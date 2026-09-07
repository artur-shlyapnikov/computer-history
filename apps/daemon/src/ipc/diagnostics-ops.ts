import type { Db } from '../db/database.js';
import type { RecentError } from '../logging.js';
import type { Router } from './router.js';

export interface DiagnosticsOpsDeps {
  db: Db;
  /** Newest-first error-ring accessor (createLogger's recentErrors). */
  lastErrors: () => RecentError[];
}

/**
 * Read-only diagnostics surface (contracts §Protocol v1): `diagnostics.get`
 * reports a quick_check integrity flag plus the newest-first tail of the
 * daemon's in-memory error ring. quick_check runs instead of the full
 * integrity_check the startup gate uses (openDatabase) — interactive latency
 * on an op the recorder can fire any time matters more than page-by-page
 * depth here.
 */
export function registerDiagnosticsOps(router: Router, deps: DiagnosticsOpsDeps): void {
  router.register('diagnostics.get', () => {
    const integrityOk = deps.db.pragma('quick_check', { simple: true }) === 'ok';
    return {
      integrityOk,
      lastErrors: deps.lastErrors(),
    };
  });
}
