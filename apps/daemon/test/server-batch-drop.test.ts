import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import {
  clientHello,
  connect,
  encodeFrame,
  readFrameUntil,
  waitClose,
} from './helpers/ipc.js';
import { IpcServer, type IpcServerOptions } from '../src/ipc/server.js';
import { Router, type BatchHandler } from '../src/ipc/router.js';
import type { ActivityEvent } from '@computer-history/protocol';

/**
 * Regression tests for the round-6 batch-drop findings (R1/R2):
 *
 * - R1: mid-size event_batch frames (hundreds of events, tens of KB — far
 *   under maxFrameBytes) must get exactly one reply over a real socket,
 *   including when the frame arrives split across chunk boundaries;
 * - R2: the frame-shape verdict is deterministic and layered — shape is
 *   decided by envelope + type only, so value-level violations (edge-case
 *   ids) can never flip a well-formed batch into 'unknown frame shape', and
 *   identical bytes always produce an identical verdict;
 * - every dispatched frame gets exactly one reply even when ack construction
 *   itself fails (no silent unhandled-rejection loss).
 */
describe('IpcServer batch reply guarantees', () => {
  const logger = { log: vi.fn(), pruneOld: () => 0 };

  /** Collects every framed payload a socket receives; can await by type. */
  function collect(socket: net.Socket) {
    const frames: Record<string, unknown>[] = [];
    const waiters: Array<{ type: string; resolve: (frame: Record<string, unknown>) => void }> = [];
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<
          string,
          unknown
        >;
        buffer = buffer.subarray(4 + length);
        frames.push(frame);
        const waiterIndex = waiters.findIndex((w) => w.type === frame.type);
        if (waiterIndex !== -1) waiters.splice(waiterIndex, 1)[0]!.resolve(frame);
      }
    };
    socket.on('data', onData);
    return {
      frames,
      waitFor(type: string): Promise<Record<string, unknown>> {
        const existing = frames.find((f) => f.type === type);
        if (existing !== undefined) return Promise.resolve(existing);
        return new Promise((resolve) => {
          waiters.push({ type, resolve });
        });
      },
      stop: () => socket.off('data', onData),
    };
  }

  const teardowns: Array<() => Promise<void>> = [];

  function start(batchHandler?: BatchHandler) {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-batch-drop-'));
    const socketPath = path.join(home, 'history.sock');
    const router = new Router(logger);
    if (batchHandler) router.registerBatch(batchHandler);
    const server = new IpcServer({
      socketPath,
      router,
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
    } satisfies IpcServerOptions);
    const done = server.listen().then(() => socketPath);
    teardowns.push(async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    });
    return done;
  }

  async function handshaken(socketPath: string) {
    const socket = await connect(socketPath);
    const collector = collect(socket);
    socket.write(encodeFrame(clientHello()));
    await collector.waitFor('server_hello');
    return { socket, collector };
  }

  /** Canonical ULID for generated events. */
  function eventId(timeMs: number): string {
    const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let s = '';
    let x = Math.max(1, Math.floor(timeMs));
    for (let i = 0; i < 10; i++) {
      s = ENC[x % 32] + s;
      x = Math.floor(x / 32);
    }
    let r = '';
    for (let i = 0; i < 16; i++) r += ENC[Math.floor(Math.random() * 32)];
    return s + r;
  }

  /**
   * R2's clamped-timestamp id pattern: timestamp portion collapsed to
   * '1' + zeros, randomness in the tail. Wire-valid per the Ulid pattern.
   */
  function clampedId(): string {
    const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let r = '';
    for (let i = 0; i < 16; i++) r += ENC[Math.floor(Math.random() * 32)];
    return `1${'0'.repeat(9)}${r}`;
  }

  function makeEvents(n: number, idOf: (i: number) => string): ActivityEvent[] {
    return Array.from({ length: n }, (_, i): ActivityEvent => ({
      id: idOf(i),
      observedAt: Date.now() - 120000 + i,
      source: 'workspace',
      app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 1000 + (i % 50) },
      window: { title: `Doc ${Math.floor(i / 100)}` },
      action: i % 5 === 0 ? 'click' : 'text_change',
      contentPolicy: 'allow',
      content: i % 5 === 0 ? undefined : `note ${i}`,
    }));
  }

  function batchFrame(events: ActivityEvent[], overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
      events,
      ...overrides,
    };
  }

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.clearAllMocks();
  });

  describe('R1: mid-size batches always get exactly one reply', () => {
    it('acks a 500-event (~100KB) batch with accepted=500 over a real socket', async () => {
      const socketPath = await start((batch) => ({
        accepted: batch.events.length,
        duplicates: 0,
        rejected: 0,
      }));
      const a = await handshaken(socketPath);

      const events = makeEvents(500, (i) => eventId(Date.now() - 120000 - i));
      a.socket.write(encodeFrame(batchFrame(events)));

      const ack = await a.collector.waitFor('event_batch_ack');
      expect(ack.batchId).toBeTypeOf('string');
      expect(ack.accepted).toBe(500);
      expect(ack.duplicates).toBe(0);
      expect(ack.rejected).toBe(0);

      // Exactly one reply arrived for the batch.
      expect(a.collector.frames.filter((f) => f.type === 'event_batch_ack')).toHaveLength(1);
      expect(a.collector.frames.filter((f) => f.type === 'error')).toHaveLength(0);

      // The connection keeps serving subsequent requests on the same socket.
      a.socket.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: ulid(),
          type: 'request',
          sentAt: Date.now(),
          requestId: ulid(),
          op: '__no_such_op__',
        }),
      );
      const res = await readFrameUntil(a.socket, (f) => f.type === 'response');
      expect(res.value.ok).toBe(false);
      expect(res.value.error).toMatchObject({ code: 'error.not_found' });
      a.collector.stop();
    });

    it('acks a mid-size batch delivered split across chunk boundaries', async () => {
      const socketPath = await start((batch) => ({
        accepted: batch.events.length,
        duplicates: 0,
        rejected: 0,
      }));
      const a = await handshaken(socketPath);

      const events = makeEvents(300, (i) => eventId(Date.now() - 120000 - i));
      const whole = encodeFrame(batchFrame(events));
      // Split inside the length prefix AND mid-body: exercises buffer
      // accumulation across at least three data events.
      a.socket.write(whole.subarray(0, 3));
      a.socket.write(whole.subarray(3, 40000));
      a.socket.write(whole.subarray(40000));

      const ack = await a.collector.waitFor('event_batch_ack');
      expect(ack.accepted).toBe(300);
      expect(a.collector.frames.filter((f) => f.type === 'event_batch_ack')).toHaveLength(1);
      a.collector.stop();
    });

    it('answers each of several pipelined mid-size batches with its own ack', async () => {
      const seenSizes: number[] = [];
      const socketPath = await start((batch) => {
        seenSizes.push(batch.events.length);
        return { accepted: batch.events.length, duplicates: 0, rejected: 0 };
      });
      const a = await handshaken(socketPath);

      // Three ~30-70KB frames written back-to-back in one burst.
      const frames = [100, 200, 300].map((n) =>
        encodeFrame(batchFrame(makeEvents(n, (i) => eventId(Date.now() - 120000 - n - i)))),
      );
      a.socket.write(Buffer.concat(frames));

      await a.collector.waitFor('event_batch_ack');
      // Wait until all three acks drained (poll the collector).
      for (let i = 0; i < 100 && a.collector.frames.length < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(seenSizes).toEqual([100, 200, 300]);
      expect(a.collector.frames.filter((f) => f.type === 'event_batch_ack')).toHaveLength(3);
      a.collector.stop();
    });
  });

  describe('R2: deterministic, layered verdicts', () => {
    it("reports a value-invalid mid-size batch as 'malformed event_batch', never 'unknown frame shape'", async () => {
      const socketPath = await start();
      const a = await handshaken(socketPath);

      const events = makeEvents(300, (i) => eventId(Date.now() - 120000 - i));
      a.socket.write(encodeFrame(batchFrame(events, { batchId: `${ulid()}Z` })));

      const err = await readFrameUntil(a.socket, (f) => f.type === 'error');
      expect(err.value.error).toMatchObject({
        code: 'error.bad_frame',
        message: 'malformed event_batch',
      });
      await waitClose(a.socket);
    });

    it('gives edge-case clamped-timestamp event ids the same verdict as ordinary ids', async () => {
      const socketPath = await start((batch) => ({
        accepted: batch.events.length,
        duplicates: 0,
        rejected: 0,
      }));
      const base = Date.now() - 120000;

      const normal = await handshaken(socketPath);
      normal.socket.write(encodeFrame(batchFrame(makeEvents(50, () => eventId(base)))));
      const normalAck = await normal.collector.waitFor('event_batch_ack');

      const clamped = await handshaken(socketPath);
      clamped.socket.write(encodeFrame(batchFrame(makeEvents(50, clampedId))));
      const clampedAck = await clamped.collector.waitFor('event_batch_ack');

      // Identical structure → identical verdict class; the id edge values did
      // not flip the frame-shape verdict.
      expect(clampedAck.type).toBe(normalAck.type);
      expect(clampedAck.accepted).toBe(50);
      expect(clampedAck.rejected).toBe(0);
      expect(clamped.collector.frames.filter((f) => f.type === 'error')).toHaveLength(0);
      normal.collector.stop();
      clamped.collector.stop();
    });

    it('produces byte-identical verdicts for identical malformed bytes across connections', async () => {
      const socketPath = await start();

      const events = makeEvents(200, (i) => eventId(Date.now() - 120000 - i));
      const frameBytes = encodeFrame(batchFrame(events, { batchId: `${ulid()}Z` }));

      const verdicts: Array<{ code: unknown; message: unknown }> = [];
      for (let run = 0; run < 2; run++) {
        const c = await handshaken(socketPath);
        c.socket.write(frameBytes); // literally the same bytes both runs
        const err = await readFrameUntil(c.socket, (f) => f.type === 'error');
        verdicts.push({
          code: (err.value.error as Record<string, unknown>).code,
          message: (err.value.error as Record<string, unknown>).message,
        });
        await waitClose(c.socket);
      }
      expect(verdicts).toHaveLength(2);
      expect(verdicts[1]).toEqual(verdicts[0]);
      expect(verdicts[0]?.code).toBe('error.bad_frame');
    });
  });

  describe('exactly-one-reply under handler failure', () => {
    it('replies error.internal when ack construction throws instead of losing the batch silently', async () => {
      // Counts that cannot satisfy EventBatchAckSchema (NaN is not an integer)
      // force the constructed ack to fail its own schema check.
      const socketPath = await start(() => ({
        accepted: Number.NaN,
        duplicates: 0,
        rejected: 0,
      }));
      const a = await handshaken(socketPath);

      const events = makeEvents(10, (i) => eventId(Date.now() - 120000 - i));
      a.socket.write(encodeFrame(batchFrame(events)));

      const err = await readFrameUntil(a.socket, (f) => f.type === 'error');
      expect(err.value.error).toMatchObject({ code: 'error.internal' });
      // The failure reply never leaves a silent gap, and the socket survives.
      expect(a.socket.destroyed).toBe(false);
      a.socket.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: ulid(),
          type: 'request',
          sentAt: Date.now(),
          requestId: ulid(),
          op: '__no_such_op__',
        }),
      );
      const res = await readFrameUntil(a.socket, (f) => f.type === 'response');
      expect(res.value.error).toMatchObject({ code: 'error.not_found' });
      expect(logger.log).toHaveBeenCalledWith(
        'error',
        'ipc',
        'frame handler failed',
        expect.anything(),
      );
      a.collector.stop();
    });
  });
});
