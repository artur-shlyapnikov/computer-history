import Foundation
@testable import RecorderApp
import Testing

/**
 * SW5-04a: request() writes must run on the dedicated serial writer queue —
 * the same one sendBatch uses — so a wedged-but-alive daemon pins that
 * queue's thread instead of one cooperative-pool thread per caller, while
 * response correlation and the connection-generation invalidation semantics
 * stay exactly as before.
 *
 * Reuses ScriptedDaemon from DaemonClientHandshakeTests.
 */
struct DaemonClientTests {
    // MARK: - Fixtures

    private static func helloReply(for hello: ClientHello) -> Data {
        try! JSONEncoder().encode(
            ServerHello(
                protocolVersion: 1,
                messageId: hello.messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "daemon-client-tests",
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

    private static func responseFrame(for request: RequestFrame) -> Data {
        try! JSONEncoder().encode(
            ResponseFrame(
                protocolVersion: 1,
                messageId: request.messageId,
                type: "response",
                sentAt: 2,
                requestId: request.requestId,
                ok: true,
                result: .string("ok-\(request.op)"),
                error: nil
            )
        )
    }

    private static func batchAckFrame(for batch: EventBatch) -> Data {
        try! JSONEncoder().encode(
            EventBatchAck(
                protocolVersion: 1,
                messageId: batch.messageId,
                type: "event_batch_ack",
                sentAt: 2,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        )
    }

    /// Thread-safe wire-order recorder (frames as they arrive at the daemon).
    private final class OrderRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String] = []

        func append(_ entry: String) {
            lock.lock()
            defer { lock.unlock() }
            entries.append(entry)
        }

        var snapshot: [String] {
            lock.lock()
            defer { lock.unlock() }
            return entries
        }
    }

    /// Thread-safe one-shot completion flag for the starvation probe.
    private final class ProbeBox: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func markDone() {
            lock.lock()
            done = true
            lock.unlock()
        }

        var finished: Bool {
            lock.lock()
            defer { lock.unlock() }
            return done
        }
    }

    /// Daemon stand-in that completes the handshake and then NEVER reads
    /// again: the peer's blocking send wedges once its kernel buffers fill,
    /// reproducing a wedged-but-alive daemon without socket timeouts.
    private final class WedgeDaemon: @unchecked Sendable {
        let path: String
        private var listenFd: Int32 = -1

        init() {
            // sockaddr_un.sun_path caps at 104 bytes; the default temporary
            // directory path is far too long, so pin a short /tmp path.
            path = "/tmp/ch-wedge-\(UUID().uuidString.prefix(8)).sock"
        }

        func start() throws {
            try? FileManager.default.removeItem(atPath: path)
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS) }
            var address = makeSockaddrUn(path: path)
            let rc = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard rc == 0, listen(fd, 4) == 0 else {
                close(fd)
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS)
            }
            listenFd = fd
            Thread.detachNewThread { [weak self] in self?.acceptLoop() }
        }

        /// Accepts ONE connection, answers the hello, then parks holding the
        /// socket without ever reading it.
        private func acceptLoop() {
            var address = sockaddr()
            var length = socklen_t(MemoryLayout<sockaddr>.size)
            let client = accept(listenFd, &address, &length)
            guard client >= 0 else { return }
            guard let body = Self.readFramed(fd: client),
                  let hello = try? JSONDecoder().decode(ClientHello.self, from: body)
            else {
                close(client)
                return
            }
            ScriptedDaemon.sendFrame(fd: client, payload: helloReply(for: hello))
            // Park WITHOUT reading: draining bytes would un-wedge the peer's
            // blocking send and defeat the fixture.
            while true {
                Thread.sleep(forTimeInterval: 3600)
            }
        }

        func stop() {
            if listenFd >= 0 {
                close(listenFd)
                listenFd = -1
            }
            try? FileManager.default.removeItem(atPath: path)
        }

        private static func readFramed(fd: Int32) -> Data? {
            func readExactly(_ count: Int) -> Data? {
                var buffer = Data()
                var chunk = [UInt8](repeating: 0, count: count)
                while buffer.count < count {
                    let n = chunk.withUnsafeMutableBytes { raw -> Int in
                        guard let base = raw.baseAddress else { return -1 }
                        return recv(fd, base.advanced(by: buffer.count), count - buffer.count, 0)
                    }
                    guard n > 0 else { return nil }
                    buffer.append(contentsOf: chunk[0 ..< n])
                }
                return buffer
            }
            guard let header = readExactly(4) else { return nil }
            let declared = header.reduce(0) { ($0 << 8) | UInt32($1) }
            guard declared <= UInt32(FrameCodec.maxPayloadSize) else { return nil }
            return readExactly(Int(declared))
        }
    }

    // MARK: - Non-pinning (SW5-04a core)

    @Test("wedged-daemon request writes pin the writer queue, not cooperative-pool threads")
    func blockedRequestWriteDoesNotStarveCooperativePool() async throws {
        // Pre-fix failure mode: each of these requests ran its blocking
        // `sendAll` inline inside withCheckedThrowingContinuation, pinning one
        // cooperative-pool thread per call. With more wedged calls than pool
        // width every other async hop starved — including this test's own
        // probe loop, which then never completed. Post-fix all blocked sends
        // serialize on the writer queue's dedicated thread and the probe
        // finishes immediately.
        let daemon = WedgeDaemon()
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "wedge-test")

        // Oversized-but-legal params: the encoded frame (~850 KB, under the
        // 1 MiB cap) exceeds the unix-socket kernel buffers, so the blocking
        // send wedges until teardown.
        let bigParams = JSONValue.string(String(repeating: "x", count: 850_000))

        let width = max(ProcessInfo.processInfo.activeProcessorCount + 2, 8)
        var tasks: [Task<Void, Never>] = []
        for _ in 0 ..< width {
            tasks.append(Task {
                _ = try? await client.request(op: "timeline.list", params: bigParams)
            })
        }

        // Independent async work must keep making progress while every write
        // is wedged.
        let probe = ProbeBox()
        Task.detached {
            for _ in 0 ..< 500 {
                await Task.yield()
            }
            probe.markDone()
        }
        let deadline = Date().addingTimeInterval(15)
        while !probe.finished, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(probe.finished, "cooperative executor starved by blocked request writes")

        // Unwedge everything: shutdown fails the blocked send on the writer
        // queue and disconnect drains the pending continuations.
        client.disconnect()
        for task in tasks {
            _ = await task.value
        }
    }

    // MARK: - Write-error path

    @Test("write error on the writer queue fails the pending request continuation")
    func writeErrorFailsPendingRequest() async throws {
        var pair: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            Issue.record("socketpair failed: errno \(errno)")
            return
        }
        let clientEnd = pair[0]
        defer { close(pair[1]) }
        // The production transport sets SO_NOSIGPIPE in openUnixSocket;
        // mirror it or the failing send kills the test process (SIGPIPE).
        var noSigPipe: Int32 = 1
        setsockopt(
            clientEnd,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &noSigPipe,
            socklen_t(MemoryLayout<Int32>.size)
        )

        let client = DaemonClient()
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

        // Shut down OUR write side: every subsequent send fails immediately
        // and deterministically with EPIPE — a transport write failure, which
        // is connection-fatal (a failed send may have consumed a frame
        // prefix): the writer-queue catch runs teardownConnection.
        shutdown(clientEnd, SHUT_WR)

        do {
            _ = try await client.request(op: "status.get", params: nil)
            Issue.record("expected request to throw after the write failed")
        } catch let error as DaemonClientError {
            guard case let .transportWriteFailed(message) = error else {
                Issue.record("expected transportWriteFailed carrying the socket error, got \(error)")
                return
            }
            #expect(!message.isEmpty)
        }
        // The failed send must tear the connection down, not leave a
        // truncated frame on a still-"healthy" stream (WaveAudit15).
        #expect(!client.isConnectedToDaemon)
    }

    // MARK: - Response correlation

    @Test("concurrent requests still correlate responses by requestId")
    func concurrentRequestsCorrelateResponses() async throws {
        let daemon = ScriptedDaemon(
            // Short /tmp path: sockaddr_un.sun_path caps at 104 bytes and
            // long temporary-directory prefixes must not tip it over.
            path: "/tmp/ch-dc-\(UUID().uuidString.prefix(8)).sock"
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.responseFrame(for: request))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "correlate-test")

        // If routing ever mismatched requestIds, some waiter would never be
        // resumed and these awaits would hang instead of resolving ok.
        var tasks: [Task<ResponseFrame?, Never>] = []
        for index in 0 ..< 8 {
            tasks.append(Task {
                try? await client.request(op: "op.\(index)", params: nil)
            })
        }
        for (index, task) in tasks.enumerated() {
            let response = await task.value
            #expect(response?.ok == true, "request \(index) did not resolve")
            #expect(response?.result == .string("ok-op.\(index)"))
        }
        client.disconnect()
    }

    // MARK: - FIFO ordering across frame kinds

    @Test("request and sendBatch interleave in FIFO order on the wire")
    func requestAndBatchPreserveWireOrder() async throws {
        let recorder = OrderRecorder()
        let daemon = ScriptedDaemon(
            // Short /tmp path: see the correlate test above.
            path: "/tmp/ch-dc-\(UUID().uuidString.prefix(8)).sock"
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                recorder.append("request:\(request.op)")
                ScriptedDaemon.sendFrame(fd: client, payload: Self.responseFrame(for: request))
            case let .other(body):
                guard let batch = try? JSONDecoder().decode(EventBatch.self, from: body) else { return }
                recorder.append("batch")
                ScriptedDaemon.sendFrame(fd: client, payload: Self.batchAckFrame(for: batch))
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        // Gate the injected serial writer queue BEFORE either frame is
        // enqueued: both writer blocks then queue behind the gate in strict
        // call order, making the enqueue order deterministic.
        let gate = DispatchSemaphore(value: 0)
        let writerQueue = DispatchQueue(label: "test.daemon-client.writer")
        writerQueue.async { gate.wait() }

        let client = DaemonClient(writerQueue: writerQueue)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "fifo-test")

        // Task-creation order does NOT guarantee registration order: two
        // independently scheduled tasks can invert under load (observed as
        // a flaky ["batch", "request"] wire order). Make the call order
        // binding instead: the batch task is only created after the request
        // task PROVED it entered its closure, and request()'s synchronous
        // prefix (register + enqueue) runs to completion before its first
        // suspension point — so the enqueue order is then deterministic.
        let entered = ProbeBox()
        let requestTask = Task {
            entered.markDone()
            _ = try? await client.request(op: "a.first", params: nil)
        }
        let deadline = Date().addingTimeInterval(5)
        while !entered.finished, Date() < deadline {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(entered.finished, "request task never started")
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        let batchTask = Task { _ = try? await client.sendBatch([Self.makeEvent()]) }

        // Give the batch caller time to register too; while gated nothing
        // may reach the wire.
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(recorder.snapshot.isEmpty, "frames reached the wire while the writer was gated")

        gate.signal()
        _ = await requestTask.value
        _ = await batchTask.value

        #expect(recorder.snapshot == ["request:a.first", "batch"])
        client.disconnect()
    }

    // MARK: - Post-send ABA generation guard

    /// Thread-safe error capture for the deadline-polled ABA probe.
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

    @Test("request whose send races a reconnect aborts as notConnected even when the old write succeeds")
    func postSendGenerationBumpFailsPendingRequest() async throws {
        func hello(_ messageId: String) -> ServerHello {
            ServerHello(
                protocolVersion: 1,
                messageId: messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "test",
                databaseSchemaVersion: 1
            )
        }

        // Registration runs synchronously at the START of the request task,
        // but task scheduling cannot PROVE it completed before the reconnect
        // below. On that rare inverted interleaving the request captures the
        // NEW socket and its write fails there (badFrame) — inconclusive for
        // the guard, so the attempt is rebuilt and retried. Correct code
        // resolves on the first attempt; a deleted guard NEVER resolves as
        // notConnected and exhausts every attempt.
        for _ in 0 ..< 5 {
            var pair1: [Int32] = [0, 0]
            var pair2: [Int32] = [0, 0]
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair1) == 0,
                  socketpair(AF_UNIX, SOCK_STREAM, 0, &pair2) == 0
            else {
                Issue.record("socketpair failed: errno \(errno)")
                return
            }
            let sock1 = pair1[0], peer1 = pair1[1]
            let sock2 = pair2[0], peer2 = pair2[1]
            defer { close(sock1); close(peer1); close(sock2); close(peer2) }
            // Production sets SO_NOSIGPIPE in openUnixSocket; mirror it or
            // a failing send kills the test process (SIGPIPE).
            var noSigPipe: Int32 = 1
            for fd in [sock1, sock2] {
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            }

            // Gate the injected writer BEFORE anything is enqueued so the
            // request's writer block parks until after the reconnect:
            // exactly the teardown+races-the-send interleaving.
            let gate = DispatchSemaphore(value: 0)
            let writerQueue = DispatchQueue(label: "test.daemon-client.aba-writer")
            writerQueue.async { gate.wait() }

            let client = DaemonClient(writerQueue: writerQueue)
            client.adoptSocketForTesting(sock1, hello: hello("01ABA000000000000000000001"))

            let box = SendErrorBox()
            let task = Task.detached {
                do {
                    _ = try await client.request(op: "status.get", params: nil)
                } catch {
                    box.store(error)
                }
            }
            for _ in 0 ..< 100 {
                await Task.yield()
            }
            try await Task.sleep(nanoseconds: 10_000_000)

            // Reconnect simulation: adoptSocket bumps the generation WITHOUT
            // draining pendings and WITHOUT touching the parked writer block.
            client.adoptSocketForTesting(sock2, hello: hello("01ABA000000000000000000002"))

            // Release the gate: sendAll(sock1) SUCCEEDS because peer1 is
            // still open — yet the waiter must be aborted as notConnected by
            // the post-send generation check.
            let clock = ContinuousClock()
            let start = clock.now
            gate.signal()

            let deadline = Date().addingTimeInterval(5)
            while box.captured == nil, Date() < deadline {
                try await Task.sleep(nanoseconds: 2_000_000)
            }
            guard let error = box.captured else {
                continue // unresolved (e.g. guard deleted): retry, then fail
            }
            guard case DaemonClientError.notConnected = error else {
                continue // late registration wrote sock2: inconclusive, retry
            }
            #expect(clock.now - start < .seconds(3), "resolution must be fast")
            _ = await task.value
            return
        }
        Issue.record("post-send generation abort never observed within 5 attempts")
    }
}
