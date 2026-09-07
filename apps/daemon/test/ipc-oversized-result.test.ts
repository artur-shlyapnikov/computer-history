import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import { CONSTANTS } from '../src/config.js';
import { IpcServer, type IpcServerOptions } from '../src/ipc/server.js';
import { Router } from '../src/ipc/router.js';
import { type TimelineListResult } from '@computer-history/protocol';

import {
  clientHello,
  connect,
  encodeFrame,
  readFrame,
  readFrameUntil,
} from './helpers/ipc.js';

/**
 * The dispatch() oversized-result substitution has existed since the daemon
 * skeleton and no suite exercised it: when the ENCODED success response
 * exceeds CONSTANTS.maxFrameBytes, the server must answer exactly ONE compact
 * error.internal ("result exceeded max frame size") instead of writing the
 * giant frame — send()'s drop-guard is only the backstop. A regression either
 * hangs the client (reply dropped whole → reader times out) or leaks an
 * oversized frame onto the wire.
 */
describe('IpcServer oversized-result substitution', () => {
  const logger = { log: vi.fn(), pruneOld: () => 0 };

  const teardowns: Array<() => Promise<void>> = [];

  /** Real server over a tmpdir unix socket; `result` is the pinned op's reply. */
  function start(result: () => TimelineListResult) {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-oversized-result-'));
    const socketPath = path.join(home, 'history.sock');
    const router = new Router(logger);
    // Router validates BOTH sides of the op centrally, so the handler
    // returns a schema-VALID result whose encoded size exceeds the frame
    // cap — this pins the server's own substitution guard, not validation.
    router.register('timeline.list', () => result());
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
    socket.write(encodeFrame(clientHello()));
    await readFrameUntil(socket, (f) => f.type === 'server_hello');
    return socket;
  }

  function request(op: string, params: Record<string, unknown> = {}) {
    return {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'request',
      sentAt: Date.now(),
      requestId: ulid(),
      op,
      params,
    };
  }

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.clearAllMocks();
  });

  /** Contract-valid timeline.list result whose bulk sits in `title`. */
  function hugeEpisodeResult(titleChars: number): TimelineListResult {
    return {
      episodes: [
        {
          id: ulid(),
          startedAtMs: 0,
          endedAtMs: 1,
          title: 'x'.repeat(titleChars),
          appNames: [],
          stepCount: 0,
          pendingJobs: 0,
        },
      ],
    };
  }

  it('B1: answers a 2MiB result with exactly one compact error.internal and keeps serving', async () => {
    const socketPath = await start(() => hugeEpisodeResult(2 * 1024 * 1024));
    const socket = await handshaken(socketPath);

    socket.write(encodeFrame(request('timeline.list')));
    const res = await readFrameUntil(socket, (f) => f.type === 'response');
    expect(res.value.ok).toBe(false);
    expect(res.value.error).toMatchObject({
      code: 'error.internal',
      message: 'result exceeded max frame size',
    });
    // Compact substitution frame, not a truncated giant.
    expect(res.raw.length).toBeLessThan(4096);
    expect(socket.destroyed).toBe(false);

    // The backstop never fired: the substitution happened in dispatch(), so
    // no oversized bytes ever reached send()'s drop-guard. Deleting the
    // substitution branch fails HERE first (drop-guard logs + reply vanishes).
    const dropped = logger.log.mock.calls.some(
      (c) => c[2] === 'outbound frame exceeded max frame size; dropped',
    );
    expect(dropped).toBe(false);

    // Exactly one reply for the oversized request: the very next response on
    // this FIFO connection is the follow-up's own answer.
    socket.write(encodeFrame(request('__no_such_op__')));
    const followup = await readFrameUntil(socket, (f) => f.type === 'response');
    expect(followup.value.ok).toBe(false);
    expect(followup.value.error).toMatchObject({ code: 'error.not_found' });
    expect(socket.destroyed).toBe(false);
  });

  it('B2: a result exactly AT the limit is delivered verbatim (strict > boundary)', async () => {
    let payload: TimelineListResult | null = null;
    const socketPath = await start(() => {
      expect(payload).not.toBeNull();
      return payload as TimelineListResult;
    });
    const socket = await handshaken(socketPath);

    // Size the filler against the exact response envelope dispatch() builds:
    // messageId is always a 26-char ULID and sentAt a 13-digit epoch ms, so
    // byte length is deterministic given our fixed requestId.
    const req = request('timeline.list');
    const probe = {
      protocolVersion: 1,
      messageId: '0'.repeat(26),
      sentAt: Date.now(),
      requestId: req.requestId,
      type: 'response',
      ok: true,
      result: hugeEpisodeResult(0),
    };
    const overhead = Buffer.byteLength(JSON.stringify(probe), 'utf8');
    const fillerLen = CONSTANTS.maxFrameBytes - overhead;
    expect(fillerLen).toBeGreaterThan(0);
    payload = hugeEpisodeResult(fillerLen);

    // Encoded payload == maxFrameBytes exactly; the check is
    // `encoded.length - 4 > maxFrameBytes` — strictly greater — so this must
    // be delivered, not substituted.
    socket.write(encodeFrame(req));
    const res = await readFrameUntil(socket, (f) => f.type === 'response');
    expect(res.value.ok).toBe(true);
    const delivered = res.value.result as TimelineListResult;
    expect(delivered.episodes[0]?.title.length).toBe(fillerLen);
    expect(res.raw.length).toBe(CONSTANTS.maxFrameBytes + 4);
    expect(res.raw.readUInt32BE(0)).toBe(CONSTANTS.maxFrameBytes);
  });

  it('B3: an oversized result degrades per-connection; other clients are unaffected', async () => {
    const socketPath = await start(() => hugeEpisodeResult(2 * 1024 * 1024));
    const a = await handshaken(socketPath);
    const b = await handshaken(socketPath);

    a.write(encodeFrame(request('timeline.list')));
    const bReq = request('__no_such_op__');
    b.write(encodeFrame(bReq));

    const resA = await readFrameUntil(a, (f) => f.type === 'response');
    expect(resA.value.ok).toBe(false);
    expect(resA.value.error).toMatchObject({
      code: 'error.internal',
      message: 'result exceeded max frame size',
    });

    // B's FIRST frame is its own reply (echoed messageId) — nothing spurious
    // leaked onto the unaffected connection.
    const resB = await readFrame(b);
    expect(resB.value.requestId).toBe(bReq.requestId);
    expect(resB.value.error).toMatchObject({ code: 'error.not_found' });

    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);
  });
});
