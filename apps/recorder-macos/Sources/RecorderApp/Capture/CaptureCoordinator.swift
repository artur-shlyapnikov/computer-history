import AppKit
import Foundation

/// Single owner of the capture lifecycle (spec §3.6): wires
/// WorkspaceMonitor / AXMonitor / InputMonitor → PrivacyFilter → EventBuffer
/// → DaemonClient | SpoolStore, honors pause, and reports state upward.
///
/// Isolation: @MainActor for lifecycle control; monitor callbacks arrive on
/// arbitrary queues/threads and hop into async routing.
@MainActor
final class CaptureCoordinator {
    enum CaptureState: Equatable, Sendable {
        case idle
        case running
        case paused(reason: String?)
        case permissionMissing
    }

    /// State changes surfaced to AppState/menu bar.
    var onStateChange: (@MainActor (CaptureState) -> Void)?

    private(set) var state: CaptureState = .idle

    /// True while the current pause came from an explicit user action (menu
    /// bar / Settings). A reconnect transport bind (start(transport:)) and a
    /// permission recovery must never silently undo it; resume() is the only
    /// path back to .running.
    private(set) var pausedByUser = false

    /// Reason string of the user pause, preserved across the
    /// permission-missing detour so recovery restores the exact state.
    private var userPauseReason: String?

    private let policyStore = CapturePolicyStore()
    private let filter = PrivacyFilter()
    private let captureSession = CaptureSession()
    private let spool: SpoolStore
    private lazy var buffer = EventBuffer(
        sender: { [weak self] batch in
            guard let self else { throw DaemonClientError.notConnected }
            try await sendOrSpool(batch)
        },
        spool: spool
    )

    private let workspaceMonitor: any WorkspaceMonitoring
    private let inputMonitor: any InputMonitoring
    /// Internal so the permission-flow test can assert observer bookkeeping.
    let axMonitor: any AXMonitoring

    /// The live transport; nil while disconnected (everything spools).
    private weak var client: DaemonClient?

    /// Injectable Accessibility trust check (default: real AX trust probe);
    /// tests inject a closure to drive revocation/recovery deterministically.
    var trustCheck: () -> Bool = { AXMonitor.checkPermission(prompt: false) }

    /// Owns the runtime permission state machine + 30 s recheck loop.
    private(set) var permissionGate: PermissionGate!

    private let recheckScheduler: any TrustRecheckScheduler

    private var foregroundApp: WorkspaceMonitor.ActivatedApp?
    private var currentPid: pid_t?

    init(
        spoolDirectory: URL,
        recheckScheduler: any TrustRecheckScheduler = DispatchTrustRecheckScheduler(),
        monitorFactories: MonitorFactories = .live
    ) {
        spool = SpoolStore(directory: spoolDirectory)
        self.recheckScheduler = recheckScheduler
        workspaceMonitor = monitorFactories.workspace()
        inputMonitor = monitorFactories.input()
        axMonitor = monitorFactories.ax()
        permissionGate = PermissionGate(
            trustCheck: { [weak self] in
                guard let self else { return false }
                return trustCheck()
            },
            scheduler: recheckScheduler,
            onLost: { [weak self] in self?.handlePermissionLost() },
            onRecovered: { [weak self] in await self?.handlePermissionRecovered() }
        )
    }

    // MARK: - Lifecycle

    /// Starts monitors. `permissionGranted` reflects the AX trust check made
    /// by the caller BEFORE this point; a failing event tap overrides it.
    func start(transport: DaemonClient?) async -> Bool {
        client = transport
        switch state {
        case .idle:
            return await startMonitors()
        case .paused:
            // A reconnect handshake re-binds the transport but must NOT
            // resume capture over an explicit user pause (SW5-01): the menu
            // bar still shows Resume and resume() stays the only path back
            // to .running.
            return true
        default:
            return true // already running or transitioning
        }
    }

    private func startMonitors() async -> Bool {
        // Accessibility trust decides whether AX observation can attach at
        // all; prompt-once happened at app launch. A failure here engages
        // the gate's 30 s recheck loop (idempotent while already missing).
        guard trustCheck() else {
            await permissionGate.trustFailureObserved()
            return false
        }
        // Trust just proved fresh: re-arm the gate. A previous session may
        // have been torn down while `.missing` (stop() preserves phase);
        // without this reset a reused gate would silently ignore the next
        // runtime revocation.
        permissionGate.reset()

        inputMonitor.onPermissionFailure = { [weak self] _ in
            Task { @MainActor [weak self] in await self?.permissionGate.trustFailureObserved() }
        }
        inputMonitor.onDraft = { [weak self] draft in
            Task { @MainActor [weak self] in await self?.route(draft) }
        }
        guard inputMonitor.start() else {
            await permissionGate.trustFailureObserved()
            return false
        }

        axMonitor.onDrafts = { [weak self] drafts in
            // One hop per notification batch, not one Task per draft: the
            // handler already runs on the main actor, so per-draft Tasks were
            // pure heap-allocation + scheduler overhead at keystroke rate.
            Task { @MainActor [weak self] in
                for draft in drafts {
                    await self?.route(draft)
                }
            }
        }
        axMonitor.onAttachFailed = { [weak self] pid in
            // Dead or protected process: drop any stale observer bookkeeping.
            self?.axMonitor.detach(pid: pid)
        }
        axMonitor.onTrustFailure = { [weak self] in
            // Runtime revocation: observer calls start returning apiDisabled/
            // cannotComplete; the gate stops capture and schedules rechecks.
            Task { @MainActor [weak self] in
                await self?.permissionGate.trustFailureObserved()
            }
        }

        workspaceMonitor.setHandler { [weak self] activated in
            Task { @MainActor [weak self] in
                await self?.handleAppSwitch(to: activated)
            }
        }
        workspaceMonitor.start()

        await buffer.start()
        setState(.running)

        // Seed the app that is ALREADY frontmost at start time (app launch,
        // reconnect, permission recovery): the workspace monitor only fires
        // on activation CHANGE, so without this adoption the frontmost app
        // never gets an AX observer and typed-text capture stays dead until
        // the first app switch. Deliberately placed AFTER buffer.start() +
        // setState(.running) so the seeded appFocus draft routes exactly
        // like a switch-driven one instead of hitting the idle-state guard.
        if let frontmost = NSWorkspace.shared.frontmostApplication {
            await adoptForegroundApp(WorkspaceMonitor.ActivatedApp(
                bundleId: frontmost.bundleIdentifier ?? "unknown",
                name: frontmost.localizedName,
                pid: frontmost.processIdentifier
            ))
        }
        return true
    }

    func pause(reason: String?) async {
        guard state == .running else { return }
        stopMonitors()
        pausedByUser = true
        userPauseReason = reason
        setState(.paused(reason: reason))
    }

    func resume() async {
        guard case .paused = state else { return }
        pausedByUser = false
        userPauseReason = nil
        _ = await startMonitors()
    }

    func stop() async {
        permissionGate.stop()
        stopMonitors()
        // Drop to .idle BEFORE draining: route() Tasks already spawned but
        // not yet run must lose the `state == .running` race and
        // short-circuit instead of appending after shutdown()'s final flush
        // (events appended before this point are still flushed by the
        // drain). The onStateChange(.idle) callback therefore fires BEFORE
        // the drain completes — intended.
        setState(.idle)
        await buffer.shutdown()
        pausedByUser = false
        userPauseReason = nil
    }

    // MARK: - Runtime permission revocation (PermissionGate callbacks)

    /// Trust lost at runtime: stop every monitor cleanly, surface
    /// permission_missing; the gate's recheck loop keeps polling.
    private func handlePermissionLost() {
        stopMonitors()
        setState(.permissionMissing)
    }

    /// Trust re-granted while missing: restart the full monitor stack —
    /// unless the user had explicitly paused, whose intent survives the
    /// revocation detour (recovery returns to .paused; resume() stays the
    /// exclusive path back to .running).
    private func handlePermissionRecovered() async {
        guard state == .permissionMissing else { return }
        if pausedByUser {
            setState(.paused(reason: userPauseReason))
            return
        }
        _ = await startMonitors()
    }

    private func stopMonitors() {
        workspaceMonitor.stop()
        inputMonitor.stop()
        // Detach AX observers too — pause must not leave pid observers live.
        axMonitor.stopAll()
    }

    private func setState(_ newState: CaptureState) {
        state = newState
        onStateChange?(newState)
    }

    /// Spool diagnostics for the menu bar ("N events waiting").
    var pendingSpoolEvents: Int {
        spool.spooledEventCount
    }

    /// Test observability: how many pids currently have live AX observers
    /// (permission-loss must drive this to zero).
    var attachedPidCount: Int {
        axMonitor.attachedPids.count
    }

    // MARK: - Routing

    /// Workspace-activation callback: thin delegate kept so callers and
    /// tests read "app switched"; all bookkeeping lives in
    /// adoptForegroundApp, which also serves the launch-time seeding below.
    private func handleAppSwitch(to activated: WorkspaceMonitor.ActivatedApp) async {
        await adoptForegroundApp(activated)
    }

    /// Adopts an app as foreground: detaches the previous pid's AX observer,
    /// attaches the new one, seeds the input monitor's attribution snapshot,
    /// and emits the app_focus draft.
    private func adoptForegroundApp(_ activated: WorkspaceMonitor.ActivatedApp) async {
        let previousPid = currentPid
        currentPid = activated.pid
        foregroundApp = activated
        inputMonitor.updateCurrentApp(AppInfo(bundleId: activated.bundleId, name: activated.name, pid: Int64(activated.pid)))

        let appInfo = AppInfo(bundleId: activated.bundleId, name: activated.name, pid: Int64(activated.pid))

        if previousPid != activated.pid {
            axMonitor.detach(pid: previousPid ?? -1)
        }
        axMonitor.attach(pid: activated.pid)

        await route(EventDraft(source: .workspace, action: .appFocus, app: appInfo))
    }

    /// Draft → filter → buffer. The single chokepoint every captured fact
    /// passes through before leaving the process boundary.
    private func route(_ draft: EventDraft) async {
        guard state == .running else { return } // paused/idle: nothing recorded
        let mode = policyStore.load().mode(forBundleId: draft.app.bundleId)
        if let event = filter.apply(draft, mode: mode, captureSessionId: captureSession.id) {
            await buffer.append(event)
        }
    }

    // MARK: - Transport

    /// Live-send through the daemon; on ANY failure persist the whole batch to
    /// the spool so the event stream survives daemon outages.
    private func sendOrSpool(_ batch: EventBatch) async throws {
        guard let client, client.isConnectedToDaemon else {
            throw DaemonClientError.notConnected
        }
        try await client.sendBatch(batch.events)
    }

    /// Reconnect hook: replay everything spooled while offline, oldest first,
    /// deleting files only after full ack (spec §3.8).
    func replaySpool() async {
        guard let client else { return }
        _ = await spool.replayOldestFirst { batch in
            try await client.sendBatch(batch.events)
        }
    }

    // MARK: - Capture policy (Settings surface)

    /// Current policy snapshot for the Settings editor.
    func currentPolicy() -> CapturePolicy {
        policyStore.load()
    }

    /// Policy edits from the Settings editor take effect immediately
    /// (route() reloads per draft).
    func updatePolicy(_ policy: CapturePolicy) throws {
        try policyStore.save(policy)
    }
}

// MARK: - Monitor injection seam

/// Minimal object surface CaptureCoordinator needs from each monitor. The
/// only reason these exist: unit tests that drive the coordinator lifecycle
/// must never touch the real capture stack (a synchronous
/// AXUIElementCopyAttributeValue against an animating window never returns —
/// mach_msg hang — and a CGEvent tap / NSWorkspace subscription in tests is
/// nondeterministic besides). Production witnesses are the real monitors;
/// the default `MonitorFactories.live` bundle constructs exactly what the
/// inline `let` initializers used to, so the app path is unchanged.
protocol WorkspaceMonitoring: AnyObject {
    func setHandler(_ handler: @escaping @Sendable (WorkspaceMonitor.ActivatedApp) -> Void)
    func start()
    func stop()
}

extension WorkspaceMonitor: WorkspaceMonitoring {}

protocol InputMonitoring: AnyObject {
    var onDraft: (@Sendable (EventDraft) -> Void)? { get set }
    var onPermissionFailure: (@Sendable (InputMonitor.MonitorError) -> Void)? { get set }

    @discardableResult
    func start() -> Bool
    func stop()
    func updateCurrentApp(_ app: AppInfo)
}

extension InputMonitor: InputMonitoring {}

@MainActor
protocol AXMonitoring: AnyObject {
    var onDrafts: (@MainActor ([EventDraft]) -> Void)? { get set }
    var onAttachFailed: (@MainActor (pid_t) -> Void)? { get set }
    var onTrustFailure: (@MainActor () -> Void)? { get set }
    func attach(pid: pid_t)
    func detach(pid: pid_t)
    func stopAll()
    var attachedPids: [pid_t] { get }
}

extension AXMonitor: AXMonitoring {}

/// Factory bundle for one CaptureCoordinator's monitor stack. Tests inject a
/// bundle of inert stubs; everything else keeps `.live`. @MainActor because
/// the default bundle constructs the actor-isolated AXMonitor and the
/// coordinator only ever builds its stack on the main actor.
@MainActor
struct MonitorFactories {
    let workspace: () -> any WorkspaceMonitoring
    let input: () -> any InputMonitoring
    let ax: () -> any AXMonitoring

    /// Production default: byte-for-byte the previous real construction.
    static let live = MonitorFactories(
        workspace: { WorkspaceMonitor() },
        input: { InputMonitor() },
        ax: { AXMonitor() }
    )
}
