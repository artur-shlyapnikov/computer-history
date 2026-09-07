import Foundation
@testable import RecorderApp
import Testing

/// Scripted-socket coverage for the chat ops (spec §3.19), symmetric with the
/// DaemonClientHandshakeTests patterns: chat.send/chat.cancel roundtrips plus
/// their typed error branches, and end-to-end routing of chat_* server events.
struct ChatClientTests {
    private static let requestId = "01M0NP9G4HP0M1M64H8TC0VEKA"
    private static let sessionId = "01M0NP9G4HP0M1M64H8TC0VEKS"

    /// Thread-safe collector for server-pushed events.
    private final class EventCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [DaemonEvent] = []

        func append(_ event: DaemonEvent) {
            lock.lock()
            defer { lock.unlock() }
            items.append(event)
        }

        var snapshot: [DaemonEvent] {
            lock.lock()
            defer { lock.unlock() }
            return items
        }
    }

    /// Shared boilerplate: echo handshake, then answer every request via
    /// `replyFor` (requestId substituted by the caller's closure).
    private static func makeDaemon(
        path: String,
        replyFor: @escaping @Sendable (RequestFrame) -> Data
    ) -> ScriptedDaemon {
        ScriptedDaemon(path: path) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: try! JSONEncoder().encode(
                        ServerHello(
                            protocolVersion: 1,
                            messageId: hello.messageId,
                            type: "server_hello",
                            sentAt: 1,
                            daemonVersion: "echo-chat-0.4.0",
                            databaseSchemaVersion: 2
                        )
                    )
                )
            case let .request(request):
                ScriptedDaemon.sendFrame(fd: client, payload: replyFor(request))
            case .other:
                break
            }
        }
    }

    // MARK: - chat.send

    /// Thread-safe box for values captured from the daemon thread.
    private final class CaptureBox<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var value: T?

        func set(_ newValue: T) {
            lock.lock()
            defer { lock.unlock() }
            value = newValue
        }

        func get() -> T? {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    @Test("chat.send happy path decodes requestId/sessionId and pins params")
    func sendChatRoundtrip() async throws {
        let capturedParams = CaptureBox<JSONValue>()
        let daemon = Self.makeDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-cok-\(UUID().uuidString).sock").path
        ) { [capturedParams] request in
            if request.op == "chat.send" {
                capturedParams.set(request.params ?? .null)
            }
            return Data(
                #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWB","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"requestId":"\#(request.requestId)","sessionId":"\#(Self.sessionId)"}}"#
                    .utf8
            )
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.sendChat(sessionId: nil, text: "what did I do about webhooks?")
        #expect(!result.requestId.isEmpty)
        #expect(result.sessionId == Self.sessionId)

        let paramsData = try JSONEncoder().encode(capturedParams.get() ?? .null)
        let params = try JSONDecoder().decode(ChatSendParams.self, from: paramsData)
        #expect(params.text == "what did I do about webhooks?")
        #expect(params.sessionId == nil)
        client.disconnect()
    }

    @Test("chat.send follow-up turn carries the existing sessionId")
    func sendChatCarriesSession() async throws {
        let capturedParams = CaptureBox<JSONValue>()
        let daemon = Self.makeDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-cssn-\(UUID().uuidString).sock").path
        ) { [capturedParams] request in
            if request.op == "chat.send" {
                capturedParams.set(request.params ?? .null)
            }
            return Data(
                #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWC","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"requestId":"\#(request.requestId)","sessionId":"\#(Self.sessionId)"}}"#
                    .utf8
            )
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        _ = try await client.sendChat(sessionId: Self.sessionOneEcho, text: "follow-up")
        let paramsData = try JSONEncoder().encode(capturedParams.get() ?? .null)
        let params = try JSONDecoder().decode(ChatSendParams.self, from: paramsData)
        #expect(params.sessionId == Self.sessionOneEcho)
        #expect(params.text == "follow-up")
        client.disconnect()
    }

    private static let sessionOneEcho = "01M0NP9G4HP0M1M64H8TC0VEKS"

    @Test("chat.send ok:false error reply surfaces as typed handshakeFailed")
    func sendChatServerErrorSurfaces() async throws {
        let daemon = Self.makeDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-cerr-\(UUID().uuidString).sock").path
        ) { request in
            Data(
                #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWD","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.invalid_params","message":"chat.send rejected: empty text"}}"#
                    .utf8
            )
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.handshakeFailed("chat.send rejected: empty text")) {
            _ = try await client.sendChat(sessionId: nil, text: "")
        }
        client.disconnect()
    }

    @Test("chat.send ok:true without a result surfaces as badFrame")
    func sendChatMissingResultSurfaces() async throws {
        let daemon = Self.makeDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-cnrs-\(UUID().uuidString).sock").path
        ) { request in
            Data(
                #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
                    .utf8
            )
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        await #expect(throws: DaemonClientError.badFrame("chat.send missing result")) {
            _ = try await client.sendChat(sessionId: nil, text: "hello")
        }
        client.disconnect()
    }

    // MARK: - chat.cancel

    @Test("chat.cancel roundtrip decodes cancelled:true")
    func cancelChatRoundtrip() async throws {
        let capturedOp = CaptureBox<String>()
        let capturedRequestId = CaptureBox<String>()
        let daemon = Self.makeDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ccxl-\(UUID().uuidString).sock").path
        ) { [capturedOp, capturedRequestId] request in
            capturedOp.set(request.op)
            if let params = request.params {
                capturedRequestId.set(
                    (try? JSONDecoder().decode(ChatCancelParams.self, from: JSONEncoder().encode(params)))?.requestId ?? ""
                )
            }
            return Data(
                #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWF","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"cancelled":true}}"#
                    .utf8
            )
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.cancelChat(requestId: Self.requestId)
        #expect(result.cancelled)
        #expect(capturedOp.get() == "chat.cancel")
        #expect(capturedRequestId.get() == Self.requestId)
        client.disconnect()
    }

    // MARK: - chat_* server-event routing

    @Test("chat_chunk/chat_done events route through the event subscription")
    func chatEventsRouteThroughSubscription() async throws {
        let collector = EventCollector()
        let daemon = ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-cevt-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: try! JSONEncoder().encode(
                        ServerHello(
                            protocolVersion: 1,
                            messageId: hello.messageId,
                            type: "server_hello",
                            sentAt: 1,
                            daemonVersion: "echo-chat-0.4.0",
                            databaseSchemaVersion: 2
                        )
                    )
                )
            case let .request(request):
                // 1. Resolve the chat.send response…
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(
                        #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWG","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"requestId":"\#(request.requestId)","sessionId":"\#(Self.sessionId)"}}"#
                            .utf8
                    )
                )
                /// 2. …then push the pinned stream as server events.
                func envelope(_ kind: String, _ payload: String) -> String {
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWH","type":"event","sentAt":1,"kind":"\#(kind)","payload":\#(payload)}"#
                }
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(envelope("chat_chunk", #"{"requestId":"\#(request.requestId)","delta":"You investigated "}"#).utf8)
                )
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(envelope("chat_chunk", #"{"requestId":"\#(request.requestId)","delta":"webhook failures."}"#).utf8)
                )
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(envelope("chat_done", #"{"requestId":"\#(request.requestId)","sessionId":"\#(Self.sessionId)"}"#).utf8)
                )
            case .other:
                break
            }
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        client.setEventSubscription { [collector] event in
            collector.append(event)
        }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.sendChat(sessionId: nil, text: "webhook question?")
        #expect(result.sessionId == Self.sessionId)

        // The events race the response on the same socket; poll briefly.
        for _ in 0 ..< 250 where collector.snapshot.count < 3 {
            try await Task.sleep(for: .milliseconds(20))
        }
        let events = collector.snapshot
        // The poll above expires silently when events lose the race, so a
        // bare count #expect would fall through to out-of-bounds indexing.
        if events.count != 3 {
            Issue.record("expected 3 chat events, got \(events.count)")
            return
        }

        // Typed delivery: the deltas are keyed by the requestId returned
        // from chat.send, and the pinned stream arrives in order.
        if case let .chatChunk(requestId, delta) = events[0] {
            #expect(requestId == result.requestId)
            #expect(delta == "You investigated ")
        } else {
            Issue.record("expected chatChunk first, got \(events[0])")
        }
        if case let .chatChunk(requestId, delta) = events[1] {
            #expect(requestId == result.requestId)
            #expect(delta == "webhook failures.")
        } else {
            Issue.record("expected chatChunk second, got \(events[1])")
        }
        if case let .chatDone(requestId, sessionId) = events[2] {
            #expect(requestId == result.requestId)
            #expect(sessionId == Self.sessionId)
        } else {
            Issue.record("expected chatDone third, got \(events[2])")
        }
        client.disconnect()
    }
}
