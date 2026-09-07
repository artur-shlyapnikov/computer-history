import { Type, type Static } from '@sinclair/typebox';
import { ActivityEventSchema } from './events.js';
import { DaemonSafeInt, EpochMs } from './bounds.js';

const ulidPattern = '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$';
const Ulid = Type.String({ pattern: ulidPattern });

/**
 * Every frame payload carries the envelope fields plus a `type` discriminator.
 * Contracts §Protocol v1.
 */
export const EnvelopeFields = {
  protocolVersion: Type.Integer({ description: 'IPC protocol major version; currently 1' }),
  messageId: Ulid,
  type: Type.String(),
  sentAt: EpochMs,
};

// ---------------------------------------------------------------------------
// Handshake (must be the first frames in both directions)
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

export const ClientHelloSchema = Type.Object(
  {
    ...EnvelopeFields,
    type: Type.Literal('client_hello'),
    protocolVersion: Type.Integer(),
    appVersion: Type.String(),
  },
  { $id: 'ClientHello' },
);
export type ClientHello = Static<typeof ClientHelloSchema>;

export const ServerHelloSchema = Type.Object(
  {
    ...EnvelopeFields,
    type: Type.Literal('server_hello'),
    protocolVersion: Type.Integer(),
    daemonVersion: Type.String(),
    databaseSchemaVersion: Type.Integer(),
  },
  { $id: 'ServerHello' },
);
export type ServerHello = Static<typeof ServerHelloSchema>;

// ---------------------------------------------------------------------------
// Event batching (recorder → daemon ingest, M1; wire shape pinned now)
// ---------------------------------------------------------------------------

export const EventBatchSchema = Type.Object(
  {
    ...EnvelopeFields,
    type: Type.Literal('event_batch'),
    batchId: Ulid,
    events: Type.Array(ActivityEventSchema, { maxItems: 1000 }),
  },
  { $id: 'EventBatch' },
);
export type EventBatch = Static<typeof EventBatchSchema>;

export const EventBatchAckSchema = Type.Object(
  {
    ...EnvelopeFields,
    type: Type.Literal('event_batch_ack'),
    batchId: Ulid,
    accepted: Type.Integer(),
    duplicates: Type.Integer(),
    rejected: Type.Integer(),
  },
  { $id: 'EventBatchAck' },
);
export type EventBatchAck = Static<typeof EventBatchAckSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ErrorCodes = [
  'error.protocol_version',
  'error.bad_frame',
  'error.unknown_op',
  'error.invalid_params',
  'error.not_implemented',
  'error.not_found',
  'error.internal',
  /** M7 additive: events.batch refused while recording is paused (spec §3.25). */
  'error.disk_pressure',
] as const;
export const ErrorCode = Type.Union(ErrorCodes.map((c) => Type.Literal(c)));
export type ErrorCode = (typeof ErrorCodes)[number];

export const ServerErrorSchema = Type.Object({
  code: ErrorCode,
  message: Type.String(),
});
export type ServerError = Static<typeof ServerErrorSchema>;

// ---------------------------------------------------------------------------
// Domain DTOs referenced by op results (defined in domain.ts, re-used here)
// ---------------------------------------------------------------------------

import {
  EpisodeDtoSchema,
  EpisodeSummaryDtoSchema,
  MemoryCandidateDtoSchema,
  SemanticStepDtoSchema,
  WorkflowStatus,
  WorkflowDtoSchema,
  WorkflowListItemSchema,
} from './domain.js';
export const ProtocolErrorFrameSchema = Type.Object(
  {
    ...EnvelopeFields,
    type: Type.Literal('error'),
    error: ServerErrorSchema,
  },
  { $id: 'ProtocolErrorFrame' },
);
export type ProtocolErrorFrame = Static<typeof ProtocolErrorFrameSchema>;

// ---------------------------------------------------------------------------
// Request/response ops (contracts §Protocol v1)
// ---------------------------------------------------------------------------

export const RequestFrameSchema = Type.Object({
  ...EnvelopeFields,
  type: Type.Literal('request'),
  op: Type.String(),
  requestId: Ulid,
  params: Type.Optional(Type.Unknown()),
});
export type RequestFrame = Static<typeof RequestFrameSchema>;

export const ResponseOkFrameSchema = Type.Object({
  ...EnvelopeFields,
  type: Type.Literal('response'),
  requestId: Ulid,
  ok: Type.Literal(true),
  result: Type.Unknown(),
});
export type ResponseOkFrame = Static<typeof ResponseOkFrameSchema>;

export const ResponseErrFrameSchema = Type.Object({
  ...EnvelopeFields,
  type: Type.Literal('response'),
  requestId: Ulid,
  ok: Type.Literal(false),
  error: ServerErrorSchema,
});
export type ResponseErrFrame = Static<typeof ResponseErrFrameSchema>;

export const ResponseFrameSchema = Type.Union([ResponseOkFrameSchema, ResponseErrFrameSchema]);
export type ResponseFrame = Static<typeof ResponseFrameSchema>;

// --- op params / results ---------------------------------------------------

export const StatusGetParamsSchema = Type.Object({}, { additionalProperties: false });
export type StatusGetParams = Static<typeof StatusGetParamsSchema>;

export const StatusResultSchema = Type.Object({
  daemon: Type.Object({
    version: Type.String(),
    schemaVersion: Type.Integer(),
    uptimeMs: DaemonSafeInt,
  }),
  recording: Type.Object({
    paused: Type.Boolean(),
    reason: Type.Optional(Type.String()),
  }),
  accessibilityRequired: Type.Literal(false),
  queue: Type.Object({
    pending: DaemonSafeInt,
    retrying: DaemonSafeInt,
    dead: DaemonSafeInt,
  }),
  db: Type.Object({
    rawEvents: DaemonSafeInt,
    segments: DaemonSafeInt,
    steps: DaemonSafeInt,
    episodes: DaemonSafeInt,
    memories: DaemonSafeInt,
    workflows: DaemonSafeInt,
    pageCountBytes: DaemonSafeInt,
  }),
  diskFreeBytes: DaemonSafeInt,
});
export type StatusResult = Static<typeof StatusResultSchema>;

export const TimelineListParamsSchema = Type.Object(
  {
    from: Type.Optional(EpochMs),
    to: Type.Optional(EpochMs),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
export type TimelineListParams = Static<typeof TimelineListParamsSchema>;

export const TimelineListResultSchema = Type.Object({
  episodes: Type.Array(EpisodeSummaryDtoSchema),
});
export type TimelineListResult = Static<typeof TimelineListResultSchema>;

/**
 * segments.list: activity segments with ordered semantic steps (contracts
 * §Additional pinned decisions). Additive protocol-v1 op serving the Timeline
 * UI before episodes exist (M3 wires summarization on top).
 */
export const SegmentsListParamsSchema = Type.Object(
  {
    from: Type.Optional(EpochMs),
    to: Type.Optional(EpochMs),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
export type SegmentsListParams = Static<typeof SegmentsListParamsSchema>;

/** One activity segment plus its ordered steps and denormalized stepCount. */
export const SegmentSummaryDtoSchema = Type.Object(
  {
    id: Ulid,
    startedAtMs: EpochMs,
    /** Null while the segment is still open. */
    endedAtMs: Type.Union([EpochMs, Type.Null()]),
    state: Type.Union([
      Type.Literal('open'),
      Type.Literal('processing'),
      Type.Literal('finalized'),
      Type.Literal('failed'),
    ]),
    stepCount: Type.Integer(),
    steps: Type.Array(SemanticStepDtoSchema),
  },
  { $id: 'SegmentSummaryDto' },
);
export type SegmentSummaryDto = Static<typeof SegmentSummaryDtoSchema>;

export const SegmentsListResultSchema = Type.Object({
  /** Newest first (started_at_ms DESC). */
  segments: Type.Array(SegmentSummaryDtoSchema),
});
export type SegmentsListResult = Static<typeof SegmentsListResultSchema>;

export const EpisodeGetParamsSchema = Type.Object(
  { id: Ulid },
  { additionalProperties: false },
);
export type EpisodeGetParams = Static<typeof EpisodeGetParamsSchema>;

export const EpisodeGetResultSchema = Type.Object({
  episode: EpisodeDtoSchema,
  steps: Type.Array(SemanticStepDtoSchema),
});
export type EpisodeGetResult = Static<typeof EpisodeGetResultSchema>;

export const HistorySearchScope = Type.Union([
  Type.Literal('episodes'),
  Type.Literal('steps'),
  Type.Literal('both'),
]);

export const HistorySearchParamsSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 512 })),
    from: Type.Optional(EpochMs),
    to: Type.Optional(EpochMs),
    // Bounded so a huge app list surfaces as invalid_params, not a SQLite
    // 'too many SQL variables' internal error (S3).
    apps: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
    scope: Type.Optional(HistorySearchScope),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
export type HistorySearchParams = Static<typeof HistorySearchParamsSchema>;

export const HistoryHitSchema = Type.Object({
  source: Type.Object({
    episodeId: Type.Optional(Ulid),
    stepId: Type.Optional(Ulid),
    startedAtMs: EpochMs,
    endedAtMs: EpochMs,
    appNames: Type.Array(Type.String()),
    snippet: Type.String(),
  }),
  score: Type.Number(),
});
export type HistoryHit = Static<typeof HistoryHitSchema>;

export const HistorySearchResultSchema = Type.Object({
  hits: Type.Array(HistoryHitSchema),
});
export type HistorySearchResult = Static<typeof HistorySearchResultSchema>;

export const MemoriesListStatus = Type.Union([
  Type.Literal('confirmed'),
  Type.Literal('suggestions'),
  Type.Literal('rejected'),
  Type.Literal('superseded'),
]);
export type MemoriesListStatus = Static<typeof MemoriesListStatus>;

export const MemoriesListParamsSchema = Type.Object(
  {
    status: Type.Optional(MemoriesListStatus),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
export type MemoriesListParams = Static<typeof MemoriesListParamsSchema>;

export const MemoriesListResultSchema = Type.Object({
  groups: Type.Array(
    Type.Object({
      // Closed union mirroring the Swift enum: an unknown status must be
      // rejected at the wire boundary instead of wiping the app's list (W1).
      status: MemoriesListStatus,
      memories: Type.Array(MemoryCandidateDtoSchema),
    }),
  ),
});
export type MemoriesListResult = Static<typeof MemoriesListResultSchema>;

export const MemoryActionParamsSchema = Type.Object(
  {
    // Memory ids are daemon-minted ULIDs; pinning the shape bounds the
    // not_found error echo instead of forwarding arbitrary client strings.
    id: Ulid,
    action: Type.Union([Type.Literal('confirm'), Type.Literal('reject'), Type.Literal('forget')]),
  },
  { additionalProperties: false },
);
export type MemoryActionParams = Static<typeof MemoryActionParamsSchema>;

export const MemoryActionResultSchema = Type.Object({
  updated: Type.Union([MemoryCandidateDtoSchema, Type.Null()]),
});
export type MemoryActionResult = Static<typeof MemoryActionResultSchema>;

export const WorkflowsListParamsSchema = Type.Object(
  { status: Type.Optional(WorkflowStatus) },
  { additionalProperties: false },
);
export type WorkflowsListParams = Static<typeof WorkflowsListParamsSchema>;

export const WorkflowsListResultSchema = Type.Object({
  workflows: Type.Array(WorkflowListItemSchema),
});
export type WorkflowsListResult = Static<typeof WorkflowsListResultSchema>;

export const WorkflowActionParamsSchema = Type.Object(
  {
    // Daemon-minted ULID (workflows-repository), same echo-bounding rationale
    // as memory.action.
    id: Ulid,
    action: Type.Union([Type.Literal('confirm'), Type.Literal('reject')]),
  },
  { additionalProperties: false },
);
export type WorkflowActionParams = Static<typeof WorkflowActionParamsSchema>;

export const WorkflowActionResultSchema = Type.Object({
  updated: Type.Union([WorkflowDtoSchema, Type.Null()]),
});
export type WorkflowActionResult = Static<typeof WorkflowActionResultSchema>;

export const ChatSendParamsSchema = Type.Object(
  {
    // Omitted on a new conversation; otherwise a daemon-allocated ULID from a
    // previous chat.send result — pinned so the busy/abort error echoes stay
    // bounded.
    sessionId: Type.Optional(Ulid),
    text: Type.String({ minLength: 1, maxLength: 32768 }),
  },
  { additionalProperties: false },
);

export const ChatSendResultSchema = Type.Object({
  // Daemon always allocates ULID session ids; pin the result shape to match
  // the params side.
  requestId: Ulid,
  sessionId: Ulid,
});
export type ChatSendResult = Static<typeof ChatSendResultSchema>;

export const ChatCancelParamsSchema = Type.Object(
  { requestId: Ulid },
  { additionalProperties: false },
);
export type ChatCancelParams = Static<typeof ChatCancelParamsSchema>;

export const ChatCancelResultSchema = Type.Object({
  cancelled: Type.Boolean(),
});
export type ChatCancelResult = Static<typeof ChatCancelResultSchema>;

export const DeleteRangeParamsSchema = Type.Object(
  {
    from: Type.Optional(EpochMs),
    to: Type.Optional(EpochMs),
    preset: Type.Optional(
      Type.Union([
        Type.Literal('last_10_minutes'),
        Type.Literal('last_hour'),
        Type.Literal('today'),
        Type.Literal('all'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type DeleteRangeParams = Static<typeof DeleteRangeParamsSchema>;

export const DeleteRangeResultSchema = Type.Object({
  deleted: Type.Object({
    rawEvents: DaemonSafeInt,
    steps: DaemonSafeInt,
    episodes: DaemonSafeInt,
    memories: DaemonSafeInt,
    workflows: DaemonSafeInt,
  }),
});
export type DeleteRangeResult = Static<typeof DeleteRangeResultSchema>;

export const SettingsGetParamsSchema = Type.Object({}, { additionalProperties: false });
export type SettingsGetParams = Static<typeof SettingsGetParamsSchema>;

export const DaemonSettingsSchema = Type.Object({
  // Bounded even though settings.set is not yet registered: when mutation
  // ships, a patch like {rawRetentionHours: -1} must not reach retention
  // scheduling math with destructive semantics (round-25).
  chatModel: Type.String({ minLength: 1, maxLength: 256 }),
  backgroundModel: Type.String({ minLength: 1, maxLength: 256 }),
  rawRetentionHours: Type.Integer({ minimum: 1 }),
  semanticRetentionDays: Type.Integer({ minimum: 1 }),
});
export type DaemonSettings = Static<typeof DaemonSettingsSchema>;

export const SettingsGetResultSchema = Type.Object({
  settings: DaemonSettingsSchema,
});
export type SettingsGetResult = Static<typeof SettingsGetResultSchema>;

export const SettingsSetPatchSchema = Type.Composite([Type.Partial(DaemonSettingsSchema)], {
  additionalProperties: false,
});

export const SettingsSetParamsSchema = Type.Object(
  { patch: SettingsSetPatchSchema },
  { additionalProperties: false },
);
export type SettingsSetParams = Static<typeof SettingsSetParamsSchema>;

export const SettingsSetResultSchema = Type.Object({
  settings: DaemonSettingsSchema,
});
export type SettingsSetResult = Static<typeof SettingsSetResultSchema>;

export const JobsRetryDeadParamsSchema = Type.Object({}, { additionalProperties: false });
export type JobsRetryDeadParams = Static<typeof JobsRetryDeadParamsSchema>;

export const JobsRetryDeadResultSchema = Type.Object({
  retried: DaemonSafeInt,
});
export type JobsRetryDeadResult = Static<typeof JobsRetryDeadResultSchema>;

/**
 * diagnostics.get: read-only daemon health surface (contracts §Protocol v1)
 * backing the recorder's Diagnostics pane — quick_check integrity flag plus
 * the newest-first tail of the daemon's error ring (logging.ts).
 */
export const DiagnosticsGetParamsSchema = Type.Object({}, { additionalProperties: false });
export type DiagnosticsGetParams = Static<typeof DiagnosticsGetParamsSchema>;

/** Shared bound: wire maxItems here AND the in-memory error-ring cap. */
export const DIAGNOSTICS_MAX_LAST_ERRORS = 50;

/** One recorded daemon error (newest-first in `lastErrors`). */
export const DiagnosticsErrorEntrySchema = Type.Object(
  {
    at: DaemonSafeInt,
    scope: Type.String(),
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);
export type DiagnosticsErrorEntry = Static<typeof DiagnosticsErrorEntrySchema>;

export const DiagnosticsGetResultSchema = Type.Object(
  {
    integrityOk: Type.Boolean(),
    lastErrors: Type.Array(DiagnosticsErrorEntrySchema, {
      maxItems: DIAGNOSTICS_MAX_LAST_ERRORS,
    }),
  },
  { additionalProperties: false },
);
export type DiagnosticsGetResult = Static<typeof DiagnosticsGetResultSchema>;

/** Pinned op name → param/result schema map. Contracts §Protocol v1. */
export const Ops = {
  'status.get': {
    params: StatusGetParamsSchema,
    result: StatusResultSchema,
  },
  'timeline.list': {
    params: TimelineListParamsSchema,
    result: TimelineListResultSchema,
  },
  'segments.list': {
    params: SegmentsListParamsSchema,
    result: SegmentsListResultSchema,
  },
  'episode.get': {
    params: EpisodeGetParamsSchema,
    result: EpisodeGetResultSchema,
  },
  'history.search': {
    params: HistorySearchParamsSchema,
    result: HistorySearchResultSchema,
  },
  'memories.list': {
    params: MemoriesListParamsSchema,
    result: MemoriesListResultSchema,
  },
  'memory.action': {
    params: MemoryActionParamsSchema,
    result: MemoryActionResultSchema,
  },
  'workflows.list': {
    params: WorkflowsListParamsSchema,
    result: WorkflowsListResultSchema,
  },
  'workflow.action': {
    params: WorkflowActionParamsSchema,
    result: WorkflowActionResultSchema,
  },
  'chat.send': {
    params: ChatSendParamsSchema,
    result: ChatSendResultSchema,
  },
  'chat.cancel': {
    params: ChatCancelParamsSchema,
    result: ChatCancelResultSchema,
  },
  'delete.range': {
    params: DeleteRangeParamsSchema,
    result: DeleteRangeResultSchema,
  },
  'settings.get': {
    params: SettingsGetParamsSchema,
    result: SettingsGetResultSchema,
  },
  'settings.set': {
    params: SettingsSetParamsSchema,
    result: SettingsSetResultSchema,
  },
  'jobs.retryDead': {
    params: JobsRetryDeadParamsSchema,
    result: JobsRetryDeadResultSchema,
  },
  'diagnostics.get': {
    params: DiagnosticsGetParamsSchema,
    result: DiagnosticsGetResultSchema,
  },
} as const;
export type OpName = keyof typeof Ops;
export const OpNames = Object.keys(Ops) as OpName[];

/**
 * Handler-facing param/result types derived from the registry itself — the
 * single source both for wire validation (Router.dispatch checks BOTH sides
 * against `Ops[op]`) and for statically typed op handlers
 * (`OpHandler<K>` receives `OpParams<K>` and must return `OpResult<K>`).
 */
export type OpParams<K extends OpName> = Static<(typeof Ops)[K]['params']>;
export type OpResult<K extends OpName> = Static<(typeof Ops)[K]['result']>;

// ---------------------------------------------------------------------------
// Server-pushed events
// ---------------------------------------------------------------------------

export const ServerEventFrameSchema = Type.Object({
  ...EnvelopeFields,
  type: Type.Literal('event'),
  kind: Type.String(),
  payload: Type.Unknown(),
});
export type ServerEventFrame = Static<typeof ServerEventFrameSchema>;

export const ServerEventKinds = [
  'chat_chunk',
  'chat_done',
  'chat_error',
  'queue_update',
  'recording_state',
  'episodes_changed',
  'memories_changed',
  'workflows_changed',
] as const;
export type ServerEventKind = (typeof ServerEventKinds)[number];

export const ChatChunkPayloadSchema = Type.Object({
  requestId: Ulid,
  delta: Type.String(),
});
export type ChatChunkPayload = Static<typeof ChatChunkPayloadSchema>;

export const ChatDonePayloadSchema = Type.Object({
  requestId: Ulid,
  // Same daemon-minted ULID as the chat.send result — the recorder persists
  // this value and re-sends it as chat.send's sessionId, so an unpinned
  // shape would let a malformed id bypass the params-side Ulid gate until
  // the next turn fails with error.invalid_params.
  sessionId: Ulid,
});
export type ChatDonePayload = Static<typeof ChatDonePayloadSchema>;

/**
 * Closed vocabulary of daemon-emitted chat_error codes (contracts §Protocol
 * v1): classifyChatError in agent/agent-session.ts produces
 * llm_unavailable|aborted|internal, and the concurrency-cap path in
 * ipc/chat-ops.ts emits busy.
 */
export const ChatErrorCodes = ['llm_unavailable', 'aborted', 'internal', 'busy'] as const;
export const ChatErrorCode = Type.Union(ChatErrorCodes.map((c) => Type.Literal(c)));
export type ChatErrorCode = (typeof ChatErrorCodes)[number];

export const ChatErrorPayloadSchema = Type.Object({
  requestId: Ulid,
  code: ChatErrorCode,
  message: Type.String(),
});
export type ChatErrorPayload = Static<typeof ChatErrorPayloadSchema>;

export const QueueUpdatePayloadSchema = Type.Object({
  pendingJobs: DaemonSafeInt,
});
export type QueueUpdatePayload = Static<typeof QueueUpdatePayloadSchema>;

export const RecordingStatePayloadSchema = Type.Object({
  state: Type.Union([Type.Literal('paused'), Type.Literal('active')]),
  reason: Type.Optional(Type.String()),
});
export type RecordingStatePayload = Static<typeof RecordingStatePayloadSchema>;

export const ChangedPayloadSchema = Type.Object({});
export type ChangedPayload = Static<typeof ChangedPayloadSchema>;

export const ServerEventPayloads = {
  chat_chunk: ChatChunkPayloadSchema,
  chat_done: ChatDonePayloadSchema,
  chat_error: ChatErrorPayloadSchema,
  queue_update: QueueUpdatePayloadSchema,
  recording_state: RecordingStatePayloadSchema,
  episodes_changed: ChangedPayloadSchema,
  memories_changed: ChangedPayloadSchema,
  workflows_changed: ChangedPayloadSchema,
} as const;

// ---------------------------------------------------------------------------
// Inbound (daemon-received) frame union
// ---------------------------------------------------------------------------

export const InboundFrameSchema = Type.Union([
  ClientHelloSchema,
  EventBatchSchema,
  EventBatchAckSchema,
  RequestFrameSchema,
]);
export type InboundFrame = Static<typeof InboundFrameSchema>;

/** Outbound (daemon-sent) frame union. */
export const OutboundFrameSchema = Type.Union([
  ServerHelloSchema,
  EventBatchSchema,
  EventBatchAckSchema,
  ResponseFrameSchema,
  ServerEventFrameSchema,
  ProtocolErrorFrameSchema,
]);
export type OutboundFrame = Static<typeof OutboundFrameSchema>;

/** Any frame on the wire (either direction) — used by tests and the recorder. */
export const AnyFrameSchema = Type.Union([InboundFrameSchema, OutboundFrameSchema]);
export type AnyFrame = Static<typeof AnyFrameSchema>;
