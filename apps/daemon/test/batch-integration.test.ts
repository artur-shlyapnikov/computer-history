import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EventBatchAckSchema,
  ServerHelloSchema,
  StatusResultSchema,
  assertFrame,
  type EventBatch,
} from '@computer-history/protocol';

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

const FIXTURES_DIR = path.join(import.meta.dirname, '..', '..', '..', 'packages', 'protocol', 'fixtures');
const fixtureBatch = (): EventBatch =>
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'event-batch.json'), 'utf8')) as EventBatch;

/** Oversize-content event: one char beyond the 2048-char ingest bound. */
const OVERSIZE_CONTENT = 'x'.repeat(2049);

/** Fresh-timestamped batch: retention-safe counterpart to the static fixture
 * (startup retention purges raw_events older than 48h by observedAt, so any
 * assertion spanning a restart must use events that are young by construction). */
const freshBatch = (): EventBatch => {
  const base = {
    observedAt: Date.now() - 1_000,
    monotonicNs: 1_000,
    source: 'accessibility' as const,
    app: { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 7 },
    action: 'text_change' as const,
    target: { role: 'AXTextArea', identifier: 'body' },
    contentPolicy: 'allow' as const,
    content: 'restart durability probe',
  };
  return {
    protocolVersion: 1,
    messageId: ulid(),
    type: 'event_batch',
    sentAt: Date.now(),
    batchId: ulid(),
    events: [{ ...base, id: ulid() }, { ...base, id: ulid(), observedAt: Date.now() - 2_000 }],
  };
};

describe('daemon events.batch integration (real unix socket, temp home)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let socketPath: string;
  let socket: net.Socket;

  async function freshConnection(): Promise<void> {
    if (socket && !socket.destroyed) socket.destroy();
    socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello.value as never);
  }

  function sendBatch(batch: EventBatch): void {
    socket.write(encodeFrame(batch));
  }

  async function readAck(): Promise<{ batchId: string; accepted: number; duplicates: number; rejected: number }> {
    const frame = await readFrameUntil(socket, (value) => value.type === 'event_batch_ack');
    assertFrame(EventBatchAckSchema, frame.value as never);
    return frame.value as unknown as { batchId: string; accepted: number; duplicates: number; rejected: number };
  }

  /** status.get → db.rawEvents (proves what actually reached sqlite). */
  async function rawEventCount(): Promise<number> {
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'status.get',
        requestId: ulid(),
        params: {},
      }),
    );
    const response = await readFrame(socket);
    expect(response.value.ok).toBe(true);
    assertFrame(StatusResultSchema, response.value.result as never);
    return (response.value.result as { db: { rawEvents: number } }).db.rawEvents;
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-batch-itest-'));
    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
    await freshConnection();
  }, 20_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    if (socket && !socket.destroyed) socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('acks the shared fixture batch with exact counts and persists both events', async () => {
    const batch = fixtureBatch();
    sendBatch(batch);
    const ack = await readAck();
    expect(ack.batchId).toBe(batch.batchId);
    expect(ack).toEqual({ ...ack, accepted: 2, duplicates: 0, rejected: 0 });
    expect(await rawEventCount()).toBe(2);
  });

  it('counts a full resend of the same batch as duplicates with accepted=0', async () => {
    const batch = fixtureBatch();
    sendBatch(batch);
    const ack = await readAck();
    expect(ack.batchId).toBe(batch.batchId);
    expect(ack.accepted).toBe(0);
    expect(ack.duplicates).toBe(2);
    expect(ack.rejected).toBe(0);
    // idempotent: still exactly two stored rows
    expect(await rawEventCount()).toBe(2);
  });

  it('rejects privacy-invariant violations without storing them, and acks anyway', async () => {
    const good = {
      id: ulid(),
      observedAt: Date.now() - 10_000,
      monotonicNs: 1_000,
      source: 'accessibility' as const,
      app: { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 7 },
      action: 'text_change' as const,
      target: { role: 'AXTextArea', identifier: 'body' },
      contentPolicy: 'allow' as const,
      content: 'normal text under the bound',
    };
    const batch: EventBatch = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
      events: [
        // (a) secure-field policy with surviving content
        {
          ...good,
          id: ulid(),
          target: { role: 'AXTextField', subrole: 'AXSecureTextField', label: 'Password:' },
          contentPolicy: 'redacted_secure_field',
          content: 'hunter2',
        },
        // (b) typing_activity that leaked keystrokes
        { ...good, id: ulid(), source: 'input', action: 'typing_activity', content: 'typed secret' },
        // (c) content beyond the 2048-char bound
        { ...good, id: ulid(), content: OVERSIZE_CONTENT },
        good,
      ],
    };
    sendBatch(batch);
    const ack = await readAck();
    expect(ack.batchId).toBe(batch.batchId);
    expect(ack).toMatchObject({ accepted: 1, duplicates: 0, rejected: 3 });
    // only the one clean event was added
    expect(await rawEventCount()).toBe(3);

    // the rejected payloads must not be recoverable from the daemon log either
    const log = readFileSync(path.join(home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).not.toContain('hunter2');
    expect(log).not.toContain('typed secret');
    expect(log).toContain('"rejected":3');
  });

  it('keeps acked events across a graceful daemon restart; redelivery stays idempotent', async () => {
    // Durability is asserted via idempotent re-delivery of a FRESH batch rather
    // than absolute counts: startup retention (spec §3.22) legitimately purges
    // raw_events older than 48h on every daemon start, so static fixture rows
    // age out of any count that spans a restart. A surviving row makes the
    // resend count as a duplicate; a lost row would re-accept.
    const fresh = freshBatch();
    sendBatch(fresh);
    expect(await readAck()).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });

    expect(await stopDaemon(daemon.child)).toBe(0);
    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
    await freshConnection();

    sendBatch(fresh);
    expect(await readAck()).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
  });

  it('does not lose acked events even on a hard kill (WAL durability)', async () => {
    const durable: EventBatch = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
      events: [
        {
          id: ulid(),
          observedAt: Date.now() - 60_000,
          source: 'workspace',
          app: { bundleId: 'com.apple.Finder', name: 'Finder' },
          action: 'app_focus',
          contentPolicy: 'metadata_only',
        },
      ],
    };
    sendBatch(durable);
    expect(await readAck()).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });

    daemon.child.kill('SIGKILL');
    await new Promise<void>((resolve) => daemon.child.once('exit', () => resolve()));
    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
    await freshConnection();

    // WAL durability of the acked row, proven without absolute counts (startup
    // retention may legitimately purge stale fixture rows during this restart):
    // the exact batch re-delivers as a duplicate — INSERT OR IGNORE only
    // deduplicates against a row actually present in raw_events.
    sendBatch(durable);
    expect(await readAck()).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });
  }, 15_000);

  it('re-acks an unacked redelivered batch idempotently after reconnect (no data loss)', async () => {
    await freshConnection();
    const batch: EventBatch = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
      events: [
        {
          id: ulid(),
          observedAt: Date.now() - 5_000,
          source: 'workspace',
          app: { bundleId: 'com.apple.Finder', name: 'Finder' },
          action: 'app_focus',
          contentPolicy: 'metadata_only',
        },
        {
          id: ulid(),
          observedAt: Date.now() - 4_000,
          source: 'accessibility',
          app: { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 7 },
          action: 'text_change',
          target: { role: 'AXTextArea', identifier: 'body' },
          contentPolicy: 'allow',
          content: 'reconnect probe',
        },
      ],
    };
    sendBatch(batch);
    expect(await readAck()).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
    const stored = await rawEventCount();

    // Crash-style reconnect: the same ids arrive again on a fresh connection.
    await freshConnection();
    sendBatch(batch);
    expect(await readAck()).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
    expect(await rawEventCount()).toBe(stored);
  });

  it('rejects a malformed event_batch with error.bad_frame and closes', async () => {
    await freshConnection();
    const bad = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: 'not-a-ulid',
      events: [],
    };
    socket.write(encodeFrame(bad));
    const err = await readFrame(socket);
    expect(err.value.type).toBe('error');
    expect((err.value.error as { code: string }).code).toBe('error.bad_frame');
  });
});
