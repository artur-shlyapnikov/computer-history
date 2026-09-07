import Foundation

/// Wire protocol version; must match PROTOCOL_VERSION in packages/protocol/src/ipc.ts.
let protocolVersion = 1

// MARK: - Wire enums (must stay in lockstep with packages/protocol TypeBox schemas)

enum EventSource: String, Codable, Sendable, CaseIterable {
    case workspace
    case accessibility
    case input
}

enum EventAction: String, Codable, Sendable, CaseIterable {
    case appFocus = "app_focus"
    case windowChange = "window_change"
    case focusChange = "focus_change"
    case click
    case textChange = "text_change"
    case typingActivity = "typing_activity"
    case shortcut
    case scroll
}

enum ContentPolicy: String, Codable, Sendable, CaseIterable {
    case allow
    case metadataOnly = "metadata_only"
    case redactedSecureField = "redacted_secure_field"
    case redactedSensitiveLabel = "redacted_sensitive_target"
    case redactedSecretPattern = "redacted_secret_pattern"
    case redactedOversize = "redacted_oversize"
    case excludedApp = "excluded_app"
}

// MARK: - ActivityEvent (spec §3.5 wire camelCase)

struct AppInfo: Codable, Equatable, Sendable {
    var bundleId: String
    var name: String?
    var pid: Int64?
}

struct WindowInfo: Codable, Equatable, Sendable {
    var title: String?
}

struct TargetInfo: Codable, Equatable, Sendable {
    var role: String?
    var subrole: String?
    var label: String?
    var identifier: String?
}

struct ActivityEvent: Codable, Equatable, Sendable {
    var id: String
    /// Unix epoch milliseconds.
    var observedAt: Int64
    var monotonicNs: Int64?
    var source: EventSource
    var app: AppInfo
    var window: WindowInfo?
    var action: EventAction
    var target: TargetInfo?
    var content: String?
    var contentPolicy: ContentPolicy
    var captureSessionId: String?
}

// MARK: - Handshake

struct ClientHello: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    /// Unix epoch milliseconds.
    var sentAt: Int64
    var appVersion: String

    static func make(appVersion: String) -> ClientHello {
        ClientHello(
            protocolVersion: RecorderApp.protocolVersion,
            messageId: Ulid.shared.next(),
            type: "client_hello",
            sentAt: Int64(Date().timeIntervalSince1970 * 1000),
            appVersion: appVersion
        )
    }
}

struct ServerHello: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var daemonVersion: String
    var databaseSchemaVersion: Int
}

// MARK: - Event batching

struct EventBatch: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var batchId: String
    var events: [ActivityEvent]
}

struct EventBatchAck: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var batchId: String
    var accepted: Int
    var duplicates: Int
    var rejected: Int
}

// MARK: - Requests / responses

/// A JSON value that survives decoding of arbitrary params/results payloads.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

extension JSONValue {
    /// Wraps any Encodable wire model (e.g. EventBatch) as a params payload.
    init(encoding value: some Encodable) throws {
        let data = try JSONEncoder().encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }
}

struct RequestFrame: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var op: String
    var requestId: String
    var params: JSONValue?

    static func make(op: String, requestId: String, params: JSONValue?) -> RequestFrame {
        RequestFrame(
            protocolVersion: RecorderApp.protocolVersion,
            messageId: Ulid.shared.next(),
            type: "request",
            sentAt: Int64(Date().timeIntervalSince1970 * 1000),
            op: op,
            requestId: requestId,
            params: params
        )
    }
}

struct ServerErrorBody: Codable, Equatable, Sendable {
    var code: String
    var message: String
}

/// Response envelope; `result` is kept as a raw JSON value so one struct serves
/// every op while typed mirrors decode specific results separately.
struct ResponseFrame: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var requestId: String
    var ok: Bool
    var result: JSONValue?
    var error: ServerErrorBody?

    func decodedResult<R: Codable & Sendable>(as _: R.Type, decoder: JSONDecoder = JSONDecoder()) throws -> R? {
        guard let result else { return nil }
        let data = try JSONEncoder().encode(result)
        return try decoder.decode(R.self, from: data)
    }
}

/// Protocol-level rejection frame (`error.protocol_version`, `error.bad_frame`).
struct ProtocolErrorFrame: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var messageId: String
    var type: String
    var sentAt: Int64
    var error: ServerErrorBody
}

// MARK: - status.get mirror subset

struct StatusResult: Codable, Equatable, Sendable {
    struct Daemon: Codable, Equatable, Sendable {
        var version: String
        var schemaVersion: Int
        var uptimeMs: Int64
    }

    struct Recording: Codable, Equatable, Sendable {
        var paused: Bool
        var reason: String?
    }

    struct Queue: Codable, Equatable, Sendable {
        var pending: Int
        var retrying: Int
        var dead: Int
    }

    struct DbCounts: Codable, Equatable, Sendable {
        var rawEvents: Int
        var segments: Int
        var steps: Int
        var episodes: Int
        var memories: Int
        var workflows: Int
        var pageCountBytes: Int
    }

    var daemon: Daemon
    var recording: Recording
    var accessibilityRequired: Bool
    var queue: Queue
    var db: DbCounts
    var diskFreeBytes: Int
}

// MARK: - Domain DTO subset (episodes / memories / workflows)

struct EpisodeDto: Codable, Equatable, Sendable {
    var id: String
    var startedAtMs: Int64
    var endedAtMs: Int64
    var title: String
    var summary: String
    var intent: String?
    var outcome: String?
    var apps: [String]
    var entities: [String]
    var summaryModel: String?
    var summaryPromptVersion: String?
    var createdAtMs: Int64
    var updatedAtMs: Int64
}

struct SemanticStepDto: Codable, Equatable, Sendable {
    var id: String
    var segmentId: String
    var ordinal: Int
    var startedAtMs: Int64
    var endedAtMs: Int64
    var action: String
    var appBundleId: String
    var appName: String?
    var target: String?
    var text: String?
    /// Migration 004 `semantic_steps.target_role TEXT NULL` on the wire
    /// (D7b additive change): null/absent = historical pre-004 step.
    var targetRole: String?
}

struct EpisodeGetResult: Codable, Equatable, Sendable {
    var episode: EpisodeDto
    var steps: [SemanticStepDto]
}

/// `{id}` (`additionalProperties: false`).
struct EpisodeGetParams: Codable, Equatable, Sendable {
    var id: String
}

// MARK: - segments.list mirror (contracts §Additional pinned decisions)

/// Pinned server-side bounds for `segments.list` (default 50, max 200).
enum SegmentsListDefaults {
    static let defaultLimit = 50
    static let maxLimit = 200
}

/// `{from?, to?, limit?}`; all fields optional (`additionalProperties: false`).
struct SegmentsListParams: Codable, Equatable, Sendable {
    var from: Int64?
    var to: Int64?
    var limit: Int?
}

/// Segment lifecycle state (activity_segments.state).
enum SegmentState: String, Codable, Sendable, CaseIterable {
    case open
    case processing
    case finalized
    case failed
}

/// One activity segment plus its ordered steps and denormalized stepCount.
struct SegmentSummaryDto: Codable, Equatable, Sendable {
    var id: String
    var startedAtMs: Int64
    /// Null while the segment is still open.
    var endedAtMs: Int64?
    var state: SegmentState
    var stepCount: Int
    /// Ordered by `ordinal` ascending (daemon contract).
    var steps: [SemanticStepDto]
}

/// `segments.list` result; newest first (started_at_ms DESC).
struct SegmentsListResult: Codable, Equatable, Sendable {
    var segments: [SegmentSummaryDto]
}

// MARK: - timeline.list mirror (contracts §Protocol v1; M3 episodes)

/// Pinned server-side bounds for `timeline.list` (default 50, max 50).
enum TimelineListDefaults {
    static let defaultLimit = 50
    static let maxLimit = 50
}

/// `{from?, to?, limit?}`; all fields optional (`additionalProperties: false`).
struct TimelineListParams: Codable, Equatable, Sendable {
    var from: Int64?
    var to: Int64?
    var limit: Int?
}

/// One timeline row item: episode plus denormalized display fields
/// (domain.ts `EpisodeSummaryDto`; contracts status/timeline ops).
struct EpisodeSummaryDto: Codable, Equatable, Sendable {
    var id: String
    var startedAtMs: Int64
    var endedAtMs: Int64
    var title: String
    var appNames: [String]
    var stepCount: Int
    /// Jobs still pending/retrying against this episode (drives the badge).
    var pendingJobs: Int
}

/// `timeline.list` result; newest first (started_at_ms DESC).
struct TimelineListResult: Codable, Equatable, Sendable {
    var episodes: [EpisodeSummaryDto]
}

// MARK: - Server-pushed events (contracts §Server-pushed events)

/// `queue_update` event payload: jobs waiting for processing
/// (pending + retrying folded server-side into one count; dead excluded).
struct QueueUpdatePayload: Codable, Equatable, Sendable {
    var pendingJobs: Int
}

/// Full wire shape of a `queue_update` server event frame.
struct QueueUpdateEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: QueueUpdatePayload
}

/// `recording_state` event payload: capture pause/resume broadcasts
/// (disk-pressure pause, hysteresis resume; spec §3.25).
struct RecordingStatePayload: Codable, Equatable, Sendable {
    var state: String
    var reason: String?
}

/// Full wire shape of a `recording_state` server event frame.
struct RecordingStateEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: RecordingStatePayload
}

enum MemoryKind: String, Codable, Sendable {
    case fact
    case preference
    case procedure
}

enum MemoryStatus: String, Codable, Sendable {
    case candidate
    case active
    case rejected
    case superseded
}

struct MemoryCandidateDto: Codable, Equatable, Sendable {
    var id: String
    var kind: MemoryKind
    var canonicalKey: String
    var text: String
    var confidence: Double
    var status: MemoryStatus
    var firstSeenAtMs: Int64
    var lastSeenAtMs: Int64
    var evidenceCount: Int
    var createdAtMs: Int64
    var updatedAtMs: Int64
}

enum WorkflowStatusMirror: String, Codable, Sendable {
    case candidate
    case confirmed
    case rejected
}

struct WorkflowTemplate: Codable, Equatable, Sendable {
    var name: String?
    var purpose: String?
    var preconditions: [String]?
    var stableSteps: [String]?
    var variableInputs: [String]?
    var expectedOutcome: String?
}

struct WorkflowDto: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var purpose: String?
    var status: WorkflowStatusMirror
    var template: WorkflowTemplate
    var occurrenceCount: Int
    var medianSimilarity: Double
    var firstSeenAtMs: Int64
    var lastSeenAtMs: Int64
    var createdAtMs: Int64
    var updatedAtMs: Int64
}

// MARK: - history.search mirror (spec §3.18; contracts §Protocol v1)

/// Search scope for `history.search`.
enum HistorySearchScope: String, Codable, Sendable, CaseIterable {
    case episodes
    case steps
    case both
}

/// `{query?, from?, to?, apps?, scope?, limit?}`; all fields optional
/// (`additionalProperties: false`). Server defaults: scope = episodes,
/// limit = 10; limit clamped to max 50.
struct HistorySearchParams: Codable, Equatable, Sendable {
    var query: String?
    var from: Int64?
    var to: Int64?
    var apps: [String]?
    var scope: HistorySearchScope?
    var limit: Int?
}

/// Provenance block carried by every hit; step hits add `stepId` on top of
/// the owning-episode fields (spec §3.18).
struct HistoryHitSource: Codable, Equatable, Sendable {
    var episodeId: String?
    var stepId: String?
    var startedAtMs: Int64
    var endedAtMs: Int64
    var appNames: [String]
    var snippet: String
}

struct HistoryHit: Codable, Equatable, Sendable {
    var source: HistoryHitSource
    var score: Double
}

struct HistorySearchResult: Codable, Equatable, Sendable {
    var hits: [HistoryHit]
}

// MARK: - chat.send / chat.cancel mirrors (spec §3.19; contracts §Protocol v1)

/// `{sessionId?, text}` (`additionalProperties: false`; text minLength 1).
/// Daemon-side validation pins `sessionId` to a ULID (26 chars): omit it to
/// start a new conversation and reuse the id the daemon allocated.
struct ChatSendParams: Codable, Equatable, Sendable {
    /// Omit to start a new conversation; the daemon allocates a session id.
    var sessionId: String?
    var text: String
}

struct ChatSendResult: Codable, Equatable, Sendable {
    /// Correlates the follow-up chat_* server events for this turn.
    var requestId: String
    var sessionId: String
}

/// `{requestId}` (`additionalProperties: false`).
struct ChatCancelParams: Codable, Equatable, Sendable {
    var requestId: String
}

struct ChatCancelResult: Codable, Equatable, Sendable {
    /// `false` when the run had already finished before the cancel landed.
    var cancelled: Bool
}

// MARK: - chat_* server-event payloads (contracts §Server-pushed events)

struct ChatChunkPayload: Codable, Equatable, Sendable {
    var requestId: String
    var delta: String
}

/// `{requestId, sessionId}` — both daemon-minted ULIDs (26 chars); the
/// session id is persisted and re-sent as chat.send's sessionId.
struct ChatDonePayload: Codable, Equatable, Sendable {
    var requestId: String
    var sessionId: String
}

/// `code`: `llm_unavailable` | `aborted` | `internal` | `busy` (contracts chat.send).
struct ChatErrorPayload: Codable, Equatable, Sendable {
    var requestId: String
    var code: String
    var message: String
}

/// Full wire shape of a `chat_chunk` server event frame.
struct ChatChunkEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: ChatChunkPayload
}

/// Full wire shape of a `chat_done` server event frame.
struct ChatDoneEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: ChatDonePayload
}

/// Full wire shape of a `chat_error` server event frame.
struct ChatErrorEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: ChatErrorPayload
}

// MARK: - memories.list / memory.action mirrors (spec §3.16–3.17; contracts §Protocol v1)

/// `{status?, limit?}`; all fields optional and OMITTED when nil
/// (`additionalProperties: false`). Wire `status` is one of
/// confirmed | suggestions | rejected | superseded (daemon group names).
/// `limit` bounds are enforced TS-side (ipc.ts: integer 1...200).
struct MemoriesListParams: Codable, Equatable, Sendable {
    var status: String?
    var limit: Int?
}

/// Display-group name carried by each `memories.list` group. Daemon maps
/// active→confirmed, candidate→suggestions, rejected→rejected; `superseded`
/// appears only when requested explicitly via params.status.
enum MemoriesGroupStatus: String, Codable, Sendable, CaseIterable {
    case confirmed
    case suggestions
    case rejected
    case superseded
}

/// One status bucket of the grouped `memories.list` result.
struct MemoriesListGroup: Codable, Equatable, Sendable {
    var status: MemoriesGroupStatus
    var memories: [MemoryCandidateDto]
}

struct MemoriesListResult: Codable, Equatable, Sendable {
    var groups: [MemoriesListGroup]
}

enum MemoryActionKind: String, Codable, Sendable, CaseIterable {
    case confirm
    case reject
    case forget
}

/// `{id, action}` (`additionalProperties: false`); `id` is a daemon-minted ULID.
struct MemoryActionParams: Codable, Equatable, Sendable {
    var id: String
    var action: MemoryActionKind
}

/// confirm/reject return the updated row; forget hard-deletes ⇒ `updated:nil`.
struct MemoryActionResult: Codable, Equatable, Sendable {
    var updated: MemoryCandidateDto?
}

// MARK: - workflows.list / workflow.action mirrors (spec §3.20; contracts §Protocol v1)

/// `{status?}` (`additionalProperties: false`). Wire value is one of
/// candidate | confirmed | rejected.
struct WorkflowsListParams: Codable, Equatable, Sendable {
    var status: String?
}

/// One episode occurrence of a workflow, as embedded in each
/// `workflows.list` item (M6 wire contract: `episodeId`, `startedAtMs`,
/// `similarity`; ordered newest-first by `startedAtMs`). Note this is the
/// list-projection shape — domain.ts `WorkflowOccurrenceDto` additionally
/// carries `workflowId`, which is implicit in the embedding here.
struct WorkflowOccurrenceDto: Codable, Equatable, Sendable {
    var episodeId: String
    var startedAtMs: Int64
    var similarity: Double
}

/// One `workflows.list` row: the full WorkflowDto fields plus its required
/// `occurrences` array (WorkflowListItemSchema extends WorkflowDtoSchema).
struct WorkflowListItem: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var purpose: String?
    var status: WorkflowStatusMirror
    var template: WorkflowTemplate
    var occurrenceCount: Int
    var medianSimilarity: Double
    var firstSeenAtMs: Int64
    var lastSeenAtMs: Int64
    var createdAtMs: Int64
    var updatedAtMs: Int64
    var occurrences: [WorkflowOccurrenceDto]
}

/// `workflows.list` result; newest workflow first (daemon ordering).
struct WorkflowsListResult: Codable, Equatable, Sendable {
    var workflows: [WorkflowListItem]
}

enum WorkflowActionKind: String, Codable, Sendable, CaseIterable {
    case confirm
    case reject
}

/// `{id, action}` (`additionalProperties: false`); `id` is a daemon-minted ULID.
struct WorkflowActionParams: Codable, Equatable, Sendable {
    var id: String
    var action: WorkflowActionKind
}

/// confirm/reject return the updated plain WorkflowDto (no occurrences);
/// a null `updated` means the row vanished concurrently (delete cascade).
struct WorkflowActionResult: Codable, Equatable, Sendable {
    var updated: WorkflowDto?
}

/// `workflows_changed` server-event payload: an empty object (contracts pin
/// the kind with no fields); the event itself signals a workflows re-sync.
struct WorkflowsChangedPayload: Codable, Equatable, Sendable {}

/// Full wire shape of a `workflows_changed` server event frame.
struct WorkflowsChangedEvent: Codable, Equatable, Sendable {
    var type: String
    var kind: String
    var payload: WorkflowsChangedPayload
}

// MARK: - delete.range mirror (spec §3.23; shape frozen by D7b in

// packages/protocol/src/ipc.ts DeleteRangeParams/ResultSchema — hub-confirmed
// 2026-08-23: params additionalProperties:false, exactly one of {from/to} or
// preset is required server-side; daemon rejects both/neither invalid_params).

/// Preset ranges for `delete.range` (`preset` wire values pinned by the
/// protocol schema union).
enum DeleteRangePreset: String, Codable, Sendable, CaseIterable {
    case last10Minutes = "last_10_minutes"
    case lastHour = "last_hour"
    case today
    case all
}

/// `{from?, to?, preset?}`; all fields optional and OMITTED when nil
/// (synthesized Codable uses encodeIfPresent, satisfying
/// `additionalProperties: false`).
struct DeleteRangeParams: Codable, Equatable, Sendable {
    var from: Int64?
    var to: Int64?
    var preset: DeleteRangePreset?
}

/// Per-table deletion counts of the single delete transaction.
struct DeleteRangeDeletedCounts: Codable, Equatable, Sendable {
    var rawEvents: Int
    var steps: Int
    var episodes: Int
    var memories: Int
    var workflows: Int
}

struct DeleteRangeResult: Codable, Equatable, Sendable {
    var deleted: DeleteRangeDeletedCounts
}

/// Client-side guard mirroring the server's exactly-one-of rule before a
/// frame ever leaves the recorder.
enum DeleteRangeValidationError: Error, Equatable {
    case mixedPresetAndRange
    case emptySelection
}

extension DeleteRangeParams {
    /// Validates the pinned "exactly one of {from/to} or preset" rule.
    func validate() throws {
        if preset != nil, from != nil || to != nil {
            throw DeleteRangeValidationError.mixedPresetAndRange
        }
        if preset == nil, from == nil, to == nil {
            throw DeleteRangeValidationError.emptySelection
        }
    }
}

// MARK: - settings.get mirror (read-only display; editing deferred post-V1)

/// DaemonSettingsSchema mirror (chatModel/backgroundModel/rawRetentionHours/
/// semanticRetentionDays). The recorder renders these read-only this wave.
struct DaemonSettingsDto: Codable, Equatable, Sendable {
    var chatModel: String
    var backgroundModel: String
    var rawRetentionHours: Int
    var semanticRetentionDays: Int
}

struct SettingsGetResult: Codable, Equatable, Sendable {
    var settings: DaemonSettingsDto
}

// MARK: - jobs.retryDead mirror (M7 additive op; brief D7 item 5)

/// `{}` (`additionalProperties: false`) — manual re-drive of dead jobs.
struct JobsRetryDeadParams: Codable, Equatable, Sendable {}

/// Wire field is `retried` (ipc.ts JobsRetryDeadResultSchema; D7b fixture
/// response.jobs-retry-dead.json) — the earlier hub message said "requeued"
/// but the landed schema pins `retried`.
struct JobsRetryDeadResult: Codable, Equatable, Sendable {
    var retried: Int
}

// MARK: - diagnostics.get mirror (contracts §Protocol v1)

/// One recorded daemon error (newest-first in `lastErrors`).
struct DiagnosticsErrorEntry: Codable, Equatable, Sendable {
    var at: Int64
    var scope: String
    var code: String
    var message: String
}

struct DiagnosticsGetResult: Codable, Equatable, Sendable {
    var integrityOk: Bool
    var lastErrors: [DiagnosticsErrorEntry]
}
