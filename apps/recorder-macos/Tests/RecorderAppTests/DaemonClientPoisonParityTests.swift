import Foundation
@testable import RecorderApp
import Testing

/*
 * P1-1 — DaemonClient poison-parity regression pins (round 7).
 *
 * Pins the receive-loop reorder in `DaemonClient.receiveLoop`: frames parsed
 * BEFORE a poison signal are routed BEFORE the disconnect teardown runs (TS
 * parity — the daemon answers well-formed frames before evaluating a trailing
 * bad one). Reverting the reorder reintroduces the lost-response bug while
 * every codec-level FramingTests pin stays green, so these cases drive the
 * real socket through `ScriptedDaemon`.
 *
 * Determinism contract: one daemon write carries `[valid reply][poison]`;
 * ordering is asserted via a lock-protected event-log array checked after a
 * single bounded disconnect wait fires — no sleeps.
 */

/// Lock-protected event log shared by the reply continuation and the
/// disconnect callback.
private final class PoisonEventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []

    func append(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
    }

    var recorded: [String] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}

/// Latches the first disconnect callback; `waitFired` resolves exactly once,
/// racing the latch against a bounded timeout (the suite's single wait).
private final class DisconnectLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func fire() {
        lock.lock()
        let pending = fired ? [] : waiters
        fired = true
        waiters.removeAll()
        lock.unlock()
        pending.forEach { $0.resume() }
    }

    /// Resumes any stranded waiter after a lost timeout race so no
    /// continuation leaks; `fired` stays untouched.
    private func abandon() {
        lock.lock()
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        pending.forEach { $0.resume() }
    }

    private func awaitFire() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if fired {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    /// True when the disconnect callback fired (first, if it races the timer).
    func waitFired(timeout seconds: Double) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { await self.awaitFire(); return true }
            group.addTask {
                try? await Task.sleep(for: .seconds(seconds))
                return false
            }
            let first = await group.next() ?? false
            if !first {
                abandon()
            }
            group.cancelAll()
            return first
        }
    }
}

struct DaemonClientPoisonParityTests {
    /// 0x00100001 = 1_048_577 > FrameCodec.maxPayloadSize (oversize poison).
    private static let oversizeHeader: [UInt8] = [0x00, 0x10, 0x00, 0x01]
    /// Declared-zero-length payload header (the other FrameError poison).
    private static let zeroLengthHeader: [UInt8] = [0x00, 0x00, 0x00, 0x00]

    // MARK: Fixtures

    private static func framed(_ payload: Data) -> [UInt8] {
        let declared = payload.count
        return [
            UInt8((declared >> 24) & 0xFF),
            UInt8((declared >> 16) & 0xFF),
            UInt8((declared >> 8) & 0xFF),
            UInt8(declared & 0xFF),
        ] + Array(payload)
    }

    private static func sendRaw(fd: Int32, bytes: [UInt8]) {
        var sent = 0
        while sent < bytes.count {
            let n = send(fd, Array(bytes[sent...]), bytes.count - sent, 0)
            if n <= 0 {
                break
            }
            sent += n
        }
    }

    private static func serverHelloPayload(messageId: String) -> Data {
        let hello = ServerHello(
            protocolVersion: 1,
            messageId: messageId,
            type: "server_hello",
            sentAt: 1_787_443_200_042,
            daemonVersion: "poison-parity-0.7.0",
            databaseSchemaVersion: 1
        )
        return (try? JSONEncoder().encode(hello)) ?? Data()
    }

    private static func responsePayload(requestId: String) -> Data {
        let json =
            #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKP","type":"response","sentAt":1,"requestId":"\#(requestId)","ok":true,"result":{"echo":"poison-parity"}}"#
        return Data(json.utf8)
    }

    /// Handshake-aware daemon whose answer to the first request is ONE write
    /// of `[valid response frame][trailing bytes]`.
    private static func makeReplyPlusTrailerDaemon(
        trailer: [UInt8],
        log: PoisonEventLog
    ) -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-poison-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                sendRaw(fd: client, bytes: framed(serverHelloPayload(messageId: hello.messageId)))
            case let .request(request):
                // Reply + trailer coalesced into a single write so the client's
                // receive loop parses both from one recv chunk.
                sendRaw(fd: client, bytes: framed(responsePayload(requestId: request.requestId)) + trailer)
                log.append("daemon-wrote")
            case .other:
                break
            }
        }
    }

    // MARK: Cases

    @Test("[response][oversize poison] in one chunk: reply routes, then disconnect")
    func replyBeforeOversizePoisonTeardown() async throws {
        let log = PoisonEventLog()
        let daemon = Self.makeReplyPlusTrailerDaemon(trailer: Self.oversizeHeader, log: log)
        try daemon.start()
        defer { daemon.stop() }

        let latch = DisconnectLatch()
        let client = DaemonClient()
        client.onDisconnect = {
            log.append("disconnect")
            latch.fire()
        }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        // Mutation probe: with the DaemonClient reorder reverted, the poison
        // tears the connection down FIRST — this line fails with badFrame and
        // the log records ["daemon-wrote", "disconnect"] with no reply.
        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)
        log.append("reply")

        let disconnected = await latch.waitFired(timeout: 5)
        #expect(disconnected)
        #expect(!client.isConnectedToDaemon)
        // Ordering pin: the successful request above IS the reply-before-
        // teardown guarantee (a reverted reorder makes it throw badFrame).
        // Both events are recorded; their literal array adjacency is
        // cross-thread scheduler racy because the reply continuation resumes
        // asynchronously while the disconnect callback runs synchronously in
        // the receive loop (see deviation note in the round report).
        #expect(log.recorded.first == "daemon-wrote")
        #expect(log.recorded.contains("reply"))
        #expect(log.recorded.contains("disconnect"))
        client.disconnect()
    }

    @Test("[response][zero-length header] in one chunk: identical reply-then-teardown behavior")
    func replyBeforeZeroLengthPoisonTeardown() async throws {
        let log = PoisonEventLog()
        let daemon = Self.makeReplyPlusTrailerDaemon(trailer: Self.zeroLengthHeader, log: log)
        try daemon.start()
        defer { daemon.stop() }

        let latch = DisconnectLatch()
        let client = DaemonClient()
        client.onDisconnect = {
            log.append("disconnect")
            latch.fire()
        }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        // Both FrameError variants share one teardown path; this pins the
        // declared-zero-length variant explicitly.
        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)
        log.append("reply")

        let disconnected = await latch.waitFired(timeout: 5)
        #expect(disconnected)
        #expect(!client.isConnectedToDaemon)
        #expect(log.recorded.first == "daemon-wrote")
        #expect(log.recorded.contains("reply"))
        #expect(log.recorded.contains("disconnect"))
        client.disconnect()
    }

    @Test("[response][partial valid header]: reply routes, NO disconnect, buffer retains the partial")
    func partialTrailingHeaderDoesNotPoison() async throws {
        let log = PoisonEventLog()
        // Three bytes are a valid start of a length header but can never
        // resolve: the client keeps them buffered and stays connected.
        let daemon = Self.makeReplyPlusTrailerDaemon(trailer: [0x00, 0x00, 0x10], log: log)
        try daemon.start()
        defer { daemon.stop() }

        let latch = DisconnectLatch()
        let client = DaemonClient()
        client.onDisconnect = {
            log.append("disconnect")
            latch.fire()
        }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)

        // Bounded proof of the NEGATIVE: no poison teardown arrives. Any
        // over-eager "trailing garbage poisons" regression flips this to true.
        let disconnected = await latch.waitFired(timeout: 0.3)
        #expect(!disconnected)
        #expect(client.isConnectedToDaemon)
        #expect(log.recorded == ["daemon-wrote"]) // reply routed, nothing else
        client.disconnect()
    }
}
