import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe capture box for the wire params the scripted daemon receives.
private final class CapturedDeleteParams: @unchecked Sendable {
    private let lock = NSLock()
    private var value: JSONValue?
    func set(_ value: JSONValue) {
        lock.lock(); self.value = value; lock.unlock()
    }

    var current: JSONValue? {
        lock.lock(); defer { lock.unlock() }; return value
    }
}

/// Scripted-socket coverage for the M7 `delete.range` op (brief S7 item 4):
/// preset + explicit-range success branches, every typed error branch, and
/// the client-side exactly-one-of guard. Same pattern as WorkflowsClientTests.
struct DeleteClientTests {
    private static func makeDaemon(
        name: String,
        reply: @escaping @Sendable (RequestFrame) -> Data
    ) throws -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("m7-del-\(name)-\(UUID().uuidString).sock").path
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
                        databaseSchemaVersion: 4
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

    private static let deletedJSON = """
    {"deleted":{"rawEvents":142,"steps":37,"episodes":3,"memories":1,"workflows":0}}
    """

    @Test("preset delete roundtrips and sends exactly the preset param")
    func presetDeleteSuccess() async throws {
        let captured = CapturedDeleteParams()
        let daemon = try Self.makeDaemon(name: "ps") { request in
            captured.set(request.params ?? .null)
            let reply =
                #"{"protocolVersion":1,"messageId":"01M7DELETEMSGID0000001","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(Self.deletedJSON)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.deleteHistory(.init(preset: .lastHour))
        #expect(result.deleted.rawEvents == 142)
        #expect(result.deleted.steps == 37)
        #expect(result.deleted.episodes == 3)
        #expect(result.deleted.memories == 1)
        #expect(result.deleted.workflows == 0)

        let encoded = try String(data: JSONEncoder().encode(captured.current), encoding: .utf8)
        #expect(encoded?.contains(#""preset":"last_hour""#) == true)
        #expect(encoded?.contains(#""from""#) == false)
        #expect(encoded?.contains(#""to""#) == false)
        client.disconnect()
    }

    @Test("explicit range delete sends from/to and decodes zero counts")
    func rangeDeleteSuccess() async throws {
        let captured = CapturedDeleteParams()
        let daemon = try Self.makeDaemon(name: "rs") { request in
            captured.set(request.params ?? .null)
            let reply =
                #"{"protocolVersion":1,"messageId":"01M7DELETEMSGID0000002","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"deleted":{"rawEvents":0,"steps":0,"episodes":0,"memories":0,"workflows":0}}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.deleteHistory(.init(from: 1_787_443_200_000, to: 1_787_529_600_000))
        #expect(result.deleted.rawEvents == 0)

        let encoded = try String(data: JSONEncoder().encode(captured.current), encoding: .utf8)
        #expect(encoded?.contains(#""from":1787443200000"#) == true)
        #expect(encoded?.contains(#""to":1787529600000"#) == true)
        client.disconnect()
    }

    @Test("delete.range ok:false error reply surfaces as typed handshakeFailed")
    func deleteServerError() async throws {
        let daemon = try Self.makeDaemon(name: "er") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M7DELETEMSGID0000003","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.invalid_params","message":"delete.range rejected: both/neither selection"}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.handshakeFailed("delete.range rejected: both/neither selection")) {
            try await client.deleteHistory(.init(preset: .all))
        }
        client.disconnect()
    }

    @Test("delete.range ok:true with a missing result surfaces as badFrame")
    func deleteMissingResult() async throws {
        let daemon = try Self.makeDaemon(name: "nr") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M7DELETEMSGID0000004","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.badFrame("delete.range missing result")) {
            try await client.deleteHistory(.init(preset: .today))
        }
        client.disconnect()
    }

    @Test("client refuses mixed and empty selections before any frame is sent")
    func validateGuards() {
        let mixed = DeleteRangeParams(from: 1, to: 2)
        var mixedWithPreset = mixed
        mixedWithPreset.preset = .all
        #expect(throws: DeleteRangeValidationError.mixedPresetAndRange) { try mixedWithPreset.validate() }

        let empty = DeleteRangeParams(from: nil, to: nil, preset: nil)
        #expect(throws: DeleteRangeValidationError.emptySelection) { try empty.validate() }

        // A valid selection never throws.
        #expect(throws: Never.self) { try mixed.validate() }
        #expect(throws: Never.self) { try DeleteRangeParams(preset: .last10Minutes).validate() }
    }

    @Test("delete requests without a live connection fail fast as notConnected")
    func offlineDeleteFailsFast() async {
        let client = DaemonClient()
        await #expect(throws: DaemonClientError.notConnected) {
            try await client.deleteHistory(.init(preset: .all))
        }
    }

    @Test("jobs.retryDead roundtrips the retried count")
    func retryDeadRoundtrip() async throws {
        let daemon = try Self.makeDaemon(name: "rd") { request in
            #expect(request.op == "jobs.retryDead")
            let reply =
                #"{"protocolVersion":1,"messageId":"01M7DELETEMSGID0000005","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"retried":2}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        let result = try await client.retryDeadJobs()
        #expect(result.retried == 2)
        client.disconnect()
    }
}
