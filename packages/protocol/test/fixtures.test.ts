import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type ActivityEvent,
  ActivityEventSchema,
  AnyFrameSchema,
  ClientHelloSchema,
  EpisodeGetResultSchema,
  EventBatchAckSchema,
  EventBatchSchema,
  MemoryCandidateDtoSchema,
  Ops,
  OpNames,
  PROTOCOL_VERSION,
  ProtocolErrorFrameSchema,
  QueueUpdatePayloadSchema,
  RecordingStatePayloadSchema,
  RequestFrameSchema,
  ResponseErrFrameSchema,
  ResponseOkFrameSchema,
  ServerHelloSchema,
  WorkflowDtoSchema,
  ServerEventFrameSchema,
  assertFrame,
  frameErrors,
  type ContentPolicy,
  type OpName,
} from '../src/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function readFixture(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, relative), 'utf8')) as unknown;
}

/** fixture file → schema it must satisfy */
const validFixtures: Record<string, Parameters<typeof assertFrame>[0]> = {
  'handshake.client.json': ClientHelloSchema,
  'handshake.server.json': ServerHelloSchema,
  'activity-event.allow-content.json': ActivityEventSchema,
  'activity-event.basic.json': ActivityEventSchema,
  'activity-event.excluded-app-tombstone.json': ActivityEventSchema,
  'activity-event.oversize-redacted.json': ActivityEventSchema,
  'activity-event.secret-pattern-redacted.json': ActivityEventSchema,
  'activity-event.secure-redacted.json': ActivityEventSchema,
  'activity-event.sensitive-redacted.json': ActivityEventSchema,
  'activity-event.typing-redacted.json': ActivityEventSchema,
  'event-batch.json': EventBatchSchema,
  'event-batch-ack.json': EventBatchAckSchema,
  'request.segments-list.json': RequestFrameSchema,
  'request.timeline-list.json': RequestFrameSchema,
  'request.history-search.json': RequestFrameSchema,
  'request.chat-send.json': RequestFrameSchema,
  'request.chat-cancel.json': RequestFrameSchema,
  'request.memories-list.json': RequestFrameSchema,
  'request.memory-action.json': RequestFrameSchema,
  'request.jobs-retry-dead.json': RequestFrameSchema,
  'request.delete-range.json': RequestFrameSchema,
  'request.workflows-list.json': RequestFrameSchema,
  'request.workflow-action.json': RequestFrameSchema,
  'request.status-get.json': RequestFrameSchema,
  'request.diagnostics-get.json': RequestFrameSchema,
  'request.episode-get.json': RequestFrameSchema,
  // protocolVersion != 1 is deliberately ACCEPTED at the shape layer: the
  // envelope pins only "integer", not literal 1. Version enforcement is a
  // runtime concern (error.protocol_version), so this fixture pins that
  // layering decision instead of letting it drift back into the schema.
  'request.protocol-version-unpinned.json': RequestFrameSchema,
  'response.segments-list.json': ResponseOkFrameSchema,
  'response.timeline-list.json': ResponseOkFrameSchema,
  'response.chat-send.json': ResponseOkFrameSchema,
  'response.history-search.json': ResponseOkFrameSchema,
  'response.memories-list.json': ResponseOkFrameSchema,
  'response.memory-action.json': ResponseOkFrameSchema,
  'response.jobs-retry-dead.json': ResponseOkFrameSchema,
  'response.workflows-list.json': ResponseOkFrameSchema,
  'response.delete-range.json': ResponseOkFrameSchema,
  'response.workflow-action.json': ResponseOkFrameSchema,
  'response.status-get.json': ResponseOkFrameSchema,
  'response.diagnostics-get.json': ResponseOkFrameSchema,
  'response.episode-get.json': ResponseOkFrameSchema,
  'event.chat-chunk.json': ServerEventFrameSchema,
  'event.chat-done.json': ServerEventFrameSchema,
  'event.chat-error.json': ServerEventFrameSchema,
  'event.queue-update.json': ServerEventFrameSchema,
  'event.recording-state.json': ServerEventFrameSchema,
  'response.err.json': ResponseErrFrameSchema,
  'error.protocol-error.json': ProtocolErrorFrameSchema,
  'episode.with-steps.json': EpisodeGetResultSchema,
  'memory-candidate.json': MemoryCandidateDtoSchema,
  'workflow.candidate.json': WorkflowDtoSchema,
};

describe('golden fixtures decode against the wire contract', () => {
  for (const [file, schema] of Object.entries(validFixtures)) {
    it(`decodes ${file}`, () => {
      const value = readFixture(file);
      expect(frameErrors(schema, value), `fixture ${file} failed validation`).toEqual([]);
      expect(() => assertFrame(schema, value)).not.toThrow();
    });
  }

  it('rejects invalid/event-bad-action.json', () => {
    const value = readFixture('invalid/event-bad-action.json');
    expect(frameErrors(ActivityEventSchema, value).length).toBeGreaterThan(0);
    expect(() => assertFrame(ActivityEventSchema, value)).toThrow(TypeError);
  });

  it('rejects invalid/hello-bad-messageId.json', () => {
    const value = readFixture('invalid/hello-bad-messageId.json');
    expect(frameErrors(ClientHelloSchema, value).length).toBeGreaterThan(0);
    expect(() => assertFrame(ClientHelloSchema, value)).toThrow(TypeError);
  });

  it('rejects invalid/frame-unknown-type.json against the full wire union', () => {
    const value = readFixture('invalid/frame-unknown-type.json');
    expect(frameErrors(AnyFrameSchema, value).length).toBeGreaterThan(0);
    expect(() => assertFrame(AnyFrameSchema, value)).toThrow(TypeError);
  });

  it('covers every *.json file under fixtures/ (no orphan fixtures)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const all = walk(fixturesDir)
      .map((p) => path.relative(fixturesDir, p))
      .sort();
    const invalidFixtures = [
      'invalid/event-bad-action.json',
      'invalid/hello-bad-messageId.json',
      'invalid/frame-unknown-type.json',
      ...rejectionFixtures.map((f) => f.file),
    ];
    expect(all.sort()).toEqual([...Object.keys(validFixtures), ...invalidFixtures].sort());
  });
});

describe('activity-event goldens pin the policy-specific content shape', () => {
  // [fixture, contentPolicy, does the wire event carry content?]
  const shapes: Array<[string, ContentPolicy, boolean]> = [
    ['activity-event.allow-content.json', 'allow', true],
    ['activity-event.basic.json', 'metadata_only', false],
    ['activity-event.excluded-app-tombstone.json', 'excluded_app', false],
    ['activity-event.oversize-redacted.json', 'redacted_oversize', false],
    ['activity-event.secret-pattern-redacted.json', 'redacted_secret_pattern', true],
    ['activity-event.secure-redacted.json', 'redacted_secure_field', false],
    ['activity-event.sensitive-redacted.json', 'redacted_sensitive_target', false],
    // Producer reality (InputMonitor plain keystrokes): typing drafts carry no
    // text, so PrivacyFilter yields `allow` with null content — never
    // metadata_only.
    ['activity-event.typing-redacted.json', 'allow', false],
  ];
  for (const [file, policy, carriesContent] of shapes) {
    it(`${file} pins ${policy}`, () => {
      const event = readFixture(file) as ActivityEvent;
      expect(event.contentPolicy).toBe(policy);
      expect(event.content != null).toBe(carriesContent);
      if (policy === 'redacted_secret_pattern') {
        expect(event.content).toContain('[REDACTED]');
      }
      if (policy === 'excluded_app') {
        // Tombstone: fact only — window/target absent entirely.
        expect('window' in event).toBe(false);
        expect('target' in event).toBe(false);
      }
    });
  }
});

/** request fixture → pinned op name */
const requestOpFixtures: Record<string, OpName> = {
  'request.segments-list.json': 'segments.list',
  'request.timeline-list.json': 'timeline.list',
  'request.history-search.json': 'history.search',
  'request.chat-send.json': 'chat.send',
  'request.chat-cancel.json': 'chat.cancel',
  'request.memories-list.json': 'memories.list',
  'request.memory-action.json': 'memory.action',
  'request.jobs-retry-dead.json': 'jobs.retryDead',
  'request.delete-range.json': 'delete.range',
  'request.workflows-list.json': 'workflows.list',
  'request.workflow-action.json': 'workflow.action',
  'request.status-get.json': 'status.get',
  'request.diagnostics-get.json': 'diagnostics.get',
  'request.episode-get.json': 'episode.get',
};

/** response fixture → pinned op name of the request it answers */
const responseOpFixtures: Record<string, OpName> = {
  'response.segments-list.json': 'segments.list',
  'response.timeline-list.json': 'timeline.list',
  'response.chat-send.json': 'chat.send',
  'response.history-search.json': 'history.search',
  'response.memories-list.json': 'memories.list',
  'response.memory-action.json': 'memory.action',
  'response.jobs-retry-dead.json': 'jobs.retryDead',
  'response.workflows-list.json': 'workflows.list',
  'response.delete-range.json': 'delete.range',
  'response.workflow-action.json': 'workflow.action',
  'response.diagnostics-get.json': 'diagnostics.get',
  'response.status-get.json': 'status.get',
  'response.episode-get.json': 'episode.get',
};

describe('per-op payloads validate against the pinned Ops map', () => {
  for (const [file, op] of Object.entries(requestOpFixtures)) {
    it(`${file} carries a known op with schema-valid params`, () => {
      expect(OpNames, `${op} must exist in the Ops map`).toContain(op);
      const frame = readFixture(file) as { op?: string; params?: unknown };
      expect(frame.op).toBe(op);
      expect(frameErrors(Ops[op].params, frame.params ?? {}), `${file} params`).toEqual([]);
    });
  }

  for (const [file, op] of Object.entries(responseOpFixtures)) {
    it(`${file} result satisfies the ${op} result schema`, () => {
      expect(OpNames, `${op} must exist in the Ops map`).toContain(op);
      const frame = readFixture(file) as { ok: boolean; result?: unknown };
      expect(frame.ok, `${file} must be an ok:true response`).toBe(true);
      expect(frameErrors(Ops[op].result, frame.result), `${file} result`).toEqual([]);
    });
  }

  it('ok responses echo the paired request requestId', () => {
    for (const [file, op] of Object.entries(responseOpFixtures)) {
      const requestFile = Object.entries(requestOpFixtures).find(([, o]) => o === op)?.[0];
      if (requestFile === undefined) continue;
      const request = readFixture(requestFile) as { requestId: string };
      const response = readFixture(file) as { requestId: string };
      expect(response.requestId, `${file} must echo ${requestFile}`).toBe(request.requestId);
    }
  });
});

describe('wire roundtrip stability', () => {
  it('canonical JSON serialization is stable across a reserialize cycle', () => {
    for (const file of Object.keys(validFixtures)) {
      const raw = readFileSync(path.join(fixturesDir, file), 'utf8');
      const once = JSON.stringify(JSON.parse(raw), null, 2) + '\n';
      const twice = JSON.stringify(JSON.parse(once), null, 2) + '\n';
      expect(twice, `roundtrip drift in ${file}`).toBe(once);
    }
  });
});

/**
 * Schema-level rejection classes (CE-4). Each entry pins one boundary the
 * compiled TypeBox schema must refuse, mirroring how invalid/event-bad-action,
 * hello-bad-messageId and frame-unknown-type are asserted above. Op-param
 * entries assert against the op's params schema — the dispatch level that
 * answers error.invalid_params — since RequestFrameSchema deliberately treats
 * `params` as unknown at the shape layer.
 */
const rejectionFixtures: Array<{
  file: string;
  schema: Parameters<typeof assertFrame>[0];
  because: string;
}> = [
  // envelope: sentAt is an EpochMs (integer, 0..2^53-1)
  { file: 'invalid/envelope-sentAt-negative.json', schema: RequestFrameSchema, because: 'sentAt is negative' },
  {
    file: 'invalid/envelope-sentAt-overflow.json',
    schema: RequestFrameSchema,
    because: 'sentAt exceeds 2^53-1',
  },
  {
    file: 'invalid/envelope-sentAt-fractional.json',
    schema: RequestFrameSchema,
    because: 'sentAt is not an integer',
  },
  // frame-shape
  { file: 'invalid/request-bad-requestId.json', schema: RequestFrameSchema, because: 'requestId is not a ULID' },
  { file: 'invalid/request-missing-op.json', schema: RequestFrameSchema, because: 'request has no op' },
  {
    file: 'invalid/event-batch-bad-batchId.json',
    schema: EventBatchSchema,
    because: 'event_batch.batchId is not a ULID',
  },
  {
    file: 'invalid/event-batch-events-over-max.json',
    schema: EventBatchSchema,
    because: 'event_batch.events exceeds maxItems 1000',
  },
  {
    file: 'invalid/response-err-unknown-code.json',
    schema: ResponseErrFrameSchema,
    because: 'error.code is outside the 8-literal union',
  },
  // op params (dispatch level → error.invalid_params)
  {
    file: 'invalid/params-status-get-additional-property.json',
    schema: Ops['status.get'].params,
    because: 'status.get forbids additionalProperties',
  },
  {
    file: 'invalid/params-timeline-list-limit-over-max.json',
    schema: Ops['timeline.list'].params,
    because: 'timeline.list limit > 50',
  },
  {
    file: 'invalid/params-timeline-list-limit-under-min.json',
    schema: Ops['timeline.list'].params,
    because: 'timeline.list limit < 1',
  },
  {
    file: 'invalid/params-segments-list-limit-over-max.json',
    schema: Ops['segments.list'].params,
    because: 'segments.list limit > 200',
  },
  {
    file: 'invalid/params-history-search-query-over-length.json',
    schema: Ops['history.search'].params,
    because: 'history.search query longer than 512 chars',
  },
  {
    file: 'invalid/params-history-search-apps-over-max.json',
    schema: Ops['history.search'].params,
    because: 'history.search apps has more than 32 items',
  },
  {
    file: 'invalid/params-chat-send-text-empty.json',
    schema: Ops['chat.send'].params,
    because: 'chat.send text is empty',
  },
  {
    file: 'invalid/params-chat-send-text-over-length.json',
    schema: Ops['chat.send'].params,
    because: 'chat.send text exceeds 32768 chars',
  },
  {
    file: 'invalid/params-episode-get-id-not-ulid.json',
    schema: Ops['episode.get'].params,
    because: 'episode.get id is not a ULID',
  },
  {
    file: 'invalid/params-memory-action-action-unknown.json',
    schema: Ops['memory.action'].params,
    because: 'memory.action action outside its literal union',
  },
  {
    file: 'invalid/params-workflow-action-forget.json',
    schema: Ops['workflow.action'].params,
    because: "workflow.action rejects action='forget' (memory.action-only)",
  },
  {
    file: 'invalid/params-memories-list-status-unknown.json',
    schema: Ops['memories.list'].params,
    because: 'memories.list status outside its enum',
  },
  {
    file: 'invalid/params-delete-range-preset-unknown.json',
    schema: Ops['delete.range'].params,
    because: 'delete.range preset outside its enum',
  },
  {
    file: 'invalid/params-delete-range-from-overflow.json',
    schema: Ops['delete.range'].params,
    because: 'delete.range from overflows EpochMs past 2^53-1',
  },
  {
    file: 'invalid/params-settings-set-patch-unknown-key.json',
    schema: Ops['settings.set'].params,
    because: 'settings.set patch has an unknown key',
  },
  {
    file: 'invalid/params-settings-set-missing-patch.json',
    schema: Ops['settings.set'].params,
    because: 'settings.set is missing patch',
  },
  // server-event payload bounds
  {
    file: 'invalid/event-queue-update-pendingJobs-overflow.json',
    schema: QueueUpdatePayloadSchema,
    because: 'queue-update pendingJobs exceeds DaemonSafeInt (2^53-1)',
  },
  {
    file: 'invalid/event-recording-state-state-unknown.json',
    schema: RecordingStatePayloadSchema,
    because: 'recording-state state outside its enum',
  },
];

describe('invalid fixtures pin every schema-level rejection class', () => {
  for (const { file, schema, because } of rejectionFixtures) {
    it(`rejects ${file} (${because})`, () => {
      const value = readFixture(file);
      expect(frameErrors(schema, value).length).toBeGreaterThan(0);
      expect(() => assertFrame(schema, value)).toThrow(TypeError);
    });
  }

  it('rejects every rejection fixture against the full inbound/outbound wire union too', () => {
    for (const { file } of rejectionFixtures) {
      const value = readFixture(file);
      const fullFrame = ['invalid/envelope-sentAt-', 'invalid/request-', 'invalid/event-batch-'].some((p) =>
        file.startsWith(p),
      )
        ? AnyFrameSchema
        : null;
      if (fullFrame !== null) {
        expect(frameErrors(fullFrame, value).length).toBeGreaterThan(0);
      }
    }
  });
  it('accepts request.protocol-version-unpinned.json — version pinning lives at runtime, not in the schema', () => {
    const value = readFixture('request.protocol-version-unpinned.json');
    expect(
      typeof value === 'object' &&
      value !== null &&
      'protocolVersion' in value &&
      value.protocolVersion !== PROTOCOL_VERSION,
    ).toBe(true);
    expect(frameErrors(RequestFrameSchema, value)).toEqual([]);
    expect(() => assertFrame(RequestFrameSchema, value)).not.toThrow();
  });
});
