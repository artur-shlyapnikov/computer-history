import { describe, expect, it } from 'vitest';

import {
  ActivityEventSchema,
  ChatChunkPayloadSchema,
  ChatErrorPayloadSchema,
  ChatSendParamsSchema,
  ErrorCodes,
  ClientHelloSchema,
  EpisodeGetParamsSchema,
  HistorySearchParamsSchema,
  HistoryHitSchema,
  InboundFrameSchema,
  MemoriesListParamsSchema,
  MemoriesListResultSchema,
  Ops,
  OpNames,
  QueueUpdatePayloadSchema,
  SemanticStepDtoSchema,
  ServerEventKinds,
  ServerHelloSchema,
  SettingsSetParamsSchema,
  WorkflowsListParamsSchema,
  assertFrame,
  frameErrors,
  isFrame,
} from '../src/index.js';

const envelope = {
  protocolVersion: 1,
  messageId: '01M0NP9G4GXXGYT7PYGFC5K5HV',
  sentAt: 1787443200000,
};

describe('protocol invariants', () => {
  it('pins protocol version 1', () => {
    expect(Object.keys(Ops).length).toBe(16);
    expect(OpNames).toContain('status.get');
    expect(OpNames).toContain('chat.send');
    expect(OpNames).toContain('delete.range');
    expect(OpNames).toContain('segments.list');
    expect(ServerEventKinds).toHaveLength(8);
    expect(ErrorCodes).toContain('error.protocol_version');
    expect(ErrorCodes).toContain('error.bad_frame');
    expect(OpNames).toContain('diagnostics.get');
  });

  it('accepts a well-formed ClientHello and rejects wrong protocolVersion shape', () => {
    const hello = { ...envelope, type: 'client_hello', protocolVersion: 1, appVersion: '0.1.0' };
    expect(isFrame(ClientHelloSchema, hello)).toBe(true);
    const bad = { ...hello, protocolVersion: 'one' };
    expect(isFrame(ClientHelloSchema, bad)).toBe(false);
  });

  it('ActivityEvent requires a ULID-shaped id and a known action', () => {
    const base = {
      id: '01M0NP9G4GXXGYT7PYGFC5K5HV',
      observedAt: 1787443200000,
      source: 'workspace',
      app: { bundleId: 'com.apple.Safari' },
      action: 'app_focus',
      contentPolicy: 'metadata_only',
    };
    expect(frameErrors(ActivityEventSchema, base)).toEqual([]);
    expect(frameErrors(ActivityEventSchema, { ...base, id: 'not-a-ulid' }).length).toBeGreaterThan(0);
    expect(
      frameErrors(ActivityEventSchema, { ...base, contentPolicy: 'allow_everything' }).length,
    ).toBeGreaterThan(0);
  });

  it('InboundFrame union discriminates request vs event_batch', () => {
    const request = {
      ...envelope,
      type: 'request',
      op: 'status.get',
      requestId: '01M0NP9G4HP0M1M64H8TC0VEKD',
      params: {},
    };
    expect(isFrame(InboundFrameSchema, request)).toBe(true);
    assertFrame(InboundFrameSchema, request);
  });

  it('isFrame narrows the static type', () => {
    const hello = { ...envelope, type: 'client_hello', protocolVersion: 2, appVersion: 'x' };
    if (isFrame(ClientHelloSchema, hello)) {
      expect(hello.appVersion).toBe('x');
    } else {
      throw new Error('expected valid ClientHello');
    }
  });

  const ulid = '01M0NP9G4GXXGYT7PYGFC5K5HV';

  it('EpochMs timestamps reject negative values', () => {
    const hello = {
      ...envelope,
      type: 'server_hello',
      daemonVersion: '0.1.0',
      databaseSchemaVersion: 1,
    };
    expect(frameErrors(ServerHelloSchema, { ...hello, sentAt: -1 }).length).toBeGreaterThan(0);
  });

  it('episode.get id must be ULID-shaped', () => {
    expect(isFrame(EpisodeGetParamsSchema, { id: ulid })).toBe(true);
    expect(isFrame(EpisodeGetParamsSchema, { id: 'not-a-ulid' })).toBe(false);
    expect(isFrame(EpisodeGetParamsSchema, { id: ulid.toLowerCase() })).toBe(false);
  });

  it('history.search hit provenance ids must be ULID-shaped', () => {
    const hit = {
      source: {
        episodeId: ulid,
        startedAtMs: 1787443200000,
        endedAtMs: 1787443200001,
        appNames: ['Safari'],
        snippet: 'snippet',
      },
      score: 0.5,
    };
    expect(frameErrors(HistoryHitSchema, hit)).toEqual([]);
    expect(frameErrors(HistoryHitSchema, { ...hit, source: { ...hit.source, episodeId: 'e1' } }).length)
      .toBeGreaterThan(0);
    expect(
      frameErrors(HistoryHitSchema, {
        ...hit,
        source: { ...hit.source, stepId: '01M0NP9G4GXXGYT7PYGFC5K5Hs' },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('memories.list status is pinned to the daemon group names', () => {
    expect(isFrame(MemoriesListParamsSchema, {})).toBe(true);
    for (const status of ['confirmed', 'suggestions', 'rejected', 'superseded']) {
      expect(isFrame(MemoriesListParamsSchema, { status })).toBe(true);
    }
    for (const status of ['active', 'candidate', 'archived', '']) {
      expect(isFrame(MemoriesListParamsSchema, { status })).toBe(false);
    }
  });

  it('memories.list limit is an optional bounded integer', () => {
    expect(isFrame(MemoriesListParamsSchema, { limit: 200 })).toBe(true);
    expect(isFrame(MemoriesListParamsSchema, { status: 'confirmed', limit: 1 })).toBe(true);
    expect(isFrame(MemoriesListParamsSchema, { limit: 0 })).toBe(false);
    expect(isFrame(MemoriesListParamsSchema, { limit: 201 })).toBe(false);
    expect(isFrame(MemoriesListParamsSchema, { limit: 1.5 })).toBe(false);
  });

  it('workflows.list status reuses WorkflowStatus', () => {
    expect(isFrame(WorkflowsListParamsSchema, {})).toBe(true);
    for (const status of ['candidate', 'confirmed', 'rejected']) {
      expect(isFrame(WorkflowsListParamsSchema, { status })).toBe(true);
    }
    for (const status of ['superseded', 'suggestions', 'archived']) {
      expect(isFrame(WorkflowsListParamsSchema, { status })).toBe(false);
    }
  });

  it('settings.set patch rejects unknown keys', () => {
    expect(frameErrors(SettingsSetParamsSchema, { patch: {} })).toEqual([]);
    expect(frameErrors(SettingsSetParamsSchema, { patch: { chatModel: 'm' } })).toEqual([]);
    expect(frameErrors(SettingsSetParamsSchema, { patch: { rawRetentionHours: 24 } })).toEqual([]);
    expect(frameErrors(SettingsSetParamsSchema, { patch: { nope: true } }).length).toBeGreaterThan(0);
    expect(
      frameErrors(SettingsSetParamsSchema, { patch: { rawRetentionHours: '24' } }).length,
    ).toBeGreaterThan(0);
  });

  it('chat.send text is bounded to [1, 32768]', () => {
    expect(isFrame(ChatSendParamsSchema, { text: 'hi' })).toBe(true);
    expect(isFrame(ChatSendParamsSchema, { text: '' })).toBe(false);
    expect(isFrame(ChatSendParamsSchema, { text: 'x'.repeat(32768) })).toBe(true);
    expect(isFrame(ChatSendParamsSchema, { text: 'x'.repeat(32769) })).toBe(false);
  });

  it('semantic step action is pinned to the coalescer vocabulary', () => {
    const base = {
      id: ulid,
      segmentId: '01M0NP9G4HP0M1M64H8TC0VEKD',
      ordinal: 0,
      startedAtMs: 1787443200000,
      appBundleId: 'com.apple.Safari',
      endedAtMs: 1787443200001,
    };
    const actions = [
      'switch_app',
      'edit_text',
      'type',
      'scroll',
      'click',
      'focus',
      'shortcut',
      'window_change',
    ];
    for (const action of actions) {
      expect(frameErrors(SemanticStepDtoSchema, { ...base, action })).toEqual([]);
    }
    for (const action of ['typing', 'text_edit', '', 'CLICK']) {
      expect(frameErrors(SemanticStepDtoSchema, { ...base, action }).length).toBeGreaterThan(0);
    }
  });

  it('history.search query is bounded to 512 chars (S1)', () => {
    expect(isFrame(HistorySearchParamsSchema, { query: 'webhook' })).toBe(true);
    expect(isFrame(HistorySearchParamsSchema, { query: 'x'.repeat(512) })).toBe(true);
    expect(isFrame(HistorySearchParamsSchema, { query: 'x'.repeat(513) })).toBe(false);
  });

  it('history.search apps list is bounded to 32 entries (S3)', () => {
    expect(isFrame(HistorySearchParamsSchema, { apps: Array.from({ length: 32 }, () => 'Safari') })).toBe(true);
    expect(isFrame(HistorySearchParamsSchema, { apps: Array.from({ length: 33 }, () => 'Safari') })).toBe(
      false,
    );
  });

  it('memories.list result groups only carry the pinned statuses (W1)', () => {
    const groups = (statuses: string[]) => ({
      groups: statuses.map((status) => ({ status, memories: [] })),
    });
    expect(frameErrors(MemoriesListResultSchema, groups(['confirmed', 'suggestions']))).toEqual([]);
    expect(frameErrors(MemoriesListResultSchema, groups(['rejected', 'superseded']))).toEqual([]);
    for (const status of ['archived', 'active', 'candidate', '']) {
      expect(frameErrors(MemoriesListResultSchema, groups([status])).length).toBeGreaterThan(0);
    }
  });

  it('daemon→app integers are pinned below 2^53−1 (W5)', () => {
    expect(isFrame(QueueUpdatePayloadSchema, { pendingJobs: 0 })).toBe(true);
    expect(isFrame(QueueUpdatePayloadSchema, { pendingJobs: 9007199254740991 })).toBe(true);
    // 2^63−1: valid JSON integer, but Foundation cannot parse it exactly.
    // (Written as an expression: the literal itself would lose precision.)
    const int64Max = 2n ** 63n - 1n;
    expect(isFrame(QueueUpdatePayloadSchema, { pendingJobs: Number(int64Max) })).toBe(false);
  });

  it('monotonicNs is pinned to the shared 2^53−1 magnitude bound (W5)', () => {
    const base = {
      id: ulid,
      observedAt: 1787443200000,
      source: 'workspace',
      app: { bundleId: 'com.apple.Safari' },
      action: 'app_focus',
      contentPolicy: 'metadata_only',
    };
    expect(frameErrors(ActivityEventSchema, { ...base, monotonicNs: 9007199254740991 })).toEqual([]);
    // A host up past ~104 days would produce uptime nanoseconds beyond 2^53−1;
    // the schema must reject what Foundation cannot decode exactly.
    const int64Max = 2n ** 63n - 1n;
    expect(
      frameErrors(ActivityEventSchema, { ...base, monotonicNs: Number(int64Max) }).length,
    ).toBeGreaterThan(0);
  });

  it('chat_error codes are a closed daemon vocabulary', () => {
    const payload = { requestId: ulid, code: 'llm_unavailable', message: 'no credentials' };
    for (const code of ['llm_unavailable', 'aborted', 'internal', 'busy']) {
      expect(isFrame(ChatErrorPayloadSchema, { ...payload, code })).toBe(true);
    }
    expect(isFrame(ChatErrorPayloadSchema, { ...payload, code: 'transport' })).toBe(false);
    expect(isFrame(ChatErrorPayloadSchema, { ...payload, code: 42 })).toBe(false);
  });

  it('astral-plane text survives a JSON encode/decode round trip', () => {
    // Surrogate-pair heavy: emoji (incl. ZWJ sequence), astral math alphanumerics.
    const text = '🧜🏽‍♀️ 𝔸𝕓𝒞 漢字 🤝';
    const chunk = { requestId: ulid, delta: text };
    assertFrame(ChatChunkPayloadSchema, chunk);
    const decoded: unknown = JSON.parse(JSON.stringify(chunk));
    if (!isFrame(ChatChunkPayloadSchema, decoded)) throw new Error('round trip lost the frame');
    expect(decoded.delta).toBe(text);
    // Sanity: the payload really does exercise surrogate pairs (UTF-16 units
    // outnumber Unicode scalar values).
    expect(text.length).toBeGreaterThan([...text].length);

    const event = {
      id: ulid,
      observedAt: 1787443200000,
      monotonicNs: 9007199254740991,
      source: 'accessibility',
      app: { bundleId: 'com.apple.Notes' },
      action: 'text_change',
      contentPolicy: 'allow',
      content: text,
    };
    assertFrame(ActivityEventSchema, event);
    const decodedEvent: unknown = JSON.parse(JSON.stringify(event));
    if (!isFrame(ActivityEventSchema, decodedEvent)) throw new Error('round trip lost the event');
    expect(decodedEvent.content).toBe(text);
  });

  it('optional string fields accept present-but-empty and absent alike', () => {
    const base = {
      id: ulid,
      observedAt: 1787443200000,
      source: 'workspace',
      app: { bundleId: 'com.apple.Safari' },
      action: 'app_focus',
      contentPolicy: 'metadata_only',
    };
    expect(frameErrors(ActivityEventSchema, { ...base, content: '' })).toEqual([]);
    expect(frameErrors(ActivityEventSchema, { ...base, content: null })).toEqual([]);
    expect(frameErrors(ActivityEventSchema, { ...base, window: { title: '' } })).toEqual([]);
    // Required strings must be present even when empty is legal.
    expect(frameErrors(ChatChunkPayloadSchema, { requestId: ulid, delta: '' })).toEqual([]);
    expect(frameErrors(ChatChunkPayloadSchema, { requestId: ulid }).length).toBeGreaterThan(0);
  });
});

describe('frameErrors / assertFrame message contract (R9-T5)', () => {
  const ulid = '01M0NP9G4GXXGYT7PYGFC5K5HV';
  const validEvent = {
    id: ulid,
    observedAt: 1787443200000,
    source: 'workspace',
    app: { bundleId: 'com.apple.Safari' },
    action: 'app_focus',
    contentPolicy: 'metadata_only',
  };

  it('assertFrame truncates to exactly the first five fragments', () => {
    // An empty object fails every required key → far more than five errors.
    const errors = frameErrors(ActivityEventSchema, {});
    expect(errors.length).toBeGreaterThanOrEqual(5);
    // Each fragment is "<path> <message>" with an absolute path.
    for (const error of errors) expect(error).toMatch(/^\/\S* \S/);

    let thrown: unknown;
    try {
      assertFrame(ActivityEventSchema, {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    const message = (thrown as TypeError).message;
    expect(message.startsWith('frame validation failed: ')).toBe(true);
    const fragments = message.slice('frame validation failed: '.length).split('; ');
    expect(fragments).toHaveLength(5); // slice(0, 5), never fewer or flooded
    for (const fragment of fragments) expect(errors).toContain(fragment);
  });

  it('envelope-level failures render the root path as "/"', () => {
    const errors = frameErrors(ClientHelloSchema, 42);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.startsWith('/ ')).toBe(true); // `e.path || '/'` branch
    expect(() => assertFrame(ClientHelloSchema, 42)).toThrow(TypeError);
    try {
      assertFrame(ClientHelloSchema, 42);
    } catch (err) {
      // Exactly one envelope error → one fragment, still rooted at "/".
      const fragments = ((err as TypeError).message).slice('frame validation failed: '.length);
      expect(fragments.split('; ')).toHaveLength(1);
      expect(fragments.startsWith('/ ')).toBe(true);
    }
  });

  it('isFrame narrows repeatedly on the same schema object and agrees with frameErrors', () => {
    expect(isFrame(ClientHelloSchema, { ...envelope, type: 'client_hello', protocolVersion: 1, appVersion: '0.1.0' })).toBe(true);
    expect(isFrame(ActivityEventSchema, validEvent)).toBe(true);
    expect(isFrame(ActivityEventSchema, validEvent)).toBe(true); // compiled-check cache hit
    expect(frameErrors(ActivityEventSchema, validEvent)).toEqual([]);

    const bad = { ...validEvent, id: 'not-a-ulid' };
    expect(isFrame(ActivityEventSchema, bad)).toBe(false);
    expect(isFrame(ActivityEventSchema, bad)).toBe(false);
    expect(frameErrors(ActivityEventSchema, bad).length).toBeGreaterThan(0);
  });
});
