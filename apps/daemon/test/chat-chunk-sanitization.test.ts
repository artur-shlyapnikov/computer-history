import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ChatCancelResultSchema,
  ChatSendResultSchema,
  ServerHelloSchema,
  assertFrame,
} from '@computer-history/protocol';

import {
  ChatSessionManager,
  type ChatTransportSession,
} from '../src/agent/agent-session.js';
import { registerChatOps } from '../src/ipc/chat-ops.js';
import { Router } from '../src/ipc/router.js';
import { IpcServer } from '../src/ipc/server.js';
import type { Logger } from '../src/logging.js';

import {
  clientHello,
  connect,
  encodeFrame,
} from './helpers/ipc.js';

/**
 * Issue W2 at the last unpinned emission point: chat-ops pipes every LLM
 * delta through replaceWellFormedTarget() BEFORE broadcastEvent('chat_chunk').
 * Deleting that call leaves every other suite green while Swift clients lose
 * the whole chat_chunk frame (JSONDecoder rejects it at parse time) — these
 * tests pin the boundary over a real unix socket.
 */

/** Pair-aware scan: true iff every surrogate is half of a well-formed pair. */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * TextEncoder replaces unpaired surrogates with U+FFFD when encoding — so a
 * strict encode→decode round-trip only reproduces its input exactly when the
 * input was well-formed. Independent second witness besides the code-unit scan.
 */
function survivesTextEncoderRoundTrip(s: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(s)) === s;
}

/**
 * Queue-based frame reader: ONE permanent 'data' listener decodes frames into
 * a FIFO as they arrive, so server writes coalesced into one TCP segment (or
 * arriving between reads) are never dropped between reads.
 */
function frameReader(socket: net.Socket) {
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<{ resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout }> = [];
  let resolve!: (v: Record<string, unknown>) => void;
  let reject!: (err: Error) => void;
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const value = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<
        string,
        unknown
      >;
      buffer = buffer.subarray(4 + length);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        queue.push(value);
      }
    }
  });
  return (timeoutMs = 5000): Promise<Record<string, unknown>> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const promise = new Promise<Record<string, unknown>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      const index = waiters.findIndex((w) => w.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error('timed out waiting for frame'));
    }, timeoutMs);
    waiters.push({ resolve, timer });
    return promise;
  };
}

interface ScriptedSession extends ChatTransportSession {
  listeners: Array<(event: unknown) => void>;
  finish(): void;
}

function makeScriptedSession(script: string[]): ScriptedSession {
  const listeners: Array<(event: unknown) => void> = [];
  let release: (() => void) | null = null;
  return {
    listeners,
    subscribe(listener) {
      listeners.push(listener as never);
      return () => {
        listeners.splice(listeners.indexOf(listener as never), 1);
      };
    },
    // Emits the whole growing-snapshot script synchronously, then parks until
    // finish() resolves the prompt (so done ordering is test-controlled).
    async prompt() {
      for (const text of script) {
        for (const listener of [...listeners]) {
          listener({
            type: 'message_update',
            message: { role: 'assistant', content: [{ type: 'text', text }] },
          });
        }
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    abort() {},
    dispose() {},
    finish() {
      release?.();
    },
  };
}

/** Quiet logger; failures still surface through frame assertions. */
const logger: Logger = { log() {}, pruneOld: () => 0 };

describe('chat_chunk wire sanitization (issue W2)', () => {
  let home: string;
  let socketPath: string;
  let server: IpcServer;
  let sessions: Map<string, ScriptedSession>;
  let script: string[];
  let chatManager: ChatSessionManager;

  /** Most recently created scripted session (one per chat.send sans sessionId). */
  function lastSession(): ScriptedSession {
    const all = [...sessions.values()];
    const session = all[all.length - 1];
    expect(session, 'factory did not create a session').toBeDefined();
    return session!;
  }

  /**
   * Handshakes a client, sends chat.send with the CURRENT `script`, and
   * returns the socket, its frame reader, and the server-run correlation ids.
   */
  async function sendChat(text: string): Promise<{
    socket: net.Socket;
    read: (timeoutMs?: number) => Promise<Record<string, unknown>>;
    requestId: string;
    sessionId: string;
  }> {
    const socket = await connect(socketPath);
    const read = frameReader(socket);
    socket.write(encodeFrame(clientHello()));
    const hello = await read();
    expect(hello['type']).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello as never);

    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        requestId: ulid(),
        op: 'chat.send',
        params: { text },
      }),
    );
    const response = await read();
    expect(response['ok']).toBe(true);
    const result = response['result'] as { requestId: string; sessionId: string };
    assertFrame(ChatSendResultSchema, result);
    return { socket, read, requestId: result.requestId, sessionId: result.sessionId };
  }

  /** Both witnesses on the full wire frame: what Swift parses must be safe. */
  function expectWellFormedFrame(frame: Record<string, unknown>): void {
    const serialized = JSON.stringify(frame);
    expect(isWellFormedUtf16(serialized)).toBe(true);
    expect(survivesTextEncoderRoundTrip(serialized)).toBe(true);
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-chat-chunk-sanitize-'));
    sessions = new Map();
    script = [];
    const dbDir = path.join(home, 'run');
    const router = new Router(logger);
    chatManager = new ChatSessionManager({
      sessionFactory: async () => {
        const id = `session-${sessions.size}`;
        const session = makeScriptedSession(script);
        sessions.set(id, session);
        return session;
      },
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    registerChatOps(router, {
      chat: chatManager,
      broadcastEvent: (kind, payload) => server.broadcastEvent(kind, payload),
      logger,
    });
    server = new IpcServer({
      socketPath: path.join(dbDir, 'history.sock'),
      router,
      logger,
      daemonVersion: 'test',
      databaseSchemaVersion: 2,
    });
    await server.listen();
    socketPath = path.join(dbDir, 'history.sock');
  });

  afterAll(async () => {
    await chatManager.dispose();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('A1: sanitizes a poisoned delta on the wire', async () => {
    script = ['ok \ud800 high \ude00 low \ud83d\ude00 paired'];
    const { read, requestId } = await sendChat('poison me');

    const chunk = await read();
    expect(chunk['type']).toBe('event');
    expect(chunk['kind']).toBe('chat_chunk');
    const payload = chunk['payload'] as { requestId: string; delta: string };
    // Each unpaired unit becomes U+FFFD; the well-formed pair survives intact.
    expect(payload.delta).toBe('ok \uFFFD high \uFFFD low \ud83d\ude00 paired');
    expect(payload.requestId).toBe(requestId);
    expect(isWellFormedUtf16(payload.delta)).toBe(true);
    // What Swift's JSONDecoder consumes parses cleanly.
    expect(survivesTextEncoderRoundTrip(JSON.stringify(chunk))).toBe(true);

    lastSession().finish();
  });

  it('A2: clean deltas arrive byte-identical (sanitize once, change nothing else)', async () => {
    script = ['naïve 中文 \u{1F600} ok'];
    const { read } = await sendChat('clean');

    const chunk = await read();
    expect(chunk['kind']).toBe('chat_chunk');
    const payload = chunk['payload'] as { delta: string };
    expect(payload.delta).toBe('naïve 中文 \u{1F600} ok');
    expect(isWellFormedUtf16(payload.delta)).toBe(true);

    lastSession().finish();
  });

  it('A3: sanitization is per-chunk with no cross-frame state', async () => {
    // Snapshot 1 ends in a trailing lone HIGH surrogate; snapshot 2 completes
    // the pair across the chunk boundary — chunk 1 must sanitize the dangler,
    // chunk 2's diff is itself a lone LOW unit in isolation.
    script = ['tail \ud83d', 'tail \ud83d\ude00 done'];
    const { read } = await sendChat('split pair');

    const chunk1 = await read();
    expect(chunk1['kind']).toBe('chat_chunk');
    const payload1 = chunk1['payload'] as { delta: string };
    expect(payload1.delta).toBe('tail \uFFFD');
    expectWellFormedFrame(chunk1);

    const chunk2 = await read();
    expect(chunk2['kind']).toBe('chat_chunk');
    const payload2 = chunk2['payload'] as { delta: string };
    expect(payload2.delta).toBe('\uFFFD done');
    expectWellFormedFrame(chunk2);

    lastSession().finish();
  });

  it('A4: poisoned chunk does not trip broadcast validation nor kill the stream', async () => {
    script = ['ok \ud800 high \ude00 low \ud83d\ude00 paired'];
    const { socket, read, requestId, sessionId } = await sendChat('poison then finish');

    const chunk = await read();
    expect(chunk['kind']).toBe('chat_chunk');
    expect((chunk['payload'] as { delta: string }).delta).toContain('\uFFFD');
    expectWellFormedFrame(chunk);

    // Release the prompt: the stream must complete normally — sanitization
    // happens BEFORE broadcastEvent's schema check could ever see the raw
    // escape, and one bad LLM token cannot wedge the chat stream.
    lastSession().finish();
    const done = await read();
    // FIFO: nothing (in particular no error frame of any kind) precedes it.
    expect(done['kind']).toBe('chat_done');
    expect(done['type']).toBe('event');
    expect(done['payload']).toEqual({ requestId, sessionId });

    // The socket survived and stays usable: an already-finished cancel
    // answers normally.
    expect(socket.destroyed).toBe(false);
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        requestId: ulid(),
        op: 'chat.cancel',
        params: { requestId },
      }),
    );
    const cancelResponse = await read();
    expect(cancelResponse['ok']).toBe(true);
    const cancelResult = cancelResponse['result'] as { cancelled: boolean };
    assertFrame(ChatCancelResultSchema, cancelResult);
    expect(cancelResult.cancelled).toBe(false);
  });

  it('A5: requestId correlation holds on EVERY sanitized chunk', async () => {
    script = [
      '\ud800 first',
      '\ud800 first \udfff second',
      '\ud800 first \udfff second \ud83d\ude00 third',
    ];
    const { read, requestId } = await sendChat('correlate');

    for (let i = 0; i < 3; i += 1) {
      const frame = await read();
      expect(frame['kind']).toBe('chat_chunk');
      const payload = frame['payload'] as { requestId: string; delta: string };
      expect(payload.requestId).toBe(requestId);
      expect(isWellFormedUtf16(payload.delta)).toBe(true);
    }
    // Release the parked prompt so the run completes.
    lastSession().finish();
    const done = await read();
    expect(done['kind']).toBe('chat_done');
  });
});
