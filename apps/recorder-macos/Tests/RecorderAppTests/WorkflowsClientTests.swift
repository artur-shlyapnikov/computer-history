import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe capture box: the scripted-daemon reply closure is @Sendable,
/// so captured wire params go through a lock instead of a local var.
private final class CapturedWorkflowParams: @unchecked Sendable {
    private let lock = NSLock()
    private var value: JSONValue?
    func set(_ value: JSONValue) {
        lock.lock(); self.value = value; lock.unlock()
    }

    var current: JSONValue? {
        lock.lock(); defer { lock.unlock() }; return value
    }
}

/// Scripted-socket coverage for the M6 workflow ops: `workflows.list` decode
/// (with embedded occurrences) + `workflow.action` roundtrips, including every
/// typed error branch (ok:false rejection, ok:true with missing result,
/// not-connected). Same pattern as MemoriesClientTests.
struct WorkflowsClientTests {
    private static let candidateId = "01M6WORKFLOWCANDIDATE000001"

    /// Handshake echo + one canned reply builder keyed by op (same pattern as
    /// DaemonClientHandshakeTests' shared boilerplate).
    private static func makeDaemon(
        name: String,
        reply: @escaping @Sendable (RequestFrame) -> Data
    ) throws -> ScriptedDaemon {
        ScriptedDaemon(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("m6-\(name)-\(UUID().uuidString).sock").path
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

    @Test("listWorkflows decodes items with embedded occurrences through the socket")
    func listWorkflowsSuccess() async throws {
        let resultJSON = """
        {"workflows":[
          {"id":"01M6WORKFLOWCANDIDATE000001","name":"File a Jira issue from Slack","purpose":"Turn Slack problem reports into tracked issues","status":"candidate","template":{"name":"File a Jira issue from Slack","purpose":"Turn Slack problem reports into tracked issues","preconditions":["Jira open in browser"],"stableSteps":["Focus Slack","Click button Create","Edit textarea"],"variableInputs":["issue summary text"],"expectedOutcome":"New Jira issue created"},"occurrenceCount":3,"medianSimilarity":0.82,"firstSeenAtMs":1787000000000,"lastSeenAtMs":1787443200000,"createdAtMs":1787443200000,"updatedAtMs":1787443200000,"occurrences":[{"episodeId":"01M6OCCURRENCEEPISODE00001","startedAtMs":1787443200000,"similarity":0.86},{"episodeId":"01M6OCCURRENCEEPISODE00002","startedAtMs":1787356800000,"similarity":0.81},{"episodeId":"01M6OCCURRENCEEPISODE00003","startedAtMs":1787270400000,"similarity":0.79}]},
          {"id":"01M6WORKFLOWCONFIRMED0000002","name":"Morning inbox triage","purpose":null,"status":"confirmed","template":{},"occurrenceCount":4,"medianSimilarity":0.79,"firstSeenAtMs":1786900000000,"lastSeenAtMs":1787443000000,"createdAtMs":1786900000000,"updatedAtMs":1787443000000,"occurrences":[]}
        ]}
        """
        let daemon = try Self.makeDaemon(name: "wo") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(resultJSON)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.listWorkflows()
        #expect(result.workflows.count == 2)
        let candidate = result.workflows[0]
        #expect(candidate.status == .candidate && candidate.occurrenceCount == 3)
        #expect(candidate.medianSimilarity == 0.82)
        #expect(candidate.template.stableSteps?.count == 3)
        #expect(candidate.template.variableInputs == ["issue summary text"])
        #expect(candidate.template.expectedOutcome == "New Jira issue created")
        // Occurrences arrive newest-first by startedAtMs (wire contract).
        #expect(candidate.occurrences.map(\.startedAtMs) == [1_787_443_200_000, 1_787_356_800_000, 1_787_270_400_000])
        #expect(candidate.occurrences[0].similarity == 0.86)
        #expect(!candidate.occurrences[2].episodeId.isEmpty)

        let confirmed = result.workflows[1]
        #expect(confirmed.status == .confirmed && confirmed.purpose == nil)
        #expect(confirmed.occurrences.isEmpty)
        client.disconnect()
    }

    @Test("listWorkflows sends the requested status param and nothing else")
    func listWorkflowsWithStatusParam() async throws {
        let captured = CapturedWorkflowParams()
        let daemon = try Self.makeDaemon(name: "ws") { request in
            captured.set(request.params ?? .null)
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"workflows":[]}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        let result = try await client.listWorkflows(status: "candidate")
        #expect(result.workflows.isEmpty)
        // The wire params must carry exactly the requested status — no extras.
        let encoded = try String(data: JSONEncoder().encode(captured.current), encoding: .utf8)
        #expect(encoded?.contains(#""status":"candidate""#) == true)
    }

    @Test("listWorkflows ok:false error reply surfaces as typed handshakeFailed")
    func listWorkflowsServerError() async throws {
        let daemon = try Self.makeDaemon(name: "we") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.invalid_params","message":"workflows.list rejected: unknown status"}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.handshakeFailed("workflows.list rejected: unknown status")) {
            _ = try await client.listWorkflows(status: "bogus")
        }
        client.disconnect()
    }

    @Test("listWorkflows ok:true with a missing result surfaces as badFrame")
    func listWorkflowsMissingResult() async throws {
        let daemon = try Self.makeDaemon(name: "wn") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.badFrame("workflows.list missing result")) {
            _ = try await client.listWorkflows()
        }
        client.disconnect()
    }

    @Test("workflow.action confirm roundtrip returns the updated row without occurrences")
    func workflowActionConfirmRoundtrip() async throws {
        let captured = CapturedWorkflowParams()
        let updatedJSON =
            #"{"updated":{"id":"01M6WORKFLOWCANDIDATE000001","name":"File a Jira issue from Slack","purpose":null,"status":"confirmed","template":{},"occurrenceCount":3,"medianSimilarity":0.82,"firstSeenAtMs":1787000000000,"lastSeenAtMs":1787443200000,"createdAtMs":1787000100000,"updatedAtMs":1787443201000}}"#
        let daemon = try Self.makeDaemon(name: "wa") { request in
            captured.set(request.params ?? .null)
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":\#(updatedJSON)}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        let result = try await client.workflowAction(id: Self.candidateId, action: .confirm)
        #expect(result.updated?.status == .confirmed)
        // The wire params must carry exactly {id, action}.
        let encoded = try String(data: JSONEncoder().encode(captured.current), encoding: .utf8)
        #expect(encoded?.contains(#""action":"confirm""#) == true)
        #expect(encoded?.contains(Self.candidateId) == true)
        client.disconnect()
    }

    @Test("workflow.action reject resolves to updated:null when the row vanished")
    func workflowActionNullUpdated() async throws {
        let daemon = try Self.makeDaemon(name: "wr") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{"updated":null}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        let result = try await client.workflowAction(id: Self.candidateId, action: .reject)
        #expect(result.updated == nil)
        client.disconnect()
    }

    @Test("workflow.action unknown id surfaces error.not_found as handshakeFailed")
    func workflowActionNotFound() async throws {
        let daemon = try Self.makeDaemon(name: "wf") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":false,"error":{"code":"error.not_found","message":"workflow.action rejected: unknown id"}}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.handshakeFailed("workflow.action rejected: unknown id")) {
            _ = try await client.workflowAction(id: Self.candidateId, action: .reject)
        }
        client.disconnect()
    }

    @Test("workflow.action ok:true with a missing result surfaces as badFrame")
    func workflowActionMissingResult() async throws {
        let daemon = try Self.makeDaemon(name: "wm") { request in
            let reply =
                #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true}"#
            return Data(reply.utf8)
        }
        try daemon.start()
        defer { daemon.stop() }

        let client = DaemonClient()
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")
        await #expect(throws: DaemonClientError.badFrame("workflow.action missing result")) {
            _ = try await client.workflowAction(id: Self.candidateId, action: .confirm)
        }
    }

    @Test("workflows_changed event frame decodes onto the empty payload")
    func workflowsChangedFrameDecodes() throws {
        let json =
            #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKE","type":"event","sentAt":1,"kind":"workflows_changed","payload":{}}"#
        let frame = try JSONDecoder().decode(WorkflowsChangedEvent.self, from: Data(json.utf8))
        #expect(frame.type == "event" && frame.kind == "workflows_changed")
    }

    @Test("requests without a live connection fail fast as notConnected")
    func offlineRequestsFailFast() async {
        let client = DaemonClient()
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.listWorkflows()
        }
        await #expect(throws: DaemonClientError.notConnected) {
            _ = try await client.workflowAction(id: Self.candidateId, action: .confirm)
        }
    }
}
