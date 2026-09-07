import Foundation
@testable import RecorderApp
import Testing

/// Round-5 capture lifecycle fixes (SW5-01/02/03/05): reconnect must not
/// resume a user pause, menu-bar state reflects the coordinator's ACTUAL
/// resulting transition, permission recovery honors user-pause intent,
/// degraded survives disconnect/reconnect, and quit is bounded by a real
/// watchdog race. Fixture mirrors CaptureCoordinatorLifecycleTests /
/// CapturePermissionFlowTests (temp spool dir + manual recheck scheduler +
/// injected trust probe). Live AX/CGEvent behavior stays out of scope.
@MainActor
struct CaptureLifecycleTests {
    /// Coordinator + manual scheduler + a setter for the trust probe so a
    /// test can flip trust mid-flight (revocation / re-grant).
    private func makeCoordinator(
        trusted: Bool = true
    ) -> (CaptureCoordinator, ManualTrustRecheckScheduler, (_ trusted: Bool) -> Void) {
        let spoolDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sw5-lifecycle-\(UUID().uuidString)")
        let scheduler = ManualTrustRecheckScheduler()
        var probe = trusted
        let coordinator = CaptureCoordinator(
            spoolDirectory: spoolDir,
            recheckScheduler: scheduler,
            // Round-14 follow-up: never arm real CGEventTap/AX observers
            // from tests — stub-backed factories keep this suite inert on
            // trusted machines while exercising identical coordinator logic.
            monitorFactories: MonitorFactories(
                workspace: { StubWorkspaceMonitor() },
                input: { StubInputMonitor() },
                ax: { StubAXMonitor() }
            )
        )
        coordinator.trustCheck = { probe }
        return (coordinator, scheduler, { probe = $0 })
    }

    // MARK: - SW5-01: reconnect transport bind must not resume a user pause

    @Test("start(transport:) while paused only rebinds; monitors stay down")
    func transportBindWhilePausedDoesNotResume() async {
        let (capture, _, _) = makeCoordinator()
        _ = await capture.start(transport: nil)
        guard capture.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(capture.state)")
            return
        }
        await capture.pause(reason: "user")
        var states: [CaptureCoordinator.CaptureState] = [.running, .paused(reason: "user")]
        capture.onStateChange = { states.append($0) }

        let bound = await capture.start(transport: nil)
        #expect(bound) // transport attach reports success…
        #expect(capture.state == .paused(reason: "user")) // …but nothing resumed
        #expect(states.count == 2) // no state emission from the bind
        #expect(capture.attachedPidCount == 0) // monitors stayed stopped

        // resume() remains the exclusive path back to running.
        await capture.resume()
        #expect(capture.state == .running)
    }

    @Test("start(transport:) from idle still starts monitors [ENVIRONMENT: without grant expect permissionMissing]")
    func startFromIdleStillStarts() async {
        let (capture, _, _) = makeCoordinator()
        var states: [CaptureCoordinator.CaptureState] = []
        capture.onStateChange = { states.append($0) }

        let started = await capture.start(transport: nil)
        if started {
            #expect(capture.state == .running)
            #expect(states == [.running])
        } else {
            #expect(capture.state == .permissionMissing)
            #expect(states == [.permissionMissing])
        }
    }

    // MARK: - SW5-02: permission recovery honors user-pause intent

    @Test("permission recovery after a user pause returns to paused, not running")
    func recoveryRespectsUserPause() async {
        let (capture, scheduler, setTrusted) = makeCoordinator()
        _ = await capture.start(transport: nil)
        guard capture.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(capture.state)")
            return
        }
        await capture.pause(reason: "user")

        // Revocation detour while paused.
        setTrusted(false)
        await capture.permissionGate.trustFailureObserved()
        #expect(capture.state == .permissionMissing)

        // Re-grant picked up by the next recheck tick: back to PAUSED.
        setTrusted(true)
        await scheduler.fireTick()
        #expect(capture.state == .paused(reason: "user"))
        #expect(capture.pausedByUser)

        // Explicit resume still works afterwards.
        await capture.resume()
        #expect(capture.state == .running)
    }

    // MARK: - SW5-02: menu-bar state reflects actual transitions

    @Test("pauseCapture when the coordinator cannot pause leaves recordingState unchanged")
    func pauseNoopLeavesRecordingStateUnchanged() async {
        let recorder = RecorderCoordinator(socketPathOverride: "/nonexistent.sock")
        let (capture, _, _) = makeCoordinator() // never started → .idle
        recorder.capture = capture
        #expect(recorder.appState.recordingState == .active)

        await recorder.pauseCapture()

        #expect(recorder.appState.recordingState == .active) // unchanged
        #expect(capture.state == .idle) // pause was guarded away
    }

    @Test("resumeCapture that cannot restart monitors keeps recordingState paused")
    func resumeFailureKeepsPausedState() async {
        let recorder = RecorderCoordinator(socketPathOverride: "/nonexistent.sock")
        let (capture, _, setTrusted) = makeCoordinator()
        _ = await capture.start(transport: nil)
        guard capture.state == .running else {
            Issue.record("precondition: needs a granted environment; got \(capture.state)")
            return
        }
        await capture.pause(reason: "user")
        setTrusted(false) // any restart attempt now fails into permissionMissing

        recorder.capture = capture
        recorder.appState.recordingState = .paused(reason: "user")

        await recorder.resumeCapture()

        #expect(recorder.appState.recordingState != .active) // still paused
        #expect(capture.state == .permissionMissing) // restart failed for real
    }

    // MARK: - SW5-05: degraded survives disconnect/reconnect transitions

    @Test("markReconnecting preserves degraded; moves non-degraded statuses")
    func degradedSurvivesReconnectMark() {
        let recorder = RecorderCoordinator(socketPathOverride: "/nonexistent.sock")

        // Supervisor-set degraded (exit 46 / spawn failures) is terminal:
        // both the post-disconnect path and the catch bail-out must leave it.
        recorder.appState.daemonStatus = .degraded
        recorder.markReconnecting(attempt: 1)
        #expect(recorder.appState.daemonStatus == .degraded)

        // Non-degraded statuses still transition to reconnecting.
        recorder.appState.daemonStatus = .connected
        recorder.markReconnecting(attempt: 3)
        #expect(recorder.appState.daemonStatus == .reconnecting(attempt: 3))
    }

    // MARK: - SW5-03: quit watchdog races teardown against a timer

    @Test("watchdog bounds a never-completing teardown instead of hanging quit")
    func watchdogBoundsStuckTeardown() async {
        let clock = ContinuousClock()
        let start = clock.now
        let finished = await AppDelegate.awaitBounded(
            { try? await Task.sleep(for: .seconds(10)) }, // wedged teardown stand-in
            timeout: .milliseconds(100)
        )
        #expect(!finished) // watchdog won, not the work
        #expect(clock.now - start < .seconds(2)) // reply not blocked on the work
    }

    @Test("watchdog lets healthy teardown finish first")
    func watchdogLetsHealthyTeardownFinish() async {
        var completed = false
        let finished = await AppDelegate.awaitBounded(
            { completed = true },
            timeout: .seconds(5)
        )
        #expect(finished) // real teardown completed inside the window
        #expect(completed)
    }

    // MARK: - SW5-03 half-b: stop() disconnects so quit-time sends fail fast

    /// Thread-safe error capture for the deadline-polled batch probe.
    private final class SendErrorBox: @unchecked Sendable {
        private let lock = NSLock()
        private var error: Error?

        func store(_ newError: Error) {
            lock.lock()
            error = newError
            lock.unlock()
        }

        var captured: Error? {
            lock.lock()
            defer { lock.unlock() }
            return error
        }
    }

    /// Minimal wireable event for sendBatch (mirrors DaemonClientTests).
    private static func makeSpoolableEvent() -> ActivityEvent {
        ActivityEvent(
            id: Ulid.shared.next(nowMs: 1_700_000_000_000),
            observedAt: 1_700_000_000_000,
            monotonicNs: 0,
            source: .input,
            app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
            window: nil,
            action: .typingActivity,
            target: nil,
            content: nil,
            contentPolicy: .metadataOnly,
            captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        )
    }

    @Test("stop() disconnects the client so an in-flight gated batch fails fast")
    func stopDisconnectsClientAndFailsInFlightBatch() async throws {
        var pair: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            Issue.record("socketpair failed: errno \(errno)")
            return
        }
        let clientEnd = pair[0]
        defer { close(clientEnd); close(pair[1]) }
        var noSigPipe: Int32 = 1
        setsockopt(
            clientEnd,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &noSigPipe,
            socklen_t(MemoryLayout<Int32>.size)
        )

        // Writer parked behind a gate: the batch's encode+send stays wedged
        // for as long as the gate is closed, standing in for a
        // wedged-but-alive daemon at quit time.
        let gate = DispatchSemaphore(value: 0)
        let writerQueue = DispatchQueue(label: "test.lifecycle.writer")
        writerQueue.async { gate.wait() }

        let client = DaemonClient(writerQueue: writerQueue)
        client.adoptSocketForTesting(
            clientEnd,
            hello: ServerHello(
                protocolVersion: 1,
                messageId: "01M0NP9G4GXXGYT7PYGFC5K5HT",
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "test",
                databaseSchemaVersion: 1
            )
        )

        let recorder = RecorderCoordinator(socketPathOverride: "/nonexistent.sock", client: client)
        let (capture, _, _) = makeCoordinator() // never started → .idle
        recorder.capture = capture

        // One sendBatch in flight: registered, then parked behind the gate.
        let box = SendErrorBox()
        let batchTask = Task.detached {
            do {
                _ = try await client.sendBatch([Self.makeSpoolableEvent()])
            } catch {
                box.store(error)
            }
        }
        for _ in 0 ..< 100 {
            await Task.yield()
        }

        // The disconnect INSIDE stop() must drain pendings immediately —
        // while the gate is still closed — instead of waiting on the wedged
        // write or on capture teardown.
        await recorder.stop()

        let deadline = Date().addingTimeInterval(15)
        while box.captured == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        guard let error = box.captured else {
            Issue.record("in-flight batch never rejected within the 15 s window; stop() did not drain pendings")
            return
        }
        guard case DaemonClientError.notConnected = error else {
            Issue.record("expected .notConnected from stop()'s disconnect, got \(error)")
            return
        }
        _ = await batchTask.value

        #expect(capture.state == .idle) // teardown completed

        // The client stays disconnected: fresh requests fail fast.
        let clock = ContinuousClock()
        let fastStart = clock.now
        do {
            _ = try await client.request(op: "status.get", params: nil)
            Issue.record("expected a fresh request to throw after stop()")
        } catch DaemonClientError.notConnected {}
        #expect(clock.now - fastStart < .seconds(2))
    }

    // MARK: - InputMonitor teardown quiesce (UAF window closure)

    /// The tap callback dereferences its context box UNRETAINED on the tap
    /// run-loop thread, so stop() must not return while that thread can
    /// still be inside a callback. Regression guard for the WaveAudit15
    /// P3 finding: stop() now waits for the tap thread to signal exit
    /// before dropping the last strong reference to the box.
    @Test("stop() returns only after the tap thread has exited")
    func stopQuiescesTapThread() {
        let monitor = InputMonitor()
        // start() may return false in CI without input-monitoring permission
        // (CGEvent.tapCreate returns nil): then no tap thread is ever spawned.
        // Either way the probe holds trivially on a fresh monitor — and must
        // keep holding after stop().
        #expect(monitor.isTapThreadQuiesced)
        _ = monitor.start()
        monitor.stop()
        // No grace-period sleep: if a tap thread exists, stop() must have
        // already waited for its exit before returning.
        #expect(monitor.isTapThreadQuiesced)
        // Idempotent second stop keeps the invariant.
        monitor.stop()
        #expect(monitor.isTapThreadQuiesced)
    }

    /// A thread from a previous lifecycle that resumes after a quick
    /// stop()+start() must not mark the CURRENT lifecycle's tap thread
    /// quiesced; each cycle's exit is tagged with its own generation.
    @Test("repeated stop/start cycles keep the quiesce probe per-lifecycle")
    func stopStartChurnKeepsQuiesceProbeAccurate() {
        let monitor = InputMonitor()
        for _ in 0 ..< 3 {
            _ = monitor.start()
            monitor.stop()
            // After each stop() the current lifecycle's tap thread (if any)
            // has exited or never spawned; a stale predecessor cannot fake it.
            #expect(monitor.isTapThreadQuiesced)
        }
    }

    /// A tap thread stalled past stop()'s bounded wait — its exit landing
    /// only after a NEWER lifecycle has started and exited — must not
    /// clobber that lifecycle's quiesce state (WaveAudit17 S-1). Uses the
    /// testing seams: lifecycle N parks inside the exit gate while stop()'s
    /// bounded wait expires; lifecycle M then starts and exits cleanly;
    /// releasing N lands the stale exit. The probe must STILL report
    /// M-quiesced. On code without the slot-ownership gate on the exit
    /// writes, N overwrites `tapThreadExitedGeneration` with N and this
    /// assertion fails forever after.
    @Test("stalled predecessor exit cannot clobber the current lifecycle's quiesce probe")
    func stalledPredecessorExitDoesNotClobberQuiesceProbe() async {
        let monitor = InputMonitor()
        // Arm BEFORE spawning lifecycle N: the gate is installed on a fresh
        // monitor before any exit can be recorded, so N's park point is
        // already gated when it arrives — N cannot pass its final
        // bookkeeping until we release. (Arming after spawn races: N could
        // reach recordExit, find no gate, and exit unparked.)
        let gate = monitor.armExitGateForTesting()
        _ = monitor.spawnLifecycleThreadForTesting() // lifecycle N
        // Off the main actor: this parks inside stop()'s bounded 10 s wait
        // while N sits gated mid-exit — a real wedged/stalled predecessor.
        // Blocking the actor itself would starve sibling @MainActor tests.
        await Task.detached { monitor.stop() }.value
        #expect(Self.waitForEntered(gate)) // N announced its park
        monitor.disarmExitGateForTesting() // parked N stays parked; M exits freely

        _ = monitor.spawnLifecycleThreadForTesting() // lifecycle M claims the slot
        monitor.stop() // M exits promptly and records ITS OWN generation
        #expect(monitor.isTapThreadQuiesced) // M is genuinely quiesced here

        gate.release() // N's stale exit finally lands…
        // …on a pathologically stalled machine that landing can come long
        // after release(), so sample through a bounded window instead of a
        // fixed sleep + single probe: fail fast (red) the moment the stale
        // write flips M's truth, assert only after surviving the window.
        #expect(await Self.probeStaysQuiesced(monitor, window: 2.0))
    }

    /// DispatchSemaphore.wait is unavailable from async contexts; this
    /// sync wrapper keeps the deterministic ordering probe callable.
    private nonisolated static func waitForEntered(_ gate: InputMonitor.ExitGate) -> Bool {
        gate.entered.wait(timeout: .now() + 5) == .success
    }

    /// Samples the quiesce probe every 25 ms across `window`, mirroring the
    /// waitUntil pattern in DispatchTrustRecheckSchedulerTests: false as
    /// soon as the probe flips (a stale predecessor clobbered M's truth),
    /// true only once the full window has elapsed without a flip.
    private nonisolated static func probeStaysQuiesced(
        _ monitor: InputMonitor,
        window: TimeInterval,
        pollIntervalNanos: UInt64 = 25_000_000
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(window)
        while Date() < deadline {
            if !monitor.isTapThreadQuiesced {
                return false
            }
            try? await Task.sleep(nanoseconds: pollIntervalNanos)
        }
        return monitor.isTapThreadQuiesced
    }
}

// MARK: - Inert capture-monitor stubs

/// Same shape as CoordinatorVersionMismatchTests.makeInertRecorder:
/// start()/attach() are no-ops, so start(transport:) exercises the
/// coordinator state machine without ever touching CGEventTap or the
/// Accessibility API.
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
