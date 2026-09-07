import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * Multi-client fanout over the REAL unix socket (design P2-7): two
 * simultaneously handshaken clients both receive every server-pushed event,
 * and a stalled peer never stalls an unrelated connection.
 *
 * Broadcast source: one `delete.range {preset:'last_10_minutes'}` against an
 * empty DB — main.ts folds the post-commit callback into exactly three
 * broadcasts (episodes_changed, memories_changed, workflows_changed)
 * regardless of how many rows matched, so no seeding is needed.
 */

const CHANGED_KINDS = ['episodes_changed', 'memories_changed', 'workflows_changed'] as const;

describe('IpcServer multi-client fanout (real unix socket, spawned daemon)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let clientA: net.Socket;
  let clientB: net.Socket;

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-fanout-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    daemon = startDaemon(home);
    await daemon.ready;
    clientA = await handshake(daemon.socketPath);
    clientB = await handshake(daemon.socketPath);
  }, 20_000);

  afterAll(async () => {
    clientA?.destroy();
    clientB?.destroy();
    await stopDaemon(daemon.child);
    rmSync(home, { recursive: true, force: true });
  });

  it('fans one delete.range out to BOTH clients, three *_changed events each, same order', async () => {
    const requestId = ulid();
    clientA.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'delete.range',
        requestId,
        params: { preset: 'last_10_minutes' },
      }),
    );
    // The daemon fires the post-commit onChanged BEFORE writing the response
    // frame, so clientA receives the three broadcasts first; one interleaved
    // reader collects both without discarding events.
    const seenA: string[] = [];
    let gotResponse = false;
    while (!gotResponse || seenA.length < CHANGED_KINDS.length) {
      const frame = await readFrame(clientA, 10_000);
      if (frame.value.type === 'event') {
        const kind = frame.value.kind as string;
        if ((CHANGED_KINDS as readonly string[]).includes(kind)) seenA.push(kind);
        continue;
      }
      expect(frame.value.type).toBe('response');
      expect(frame.value.requestId).toBe(requestId);
      expect(frame.value.ok).toBe(true);
      gotResponse = true;
    }

    const seenB = await drainChanged(clientB);
    expect(seenA).toEqual([...CHANGED_KINDS]);
    expect(seenB).toEqual([...CHANGED_KINDS]);
  }, 20_000);

  it('a slow reader on another connection never stalls this client’s responses', async () => {
    // clientB simply stops reading frames entirely (no destroy — its kernel
    // buffer must be the only thing absorbing any backpressure).
    const requestIds = Array.from({ length: 5 }, () => ulid());
    for (const requestId of requestIds) {
      clientA.write(
        encodeFrame({
          protocolVersion: 1,
          messageId: ulid(),
          type: 'request',
          sentAt: Date.now(),
          op: 'status.get',
          requestId,
          params: {},
        }),
      );
    }

    // status.get produces zero broadcasts, so fire a broadcast-producing op
    // from A while B is still stalled (same shape as the first test: empty DB,
    // exactly three *_changed events). Without this, nothing is ever written
    // to B and the stalled-peer path is never exercised.
    const broadcastRequestId = ulid();
    clientA.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'delete.range',
        requestId: broadcastRequestId,
        params: { preset: 'last_10_minutes' },
      }),
    );

    // Responses must arrive correlated per requestId despite the stalled peer
    // (the daemon does not guarantee FIFO across different ops, so collect as
    // a set until every request has been answered exactly once). A broadcast
    // writer that synchronously blocked A's connection loop on B's unread
    // socket would leave these reads hanging until the timeout fires.
    const expectedIds = new Set<string>([...requestIds, broadcastRequestId]);
    const answered = new Set<string>();
    while (answered.size < expectedIds.size) {
      const frame = await readFrame(clientA, 10_000);
      const value = frame.value;
      if (value.type === 'event') continue;
      expect(value.type).toBe('response');
      expect(expectedIds.has(value.requestId as string)).toBe(true);
      expect(value.ok).toBe(true);
      answered.add(value.requestId as string);
    }

    // Now let B catch up: all three broadcast frames were buffered/delivered
    // per server policy — never dropped and never allowed to block A.
    expect(await drainChanged(clientB)).toEqual([...CHANGED_KINDS]);
  }, 20_000);

  /** Full handshake; resolves once the server_hello frame is observed. */
  async function handshake(socketPath: string): Promise<net.Socket> {
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrameUntil(socket, (v) => v.type === 'server_hello');
    expect(hello.value.type).toBe('server_hello');
    return socket;
  }


  /** Collects `*_changed` event kinds in arrival order until all three are seen. */
  async function drainChanged(socket: net.Socket): Promise<string[]> {
    const seen: string[] = [];
    while (seen.length < CHANGED_KINDS.length) {
      const frame = await readFrame(socket, 10_000);
      if (frame.value.type !== 'event') continue;
      const kind = frame.value.kind as string;
      if (!(CHANGED_KINDS as readonly string[]).includes(kind)) continue;
      seen.push(kind);
    }
    return seen;
  }
});
