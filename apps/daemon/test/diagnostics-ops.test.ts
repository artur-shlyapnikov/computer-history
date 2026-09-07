import { afterAll, describe, expect, it } from 'vitest';

import { DIAGNOSTICS_MAX_LAST_ERRORS } from '@computer-history/protocol';

import { tempDb, type TempDb } from './helpers/db.js';
import { createLogger, type RecentError } from '../src/logging.js';
import { registerDiagnosticsOps } from '../src/ipc/diagnostics-ops.js';
import { Router } from '../src/ipc/router.js';

/**
 * diagnostics.get read-only surface: the op reports a quick_check integrity
 * flag plus the newest-first tail of the logger's bounded error ring and
 * validates its params/result frames. The corrupt-db leg of integrityOk is
 * pinned by db-corrupt.test.ts at the openDatabase gate; here we pin the ok
 * shape and the error-ring behavior feeding lastErrors.
 */

let dbh: TempDb;
afterAll(() => {
  dbh?.close();
});

describe('diagnostics ops', () => {
  it('diagnostics.get answers ok:true over the real Router on a healthy db', async () => {
    dbh = tempDb();
    const router = new Router({ log: () => undefined });
    registerDiagnosticsOps(router, { db: dbh.db, lastErrors: () => [] });

    const outcome = await router.dispatch('diagnostics.get', {});
    expect(outcome).toEqual({
      ok: true,
      result: { integrityOk: true, lastErrors: [] },
    });
  });

  it('diagnostics.get rejects unknown params with error.invalid_params', async () => {
    dbh = tempDb();
    const router = new Router({ log: () => undefined });
    registerDiagnosticsOps(router, { db: dbh.db, lastErrors: () => [] });

    const outcome = await router.dispatch('diagnostics.get', { verbose: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('error.invalid_params');
  });

  it('the logger error ring is newest-first, capped, and falls back to code "error"', () => {
    const logger = createLogger('/dev/null');
    logger.log('info', 'main', 'not an error');
    logger.log('error', 'ingest', 'first failure', { code: 'bad_batch', content: 'secret' });
    logger.log('warn', 'router', 'still not an error');
    logger.log('error', 'router', 'second failure');

    const ring: RecentError[] = logger.recentErrors();
    expect(ring).toEqual([
      { at: ring[0]!.at, scope: 'router', code: 'error', message: 'second failure' },
      { at: ring[1]!.at, scope: 'ingest', code: 'bad_batch', message: 'first failure' },
    ]);
    // Redaction runs before storage (SEC-004): sensitive fields never ride
    // into the ring even when they share the log call with a real code.
    expect(JSON.stringify(ring)).not.toContain('secret');
  });

  it(`the logger error ring respects the ${DIAGNOSTICS_MAX_LAST_ERRORS}-entry cap`, () => {
    const logger = createLogger('/dev/null');
    for (let i = 0; i < DIAGNOSTICS_MAX_LAST_ERRORS + 5; i++) {
      logger.log('error', 'load', `failure ${i}`);
    }
    const ring = logger.recentErrors();
    expect(ring).toHaveLength(DIAGNOSTICS_MAX_LAST_ERRORS);
    // Oldest entries dropped; newest-first ordering preserved.
    expect(ring[0]!.message).toBe(`failure ${DIAGNOSTICS_MAX_LAST_ERRORS + 4}`);
    expect(ring[DIAGNOSTICS_MAX_LAST_ERRORS - 1]!.message).toBe('failure 5');
  });
});
