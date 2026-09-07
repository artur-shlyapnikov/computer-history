import Foundation
@testable import RecorderApp
import Testing

/// DaemonSupervisor termination-status decoding (design round-3 §P2-4,
/// GateM0): REAL termination reasons are decoded — uncaught signals surface
/// as NEGATED codes so the UI can distinguish crashes from clean non-zero
/// exits — plus stop() teardown semantics interacting with pending restarts.
///
/// Fixtures: /bin/sh child scripts via COMPUTER_HISTORY_DAEMON_CMD (the same
/// mechanism SupervisorTests uses); injected `scheduleRestart` gates so no
/// real backoff sleeps happen. Waits use the shared EventCollector's bounded
/// helpers. Serialized: these tests mutate process-global env — per-suite via
/// @Suite(.serialized) and cross-suite via the shared SupervisorEnvGate lock.
@Suite(.serialized)
struct SupervisorExitEncodingTests {
    private func makeScript(_ body: String) throws -> URL {
        let script = URL(fileURLWithPath: FileManager.default.temporaryDirectory.path)
            .appendingPathComponent("ch-supervisor-exit-\(UUID().uuidString).sh")
        try Data("#!/bin/sh\n\(body)\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return script
    }

    /// Manual restart gate: scheduled closures are parked until released.
    private final class RestartGate: @unchecked Sendable {
        private let lock = NSLock()
        private var parked: [@Sendable () -> Void] = []

        func park(_ work: @escaping @Sendable () -> Void) {
            lock.withLock { parked.append(work) }
        }

        func releaseAll() {
            lock.withLock { parked }.forEach { $0() }
        }
    }

    private func firstExitCode(in events: [SupervisorEvent]) -> Int32? {
        for event in events {
            if case let .exited(code) = event {
                return code
            }
        }
        return nil
    }

    @Test("clean non-zero exit surfaces as positive code 46")
    func cleanExitEncodesPositiveCode() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = try makeScript("exit 46")
        defer { try? FileManager.default.removeItem(at: script) }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(eventHandler: { events.append($0) }, scheduleRestart: { _, _ in })
        supervisor.start()

        let sawExit = await events.waitFor({ !firstExitCode(in: $0).isNil }, timeoutSeconds: 5)
        #expect(sawExit)
        #expect(firstExitCode(in: events.snapshot()) == 46)
        supervisor.stop()
    }

    @Test("SIGKILL death surfaces as negated code -9")
    func sigkillSurfacesNegated() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = try makeScript("kill -9 $$")
        defer { try? FileManager.default.removeItem(at: script) }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(eventHandler: { events.append($0) }, scheduleRestart: { _, _ in })
        supervisor.start()

        let sawExit = await events.waitFor({ !firstExitCode(in: $0).isNil }, timeoutSeconds: 5)
        #expect(sawExit)
        // The GateM0 fix: uncaughtSignal → -terminationStatus (:147–151).
        #expect(firstExitCode(in: events.snapshot()) == -9)
        supervisor.stop()
    }

    @Test("SIGTERM death surfaces as negated code -15")
    func sigtermSurfacesNegated() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = try makeScript("kill -TERM $$")
        defer { try? FileManager.default.removeItem(at: script) }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(eventHandler: { events.append($0) }, scheduleRestart: { _, _ in })
        supervisor.start()

        let sawExit = await events.waitFor({ !firstExitCode(in: $0).isNil }, timeoutSeconds: 5)
        #expect(sawExit)
        #expect(firstExitCode(in: events.snapshot()) == -15)
        supervisor.stop()
    }

    @Test("stop() tears down the child synchronously and emits no exited event")
    func stopTearsDownSilentlyAndSynchronously() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = try makeScript("sleep 60")
        defer { try? FileManager.default.removeItem(at: script) }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(eventHandler: { events.append($0) }, scheduleRestart: { _, _ in })
        supervisor.start()
        #expect(await events.waitForAtLeast(1, timeoutSeconds: 5))
        guard let pid = events.firstSpawnedPid() else {
            Issue.record("expected a spawned child")
            return
        }
        #expect(kill(pid, 0) == 0)

        // Synchronous teardown: by the time stop() returns the child is gone.
        supervisor.stop()
        #expect(kill(pid, 0) != 0)

        // A stopped child must NOT surface as an ordinary daemon exit.
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(events.snapshot().allSatisfy { event in
            if case .exited = event {
                return false
            }
            return true
        })
    }

    @Test("stop() before a pending restart tick fires cancels the respawn")
    func stopCancelsPendingRestart() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = try makeScript("exit 7")
        defer { try? FileManager.default.removeItem(at: script) }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let gate = RestartGate()
        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { events.append($0) },
            scheduleRestart: { _, work in gate.park(work) } // manual tick gate
        )
        supervisor.start()

        // One crash → one scheduled (parked) restart.
        let scheduled = await events.waitFor({ $0.contains(.restartScheduled(delaySeconds: 1, consecutiveFailures: 1)) }, timeoutSeconds: 5)
        #expect(scheduled)

        // Stop BEFORE the tick is released…
        supervisor.stop()
        let atStop = events.snapshot().count

        // …then release it: the stopped latch must swallow the respawn.
        gate.releaseAll()
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(events.snapshot().count == atStop)
        let spawnedCount = events.snapshot().reduce(0) { count, event in
            if case .spawned = event {
                return count + 1
            }
            return count
        }
        #expect(spawnedCount == 1) // only the ORIGINAL pre-stop spawn
    }

    @Test("double stop() is safe and returns promptly")
    func doubleStopIsSafe() async {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        unsetenv("COMPUTER_HISTORY_DAEMON_CMD")

        let events = EventCollector()
        let supervisor = DaemonSupervisor(eventHandler: { events.append($0) }, scheduleRestart: { _, _ in })
        supervisor.start()
        _ = await events.waitForAtLeast(1, timeoutSeconds: 5)

        supervisor.stop()
        supervisor.stop() // second call: process already nil'd (:104)
        #expect(supervisor.currentConsecutiveFailures >= 0) // liveness probe
    }
}

private extension Int32? {
    var isNil: Bool {
        self == nil
    }
}
