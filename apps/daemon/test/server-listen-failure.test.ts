import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import { clientHello, connect, encodeFrame, readFrame, readFrameUntil, waitClose } from './helpers/ipc.js';
import { IpcServer, type IpcServerOptions } from '../src/ipc/server.js';
import { Router } from '../src/ipc/router.js';

/**
 * Round-29 regression pins:
 *
 * - listen() failure leak: a bind failure after net.createServer used to
 *   abandon the server with its one-shot 'error' listener already consumed,
 *   so a late async 'error' emission could crash the process (unhandled
 *   'error' event) while this.server kept pointing at the corpse. The fix
 *   installs a persistent logging 'error' guard BEFORE awaiting listen and
 *   tears the abandoned instance down on rejection.
 * - settleWithin drain-timer leak: when Promise.allSettled won the race, the
 *   drain setTimeout was neither cleared nor unref'd — each reject teardown
 *   pinned the event loop for up to the full drain window and dead timers
 *   accumulated.
 */
describe('IpcServer listen failure + drain timer hygiene', () => {
  const logger = { log: vi.fn(), pruneOld: () => 0 };
  const teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.restoreAllMocks();
  });

  /** Router whose events.batch ingest deterministically acks one event. */
  function ackingRouter(): Router {
    const router = new Router(logger);
    router.registerBatch(() => ({ accepted: 1, duplicates: 0, rejected: 0 }));
    return router;
  }

  function makeServer(opts: Partial<IpcServerOptions> = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-listen-hygiene-'));
    const socketPath = path.join(home, 'history.sock');
    // IpcServer stores this object by reference, so test 1 repoints socketPath
    // between attempts on the SAME instance.
    const options: IpcServerOptions = {
      socketPath,
      router: new Router(logger),
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
      ...opts,
    };
    const server = new IpcServer(options);
    teardowns.push(async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { server, options, socketPath };
  }

  /** Poison header: declared length 0xFFFFFFFF, far beyond maxFrameBytes. */
  const POISON_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

  /** Valid minimal event_batch whose handler settles immediately. */
  function fastBatchFrame(): Buffer {
    return encodeFrame({
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
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

  it('bind failure rejects, is logged by the persistent error guard, and leaves a retry clean', async () => {
    const { server, options } = makeServer();
    // Oversized sun_path (>104 chars on macOS): claimSocketPath sees no file
    // and skips reclaim, then bind fails asynchronously inside server.listen.
    options.socketPath = path.join(path.dirname(options.socketPath), 'x'.repeat(200));

    await expect(server.listen()).rejects.toThrow();

    // The persistent guard logged the bind error instead of leaving a
    // listener-free window where a late emission would crash the process.
    const guardCall = logger.log.mock.calls.find(
      (call) => call[0] === 'error' && call[2] === 'server socket error',
    );
    expect(guardCall).toBeDefined();
    const fields = guardCall?.[3] as { errorMessage: string }; // log fields are open-ended
    expect(fields.errorMessage.length).toBeGreaterThan(0);

    // Retry on the same instance starts clean: point the stored options at a
    // valid path, listen again, and serve a full handshake.
    options.socketPath = path.join(path.dirname(options.socketPath), 'history.sock');
    await server.listen();
    const socket = await connect(options.socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    socket.destroy();
  });

  it('double-listen on a live instance throws; close-then-listen stays allowed', async () => {
    const { server, options } = makeServer();
    await server.listen();
    await expect(server.listen()).rejects.toThrow(
      'IpcServer.listen called on an already-listening instance',
    );
    // The old live server is untouched: a client still completes a handshake.
    const socket = await connect(options.socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    socket.destroy();

    // Close, then listen again on the same instance: fine.
    await server.close();
    options.socketPath = path.join(path.dirname(options.socketPath), 'history2.sock');
    await server.listen();
  });

  it('clears and unrefs the drain timeout when settled handlers win the race', async () => {
    const DRAIN_MS = 123_456; // unique delay identifies the drain timer unambiguously
    const LINGER_MS = 250;
    const { server, socketPath } = makeServer({
      router: ackingRouter(),
      rejectDrainTimeoutMs: DRAIN_MS,
      rejectLingerTimeoutMs: LINGER_MS,
    });
    await server.listen();

    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    await readFrameUntil(socket, (v) => v.type === 'server_hello');

    // ONE write: [fast-settling event_batch][poison header]. The reject
    // teardown races allSettled against the DRAIN_MS timeout; the tracked
    // batch leg settles immediately, so allSettled wins the race.
    socket.write(Buffer.concat([fastBatchFrame(), POISON_HEADER]));

    const ack = await readFrameUntil(socket, (v) => v.type === 'event_batch_ack');
    expect(ack.value).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });
    await waitClose(socket, LINGER_MS * 10);

    // No fixed sleep: settleWithin's clearTimeout runs as a microtask in the
    // allSettled-wins continuation, which completes strictly before the linger
    // timeout destroys the socket and resolves waitClose above.
    const drainTimer = setSpy.mock.results.find(
      (result, idx) => setSpy.mock.calls[idx]?.[1] === DRAIN_MS,
    )?.value as NodeJS.Timeout | undefined; // spy .value is untyped any
    if (!drainTimer) throw new Error('drain timeout was never created');
    expect(clearSpy.mock.calls.some((args) => args[0] === drainTimer)).toBe(true);
    expect(drainTimer.hasRef()).toBe(false);
    socket.destroy();
  }, 15_000);

});
