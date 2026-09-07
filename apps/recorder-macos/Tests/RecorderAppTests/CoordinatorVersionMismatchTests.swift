import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe handshake counter: counts client_hello frames received by the
/// scripted daemon. After a protocol-version mismatch the connection loop must
/// EXIT (`return`), so this counter is the quiescence witness: any reconnect
/// attempt (the generic-catch mutation) shows up as a second increment.
final class HandshakeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0

    func increment() {
        lock.lock(); defer { lock.unlock() }
        _count += 1
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return _count
    }
}

/// Cross-suite serialization gate for every test that mutates the
/// process-global COMPUTER_HISTORY_DAEMON_CMD environment variable.
/// `@Suite(.serialized)` only orders tests WITHIN a single suite; Swift
/// Testing runs distinct suites concurrently, and DaemonSupervisor reads
/// ProcessInfo.environment asynchronously on its event queue at spawn time,
/// so a sibling suite's setenv/unsetenv interleaved between this suite's
/// setenv and that read would change which child spawns (and concurrent
/// getenv/setenv is POSIX-undefined besides). Hold the gate from the setenv
/// until the last possible asynchronous env read — i.e., across the whole
/// test body — so mutation and spawn reads can never interleave.
///
/// Actor-based deliberately: waiters SUSPEND instead of blocking a
/// cooperative-pool thread (a plain NSLock here deadlocks once enough
/// gated tests park every pool thread while the holder is suspended).
actor SupervisorEnvGate {
    static let shared = SupervisorEnvGate()

    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// Hands ownership straight to the oldest waiter (stays locked), or
    /// unlocks when nobody is queued.
    func release() {
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            locked = false
        }
    }
}

/// R9-S2: the composition root's protocol-version-mismatch translation.
/// A mismatch is terminal for this session shape: runConnectionLoop must
/// surface `.degraded` and RETURN instead of markReconnecting + retry
/// (ComputerHistoryApp.swift catch DaemonClientError.protocolVersionMismatch).
/// A revert to retry-flapping keeps every status-only assertion green, which
/// is why the load-bearing check here is handshake-counter QUIESCENCE.
///
/// Harness: ScriptedDaemon (same-module, DaemonClientHandshakeTests.swift)
/// answers every client_hello with server_hello.protocolVersion 99; the
/// coordinator gets the socket-path override + its own injected client, per
/// the CaptureLifecycleTests/RecorderCoordinatorMappingTests pattern. The
/// supervisor is pinned to an inert command so its restart ladder can never
/// independently produce `.degraded`.
@MainActor
struct CoordinatorVersionMismatchTests {
    /// Inert supervisor command: spawns one sleeping child that stop() kills;
    /// no exit events, no restart ladder, no competing `.degraded` source.
    private static let inertDaemonCommand = "sleep 60"

    /// Builds a RecorderCoordinator whose capture stack is fully inert.
    /// RecorderCoordinator.start() would otherwise boot the REAL
    /// InputMonitor/AXMonitor/WorkspaceMonitor trio (and fire
    /// AXMonitor.checkPermission(prompt: true)); a synchronous
    /// AXUIElementCopyAttributeValue against an animating window never
    /// returns and wedges the suite on machines with a live UI. Injecting
    /// the coordinator BEFORE start() makes ensureCaptureCoordinator() a
    /// no-op, so only supervisor/client/coordinator logic runs here.
    private func makeInertRecorder(daemonPath: String) -> RecorderCoordinator {
        let recorder = RecorderCoordinator(socketPathOverride: daemonPath)
        let capture = CaptureCoordinator(
            spoolDirectory: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-r9cm-spool-\(UUID().uuidString)"),
            monitorFactories: MonitorFactories(
                workspace: { StubWorkspaceMonitor() },
                input: { StubInputMonitor() },
                ax: { StubAXMonitor() }
            )
        )
        capture.trustCheck = { true }
        recorder.capture = capture
        return recorder
    }

    private func makeMismatchingDaemon(path: String) -> (ScriptedDaemon, HandshakeCounter) {
        let counter = HandshakeCounter()
        let daemon = ScriptedDaemon(path: path) { _, client, frame in
            guard case let .clientHello(hello) = frame else { return }
            counter.increment()
            let reply = ServerHello(
                protocolVersion: 99,
                messageId: hello.messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "mismatch-0.0.0",
                databaseSchemaVersion: 1
            )
            guard let payload = try? JSONEncoder().encode(reply) else { return }
            ScriptedDaemon.sendFrame(fd: client, payload: payload)
        }
        return (daemon, counter)
    }

    @Test("protocol-version mismatch degrades and the reconnect loop quiesces")
    func mismatchDegradesAndQuiesces() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", Self.inertDaemonCommand, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let (daemon, handshakes) = makeMismatchingDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-r9cm1-\(UUID().uuidString).sock").path
        )
        try daemon.start()

        let coordinator = makeInertRecorder(daemonPath: daemon.path)
        coordinator.start()

        // Bounded poll for the terminal degraded translation.
        var settled = false
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if coordinator.appState.daemonStatus == .degraded {
                settled = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(settled)
        #expect(coordinator.appState.daemonStatus == .degraded)

        // Quiescence: exactly ONE handshake attempt ever happened, and none
        // follow within the observation window (a markReconnecting/continue
        // regression reconnects within ~1s and fails this).
        try await Task.sleep(for: .seconds(2))
        #expect(handshakes.count == 1)
        #expect(coordinator.appState.daemonStatus == .degraded)

        await coordinator.stop()
        daemon.stop()
    }

    @Test("mismatch-degraded survives a later disconnect signal")
    func degradedSurvivesDisconnect() async throws {
        await SupervisorEnvGate.shared.acquire()
        defer { Task { await SupervisorEnvGate.shared.release() } }
        setenv("COMPUTER_HISTORY_DAEMON_CMD", Self.inertDaemonCommand, 1)
        defer { unsetenv("COMPUTER_HISTORY_DAEMON_CMD") }

        let (daemon, handshakes) = makeMismatchingDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-r9cm2-\(UUID().uuidString).sock").path
        )
        try daemon.start()

        let coordinator = makeInertRecorder(daemonPath: daemon.path)
        coordinator.start()

        var settled = false
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if coordinator.appState.daemonStatus == .degraded {
                settled = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(settled)

        // Shared SW5-05 guard: firing the disconnect handler afterwards must
        // not downgrade the terminal `.degraded` back into `.reconnecting`
        // (only non-degraded statuses may move).
        coordinator.client.onDisconnect?()
        try await Task.sleep(for: .milliseconds(300))
        #expect(coordinator.appState.daemonStatus == .degraded)
        #expect(handshakes.count == 1)

        await coordinator.stop()
        daemon.stop()
    }
}

// MARK: - Inert capture-monitor stubs (see makeInertRecorder)

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
