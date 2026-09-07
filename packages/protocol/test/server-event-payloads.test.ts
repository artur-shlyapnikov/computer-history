import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertFrame,
  ChatChunkPayloadSchema,
  ChatErrorPayloadSchema,
  frameErrors,
  QueueUpdatePayloadSchema,
  RecordingStatePayloadSchema,
  ChangedPayloadSchema,
  ServerEventFrameSchema,
  ServerEventKinds,
  ServerEventPayloads,
} from '../src/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function readFixture(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, relative), 'utf8')) as unknown;
}

/** fixture file → server-event `kind` whose payload schema must accept the frame's payload */
const payloadFixtures: Record<string, keyof typeof ServerEventPayloads> = {
  'event.chat-chunk.json': 'chat_chunk',
  'event.chat-done.json': 'chat_done',
  'event.chat-error.json': 'chat_error',
  'event.queue-update.json': 'queue_update',
  'event.recording-state.json': 'recording_state',
};

describe('golden event payloads satisfy their per-kind schemas', () => {
  for (const [file, kind] of Object.entries(payloadFixtures)) {
    it(`validates the ${kind} payload from ${file}`, () => {
      const frame = readFixture(file) as { kind: string; payload: unknown };
      expect(frame.kind).toBe(kind);
      expect(frameErrors(ServerEventPayloads[kind], frame.payload), `${kind} payload failed`).toEqual(
        [],
      );
    });
  }
});

describe('per-kind payload schemas reject malformed payloads', () => {
  it('rejects a chat_chunk payload missing delta', () => {
    const chunk = readFixture('event.chat-chunk.json') as {
      kind: string;
      payload: Record<string, unknown>;
    };
    delete chunk.payload.delta;
    expect(frameErrors(ChatChunkPayloadSchema, chunk.payload).length).toBeGreaterThan(0);
    expect(() => assertFrame(ChatChunkPayloadSchema, chunk.payload)).toThrow(TypeError);
  });

  it('rejects a chat_error payload with a non-string code', () => {
    const err = readFixture('event.chat-error.json') as {
      kind: string;
      payload: Record<string, unknown>;
    };
    err.payload.code = 42;
    expect(frameErrors(ChatErrorPayloadSchema, err.payload).length).toBeGreaterThan(0);
  });

  // PINNED CURRENT BEHAVIOR: TypeBox's Type.Integer() is the JSON-Schema
  // "integer" keyword — negative values pass. Negative-count clamping lives
  // in the recorder's applyQueueUpdate, not in the wire schema. If this
  // assertion starts failing, the schema was tightened; make that a
  // deliberate protocol decision (and update consumers), not an accident.
  it('accepts a negative pendingJobs count (schema does not clamp signs)', () => {
    expect(frameErrors(QueueUpdatePayloadSchema, { pendingJobs: -1 })).toEqual([]);
  });

  it('rejects an unknown recording state but accepts paused with reason', () => {
    expect(frameErrors(RecordingStatePayloadSchema, { state: 'bogus' }).length).toBeGreaterThan(0);
    expect(
      frameErrors(RecordingStatePayloadSchema, { state: 'paused', reason: 'disk_pressure' }),
    ).toEqual([]);
  });

  // PINNED CURRENT BEHAVIOR: ChangedPayloadSchema is Type.Object({}) without
  // additionalProperties:false, so TypeBox's default object semantics ACCEPT
  // unknown properties. This documents the looseness — tightening it later
  // must be a deliberate protocol decision.
  it('changed-kind payloads tolerate unknown properties today', () => {
    expect(frameErrors(ChangedPayloadSchema, { any: 'thing' })).toEqual([]);
    expect(frameErrors(ChangedPayloadSchema, {})).toEqual([]);
  });
});

describe('server-event envelope vocabulary', () => {
  // PINNED CURRENT BEHAVIOR: ServerEventFrameSchema declares kind as
  // Type.String(), so out-of-vocabulary kinds pass envelope validation.
  // Consumers dispatch on ServerEventKinds themselves. Tightening the
  // envelope to a literal union is a protocol decision, not a test fix.
  it('envelope validation accepts an out-of-vocabulary kind today', () => {
    const envelope = {
      protocolVersion: 1,
      messageId: '01M0PCXXGS8P3T9559N9P8A8H7',
      type: 'event',
      sentAt: 1787443203050,
      kind: 'totally_bogus',
      payload: {},
    };
    expect(frameErrors(ServerEventFrameSchema, envelope)).toEqual([]);
    expect((ServerEventKinds as readonly string[]).includes('totally_bogus')).toBe(false);
  });

  it('maps every kind in the vocabulary to a payload schema (no drift)', () => {
    for (const kind of ServerEventKinds) {
      expect(ServerEventPayloads[kind], `missing payload schema for ${kind}`).toBeDefined();
    }
    expect(Object.keys(ServerEventPayloads).sort()).toEqual([...ServerEventKinds].sort());
  });
});
