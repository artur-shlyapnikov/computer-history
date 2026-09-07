import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmConfig } from '../src/config.js';

/**
 * Memoization semantics of the process-wide PiRuntime singleton: a failed
 * create() (e.g. auth.json momentarily unreadable) must clear the memo so the
 * next get() re-attempts creation instead of replaying a cached rejection for
 * process lifetime — which would burn the job retry ladder without ever
 * rebuilding the runtime. Each test re-imports the module under `vi.mock` so
 * the private static memo starts fresh.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    // Structural stand-in for the SDK runtime; PiRuntime only stores it.
    create: (...args: unknown[]) => createMock(...args),
  },
}));

const CONFIG: LlmConfig = { chatModel: 'm/chat', backgroundModel: 'm/bg' };

async function freshModule() {
  vi.resetModules();
  return import('../src/llm/pi-runtime.js');
}

beforeEach(() => {
  createMock.mockReset();
});

describe('PiRuntime.get', () => {
  it('clears the memo on rejection so the next get() re-attempts create', async () => {
    const { PiRuntime } = await freshModule();
    const failure = new Error('auth.json temporarily unreadable');
    createMock.mockRejectedValueOnce(failure);
    const rebuilt = {};
    createMock.mockResolvedValueOnce(rebuilt);

    await expect(PiRuntime.get(CONFIG)).rejects.toBe(failure);
    expect(createMock).toHaveBeenCalledTimes(1);

    // Second attempt must rebuild, not replay the cached rejection.
    const second = await PiRuntime.get(CONFIG);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(second.getSdkRuntime()).toBe(rebuilt);
  });

  it('keeps sharing one memoized instance while creation succeeds', async () => {
    const { PiRuntime } = await freshModule();
    const sdk = {};
    const pending = deferred<unknown>();
    createMock.mockReturnValue(pending.promise);

    const first = PiRuntime.get(CONFIG);
    const second = PiRuntime.get(CONFIG);
    expect(second).toBe(first); // concurrent callers share one promise
    expect(createMock).toHaveBeenCalledTimes(1);

    pending.resolve(sdk);
    const resolved = await first;
    expect(resolved.getSdkRuntime()).toBe(sdk);
    expect((await PiRuntime.get(CONFIG)).getSdkRuntime()).toBe(sdk);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
