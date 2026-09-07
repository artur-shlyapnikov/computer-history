import { describe, expect, it, vi } from 'vitest';

import { OpError, Router } from '../src/ipc/router.js';

/**
 * Round-30 pin: non-OpError handler exceptions must NOT forward their raw
 * message to the peer — SQL/filesystem internals stay server-side in the
 * error-level log; the wire only ever sees the generic 'internal error'.
 */
describe('Router internal-error masking', () => {
  function setup() {
    const logger = { log: vi.fn() };
    const router = new Router(logger);
    return { logger, router };
  }

  it('answers a plain Error with the generic message and logs full detail', async () => {
    const { logger, router } = setup();
    router.register('status.get', () => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: episodes.id');
    });

    const outcome = await router.dispatch('status.get', {});

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.internal', message: 'internal error' },
    });
    // Full detail stays server-side at error level.
    const logCall = logger.log.mock.calls.find((call) => call[2] === 'op failed');
    expect(logCall).toBeDefined();
    expect(logCall?.[0]).toBe('error');
    const fields: unknown = logCall?.[3];
    expect(fields && typeof fields === 'object' && 'errorMessage' in fields).toBe(true);
    if (fields && typeof fields === 'object' && 'errorMessage' in fields) {
      expect(String(fields.errorMessage)).toContain('SQLITE_CONSTRAINT');
      expect('stack' in fields).toBe(true);
    }
  });

  it('keeps OpError messages verbatim on the wire', async () => {
    const { router } = setup();
    router.register('status.get', () => {
      throw new OpError('error.not_found', 'no episode with id 01XYZ');
    });

    const outcome = await router.dispatch('status.get', {});

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.not_found', message: 'no episode with id 01XYZ' },
    });
  });

  it('masks non-Error throwables too', async () => {
    const { router } = setup();
    router.register('status.get', () => {
      // The masking contract must hold for exotic throwables, not just
      // Errors:
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a bare string failure';
    });

    const outcome = await router.dispatch('status.get', {});

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.internal', message: 'internal error' },
    });
  });
  it('masks plain Errors on the events.batch path too', async () => {
    const { logger, router } = setup();
    router.registerBatch(() => {
      throw new Error('UNIQUE constraint failed: raw_events.id');
    });

    const outcome = await router.dispatchBatch({ batchId: 'b1', events: [] } as never);

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.internal', message: 'internal error' },
    });
    // Full detail stays server-side at error level.
    const logCall = logger.log.mock.calls.find((call) => call[2] === 'events.batch failed');
    expect(logCall).toBeDefined();
    expect(logCall?.[0]).toBe('error');
    const fields: unknown = logCall?.[3];
    expect(fields && typeof fields === 'object' && 'errorMessage' in fields).toBe(true);
    if (fields && typeof fields === 'object' && 'errorMessage' in fields) {
      expect(String(fields.errorMessage)).toContain('UNIQUE constraint');
      expect('stack' in fields).toBe(true);
    }
  });

  // Round-32 pin: an OpError whose code is 'error.internal' gets the same
  // treatment as a bare Error — no throw site currently builds one, but if
  // `new OpError('error.internal', err.message)` ever appears, its raw message
  // must never reach the peer.
  it('masks an OpError carrying code error.internal like any other internal failure', async () => {
    const { logger, router } = setup();
    router.register('status.get', () => {
      throw new OpError('error.internal', 'SQL detail: select * from secrets');
    });

    const outcome = await router.dispatch('status.get', {});

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.internal', message: 'internal error' },
    });
    // Full detail stays server-side at error level with op context.
    const logCall = logger.log.mock.calls.find((call) => call[2] === 'op failed');
    expect(logCall).toBeDefined();
    expect(logCall?.[0]).toBe('error');
    const fields = logCall?.[3] as { op?: string; errorMessage?: string };
    expect(fields.op).toBe('status.get');
    expect(String(fields.errorMessage)).toContain('SQL detail');
  });

  it('keeps non-internal OpError codes verbatim on the wire', async () => {
    const { logger, router } = setup();
    router.register('status.get', () => {
      throw new OpError('error.invalid_params', 'episodeId must be a ULID');
    });

    const outcome = await router.dispatch('status.get', {});

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'error.invalid_params', message: 'episodeId must be a ULID' },
    });
    // Rejected ops stay at info level — not treated as internal failures.
    const logCall = logger.log.mock.calls.find((call) => call[2] === 'op rejected');
    expect(logCall?.[0]).toBe('info');
  });
});
