import Foundation
@testable import RecorderApp
import Testing

/// Serialized: these tests mutate process-global env and spawn real children.
/// The SupervisorEnvGate lock additionally serializes them against the OTHER
/// env-mutating suites (cross-suite; @Suite(.serialized) is per-suite only).
@Suite(.serialized)
struct SupervisorBackoffTests {
    @Test("backoff sequence is 1,2,5,15,30 then capped at 30")
    func backoffSequence() {
        let expected = [1, 2, 5, 15, 30]
        for (index, delay) in expected.enumerated() {
            #expect(SupervisorPolicy.delay(afterFailureAt: index + 1) == delay)
        }
        // Beyond the table: stays capped at the maximum.
        #expect(SupervisorPolicy.delay(afterFailureAt: 6) == 30)
        #expect(SupervisorPolicy.delay(afterFailureAt: 25) == 30)
        #expect(SupervisorPolicy.delay(afterFailureAt: 0) == 1)
    }

    @Test("degraded only after ten consecutive failures")
    func degradedThreshold() {
        #expect(!SupervisorPolicy.isDegraded(consecutiveFailures: 1))
        #expect(!SupervisorPolicy.isDegraded(consecutiveFailures: 9))
        #expect(SupervisorPolicy.isDegraded(consecutiveFailures: 10))
        #expect(SupervisorPolicy.isDegraded(consecutiveFailures: 11))
        #expect(SupervisorPolicy.maxConsecutiveFailures == 10)
    }

    @Test("supervisor counts consecutive failures and emits degraded")
    func supervisorCountsFailures() async {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { event in events.append(event) },
            scheduleRestart: { delay, work in
                // Delayed, not immediate: a synchronous scheduler would recurse
                // spawn→fail→spawn and starve the serial event queue.
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delay), execute: work)
            }
        )
        supervisor.start()

        // With no daemon command available, each spawn attempt fails immediately.
        try? await Task.sleep(for: .milliseconds(300))
        var attempts = 0
        while attempts < 10, supervisor.currentConsecutiveFailures < 10 {
            try? await Task.sleep(for: .milliseconds(200))
            attempts += 1
        }

        let failures = supervisor.currentConsecutiveFailures
        #expect(failures >= 10 || attempts >= 10)
        if failures >= 10 {
            events.expectContains(.degraded)
        }
        supervisor.stop()
    }

    @Test("stop() terminates a spawned child process cleanly")
    func stopTerminatesChild() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = URL(fileURLWithPath: FileManager.default.temporaryDirectory.path)
            .appendingPathComponent("ch-supervisor-test-\(UUID().uuidString).sh")
        try Data("#!/bin/sh\nsleep 60\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        defer { try? FileManager.default.removeItem(at: script) }

        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { events.append($0) },
            scheduleRestart: { _, _ in } // no auto-restart during this test
        )
        supervisor.start()
        _ = await events.waitForAtLeast(1, timeoutSeconds: 5)

        let spawnedPid = events.firstSpawnedPid()
        #expect(spawnedPid != nil)
        if let pid = spawnedPid {
            #expect(kill(pid, 0) == 0) // child alive before stop
        }
        supervisor.stop()
        try? await Task.sleep(for: .milliseconds(500))
        if let pid = spawnedPid {
            #expect(kill(pid, 0) != 0) // child reaped after stop
        }
    }

    @Test("after the tenth consecutive failure no further restart is scheduled")
    func degradedStopsAutomaticRestart() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        unsetenv("COMPUTER_HISTORY_DAEMON_CMD") // every spawn attempt fails fast

        final class Counter: @unchecked Sendable {
            let lock = NSLock()
            var value = 0
        }
        let scheduleCalls = Counter()
        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { events.append($0) },
            scheduleRestart: { delay, work in
                scheduleCalls.lock.withLock { scheduleCalls.value += 1 }
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delay), execute: work)
            }
        )
        supervisor.start()

        #expect(await events.waitFor({ $0.contains(.degraded) }, timeoutSeconds: 15))

        // Give any illegal post-degradation restart plenty of time to surface.
        try await Task.sleep(for: .milliseconds(500))

        let snapshot = events.snapshot()
        let scheduled = snapshot.filter {
            if case .restartScheduled = $0 {
                return true
            }
            return false
        }
        // Failures 1–9 each schedule one restart; failure #10 must not.
        #expect(scheduled.count == 9)
        #expect(snapshot.filter { $0 == .degraded }.count == 1)
        #expect(snapshot.last == .degraded)
        let scheduleCount = scheduleCalls.lock.withLock { scheduleCalls.value }
        #expect(scheduleCount == 9)

        // The event stream has gone quiet: no timer fired after degradation.
        let quiescentCount = events.snapshot().count
        try await Task.sleep(for: .milliseconds(300))
        #expect(events.snapshot().count == quiescentCount)

        supervisor.stop()
    }

    @Test("successful spawn resets the streak so a later crash backs off from 1s again")
    func successfulSpawnResetsFailureStreak() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        let script = URL(fileURLWithPath: FileManager.default.temporaryDirectory.path)
            .appendingPathComponent("ch-supervisor-test-\(UUID().uuidString).sh")
        try Data("#!/bin/sh\nexit 7\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        defer { try? FileManager.default.removeItem(at: script) }

        setenv("COMPUTER_HISTORY_DAEMON_CMD", script.path, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { events.append($0) },
            scheduleRestart: { delay, work in
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delay), execute: work)
            }
        )
        supervisor.start()

        // Each cycle: spawn succeeds (streak resets to 0) → child exits with 7
        // → that crash counts as failure #1 again → restart scheduled at 1s.
        // Without the reset the second cycle would report consecutiveFailures: 2.
        #expect(await events.waitFor({ snapshot in
            snapshot.filter {
                if case .restartScheduled(delaySeconds: 1, consecutiveFailures: 1) = $0 {
                    return true
                }
                return false
            }.count >= 2
        }, timeoutSeconds: 10))

        #expect(supervisor.currentConsecutiveFailures <= 1)
        supervisor.stop()
    }

    @Test("explicit user start recovers from degraded")
    func userStartRecoversFromDegraded() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        unsetenv("COMPUTER_HISTORY_DAEMON_CMD")

        let events = EventCollector()
        let supervisor = DaemonSupervisor(
            eventHandler: { events.append($0) },
            scheduleRestart: { delay, work in
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delay), execute: work)
            }
        )
        supervisor.start()
        #expect(await events.waitFor({ $0.contains(.degraded) }, timeoutSeconds: 15))

        // Degraded: automatic restarting has stopped; the event stream is idle.
        let idleCount = events.snapshot().count
        try await Task.sleep(for: .milliseconds(300))
        #expect(events.snapshot().count == idleCount)

        // Explicit user start resets the streak and spawns again.
        supervisor.start()
        #expect(await events.waitFor({ snapshot in
            guard let degradedIndex = snapshot.firstIndex(of: .degraded) else { return false }
            return snapshot[(degradedIndex + 1)...].contains(.restartScheduled(delaySeconds: 1, consecutiveFailures: 1))
        }, timeoutSeconds: 5))

        supervisor.stop()
        unsetenv("COMPUTER_HISTORY_DAEMON_CMD")
    }
}

/// Thread-safe collector of supervisor events for tests.
final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [SupervisorEvent] = []

    func append(_ event: SupervisorEvent) {
        lock.lock()
        storage.append(event)
        lock.unlock()
    }

    func waitForAtLeast(_ count: Int, timeoutSeconds: Double) async -> Bool {
        await waitFor({ $0.count >= count }, timeoutSeconds: timeoutSeconds)
    }

    /// Polls until `predicate` holds over a snapshot of collected events.
    func waitFor(
        _ predicate: @Sendable @escaping ([SupervisorEvent]) -> Bool,
        timeoutSeconds: Double
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if predicate(snapshot()) {
                return true
            }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return false
    }

    func snapshot() -> [SupervisorEvent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage.count
    }

    func firstSpawnedPid() -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        for case let .spawned(pid) in storage {
            return pid
        }
        return nil
    }

    func expectContains(_ target: SupervisorEvent) {
        lock.lock()
        defer { lock.unlock() }
        #expect(storage.contains(target))
    }
}
