import Foundation
@testable import RecorderApp
import Testing

/// Deterministic scheduler for gate tests: records the requested interval and
/// lets the test fire ticks by hand (no real timers). Lock-guarded + Sendable
/// so the reference can cross the gate's @Sendable tick closures.
final class ManualTrustRecheckScheduler: TrustRecheckScheduler, @unchecked Sendable {
    private let lock = NSLock()
    private var _requestedInterval: TimeInterval?
    private var _startCount = 0
    private var _stopCount = 0
    private var tick: (@Sendable () async -> Void)?

    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void) {
        lock.lock(); defer { lock.unlock() }
        _requestedInterval = interval
        _startCount += 1
        self.tick = tick
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        _stopCount += 1
        tick = nil
    }

    private(set) var requestedInterval: TimeInterval? {
        get { lock.lock(); defer { lock.unlock() }; return _requestedInterval }
        set { lock.lock(); _requestedInterval = newValue; lock.unlock() }
    }

    var startCount: Int {
        lock.lock(); defer { lock.unlock() }; return _startCount
    }

    var stopCount: Int {
        lock.lock(); defer { lock.unlock() }; return _stopCount
    }

    /// Fires the scheduled tick; a no-op when nothing is scheduled.
    func fireTick() async {
        let handler: (@Sendable () async -> Void)? = lock.withLock { tick }
        await handler?()
    }
}

// Brief M7 S7 item 1: runtime Accessibility revocation must STOP capture and
// enter a 30 s trust re-check loop that auto-resumes on re-grant. The gate
// is fully driven here with an injected probe + injected timer.

/// Mutable Bool shared with a @Sendable trust probe closure (a plain local
/// `var` cannot be mutated by the test body after capture).
private final class TrustedBox: @unchecked Sendable {
    var value: Bool
    init(_ value: Bool) {
        self.value = value
    }
}

@MainActor
struct PermissionGateTests {
    @Test("trust failure fires onLost exactly once and schedules 30 s rechecks")
    func lossTransitionsOnce() async {
        let scheduler = ManualTrustRecheckScheduler()
        var lostCount = 0
        var recoveredCount = 0
        let gate = PermissionGate(
            trustCheck: { false },
            scheduler: scheduler,
            onLost: { lostCount += 1 },
            onRecovered: { recoveredCount += 1 }
        )

        await gate.trustFailureObserved()
        // Repeated signals while already missing are idempotent.
        await gate.trustFailureObserved()
        await gate.trustFailureObserved()

        #expect(gate.phase == .missing)
        #expect(lostCount == 1)
        #expect(recoveredCount == 0)
        #expect(scheduler.startCount == 1)
        #expect(scheduler.requestedInterval == PermissionGate.recheckInterval)
        // The pinned cadence is 30 seconds (brief M7).
        #expect(PermissionGate.recheckInterval == 30)
    }

    @Test("recheck ticks with a failing probe keep the gate missing")
    func rechecksKeepWaiting() async {
        let scheduler = ManualTrustRecheckScheduler()
        var lostCount = 0
        let gate = PermissionGate(
            trustCheck: { false },
            scheduler: scheduler,
            onLost: { lostCount += 1 },
            onRecovered: {}
        )
        await gate.trustFailureObserved()

        await scheduler.fireTick()
        await scheduler.fireTick()
        await scheduler.fireTick()

        #expect(gate.phase == .missing)
        #expect(gate.recheckCount == 3)
        #expect(lostCount == 1)
    }

    @Test("probe success on a tick recovers exactly once and stops the loop")
    func recoveryOnTick() async {
        let scheduler = ManualTrustRecheckScheduler()
        let trusted = TrustedBox(false)
        var recoveredCount = 0
        let gate = PermissionGate(
            trustCheck: { [trusted] in trusted.value },
            scheduler: scheduler,
            onLost: {},
            onRecovered: { recoveredCount += 1 }
        )
        await gate.trustFailureObserved()

        trusted.value = true
        await scheduler.fireTick()

        #expect(gate.phase == .granted)
        #expect(recoveredCount == 1)
        #expect(scheduler.stopCount >= 1)

        // A stale tick after recovery is a no-op.
        await scheduler.fireTick()
        #expect(recoveredCount == 1)
        #expect(gate.recheckCount == 1)
    }

    @Test("stop() cancels the recheck timer")
    func stopCancelsTimer() async {
        let scheduler = ManualTrustRecheckScheduler()
        let gate = PermissionGate(
            trustCheck: { false },
            scheduler: scheduler,
            onLost: {},
            onRecovered: {}
        )
        await gate.trustFailureObserved()
        #expect(scheduler.stopCount == 0)
        gate.stop()
        #expect(scheduler.stopCount == 1)
    }

    /// Round-14: stop() preserves phase, so a gate torn down while
    /// `.missing` must be explicitly re-armed before reuse — otherwise a
    /// later trustFailureObserved() hits the `phase == .granted` guard and
    /// is silently dropped.
    @Test("reset() re-arms a gate stopped while missing so a later revocation fires")
    func resetRearmsAfterStopWhileMissing() async {
        let scheduler = ManualTrustRecheckScheduler()
        var lostCount = 0
        let gate = PermissionGate(
            trustCheck: { false },
            scheduler: scheduler,
            onLost: { lostCount += 1 },
            onRecovered: {}
        )
        await gate.trustFailureObserved()
        #expect(gate.phase == .missing)
        #expect(scheduler.startCount == 1)

        gate.stop()
        // stop() intentionally leaves the phase untouched.
        #expect(gate.phase == .missing)

        // A reused gate would ignore this without an explicit re-arm…
        await gate.trustFailureObserved()
        #expect(lostCount == 1)

        // Drive one tick while still `.missing` so `recheckCount` is
        // observably non-zero before reset() — otherwise asserting 0 after
        // reset() reads an untouched zero and pins nothing.
        await gate.recheckTick()
        #expect(gate.recheckCount == 1)

        gate.reset()
        // Documented post-reset contract: phase re-armed to `.granted`,
        // recheck bookkeeping cleared, and the recheck timer stopped. The
        // loop was already torn down by stop() above, so reset()'s
        // stopRechecks is a guarded no-op: stopCount is exactly 1, not 2.
        #expect(gate.phase == .granted)
        #expect(gate.recheckCount == 0)
        #expect(scheduler.stopCount == 1)

        // …and with the reset in place the revocation is seen again.
        await gate.trustFailureObserved()
        #expect(gate.phase == .missing)
        #expect(lostCount == 2)
        #expect(scheduler.startCount == 2)
        // Re-arming starts the loop but never stops it (trustCheck stays
        // false, so no recovery path runs): stopCount remains exactly 1.
        #expect(scheduler.stopCount == 1)
    }

    /// R9-S3: a SECOND loss/recover cycle. After recovery, a new
    /// trustFailureObserved() must re-fire onLost, restart the recheck loop
    /// (scheduler start #2), and recheckCount keeps ACCUMULATING across
    /// cycles (PermissionGate.swift declares it observability-by-design; a
    /// silent reset in startRechecks would change diagnostics).
    @Test("second loss cycle refires onLost, restarts rechecks, and accumulates recheckCount")
    func secondLossCycle() async {
        let scheduler = ManualTrustRecheckScheduler()
        let trusted = TrustedBox(false)
        var lostCount = 0
        var recoveredCount = 0
        let gate = PermissionGate(
            trustCheck: { [trusted] in trusted.value },
            scheduler: scheduler,
            onLost: { lostCount += 1 },
            onRecovered: { recoveredCount += 1 }
        )

        // Cycle 1: loss → two ticks → recover.
        await gate.trustFailureObserved()
        #expect(gate.phase == .missing)
        await scheduler.fireTick()
        await scheduler.fireTick()
        trusted.value = true
        await scheduler.fireTick()
        #expect(gate.phase == .granted)
        let countAfterCycleOne = gate.recheckCount
        // NOTE (R9-S3 deviation from the design doc's arithmetic): the
        // RECOVERING tick itself consumes a recheck (recheckTick increments
        // before probing trust), so cycle one ends at 3, not 2. The pinned
        // contract is CUMULATIVE accumulation across cycles, which holds.
        #expect(countAfterCycleOne == 3)

        // Cycle 2: loss again → onLost refires and the loop restarts.
        trusted.value = false
        await gate.trustFailureObserved()
        #expect(gate.phase == .missing)
        #expect(lostCount == 2)
        #expect(scheduler.startCount == 2)

        // One further tick consumes recheck #4 CUMULATIVELY (never reset).
        await scheduler.fireTick()
        #expect(gate.recheckCount == 4)
    }
}

/// CaptureCoordinator-level wiring with an injected trust probe + manual
/// scheduler: monitor state follows the gate phases. Live AX/CGEvent behavior
/// stays out of scope (see CaptureStackUnitTests honest-limits note); this
/// exercises ONLY the permission lifecycle around it.
@MainActor
struct CapturePermissionFlowTests {
    @Test("revoked trust stops monitors into permissionMissing, re-grant restarts")
    func revokeAndRecoverCycle() async {
        let spoolDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("m7-perm-\(UUID().uuidString)")
        let scheduler = ManualTrustRecheckScheduler()
        var trusted = true
        let coordinator = CaptureCoordinator(
            spoolDirectory: spoolDir,
            recheckScheduler: scheduler,
            // Round-14 follow-up: stub-backed monitor factories keep this
            // suite inert (no real CGEventTap / AX observers) while the
            // permission lifecycle logic under test is unchanged.
            monitorFactories: MonitorFactories(
                workspace: { StubWorkspaceMonitor() },
                input: { StubInputMonitor() },
                ax: { StubAXMonitor() }
            )
        )
        coordinator.trustCheck = { trusted }

        var states: [CaptureCoordinator.CaptureState] = []
        coordinator.onStateChange = { states.append($0) }

        _ = await coordinator.start(transport: nil)
        #expect(coordinator.state == .running)

        // Runtime revocation signal (AX failure code / tap invalidation path).
        trusted = false
        await coordinator.permissionGate.trustFailureObserved()
        #expect(coordinator.state == .permissionMissing)

        // Monitors stopped cleanly: nothing attached anymore.
        #expect(coordinator.attachedPidCount == 0)

        // Re-grant picked up by the NEXT recheck tick → full restart.
        trusted = true
        await scheduler.fireTick()
        #expect(coordinator.permissionGate.phase == .granted)
        // startMonitors re-checks trust via the injected probe and succeeds.
        #expect(coordinator.state == .running)

        #expect(states.contains(.permissionMissing))
    }

    /// Round-14 regression: a coordinator stopped while the gate is
    /// `.missing`, then restarted (trust now granted), must re-arm the
    /// gate — a later runtime revocation has to stop monitors into
    /// `.permissionMissing` instead of being silently swallowed while
    /// capture is actually dead.
    @Test("restart after stop-while-missing re-arms gate; later revocation stops monitors")
    func restartAfterStopWhileMissingSeesLaterRevocation() async {
        let spoolDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("m7-perm-\(UUID().uuidString)")
        let scheduler = ManualTrustRecheckScheduler()
        var trusted = true
        let coordinator = CaptureCoordinator(
            spoolDirectory: spoolDir,
            recheckScheduler: scheduler,
            monitorFactories: MonitorFactories(
                workspace: { StubWorkspaceMonitor() },
                input: { StubInputMonitor() },
                ax: { StubAXMonitor() }
            )
        )
        coordinator.trustCheck = { trusted }

        _ = await coordinator.start(transport: nil)
        #expect(coordinator.state == .running)

        // Session 1 ends while trust is missing.
        trusted = false
        await coordinator.permissionGate.trustFailureObserved()
        #expect(coordinator.state == .permissionMissing)
        await coordinator.stop()
        #expect(coordinator.permissionGate.phase == .missing)

        // Session 2 starts with trust re-granted…
        trusted = true
        _ = await coordinator.start(transport: nil)
        #expect(coordinator.state == .running)
        // …so startMonitors' reset must clear the stale `.missing`.
        #expect(coordinator.permissionGate.phase == .granted)

        // A later runtime revocation is observed and stops capture.
        trusted = false
        await coordinator.permissionGate.trustFailureObserved()
        #expect(coordinator.state == .permissionMissing)
        #expect(coordinator.attachedPidCount == 0)
        #expect(scheduler.startCount == 2) // one loss per session
    }
}

// MARK: - Inert capture-monitor stubs

/// Same shape as CoordinatorVersionMismatchTests.makeInertRecorder:
/// CapturePermissionFlowTests drives start/pause/restart through the gate
/// phases without ever constructing WorkspaceMonitor/InputMonitor/AXMonitor.
private final class StubWorkspaceMonitor: WorkspaceMonitoring {
    func setHandler(_: @escaping @Sendable (WorkspaceMonitor.ActivatedApp) -> Void) {}
    func start() {}
    func stop() {}
}

private final class StubInputMonitor: InputMonitoring {
    var onDraft: (@Sendable (EventDraft) -> Void)?
    var onPermissionFailure: (@Sendable (InputMonitor.MonitorError) -> Void)?

    func start() -> Bool {
        true
    }

    func stop() {}

    func updateCurrentApp(_: AppInfo) {}
}

@MainActor
private final class StubAXMonitor: AXMonitoring {
    var onDrafts: (@MainActor ([EventDraft]) -> Void)?
    var onAttachFailed: (@MainActor (pid_t) -> Void)?
    var onTrustFailure: (@MainActor () -> Void)?

    func attach(pid _: pid_t) {}
    func detach(pid _: pid_t) {}
    func stopAll() {}
    var attachedPids: [pid_t] {
        []
    }
}
