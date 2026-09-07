import { describe, expect, it, vi } from 'vitest';

import { registerDeleteOps } from '../src/ipc/delete-ops.js';
import { Router } from '../src/ipc/router.js';

/**
 * delete.range wire-level guards (delete-ops.ts): the three malformed-param
 * branches live ONLY in the op layer — DeleteService.deleteRange accepts
 * whatever it gets, so removing a guard would silently answer ok:true for
 * destructive deletes. Also pinned: verbatim pass-through of valid params and
 * the fire-only-post-commit onChanged fold.
 */

const FULL_RESULT = {
  rawEvents: 0,
  steps: 0,
  episodes: 0,
  memories: 0,
  workflows: 0,
};

function setup() {
  const router = new Router({ log: () => undefined });
  const deleteRange = vi.fn(() => FULL_RESULT);
  const onChanged = vi.fn();
  registerDeleteOps(router, {
    deletes: { deleteRange } as never,
    onChanged,
  });
  return { router, deleteRange, onChanged };
}

describe('delete.range op-layer guards', () => {
  it('rejects preset AND from/to together with invalid_params ("not both")', async () => {
    const { router, deleteRange, onChanged } = setup();

    const outcome = await router.dispatch('delete.range', {
      preset: 'today',
      from: 0,
      to: 10,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('error.invalid_params');
      expect(outcome.error.message).toContain('not both');
    }
    expect(deleteRange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('rejects half-bounds and empty params ("both from and to, or a preset")', async () => {
    const { router, deleteRange, onChanged } = setup();

    for (const params of [{ from: 5 }, {}]) {
      const outcome = await router.dispatch('delete.range', params);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('error.invalid_params');
        expect(outcome.error.message).toContain('both from and to, or a preset');
      }
    }
    expect(deleteRange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('rejects an inverted window (from > to)', async () => {
    const { router, deleteRange } = setup();

    const outcome = await router.dispatch('delete.range', { from: 100, to: 99 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('error.invalid_params');
      expect(outcome.error.message).toContain('from <= to');
    }
    expect(deleteRange).not.toHaveBeenCalled();
  });

  it('passes a valid preset through verbatim and fires onChanged once AFTER the result', async () => {
    const { router, deleteRange, onChanged } = setup();
    const params = { preset: 'last_hour' as const };

    const outcome = await router.dispatch('delete.range', params);

    expect(outcome).toEqual({ ok: true, result: { deleted: FULL_RESULT } });
    expect(deleteRange).toHaveBeenCalledTimes(1);
    expect(deleteRange).toHaveBeenCalledWith(params);
    // Fold contract: the *_changed broadcasts fire only post-commit — i.e.
    // after deleteRange returned, never before.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
      deleteRange.mock.invocationCallOrder[0]!,
    );
  });

  it('fires onChanged even when the post-commit result self-check fails', async () => {
    const { router, deleteRange, onChanged } = setup();
    // Shape violation: deleteRange returned a contract-breaking payload.
    deleteRange.mockReturnValue({ rawEvents: 'not-a-number' } as never);

    const outcome = await router.dispatch('delete.range', { preset: 'last_hour' });

    // The mutation committed, so clients must get the *_changed truth even
    // though the op answers error.internal (self-check = programming bug).
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('error.internal');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('accepts a degenerate from === to window (guard is strictly >)', async () => {
    const { router, deleteRange } = setup();

    const outcome = await router.dispatch('delete.range', { from: 500, to: 500 });

    expect(outcome.ok).toBe(true);
    expect(deleteRange).toHaveBeenCalledWith({ from: 500, to: 500 });
  });
});
