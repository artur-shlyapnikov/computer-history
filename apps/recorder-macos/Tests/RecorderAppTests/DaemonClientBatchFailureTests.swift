import Foundation
@testable import RecorderApp
import Testing

/// DaemonClient's async `error`-frame → pending-batch failure path and the
/// explicit disconnect() drain (design P2-4): when the daemon rejects an
/// event_batch it answers with a top-level error frame echoing the batch's
/// messageId; sendBatch must reject so EventBuffer spools the batch. Reuses
/// the internal ScriptedDaemon from DaemonClientHandshakeTests.
struct DaemonClientBatchFailureTests {
    // MARK: - Fixtures

    private static func helloReply(for hello: ClientHello) -> Data {
        try! JSONEncoder().encode(
            ServerHello(
                protocolVersion: 1,
                messageId: hello.messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "batch-failure-echo",
                databaseSchemaVersion: 1
            )
        )
    }

    private static func makeEvent() -> ActivityEvent {
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

    /// Scripted daemon that completes the handshake and hands every
    /// subsequent non-request frame (i.e. event_batch bodies) to the caller.
    private static func makeHandshakenDaemon(
        onBatch: @escaping @Sendable (_ clientFd: Int32, _ batchBody: Data) -> Void
    ) throws -> ScriptedDaemon {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-batchfail-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case .request:
                break // parked: never replies
            case let .other(body):
                onBatch(client, body)
            }
        }
        try daemon.start()
        return daemon
    }

    private static func makeErrorFrame(messageId: String) -> Data {
        Data(
            #"{"protocolVersion":1,"messageId":"\#(messageId)","type":"error","sentAt":1,"error":{"code":"error.bad_frame","message":"rejected"}}"#
                .utf8
        )
    }

    @Test("async error frame echoing the batch messageId rejects sendBatch")
    func matchedErrorFrameRejectsBatch() async throws {
        let daemon = try Self.makeHandshakenDaemon { client, body in
            guard let batch = try? JSONDecoder().decode(EventBatch.self, from: body) else { return }
            ScriptedDaemon.sendFrame(fd: client, payload: Self.makeErrorFrame(messageId: batch.messageId))
        }
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        // failPendingBatch matches by messageId; the message text proves the
        // rejection came from the error frame, not a teardown path.
        await #expect(throws: DaemonClientError.handshakeFailed("rejected")) {
            _ = try await client.sendBatch([Self.makeEvent()])
        }
        #expect(client.isConnectedToDaemon) // rejected, not disconnected
        client.disconnect()
    }

    @Test("unrelated error frame is ignored; batch fails only at peer close")
    func unmatchedErrorFrameDoesNotFailBatch() async throws {
        let daemon = try Self.makeHandshakenDaemon { client, _ in
            ScriptedDaemon.sendFrame(fd: client, payload: Self.makeErrorFrame(messageId: "not-this-batch"))
            shutdown(client, SHUT_RDWR)
        }
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        // The bogus messageId must NOT resolve the waiter with the error
        // frame's failure — the only legitimate resolution is the peer-close
        // drain failing it with notConnected.
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.sendBatch([Self.makeEvent()])
        }
        #expect(!client.isConnectedToDaemon)
    }

    @Test("unknown frame shapes are ignored before the ack resolves the batch")
    func garbageFrameToleratedBeforeAck() async throws {
        let daemon = try Self.makeHandshakenDaemon { client, body in
            guard let batch = try? JSONDecoder().decode(EventBatch.self, from: body) else { return }
            // Matches no known wire shape → route()'s final try? chain link
            // must swallow it silently.
            ScriptedDaemon.sendFrame(fd: client, payload: Data(#"{"totally":"garbage"}"#.utf8))
            let ack =
                #"{"protocolVersion":1,"messageId":"ack-any","type":"event_batch_ack","sentAt":1,"batchId":"\#(batch.batchId)","accepted":1,"duplicates":0,"rejected":0}"#
            ScriptedDaemon.sendFrame(fd: client, payload: Data(ack.utf8))
        }
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let ack = try await client.sendBatch([Self.makeEvent()])
        #expect(ack.accepted == 1)
        #expect(!ack.batchId.isEmpty)
        client.disconnect()
    }

    /// Sendable box for an error captured across a Task boundary.
    private final class ErrorBox: @unchecked Sendable {
        private let lock = NSLock()
        private var error: Error?
        func set(_ e: Error) {
            lock.lock(); error = e; lock.unlock()
        }

        var value: Error? {
            lock.lock(); defer { lock.unlock() }; return error
        }
    }

    private static func waitForArrival(_ semaphore: DispatchSemaphore) -> Bool {
        semaphore.wait(timeout: .now() + 5) == .success
    }

    @Test("explicit disconnect drains an in-flight request with notConnected")
    func disconnectDrainsInFlightRequest() async throws {
        // Signals once the request FRAME has been read by the daemon thread:
        // the client registers its continuation BEFORE sending, so arrival
        // proves the waiter is parked in pendingResponses.
        let arrived = DispatchSemaphore(value: 0)
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-drain-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case .request:
                arrived.signal()
            // Park without replying; loop blocks in its own recv.
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(client.isConnectedToDaemon)

        let box = ErrorBox()
        let task = Task {
            do {
                _ = try await client.request(op: "status.get", params: nil)
            } catch {
                box.set(error)
            }
        }
        // Bounded wait purely as a hang guard; registration is already proven
        // by the frame having been written and read. (Blocking call lives in
        // a sync helper: DispatchSemaphore.wait is unavailable in async.)
        _ = Self.waitForArrival(arrived)
        client.disconnect()

        await task.value // resolves promptly via the disconnect drain
        #expect((box.value as? DaemonClientError) == .notConnected)
        #expect(!client.isConnectedToDaemon)
        client.disconnect()
    }

    @Test("after disconnect, request and sendBatch throw notConnected synchronously-fast")
    func callsAfterDisconnectThrowImmediately() async throws {
        let client = DaemonClient()
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.request(op: "status.get", params: nil)
        }
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.sendBatch([Self.makeEvent()])
        }
        #expect(!client.isConnectedToDaemon)
    }
}
