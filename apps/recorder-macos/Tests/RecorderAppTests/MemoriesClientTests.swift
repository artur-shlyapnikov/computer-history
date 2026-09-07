import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe capture box: the scripted-daemon reply closure is @Sendable,
/// so captured wire params go through a lock instead of a local var.
private final class CapturedParams: @unchecked Sendable {
    private let lock = NSLock()
    private var value: JSONValue?
    func set(_ value: JSONValue) {
        lock.lock(); self.value = value; lock.unlock()
    }

    var current: JSONValue? {
        lock.lock(); defer { lock.unlock() }; return value
    }
}

/// Scripted-socket coverage for the M5 memory ops: `memories.list` grouped
/// decode + `memory.action` roundtrips, including every typed error branch
/// (ok:false rejection, ok:true with missing result, not-connected).
struct MemoriesClientTests {
    private static let suggestionId = "01M0NP9G4HP0M1M64H8TC0VEKS"

    /// Handshake echo + one canned reply builder keyed by op (same pattern as
    /// DaemonClientHandshakeTests' shared boilerplate).
    private static func makeDaemon(
        name: String,
        reply: @escaping @Sendable (RequestFrame) -> Data
    ) throws -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("m5-\(name)-\(UUID().uuidString).sock").path
        ) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                let helloReply = try! JSONEncoder().encode(
                    ServerHello(
                        protocolVersion: 1,
                        messageId: hello.messageId,
                        type: "server_hello",
                        sentAt: 1,
                        daemonVersion: "echo-0.1.0",
                        databaseSchemaVersion: 2
                    )
                )
                ScriptedDaemon.sendFrame(fd: client, payload: helloReply)
            case let .request(request):
                ScriptedDaemon.sendFrame(fd: client, payload: reply(request))
            case .other:
                break
            }
        }
    }

    @Test("listMemories decodes the grouped result through the socket")
    func listMemoriesSuccess() async throws {
        let resultJSON = """
        {"groups":[
          {"status":"confirmed","memories":[{"id":"01M0NP9G4HP0M1M64H8TC0VEKT","kind":"preference","canonicalKey":"editor.preference.theme","text":"Prefers dark theme","confidence":0.86,"status":"active","firstSeenAtMs":1787000000000,"lastSeenAtMs":1787443200000,"evidenceCount":3,"createdAtMs":1787000100000,"updatedAtMs":1787443200000}]},
          {"status":"suggestions","memories":[{"id":"01M0NP9G4HP0M1M64H8TC0VEKS","kind":"fact","canonicalKey":"payments.provider","text":"Uses Stripe for payments","confidence":0.55,"status":"candidate","firstSeenAtMs":1787000000000,"lastSeenAtMs":1787443200000,"evidenceCount":1,"createdAtMs":1787000100000,"updatedAtMs":1787443200000}]},
          {"status":"rejected","memories":[]}
        ]}
        """
        let daemon = try Self.makeDaemon(name: "lo") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(resultJSON)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.listMemories()
        #expect(result.groups.map(\.status) == [.confirmed, .suggestions, .rejected])
        let confirmed = result.groups[0].memories[0]
        #expect(confirmed.status == .active && confirmed.evidenceCount == 3)
        let suggestion = result.groups[1].memories[0]
        #expect(suggestion.kind == .fact && suggestion.confidence == 0.55)
        client.disconnect()
    }

    @Test("listMemories sends the requested status param")
    func listMemoriesWithStatusParam() async throws {
        let captured = CapturedParams()
        let daemon = try Self.makeDaemon(name: "ls") { request in
            captured.set(request.params ?? .null)
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"groups":[{"status":"superseded","memories":[]}]}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.listMemories(status: "superseded")
        #expect(result.groups.map(\.status) == [.superseded])
        // The wire params must carry exactly the requested status — no extras.
        let encoded = try String(data: JSONEncoder().encode(captured.current), encoding: .utf8)
        #expect(encoded?.contains(#""status":"superseded""#) == true)
    }

    @Test("listMemories ok:false error reply surfaces as typed handshakeFailed")
    func listMemoriesServerError() async throws {
        let daemon = try Self.makeDaemon(name: "le") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.invalid_params","message":"memories.list rejected: unknown status"}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.handshakeFailed("memories.list rejected: unknown status")) {
            _ = try await client.listMemories(status: "bogus")
        }
        client.disconnect()
    }

    @Test("listMemories ok:true with a missing result surfaces as badFrame")
    func listMemoriesMissingResult() async throws {
        let daemon = try Self.makeDaemon(name: "ln") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.badFrame("memories.list missing result")) {
            _ = try await client.listMemories()
        }
        client.disconnect()
    }

    @Test("memory.action confirm roundtrip returns the updated row")
    func memoryActionConfirmRoundtrip() async throws {
        let updatedJSON =
            #"{"updated":{"id":"01M0NP9G4HP0M1M64H8TC0VEKS","kind":"preference","canonicalKey":"editor.preference.theme","text":"Prefers dark theme","confidence":0.86,"status":"active","firstSeenAtMs":1787000000000,"lastSeenAtMs":1787443200000,"evidenceCount":3,"createdAtMs":1787000100000,"updatedAtMs":1787443201000}}"#
        let daemon = try Self.makeDaemon(name: "ac") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(updatedJSON)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        let result = try await client.memoryAction(id: Self.suggestionId, action: .confirm)
        #expect(result.updated?.status == .active)
        client.disconnect()
    }

    @Test("memory.action forget resolves to updated:nil (hard delete)")
    func memoryActionForgetNullUpdated() async throws {
        let daemon = try Self.makeDaemon(name: "af") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"updated":null}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        let result = try await client.memoryAction(id: Self.suggestionId, action: .forget)
        #expect(result.updated == nil)
        client.disconnect()
    }

    @Test("memory.action unknown id surfaces error.not_found as handshakeFailed")
    func memoryActionNotFound() async throws {
        let daemon = try Self.makeDaemon(name: "an") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.not_found","message":"memory.action rejected: unknown id"}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.handshakeFailed("memory.action rejected: unknown id")) {
            _ = try await client.memoryAction(id: Self.suggestionId, action: .reject)
        }
        client.disconnect()
    }

    @Test("memory.action ok:true with a missing result surfaces as badFrame")
    func memoryActionMissingResult() async throws {
        let daemon = try Self.makeDaemon(name: "ar") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.badFrame("memory.action missing result")) {
            _ = try await client.memoryAction(id: Self.suggestionId, action: .confirm)
        }
        client.disconnect()
    }

    @Test("requests without a live connection fail fast as notConnected")
    func offlineRequestsFailFast() async {
        let client = DaemonClient()
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.listMemories()
        }
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.memoryAction(id: Self.suggestionId, action: .forget)
        }
    }
}
