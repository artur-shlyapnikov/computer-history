import AppKit
import SwiftUI

/// Composition root: owns AppState, the daemon supervisor and the IPC client,
/// and runs the connect/handshake/reconnect loop that feeds UI state.
@MainActor
final class RecorderCoordinator: ObservableObject {
    static let smokeLogPrefix = "computer-history: state="
    let appState: AppState
    /// Internal so tests can inject a pre-connected client whose writer is
    /// observably parked (D4-3): stop() must disconnect BEFORE teardown so
    /// in-flight sends fail fast. Production code keeps the default.
    let client: DaemonClient
    private var supervisor: DaemonSupervisor?
    private var reconnectLoop: Task<Void, Never>?
    /// Connection loop's disconnect waiter (see waitForDisconnect).
    private var disconnectWaiter: CheckedContinuation<Void, Never>?
    /// Internal so tests can inject a coordinator with an injected trust
    /// probe before start(); production code creates it lazily.
    var capture: CaptureCoordinator?
    private let policyStore = CapturePolicyStore()

    /// Dev/test override; empty means the default per-user location.
    private let socketPathOverride: String

    /// Test seam: `appState` injects a state backed by a fake backend;
    /// production keeps nil and derives it from `client`.
    init(
        socketPathOverride: String = "",
        client: DaemonClient = DaemonClient(),
        appState: AppState? = nil
    ) {
        self.socketPathOverride = socketPathOverride
        self.client = client
        // ONE backend dependency, injected at construction: AppState owns the
        // data operations from its first instant; a handshake no longer
        // installs per-feature closures (partial wiring is unrepresentable).
        self.appState = appState ?? AppState(daemon: client)
    }

    func start() {
        let supervisor = DaemonSupervisor(eventHandler: { [weak self] event in
            Task { @MainActor [weak self] in
                self?.handleSupervisorEvent(event)
            }
        })
        supervisor.start()
        self.supervisor = supervisor

        // Server-pushed events arrive already decoded (DaemonEvent); the
        // coordinator only hops them onto the main actor — every feature's
        // state machine lives in AppState.
        client.setEventSubscription { [weak self] event in
            Task { @MainActor [weak self] in
                self?.appState.apply(event)
            }
        }
        // The connection loop suspends on this hook instead of polling
        // isConnectedToDaemon (see waitForDisconnect).
        client.onDisconnect = { [weak self] in
            Task { @MainActor [weak self] in self?.resumeDisconnectWaiter() }
        }
        // The capture stack starts BEFORE any connection attempt so that an
        // unreachable/degraded daemon never drops events: offline capture
        // feeds the spool (spec §3.8) until the transport binds on handshake.
        ensureCaptureCoordinator()
        Task { @MainActor [weak self] in
            _ = await self?.capture?.start(transport: nil)
        }

        reconnectLoop = Task { [weak self] in
            await self?.runConnectionLoop()
        }
    }

    func stop() async {
        reconnectLoop?.cancel()
        cancelSpoolDrain()
        // Close the socket BEFORE buffer shutdown (quit watchdog): the final
        // flush sends through this client, and a wedged-but-alive daemon
        // would block the POSIX send forever. Disconnecting fails any
        // blocked/in-flight send fast so those events fall back to the spool
        // instead of hanging quit.
        client.disconnect()
        await capture?.stop()
        appState.stopTimelinePolling()
        supervisor?.stop()
    }

    // MARK: - Capture lifecycle (menu-bar controls)

    func pauseCapture() async {
        await capture?.pause(reason: nil)
        // Reflect the coordinator's ACTUAL resulting state (SW5-02): a no-op
        // pause (capture not running) must not flip the menu bar.
        if let capture, case .paused = capture.state {
            appState.recordingState = .paused(reason: nil)
            logSmokeState("paused")
        }
    }

    func resumeCapture() async {
        if let capture {
            await capture.resume()
            // Reflect the coordinator's ACTUAL resulting state (SW5-02): a
            // failed restart (permission lost again) must not flip the menu
            // bar to active.
            if capture.state == .running {
                appState.recordingState = .active
                logSmokeState("resumed")
            }
        }
    }

    /// Shared reconnect/downgrade guard (SW5-05): a supervisor-set `.degraded`
    /// (exit 46 / repeated spawn failure) is terminal and must survive
    /// disconnects; only non-degraded statuses move to `.reconnecting`.
    func markReconnecting(attempt: Int) {
        guard !appState.daemonStatus.isDegraded else { return }
        appState.daemonStatus = .reconnecting(attempt: attempt)
    }

    /// Spooled events awaiting daemon replay (menu bar diagnostics).
    var waitingEventCount: Int {
        capture?.pendingSpoolEvents ?? 0
    }

    // MARK: - Capture policy (Settings editor backing)

    /// Current persisted policy for the Settings editor. Reads the store
    /// directly so a policy is available before the capture stack exists.
    func loadCapturePolicy() -> CapturePolicy {
        policyStore.load()
    }

    /// Persists an edited policy via the shared defaults suite; the live
    /// capture stack reloads per draft (route()), so edits take effect
    /// immediately even when applied before capture init.
    func applyCapturePolicy(_ policy: CapturePolicy) throws {
        try policyStore.save(policy)
    }

    // MARK: - Connection loop

    private func runConnectionLoop() async {
        let path = effectiveSocketPath()
        // Consecutive failed cycles since the last good handshake (clean
        // disconnect or error). Drives the SAME backoff schedule as
        // DaemonSupervisor (SupervisorPolicy: 1, 2, 5, 15, 30 s capped) so a
        // daemon that never comes back is retried at most every 30 s instead
        // of hammering connect() once per second forever.
        var failedAttempts = 0
        while !Task.isCancelled {
            do {
                let hello = try await client.connectAndHandshake(
                    socketPath: path,
                    appVersion: appVersion()
                )
                // A good handshake restarts the backoff schedule.
                failedAttempts = 0
                appState.daemonStatus = .connected
                appState.daemonVersion = hello.daemonVersion
                // 5s auto-refresh polling; ticks drop while capture is
                // paused. (M3: timeline.list replaced the M2 segments.list
                // source; segments.list remains the detail fallback only.)
                // No per-feature wiring happens here anymore: AppState has
                // held its backend dependency since construction.
                appState.startTimelinePolling()
                // The capture stack is already running (started offline);
                // re-binding start() attaches the live transport now.
                _ = await capture?.start(transport: client)
                // Anything spooled while offline replays oldest-first now.
                await drainPendingSpoolOnce()
                logSmokeState("connected")
                // Connected-state drain: sendOrSpool spools on ANY transient
                // failure, so events can land in the spool while the socket
                // stays up; retry them periodically until drained (see the
                // Connected-state spool drain section below).
                startSpoolDrain()
                await waitForDisconnect()
                // Round 27: a clean disconnect must not leave a chat turn
                // pinned in .streaming (composer disabled forever) or a
                // stale version caption on the popover.
                appState.handleConnectionLost()
                appState.daemonVersion = nil
                guard !Task.isCancelled else { return }
                failedAttempts += 1
                markReconnecting(attempt: failedAttempts)
                logSmokeState("reconnecting")
                try? await Task.sleep(for: .seconds(SupervisorPolicy.delay(afterFailureAt: failedAttempts)))
            } catch is CancellationError {
                return
            } catch DaemonClientError.protocolVersionMismatch {
                // A version mismatch is fatal for this session shape; surface degraded.
                appState.daemonStatus = .degraded
                logSmokeState("degraded")
                return
            } catch {
                appState.daemonVersion = nil
                appState.handleConnectionLost()
                if appState.daemonStatus.isDegraded {
                    return
                }
                failedAttempts += 1
                markReconnecting(attempt: failedAttempts)
                logSmokeState("reconnecting")
                try? await Task.sleep(for: .seconds(SupervisorPolicy.delay(afterFailureAt: failedAttempts)))
            }
        }
    }

    /// Suspends until the client tears down the connection (its `onDisconnect`
    /// hook) or the loop task is cancelled. Replaces a 200 ms MainActor poll:
    /// the hook IS the disconnect signal — sampling it 5x/second forever was
    /// pure wakeups.
    private func waitForDisconnect() async {
        if !client.isConnectedToDaemon {
            return
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                disconnectWaiter = continuation
                // The teardown may have raced the install (the hook hops to
                // the main actor asynchronously); re-check so the waiter can
                // never outlive the disconnected state.
                if !client.isConnectedToDaemon {
                    resumeDisconnectWaiter()
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resumeDisconnectWaiter() }
        }
    }

    /// Exactly-once resume for the connection loop's disconnect waiter.
    private func resumeDisconnectWaiter() {
        guard let continuation = disconnectWaiter else { return }
        disconnectWaiter = nil
        continuation.resume()
    }

    // MARK: - Connected-state spool drain

    /// Base cadence between connected-state drain attempts.
    static let spoolDrainInterval: Duration = .seconds(2)
    /// Backoff ceiling when repeated drains make no progress.
    static let spoolDrainMaxBackoff: Duration = .seconds(30)

    private var spoolDrainTask: Task<Void, Never>?
    /// Single-flight guard around every replay path. @MainActor: the
    /// check-and-set in drainPendingSpoolOnce() runs without suspension, so
    /// no two replays — handshake-path or drain tick — can ever overlap.
    private var spoolReplayInFlight = false

    /// Arms the periodic drain for this connected session; any previous
    /// instance is cancelled so exactly one loop runs per connection.
    private func startSpoolDrain() {
        spoolDrainTask?.cancel()
        spoolDrainTask = Task { [weak self] in
            await self?.runSpoolDrainLoop()
        }
    }

    private func cancelSpoolDrain() {
        spoolDrainTask?.cancel()
        spoolDrainTask = nil
    }

    /// sendOrSpool spools on ANY transient send failure — including while
    /// the daemon stays connected — and such events previously waited for
    /// the NEXT reconnect to replay. While connected, retry the oldest-
    /// first replay on a bounded exponential backoff; the loop ends on
    /// disconnect or teardown.
    private func runSpoolDrainLoop() async {
        var backoff = Self.spoolDrainInterval
        while !Task.isCancelled {
            try? await Task.sleep(for: backoff)
            guard !Task.isCancelled else { return }
            // Cancel-on-disconnect: daemonStatus flips once the loss is
            // observed; the direct connectivity check closes the window
            // between socket death and markReconnecting.
            guard appState.daemonStatus == .connected, client.isConnectedToDaemon else { return }
            guard let capture, capture.pendingSpoolEvents > 0 else {
                backoff = Self.spoolDrainInterval // nothing pending: idle cadence
                continue
            }
            let before = capture.pendingSpoolEvents
            await drainPendingSpoolOnce()
            if capture.pendingSpoolEvents < before {
                backoff = Self.spoolDrainInterval // progress: resume base cadence
            } else {
                backoff = min(backoff * 2, Self.spoolDrainMaxBackoff) // bounded stall backoff
            }
        }
    }

    /// One bounded replay attempt, shared by the post-handshake replay and
    /// drain ticks; an overlapping caller is dropped (the next tick retries)
    /// rather than queued behind a stuck replay.
    func drainPendingSpoolOnce() async {
        guard !spoolReplayInFlight else { return }
        spoolReplayInFlight = true
        defer { spoolReplayInFlight = false }
        await capture?.replaySpool()
    }

    /// Creates the capture stack once, at app launch and independent of the
    /// daemon connection. Permission failures surface as permission_missing.
    private func ensureCaptureCoordinator() {
        guard capture == nil else { return }
        let coordinator = CaptureCoordinator(spoolDirectory: spoolDirectory())
        coordinator.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case .permissionMissing:
                appState.permissionState = .denied
                logSmokeState("permission_missing")
            case .running, .paused, .idle:
                if state == .running {
                    appState.permissionState = .granted
                }
            }
        }
        capture = coordinator
        // Prompt-once trust check at launch (brief S1 item 7).
        if AXMonitor.checkPermission(prompt: true) {
            appState.permissionState = .granted
        } else {
            appState.permissionState = .denied
        }
    }

    private func spoolDirectory() -> URL {
        let home = ProcessInfo.processInfo.environment["COMPUTER_HISTORY_HOME"]
            ?? NSString(string: "~/Library/Application Support/ComputerHistory").expandingTildeInPath
        return URL(fileURLWithPath: home + "/spool")
    }

    func handleSupervisorEvent(_ event: SupervisorEvent) {
        switch event {
        case .spawned:
            break
        case let .exited(code) where code == 46:
            // Spec §3.25 (disk failure): a corrupt database must stop
            // recording and surface the recovery string verbatim, not look
            // like an ordinary crash-restart.
            appState.recordSupervisorError(
                scope: "daemon-supervisor",
                code: "daemon_exit",
                message: "History database needs recovery"
            )
            appState.daemonStatus = .degraded
            logSmokeState("degraded")
        case let .exited(code):
            appState.recordSupervisorError(
                scope: "daemon-supervisor",
                code: "daemon_exit",
                message: "daemon process exited with code \(code)"
            )
        case let .restartScheduled(_, attempt):
            appState.recordSupervisorError(
                scope: "daemon-supervisor",
                code: "restart_scheduled",
                message: "restart #\(attempt) scheduled"
            )
            markReconnecting(attempt: attempt)
        case .degraded:
            appState.recordSupervisorError(
                scope: "daemon-supervisor",
                code: "supervisor_degraded",
                message: "10 consecutive failed daemon starts — recording degraded, spooling locally"
            )
            appState.daemonStatus = .degraded
            logSmokeState("degraded")
        }
    }

    private func effectiveSocketPath() -> String {
        if !socketPathOverride.isEmpty {
            return socketPathOverride
        }
        let home = ProcessInfo.processInfo.environment["COMPUTER_HISTORY_HOME"]
            ?? NSString(string: "~/Library/Application Support/ComputerHistory").expandingTildeInPath
        return home + "/run/history.sock"
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0-dev"
    }

    /// Smoke-test hook: one stable, greppable line per connection-state change.
    private func logSmokeState(_ state: String) {
        FileHandle.standardError.write(Data("\(Self.smokeLogPrefix)\(state)\n".utf8))
    }
}

/// Bridges NSApplication termination to coordinator cleanup so the capture
/// buffer flushes and the supervised daemon child is always stopped before
/// the recorder exits — bounded so a hung teardown cannot block quitting.
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Awaited teardown; the reply to `terminateLater` is sent on completion.
    var onTerminate: (() async -> Void)?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let onTerminate else { return .terminateNow }
        let teardown = onTerminate
        Task { @MainActor in
            // Bounded wait (SW5-03): race the teardown against the watchdog
            // instead of awaiting it unconditionally — whichever finishes
            // first wins, the loser is cancelled, and quit always proceeds.
            // Combined with RecorderCoordinator.stop() closing the socket
            // before buffer shutdown, a healthy daemon still finishes real
            // teardown inside the window; a wedged-but-alive one can no
            // longer hang the reply on a blocked send.
            _ = await Self.awaitBounded(teardown, timeout: Self.teardownTimeout)
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// Watchdog window for teardown before the terminate reply is sent anyway.
    @MainActor
    static let teardownTimeout: Duration = .seconds(2)

    /// Awaits `work`, but never longer than `timeout`: returns true when the
    /// work itself finished first, false when the watchdog fired. The work is
    /// deliberately NEVER awaited here — a wedged-but-alive teardown (e.g. a
    /// send blocked on a stuck socket that ignores cancellation) must be
    /// abandoned, not waited out, so quitting always proceeds. Best effort:
    /// the work task is cancelled when the race settles. Testable seam.
    @MainActor
    static func awaitBounded(_ work: @escaping () async -> Void, timeout: Duration) async -> Bool {
        let signal = AsyncStream.makeStream(of: Void.self)
        let workTask = Task {
            await work()
            signal.continuation.yield()
            signal.continuation.finish()
        }
        let finished = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false // watchdog fired first
            }
            group.addTask {
                var completed = false
                for await _ in signal.stream {
                    completed = true // real teardown completed
                    break
                }
                return completed
            }
            let first = await group.next() ?? true
            group.cancelAll()
            return first
        }
        workTask.cancel()
        return finished
    }
}

// MARK: - App entry point

/// App-scoped model owning the coordinator; @StateObject keeps it alive for the
/// process lifetime. App init runs on the main actor, so accessory activation
/// and coordinator startup happen before any scene renders.
@MainActor
final class AppModel: ObservableObject {
    let coordinator = RecorderCoordinator()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
        coordinator.start()
        signal(SIGTERM) { _ in
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

/// Menu-bar label observing AppState so icon changes track daemon/recording state.
private struct StatusBarIcon: View {
    @ObservedObject var appState: AppState

    var body: some View {
        Image(systemName: appState.menuBarSymbolName)
    }
}

@main
struct ComputerHistoryApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
    @StateObject private var model: AppModel

    init() {
        // SwiftUI instantiates the App value on the main thread before any
        // scene renders; AppModel and the coordinator it owns are @MainActor.
        _model = StateObject(wrappedValue: MainActor.assumeIsolated { AppModel() })
        appDelegate.onTerminate = { [coordinator = model.coordinator] in
            await coordinator.stop()
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(
                onPause: { [coordinator = model.coordinator] in await coordinator.pauseCapture() },
                onResume: { [coordinator = model.coordinator] in await coordinator.resumeCapture() },
                waitingEventsProvider: { [coordinator = model.coordinator] in
                    coordinator.waitingEventCount
                }
            )
            .environmentObject(model.coordinator.appState)
        } label: {
            StatusBarIcon(appState: model.coordinator.appState)
        }
        .menuBarExtraStyle(.window)

        Window("Settings", id: "settings") {
            SettingsView(
                onPause: { [coordinator = model.coordinator] in await coordinator.pauseCapture() },
                onResume: { [coordinator = model.coordinator] in await coordinator.resumeCapture() },
                policyProvider: { [coordinator = model.coordinator] in
                    coordinator.loadCapturePolicy()
                },
                policyApplier: { [coordinator = model.coordinator] policy in
                    try coordinator.applyCapturePolicy(policy)
                }
            )
            .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)

        Window("Diagnostics", id: "diagnostics") {
            DiagnosticsView()
                .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)

        Window("Timeline", id: "timeline") {
            TimelineView(
                search: { [client = model.coordinator.client] query, scope in
                    try await client.searchHistory(HistorySearchPresentation.params(query: query, scope: scope))
                },
                loadEpisodeSummary: { [client = model.coordinator.client] id in
                    try await HistorySearchPresentation.episodeSummary(from: client.getEpisode(id: id))
                }
            )
            .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)

        Window("Memories", id: "memories") {
            MemoriesView()
                .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)

        Window("Workflows", id: "workflows") {
            WorkflowsView()
                .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)

        Window("Ask Your History", id: "ask") {
            AskView(
                onSend: { [appState = model.coordinator.appState] text in
                    await appState.sendChatMessage(text)
                },
                onCancel: { [appState = model.coordinator.appState] in
                    await appState.cancelChat()
                }
            )
            .environmentObject(model.coordinator.appState)
        }
        .windowResizability(.contentSize)
    }
}
