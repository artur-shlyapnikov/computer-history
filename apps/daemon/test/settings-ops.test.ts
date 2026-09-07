import { describe, expect, it } from 'vitest';

import { CONSTANTS } from '../src/config.js';
import { registerSettingsOps } from '../src/ipc/settings-ops.js';
import { Router } from '../src/ipc/router.js';

/**
 * settings.get read-only surface: the op reports the effective daemon
 * settings (env-resolved model ids + pinned retention constants) and
 * validates its params/result frames; settings.set stays unregistered, so
 * the Router answers error.not_implemented.
 */

describe('settings ops', () => {
  it('settings.get returns effective settings matching deps and CONSTANTS', async () => {
    const router = new Router({ log: () => undefined });
    registerSettingsOps(router, {
      chatModel: 'test/chat-model',
      backgroundModel: 'test/background-model',
    });

    const outcome = await router.dispatch('settings.get', {});
    expect(outcome).toEqual({
      ok: true,
      result: {
        settings: {
          chatModel: 'test/chat-model',
          backgroundModel: 'test/background-model',
          rawRetentionHours: CONSTANTS.rawRetentionHours,
          semanticRetentionDays: CONSTANTS.semanticRetentionDays,
        },
      },
    });
  });

  it('settings.get rejects unknown params with error.invalid_params', async () => {
    const router = new Router({ log: () => undefined });
    registerSettingsOps(router, {
      chatModel: 'test/chat-model',
      backgroundModel: 'test/background-model',
    });

    const outcome = await router.dispatch('settings.get', { patch: {} });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('error.invalid_params');
  });

  it('settings.set stays not_implemented', async () => {
    const router = new Router({ log: () => undefined });
    registerSettingsOps(router, {
      chatModel: 'test/chat-model',
      backgroundModel: 'test/background-model',
    });

    const outcome = await router.dispatch('settings.set', { patch: { chatModel: 'x' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('error.not_implemented');
  });
});
