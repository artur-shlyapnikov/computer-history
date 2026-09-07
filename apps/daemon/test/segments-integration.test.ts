import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EventBatchAckSchema,
  SegmentsListResultSchema,
  ServerHelloSchema,
  StatusResultSchema,
  assertFrame,
  type ActivityEvent,
  type EventBatch,
} from '@computer-history/protocol';

import { coalesceEvents, type CoalescedStep } from '../src/processing/event-coalescer.js';

import {
  clientHello,
  connect,
  encodeFrame,
  readFrame,
  readFrameUntil,
  startDaemon,
  stopDaemon,
  type DaemonProcess,
} from './helpers/ipc.js';

const HOUR = 3_600_000;
/** All capture timestamps live an hour in the past: safely below the 2000ms watermark. */
const BASE = Date.now() - HOUR;

let seq = 0;
function makeEvent(
  observedAt: number,
  overrides: Partial<ActivityEvent> & { app?: ActivityEvent['app'] },
): ActivityEvent {
  seq += 1;
  return {
    id: ulid(Math.max(observedAt, 1)).slice(0, 22) + String(seq).padStart(4, '0'),
    observedAt,
    monotonicNs: (observedAt - BASE) * 1_000_000,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    window: { title: 'Doc' },
    action: 'typing_activity',
    contentPolicy: 'metadata_only',
    ...overrides,
  };
}

const SAFARI = { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 };
const SLACK = { bundleId: 'rebel.slack', name: 'Slack', pid: 4242 };
const TERMINAL = { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 7 };

/** Realistic mixed activity: typing burst, scrolls, click+focus collapse, three app switches. */
function batchA(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  events.push(makeEvent(BASE + 0, { action: 'app_focus', app: SAFARI, target: { role: 'AXApplication', label: 'Safari' } }));
  events.push(makeEvent(BASE + 1_000, { action: 'app_focus', app: SLACK, target: { role: 'AXApplication', label: 'Slack' } }));
  // 10-second typing burst in Slack: 20 raw keyboard events that must coalesce
  // into a single type step (≤2 allowed by acceptance; exactly 1 here).
  for (let i = 0; i < 20; i += 1) {
    events.push(makeEvent(BASE + 2_000 + i * 526, { app: SLACK, window: { title: '#eng — Slack' } }));
  }
  events.push(makeEvent(BASE + 13_000, { action: 'app_focus', app: TERMINAL, target: { role: 'AXApplication', label: 'Terminal' } }));
  const sendButton = { role: 'AXButton', label: 'Send' };
  events.push(
    makeEvent(BASE + 14_000, {
      action: 'click',
      app: TERMINAL,
      window: { title: 'deploy.sh — Terminal' },
      target: sendButton,
    }),
  );
  events.push(
    makeEvent(BASE + 14_200, {
      action: 'focus_change',
      app: TERMINAL,
      window: { title: 'deploy.sh — Terminal' },
      target: sendButton,
    }),
  );
  for (let i = 0; i < 4; i += 1) {
    events.push(
      makeEvent(BASE + 15_000 + i * 1_000, {
        action: 'scroll',
        window: { title: 'Feed' },
        target: { role: 'AXScrollArea' },
      }),
    );
  }
  return events;
}

/** Post-idle-gap batch (sent reversed to prove out-of-order tolerance). */
function batchB(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  events.push(
    makeEvent(BASE + 400_000, { action: 'app_focus', target: { role: 'AXApplication', label: 'Safari' } }),
  );
  events.push(
    makeEvent(BASE + 401_000, {
      action: 'text_change',
      window: { title: 'Compose' },
      target: { role: 'AXTextArea', identifier: 'body' },
      content: 'first draft',
      contentPolicy: 'allow',
    }),
  );
  events.push(
    makeEvent(BASE + 405_000, {
      action: 'text_change',
      window: { title: 'Compose' },
      target: { role: 'AXTextArea', identifier: 'body' },
      content: null,
      contentPolicy: 'metadata_only',
    }),
  );
  events.push(
    makeEvent(BASE + 409_500, {
      action: 'text_change',
      window: { title: 'Compose' },
      target: { role: 'AXTextArea', identifier: 'body' },
      content: 'final draft',
      contentPolicy: 'allow',
    }),
  );
  events.push(
    makeEvent(BASE + 410_000, {
      action: 'shortcut',
      window: { title: 'Compose' },
      target: { label: '⌘S' },
    }),
  );
  return [...events].reverse();
}

function wireBatch(events: ActivityEvent[]): EventBatch {
  return {
    protocolVersion: 1,
    messageId: ulid(),
    type: 'event_batch',
    sentAt: Date.now(),
    batchId: ulid(),
    events,
  };
}

/** Expected semantic steps for the whole session, derived with the pure coalescer. */
function expectedSteps(): Array<Omit<CoalescedStep, 'firstEventId' | 'lastEventId' | 'eventCount'>> {
  const all = [...batchA(), ...batchB()].sort((a, b) => a.observedAt - b.observedAt);
  return coalesceEvents(all).map(({ action, appBundleId, appName, targetRole, target, text, startedAtMs, endedAtMs }) => ({
    action,
    appBundleId,
    appName,
    targetRole,
    target,
    text,
    startedAtMs,
    endedAtMs,
  }));
}

describe('end-to-end pipeline over the real unix socket (events.batch → watermark → coalescer → segmenter)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let socket: net.Socket;

  async function freshConnection(): Promise<void> {
    socket = await connect(daemon.socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello.value);
  }

  async function sendBatch(events: ActivityEvent[], expectAccepted: number, expectDuplicates = 0): Promise<void> {
    socket.write(encodeFrame(wireBatch(events)));
    const ack = await readFrameUntil(socket, (value) => value.type === 'event_batch_ack');
    assertFrame(EventBatchAckSchema, ack.value);
    const frame = ack.value as unknown as { batchId: string; accepted: number; duplicates: number; rejected: number };
    expect(frame.accepted).toBe(expectAccepted);
    expect(frame.duplicates).toBe(expectDuplicates);
    expect(frame.rejected).toBe(0);
  }

  async function request<T>(op: string, params: Record<string, unknown>): Promise<T> {
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op,
        requestId: ulid(),
        params,
      }),
    );
    for (;;) {
      const frame = await readFrame(socket);
      const value = frame.value;
      if (value.type === 'response') return value.result as T;
      // Skip unrelated server-pushed events (none expected yet, be liberal anyway).
    }
  }

  /** Polls until the debounced watermark sweep has produced the wanted shape. */
  async function pollUntil<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    let last: T = await probe();
    while (!predicate(last)) {
      if (Date.now() > deadline) throw new Error(`condition not reached: ${what}`);
      await new Promise((r) => setTimeout(r, 250));
      last = await probe();
    }
    return last;
  }

  interface SegmentView {
    id: string;
    startedAtMs: number;
    endedAtMs: number | null;
    state: string;
    stepCount: number;
    steps: Array<{
      ordinal: number;
      action: string;
      appBundleId: string;
      appName: string | null;
      target: string | null;
      targetRole: string | null;
      text: string | null;
      startedAtMs: number;
      endedAtMs: number;
    }>;
  }

  async function listSegments(): Promise<SegmentView[]> {
    const result = await request<{ segments: SegmentView[] }>('segments.list', {});
    assertFrame(SegmentsListResultSchema, { segments: result.segments });
    return result.segments;
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-segments-e2e-'));
    daemon = startDaemon(home);
    await daemon.ready;
    await freshConnection();
  }, 20_000);

  afterAll(async () => {
    socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('pushes mixed batches, tolerates duplicates and out-of-order arrival, and builds the golden timeline', async () => {
    const A = batchA();
    const B = batchB();
    await sendBatch(A, A.length);
    await sendBatch(B, B.length);

    // Duplicate redelivery of batch A: fully idempotent, nothing new stored.
    await sendBatch([...A].reverse(), 0, A.length);

    const expected = expectedSteps();
    const segments = await pollUntil(
      listSegments,
      (segs) =>
        segs.length === 2 &&
        segs[0]?.stepCount === 3 &&
        segs[1]?.stepCount === 6,
      'two segments with 6 and 3 steps',
    );

    // Newest first: [B-segment (open), A-segment (closed by idle ≥300000ms)].
    const newer = segments[0]!;
    const older = segments[1]!;
    expect(older.state).toBe('finalized');
    expect(older.startedAtMs).toBe(BASE);
    expect(older.endedAtMs).toBe(BASE + 18_000); // last activity before the idle gap
    expect(newer.state).toBe('open');

    // The 10s typing burst collapses to exactly one type step, not 50.
    const burst = older.steps.filter((s) => s.action === 'type');
    expect(burst).toHaveLength(1);
    expect(burst[0]!.endedAtMs - burst[0]!.startedAtMs).toBeLessThanOrEqual(10_000);

    // Click + focus within 500ms collapsed into a single click step.
    const clicks = older.steps.filter((s) => s.action === 'click');
    expect(clicks).toHaveLength(1);

    // Safari→Slack→Terminal switches survive as distinct switch_app steps.
    const switches = older.steps.filter((s) => s.action === 'switch_app');
    expect(switches.map((s) => s.appName)).toEqual(['Safari', 'Slack', 'Terminal']);

    // Golden equality: flattened steps match the pure coalescer output field by
    // field, ordinals contiguous from 1 within each segment.
    const flat = [...older.steps, ...newer.steps];
    const actual = flat.map((s) => ({
      action: s.action,
      appBundleId: s.appBundleId,
      appName: s.appName,
      targetRole: s.targetRole,
      target: s.target,
      text: s.text,
      startedAtMs: s.startedAtMs,
      endedAtMs: s.endedAtMs,
    }));
    expect(actual).toEqual(expected);
    for (const segment of [older, newer]) {
      expect(segment.steps.map((s) => s.ordinal)).toEqual(segment.steps.map((_, i) => i + 1));
    }
  }, 30_000);

  it('exposes the closed segment summarize job through status.get queue counters', async () => {
    const status = await request<Record<string, unknown>>('status.get', {});
    assertFrame(StatusResultSchema, { ...status, diskFreeBytes: 0 });
    const queue = status.queue as { pending: number };
    expect(queue.pending).toBeGreaterThanOrEqual(1); // summarize_segment for segment #1
    const dbCounts = status.db as { segments: number; steps: number };
    expect(dbCounts.segments).toBe(2);
    expect(dbCounts.steps).toBe(9); // 6 + 3 golden steps
  });

  it('finalizes the open segment and persists processed marks + pending summarize jobs on graceful shutdown', async () => {
    expect(await stopDaemon(daemon.child)).toBe(0);

    // Daemon owns the only writer connection; safe to inspect the file now.
    const db = new Database(path.join(home, 'data', 'history.db'), { readonly: true });
    try {
      // Every raw event is marked processed (watermark pipeline consumed it).
      const unprocessed = db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NULL').get() as { n: number };
      expect(unprocessed.n).toBe(0);

      // Both segments finalized: the idle-closed one and the shutdown-finalized one.
      const segments = db.prepare('SELECT id, state, started_at_ms, ended_at_ms FROM activity_segments ORDER BY started_at_ms').all() as Array<{
        id: string;
        state: string;
        started_at_ms: number;
        ended_at_ms: number | null;
      }>;
      expect(segments.map((s) => s.state)).toEqual(['finalized', 'finalized']);
      expect(segments[1]?.ended_at_ms).toBe(BASE + 410_000); // last activity, not shutdown wall time

      // Exactly one pending summarize_segment job per finalized segment, with a
      // bidirectional dedupe proof: each segment points at exactly the pending
      // job whose payload names it, and vice versa.
      const jobs = db
        .prepare("SELECT id, type, state, payload_json FROM jobs WHERE type = 'summarize_segment'")
        .all() as Array<{ id: string; state: string; payload_json: string }>;
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((j) => j.state))).toEqual(new Set(['pending']));
      const jobIdByPayloadSegment = new Map(
        jobs.map((j) => [(JSON.parse(j.payload_json) as { segmentId: string }).segmentId, j.id]),
      );
      expect(jobIdByPayloadSegment.size).toBe(2);
      for (const segment of segments) {
        expect(jobIdByPayloadSegment.get(segment.id)).not.toBeUndefined();
      }
      const links = db.prepare('SELECT id, summarize_job_id FROM activity_segments').all() as Array<{
        id: string;
        summarize_job_id: string | null;
      }>;
      for (const link of links) {
        expect(link.summarize_job_id).not.toBeNull();
        expect(jobIdByPayloadSegment.get(link.id)).toBe(link.summarize_job_id);
      }
    } finally {
      db.close();
    }
  }, 15_000);
});
