import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { LlmConfig } from '../src/config.js';

/**
 * Model resolution decides which model serves EVERY prompt (contracts
 * §Pi SDK pins fallback chain: exact → same-provider → any → throw), plus the
 * auth-path gating of create() and the per-completion re-get of the background
 * transport. Each scenario re-imports the module under vi.mock so the private
 * static memo starts fresh.
 */

interface FakeSdkRuntime {
  getModel: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
  completeSimple: ReturnType<typeof vi.fn>;
}

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: (...args: unknown[]) => createMock(...args),
  },
}));

function makeSdk(overrides: Partial<FakeSdkRuntime> = {}): FakeSdkRuntime {
  return {
    getModel: vi.fn(() => undefined),
    getModels: vi.fn(() => []),
    completeSimple: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    ...overrides,
  };
}

async function freshRuntime(sdk: FakeSdkRuntime, config: LlmConfig) {
  vi.resetModules();
  createMock.mockReset();
  createMock.mockResolvedValue(sdk);
  const mod = await import('../src/llm/pi-runtime.js');
  const runtime = await mod.PiRuntime.get(config);
  return { runtime, mod };
}

const MODEL = { id: 'main', provider: 'acme' } as never;

describe('resolveModel fallback chain', () => {
  it('exact hit resolves identity without touching getModels', async () => {
    const sdk = makeSdk({ getModel: vi.fn(() => MODEL) });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'm/chat',
      backgroundModel: 'acme/main',
    });
    expect(runtime.getBackgroundModel()).toBe(MODEL);
    expect(sdk.getModel).toHaveBeenCalledTimes(1);
    expect(sdk.getModel).toHaveBeenCalledWith('acme', 'main');
    expect(sdk.getModels).not.toHaveBeenCalled();
  });

  it('a slash-less id skips the exact lookup and lands on the first catalog model', async () => {
    const anyModel = { id: 'whatever', provider: 'zoo' } as never;
    const sdk = makeSdk({
      getModel: vi.fn(() => undefined),
      getModels: vi.fn(() => [anyModel]),
    });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'm/chat',
      backgroundModel: 'main',
    });
    expect(runtime.getBackgroundModel()).toBe(anyModel);
    expect(sdk.getModel).not.toHaveBeenCalled();
    expect(sdk.getModels).toHaveBeenCalledWith(); // global catalog scan
  });

  it('falls back to another model of the SAME provider when the exact id is absent', async () => {
    const p0 = { id: 'other', provider: 'acme' } as never;
    const sdk = makeSdk({
      getModel: vi.fn(() => undefined),
      getModels: vi.fn((provider?: string) => (provider === 'acme' ? [p0] : [])),
    });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'm/chat',
      backgroundModel: 'acme/main',
    });
    expect(runtime.getBackgroundModel()).toBe(p0);
    expect(sdk.getModels).toHaveBeenCalledWith('acme');
  });

  it('falls back to ANY available model when the provider catalog is empty', async () => {
    const anyModel = { id: 'fallback', provider: 'zoo' } as never;
    const sdk = makeSdk({
      getModel: vi.fn(() => undefined),
      getModels: vi.fn((provider?: string) => (provider === undefined ? [anyModel] : [])),
    });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'm/chat',
      backgroundModel: 'acme/main',
    });
    expect(runtime.getBackgroundModel()).toBe(anyModel);
  });

  it('throws LlmUnavailableError naming the configured id when the catalog is empty', async () => {
    const sdk = makeSdk();
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'm/chat',
      backgroundModel: 'acme/main',
    });
    // resolveModel is synchronous: the exhaustion contract surfaces as a throw.
    expect(() => runtime.getBackgroundModel()).toThrowError(
      expect.objectContaining({ name: 'LlmUnavailableError' }) as Error,
    );
    expect(() => runtime.getBackgroundModel()).toThrow('acme/main');
  });

  it('getChatModel/getBackgroundModelId use their respective configured ids', async () => {
    const bg = { id: 'bg', provider: 'acme' } as never;
    const chat = { id: 'chat-model', provider: 'acme' } as never;
    const sdk = makeSdk({
      getModel: vi.fn((_provider: string, id: string) => (id === 'bg' ? bg : chat)),
    });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'acme/chat-model',
      backgroundModel: 'acme/bg',
    });
    expect(runtime.getChatModel()).toBe(chat);
    expect(runtime.resolveChat()).toEqual({ providerId: 'acme', model: chat });
    expect(runtime.getBackgroundModelId()).toBe('bg');
  });
});

describe('completeSimpleText', () => {
  it('concatenates only text blocks and passes systemPrompt + user message', async () => {
    const sdk = makeSdk({
      getModel: vi.fn(() => MODEL),
      completeSimple: vi.fn(async () => ({
        content: [{ type: 'text', text: 'x' }, { type: 'thinking' }, { type: 'text', text: 'y' }],
      })),
    });
    const { runtime } = await freshRuntime(sdk, {
      chatModel: 'acme/main',
      backgroundModel: 'acme/main',
    });
    await expect(runtime.completeSimpleText('background', 'SYS', 'hello')).resolves.toBe('xy');
    expect(sdk.completeSimple).toHaveBeenCalledTimes(1);
    const [, opts] = sdk.completeSimple.mock.calls[0] as [unknown, { systemPrompt: string; messages: Array<{ role: string; content: string }> }];
    expect(opts.systemPrompt).toBe('SYS');
    expect(opts.messages[0]!.role).toBe('user');
    expect(opts.messages[0]!.content).toBe('hello');
  });
});

describe('create() authPath gating', () => {
  it('passes undefined options without an existing auth.json', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-')); // no auth.json inside
    try {
      await freshRuntime(makeSdk(), { agentDir, chatModel: 'c', backgroundModel: 'b' });
      expect(createMock).toHaveBeenCalledWith(undefined);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('passes { authPath } when auth.json exists in the agent dir', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-'));
    try {
      writeFileSync(path.join(agentDir, 'auth.json'), '{}');
      await freshRuntime(makeSdk(), { agentDir, chatModel: 'c', backgroundModel: 'b' });
      expect(createMock).toHaveBeenCalledWith({ authPath: path.join(agentDir, 'auth.json') });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('PiBackgroundTransport', () => {
  it('re-attempts creation on the next completion instead of caching a rejection', async () => {
    vi.resetModules();
    createMock.mockReset();
    const sdk = makeSdk({ getModel: vi.fn(() => MODEL), getModels: vi.fn(() => [MODEL]) });
    createMock.mockRejectedValueOnce(new Error('auth.json momentarily unreadable'));
    createMock.mockResolvedValueOnce(sdk);
    const { PiBackgroundTransport } = await import('../src/llm/pi-runtime.js');
    const transport = new PiBackgroundTransport({ chatModel: 'c', backgroundModel: 'b' });

    await expect(transport.complete('SYS', 'q')).rejects.toThrow('auth.json momentarily unreadable');
    await expect(transport.complete('SYS', 'q')).resolves.toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
