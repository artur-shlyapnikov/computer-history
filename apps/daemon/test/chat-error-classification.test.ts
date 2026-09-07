import { describe, expect, it, vi } from 'vitest';

import {
  ChatRunError,
  ChatSessionManager,
  classifyChatError,
} from '../src/agent/agent-session.js';
import { LlmUnavailableError } from '../src/llm/pi-runtime.js';
import { makeFakeChatSession, type FakeChatSession } from './helpers/chat-session.js';
/**
 * Wire-code classification partitions (contracts §Protocol v1) and the
 * manager-level delta/abort seams. classifyChatError is pure; manager cases
 * use the scripted fake session with GC disabled (timer-free).
 */
describe('classifyChatError decision table', () => {
  it('passes ChatRunError through unchanged (same object semantics)', () => {
    const err = new ChatRunError('busy', 'session s1 already has a run in flight');
    expect(classifyChatError(err, false)).toBe(err);
    expect(classifyChatError(err, true)).toBe(err);
    expect(err.message).toBe('session s1 already has a run in flight');
  });

  it('aborted=true wins over an LlmUnavailableError', () => {
    const out = classifyChatError(new LlmUnavailableError('no credentials'), true);
    expect(out.code).toBe('aborted');
  });

  it('maps AbortError-named errors to aborted', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyChatError(err, false).code).toBe('aborted');
  });

  it('maps ABORT_ERR-coded errors to aborted', () => {
    expect(
      classifyChatError(Object.assign(new Error('request aborted upstream'), { code: 'ABORT_ERR' }), false)
        .code,
    ).toBe('aborted');
  });

  it('maps abort-SHAPED messages to internal (round-27: provider-side aborts are not user cancels)', () => {
    expect(classifyChatError(new Error('request aborted upstream'), false).code).toBe('internal');
  });

  it('maps LlmUnavailableError to llm_unavailable keeping the original message', () => {
    const out = classifyChatError(new LlmUnavailableError('no credentials configured'), false);
    expect(out.code).toBe('llm_unavailable');
    expect(out.message).toBe('no credentials configured');
  });

  it.each([
    ['Invalid API key'],
    ['401 Unauthorized'],
    ['authentication failed'],
    ['missing credential'],
    ['HTTP 403'],
  ])('maps credential failure %j to llm_unavailable', (message) => {
    const out = classifyChatError(new Error(message), false);
    expect(out.code).toBe('llm_unavailable');
    expect(out.message).toBe(message);
  });

  it('handles non-Error throwables via String()', () => {
    const internal = classifyChatError('quota exceeded', false);
    expect(internal.code).toBe('internal');
    expect(internal.message).toBe('quota exceeded');

    // The credential regex still applies to stringified non-Errors.
    const cred = classifyChatError('401 from provider', false);
    expect(cred.code).toBe('llm_unavailable');
  });

  it('maps a generic transport error to internal', () => {
    const out = classifyChatError(new Error('socket hung up'), false);
    expect(out.code).toBe('internal');
    expect(out.message).toBe('socket hung up');
  });
});

function makeManager(fake: FakeChatSession): ChatSessionManager {
  return new ChatSessionManager({
    sessionFactory: async () => fake,
    systemPrompt: 'SYS',
    gcSweepIntervalMs: 0,
  });
}

describe('manager stream and abort seams', () => {
  it('emits nothing on snapshot replacement and re-baselines after a rewind', async () => {
    const fake = makeFakeChatSession();
    const manager = makeManager(fake);
    const deltas: string[] = [];
    const done = manager.send({ sessionId: 's1', text: 'hi' }, (d) => deltas.push(d));
    await vi.waitFor(() => {
      expect(fake.prompts).toHaveLength(1);
    });

    fake.emitUpdate('hello');
    fake.emitUpdate('hello world');
    fake.emitUpdate('hel'); // replacement: no delta, no crash
    fake.emitUpdate('help'); // growth relative to the NEW baseline
    fake.finishPrompt();

    await done;
    expect(deltas).toEqual(['hello', ' world', 'p']);
    await manager.dispose();
  });

  it('rejects a pre-aborted signal before any prompt runs', async () => {
    const fake = makeFakeChatSession();
    const manager = makeManager(fake);
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.send({ sessionId: 's1', text: 'too late', signal: controller.signal }, () => {}),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fake.prompts).toHaveLength(0); // fail fast: no LLM turn for a dead input
    await manager.dispose();
  });

  it('concatenates multi-block assistant content in order', async () => {
    const fake = makeFakeChatSession();
    const manager = makeManager(fake);
    const deltas: string[] = [];
    const done = manager.send({ sessionId: 's1', text: 'hi' }, (d) => deltas.push(d));
    await vi.waitFor(() => {
      expect(fake.prompts).toHaveLength(1);
    });

    fake.emitContent([{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }]);
    fake.finishPrompt();

    await done;
    expect(deltas).toEqual(['AB']);
    await manager.dispose();
  });

  it('abort(busyId) forwards to the in-flight session and reports it', async () => {
    const fake = makeFakeChatSession();
    const manager = makeManager(fake);
    const done = manager.send({ sessionId: 's1', text: 'hi' }, () => {});
    await vi.waitFor(() => {
      expect(fake.prompts).toHaveLength(1);
    });

    expect(manager.abort('s1')).toBe(true);
    expect(fake.aborted).toBe(true);

    fake.finishPrompt();
    await done;
    await manager.dispose();
  });
});
