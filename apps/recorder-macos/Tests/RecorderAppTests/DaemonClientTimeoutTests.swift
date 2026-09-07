import Foundation
@testable import RecorderApp
import Testing

/// Wire-deadline regressions (round 14, missing IPC deadlines): a peer that
/// accepts bytes but stays silent — wedged-but-alive, the exact failure mode
/// the codebase engineers for elsewhere (writer-queue isolation, SW5-03 quit
/// watchdog) — must resolve every registered waiter through the typed failure
/// path instead of pinning it forever. Reuses the internal ScriptedDaemon
/// harness from DaemonClientHandshakeTests.
struct DaemonClientTimeoutTests {
    // MARK: - Fixtures

    private static func helloReply(for hello: ClientHello) -> Data {
        try! JSONEncoder().encode(
            ServerHello(
                protocolVersion: 1,
                messageId: hello.messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "timeout-echo",
                databaseSchemaVersion: 1
            )
        )
    }

    /// Minimal valid `response` frame echoing `requestId` back to the client.
    private static func statusResponse(requestId: String) -> Data {
        let reply =
            #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(requestId)","ok":true,"result":{"daemon":{"version":"timeout-echo","schemaVersion":1,"uptimeMs":42},"recording":{"paused":false},"accessibilityRequired":false,"queue":{"pending":0,"retrying":0,"dead":0},"db":{"rawEvents":0,"segments":0,"steps":0,"episodes":0,"memories":0,"workflows":0,"pageCountBytes":8192},"diskFreeBytes":12345678}}"#
        return Data(reply.utf8)
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

    /// Gate deciding whether the fake daemon answers non-handshake frames.
    /// Closed = silent-but-open (bytes accepted, no reply ever); opened later to
    /// prove the connection survives a deadline firing.
    private final class ReplyGate: @unchecked Sendable {
        private let lock = NSLock()
        private var open = false

        func unblock() {
            lock.lock()
            open = true
            lock.unlock()
        }

        /// Suspends until unblock() has been called (poll-based: the gate is
        /// a plain NSLock flag, so waiting tasks re-check every 10 ms).
        func waitUntilOpen() async {
            while !isOpen {
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }

        var isOpen: Bool {
            lock.lock()
            defer { lock.unlock() }
            return open
        }
    }

    /// Scripted daemon: completes the handshake, then answers subsequent
    /// request frames ONLY while the gate is open (echoing their requestId).
    private static func makeGatedEchoDaemon(gate: ReplyGate) throws -> ScriptedDaemon {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-timeout-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                guard gate.isOpen else { break } // parked: connection alive, no reply
                ScriptedDaemon.sendFrame(fd: client, payload: Self.statusResponse(requestId: request.requestId))
            case .other:
                break // event batches: parked too
            }
        }
        try daemon.start()
        return daemon
    }

    /// Scripted daemon for late-reply races: completes the handshake, then
    /// parks every request received while the gate is closed. Once the gate
    /// opens, each parked frame receives its reply after `delay` seconds —
    /// long past that waiter's deadline — echoed on the ORIGINAL connection,
    /// so the client must route (or discard) an already-expired response.
    /// Requests sent while the gate is open are answered immediately.
    private static func makeLateReplyDaemon(gate: ReplyGate, delay: TimeInterval) throws -> ScriptedDaemon {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-late-reply-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                // Mirror production's SO_NOSIGPIPE (openUnixSocket): a late
                // reply can target a client-closed socket after a
                // disconnect/reconnect; the failing send must raise errno,
                // not kill the test process with SIGPIPE.
                var noSigPipe: Int32 = 1
                setsockopt(
                    client,
                    SOL_SOCKET,
                    SO_NOSIGPIPE,
                    &noSigPipe,
                    socklen_t(MemoryLayout<Int32>.size)
                )
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                if gate.isOpen {
                    ScriptedDaemon.sendFrame(fd: client, payload: Self.statusResponse(requestId: request.requestId))
                    break
                }
                // Parked: deliver a LATE reply once the gate opens.
                let requestId = request.requestId
                Task.detached {
                    await gate.waitUntilOpen()
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    ScriptedDaemon.sendFrame(fd: client, payload: Self.statusResponse(requestId: requestId))
                }
            case .other:
                break // event batches: parked too
            }
        }
        try daemon.start()
        return daemon
    }

    // MARK: - Tests

    @Test("request against a silent-but-open peer times out with replyTimedOut")
    func requestTimesOutAgainstSilentPeer() async throws {
        let gate = ReplyGate()
        let daemon = try Self.makeGatedEchoDaemon(gate: gate)
        defer { daemon.stop() }

        let client = DaemonClient(handshakeTimeout: 5, replyTimeout: 0.3)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect {
            _ = try await client.request(op: "status.get", params: nil)
        } throws: { error in
            if case DaemonClientError.replyTimedOut = error {
                return true
            }
            return false
        }

        // The deadline fires WITHOUT tearing down the socket: the peer is
        // silent, not gone, so the client must stay connected (unlike the
        // notConnected teardown paths).
        #expect(client.isConnectedToDaemon)

        // And the same connection stays usable once the peer starts replying:
        // the expired waiter was removed from pendingResponses, so the late
        // world keeps routing fresh responses normally.
        gate.unblock()
        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)
        client.disconnect()
    }

    @Test("event_batch against a silent-but-open peer times out with replyTimedOut")
    func batchTimesOutAgainstSilentPeer() async throws {
        let gate = ReplyGate()
        let daemon = try Self.makeGatedEchoDaemon(gate: gate)
        defer { daemon.stop() }

        let client = DaemonClient(handshakeTimeout: 5, replyTimeout: 0.3)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect {
            _ = try await client.sendBatch([Self.makeEvent()])
        } throws: { error in
            if case DaemonClientError.replyTimedOut = error {
                return true
            }
            return false
        }
        // Spool fallback depends on sendBatch throwing while the connection
        // itself is still considered healthy.
        #expect(client.isConnectedToDaemon)
        client.disconnect()
    }

    @Test("handshake against a silent peer times out into the handshake-failure path")
    func handshakeTimesOutAgainstSilentPeer() async throws {
        // Accepts and reads the ClientHello but NEVER replies — the wedged
        // daemon shape that previously pinned connectAndHandshake forever.
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-hs-timeout-\(UUID().uuidString).sock").path
        ) { _, _, _ in }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient(handshakeTimeout: 0.3, replyTimeout: 5)
        await #expect {
            _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        } throws: { error in
            // Same typed channel as every other handshake failure, so
            // RecorderCoordinator's retry loop engages instead of hanging.
            if case let DaemonClientError.handshakeFailed(message) = error,
               message.contains("timed out")
            {
                return true
            }
            return false
        }
        #expect(!client.isConnectedToDaemon)
        client.disconnect()
    }

    @Test("late reply after replyTimedOut neither crashes nor resolves a newer waiter")
    func lateReplyAfterTimeoutLeavesCleanupPinned() async throws {
        let gate = ReplyGate()
        // The parked frame's reply lands ~2x replyTimeout after the gate
        // opens — well past the original waiter's 0.3s deadline.
        let daemon = try Self.makeLateReplyDaemon(gate: gate, delay: 0.6)
        defer { daemon.stop() }

        let client = DaemonClient(handshakeTimeout: 5, replyTimeout: 0.3)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect {
            _ = try await client.request(op: "status.get", params: nil)
        } throws: { error in
            if case DaemonClientError.replyTimedOut = error {
                return true
            }
            return false
        }
        #expect(client.isConnectedToDaemon)

        // A NEWER waiter registers on the same connection BEFORE the delayed
        // reply for the expired one crosses the wire.
        gate.unblock()
        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)

        // Let the late frame land in the expired waiter's slot. If
        // armReplyTimeout leaked the stale continuation (missing removeValue),
        // this response would resume a dead continuation — a guaranteed
        // runtime trap, never a silent pass — or otherwise disturb routing.
        try await Task.sleep(nanoseconds: 900_000_000)

        // And the connection still routes fresh traffic normally afterwards.
        let followUp = try await client.request(op: "status.get", params: nil)
        #expect(followUp.ok)
        client.disconnect()
    }

    @Test("deadline across a disconnect/reconnect leaves the newer generation untouched")
    func timeoutAcrossReconnectDoesNotDisturbNewGeneration() async throws {
        let gate = ReplyGate()
        let daemon = try Self.makeLateReplyDaemon(gate: gate, delay: 0.6)
        defer { daemon.stop() }

        let client = DaemonClient(handshakeTimeout: 5, replyTimeout: 0.3)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        // Generation 0: park a request and let its deadline fire.
        await #expect {
            _ = try await client.request(op: "status.get", params: nil)
        } throws: { error in
            if case DaemonClientError.replyTimedOut = error {
                return true
            }
            return false
        }

        // Reconnect on the SAME client instance: disconnect bumps
        // connectionGeneration and the handshake bumps it again, so the old
        // deadline timer now targets a dead generation on a closed socket.
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(client.isConnectedToDaemon)

        // The parked frame's late reply is written to the OLD socket only
        // (the client side is closed); it must never reach — nor disturb — a
        // waiter of the newer generation, which answers concurrently.
        gate.unblock()
        async let newGenerationResponse = client.request(op: "status.get", params: nil)
        try await Task.sleep(nanoseconds: 900_000_000)
        #expect(try await newGenerationResponse.ok)

        client.disconnect()
    }

    // MARK: - Transport send failure is connection-fatal (WaveAudit15)

    /// Connected AF_UNIX socketpair with production's SO_NOSIGPIPE; caller
    /// owns BOTH descriptors. Shutting OUR end's write side down makes every
    /// send fail deterministically with EPIPE — the transport-write failure
    /// shape (same handling as SO_SNDTIMEO EAGAIN), without wall-clock waits.
    private static func makeSocketPair() throws -> (Int32, Int32) {
        var pair: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS)
        }
        for fd in pair {
            var noSigPipe: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        }
        return (pair[0], pair[1])
    }

    private static func testHello() -> ServerHello {
        ServerHello(
            protocolVersion: 1,
            messageId: "01M0NP9G4GXXGYT7PYGFC5K5HT",
            type: "server_hello",
            sentAt: 1,
            daemonVersion: "send-fatal-tests",
            databaseSchemaVersion: 1
        )
    }

    @Test("transport write failure fails the pending request typed and tears down; reconnect succeeds")
    func requestSendFailureTearsDownAndCleanReconnectSucceeds() async throws {
        let (clientEnd, farEnd) = try Self.makeSocketPair()
        defer { close(farEnd) }

        let client = DaemonClient(handshakeTimeout: 5, replyTimeout: 5)
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())
        shutdown(clientEnd, SHUT_WR) // every send now fails EPIPE, deterministically

        await #expect {
            _ = try await client.request(op: "status.get", params: nil)
        } throws: { error in
            if case let DaemonClientError.transportWriteFailed(message) = error {
                return !message.isEmpty
            }
            return false
        }

        // The pre-patch defect: the writer path failed only this waiter and
        // kept fd/negotiatedHello intact — a truncated frame on a stream the
        // client still believed healthy. The fix must tear the connection
        // down exactly like the receive-side poison paths.
        #expect(!client.isConnectedToDaemon)

        // Clean cutover: a subsequent handshake on the SAME instance rebuilds
        // a working stream (what RecorderCoordinator's reconnect loop does).
        let gate = ReplyGate()
        gate.unblock()
        let daemon = try Self.makeGatedEchoDaemon(gate: gate)
        defer { daemon.stop() }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(client.isConnectedToDaemon)
        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)
        client.disconnect()
    }

    @Test("transport write failure drains concurrent waiters with transportWriteFailed")
    func batchSendFailureDrainsAllPendingsTyped() async throws {
        let (clientEnd, farEnd) = try Self.makeSocketPair()
        defer { close(farEnd) }

        // Gated writer queue: its head parks until both batches below have
        // registered their pendings, so the FIRST failed write's teardown
        // deterministically drains BOTH waiters (no registration race).
        let writerQueue = DispatchQueue(label: "ch-send-fatal.gated-writer")
        let parkWriter = DispatchSemaphore(value: 0)
        writerQueue.async { parkWriter.wait() }

        let client = DaemonClient(writerQueue: writerQueue, handshakeTimeout: 5, replyTimeout: 5)
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())
        shutdown(clientEnd, SHUT_WR)

        func runBatch() async -> Error? {
            do {
                _ = try await client.sendBatch([Self.makeEvent()])
                return nil
            } catch {
                return error
            }
        }
        async let firstError = runBatch()
        async let secondError = runBatch()

        // Observation-based gate: wait until BOTH senders have registered
        // their pendings (sub-microsecond map inserts once their tasks run);
        // only then unblock the writer queue, so the first failed write
        // deterministically drains BOTH waiters — no scheduling-margin race.
        let clock = ContinuousClock()
        let start = clock.now
        var bothRegistered = false
        while clock.now - start < .seconds(5) {
            if client.pendingBatchCountForTesting >= 2 {
                bothRegistered = true
                break
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(bothRegistered, "both batch pendings must register before the writer gate opens")
        parkWriter.signal()

        for error in await [firstError, secondError] {
            guard case let .some(observed) = error else {
                Issue.record("expected sendBatch to throw, got success")
                continue
            }
            guard case DaemonClientError.transportWriteFailed = observed else {
                Issue.record("expected transportWriteFailed, got \(observed)")
                continue
            }
        }
        #expect(!client.isConnectedToDaemon)
    }
}
