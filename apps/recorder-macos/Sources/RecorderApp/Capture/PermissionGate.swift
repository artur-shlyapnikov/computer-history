import Foundation

/// Drives the periodic Accessibility trust recheck; abstracted so tests fire
/// ticks deterministically without real timers (same seam as
/// TimelineTickScheduler).
protocol TrustRecheckScheduler: AnyObject {
    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void)
    func stop()
}

/// Production scheduler: a serial-queue `DispatchSourceTimer`.
/// `@unchecked Sendable`: the only mutable state (`timer`) is created,
/// replaced and cancelled exclusively from the @MainActor owner (start/stop
/// are serialized by the gate's isolation); the timer itself lives on its
/// own private serial queue.
final class DispatchTrustRecheckScheduler: TrustRecheckScheduler, @unchecked Sendable {
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "computer-history.trust-recheck")

    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void) {
        stop()
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { Task { await tick() } }
        source.resume()
        timer = source
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }
}

/// Permission state machine for runtime Accessibility revocation (spec
/// §3.25/§3.26 permission_missing; brief M7 S7 item 1).
///
/// While AX observers or the event tap report trust failure codes, capture
/// must STOP cleanly and the recorder must keep re-checking trust every 30 s
/// so recording resumes by itself once the user re-grants the permission.
///
/// The gate owns only the phase + recheck loop; the owner (CaptureCoordinator)
/// wires `onLost`/`onRecovered` to its monitor lifecycle, so the machine is
/// fully unit-testable with an injected trust closure and scheduler.
@MainActor
final class PermissionGate {
    enum Phase: Equatable {
        case granted
        case missing
    }

    /// Pinned recheck cadence (brief M7: 30 s trust-recheck retry).
    static let recheckInterval: TimeInterval = 30

    private(set) var phase: Phase = .granted
    /// Number of recheck ticks consumed while missing (test observability).
    private(set) var recheckCount = 0

    /// Awaited exactly once per transition into `.missing`.
    private let onLost: @MainActor () async -> Void
    /// Awaited exactly once per transition back to `.granted`; the owner
    /// restarts its monitor stack inline so the phase flip and the capture
    /// state stay transactional (no detached task races in tests or prod).
    private let onRecovered: @MainActor () async -> Void

    private let trustCheck: @MainActor () -> Bool
    private let scheduler: any TrustRecheckScheduler
    private var rechecking = false

    init(
        trustCheck: @escaping @MainActor () -> Bool,
        scheduler: any TrustRecheckScheduler,
        onLost: @escaping @MainActor () async -> Void,
        onRecovered: @escaping @MainActor () async -> Void
    ) {
        self.trustCheck = trustCheck
        self.scheduler = scheduler
        self.onLost = onLost
        self.onRecovered = onRecovered
    }

    /// A capture component reported a trust failure (AXObserver failure code,
    /// tap invalidation). Idempotent: repeated failure signals while already
    /// missing never re-fire onLost or reset the recheck loop.
    func trustFailureObserved() async {
        guard phase == .granted else { return }
        phase = .missing
        startRechecks()
        await onLost()
    }

    /// One recheck tick. Ticks are ignored unless the gate is missing, so a
    /// stale tick after recovery is a no-op.
    func recheckTick() async {
        guard phase == .missing else { return }
        recheckCount += 1
        if trustCheck() {
            phase = .granted
            stopRechecks()
            await onRecovered()
        }
    }

    /// Full teardown (app stop): cancels the recheck timer. The phase is left
    /// as-is; a later start re-evaluates trust from scratch.
    func stop() {
        stopRechecks()
    }

    /// Re-arms the gate for a fresh capture session. `stop()` deliberately
    /// preserves the phase, so a gate torn down while `.missing` would
    /// otherwise swallow every later `trustFailureObserved()` (its guard
    /// only acts from `.granted`) and capture would keep "running" dead.
    /// A successful monitor (re)start proves trust, so the coordinator
    /// resets here before wiring observers.
    func reset() {
        phase = .granted
        recheckCount = 0
        stopRechecks()
    }

    private func startRechecks() {
        guard !rechecking else { return }
        rechecking = true
        scheduler.start(interval: Self.recheckInterval) { [weak self] in
            await self?.recheckTick()
        }
    }

    private func stopRechecks() {
        guard rechecking else { return }
        rechecking = false
        scheduler.stop()
    }
}
