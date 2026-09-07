import Foundation
@testable import RecorderApp
import Testing

/// DaemonClient's sendBatch writer-queue transport (design round-3 §P1-3,
/// SW-03): encode + blocking write run on the dedicated serial `writerQueue`
/// so a wedged-but-alive daemon can never pin the caller's actor; transport
/// write errors are connection-fatal (`transportWriteFailed` teardown, so a
/// truncated frame can never desync the stream); a reconnect racing an
/// in-flight batch settles the waiter instead of leaking it.
///
/// Determinism: loopback unix sockets (socketpairs and in-process scripted
/// daemons); every wait is a bounded deadline loop or an awaited future — no
/// wall-clock assertions, ordering only.
struct DaemonClientWriterQueueTests {
    // MARK: - Fixtures

    /// Sendable settlement box for results captured across tasks.
    /// `outcome`: nil = still parked; .some(nil) = acked; .some(.some(e)) = thrown.
    private final class SettlementBox: @unchecked Sendable {
        private let lock = NSLock()
        private var error: Error?
        private var acked = false

        func settle(_ e: Error?) {
            lock.withLock {
                if e == nil {
                    acked = true
                } else {
                    error = e
                }
            }
        }

        var outcome: Error?? {
            lock.withLock { error != nil ? .some(error) : (acked ? .some(nil) : nil) }
        }

        var isSettled: Bool {
            outcome != nil
        }
    }

    private static func waitForSettlement(_ box: SettlementBox, timeoutSeconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !box.isSettled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return box.isSettled
    }

    /// Sync shim: DispatchSemaphore.wait is unavailable in async contexts
    /// (pattern of DaemonClientBatchFailureTests.waitForArrival).
    private static func waitForSignal(_ semaphore: DispatchSemaphore, timeoutSeconds: Double) -> Bool {
        semaphore.wait(timeout: .now() + timeoutSeconds) == .success
    }

    private static func makeEvent(content: String? = nil) -> ActivityEvent {
        ActivityEvent(
            id: Ulid.shared.next(nowMs: 1_700_000_000_000),
            observedAt: 1_700_000_000_000,
            monotonicNs: 0,
            source: .input,
            app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
            window: nil,
            action: .typingActivity,
            target: nil,
            content: content,
            contentPolicy: .metadataOnly,
            captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        )
    }

    /// One event whose encoded frame (~600 KB) exceeds every unix-socket
    /// kernel buffer yet stays under the 1 MiB framing cap.
    private static func makeOversizedButLegalBatch() -> [ActivityEvent] {
        [makeEvent(content: String(repeating: "x", count: 600_000))]
    }

    /// A connected AF_UNIX socketpair whose far end nobody reads: any send
    /// larger than the kernel buffers wedges in the kernel until shutdown.
    /// Returns (clientEnd, farEnd); caller owns BOTH descriptors.
    private static func makeSocketPair() throws -> (Int32, Int32) {
        var pair: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS)
        }
        // Mirror the production transport's SO_NOSIGPIPE: a failing send
        // must raise an errno, not kill the test process.
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
            daemonVersion: "writer-queue-tests",
            databaseSchemaVersion: 1
        )
    }

    // MARK: - 1. Liveness: the caller's actor never blocks on backpressure

    @Test("a wedged batch write leaves the calling task responsive")
    func wedgedBatchWriteDoesNotBlockCallerActor() async throws {
        let (clientEnd, farEnd) = try Self.makeSocketPair()
        defer { close(farEnd) } // clientEnd is owned/closed by the client

        let client = DaemonClient()
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())

        let box = SettlementBox()
        let batch = Task {
            do {
                _ = try await client.sendBatch(Self.makeOversizedButLegalBatch())
                box.settle(nil)
            } catch {
                box.settle(error)
            }
        }
        // Premise: sendBatch is non-blocking — it hands the frame to the
        // dedicated serial writer queue and returns control to the caller's
        // task long before the underlying write settles; no actor
        // annotation is involved anywhere on the path.
        //
        // Liveness observation: the checked continuation below is a genuine
        // suspension point — it can only resume once the scheduler runs the
        // probe task's independent hops to completion. Reaching the line
        // after it proves the calling task kept making progress while the
        // 600 KB write was parked against the unread far end; the
        // resume-before-settlement ordering is asserted by !box.isSettled.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let probe = Task.detached(priority: .userInitiated) {
                for _ in 0 ..< 20 {
                    await Task.yield()
                }
                continuation.resume()
            }
            _ = probe
        }
        #expect(!box.isSettled, "batch settled before the write could even be parked")

        // Unwedge: shutdown fails the parked send; disconnect drains the
        // registered waiter. No waiter leaks past teardown.
        client.disconnect()
        let settled = await Self.waitForSettlement(box, timeoutSeconds: 5)
        #expect(settled, "batch waiter leaked past disconnect")
        if settled, case let .some(error) = box.outcome {
            #expect(error is DaemonClientError, "unexpected settlement error: \(String(describing: error))")
        }
        _ = await batch.value
    }

    // MARK: - 2. Black-hole: bounded parking, drained waiter, no leak

    @Test("disconnect drains a parked batch waiter with notConnected")
    func blackHoleBatchDrainedByDisconnect() async throws {
        // Gated writer queue: the write block is queued BEHIND a parked
        // blocker, so the socket is untouched when disconnect() runs — the
        // drain is the ONLY possible settler, making `.notConnected`
        // deterministic rather than racing a waking send.
        let gate = DispatchSemaphore(value: 0)
        let queue = DispatchQueue(label: "ch.writer-queue-tests.gated")
        queue.async { gate.wait() }
        defer { gate.signal() }

        let (clientEnd, farEnd) = try Self.makeSocketPair()
        defer { close(farEnd) }

        let client = DaemonClient(writerQueue: queue)
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())

        let box = SettlementBox()
        let batch = Task {
            do {
                _ = try await client.sendBatch([Self.makeEvent()])
                box.settle(nil)
            } catch {
                box.settle(error)
            }
        }

        // Nothing can settle it yet: the write has not started.
        let settledEarly = await Self.waitForSettlement(box, timeoutSeconds: 0.3)
        #expect(!settledEarly, "parked batch settled with no write, no disconnect")

        client.disconnect()
        let settled = await Self.waitForSettlement(box, timeoutSeconds: 5)
        #expect(settled)
        if settled, case let .some(error) = box.outcome {
            #expect(
                (error as? DaemonClientError) == .notConnected,
                "expected the disconnect drain's notConnected, got \(String(describing: error))"
            )
        }
        _ = await batch.value

        // Follow-up disconnect resolves promptly (idempotent teardown).
        client.disconnect()
        #expect(!client.isConnectedToDaemon)
    }

    // MARK: - 3. Write-error failure path

    @Test("write error on the writer queue fails the pending batch with transportWriteFailed and tears down")
    func writeErrorFailsPendingBatch() async throws {
        let (clientEnd, farEnd) = try Self.makeSocketPair()
        defer { close(farEnd) }

        let client = DaemonClient()
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())

        // Shut down OUR write side: every subsequent send fails immediately
        // with EPIPE — deterministic; the thrown error can only originate
        // from the write itself.
        shutdown(clientEnd, SHUT_WR)

        do {
            _ = try await client.sendBatch([Self.makeEvent()])
            Issue.record("expected sendBatch to throw after the write failed")
        } catch let error as DaemonClientError {
            guard case let .transportWriteFailed(message) = error else {
                Issue.record("expected transportWriteFailed carrying the socket error, got \(error)")
                return
            }
            #expect(!message.isEmpty)
        }
        // Transport write failure is connection-fatal (WaveAudit15): the
        // writer-queue catch must tear the socket down so spool fallback
        // sees not-connected instead of a silently desynced stream.
        #expect(!client.isConnectedToDaemon)
        client.disconnect()
    }

    // MARK: - 4. Reconnect racing an in-flight batch (ABA)

    /// Accepts one connection, echoes the handshake reply, reads only a
    /// PREFIX of the next frame's payload, signals, then stalls forever —
    /// parking the client's send mid-frame with the connection healthy.
    private final class PartialReaderDaemon: @unchecked Sendable {
        private(set) var path: String
        private var listenFd: Int32 = -1
        private var clientFd: Int32 = -1
        private let prefixBytes: Int
        let prefixRead = DispatchSemaphore(value: 0)

        init(path: String, prefixBytes: Int) {
            self.path = path
            self.prefixBytes = prefixBytes
        }

        func start() throws {
            try? FileManager.default.removeItem(atPath: path)
            listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard listenFd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS) }
            var address = makeSockaddrUn(path: path)
            let rc = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    bind(listenFd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard rc == 0, listen(listenFd, 4) == 0 else {
                close(listenFd)
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS)
            }
            Thread.detachNewThread { [weak self] in
                self?.acceptAndPark()
            }
        }

        private func acceptAndPark() {
            var address = sockaddr()
            var length = socklen_t(MemoryLayout<sockaddr>.size)
            let client = accept(listenFd, &address, &length)
            guard client >= 0 else { return }
            clientFd = client
            // Echo the handshake reply.
            let hello = (try? JSONEncoder().encode(ServerHello(
                protocolVersion: 1,
                messageId: "01M0NP9G4HP0M1M64H8TC0VEKH",
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "partial-reader",
                databaseSchemaVersion: 1
            ))) ?? Data()
            ScriptedDaemon.sendFrame(fd: client, payload: hello)
            // Read the u32BE header plus a small prefix of the batch frame…
            var header = [UInt8](repeating: 0, count: 4)
            var got = 0
            while got < 4 {
                let n = header.withUnsafeMutableBytes { raw -> Int in
                    guard let base = raw.baseAddress else { return -1 }
                    return recv(client, base.advanced(by: got), 4 - got, 0)
                }
                guard n > 0 else { return }
                got += n
            }
            let declared = header.reduce(0) { ($0 << 8) | UInt32($1) }
            var prefix = [UInt8](repeating: 0, count: min(prefixBytes, Int(declared)))
            var read = 0
            while read < prefix.count {
                let remaining = prefix.count - read
                let n = prefix.withUnsafeMutableBytes { raw -> Int in
                    guard let base = raw.baseAddress else { return -1 }
                    return recv(client, base.advanced(by: read), remaining, 0)
                }
                guard n > 0 else { return }
                read += n
            }
            // …then stop reading entirely: the rest of the frame wedges.
            prefixRead.signal()
            Thread.sleep(forTimeInterval: 120)
        }

        func stop() {
            if clientFd >= 0 {
                close(clientFd); clientFd = -1
            }
            if listenFd >= 0 {
                close(listenFd); listenFd = -1
            }
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    /// Ack-recording daemon: handshakes, answers every event_batch with a
    /// matching ack, and records arriving batchIds per connection.
    private final class AckRecordingDaemon: @unchecked Sendable {
        /// Thread-safe batchId list shared with the daemon thread.
        private final class IdList: @unchecked Sendable {
            private let lock = NSLock()
            private var ids: [String] = []
            func append(_ id: String) {
                lock.withLock { ids.append(id) }
            }

            var snapshot: [String] {
                lock.withLock { ids }
            }
        }

        private let ids: IdList
        let daemon: ScriptedDaemon

        var path: String {
            daemon.path
        }

        var batchIds: [String] {
            ids.snapshot
        }

        init(name: String) throws {
            // Local first: self is not touchable before `daemon` is assigned.
            let list = IdList()
            daemon = ScriptedDaemon(
                path: FileManager.default.temporaryDirectory
                    .appendingPathComponent("ch-\(name)-\(UUID().uuidString).sock").path
            ) { _, client, frame in
                switch frame {
                case let .clientHello(hello):
                    let reply = (try? JSONEncoder().encode(ServerHello(
                        protocolVersion: 1,
                        messageId: hello.messageId,
                        type: "server_hello",
                        sentAt: 1,
                        daemonVersion: name,
                        databaseSchemaVersion: 1
                    ))) ?? Data()
                    ScriptedDaemon.sendFrame(fd: client, payload: reply)
                case let .other(body):
                    if let batch = try? JSONDecoder().decode(EventBatch.self, from: body) {
                        list.append(batch.batchId)
                        let ack = EventBatchAck(
                            protocolVersion: 1,
                            messageId: "ack-\(batch.messageId)",
                            type: "event_batch_ack",
                            sentAt: 1,
                            batchId: batch.batchId,
                            accepted: batch.events.count,
                            duplicates: 0,
                            rejected: 0
                        )
                        let body = (try? JSONEncoder().encode(ack)) ?? Data()
                        ScriptedDaemon.sendFrame(fd: client, payload: body)
                    }
                case .request:
                    break
                }
            }
            try daemon.start()
            ids = list
        }

        func stop() {
            daemon.stop()
        }
    }

    @Test("a reconnect settles the parked batch and leaves the new connection usable")
    func reconnectSettlesParkedBatchWithoutStaleBytes() async throws {
        // Gated writer queue: the old connection's write block is queued
        // BEHIND a parked blocker, so the reconnect completes BEFORE the
        // stale block ever runs. This makes both observable outcomes
        // deterministic — the drain is the only possible settler of the
        // parked waiter (:230–237 ABA guard), and the post-reconnect probe
        // below exercises the NEW descriptor without racing a wedged send.
        //
        // Honest limits vs design §P1-3 case 4: a send ALREADY blocked in
        // the kernel is NOT woken by shutdown() on macOS (probed during
        // development: the pre-teardown bytes keep draining into whatever
        // descriptor the number now refers to). Since round 31 the writer
        // block consults the connection generation BEFORE sendAll, so a
        // block merely QUEUED across the swap aborts without writing; only
        // bytes already handed to the kernel mid-write can still land on a
        // recycled descriptor. Asserted here is the CONTRACT: the waiter
        // settles exactly once with notConnected, and the new connection
        // works.
        let gate = DispatchSemaphore(value: 0)
        let queue = DispatchQueue(label: "ch.writer-queue-tests.reconnect")
        queue.async { gate.wait() }
        defer { gate.signal() }

        let old = try AckRecordingDaemon(name: "aba-old")
        defer { old.stop() }
        let fresh = try AckRecordingDaemon(name: "aba-fresh")
        defer { fresh.stop() }

        let client = DaemonClient(writerQueue: queue)
        _ = try await client.connectAndHandshake(socketPath: old.path, appVersion: "test")

        let box = SettlementBox()
        let batch = Task {
            do {
                _ = try await client.sendBatch(Self.makeOversizedButLegalBatch())
                box.settle(nil)
            } catch {
                box.settle(error)
            }
        }

        // The write is queued behind the gate: registered, never sent.
        let settledEarly = await Self.waitForSettlement(box, timeoutSeconds: 0.3)
        #expect(!settledEarly, "parked batch settled with no write and no disconnect")
        #expect(old.batchIds.isEmpty, "batch escaped the gated writer queue before reconnect")

        // Reconnect races the in-flight batch: the old waiter is drained by
        // disconnect() (its pending map is emptied under the lock before any
        // teardown side effects), then the NEW connection is adopted.
        _ = try await client.connectAndHandshake(socketPath: fresh.path, appVersion: "test")

        let settled = await Self.waitForSettlement(box, timeoutSeconds: 5)
        #expect(settled, "parked batch stranded across reconnect")
        if settled, case let .some(error) = box.outcome {
            #expect(
                (error as? DaemonClientError) == .notConnected,
                "expected notConnected for the parked batch, got \(String(describing: error))"
            )
        }
        _ = await batch.value

        // Release the stale writer block, give it a bounded window to do
        // whatever it does against the retired descriptor, then prove the
        // NEW connection is fully usable: a normal batch round-trips.
        gate.signal()
        try await Task.sleep(nanoseconds: 200_000_000)
        let ack = try await client.sendBatch([Self.makeEvent()])
        #expect(ack.accepted == 1)
        client.disconnect()
    }

    // MARK: - 4b. Pre-send generation guard (round 31)

    /// Pin for the round-31 fix: a writer block QUEUED before the connection
    /// swap must observe the generation mismatch BEFORE sendAll. Previously
    /// the check ran only after the send, so a stale block delivered its
    /// frame to the retired descriptor (a phantom frame on a REUSED fd of
    /// the new connection) and only then aborted its waiter — duplicate
    /// delivery once spool replay re-sent it.
    @Test("a stale writer block aborts BEFORE sending when the generation moved")
    func staleGenerationAbortsBeforeSend() async throws {
        let gate = DispatchSemaphore(value: 0)
        let queue = DispatchQueue(label: "ch.writer-queue-tests.presend-aba")
        queue.async { gate.wait() }
        defer { gate.signal() }

        let daemon = try AckRecordingDaemon(name: "paba")

        let client = DaemonClient(writerQueue: queue)
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let box = SettlementBox()
        let batch = Task {
            do {
                _ = try await client.sendBatch([Self.makeEvent()])
                box.settle(nil)
            } catch {
                box.settle(error)
            }
        }

        // Registered behind the gate; nothing was sent.
        let settledEarly = await Self.waitForSettlement(box, timeoutSeconds: 0.3)
        #expect(!settledEarly, "batch settled before its writer block ever ran")
        #expect(daemon.batchIds.isEmpty)

        // Swap the connection WITHOUT disconnect(): adoptSocketForTesting
        // bumps the generation while leaving BOTH the pending map and the
        // old descriptor untouched, so this batch's waiter is still
        // registered when its writer block finally runs.
        let (clientEnd, farEnd) = try Self.makeSocketPair()
        close(farEnd)
        client.adoptSocketForTesting(clientEnd, hello: Self.testHello())

        // Release the block: the pre-send guard must settle notConnected.
        gate.signal()
        let settled = await Self.waitForSettlement(box, timeoutSeconds: 5)
        #expect(settled, "stale writer block neither sent nor aborted")
        if settled, case let .some(error) = box.outcome {
            #expect(
                (error as? DaemonClientError) == .notConnected,
                "expected notConnected for the stale batch, got \(String(describing: error))"
            )
        }
        _ = await batch.value

        // Load-bearing assertion: NO frame reached the daemon. The old
        // post-send-only guard wrote the batch to the retired connection
        // before aborting, so this fails on the previous behavior. Bounded
        // wait-for-absence: give any wrongly-sent frame time to arrive.
        let deadline = Date().addingTimeInterval(0.5)
        while daemon.batchIds.isEmpty, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(daemon.batchIds.isEmpty, "stale frame was written onto the retired connection")

        client.disconnect()
    }

    // MARK: - 5. Serial-queue FIFO ordering

    @Test("sequential batches arrive at the daemon in submission order")
    func sequentialBatchesArriveInOrder() async throws {
        let daemon = try AckRecordingDaemon(name: "fifo")
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        var acks: [EventBatchAck] = []
        for _ in 0 ..< 3 {
            try await acks.append(client.sendBatch([Self.makeEvent()]))
        }

        // All three acks matched distinct continuations…
        #expect(Set(acks.map(\.batchId)).count == 3)
        // …and the serial writer queue delivered the frames FIFO.
        #expect(daemon.batchIds == acks.map(\.batchId))
        client.disconnect()
    }
}
