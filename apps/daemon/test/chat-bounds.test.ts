import { describe, expect, it, vi } from 'vitest';

import {
  ChatRunError,
  ChatSessionManager,
  type ChatSendInput,
  type ChatTransportSession,
} from '../src/agent/agent-session.js';
import { Router } from '../src/ipc/router.js';
import { registerChatOps } from '../src/ipc/chat-ops.js';
import { CONSTANTS } from '../src/config.js';

/**
 * Concurrency-bound tests for the chat stack: the op layer (chat.send)
 * rejects runs beyond maxActiveRuns with a 'busy' chat_error, and the agent
 * layer bounds concurrent prompts globally plus caps the live-session map
 * with LRU eviction that never disposes busy sessions.
 */

type EventRecord = { kind: string; payload: Record<string, unknown> };

interface PendingRun {
  sessionId: string;
  resolve(): void;
  reject(err: Error): void;
}

/** ChatSessionManager double whose send() calls park until resolved. */
function makeFakeChat(): {
  chat: ChatSessionManager;
  pending: PendingRun[];
} {
  const pending: PendingRun[] = [];
  const retire = (run: PendingRun): void => {
    const index = pending.indexOf(run);
    if (index !== -1) pending.splice(index, 1);
  };
  const chat = {
    send(input: ChatSendInput): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const run: PendingRun = {
          sessionId: input.sessionId,
          resolve: () => {
            retire(run);
            resolve(input.sessionId);
          },
          reject: (err: Error) => {
            retire(run);
            reject(err);
          },
        };
        // Cancellation reaches this layer through the AbortSignal, exactly
        // like ChatSessionManager does (onAbort → session.abort()).
        input.signal?.addEventListener(
          'abort',
          () => {
            retire(run);
            reject(new ChatRunError('aborted', 'chat run aborted'));
          },
          { once: true },
        );
        pending.push(run);
      });
    },
    abort(sessionId: string): boolean {
      const index = pending.findIndex((p) => p.sessionId === sessionId);
      if (index === -1) return false;
      const run = must(pending[index], 'aborted run');
      pending.splice(index, 1);
      run.reject(new ChatRunError('aborted', 'chat run aborted'));
      return true;
    },
  };
  return { chat: chat as unknown as ChatSessionManager, pending };
}

function makeOpsHarness(maxActiveRuns?: number): {
  router: Router;
  events: EventRecord[];
  pending: PendingRun[];
} {
  const events: EventRecord[] = [];
  const logger = {
    log: vi.fn(),
    pruneOld: vi.fn(() => 0),
  };
  const router = new Router(logger);
  const { chat, pending } = makeFakeChat();
  registerChatOps(router, {
    chat,
    // Deep-copy at capture time: the pin on llm_unavailable must fail if the
    // watchdog rewrite is ever moved back AFTER the broadcast. Storing the
    // payload by reference would let a late mutation leak into the recorded
    // event and mask the ordering bug this suite guards against.
    broadcastEvent: (kind, payload) =>
      events.push({ kind, payload: structuredClone(payload) }),
    logger,
    ...(maxActiveRuns === undefined ? {} : { maxActiveRuns }),
  });
  return { router, events, pending };
}

const flushMacrotask = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

async function sendOp(
  router: Router,
  params: Record<string, unknown>,
): Promise<{ requestId: string; sessionId: string }> {
  const outcome = await router.dispatch('chat.send', params);
  if (!outcome.ok) throw new Error(`chat.send failed: ${outcome.error.message}`);
  return outcome.result as { requestId: string; sessionId: string };
}

interface FakeSession extends ChatTransportSession {
  prompts: string[];
  disposed: number;
  finishPrompt(): void;
}

/** Test-local indexed access that satisfies noUncheckedIndexedAccess. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

function makeFakeSession(): FakeSession {
  const session: FakeSession = {
    prompts: [],
    disposed: 0,
    subscribe() {
      return () => {};
    },
    async prompt(text) {
      session.prompts.push(text);
      await new Promise<void>((resolve) => {
        session.finishPrompt = resolve;
      });
    },
    abort() {},
    dispose() {
      session.disposed += 1;
    },
    finishPrompt() {},
  };
  return session;
}

function makeSessionFactory() {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    factory: async (): Promise<ChatTransportSession> => {
      const session = makeFakeSession();
      sessions.push(session);
      return session;
    },
  };
}

describe('chat.send op-layer concurrency cap', () => {
  it('acks up to maxActiveRuns, then fails excess runs with a busy chat_error', async () => {
    const { router, events, pending } = makeOpsHarness(2);

    const a = await sendOp(router, { text: 'a' });
    const b = await sendOp(router, { text: 'b' });
    const c = await sendOp(router, { text: 'c' });
    await flushMacrotask();

    // All three were ACKed (the wire contract always answers {requestId,…}).
    expect(a.requestId).toBeDefined();
    expect(b.requestId).toBeDefined();
    expect(c.requestId).toBeDefined();
    // Only the over-cap run failed, and it failed with the pinned busy code.
    expect(events).toHaveLength(1);
    const busyError = must(events[0], 'busy error event');
    expect(busyError.kind).toBe('chat_error');
    expect(busyError.payload).toMatchObject({ requestId: c.requestId, code: 'busy' });
    expect(pending).toHaveLength(2);

    // Completing the admitted runs emits their chat_done events.
    for (const run of [...pending]) run.resolve();
    await flushMacrotask();
    const doneIds = events
      .filter((e) => e.kind === 'chat_done')
      .map((e) => e.payload.requestId);
    expect(doneIds.sort()).toEqual([a.requestId, b.requestId].sort());
  });

  it('a completed run frees its slot for the next send', async () => {
    const { router, events, pending } = makeOpsHarness(1);

    const a = await sendOp(router, { text: 'a' });
    await flushMacrotask();
    expect(pending).toHaveLength(1);

    must(pending[0], "pending run").resolve();
    await flushMacrotask();
    expect(events).toContainEqual({
      kind: 'chat_done',
      payload: { requestId: a.requestId, sessionId: a.sessionId },
    });

    const b = await sendOp(router, { text: 'b' });
    await flushMacrotask();
    expect(
      events.some((e) => e.kind === 'chat_error' && e.payload.requestId === b.requestId),
    ).toBe(false);
    expect(pending.map((p) => p.sessionId)).toEqual([b.sessionId]);
  });

  it('a cancelled run frees its slot', async () => {
    const { router, events } = makeOpsHarness(1);

    const a = await sendOp(router, { text: 'a' });
    await flushMacrotask();

    const cancel = await router.dispatch('chat.cancel', { requestId: a.requestId });
    expect(cancel).toEqual({ ok: true, result: { cancelled: true } });
    await flushMacrotask();
    expect(events).toContainEqual({
      kind: 'chat_error',
      payload: { requestId: a.requestId, code: 'aborted', message: 'chat run aborted' },
    });

    const b = await sendOp(router, { text: 'b' });
    await flushMacrotask();
    expect(
      events.some((e) => e.kind === 'chat_error' && e.payload.requestId === b.requestId),
    ).toBe(false);
  });

  it('cancelling an over-cap run before it starts emits no terminal event', async () => {
    const { router, events, pending } = makeOpsHarness(1);

    await sendOp(router, { text: 'a' });
    const b = await sendOp(router, { text: 'b' });
    const cancel = await router.dispatch('chat.cancel', { requestId: b.requestId });
    expect(cancel).toEqual({ ok: true, result: { cancelled: true } });
    await flushMacrotask();

    expect(
      events.some((e) => e.kind === 'chat_error' && e.payload.requestId === b.requestId),
    ).toBe(false);
    // The over-cap run left the tracker without ever reaching the manager.
    expect(pending).toHaveLength(1);
    expect(must(pending[0], "pending run").sessionId).not.toBe(b.sessionId);
  });
});

describe('chat.send watchdog', () => {
  it('a run exceeding promptTimeoutMs emits llm_unavailable and frees its slot', async () => {
    vi.useFakeTimers();
    try {
      const { router, events, pending } = makeOpsHarness(1);

      const a = await sendOp(router, { text: 'a' });
      // Flush the deferred admission macrotask without letting fake timers
      // fire the watchdog yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(1);

      // The watchdog aborts the signal; the fake chat (like agent-session)
      // rejects on abort, unwedging the transport.
      await vi.advanceTimersByTimeAsync(CONSTANTS.promptTimeoutMs);
      const timeoutError = must(
        events.find((e) => e.kind === 'chat_error'),
        'timeout error event',
      );
      expect(timeoutError.payload).toMatchObject({
        requestId: a.requestId,
        code: 'llm_unavailable',
        message: 'chat run timed out after 120000ms',
      });
      expect(pending).toHaveLength(0);

      // The watchdog timer was cleared in .finally — nothing lingers.
      expect(vi.getTimerCount()).toBe(0);

      // The slot is released: a subsequent send is admitted, not busy.
      const b = await sendOp(router, { text: 'b' });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        events.some((e) => e.kind === 'chat_error' && e.payload.requestId === b.requestId),
      ).toBe(false);
      expect(pending.map((p) => p.sessionId)).toEqual([b.sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatSessionManager concurrency bounds', () => {
  it('rejects sends beyond the global maxActiveRuns across DISTINCT sessions', async () => {
    const { factory, sessions } = makeSessionFactory();
    const manager = new ChatSessionManager({
      sessionFactory: factory,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxActiveRuns: 2,
    });

    const first = manager.send({ sessionId: 's1', text: 'one' }, () => {});
    const second = manager.send({ sessionId: 's2', text: 'two' }, () => {});
    const third = manager.send({ sessionId: 's3', text: 'three' }, () => {});

    await expect(third).rejects.toMatchObject({ code: 'busy' });
    expect(must(sessions[0], "session").prompts).toHaveLength(1);
    expect(must(sessions[1], "session").prompts).toHaveLength(1);

    // Finishing a run frees capacity for a retried send. The retry reuses
    // s3's already-created session entry (sessions[2]).
    must(sessions[0], "session").finishPrompt();
    await first;
    const retry = manager.send({ sessionId: 's3', text: 'three' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[2], "session").prompts).toHaveLength(1),
    );
    must(sessions[2], "session").finishPrompt();
    await expect(retry).resolves.toBe('s3');
    must(sessions[1], "session").finishPrompt();
    await second;
    await manager.dispose();
  });

  it('LRU-evicts the least-recently-used IDLE session when the map is full', async () => {
    const { factory, sessions } = makeSessionFactory();
    const manager = new ChatSessionManager({
      sessionFactory: factory,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxSessions: 3,
    });

    // Three live sessions; s2 is refreshed last so s1 becomes the LRU victim.
    for (const id of ['s1', 's2', 's3']) {
      const run = manager.send({ sessionId: id, text: id }, () => {});
      await vi.waitFor(() =>
        expect(must(sessions[sessions.length - 1], "session").prompts).toHaveLength(1),
      );
      must(sessions[sessions.length - 1], "session").finishPrompt();
      await run;
    }
    const refresh = manager.send({ sessionId: 's2', text: 'again' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[1], "session").prompts).toHaveLength(2),
    );
    must(sessions[1], "session").finishPrompt();
    await refresh;

    const admit = manager.send({ sessionId: 's4', text: 'new' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[3], "session").prompts).toHaveLength(1),
    );
    must(sessions[3], "session").finishPrompt();
    await admit;

    expect(must(sessions[0], "session").disposed).toBe(1); // s1 evicted
    expect(must(sessions[1], "session").disposed).toBe(0); // recently-used s2 kept
    expect(must(sessions[2], "session").disposed).toBe(0); // s3 kept
    expect(manager.size).toBe(3);

    // Eviction also drops grounding state: s1's next incarnation re-sends
    // the preamble, while refreshed s2 does not.
    const s1again = manager.send({ sessionId: 's1', text: 'back' }, () => {});
    await vi.waitFor(() => {
      const last = must(sessions[sessions.length - 1], 'fresh s1');
      expect(last.prompts).toHaveLength(1);
      return last;
    });
    const freshS1 = must(sessions[sessions.length - 1], 'fresh s1');
    freshS1.finishPrompt();
    await s1again;

    await manager.dispose();
  });

  it('never evicts busy sessions; idle neighbours are disposed instead', async () => {
    const { factory, sessions } = makeSessionFactory();
    const manager = new ChatSessionManager({
      sessionFactory: factory,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxSessions: 2,
    });

    const busyRun = manager.send({ sessionId: 's1', text: 'busy work' }, () => {});
    await vi.waitFor(() => expect(must(sessions[0], "session").prompts).toHaveLength(1));

    const idleRun = manager.send({ sessionId: 's2', text: 'idle work' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[1], "session").prompts).toHaveLength(1),
    );
    must(sessions[1], "session").finishPrompt();
    await idleRun;

    // Map is full: s1 busy, s2 idle. Admission must sacrifice s2, not s1.
    const admit = manager.send({ sessionId: 's3', text: 'new' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[2], "session").prompts).toHaveLength(1),
    );
    must(sessions[2], "session").finishPrompt();
    await admit;

    expect(must(sessions[0], "session").disposed).toBe(0); // busy survivor untouched
    expect(must(sessions[1], "session").disposed).toBe(1); // idle LRU evicted
    expect(manager.size).toBe(2);

    must(sessions[0], "session").finishPrompt();
    await busyRun;
    await manager.dispose();
  });

  it('fails admission with a typed busy error when every session is busy', async () => {
    const { factory, sessions } = makeSessionFactory();
    const manager = new ChatSessionManager({
      sessionFactory: factory,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxSessions: 1,
    });

    const held = manager.send({ sessionId: 's1', text: 'hold' }, () => {});
    await vi.waitFor(() => expect(must(sessions[0], "session").prompts).toHaveLength(1));

    // No evictable session exists: the factory must not even be consulted.
    await expect(
      manager.send({ sessionId: 's2', text: 'no room' }, () => {}),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(sessions).toHaveLength(1);

    must(sessions[0], "session").finishPrompt();
    await held;

    const next = manager.send({ sessionId: 's2', text: 'room now' }, () => {});
    await vi.waitFor(() =>
      expect(must(sessions[1], "session").prompts).toHaveLength(1),
    );
    must(sessions[1], "session").finishPrompt();
    await expect(next).resolves.toBe('s2');
    await manager.dispose();
  });
});
