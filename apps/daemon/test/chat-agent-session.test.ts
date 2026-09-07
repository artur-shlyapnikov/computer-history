import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChatRunError,
  ChatSessionManager,
  classifyChatError,
  type ChatStreamEvent,
  type ChatTransportSession,
} from '../src/agent/agent-session.js';
import { LlmUnavailableError } from '../src/llm/pi-runtime.js';

/**
 * Scripted-fake tests for the chat session layer (brief-m4 §D4 item 7):
 * exactly-once delta relay from message_update snapshots, cancel mid-stream →
 * 'aborted', idle GC disposal >10 min, grounding preamble on first turn only,
 * and concurrent sessions running independently of any job serialization.
 */

interface FakeSession extends ChatTransportSession {
  listeners: Array<(event: ChatStreamEvent) => void>;
  prompts: string[];
  disposed: number;
  /** Emits an assistant message_update snapshot to all subscribers. */
  emitUpdate(text: string): void;
  finishPrompt(): void;
  failPrompt(err: Error): void;
}

function makeFakeSession(): FakeSession {
  const session: FakeSession = {
    listeners: [],
    prompts: [],
    disposed: 0,
    subscribe(listener) {
      session.listeners.push(listener);
      return () => {
        session.listeners = session.listeners.filter((l) => l !== listener);
      };
    },
    async prompt(text) {
      session.prompts.push(text);
      await new Promise<void>((resolve, reject) => {
        session.finishPrompt = resolve;
        session.failPrompt = reject;
      });
    },
    abort() {},
    dispose() {
      session.disposed += 1;
    },
    emitUpdate(text: string) {
      for (const listener of [...session.listeners]) {
        listener({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] } });
      }
    },
    finishPrompt() {},
    failPrompt() {},
  };
  return session;
}

describe('chat agent session manager (scripted fakes)', () => {
  let clockMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clockMs = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('relays assistant deltas exactly once each from growing snapshots', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    const deltas: string[] = [];
    const done = manager.send({ sessionId: 's1', text: 'hi' }, (d) => deltas.push(d));
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    // Growing snapshots: only the grown suffix may be emitted, once.
    fake.emitUpdate('Hello');
    fake.emitUpdate('Hello');
    fake.emitUpdate('Hello world');
    fake.emitUpdate('Hello world!');
    fake.emitUpdate('Hello world!'); // no growth → no emission
    fake.finishPrompt();
    await done;

    // Non-assistant events are ignored silently (probe while still subscribed).
    for (const listener of [...fake.listeners]) {
      listener({ type: 'message_start' });
      listener({ type: 'message_update', message: { role: 'user', content: [{ type: 'text', text: 'nope' }] } });
      listener({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'image' }] } });
    }
    expect(deltas).toEqual(['Hello', ' world', '!']);
    await manager.dispose();
  });

  it('sends the grounding preamble on the first turn only per session', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'GROUNDING',
      gcSweepIntervalMs: 0,
    });
    const first = manager.send({ sessionId: 's1', text: 'q1' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    fake.finishPrompt();
    await first;

    const second = manager.send({ sessionId: 's1', text: 'q2' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    fake.finishPrompt();
    await second;

    expect(fake.prompts[0]).toContain('GROUNDING');
    expect(fake.prompts[0]).toContain('q1');
    expect(fake.prompts[1]).toBe('q2'); // preamble NOT repeated
    await manager.dispose();
  });

  it('cancel mid-stream aborts the run with the pinned aborted code', async () => {
    const fake = makeFakeSession();
    const controller = new AbortController();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    const run = manager.send(
      { sessionId: 's1', text: 'long question', signal: controller.signal },
      () => {},
    );
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    // Wire path: chat.cancel aborts the signal; manager forwards to session.abort().
    controller.abort();
    fake.failPrompt(new Error('run aborted'));
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    await manager.dispose();
  });

  it('classifies failures into llm_unavailable / aborted / internal', () => {
    expect(classifyChatError(new LlmUnavailableError('no creds'), false).code).toBe('llm_unavailable');
    expect(classifyChatError(new Error('401 unauthorized'), false).code).toBe('llm_unavailable');
    expect(classifyChatError(new Error('boom'), false).code).toBe('internal');
    expect(classifyChatError(new Error('boom'), true).code).toBe('aborted');
    expect(classifyChatError(new DOMException('x', 'AbortError'), false).code).toBe('aborted');
    // Provider-side faults whose MESSAGE merely mentions "abort" stay
    // 'internal': genuine user cancels are classified via the signal flag.
    expect(classifyChatError(new Error('request aborted by server'), false).code).toBe('internal');
    expect(
      classifyChatError(Object.assign(new Error('socket closed'), { code: 'ABORT_ERR' }), false).code,
    ).toBe('aborted');
    expect(classifyChatError(new ChatRunError('internal', 'kept'), false)).toMatchObject({
      code: 'internal',
    });
  });

  it('idle GC disposes sessions unused longer than 10 minutes, never busy ones', async () => {
    const fakeA = makeFakeSession();
    const fakeB = makeFakeSession();
    let toggle = false;
    const manager = new ChatSessionManager({
      sessionFactory: async () => {
        toggle = !toggle;
        return toggle ? fakeA : fakeB;
      },
      systemPrompt: 'SYS',
      idleGcMs: 10 * 60_000,
      gcSweepIntervalMs: 1_000,
      now: () => clockMs,
    });

    const runA = manager.send({ sessionId: 'a', text: 'x' }, () => {});
    await vi.waitFor(() => expect(fakeA.prompts).toHaveLength(1)); // A busy
    const runB = manager.send({ sessionId: 'b', text: 'y' }, () => {});
    await vi.waitFor(() => expect(fakeB.prompts).toHaveLength(1)); // B busy
    fakeA.finishPrompt();
    fakeB.finishPrompt();
    await Promise.all([runA, runB]);
    expect(manager.size).toBe(2);

    // Advance beyond idle window: A goes stale, B gets fresh activity first.
    clockMs += 11 * 60_000;
    manager.abort('b'); // not busy → returns false but touches nothing
    void manager.send({ sessionId: 'b', text: 'keepalive' }, () => {});
    await vi.waitFor(() => expect(fakeB.prompts).toHaveLength(2));
    clockMs += 30_000; // B lastUsed refreshed above; A still stale
    await vi.advanceTimersByTimeAsync(1_000); // sweep tick
    expect(fakeA.disposed).toBe(1);
    expect(manager.size).toBe(1);
    fakeB.finishPrompt();
    await manager.dispose();
    expect(fakeB.disposed).toBe(1);
    expect(manager.size).toBe(0);
  });

  it('runs concurrent chat sessions independently (no job-worker serialization)', async () => {
    const fakeA = makeFakeSession();
    const fakeB = makeFakeSession();
    const observedOrder: string[] = [];
    let next = fakeA;
    const manager = new ChatSessionManager({
      sessionFactory: async () => {
        const s = next;
        next = fakeB;
        return s;
      },
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    // Both prompts in flight simultaneously — neither waits for the other.
    const a = manager.send({ sessionId: 'a', text: 'a?' }, () => {});
    const b = manager.send({ sessionId: 'b', text: 'b?' }, () => {});
    await vi.waitFor(() => {
      if (fakeA.prompts.length < 1 || fakeB.prompts.length < 1) throw new Error('not yet');
    });
    expect(manager.size).toBe(2);

    // Finish B first and OBSERVE its completion via the send promise while A
    // is still in flight — a manager that serialized all sessions behind one
    // job worker could never resolve B here.
    fakeB.finishPrompt();
    await b;
    observedOrder.push('b-done');

    // A never started finishing: it is still awaiting its prompt.
    expect(fakeA.prompts).toHaveLength(1);

    // Now release A and observe its completion after B's.
    fakeA.finishPrompt();
    await a;
    observedOrder.push('a-done');
    expect(observedOrder).toEqual(['b-done', 'a-done']);
    await manager.dispose();
  });

  it('busy-rejects a concurrent send on the SAME session with a typed error (M5 gate)', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    const first = manager.send({ sessionId: 's1', text: 'first' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    // Second send while the first prompt is still in flight → typed 'busy'.
    await expect(
      manager.send({ sessionId: 's1', text: 'second' }, () => {}),
    ).rejects.toMatchObject({ code: 'busy' });

    // The in-flight run is untouched; after it completes the session is free.
    fake.finishPrompt();
    await first;
    const third = manager.send({ sessionId: 's1', text: 'third' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    fake.finishPrompt();
    await third;
    await manager.dispose();
  });

  it('fails fast with the aborted code when the signal is already aborted (AG-03)', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.send({ sessionId: 's1', text: 'too late', signal: controller.signal }, () => {}),
    ).rejects.toMatchObject({ code: 'aborted' });
    // No LLM turn may run for an already-cancelled input.
    expect(fake.prompts).toHaveLength(0);
    await manager.dispose();
  });

  it('serializes concurrent first sends on a fresh session into one factory call (AG-04)', async () => {
    const fake = makeFakeSession();
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const manager = new ChatSessionManager({
      sessionFactory: async () => {
        factoryCalls += 1;
        await factoryGate;
        return fake;
      },
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
    });
    const first = manager.send({ sessionId: 's1', text: 'a' }, () => {});
    const second = manager.send({ sessionId: 's1', text: 'b' }, () => {});
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    releaseFactory();

    // Both callers share ONE entry; the loser hits the busy gate instead of
    // interleaving a second prompt (or orphaning the winner's Pi session).
    await expect(second).rejects.toMatchObject({ code: 'busy' });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    fake.finishPrompt();
    const winnerText = await first;
    expect(winnerText).toBe('s1');
    expect(factoryCalls).toBe(1);
    expect(manager.size).toBe(1);
    await manager.dispose();
    expect(fake.disposed).toBe(1);
  });

  it('re-checks the session cap after the factory resolves so concurrent admissions cannot overshoot it', async () => {
    const created: FakeSession[] = [];
    const gates = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });
    const manager = new ChatSessionManager({
      sessionFactory: async () => {
        const fake = makeFakeSession();
        created.push(fake);
        await gates[created.length - 1]!.promise;
        return fake;
      },
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxSessions: 1,
    });

    // Two first-sends for DISTINCT sessionIds both pass the pre-factory cap
    // check while entries is still empty.
    const first = manager.send({ sessionId: 's1', text: 'a' }, () => {});
    const second = manager.send({ sessionId: 's2', text: 'b' }, () => {});
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(manager.size).toBe(0);

    gates[0]!.resolve();
    await vi.waitFor(() => expect(created[0]!.prompts).toHaveLength(1));
    created[0]!.finishPrompt();
    await expect(first).resolves.toBe('s1');
    expect(manager.size).toBe(1);

    // Admitting the overshooting creation evicts the LRU idle s1 entry
    // BEFORE the set, so the cap holds instead of overshooting to 2.
    gates[1]!.resolve();
    await vi.waitFor(() => expect(created[1]!.prompts).toHaveLength(1));
    created[1]!.finishPrompt();
    await expect(second).resolves.toBe('s2');
    expect(manager.size).toBe(1);
    expect(created[0]!.disposed).toBe(1);
    expect(created[1]!.disposed).toBe(0);
    await manager.dispose();
    expect(created[1]!.disposed).toBe(1);
  });

  it('disposes the freshly created session when the post-factory cap recheck throws busy', async () => {
    const gates = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });
    const created: FakeSession[] = [];
    const manager = new ChatSessionManager({
      sessionFactory: async () => {
        const fake = makeFakeSession();
        created.push(fake);
        await gates[created.length - 1]!.promise;
        return fake;
      },
      systemPrompt: 'SYS',
      gcSweepIntervalMs: 0,
      maxSessions: 1,
    });
    // Both first-sends pass the pre-factory cap check while entries is still
    // empty; their factories park on gates.
    const first = manager.send({ sessionId: 's1', text: 'a' }, () => {});
    const second = manager.send({ sessionId: 's2', text: 'b' }, () => {});
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(manager.size).toBe(0);

    // s1 admits and stays BUSY for the whole scenario.
    gates[0]!.resolve();
    await vi.waitFor(() => expect(created[0]!.prompts).toHaveLength(1));
    expect(manager.size).toBe(1);

    // s2's factory resolves while every live session is busy: the post-factory
    // recheck cannot evict anything and throws busy. The orphaned session must
    // be disposed exactly once instead of leaking.
    gates[1]!.resolve();
    const orphan = created[1]!;
    await expect(second).rejects.toMatchObject({ code: 'busy' });
    expect(orphan.disposed).toBe(1);
    expect(manager.size).toBe(1);

    created[0]!.finishPrompt();
    await expect(first).resolves.toBe('s1');
    await manager.dispose();
    expect(created[0]!.disposed).toBe(1);
    expect(orphan.disposed).toBe(1);
  });

  it('re-sends the grounding preamble after a failed first turn (AG-05)', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'GROUNDING',
      gcSweepIntervalMs: 0,
    });
    const first = manager.send({ sessionId: 's1', text: 'q1' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    expect(fake.prompts[0]).toContain('GROUNDING');
    fake.failPrompt(new LlmUnavailableError('no creds'));
    await expect(first).rejects.toMatchObject({ code: 'llm_unavailable' });

    // The failed turn never committed grounding → retry re-sends the preamble.
    const second = manager.send({ sessionId: 's1', text: 'q2' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    expect(fake.prompts[1]).toContain('GROUNDING');
    expect(fake.prompts[1]).toContain('q2');
    fake.finishPrompt();
    await second;

    // After a SUCCESSFUL turn grounding sticks: no preamble on turn three.
    const third = manager.send({ sessionId: 's1', text: 'q3' }, () => {});
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(3));
    expect(fake.prompts[2]).toBe('q3');
    fake.finishPrompt();
    await third;
    await manager.dispose();
  });

  it('sweep tick never disposes a session that is stale AND busy (R11-T1)', async () => {
    const fake = makeFakeSession();
    const manager = new ChatSessionManager({
      sessionFactory: async () => fake,
      systemPrompt: 'SYS',
      idleGcMs: 10 * 60_000,
      gcSweepIntervalMs: 1_000,
      now: () => clockMs,
    });

    // In-flight prompt: busy for the entire idle window.
    const deltas: string[] = [];
    const run = manager.send({ sessionId: 's', text: 'long-running' }, (d) => deltas.push(d));
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    clockMs += 11 * 60_000; // past idleGcMs, no activity since lastUsed
    await vi.advanceTimersByTimeAsync(1_000); // exactly one sweep tick
    expect(fake.disposed).toBe(0);
    expect(manager.size).toBe(1);

    // The pending prompt survives the tick and completes normally.
    fake.emitUpdate('partial');
    fake.finishPrompt();
    await run;
    expect(deltas).toEqual(['partial']);
    await manager.dispose();
  });
});
