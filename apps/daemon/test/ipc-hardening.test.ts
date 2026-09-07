import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import { ProtocolErrorFrameSchema, assertFrame } from '@computer-history/protocol';

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
 * Hardening contracts for the unix-socket IPC server:
 *
 * - error frames echo the client's messageId ONLY when it is itself a
 *   well-formed ULID; attacker-controlled ids are replaced by a generated one,
 *   so every outbound frame satisfies the Ulid-typed envelope schema;
 * - concurrent connections are capped (excess sockets are destroyed on
 *   accept, existing ones untouched);
 * - a connection may pin at most `maxIncompleteFrameBytes` of buffered,
 *   never-completed frame (dribbler defense);
 * - no outbound frame larger than maxFrameBytes ever reaches the wire;
 * - broadcast payloads must satisfy their per-kind schema before any bytes
 *   are written.
 */
describe('IpcServer hardening', () => {
  const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
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
    const home = mkdtempSync(path.join(tmpdir(), 'ch-hardening-'));
    const socketPath = path.join(home, 'history.sock');
    const server = new IpcServer({
      socketPath,
      router: new Router(logger),
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
      ...opts,
    });
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

  afterEach(async () => {
    while (teardowns.length) await teardowns.pop()!();
    vi.clearAllMocks();
  });

  describe('ULID-safe error-frame messageId echo', () => {
    it('echoes a well-formed client messageId verbatim on version rejection', async () => {
      const { socketPath } = await start();
      const a = await handshaken(socketPath);

      const mine = ulid();
      a.socket.write(
        encodeFrame({
          protocolVersion: 99,
          messageId: mine,
          type: 'request',
          sentAt: Date.now(),
          requestId: ulid(),
          op: 'ping',
        }),
      );
      const err = await readFrameUntil(a.socket, (f) => f.type === 'error');

      expect(err.value.error).toMatchObject({ code: 'error.protocol_version' });
      expect(err.value.messageId).toBe(mine);
      assertFrame(ProtocolErrorFrameSchema, err.value as never);
    });

    it('replaces a non-ULID client messageId with a generated one', async () => {
      const { socketPath } = await start();
      const a = await handshaken(socketPath);

      a.socket.write(
        encodeFrame({
          protocolVersion: 99,
          messageId: '../../etc/passwd',
          type: 'request',
          sentAt: Date.now(),
        }),
      );
      const err = await readFrameUntil(a.socket, (f) => f.type === 'error');

      expect(err.value.messageId).not.toBe('../../etc/passwd');
      expect(err.value.messageId).toMatch(ULID_PATTERN);
      // The constructed frame satisfies its own wire schema despite hostile input.
      assertFrame(ProtocolErrorFrameSchema, err.value as never);
    });

    it('applies the same echo rule to post-handshake bad-frame rejections', async () => {
      const { socketPath } = await start();

      // Envelope-shaped junk fails InboundFrameSchema; its ULID id is echoed.
      const echoed = await handshaken(socketPath);
      const mine = ulid();
      echoed.socket.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: mine,
          sentAt: Date.now(),
          type: 'definitely_not_a_frame_kind',
        }),
      );
      const firstErr = await readFrameUntil(echoed.socket, (f) => f.type === 'error');
      expect(firstErr.value.error).toMatchObject({ code: 'error.bad_frame' });
      expect(firstErr.value.messageId).toBe(mine);

      const replaced = await handshaken(socketPath);
      replaced.socket.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: 'x'.repeat(27),
          sentAt: Date.now(),
          type: 'definitely_not_a_frame_kind',
        }),
      );
      const secondErr = await readFrameUntil(replaced.socket, (f) => f.type === 'error');
      expect(secondErr.value.messageId).toMatch(ULID_PATTERN);
      expect(secondErr.value.messageId).not.toBe('x'.repeat(27));
    });
  });

  describe('connection cap', () => {
    it('destroys excess connections on accept and leaves existing ones intact', async () => {
      const { socketPath } = await start({ maxConnections: 1 });
      const first = await handshaken(socketPath);

      const excess = await connect(socketPath);
      excess.write(encodeFrame(clientHello()));
      await waitClose(excess);
      expect(excess.destroyed).toBe(true);
      expect(logger.log).toHaveBeenCalledWith(
        'warn',
        'ipc',
        'connection refused: max connections',
        expect.anything(),
      );

      // The pre-cap connection is unaffected and still speaks protocol.
      expect(first.socket.destroyed).toBe(false);
      first.socket.write(
        encodeFrame({ protocolVersion: 7, messageId: ulid(), type: 'request', sentAt: Date.now() }),
      );
      const err = await readFrameUntil(first.socket, (f) => f.type === 'error');
      expect(err.value.error).toMatchObject({ code: 'error.protocol_version' });
    });
  });

  describe('incomplete-frame byte budget', () => {
    it('rejects a connection whose buffered incomplete frame exceeds the budget', async () => {
      const { socketPath } = await start({ maxIncompleteFrameBytes: 64 });
      const a = await handshaken(socketPath);

      // Declare a 1000-byte payload but dribble only part of it: the buffered
      // prefix (4 header + 70 body = 74) blows past the 64-byte budget.
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1000, 0);
      a.socket.write(Buffer.concat([header, Buffer.alloc(70)]));

      const err = await readFrameUntil(a.socket, (f) => f.type === 'error');
      expect(err.value.error).toMatchObject({ code: 'error.bad_frame' });
      // JSON of the error payload carries the human-readable reason.
      expect(JSON.stringify(err.value.error)).toContain('byte budget');
      await waitClose(a.socket);
    });

    it('tolerates incomplete frames within the budget until they complete', async () => {
      const { socketPath } = await start({ maxIncompleteFrameBytes: 64 });
      const a = await handshaken(socketPath);

      const body = Buffer.from(
        JSON.stringify({
          protocolVersion: 1,
          messageId: ulid(),
          sentAt: Date.now(),
          type: 'request',
          requestId: ulid(),
          op: '__no_such_op__',
        }),
        'utf8',
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      const whole = Buffer.concat([header, body]);

      // Split mid-frame: the first half sits incomplete (under budget), the
      // second completes it.
      a.socket.write(whole.subarray(0, 12));
      a.socket.write(whole.subarray(12));

      const res = await readFrameUntil(a.socket, (f) => f.type === 'response');
      expect(res.value.ok).toBe(false);
      expect(res.value.error).toMatchObject({ code: 'error.not_found' });
      expect(a.socket.destroyed).toBe(false);
    });
  });

  describe('outbound frame size guard', () => {
    it('drops an oversized broadcast whole and keeps connections usable', async () => {
      const { socketPath, server } = await start();
      const a = await handshaken(socketPath);
      const b = await handshaken(socketPath);

      const oversizedDelta = 'x'.repeat(1024 * 1024 + 16);
      expect(() =>
        server.broadcastEvent('chat_chunk', { requestId: ulid(), delta: oversizedDelta }),
      ).not.toThrow();

      // A subsequent small broadcast proves both sockets survived; stream
      // ordering proves the oversized frame was dropped WHOLE (it would have
      // appeared before this one had it been written).
      server.broadcastEvent('episodes_changed', {});
      const firstA = await a.collector.waitFor('event');
      const firstB = await b.collector.waitFor('event');
      expect(firstA.payload).toEqual({});
      expect(firstB.payload).toEqual({});
      // The collector also holds the server_hello; only ONE event frame (the
      // small follow-up) may have arrived per socket.
      expect(a.collector.frames.filter((f) => f.type === 'event')).toHaveLength(1);
      expect(b.collector.frames.filter((f) => f.type === 'event')).toHaveLength(1);

      expect(logger.log).toHaveBeenCalledWith(
        'warn',
        'ipc',
        'outbound frame exceeded max frame size; dropped',
        expect.anything(),
      );

      a.collector.stop();
      b.collector.stop();
    });
  });

  describe('broadcast payload schema validation', () => {
    it('throws on payloads violating their per-kind schema and writes nothing', async () => {
      const { socketPath, server } = await start();
      const a = await handshaken(socketPath);

      expect(() => server.broadcastEvent('queue_update', {})).toThrow(TypeError);
      expect(() =>
        server.broadcastEvent('chat_chunk', { requestId: 'not-a-ulid', delta: 'hi' }),
      ).toThrow(/chat_chunk/);
      // Both failures threw before any write, so no event frame is on the wire
      // (the collector's server_hello predates them).
      expect(a.collector.frames.filter((f) => f.type === 'event')).toEqual([]);

      server.broadcastEvent('episodes_changed', {});
      const event = await a.collector.waitFor('event');
      expect(event.kind).toBe('episodes_changed');
      a.collector.stop();
    });
  });

  describe('protocol-version rejection survives trailing inbound bytes', () => {
    it('delivers error.protocol_version before close when junk follows the bad hello, over >=5 connections', async () => {
      const { socketPath } = await start();
      for (let i = 0; i < 5; i++) {
        const socket = await connect(socketPath);
        const collector = collect(socket);

        // ONE write: [hello with protocolVersion 99][junk]. At reject time
        // the junk sits unread in the kernel, so a destroy()-based teardown
        // would RST the reply away; the graceful teardown delivers it.
        socket.write(
          Buffer.concat([
            encodeFrame(clientHello(99)),
            Buffer.from('trailing junk that must never be parsed'),
          ]),
        );

        const err = await collector.waitFor('error');
        expect(err.error).toMatchObject({ code: 'error.protocol_version' });
        await waitClose(socket);
      }
    });

    it('a string protocolVersion hello rejects as bad_frame with the same delivery guarantee', async () => {
      const { socketPath } = await start();
      const socket = await connect(socketPath);
      const collector = collect(socket);

      // protocolVersion "1" (string) fails the ClientHello Integer check, so
      // this exercises the reject() path at the handshake gate instead of
      // rejectProtocolVersion — same teardown, same delivery guarantee.
      socket.write(
        Buffer.concat([
          encodeFrame({
            protocolVersion: '1',
            messageId: ulid(),
            type: 'client_hello',
            sentAt: Date.now(),
            appVersion: 'test',
          }),
          Buffer.from('trailing junk'),
        ]),
      );

      const err = await collector.waitFor('error');
      expect(err.error).toMatchObject({
        code: 'error.bad_frame',
        message: 'first frame must be client_hello',
      });
      await waitClose(socket);
    });
  });

  describe('coalesced inbound frames', () => {
    it('answers TWO valid requests riding in ONE write, in arrival order', async () => {
      const { socketPath } = await start();
      const a = await handshaken(socketPath);

      const request = (requestId: string) => ({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        requestId,
        op: '__no_such_op__',
      });
      const id1 = ulid();
      const id2 = ulid();

      // Register BOTH waiters before any bytes move: the collector resolves
      // same-type waiters FIFO, so the pair pins response ORDER.
      const first = a.collector.waitFor('response');
      const second = a.collector.waitFor('response');

      // ONE segment carries both frames. A residue-math regression to `[]`
      // would silently drop frame 2 here; both requestIds must be answered.
      a.socket.write(Buffer.concat([encodeFrame(request(id1)), encodeFrame(request(id2))]));

      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.requestId).toBe(id1);
      expect(r2.requestId).toBe(id2);
      expect(r1.error).toMatchObject({ code: 'error.not_found' });
      expect(r2.error).toMatchObject({ code: 'error.not_found' });
      expect(a.collector.frames.filter((f) => f.type === 'response')).toEqual([r1, r2]);
      a.collector.stop();
    });
  });

  describe('client destroy during an incomplete partial frame', () => {
    it('reaps the dead connection cleanly; a fresh connection then works', async () => {
      const { socketPath } = await start({ maxConnections: 1 });
      const a = await handshaken(socketPath);
      a.collector.stop();

      // Header promises a 200-byte body; only 50 bytes ever follow. The
      // server holds this incomplete prefix when the client vanishes.
      const header = Buffer.alloc(4);
      header.writeUInt32BE(200, 0);
      a.socket.write(Buffer.concat([header, Buffer.alloc(50)]));
      a.socket.destroy();

      // With maxConnections 1, the next accept survives exactly when the
      // dead socket's map entry was dropped. EOF handling vs accept ordering
      // is racy on loopback, so retry until a hello gets through instead of
      // assuming one attempt lands.
      interface Handshaken {
        socket: net.Socket;
        collector: {
          frames: Record<string, unknown>[];
          waitFor(type: string): Promise<Record<string, unknown>>;
          stop(): void;
        };
      }
      let b: Handshaken | undefined;
      for (let attempt = 0; attempt < 20 && b === undefined; attempt++) {
        const socket = await connect(socketPath);
        const collector = collect(socket);
        socket.write(encodeFrame(clientHello()));
        const outcome = await Promise.race([
          collector.waitFor('server_hello').then(() => 'hello' as const),
          waitClose(socket).then(() => 'refused' as const),
        ]);
        if (outcome === 'refused') {
          collector.stop();
          continue;
        }
        b = { socket, collector };
      }
      expect(b).toBeDefined();

      // Full handshake + round-trip proves no crash and a usable server.
      b!.socket.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: ulid(),
          type: 'request',
          sentAt: Date.now(),
          requestId: ulid(),
          op: '__no_such_op__',
        }),
      );
      const res = await readFrameUntil(b!.socket, (f) => f.type === 'response');
      expect(res.value.ok).toBe(false);
      expect(res.value.error).toMatchObject({ code: 'error.not_found' });
      expect(b!.socket.destroyed).toBe(false);
      b!.collector.stop();
    });
  });
});
