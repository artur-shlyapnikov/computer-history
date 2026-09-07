import { Type, type Static } from '@sinclair/typebox';

import { EpochMs } from './bounds.js';

const ulidPattern = '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$';
const Ulid = Type.String({ pattern: ulidPattern });

/** Episode: durable episodic memory unit. Spec §3.9 episodes table. */
export const EpisodeDtoSchema = Type.Object(
  {
    id: Ulid,
    startedAtMs: EpochMs,
    endedAtMs: EpochMs,
    title: Type.String(),
    summary: Type.String(),
    intent: Type.Union([Type.Null(), Type.String()]),
    outcome: Type.Union([Type.Null(), Type.String()]),
    apps: Type.Array(Type.String()),
    entities: Type.Array(Type.String()),
    summaryModel: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    summaryPromptVersion: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    createdAtMs: EpochMs,
    updatedAtMs: EpochMs,
  },
  { $id: 'EpisodeDto' },
);
export type EpisodeDto = Static<typeof EpisodeDtoSchema>;

/** Timeline list item: episode plus denormalized display fields. Contracts status/timeline ops. */
export const EpisodeSummaryDtoSchema = Type.Object(
  {
    id: Ulid,
    startedAtMs: EpochMs,
    endedAtMs: EpochMs,
    title: Type.String(),
    appNames: Type.Array(Type.String()),
    stepCount: Type.Integer(),
    pendingJobs: Type.Integer(),
  },
  { $id: 'EpisodeSummaryDto' },
);
export type EpisodeSummaryDto = Static<typeof EpisodeSummaryDtoSchema>;

/** Action vocabulary emitted by the daemon coalescer (brief-m2 §D2 item 3); mirrors STEP_ACTIONS. */
export const SemanticStepAction = Type.Union([
  Type.Literal('switch_app'),
  Type.Literal('edit_text'),
  Type.Literal('type'),
  Type.Literal('scroll'),
  Type.Literal('click'),
  Type.Literal('focus'),
  Type.Literal('shortcut'),
  Type.Literal('window_change'),
]);
export type SemanticStepAction = Static<typeof SemanticStepAction>;

/** Semantic step. Spec §3.9 semantic_steps table. */
export const SemanticStepDtoSchema = Type.Object(
  {
    id: Ulid,
    segmentId: Ulid,
    ordinal: Type.Integer(),
    startedAtMs: EpochMs,
    endedAtMs: EpochMs,
    action: SemanticStepAction,
    appBundleId: Type.String(),
    appName: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    target: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    text: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    /** M7 additive (migration 004): UI control role; null on pre-004 rows. */
    targetRole: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  },
  { $id: 'SemanticStepDto' },
);
export type SemanticStepDto = Static<typeof SemanticStepDtoSchema>;

export const MemoryKind = Type.Union([
  Type.Literal('fact'),
  Type.Literal('preference'),
  Type.Literal('procedure'),
]);
export type MemoryKind = Static<typeof MemoryKind>;

export const MemoryStatus = Type.Union([
  Type.Literal('candidate'),
  Type.Literal('active'),
  Type.Literal('rejected'),
  Type.Literal('superseded'),
]);
export type MemoryStatus = Static<typeof MemoryStatus>;

/** Memory candidate. Spec §3.9 memory_candidates table. */
export const MemoryCandidateDtoSchema = Type.Object(
  {
    id: Ulid,
    kind: MemoryKind,
    canonicalKey: Type.String(),
    text: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    status: MemoryStatus,
    firstSeenAtMs: EpochMs,
    lastSeenAtMs: EpochMs,
    evidenceCount: Type.Integer(),
    createdAtMs: EpochMs,
    updatedAtMs: EpochMs,
  },
  { $id: 'MemoryCandidateDto' },
);
export type MemoryCandidateDto = Static<typeof MemoryCandidateDtoSchema>;

export const WorkflowStatus = Type.Union([
  Type.Literal('candidate'),
  Type.Literal('confirmed'),
  Type.Literal('rejected'),
]);
export type WorkflowStatus = Static<typeof WorkflowStatus>;

/** Workflow template JSON payload (opaque in V1 wire terms but structured here). */
export const WorkflowTemplateSchema = Type.Object({
  name: Type.Optional(Type.String()),
  purpose: Type.Optional(Type.String()),
  preconditions: Type.Optional(Type.Array(Type.String())),
  stableSteps: Type.Optional(Type.Array(Type.String())),
  variableInputs: Type.Optional(Type.Array(Type.String())),
  expectedOutcome: Type.Optional(Type.String()),
});
export type WorkflowTemplate = Static<typeof WorkflowTemplateSchema>;

/** Workflow. Spec §3.9 workflows table. */
export const WorkflowDtoSchema = Type.Object(
  {
    id: Ulid,
    name: Type.String(),
    purpose: Type.Union([Type.Null(), Type.String()]),
    status: WorkflowStatus,
    template: WorkflowTemplateSchema,
    occurrenceCount: Type.Integer(),
    medianSimilarity: Type.Number(),
    firstSeenAtMs: EpochMs,
    lastSeenAtMs: EpochMs,
    createdAtMs: EpochMs,
    updatedAtMs: EpochMs,
  },
  { $id: 'WorkflowDto' },
);
export type WorkflowDto = Static<typeof WorkflowDtoSchema>;

/** Workflow occurrence link. Spec §3.9 workflow_occurrences table. */
export const WorkflowOccurrenceDtoSchema = Type.Object(
  {
    workflowId: Ulid,
    episodeId: Ulid,
    similarity: Type.Number(),
  },
  { $id: 'WorkflowOccurrenceDto' },
);
export type WorkflowOccurrenceDto = Static<typeof WorkflowOccurrenceDtoSchema>;

/** One occurrence as rendered by workflows.list: episode provenance + similarity. */
export const WorkflowOccurrenceViewSchema = Type.Object(
  {
    episodeId: Ulid,
    startedAtMs: EpochMs,
    similarity: Type.Number(),
  },
  { $id: 'WorkflowOccurrenceView' },
);
export type WorkflowOccurrenceView = Static<typeof WorkflowOccurrenceViewSchema>;

/** workflows.list item (contracts): WorkflowDto plus its occurrence ledger, newest first. */
export const WorkflowListItemSchema = Type.Composite(
  [WorkflowDtoSchema, Type.Object({ occurrences: Type.Array(WorkflowOccurrenceViewSchema) })],
  { $id: 'WorkflowListItem' },
);
export type WorkflowListItem = Static<typeof WorkflowListItemSchema>;
