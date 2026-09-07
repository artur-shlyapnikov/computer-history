import { describe, expect, it, vi } from 'vitest';

import { OpError, Router } from '../src/ipc/router.js';

/**
 * The Router owns BOTH wire sides of every op (validation moved behind the
 * interface from the individual ops modules): params are checked against
 * `Ops[op].params` BEFORE the handler runs, and the returned value against
 * `Ops[op].result` AFTER it — an invalid server output must never reach the
 * wire and must mask exactly like any other internal failure.
 */
describe('Router central op contract', () => {
  function setup() {
    const logger = { log: vi.fn() };
    const router = new Router(logger);
    return { logger, router };
  }

  it('passes schema-valid params to the handler and a valid result through', async () => {
    const { router } = setup();
    const requestId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const handler = vi.fn((_params) => ({ cancelled: false }));
    router.register('chat.cancel', handler);

    const outcome = await router.dispatch('chat.cancel', { requestId });

    expect(outcome).toEqual({ ok: true, result: { cancelled: false } });
    expect(handler).toHaveBeenCalledWith({ requestId });
  });

  it('rejects invalid params without ever invoking the handler', async () => {
    const { logger, router } = setup();
    const handler = vi.fn(() => ({ cancelled: true }));
    router.register('chat.cancel', handler);

    const outcome = await router.dispatch('chat.cancel', { requestId: 42 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('error.invalid_params');
    expect(handler).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalledWith('error', 'router', expect.anything(), expect.anything());
  });

  it('masks a contract-invalid result as error.internal and logs the offending paths', async () => {
    const { logger, router } = setup();
    // Shape bug: chat.cancel's pinned result is {cancelled: boolean}.
    router.register('chat.cancel', () => ({ cancelled: 'yes' }) as never);

    const outcome = await router.dispatch('chat.cancel', { requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });

    expect(outcome).toEqual({ ok: false, error: { code: 'error.internal', message: 'internal error' } });
    const logCall = logger.log.mock.calls.find(
      (call) => call[2] === 'op handler returned contract-invalid result',
    );
    expect(logCall).toBeDefined();
    expect(logCall?.[0]).toBe('error');
    const fields = logCall?.[3] as { errors?: string[] };
    expect(fields.errors?.length).toBeGreaterThan(0);
  });

  it('still forwards non-internal OpError codes verbatim after result validation exists', async () => {
    const { router } = setup();
    router.register('episode.get', () => {
      throw new OpError('error.not_found', 'no episode with id X');
    });

    const outcome = await router.dispatch('episode.get', { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.not_found', message: 'no episode with id X' },
    });
  });

  it('answers not_implemented only for schema-valid params of unregistered ops', async () => {
    const { router } = setup();

    const badParams = await router.dispatch('jobs.retryDead', { extra: true });
    expect(badParams.ok).toBe(false);
    if (!badParams.ok) expect(badParams.error.code).toBe('error.invalid_params');

    const okParams = await router.dispatch('jobs.retryDead', {});
    expect(okParams).toEqual({
      ok: false,
      error: { code: 'error.not_implemented', message: 'op jobs.retryDead arrives in a later milestone' },
    });
  });
});
