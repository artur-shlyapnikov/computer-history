import { describe, expect, it, vi } from 'vitest';

import { Type } from '@sinclair/typebox';

import { FakeTransport, FailingTransport } from '../src/llm/fake-transport.js';
import {
  StructuredPromptRunner,
  StructuredValidationError,
  type StructuredTransport,
} from '../src/llm/structured-prompt-runner.js';

/** Promise.withResolvers equivalent — the repo lib target predates es2024. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const Reply = Type.Object({ answer: Type.Integer() });

describe('StructuredPromptRunner (spec §3.15 semantics)', () => {
  it('parses direct JSON responses', async () => {
    const runner = new StructuredPromptRunner({ transport: new FakeTransport(['{"answer":42}']) });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).resolves.toEqual({
      answer: 42,
    });
  });

  it('extracts JSON from a fenced ```json block', async () => {
    const fenced = 'Here you go:\n```json\n{"answer": 7}\n```\nThanks!';
    const runner = new StructuredPromptRunner({ transport: new FakeTransport([fenced]) });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).resolves.toEqual({
      answer: 7,
    });
  });

  it('repairs exactly once and embeds the validation errors in the repair prompt', async () => {
    const transport = new FakeTransport(['not json at all', '{"answer":3}']);
    const runner = new StructuredPromptRunner({ transport });
    const result = await runner.run({ schema: Reply, systemPrompt: 'sys prompt', input: { q: 1 } });
    expect(result).toEqual({ answer: 3 });
    expect(transport.prompts).toHaveLength(2);
    const repair = transport.prompts[1]!.userPrompt;
    expect(repair).toContain('Your previous response was invalid');
    expect(repair).toContain('not json at all'); // previous response echoed
    expect(repair).toContain('response contains no parsable JSON'); // error embedded
    expect(repair).not.toBe(transport.prompts[0]!.userPrompt);
  });

  it('feeds schema violations into the repair prompt', async () => {
    const transport = new FakeTransport(['{"answer": "wrong-type"}', '{"answer":9}']);
    const runner = new StructuredPromptRunner({ transport });
    const result = await runner.run({
      schema: Type.Object({ answer: Type.Integer({ minimum: 0 }) }),
      systemPrompt: 's',
      input: {},
    });
    expect(result).toEqual({ answer: 9 });
    expect(transport.prompts).toHaveLength(2);
    expect(transport.prompts[1]!.userPrompt).toContain('Your previous response was invalid');
    expect(transport.prompts[1]!.userPrompt).toContain('Expected integer'); // TypeBox error text
  });

  it('semantic validate() errors share the single repair attempt', async () => {
    const transport = new FakeTransport(['{"answer":3}', '{"answer":4}']);
    const runner = new StructuredPromptRunner({ transport });
    const result = await runner.run({
      schema: Reply,
      systemPrompt: 's',
      input: {},
      validate: (value) => ((value).answer === 3 ? ['semantic: no 3'] : []),
    });
    expect(result).toEqual({ answer: 4 });
    // Schema-valid first response still consumed the ONE repair on semantic errors.
    expect(transport.prompts).toHaveLength(2);
    expect(transport.prompts[1]!.userPrompt).toContain('semantic: no 3');
  });

  it('throws typed StructuredValidationError after the second invalid response', async () => {
    const transport = new FakeTransport(['{"answer":"x"}', '{"nope":true}']);
    const runner = new StructuredPromptRunner({ transport });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).rejects.toThrowError(
      StructuredValidationError,
    );
    // Exactly one repair attempt happened.
    expect(transport.prompts).toHaveLength(2);
  });

  it('propagates transport failures untouched — no repair attempt on outages', async () => {
    const transport = new FailingTransport(new Error('LLM unreachable'));
    const runner = new StructuredPromptRunner({ transport });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).rejects.toThrowError(
      'LLM unreachable',
    );
  });

  it('enforces the per-attempt timeout', async () => {
    const slow: StructuredTransport = {
      complete: () => new Promise<string>(() => undefined), // never settles
    };
    const runner = new StructuredPromptRunner({ transport: slow, timeoutMs: 25 });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).rejects.toThrowError(
      /timed out after 25ms/,
    );
  });

  it('aborts the in-flight transport when the attempt timeout fires', async () => {
    // Regression pin: the timeout must tear down the underlying stream, not
    // just reject the local promise — an abandoned attempt keeps burning
    // tokens while the job retry ladder stacks a second concurrent inference.
    let observed: AbortSignal | undefined;
    const slow: StructuredTransport = {
      complete: (_system: string, _user: string, signal?: AbortSignal) => {
        observed = signal;
        return new Promise<string>(() => undefined); // never settles
      },
    };
    const runner = new StructuredPromptRunner({ transport: slow, timeoutMs: 25 });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).rejects.toThrowError(
      /timed out after 25ms/,
    );
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(true);
  });

  it('hands each attempt a fresh, unaborted signal and leaves success paths untouched', async () => {
    const transport = new FakeTransport(['{"answer":1}', '{"answer":2}']);
    const runner = new StructuredPromptRunner({ transport, timeoutMs: 5_000 });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).resolves.toEqual({ answer: 1 });
    expect(transport.prompts[0]!.signal?.aborted).toBe(false);
  });

  it('never stacks concurrent inferences across the timeout retry ladder', async () => {
    // Regression pin: once an attempt times out, its inference must actually
    // settle (abort tears down the stream) BEFORE the next attempt starts —
    // otherwise each retry stacks a second concurrent complete() on top of
    // the abandoned one and doubles token cost.
    vi.useFakeTimers();
    let active = 0;
    let maxConcurrent = 0;
    let attempts = 0;
    const tracked: StructuredTransport = {
      complete: (_system, _user, signal) => {
        attempts += 1;
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        const attempt = deferred<string>();
        // A real client settles when its signal aborts; only the abort makes
        // attempt 1's slot free for attempt 2.
        signal?.addEventListener('abort', () => attempt.reject(signal.reason), { once: true });
        if (attempts > 1) {
          attempt.resolve('{"answer":2}');
        }
        return attempt.promise.finally(() => {
          active -= 1;
        });
      },
    };
    const runner = new StructuredPromptRunner({ transport: tracked, timeoutMs: 25 });
    const firstRun = runner.run({ schema: Reply, systemPrompt: 's', input: {} });
    firstRun.catch(() => undefined); // rejection asserted below; avoid unhandled warnings
    await vi.advanceTimersByTimeAsync(25); // attempt 1 times out and aborts
    await expect(firstRun).rejects.toThrowError(/timed out after 25ms/);
    // Job-layer retry issues the next attempt only after the first failed.
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).resolves.toEqual({
      answer: 2,
    });
    expect(attempts).toBe(2);
    expect(maxConcurrent).toBe(1);
    vi.useRealTimers();
  });

  it('gives the repair attempt its own full per-attempt timeout', async () => {
    // Regression pin: the first response lands just under timeoutMs and is
    // invalid; the repair lands a further ~timeoutMs later and must still
    // succeed. A shared run-level timer would have expired mid-repair.
    vi.useFakeTimers();
    let attempts = 0;
    const slow: StructuredTransport = {
      complete: () => {
        attempts += 1;
        const { promise, resolve } = deferred<string>();
        setTimeout(() => resolve(attempts === 1 ? 'not json at all' : '{"answer":9}'), 30);
        return promise;
      },
    };
    const runner = new StructuredPromptRunner({ transport: slow, timeoutMs: 40 });
    const pending = runner.run({ schema: Reply, systemPrompt: 's', input: {} });
    await vi.advanceTimersByTimeAsync(30); // t=30 < 40ms: attempt 1 arrives, invalid → repair
    await vi.advanceTimersByTimeAsync(30); // t=60 > 40ms: repair still alive → own timer
    await expect(pending).resolves.toEqual({ answer: 9 });
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('hands the repair attempt a fresh, unaborted signal', async () => {
    // Regression pin: the repair call must not reuse the first attempt's
    // controller/signal — a stale aborted signal would kill the repair
    // in-flight on transports that honor it.
    const transport = new FakeTransport(['not json', '{"answer":3}']);
    const runner = new StructuredPromptRunner({ transport });
    await expect(runner.run({ schema: Reply, systemPrompt: 's', input: {} })).resolves.toEqual({
      answer: 3,
    });
    expect(transport.prompts[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(transport.prompts[1]?.signal?.aborted).toBe(false);
  });
});
