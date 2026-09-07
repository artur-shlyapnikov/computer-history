import { readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { tempDb } from './helpers/db.js';

/**
 * migrate() contract pins (runs on every daemon boot): ascending-complete
 * application, idempotency, recorded timestamps, FK-pragma restoration.
 */

const NOW = Date.UTC(2026, 2, 3, 4, 5, 6);
const MIGRATION_COUNT = readdirSync(path.join(import.meta.dirname, '../src/db/migrations')).length;

describe('migrate contract', () => {
  let db: Db;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-migrator-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('a fresh db applies every migration in ascending order', () => {
    const result = migrate(db, NOW);
    expect(result.applied).toEqual(Array.from({ length: MIGRATION_COUNT }, (_, i) => i + 1));
    expect(result.schemaVersion).toBe(MIGRATION_COUNT);

    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual(result.applied);
  });

  it('a second run applies nothing and changes nothing', () => {
    const first = migrate(db, NOW);
    const rowsBefore = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;

    const second = migrate(db, NOW + 1_000);
    expect(second.applied).toEqual([]);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    const rowsAfter = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    expect(rowsAfter).toBe(rowsBefore);
  });

  it('records the injected timestamp on every applied row', () => {
    migrate(db, NOW);
    const rows = db.prepare('SELECT applied_at_ms FROM schema_migrations').all() as Array<{ applied_at_ms: number }>;
    expect(rows.length).toBe(MIGRATION_COUNT);
    for (const row of rows) expect(row.applied_at_ms).toBe(NOW);
  });

  it('restores PRAGMA foreign_keys = ON after the run', () => {
    // The run switches the pragma OFF internally; the finally block must undo it.
    migrate(db, NOW);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('helper fixture parity: tempDb() lands fully migrated and idempotent', () => {
    db.close();
    const t = tempDb();
    try {
      expect(migrate(t.db, NOW).applied).toEqual([]);
      expect((t.db.pragma('foreign_keys', { simple: true }) as number)).toBe(1);
    } finally {
      t.close();
    }
  });
});
