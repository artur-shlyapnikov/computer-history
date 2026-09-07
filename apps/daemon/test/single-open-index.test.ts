import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CONSTANTS } from '../src/config.js';
import { openDatabase, startCheckpointWatch } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';

describe('single-open activity segment index (GateM2 finding 1)', () => {
  it('applies 002 and rejects a second globally-open segment INSERT', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db);
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(first.schemaVersion).toBe(13);

    const insert = db.prepare(
      `INSERT INTO activity_segments (id, started_at_ms, state, event_count, created_at_ms)
       VALUES (?, ?, ?, 0, ?)`,
    );
    insert.run('seg-1', 1_000, 'open', 1_000);

    // The partial unique index enforces spec §3.13 at the schema level.
    expect(() => insert.run('seg-2', 2_000, 'open', 2_000)).toThrowError(
      /UNIQUE constraint failed/,
    );

    // Non-open states stay unrestricted.
    insert.run('seg-3', 3_000, 'finalized', 3_000);
    insert.run('seg-4', 4_000, 'failed', 4_000);

    // Re-running the migrator is a no-op (IF NOT EXISTS keeps it idempotent).
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });
});

describe('pinned database constants (contracts §Numeric constants)', () => {
  it('opens every database with the pinned 5000 ms busy_timeout', () => {
    // Direct pin: a silent retune of CONSTANTS.busyTimeoutMs must fail here.
    expect(CONSTANTS.busyTimeoutMs).toBe(5000);
    const db = openDatabase(':memory:');
    try {
      const busy = db.pragma('busy_timeout', { simple: true });
      expect(busy).toBe(CONSTANTS.busyTimeoutMs);
    } finally {
      db.close();
    }
  });

  it('checkpoint watch fires a passive checkpoint once the WAL crosses the trigger', () => {
    // Direct pin: the production watch trigger is exactly 32 MiB.
    expect(CONSTANTS.walCheckpointBytes).toBe(32 * 1024 * 1024);

    const home = mkdtempSync(path.join(tmpdir(), 'ch-checkpoint-watch-'));
    const dbPath = path.join(home, 'history.db');
    const db = openDatabase(dbPath);
    migrate(db);
    try {
      // Grow the REAL WAL file past an injected trigger (production uses the
      // pinned 32 MiB constant through this same code path).
      db.exec('CREATE TABLE blob_sink (id INTEGER PRIMARY KEY, b BLOB NOT NULL)');
      const insert = db.prepare('INSERT INTO blob_sink (b) VALUES (?)');
      const fill = db.transaction(() => {
        for (let i = 0; i < 8; i += 1) insert.run(Buffer.alloc(64 * 1024, i));
      });
      fill();
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(256 * 1024);

      vi.useFakeTimers();
      const pragmaSpy = vi.spyOn(db, 'pragma');
      const stop = startCheckpointWatch(db, dbPath, 256 * 1024, 1_000);
      try {
        vi.advanceTimersByTime(1_000); // one tick crosses the threshold
        expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)');
      } finally {
        stop();
        vi.useRealTimers();
        pragmaSpy.mockRestore();
      }
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
