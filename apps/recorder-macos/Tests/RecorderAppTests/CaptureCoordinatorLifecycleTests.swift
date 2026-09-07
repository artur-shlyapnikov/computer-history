import Foundation
@testable import RecorderApp
import Testing

/// CaptureCoordinator lifecycle state machine (spec §3.6): start/pause/resume/
/// stop transitions, no-op guards, monitor teardown on pause, and exact
/// onStateChange emission ordering. Fixture mirrors
/// PermissionGateTests.CapturePermissionFlowTests (temp spool dir + manual
/// recheck scheduler + injected trust probe). Reads policy only via the
/// coordinator's own store — never touches UserDefaults.
@MainActor
struct CaptureCoordinatorLifecycleTests {
    private func makeCoordinator(trusted: Bool) -> (CaptureCoordinator, ManualTrustRecheckScheduler) {
        let spoolDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifecycle-\(UUID().uuidString)")
        let scheduler = ManualTrustRecheckScheduler()
        let coordinator = CaptureCoordinator(
            spoolDirectory: spoolDir,
            recheckScheduler: scheduler,
            // Round-14 follow-up: stub-backed monitor factories keep this
            // suite inert (no real CGEventTap / AX observers) while the
            // lifecycle state machine under test is unchanged.
            monitorFactories: MonitorFactories(
                workspace: { StubWorkspaceMonitor() },
                input: { StubInputMonitor() },
                ax: { StubAXMonitor() }
            )
        )
        coordinator.trustCheck = { trusted }
        return (coordinator, scheduler)
    }

    @Test("fresh coordinator starts into running [ENVIRONMENT: without grant expect permissionMissing]")
    func startFromIdle() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        var states: [CaptureCoordinator.CaptureState] = []
        coordinator.onStateChange = { states.append($0) }

        // Dual-safe per design §P1-2: on a machine without the Input
        // Monitoring grant, inputMonitor.start() fails and the coordinator
        // degrades to .permissionMissing; both outcomes pin the same contract
        // (start reports what happened through its return value AND state).
        let started = await coordinator.start(transport: nil)
        if started {
            #expect(coordinator.state == .running)
            #expect(states == [.running])
        } else {
            #expect(coordinator.state == .permissionMissing)
            #expect(states == [.permissionMissing])
        }
    }

    @Test("second start while running returns immediately without a new state emission")
    func doubleStartIsNoOp() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        _ = await coordinator.start(transport: nil)
        guard coordinator.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(coordinator.state)")
            return
        }
        var states: [CaptureCoordinator.CaptureState] = [.running]
        coordinator.onStateChange = { states.append($0) }

        let again = await coordinator.start(transport: nil)
        #expect(again) // early-return, no restart work
        #expect(states == [.running]) // no duplicate emission
    }

    @Test("pause stops monitors: no pids stay attached")
    func pauseDetachesMonitors() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        _ = await coordinator.start(transport: nil)
        guard coordinator.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(coordinator.state)")
            return
        }

        await coordinator.pause(reason: "test")
        #expect(coordinator.state == .paused(reason: "test"))
        // stopMonitors ran axMonitor.stopAll — nothing stays tracked even if
        // an app switch attached observers in between.
        #expect(coordinator.attachedPidCount == 0)
    }

    @Test("pause while idle is guarded away with no emission")
    func pauseWhileIdleIsNoOp() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        var states: [CaptureCoordinator.CaptureState] = []
        coordinator.onStateChange = { states.append($0) }

        await coordinator.pause(reason: "x")
        #expect(coordinator.state == .idle)
        #expect(states.isEmpty)
    }

    @Test("resume from paused restarts monitors into running")
    func resumeFromPaused() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        _ = await coordinator.start(transport: nil)
        await coordinator.pause(reason: "test")
        guard coordinator.state == .paused(reason: "test") else {
            Issue.record("precondition: needs a granted environment; got \(coordinator.state)")
            return
        }

        await coordinator.resume()
        #expect(coordinator.state == .running)
    }

    @Test("resume while running is guarded away with no emission")
    func resumeWhileRunningIsNoOp() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        _ = await coordinator.start(transport: nil)
        guard coordinator.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(coordinator.state)")
            return
        }
        var states: [CaptureCoordinator.CaptureState] = []
        coordinator.onStateChange = { states.append($0) }

        await coordinator.resume()
        #expect(coordinator.state == .running)
        #expect(states.isEmpty)
    }

    @Test("full cycle emits exactly running → paused → running → idle")
    func fullCycleEmitsExactSequence() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        var states: [CaptureCoordinator.CaptureState] = []
        coordinator.onStateChange = { states.append($0) }

        _ = await coordinator.start(transport: nil)
        guard coordinator.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(coordinator.state)")
            return
        }

        await coordinator.pause(reason: "test")
        await coordinator.resume()
        await coordinator.stop()

        // Exact sequence equality fails if any transition emits twice or the
        // state is mutated before being reported.
        #expect(
            states == [
                .running,
                .paused(reason: "test"),
                .running,
                .idle,
            ]
        )
    }

    @Test("shutdown with nil transport spools only the launch app_focus draft")
    func pendingSpoolStaysZeroAcrossStop() async {
        let (coordinator, _) = makeCoordinator(trusted: true)
        _ = await coordinator.start(transport: nil)
        #expect(coordinator.pendingSpoolEvents == 0)

        await coordinator.stop()
        // Round-30 launch adoption routes exactly one app_focus draft; with
        // no transport it spools during the shutdown flush — one event, no
        // stranding of capture events.
        #expect(coordinator.pendingSpoolEvents == 1)
    }
}

// MARK: - Inert capture-monitor stubs

/// Same shape as CoordinatorVersionMismatchTests.makeInertRecorder:
/// start()/attach() are no-ops, so the coordinator's monitor start/stop
/// bookkeeping runs without ever touching CGEventTap or the Accessibility API.
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
