import Foundation
@testable import RecorderApp
import Testing

/// Scripted-socket coverage for the M7 diagnostics ops: `status.get`,
/// `settings.get` and `diagnostics.get` decode through a real framed socket.
/// `delete.range` client coverage lives in DeleteClientTests (deduplicated).
struct HardeningClientTests {
    private static func makeDaemon(
        name: String,
        reply: @escaping @Sendable (RequestFrame) -> Data
    ) throws -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("m7-\(name)-\(UUID().uuidString).sock").path
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

    @Test("fetchStatus / fetchSettings / fetchDiagnostics decode through the socket")
    func diagnosticsOpsRoundtrip() async throws {
        let daemon = try Self.makeDaemon(name: "ds") { request in
            let result = switch request.op {
            case "status.get":
                #"{"daemon":{"version":"0.1.0","schemaVersion":4,"uptimeMs":7200000},"recording":{"paused":true,"reason":"disk_pressure"},"accessibilityRequired":false,"queue":{"pending":3,"retrying":1,"dead":2},"db":{"rawEvents":1200,"segments":40,"steps":300,"episodes":12,"memories":8,"workflows":2,"pageCountBytes":1048576},"diskFreeBytes":2147483648}"#
            case "settings.get":
                #"{"settings":{"chatModel":"openai/gpt-5.6-luna","backgroundModel":"haiku","rawRetentionHours":48,"semanticRetentionDays":30}}"#
            case "diagnostics.get":
                #"{"integrityOk":true,"lastErrors":[{"at":1787443200000,"scope":"ingest","code":"bad_batch","message":"dropped malformed batch"}]}"#
            default:
                "{}"
            }
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(result)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let status = try await client.fetchStatus()
        #expect(status.daemon.schemaVersion == 4 && status.daemon.uptimeMs == 7_200_000)
        #expect(status.recording.paused && status.recording.reason == "disk_pressure")
        #expect(status.queue.pending == 3 && status.queue.retrying == 1 && status.queue.dead == 2)
        #expect(status.db.rawEvents == 1200 && status.db.episodes == 12)
        #expect(status.diskFreeBytes == 2_147_483_648)

        let settings = try await client.fetchSettings()
        #expect(settings.settings.chatModel == "openai/gpt-5.6-luna")
        #expect(settings.settings.semanticRetentionDays == 30)

        let diagnostics = try await client.fetchDiagnostics()
        #expect(diagnostics.integrityOk)
        #expect(diagnostics.lastErrors.first?.code == "bad_batch")

        client.disconnect()
    }

    @Test("hardening ops without a live connection fail fast as notConnected")
    func offlineFailFast() async throws {
        let client = DaemonClient()
        do {
            _ = try await client.fetchStatus()
            Issue.record("expected notConnected")
        } catch {
            #expect(error is DaemonClientError)
        }
        do {
            _ = try await client.deleteHistory(DeleteRangeParams(preset: .all))
            Issue.record("expected notConnected")
        } catch {
            #expect(error is DaemonClientError)
        }
    }
}
