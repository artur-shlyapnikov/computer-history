import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { Router } from '../src/ipc/router.js';

/**
 * Post-handshake frame policy (server.ts onFrame): any frame that passes
 * InboundFrameSchema but is not a request — a REPLAYED client_hello or a
 * client-sent event_batch_ack — is answered error.bad_frame "unexpected
 * post-handshake frame <type>" and the connection is closed. This enforces
 * exactly-one-hello per connection; without the branch a replayed hello would
 * fall into dispatch (error.not_found) with the socket left open.
 */

describe('IpcServer post-handshake frame policy', () => {
  const logger = { log: vi.fn(), pruneOld: () => 0 };

  const teardowns: Array<() => Promise<void>> = [];

  function start() {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-frame-policy-'));
    const socketPath = path.join(home, 'history.sock');
    const router = new Router(logger);
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

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.clearAllMocks();
  });

  it('poisons a replayed client_hello with bad_frame and closes', async () => {
    const socketPath = await start();
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    await readFrameUntil(socket, (f) => f.type === 'server_hello');

    // Second valid hello on the SAME connection — schema-valid, wrong moment.
    socket.write(encodeFrame(clientHello()));

    const err = await readFrameUntil(socket, (f) => f.type === 'error');
    expect(err.value.error).toMatchObject({
      code: 'error.bad_frame',
      message: 'unexpected post-handshake frame client_hello',
    });
    await waitClose(socket);
  });

  it('poisons a client-sent event_batch_ack with bad_frame and closes', async () => {
    const socketPath = await start();
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    await readFrameUntil(socket, (f) => f.type === 'server_hello');

    // Schema-valid inbound member a hostile peer could echo back — the policy
    // keys on the TYPE discriminator, not on which non-request member it is.
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'event_batch_ack',
        sentAt: Date.now(),
        batchId: ulid(),
        accepted: 0,
        duplicates: 0,
        rejected: 0,
      }),
    );

    const err = await readFrameUntil(socket, (f) => f.type === 'error');
    expect(err.value.error).toMatchObject({
      code: 'error.bad_frame',
      message: 'unexpected post-handshake frame event_batch_ack',
    });
    await waitClose(socket);
  });

  it('keeps poisoning per-connection: other clients keep working', async () => {
    const socketPath = await start();

    // Client A poisons itself with a replayed hello.
    const dead = await connect(socketPath);
    dead.write(encodeFrame(clientHello()));
    await readFrameUntil(dead, (f) => f.type === 'server_hello');
    dead.write(encodeFrame(clientHello()));
    await readFrameUntil(dead, (f) => f.type === 'error');
    await waitClose(dead);

    // Client B handshakes and completes a normal request/response unaffected.
    const live = await connect(socketPath);
    live.write(encodeFrame(clientHello()));
    await readFrameUntil(live, (f) => f.type === 'server_hello');
    const requestId = ulid();
    live.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        requestId,
        op: '__no_such_op__',
      }),
    );
    const res = await readFrameUntil(live, (f) => f.type === 'response');
    expect(res.value.requestId).toBe(requestId);
    live.destroy();

    // And a fresh connection is still accepted afterwards.
    const fresh = await connect(socketPath);
    fresh.write(encodeFrame(clientHello()));
    await readFrameUntil(fresh, (f) => f.type === 'server_hello');
    fresh.destroy();
  });
});
