import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerHelloSchema, assertFrame } from '@computer-history/protocol';

import { clientHello, connect, encodeFrame } from './helpers/ipc.js';
import { IpcServer } from '../src/ipc/server.js';
import { Router } from '../src/ipc/router.js';

/**
 * Real unix-socket integration for server-pushed events (contracts §Protocol
 * v1): only handshaken connections may receive broadcastEvent frames; a
 * connected-but-pre-handshake socket must stay completely silent.
 *
 * No wall-clock waits: the broadcast is synchronous on the server side, so
 * once the handshaken socket has observed its pushed event frame, any write
 * to the silent socket would already have happened — absence is provable.
 */
describe('IpcServer broadcastEvent (real unix socket)', () => {
  let home: string;
  let server: IpcServer;
  let socketPath: string;
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
        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
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
        let resolve!: (frame: Record<string, unknown>) => void;
        const promise = new Promise<Record<string, unknown>>((res) => {
          resolve = res;
        });
        waiters.push({ type, resolve });
        return promise;
      },
      stop: () => socket.off('data', onData),
    };
  }

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-broadcast-'));
    socketPath = path.join(home, 'history.sock');
    server = new IpcServer({
      socketPath,
      router: new Router(logger),
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('pushes events only to handshaken connections; pre-handshake sockets stay silent', async () => {
    const handshaken = await connect(socketPath);
    const raw = await connect(socketPath);
    const a = collect(handshaken);
    const b = collect(raw);

    handshaken.write(encodeFrame(clientHello()));
    const hello = await a.waitFor('server_hello');
    expect(hello.protocolVersion).toBe(1);

    server.broadcastEvent('queue_update', { pendingJobs: 3 });
    const event = await a.waitFor('event');

    assertFrame(ServerHelloSchema, hello as never);
    expect(event.kind).toBe('queue_update');
    expect(event.payload).toEqual({ pendingJobs: 3 });

    // Connected but never handshaken → NO pushed event of any kind.
    expect(b.frames).toEqual([]);

    a.stop();
    b.stop();
    handshaken.destroy();
    raw.destroy();
  });
});
