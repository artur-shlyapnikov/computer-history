import Foundation
@testable import RecorderApp
import Testing

/**
 * In-test stand-in for the daemon: a POSIX unix-socket listener that accepts
 * connections on a detached thread (the pattern proven to interoperate with
 * NWConnection), reads framed messages, and answers via a caller-supplied
 * handler. The first frame is always decoded and passed as `Data`; subsequent
 * frames on the same connection go through the same handler.
 */
/// Copies a unix socket path into sockaddr_un.sun_path (null-terminated).
func makeSockaddrUn(path: String) -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        for (index, byte) in bytes.prefix(destination.count).enumerated() {
            destination[index] = UInt8(bitPattern: byte)
        }
    }
    return address
}

final class ScriptedDaemon: @unchecked Sendable {
    enum Frame {
        case clientHello(ClientHello)
        case request(RequestFrame)
        case other(Data)
    }

    private(set) var path: String
    private var fd: Int32 = -1

    /// Returns the reply for a received frame, or nil to close the connection.
    private let respond: @Sendable (Int32, Int32, Frame) -> Void // (serverSelfMarker, clientFd, frame)

    init(path: String, respond: @escaping @Sendable (Int32, Int32, Frame) -> Void) {
        self.path = path
        self.respond = respond
    }

    convenience init(path: String, reply: Data) {
        // Single canned reply: ServerHello (or error frame) for the handshake.
        self.init(path: path) { _, client, _ in
            var frame = [UInt8](repeating: 0, count: 4 + reply.count)
            let declared = reply.count
            frame[0] = UInt8((declared >> 24) & 0xFF)
            frame[1] = UInt8((declared >> 16) & 0xFF)
            frame[2] = UInt8((declared >> 8) & 0xFF)
            frame[3] = UInt8(declared & 0xFF)
            frame.replaceSubrange(4..., with: Array(reply))
            var sent = 0
            while sent < frame.count {
                let n = send(client, Array(frame[sent...]), frame.count - sent, 0)
                if n <= 0 {
                    break
                }
                sent += n
            }
        }
    }

    func start() throws {
        try? FileManager.default.removeItem(atPath: path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS) }
        var address = makeSockaddrUn(path: path)
        let rc = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0, listen(fd, 4) == 0 else {
            close(fd)
            fd = -1
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ENOSYS)
        }
        Thread.detachNewThread { [weak self] in
            self?.acceptLoop()
        }
    }

    private func acceptLoop() {
        while true {
            var address = sockaddr()
            var length = socklen_t(MemoryLayout<sockaddr>.size)
            let client = accept(fd, &address, &length)
            guard client >= 0 else { return }
            handle(client: client)
            close(client)
        }
    }

    private func handle(client: Int32) {
        while true {
            guard let body = readFramed(fd: client) else { return }
            guard let parsed = parse(body) else { return }
            respond(-1, client, parsed)
        }
    }

    private func readFramed(fd: Int32) -> Data? {
        func readExactly(_ count: Int) -> Data? {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: count)
            while buffer.count < count {
                let n = chunk.withUnsafeMutableBytes { raw in
                    recv(fd, raw.baseAddress!.advanced(by: buffer.count), count - buffer.count, 0)
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

    private func parse(_ body: Data) -> Frame? {
        let decoder = JSONDecoder()
        do {
            return try .clientHello(decoder.decode(ClientHello.self, from: body))
        } catch {}
        do {
            return try .request(decoder.decode(RequestFrame.self, from: body))
        } catch {}
        return .other(body)
    }

    func stop() {
        if fd >= 0 {
            close(fd)
            fd = -1
        }
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Sends one framed payload on an accepted client socket.
    static func sendFrame(fd: Int32, payload: Data) {
        var frame = [UInt8](repeating: 0, count: 4 + payload.count)
        let declared = payload.count
        frame[0] = UInt8((declared >> 24) & 0xFF)
        frame[1] = UInt8((declared >> 16) & 0xFF)
        frame[2] = UInt8((declared >> 8) & 0xFF)
        frame[3] = UInt8(declared & 0xFF)
        frame.replaceSubrange(4..., with: Array(payload))
        var sent = 0
        while sent < frame.count {
            let n = send(fd, Array(frame[sent...]), frame.count - sent, 0)
            if n <= 0 {
                break
            }
            sent += n
        }
    }
}

/// Thread-safe disconnect counter (NSLock keeps the test target free of
/// any OSAllocatedUnfairLock availability constraints).
private final class DisconnectCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func bump() {
        lock.lock()
        defer { lock.unlock() }
        value += 1
    }

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// Client↔daemon handshake over a real socket (spec M0 done-criterion).
struct DaemonClientHandshakeTests {
    @Test("ClientHello → ServerHello completes against a live socket")
    func handshakeSucceeds() async throws {
        let serverHello = ServerHello(
            protocolVersion: 1,
            messageId: "01M0NP9G4GXXGYT7PYGFC5K5HT",
            type: "server_hello",
            sentAt: 1_787_443_200_042,
            daemonVersion: "0.1.0",
            databaseSchemaVersion: 1
        )
        let reply = try JSONEncoder().encode(serverHello)

        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-handshake-\(UUID().uuidString).sock").path,
            reply: reply
        )
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        let negotiated = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(negotiated.protocolVersion == 1)
        #expect(negotiated.daemonVersion == "0.1.0")
        #expect(negotiated.databaseSchemaVersion == 1)
        client.disconnect()
    }

    @Test("version-mismatch rejection surfaces as typed protocolVersionMismatch")
    func versionMismatchSurfaces() async throws {
        let rejection = ProtocolErrorFrame(
            protocolVersion: 1,
            messageId: "01M0NP9G4GXXGYT7PYGFC5K5HV",
            type: "error",
            sentAt: 1_787_443_200_100,
            error: ServerErrorBody(code: "error.protocol_version", message: "daemon speaks protocol 1")
        )
        let reply = try JSONEncoder().encode(rejection)

        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-version-\(UUID().uuidString).sock").path,
            reply: reply
        )
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        await #expect(throws: DaemonClientError.protocolVersionMismatch(offered: 1, expected: 1)) {
            _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        }
        client.disconnect()
    }

    @Test("handshake plus request/response roundtrip matches requestId and shape")
    func requestRoundtrip() async throws {
        let resultJSON = #"{"daemon":{"version":"echo-0.2.0","schemaVersion":1,"uptimeMs":42},"recording":{"paused":false},"accessibilityRequired":false,"queue":{"pending":0,"retrying":0,"dead":0},"db":{"rawEvents":0,"segments":0,"steps":0,"episodes":0,"memories":0,"workflows":0,"pageCountBytes":8192},"diskFreeBytes":12345678}"#

        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-request-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                let reply = ServerHello(
                    protocolVersion: 1,
                    messageId: hello.messageId,
                    type: "server_hello",
                    sentAt: 1,
                    daemonVersion: "echo-0.2.0",
                    databaseSchemaVersion: 1
                )
                ScriptedDaemon.sendFrame(fd: client, payload: try! JSONEncoder().encode(reply))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(resultJSON)}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        let hello = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(hello.daemonVersion == "echo-0.2.0")

        let response = try await client.request(op: "status.get", params: nil)
        #expect(response.ok)
        let status = try response.decodedResult(as: StatusResult.self)
        #expect(status?.daemon.schemaVersion == 1)
        #expect(status?.db.pageCountBytes == 8192)
        client.disconnect()
    }

    @Test("segments.list ok:false error reply surfaces as typed handshakeFailed")
    func listSegmentsServerErrorSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-seg-err-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                let reply = ServerHello(
                    protocolVersion: 1,
                    messageId: hello.messageId,
                    type: "server_hello",
                    sentAt: 1,
                    daemonVersion: "echo-0.1.0",
                    databaseSchemaVersion: 2
                )
                ScriptedDaemon.sendFrame(fd: client, payload: try! JSONEncoder().encode(reply))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKF","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.bad_request","message":"segments.list rejected: limit out of range"}}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.handshakeFailed("segments.list rejected: limit out of range")) {
            _ = try await client.listSegments()
        }
        client.disconnect()
    }

    @Test("segments.list ok:true with a missing result surfaces as badFrame")
    func listSegmentsMissingResultSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-seg-nores-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                let reply = ServerHello(
                    protocolVersion: 1,
                    messageId: hello.messageId,
                    type: "server_hello",
                    sentAt: 1,
                    daemonVersion: "echo-0.1.0",
                    databaseSchemaVersion: 2
                )
                ScriptedDaemon.sendFrame(fd: client, payload: try! JSONEncoder().encode(reply))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKG","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.badFrame("segments.list missing result")) {
            _ = try await client.listSegments()
        }
        client.disconnect()
    }

    /// Shared scripted-daemon boilerplate: handshake echo + one canned
    /// request reply builder keyed by op.
    private static func helloReply(for hello: ClientHello) -> Data {
        try! JSONEncoder().encode(
            ServerHello(
                protocolVersion: 1,
                messageId: hello.messageId,
                type: "server_hello",
                sentAt: 1,
                daemonVersion: "echo-0.1.0",
                databaseSchemaVersion: 2
            )
        )
    }

    @Test("timeline.list ok:false error reply surfaces as typed handshakeFailed")
    func listTimelineServerErrorSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-tl-err-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWC","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.bad_request","message":"timeline.list rejected: limit out of range"}}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.handshakeFailed("timeline.list rejected: limit out of range")) {
            _ = try await client.listTimeline()
        }
        client.disconnect()
    }

    @Test("timeline.list ok:true with a missing result surfaces as badFrame")
    func listTimelineMissingResultSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-tl-nores-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWD","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.badFrame("timeline.list missing result")) {
            _ = try await client.listTimeline()
        }
        client.disconnect()
    }

    @Test("episode.get ok:false error reply surfaces as typed handshakeFailed")
    func getEpisodeServerErrorSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ep-err-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.not_found","message":"episode.get rejected: unknown episode"}}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.handshakeFailed("episode.get rejected: unknown episode")) {
            _ = try await client.getEpisode(id: "01M0NP9G4HP0M1M64H8TC0VEKF")
        }
        client.disconnect()
    }

    @Test("episode.get ok:true with a missing result surfaces as badFrame")
    func getEpisodeMissingResultSurfaces() async throws {
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ep-nores-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWF","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.badFrame("episode.get missing result")) {
            _ = try await client.getEpisode(id: "01M0NP9G4HP0M1M64H8TC0VEKF")
        }
        client.disconnect()
    }

    @Test("episode.get success decodes episode plus ordered steps through the socket")
    func getEpisodeSuccessRoundtrip() async throws {
        let resultJSON = """
        {"episode":{"id":"01M0NP9G4HP0M1M64H8TC0VEKF","startedAtMs":1787439000000,"endedAtMs":1787441400000,"title":"Investigated webhook failures","summary":"Traced failing payment webhook deliveries.","intent":"Debug why payment webhooks stopped arriving","outcome":"Root cause found","apps":["com.apple.Safari"],"entities":["stripe"],"summaryModel":null,"summaryPromptVersion":null,"createdAtMs":1787441500000,"updatedAtMs":1787441500000},"steps":[{"id":"01M0NP9G4HP0M1M64H8TC0VEKG","segmentId":"01M0NP9G4HP0M1M64H8TC0VEKH","ordinal":0,"startedAtMs":1787439000000,"endedAtMs":1787439060000,"action":"text_edit","appBundleId":"com.apple.Safari","appName":"Safari","target":"textarea#issue-comment","text":"Reproduced the failure."}]}
        """
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ep-ok-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(fd: client, payload: Self.helloReply(for: hello))
            case let .request(request):
                let reply =
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWG","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(resultJSON)}"#
                ScriptedDaemon.sendFrame(fd: client, payload: Data(reply.utf8))
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.getEpisode(id: "01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(result.episode.title == "Investigated webhook failures")
        #expect(result.episode.entities == ["stripe"])
        #expect(result.episode.summaryModel == nil)
        #expect(result.steps.map(\.ordinal) == [0])
        #expect(result.steps[0].action == "text_edit")
        client.disconnect()
    }

    // MARK: - Peer-close teardown (regression: receive-loop EOF path)

    /// Daemon that completes the handshake, then simulates a crash on the
    /// first post-handshake frame: it never replies and shuts the accepted
    /// socket down, so the client's recv returns 0 (EOF) in the receive loop.
    private static func makeCrashingDaemon(helloReply: Data) -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-peerclose-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case .clientHello:
                ScriptedDaemon.sendFrame(fd: client, payload: helloReply)
            case .request, .other:
                shutdown(client, SHUT_RDWR)
            }
        }
    }

    @Test("peer close clears connection state and fails a pending request with notConnected")
    func peerCloseFailsPendingRequestAndClearsState() async throws {
        let serverHello = ServerHello(
            protocolVersion: 1,
            messageId: "01M0NP9G4GXXGYT7PYGFC5K5HT",
            type: "server_hello",
            sentAt: 1_787_443_200_042,
            daemonVersion: "0.1.0",
            databaseSchemaVersion: 1
        )
        let daemon = try Self.makeCrashingDaemon(helloReply: JSONEncoder().encode(serverHello))
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        #expect(client.isConnectedToDaemon)

        let disconnects = DisconnectCounter()
        client.onDisconnect = { disconnects.bump() }

        // The daemon sends no response frame, so the ONLY way this request can
        // resolve is the peer-close teardown draining pendingResponses.
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.request(op: "status.get", params: nil)
        }
        #expect(!client.isConnectedToDaemon)
        #expect(client.activeServerHello == nil)
        #expect(disconnects.current >= 1)
    }

    @Test("peer close drains a pending event_batch ack waiter instead of stranding it")
    func peerCloseDrainsPendingBatch() async throws {
        let serverHello = ServerHello(
            protocolVersion: 1,
            messageId: "01M0NP9G4GXXGYT7PYGFC5K5HT",
            type: "server_hello",
            sentAt: 1_787_443_200_042,
            daemonVersion: "0.1.0",
            databaseSchemaVersion: 1
        )
        let daemon = try Self.makeCrashingDaemon(helloReply: JSONEncoder().encode(serverHello))
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let event = ActivityEvent(
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

        // The daemon never acks; before the failAllPending fix this batch's
        // continuation stranded forever (test would hang). The peer-close
        // teardown must resume it with notConnected.
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.sendBatch([event])
        }
        #expect(!client.isConnectedToDaemon)
    }
}
