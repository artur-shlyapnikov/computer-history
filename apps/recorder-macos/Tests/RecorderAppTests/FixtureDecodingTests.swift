import Foundation
@testable import RecorderApp
import Testing

/// Decodes every golden fixture from packages/protocol/fixtures through the
/// repo-relative symlink apps/recorder-macos/Fixtures. This is the anti-drift
/// contract between the TypeBox wire schemas and the Swift Codable mirrors.
struct FixtureDecodingTests {
    static let fixturesRoot: URL = {
        // Tests/RecorderAppTests/<this file> → walk up to the package dir,
        // then into the symlinked Fixtures directory.
        let fileURL = URL(fileURLWithPath: #filePath)
        let packageDir = fileURL
            .deletingLastPathComponent() // RecorderAppTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apps/recorder-macos
        return packageDir.appendingPathComponent("Fixtures")
    }()

    private func fixtureData(_ relativePath: String) throws -> Data {
        let url = Self.fixturesRoot.appendingPathComponent(relativePath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            Issue.record("fixture missing at \(url.path) — run scripts/sync-fixtures.sh")
            return Data()
        }
        return try Data(contentsOf: url)
    }

    private func decodeBadAction() throws -> ActivityEvent {
        try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("invalid/event-bad-action.json"))
    }

    @Test("valid fixtures decode into Swift mirrors")
    func validFixturesDecode() throws {
        _ = try JSONDecoder().decode(ClientHello.self, from: fixtureData("handshake.client.json"))
        _ = try JSONDecoder().decode(ServerHello.self, from: fixtureData("handshake.server.json"))
        _ = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.basic.json"))

        let secure = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.secure-redacted.json"))
        #expect(secure.contentPolicy == .redactedSecureField)
        #expect(secure.target?.subrole == "AXSecureTextField")

        // Producer reality: plain-keystroke typing drafts carry no text
        // (InputMonitor), so PrivacyFilter yields `allow` with null content.
        let typing = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.typing-redacted.json"))
        #expect(typing.contentPolicy == .allow)
        #expect(typing.content == nil)

        let allowContent = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.allow-content.json"))
        #expect(allowContent.contentPolicy == .allow)
        #expect(allowContent.content?.isEmpty == false)

        // The only policy whose wire shape carries scrubbed content.
        let secretPattern = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.secret-pattern-redacted.json"))
        #expect(secretPattern.contentPolicy == .redactedSecretPattern)
        #expect(secretPattern.content?.contains("[REDACTED]") == true)

        let oversize = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.oversize-redacted.json"))
        #expect(oversize.contentPolicy == .redactedOversize)
        #expect(oversize.content == nil)

        // Tombstone: fact only — window/target/content absent entirely.
        let tombstone = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.excluded-app-tombstone.json"))
        #expect(tombstone.contentPolicy == .excludedApp)
        #expect(tombstone.content == nil && tombstone.window == nil && tombstone.target == nil)

        let sensitive = try JSONDecoder().decode(ActivityEvent.self, from: fixtureData("activity-event.sensitive-redacted.json"))
        #expect(sensitive.contentPolicy == .redactedSensitiveLabel)
        #expect(sensitive.content == nil)
        let batch = try JSONDecoder().decode(EventBatch.self, from: fixtureData("event-batch.json"))
        #expect(batch.events.count == 2)
        #expect(batch.events.allSatisfy { !$0.id.isEmpty })

        let timelineRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.timeline-list.json"))
        #expect(timelineRequest.op == "timeline.list")
        let timelineParamsData = try JSONEncoder().encode(timelineRequest.params ?? .null)
        let timelineParams = try JSONDecoder().decode(TimelineListParams.self, from: timelineParamsData)
        #expect(timelineParams.limit == TimelineListDefaults.defaultLimit)
        #expect(timelineParams.from == nil && timelineParams.to == nil)

        let timelineResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.timeline-list.json"))
        #expect(timelineResponse.ok)
        let timelineResult = try timelineResponse.decodedResult(as: TimelineListResult.self)
        let episodes = try #require(timelineResult?.episodes)
        #expect(episodes.count == 2)
        #expect(episodes[0].title == "Investigated webhook failures")
        #expect(episodes[0].appNames == ["Safari", "Terminal", "Slack"])
        #expect(episodes[0].stepCount == 12 && episodes[0].pendingJobs == 2)
        #expect(episodes[0].startedAtMs < episodes[0].endedAtMs)
        #expect(episodes[1].title == "Drafted release notes")
        #expect(episodes[1].appNames == ["Safari"])

        let ack = try JSONDecoder().decode(EventBatchAck.self, from: fixtureData("event-batch-ack.json"))
        #expect(ack.accepted == 2 && ack.duplicates == 0 && ack.rejected == 0)

        let request = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.history-search.json"))
        #expect(request.op == "history.search")

        let response = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.history-search.json"))
        #expect(response.ok)

        let segmentsRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.segments-list.json"))
        #expect(segmentsRequest.op == "segments.list")
        let paramsData = try JSONEncoder().encode(segmentsRequest.params ?? .null)
        let segmentsParams = try JSONDecoder().decode(SegmentsListParams.self, from: paramsData)
        #expect(segmentsParams.limit == SegmentsListDefaults.defaultLimit)
        #expect(segmentsParams.from == nil && segmentsParams.to == nil)
        let segmentsResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.segments-list.json"))
        #expect(segmentsResponse.ok)
        let segmentsResult = try segmentsResponse.decodedResult(as: SegmentsListResult.self)
        let segments = try #require(segmentsResult?.segments)
        #expect(segments.count == 1)
        let segment = try #require(segments.first)
        #expect(segment.state == .finalized)
        #expect(segment.stepCount == 2 && segment.steps.count == 2)
        let segmentEnded = try #require(segment.endedAtMs)
        #expect(segment.startedAtMs < segmentEnded)
        #expect(segment.steps.map(\.ordinal) == [1, 2])
        #expect(segment.steps[0].action == "switch_app")
        #expect(segment.steps[0].appName == "Safari")
        #expect(segment.steps[0].text == nil)
        #expect(segment.steps[1].action == "scroll")

        let episode = try JSONDecoder().decode(EpisodeGetResult.self, from: fixtureData("episode.with-steps.json"))
        #expect(episode.steps.map(\.ordinal) == [0, 1])
        #expect(episode.episode.title == "Investigated webhook failures")
        #expect(episode.episode.entities == ["stripe", "webhooks", "TANGO-123"])
        #expect(episode.episode.apps == ["com.apple.Safari", "com.apple.Terminal", "rebel.slack"])
        #expect(episode.episode.summaryModel == nil && episode.episode.summaryPromptVersion == nil)

        let memory = try JSONDecoder().decode(MemoryCandidateDto.self, from: fixtureData("memory-candidate.json"))
        #expect(memory.kind == .preference && memory.status == .candidate)

        let workflow = try JSONDecoder().decode(WorkflowDto.self, from: fixtureData("workflow.candidate.json"))
        #expect(workflow.status == .candidate && workflow.occurrenceCount == 3)

        // M4 chat ops + chat_* server events (spec §3.19; contracts §Server-
        // pushed events). Deltas/dones/errors are keyed by requestId.
        let chatSendRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.chat-send.json"))
        #expect(chatSendRequest.op == "chat.send")
        let chatParamsData = try JSONEncoder().encode(chatSendRequest.params ?? .null)
        let chatSendParams = try JSONDecoder().decode(ChatSendParams.self, from: chatParamsData)
        #expect(!chatSendParams.text.isEmpty)

        let chatSendResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.chat-send.json"))
        #expect(chatSendResponse.ok)
        let chatSendResult = try #require(try chatSendResponse.decodedResult(as: ChatSendResult.self))
        #expect(!chatSendResult.requestId.isEmpty)
        #expect(!chatSendResult.sessionId.isEmpty)

        let chatCancelRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.chat-cancel.json"))
        #expect(chatCancelRequest.op == "chat.cancel")
        let cancelParamsData = try JSONEncoder().encode(chatCancelRequest.params ?? .null)
        let cancelParams = try JSONDecoder().decode(ChatCancelParams.self, from: cancelParamsData)
        #expect(!cancelParams.requestId.isEmpty)

        let chunkEvent = try JSONDecoder().decode(ChatChunkEvent.self, from: fixtureData("event.chat-chunk.json"))
        #expect(chunkEvent.kind == "chat_chunk")
        #expect(!chunkEvent.payload.requestId.isEmpty)
        #expect(!chunkEvent.payload.delta.isEmpty)

        let doneEvent = try JSONDecoder().decode(ChatDoneEvent.self, from: fixtureData("event.chat-done.json"))
        #expect(doneEvent.kind == "chat_done")
        #expect(doneEvent.payload.requestId == chunkEvent.payload.requestId)
        #expect(!doneEvent.payload.sessionId.isEmpty)

        let errorEvent = try JSONDecoder().decode(ChatErrorEvent.self, from: fixtureData("event.chat-error.json"))
        #expect(errorEvent.kind == "chat_error")
        #expect(!errorEvent.payload.code.isEmpty)
        #expect(!errorEvent.payload.message.isEmpty)

        // M5 memory ops (spec §3.16–3.17; contracts §Protocol v1). Group
        // status values are daemon display-group names; memory.action
        // confirm/reject return the updated row, forget returns null.
        let memoriesRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.memories-list.json"))
        #expect(memoriesRequest.op == "memories.list")
        let memoriesParamsData = try JSONEncoder().encode(memoriesRequest.params ?? .null)
        let memoriesParams = try JSONDecoder().decode(MemoriesListParams.self, from: memoriesParamsData)
        #expect(memoriesParams.status == nil)

        let memoriesResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.memories-list.json"))
        #expect(memoriesResponse.ok)
        let memoriesResult = try #require(try memoriesResponse.decodedResult(as: MemoriesListResult.self))
        #expect(memoriesResult.groups.map(\.status) == [.confirmed, .suggestions, .rejected])
        let confirmedMemory = try #require(memoriesResult.groups.first { $0.status == .confirmed }?.memories.first)
        #expect(confirmedMemory.status == .active)

        let actionRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.memory-action.json"))
        #expect(actionRequest.op == "memory.action")
        let actionParamsData = try JSONEncoder().encode(actionRequest.params ?? .null)
        let actionParams = try JSONDecoder().decode(MemoryActionParams.self, from: actionParamsData)
        #expect(actionParams.action == .confirm)
        #expect(!actionParams.id.isEmpty)

        let actionResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.memory-action.json"))
        #expect(actionResponse.ok)
        let actionResult = try #require(try actionResponse.decodedResult(as: MemoryActionResult.self))
        #expect(actionResult.updated != nil)
        #expect(actionResult.updated?.status == .active)

        // M6 workflow ops (spec §3.20; contracts §Protocol v1). workflows.list
        // items embed occurrences (newest-first by startedAtMs); workflow.action
        // returns the plain updated row (no occurrences).
        let workflowsListRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.workflows-list.json"))
        #expect(workflowsListRequest.op == "workflows.list")
        let workflowsListParamsData = try JSONEncoder().encode(workflowsListRequest.params ?? .null)
        let workflowsListParams = try JSONDecoder().decode(WorkflowsListParams.self, from: workflowsListParamsData)
        #expect(workflowsListParams.status == "candidate")

        let workflowsListResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.workflows-list.json"))
        #expect(workflowsListResponse.ok)
        let workflowsListResult = try #require(try workflowsListResponse.decodedResult(as: WorkflowsListResult.self))
        #expect(workflowsListResult.workflows.count == 1)
        let workflowItem = try #require(workflowsListResult.workflows.first)
        #expect(workflowItem.id == "01M0NP9G4HP0M1M64H8TC0VEKM")
        #expect(workflowItem.status == .candidate && workflowItem.occurrenceCount == 3)
        #expect(workflowItem.medianSimilarity == 0.81)
        #expect(workflowItem.template.stableSteps?.count == 4)
        #expect(workflowItem.template.variableInputs == ["issue title", "reproduction steps text"])
        #expect(workflowItem.template.expectedOutcome?.isEmpty == false)
        // Occurrences newest-first by startedAtMs (wire contract).
        #expect(workflowItem.occurrences.map(\.startedAtMs) == [1_787_356_800_000, 1_786_180_000_000, 1_785_000_000_000])
        #expect(workflowItem.occurrences.map(\.similarity) == [0.84, 0.79, 0.80])
        #expect(workflowItem.occurrences.allSatisfy { !$0.episodeId.isEmpty })

        let workflowActionRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.workflow-action.json"))
        #expect(workflowActionRequest.op == "workflow.action")
        let workflowActionParamsData = try JSONEncoder().encode(workflowActionRequest.params ?? .null)
        let workflowActionParams = try JSONDecoder().decode(WorkflowActionParams.self, from: workflowActionParamsData)
        #expect(workflowActionParams.action == .confirm)
        #expect(workflowActionParams.id == "01M0NP9G4HP0M1M64H8TC0VEKM")

        let workflowActionResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.workflow-action.json"))
        #expect(workflowActionResponse.ok)
        let workflowActionResult = try #require(try workflowActionResponse.decodedResult(as: WorkflowActionResult.self))
        #expect(workflowActionResult.updated?.status == .confirmed)
        #expect(workflowActionResult.updated?.occurrenceCount == 3)

        // M7 hardening ops: delete.range (spec §3.23; D7b-frozen shape) and
        // jobs.retryDead (additive daemon diagnostics op).
        let deleteRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.delete-range.json"))
        #expect(deleteRequest.op == "delete.range")
        let deleteParamsData = try JSONEncoder().encode(deleteRequest.params ?? .null)
        let deleteParams = try JSONDecoder().decode(DeleteRangeParams.self, from: deleteParamsData)
        #expect(deleteParams.preset == .lastHour)
        #expect(deleteParams.from == nil && deleteParams.to == nil)

        let deleteResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.delete-range.json"))
        #expect(deleteResponse.ok)
        let deleteResult = try #require(try deleteResponse.decodedResult(as: DeleteRangeResult.self))
        #expect(deleteResult.deleted.rawEvents == 142)
        #expect(deleteResult.deleted.steps == 37)
        #expect(deleteResult.deleted.episodes == 3)
        #expect(deleteResult.deleted.memories == 1)
        #expect(deleteResult.deleted.workflows == 0)

        let retryDeadRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.jobs-retry-dead.json"))
        #expect(retryDeadRequest.op == "jobs.retryDead")
        let retryDeadResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.jobs-retry-dead.json"))
        #expect(retryDeadResponse.ok)
        let retryDeadResult = try #require(try retryDeadResponse.decodedResult(as: JobsRetryDeadResult.self))
        #expect(retryDeadResult.retried == 2)

        // diagnostics.get (read-only daemon health surface).
        let diagnosticsRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.diagnostics-get.json"))
        #expect(diagnosticsRequest.op == "diagnostics.get")
        let diagnosticsResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.diagnostics-get.json"))
        #expect(diagnosticsResponse.ok)
        let diagnostics = try #require(try diagnosticsResponse.decodedResult(as: DiagnosticsGetResult.self))
        #expect(diagnostics.integrityOk)
        let entry = try #require(diagnostics.lastErrors.first)
        #expect(entry.scope == "ingest" && entry.code == "bad_batch")
        #expect(entry.message == "dropped malformed batch")
    }

    @Test("invalid fixture fails to decode (unknown action enum value)")
    func invalidFixtureThrows() throws {
        #expect(throws: Error.self) {
            _ = try decodeBadAction()
        }
    }

    @Test("history-search response result carries hits with provenance")
    func historyResultDecodes() throws {
        let response = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.history-search.json"))
        #expect(response.ok)
        let result = try #require(try response.decodedResult(as: HistorySearchResult.self))
        #expect(result.hits.count == 1)
        let hit = try #require(result.hits.first)
        #expect(hit.source.episodeId == "01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(hit.source.stepId == "01M0NP9G4HP0M1M64H8TC0VEKG")
        #expect(hit.source.appNames == ["Safari", "Slack"])
        #expect(hit.source.snippet == "Investigated webhook failures in the payments integration")
        #expect(hit.source.startedAtMs < hit.source.endedAtMs)
    }

    @Test("fixtures root resolves through the repo-relative symlink")
    func fixturesRootExistsThroughSymlink() {
        #expect(FileManager.default.fileExists(atPath: Self.fixturesRoot.path))
    }

    @Test("round-3 goldens decode into Swift mirrors")
    func newGoldensDecode() throws {
        let protocolError = try JSONDecoder().decode(ProtocolErrorFrame.self, from: fixtureData("error.protocol-error.json"))
        #expect(protocolError.error.code == "error.bad_frame")

        let queueUpdate = try JSONDecoder().decode(QueueUpdateEvent.self, from: fixtureData("event.queue-update.json"))
        #expect(queueUpdate.payload.pendingJobs == 3)

        let recordingState = try JSONDecoder().decode(RecordingStateEvent.self, from: fixtureData("event.recording-state.json"))
        #expect(recordingState.payload.state == "paused")
        #expect(recordingState.payload.reason == "disk_pressure")

        let statusRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.status-get.json"))
        #expect(statusRequest.op == "status.get")
        let statusResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.status-get.json"))
        let status = try #require(try statusResponse.decodedResult(as: StatusResult.self))
        #expect(status.daemon.schemaVersion == 6)
        #expect(status.queue.pending == 2)

        let episodeRequest = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.episode-get.json"))
        #expect(episodeRequest.op == "episode.get")
        let episodeResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.episode-get.json"))
        let episode = try #require(try episodeResponse.decodedResult(as: EpisodeGetResult.self))
        #expect(!episode.steps.isEmpty)

        let errResponse = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("response.err.json"))
        #expect(errResponse.ok == false)
        #expect(errResponse.error?.code == "error.invalid_params")
    }

    @Test("unknown frame type rejects as every envelope mirror")
    func unknownFrameTypeRejects() {
        #expect {
            _ = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/frame-unknown-type.json"))
        } throws: { _ in true }
        #expect {
            _ = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("invalid/frame-unknown-type.json"))
        } throws: { _ in true }
        #expect {
            _ = try JSONDecoder().decode(ProtocolErrorFrame.self, from: fixtureData("invalid/frame-unknown-type.json"))
        } throws: { _ in true }
    }

    @Test("bad-ULID hello decodes structurally (ULID gate is TS-schema-side)")
    func badUlidHelloDecodes() throws {
        let hello = try JSONDecoder().decode(ClientHello.self, from: fixtureData("invalid/hello-bad-messageId.json"))
        #expect(hello.messageId == "01M0NP9G4GOXGYT7PYGFC5K5HO")
    }

    // MARK: - Round-7 fixture coverage (FixtureCoverageFix)

    /// Fixtures whose violation lives in gates the Swift mirrors deliberately
    /// do not enforce: TS wire layer rejects; Swift mirror accepts —
    /// enforcement is daemon-side. Each pins structural decode success.
    @Test("round-7 divergent fixtures decode structurally (bounds/caps/params gates are TS-side)")
    func round7DivergentFixturesDecode() throws {
        // sentAt negative / >2^53-1 are numeric bounds Int64 accepts.
        #expect(try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/envelope-sentAt-negative.json")).sentAt == -1)
        #expect(try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/envelope-sentAt-overflow.json")).sentAt == 9_007_199_254_740_992)
        // requestId/batchId ULID patterns are TS-schema-side (see badUlidHelloDecodes).
        #expect(try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/request-bad-requestId.json")).requestId == "not-a-ulid")
        #expect(try JSONDecoder().decode(EventBatch.self, from: fixtureData("invalid/event-batch-bad-batchId.json")).batchId == "not-a-ulid")
        // response error.code rides as String; the code enum is TS-side.
        let unknownCode = try JSONDecoder().decode(ResponseFrame.self, from: fixtureData("invalid/response-err-unknown-code.json"))
        #expect(unknownCode.error?.code == "error.banana")
        // recording_state state values ride as String in the Swift payload mirror.
        #expect(try JSONDecoder().decode(RecordingStatePayload.self, from: fixtureData("invalid/event-recording-state-state-unknown.json")).state == "paused_active")
        // pendingJobs >2^53-1 still fits Int64 on arm64.
        #expect(try JSONDecoder().decode(QueueUpdatePayload.self, from: fixtureData("invalid/event-queue-update-pendingJobs-overflow.json")).pendingJobs == 9_007_199_254_740_992)
        // maxItems caps are not mirrored: a 1001-event batch decodes wholesale.
        #expect(try JSONDecoder().decode(EventBatch.self, from: fixtureData("invalid/event-batch-events-over-max.json")).events.count == 1001)
        // chat.send text minLength/maxLength live TS-side.
        #expect(try JSONDecoder().decode(ChatSendParams.self, from: fixtureData("invalid/params-chat-send-text-empty.json")).text.isEmpty)
        #expect(try JSONDecoder().decode(ChatSendParams.self, from: fixtureData("invalid/params-chat-send-text-over-length.json")).text.count == 32769)
        // history.search query maxLength / apps maxItems live TS-side.
        #expect(try JSONDecoder().decode(HistorySearchParams.self, from: fixtureData("invalid/params-history-search-query-over-length.json")).query?.count == 513)
        #expect(try JSONDecoder().decode(HistorySearchParams.self, from: fixtureData("invalid/params-history-search-apps-over-max.json")).apps?.count == 33)
        // episode.get id ULID pattern is TS-side.
        #expect(try JSONDecoder().decode(EpisodeGetParams.self, from: fixtureData("invalid/params-episode-get-id-not-ulid.json")).id == "not-a-ulid")
        // memories.list status enum rides as String.
        #expect(try JSONDecoder().decode(MemoriesListParams.self, from: fixtureData("invalid/params-memories-list-status-unknown.json")).status == "archived")
        // limit min/max clamps live TS-side.
        #expect(try JSONDecoder().decode(SegmentsListParams.self, from: fixtureData("invalid/params-segments-list-limit-over-max.json")).limit == 201)
        #expect(try JSONDecoder().decode(TimelineListParams.self, from: fixtureData("invalid/params-timeline-list-limit-over-max.json")).limit == 51)
        #expect(try JSONDecoder().decode(TimelineListParams.self, from: fixtureData("invalid/params-timeline-list-limit-under-min.json")).limit == 0)
        // delete.range from >2^53-1 fits Int64; exactly-one-of is a client
        // validation guard, not part of decoding.
        #expect(try JSONDecoder().decode(DeleteRangeParams.self, from: fixtureData("invalid/params-delete-range-from-overflow.json")).from == 9_007_199_254_740_992)
        // settings.set / status.get params have no Swift mirror — params ride
        // as opaque payloads, so additionalProperties/required keys are TS-side.
        #expect(try JSONDecoder().decode([String: JSONValue].self, from: fixtureData("invalid/params-settings-set-missing-patch.json")).isEmpty)
        #expect(try JSONDecoder().decode([String: JSONValue].self, from: fixtureData("invalid/params-settings-set-patch-unknown-key.json"))["patch"] != nil)
        #expect(try JSONDecoder().decode([String: JSONValue].self, from: fixtureData("invalid/params-status-get-additional-property.json"))["verbose"] == .bool(true))
    }

    /// Fixtures Swift also rejects: enum violations, structural gaps, and
    /// non-integral sentAt (fractional ms cannot decode into Int64).
    @Test("round-7 invalid fixtures rejected by Swift mirrors")
    func round7InvalidFixturesThrow() {
        // workflow.action enum pins confirm|reject ("forget" belongs to memory.action).
        #expect { _ = try JSONDecoder().decode(WorkflowActionParams.self, from: fixtureData("invalid/params-workflow-action-forget.json")) } throws: { _ in true }
        // memory.action enum pins confirm|reject|forget ("archive" unknown).
        #expect { _ = try JSONDecoder().decode(MemoryActionParams.self, from: fixtureData("invalid/params-memory-action-action-unknown.json")) } throws: { _ in true }
        // delete.range preset union rejects unknown wire values.
        #expect { _ = try JSONDecoder().decode(DeleteRangeParams.self, from: fixtureData("invalid/params-delete-range-preset-unknown.json")) } throws: { _ in true }
        // RequestFrame.op is required; an envelope without it fails structurally.
        #expect { _ = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/request-missing-op.json")) } throws: { _ in true }
        #expect { _ = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("invalid/envelope-sentAt-fractional.json")) } throws: { _ in true }
    }

    @Test("round-7 goldens decode into Swift mirrors")
    func round7GoldensDecode() throws {
        // Shape/content layering: protocolVersion is unpinned on the wire;
        // v2 frames decode through the same envelope mirror.
        let request = try JSONDecoder().decode(RequestFrame.self, from: fixtureData("request.protocol-version-unpinned.json"))
        #expect(request.protocolVersion == 2)
        #expect(request.op == "status.get")
    }

    @Test("every fixture file is covered by a decode expectation")
    func noOrphanFixtures() {
        let enumerator = FileManager.default.enumerator(atPath: Self.fixturesRoot.path)
        let files = (enumerator?.allObjects as? [String] ?? []).filter { $0.hasSuffix(".json") }.sorted()
        let expected = [
            "activity-event.allow-content.json",
            "activity-event.basic.json",
            "activity-event.excluded-app-tombstone.json",
            "activity-event.oversize-redacted.json",
            "activity-event.secret-pattern-redacted.json",
            "activity-event.secure-redacted.json",
            "activity-event.sensitive-redacted.json",
            "activity-event.typing-redacted.json",
            "episode.with-steps.json",
            "error.protocol-error.json",
            "event-batch-ack.json",
            "event-batch.json",
            "event.chat-chunk.json",
            "event.chat-done.json",
            "event.chat-error.json",
            "event.queue-update.json",
            "event.recording-state.json",
            "handshake.client.json",
            "handshake.server.json",
            "invalid/envelope-sentAt-fractional.json",
            "invalid/envelope-sentAt-negative.json",
            "invalid/envelope-sentAt-overflow.json",
            "invalid/event-bad-action.json",
            "invalid/event-batch-bad-batchId.json",
            "invalid/event-batch-events-over-max.json",
            "invalid/event-queue-update-pendingJobs-overflow.json",
            "invalid/event-recording-state-state-unknown.json",
            "invalid/frame-unknown-type.json",
            "invalid/hello-bad-messageId.json",
            "invalid/params-chat-send-text-empty.json",
            "invalid/params-chat-send-text-over-length.json",
            "invalid/params-delete-range-from-overflow.json",
            "invalid/params-delete-range-preset-unknown.json",
            "invalid/params-episode-get-id-not-ulid.json",
            "invalid/params-history-search-apps-over-max.json",
            "invalid/params-history-search-query-over-length.json",
            "invalid/params-memories-list-status-unknown.json",
            "invalid/params-memory-action-action-unknown.json",
            "invalid/params-segments-list-limit-over-max.json",
            "invalid/params-settings-set-missing-patch.json",
            "invalid/params-settings-set-patch-unknown-key.json",
            "invalid/params-status-get-additional-property.json",
            "invalid/params-timeline-list-limit-over-max.json",
            "invalid/params-timeline-list-limit-under-min.json",
            "invalid/params-workflow-action-forget.json",
            "invalid/request-bad-requestId.json",
            "invalid/request-missing-op.json",
            "invalid/response-err-unknown-code.json",
            "memory-candidate.json",
            "request.chat-cancel.json",
            "request.chat-send.json",
            "request.delete-range.json",
            "request.diagnostics-get.json",
            "request.episode-get.json",
            "request.history-search.json",
            "request.jobs-retry-dead.json",
            "request.memories-list.json",
            "request.memory-action.json",
            "request.protocol-version-unpinned.json",
            "request.segments-list.json",
            "request.status-get.json",
            "request.timeline-list.json",
            "request.workflow-action.json",
            "request.workflows-list.json",
            "response.chat-send.json",
            "response.delete-range.json",
            "response.diagnostics-get.json",
            "response.episode-get.json",
            "response.err.json",
            "response.history-search.json",
            "response.jobs-retry-dead.json",
            "response.memories-list.json",
            "response.memory-action.json",
            "response.segments-list.json",
            "response.status-get.json",
            "response.timeline-list.json",
            "response.workflow-action.json",
            "response.workflows-list.json",
            "workflow.candidate.json",
        ]
        #expect(files == expected)
    }
}
