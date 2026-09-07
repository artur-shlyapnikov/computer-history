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
import { LlmUnavailableError } from '../src/llm/pi-runtime.js';
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

describe('chat.send / chat.cancel over the real unix socket', () => {
  let home: string;
  let socketPath: string;
  let server: IpcServer;
  let sessions: Map<string, ScriptedSession>;
  let script: string[];
  let chatManager: ChatSessionManager;

  async function startServer(factory: () => Promise<ChatTransportSession>): Promise<void> {
    const dbDir = path.join(home, 'run');
    const router = new Router(logger);
    chatManager = new ChatSessionManager({ sessionFactory: factory, systemPrompt: 'SYS', gcSweepIntervalMs: 0 });
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
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-chat-ipc-'));
    sessions = new Map();
    // Growing assistant snapshots — deltas are the grown suffixes.
    script = ['Вчера', 'Вчера после ', 'Вчера после созвона ты'];
    await startServer(async () => {
      const id = `session-${sessions.size}`;
      const session = makeScriptedSession(script);
      sessions.set(id, session);
      return session;
    });
  });

  afterAll(async () => {
    await chatManager.dispose();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('streams chunks and done with requestId correlation on the happy path', async () => {
    const socket = await connect(socketPath);
    const read = frameReader(socket);
    socket.write(encodeFrame(clientHello()));
    const hello = await read();
    expect(hello['type']).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello as never);

    const request = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'request',
      sentAt: Date.now(),
      op: 'chat.send',
      requestId: ulid(),
      params: { text: 'Что я вчера делал?' },
    };
    socket.write(encodeFrame(request));

    // Response first: {requestId, sessionId}. The requestId is the SERVER-run
    // correlation id (distinct from the transport-level frame requestId).
    const response = await read();
    expect(response['ok']).toBe(true);
    const result = response['result'] as { requestId: string; sessionId: string };
    assertFrame(ChatSendResultSchema, result);
    expect(result.requestId).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);

    // Then exactly one chat_chunk per scripted snapshot suffix + chat_done.
    const chunk1 = await read();
    expect(chunk1['type']).toBe('event');
    expect(chunk1['kind']).toBe('chat_chunk');
    expect(chunk1['payload']).toEqual({ requestId: result.requestId, delta: 'Вчера' });
    const chunk2 = await read();
    expect(chunk2['payload']).toEqual({ requestId: result.requestId, delta: ' после ' });
    const chunk3 = await read();
    expect(chunk3['payload']).toEqual({ requestId: result.requestId, delta: 'созвона ты' });
    // Release the scripted prompt so the run completes and chat_done fires.
    [...sessions.values()][0]?.finish();
    const done = await read();
    expect(done['kind']).toBe('chat_done');
    expect(done['payload']).toEqual({ requestId: result.requestId, sessionId: result.sessionId });

    // Same sessionId reuses the session (factory not re-invoked).
    expect(sessions.size).toBe(1);

    // chat.cancel for an already-finished request → cancelled:false.
    socket.write(
      encodeFrame({
        ...request,
        messageId: ulid(),
        requestId: ulid(),
        op: 'chat.cancel',
        params: { requestId: result.requestId },
      }),
    );
    const cancelResponse = await read();
    expect(cancelResponse['ok']).toBe(true);
    const cancelResult = cancelResponse['result'] as { cancelled: boolean };
    assertFrame(ChatCancelResultSchema, cancelResult);
    expect(cancelResult.cancelled).toBe(false);
    socket.destroy();
  });

  it('maps an unavailable LLM to chat_error with code llm_unavailable', async () => {
    // Fresh server+socket pair wired to a factory that fails like an authless runtime.
    await server.close();
    await startServer(async () => {
      throw new LlmUnavailableError('no credentials available for chat model provider "anthropic"');
    });
    const socket = await connect(socketPath);
    const read = frameReader(socket);
    socket.write(encodeFrame(clientHello()));
    await read(); // server_hello

    const request = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'request',
      sentAt: Date.now(),
      op: 'chat.send',
      requestId: ulid(),
      params: { text: 'hello' },
    };
    socket.write(encodeFrame(request));
    const response = await read();
    // The ack itself still succeeds; failure arrives as the pinned event.
    expect(response['ok']).toBe(true);
    const sendResult = response['result'] as { requestId: string };

    // Same reader instance: frames are FIFO-queued as they arrive on the wire.
    const errorEvent = await read();
    expect(errorEvent['type']).toBe('event');
    expect(errorEvent['kind']).toBe('chat_error');
    expect(errorEvent['payload']).toMatchObject({
      requestId: sendResult.requestId,
      code: 'llm_unavailable',
      message: 'no credentials available for chat model provider "anthropic"',
    });
    socket.destroy();
  });
});
