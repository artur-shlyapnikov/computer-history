import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import { clientHello, connect, encodeFrame, waitClose } from './helpers/ipc.js';
import { IpcServer, type IpcServerOptions } from '../src/ipc/server.js';
import { OpError, Router } from '../src/ipc/router.js';
import { CONSTANTS } from '../src/config.js';

/**
 * Regression tests for the round-7 reject-teardown findings (CE-1/CE-5):
 *
 * - CE-1: destroying a socket that still holds unread inbound data makes BSD
 *   emit RST instead of FIN, so the client loses the just-written error frame
 *   (probe experiment: single-write oversize delivered 0/30 with ECONNRESET
 *   30/30, while header-only or delayed-body oversize delivered 30/30). The
 *   reject path now flushes the error frame with a half-close (FIN ordered
 *   after the data) and only force-destroys after a bounded linger.
 * - CE-5: a poison header coalesced behind a valid request in ONE segment used
 *   to destroy the socket synchronously, before the sibling's void'd async
 *   dispatch continuation could write its reply (probe: 20/20 suppressed).
 *   Rejects now drain pending dispatches (bounded by REJECT_DRAIN_TIMEOUT_MS)
 *   before teardown.
 */
describe('IpcServer reject teardown', () => {
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

  async function start(opts: Partial<IpcServerOptions> = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-reject-teardown-'));
    const socketPath = path.join(home, 'history.sock');
    const server = new IpcServer({
      socketPath,
      router: new Router(logger),
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
      ...opts,
    } satisfies IpcServerOptions);
    await server.listen();
    teardowns.push(async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { socketPath, server };
  }

  async function handshaken(socketPath: string) {
    const socket = await connect(socketPath);
    const collector = collect(socket);
    socket.write(encodeFrame(clientHello()));
    await collector.waitFor('server_hello');
    return { socket, collector };
  }

  /**
   * CE-1's killer payload: header declares maxFrameBytes + 1 while body bytes
   * ride in the SAME write — at reject time unread data sits in the kernel,
   * so an immediate destroy() would RST away the reply.
   */
  function singleWriteOversize(): Buffer {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(CONSTANTS.maxFrameBytes + 1, 0);
    return Buffer.concat([header, Buffer.alloc(64, 0x41)]);
  }

  /** Poison header: declared length 0xFFFFFFFF, far beyond maxFrameBytes. */
  const POISON_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

  function requestFrame(requestId: string): Buffer {
    return encodeFrame({
      protocolVersion: 1,
      messageId: ulid(),
      type: 'request',
      sentAt: Date.now(),
      requestId,
      op: '__no_such_op__',
    });
  }

  /**
   * Valid minimal event_batch frame (shape mirrors text-sanitization's
   * makeEvent/makeBatch fixtures); answered by a registered batch handler.
   */
  function eventBatchFrame(batchId: string, messageId: string = ulid()): Buffer {
    return encodeFrame({
      protocolVersion: 1,
      messageId,
      type: 'event_batch',
      sentAt: Date.now(),
      batchId,
      events: [
        {
          id: ulid(),
          observedAt: 1_000_000,
          monotonicNs: 500,
          source: 'workspace',
          app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
          action: 'app_focus',
          contentPolicy: 'allow',
        },
      ],
    });
  }

  /** Router whose events.batch ingest deterministically acks one event. */
  function ackingRouter(): Router {
    const router = new Router(logger);
    router.registerBatch(() => ({ accepted: 1, duplicates: 0, rejected: 0 }));
    return router;
  }

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.clearAllMocks();
  });

  /** Timer-based delay; Promise.withResolvers needs lib ES2024, repo pins ES2023. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Linger override used by the hostile-peer test (matches its waits). */
  const LINGER_MS = 250;

  describe('CE-1: error frame survives a single-write oversize frame', () => {
    it('delivers error.bad_frame before close, deterministically over >=5 fresh connections', async () => {
      const { socketPath } = await start();
      for (let i = 0; i < 5; i++) {
        const socket = await connect(socketPath);
        const collector = collect(socket);
        socket.write(encodeFrame(clientHello()));
        await collector.waitFor('server_hello');

        socket.write(singleWriteOversize());

        // THE assertion: the reply arrives on this connection before close.
        const err = await collector.waitFor('error');
        expect(err.error).toMatchObject({ code: 'error.bad_frame' });
        expect(JSON.stringify(err.error)).toContain(`exceeds ${CONSTANTS.maxFrameBytes}`);
        await waitClose(socket);
      }
    });

    it('still answers a header-only oversize (no unread body bytes)', async () => {
      const { socketPath } = await start();
      const { socket, collector } = await handshaken(socketPath);

      const header = Buffer.alloc(4);
      header.writeUInt32BE(CONSTANTS.maxFrameBytes + 1, 0);
      socket.write(header);

      const err = await collector.waitFor('error');
      expect(err.error).toMatchObject({ code: 'error.bad_frame' });
      await waitClose(socket);
    });

    it('a non-reading oversize client cannot wedge the daemon (linger timer)', async () => {
      const { socketPath } = await start({ rejectLingerTimeoutMs: 250 });
      const hostile = await connect(socketPath);
      // Ignore the server's FIN: with half-open kept, only the linger timer
      // can reap this connection — exactly the fallback path under test.
      hostile.allowHalfOpen = true;
      const helloCollector = collect(hostile);
      hostile.write(encodeFrame(clientHello()));
      await helloCollector.waitFor('server_hello');
      helloCollector.stop();

      // Sends the violation, then never reads and never closes. The server
      // half-closes to flush the error frame, but must REAP the socket once
      // the linger deadline passes. A half-open peer observes nothing
      // spontaneously (Unix sockets have no unsolicited signal), so past the
      // linger window we poke the socket: I/O against the reaped peer must
      // fail with ECONNRESET/EPIPE or surface 'close'.
      hostile.write(singleWriteOversize());
      const reaped = new Promise<string>((resolve) => {
        hostile.once('error', (err: NodeJS.ErrnoException) => resolve(String(err.code ?? 'error')));
        hostile.once('close', () => resolve('close'));
      });
      await sleep(LINGER_MS + 250);
      expect(hostile.destroyed).toBe(false); // client stayed half-open throughout
      hostile.write(singleWriteOversize());
      expect(await reaped).toBeTruthy();

      // Daemon survived and serves a subsequent healthy connection end-to-end.
      const fresh = await handshaken(socketPath);
      const requestId = ulid();
      fresh.socket.write(requestFrame(requestId));
      const response = await fresh.collector.waitFor('response');
      expect(response.requestId).toBe(requestId);
    }, 15_000);
  });

  describe('CE-5: valid request coalesced with a poison header', () => {
    it("writes the valid request's response before the error/close", async () => {
      const { socketPath } = await start();
      const { socket, collector } = await handshaken(socketPath);

      const requestId = ulid();
      // ONE write: [valid request][poison header] — reject fires mid-pass
      // while the sibling dispatch's continuation is still pending.
      socket.write(Buffer.concat([requestFrame(requestId), POISON_HEADER]));

      const response = await collector.waitFor('response');
      expect(response.requestId).toBe(requestId);
      expect(response.ok).toBe(false); // unknown op -> not_found, but DELIVERED

      const err = await collector.waitFor('error');
      expect(err.error).toMatchObject({ code: 'error.bad_frame' });
      await waitClose(socket);
    });
  });

  describe('CE-5b: valid event_batch coalesced with a poison header', () => {
    it('delivers event_batch_ack before error.bad_frame over >=5 fresh connections', async () => {
      const { socketPath } = await start({ router: ackingRouter() });
      for (let i = 0; i < 5; i++) {
        const { socket, collector } = await handshaken(socketPath);

        const batchId = ulid();
        // ONE write: [valid event_batch][poison header] — the batch leg of
        // track() must hold the socket open until the ack continuation runs.
        socket.write(Buffer.concat([eventBatchFrame(batchId), POISON_HEADER]));

        const ack = await collector.waitFor('event_batch_ack');
        expect(ack.batchId).toBe(batchId);
        expect(ack).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });

        const err = await collector.waitFor('error');
        expect(err.error).toMatchObject({ code: 'error.bad_frame' });
        await waitClose(socket);
      }
    });

    it('a throwing batch handler still answers error.internal before error.bad_frame', async () => {
      const throwingRouter = new Router(logger);
      throwingRouter.registerBatch(() => {
        throw new Error('batch ingest exploded');
      });
      const { socketPath } = await start({ router: throwingRouter });
      const { socket, collector } = await handshaken(socketPath);

      socket.write(Buffer.concat([eventBatchFrame(ulid()), POISON_HEADER]));

      // Both replies are type 'error', so order is asserted from the full
      // delivery log after close — the tracked handler failure must land
      // first, exactly like the success path above.
      await waitClose(socket);
      const errorCode = (f: Record<string, unknown>): unknown =>
        typeof f.error === 'object' && f.error !== null && 'code' in f.error
          ? f.error.code
          : undefined;
      const errors = collector.frames.filter((f) => f.type === 'error');
      const codes = errors.map((f) => errorCode(f));
      expect(codes).toEqual(['error.internal', 'error.bad_frame']);
      expect(errors[0]).toMatchObject({
        type: 'error',
        // Round-31 batch masking: handler internals stay server-side; the
        // wire carries the generic message (code order asserted above).
        error: { message: 'internal error' },
      });
    });
  });

  describe('drain timeout bound (injectable REJECT_DRAIN_TIMEOUT_MS)', () => {
    it('force-proceeds after drainTimeoutMs when a coalesced handler stays parked', async () => {
      let releaseHandler: () => void = () => {};
      const parked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const parkedRouter = new Router(logger);
      parkedRouter.register('status.get', async () => {
        await parked;
        // Unreached: the bounded drain force-proceeds while this is still
        // parked; a throw keeps the handler's erased result type honest.
        throw new Error('parked status.get released after teardown');
      });
      const DRAIN_MS = 100;
      const { socketPath } = await start({
        router: parkedRouter,
        rejectDrainTimeoutMs: DRAIN_MS,
        rejectLingerTimeoutMs: 250,
      });
      const { socket, collector } = await handshaken(socketPath);

      const startedAt = Date.now();
      // ONE write: [request handled by the parked handler][poison header].
      socket.write(
        Buffer.concat([
          encodeFrame({
            protocolVersion: 1,
            messageId: ulid(),
            type: 'request',
            sentAt: Date.now(),
            requestId: ulid(),
            op: 'status.get',
          }),
          POISON_HEADER,
        ]),
      );

      // The parked handler cannot settle, so the bounded drain — not the
      // handler — ends the grace window: the reject still goes out and the
      // socket closes instead of wedging forever.
      const err = await collector.waitFor('error');
      expect(err.error).toMatchObject({ code: 'error.bad_frame' });
      await waitClose(socket, DRAIN_MS * 30);

      // Node timers fire no earlier than their deadline, so observing close
      // proves teardown waited out the full drain window (deadline-poll on
      // the close event; no fixed sleep).
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DRAIN_MS);

      releaseHandler();

      // Daemon stayed healthy through the forced teardown: a fresh connection
      // completes handshake and request end-to-end.
      const fresh = await handshaken(socketPath);
      const requestId = ulid();
      fresh.socket.write(requestFrame(requestId));
      const response = await fresh.collector.waitFor('response');
      expect(response.requestId).toBe(requestId);
    }, 15_000);
  });

  describe('batch refusals echo the batch messageId (routable waiter)', () => {
    it('no-handler refusal echoes messageId and leaves the connection open', async () => {
      // Bare Router: dispatchBatch answers error.internal without touching
      // ingest. Before the echo fix this carried a fresh messageId no waiter
      // could route, hanging the batch until its reply timeout.
      const { socketPath } = await start();
      const { socket, collector } = await handshaken(socketPath);
      const messageId = ulid();
      socket.write(eventBatchFrame(ulid(), messageId));
      const err = await collector.waitFor('error');
      expect(err.messageId).toBe(messageId);
      expect(err.error).toMatchObject({
        code: 'error.internal',
        message: 'no events.batch handler registered',
      });
      // A refusal is not a violation: the connection stays usable.
      expect(socket.destroyed).toBe(false);
    });

    it('disk-pressure refusal echoes messageId as error.disk_pressure', async () => {
      const pressured = new Router(logger);
      pressured.registerBatch(() => {
        throw new OpError('error.disk_pressure', 'paused');
      });
      const { socketPath } = await start({ router: pressured });
      const { socket, collector } = await handshaken(socketPath);
      const messageId = ulid();
      socket.write(eventBatchFrame(ulid(), messageId));
      const err = await collector.waitFor('error');
      expect(err.messageId).toBe(messageId);
      expect(err.error).toMatchObject({ code: 'error.disk_pressure', message: 'paused' });
      expect(socket.destroyed).toBe(false);
    });

    it('throwing-handler refusal echoes messageId with the masked message', async () => {
      const throwingRouter = new Router(logger);
      throwingRouter.registerBatch(() => {
        throw new Error('batch ingest exploded');
      });
      const { socketPath } = await start({ router: throwingRouter });
      const { socket, collector } = await handshaken(socketPath);
      const messageId = ulid();
      socket.write(eventBatchFrame(ulid(), messageId));
      const err = await collector.waitFor('error');
      expect(err.messageId).toBe(messageId);
      // Round-31 masking: internals stay server-side (see CE-5b above).
      expect(err.error).toMatchObject({ code: 'error.internal', message: 'internal error' });
      expect(socket.destroyed).toBe(false);
    });
  });
});
