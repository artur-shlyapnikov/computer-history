import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, type Db } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrator.js';

export interface TempDb {
  db: Db;
  /** Isolated home directory containing history.db (for file-mode / sidecar probes). */
  home: string;
  close: () => void;
}

/**
 * Uniform DB fixture: fresh tmp home, opened + migrated database with the
 * journal switched to MEMORY so tests never touch WAL sidecars unless they
 * explicitly want to (see single-open-index.test.ts for that flow).
 */
export function tempDb(): TempDb {
  const home = mkdtempSync(path.join(tmpdir(), 'computer-history-test-'));
  const db = openDatabase(path.join(home, 'history.db'));
  db.pragma('journal_mode = MEMORY');
  migrate(db);
  return {
    db,
    home,
    close: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
