import type { Db } from '../db/database.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface MigrationResult {
  applied: number[];
  schemaVersion: number;
}

interface MigrationFile {
  version: number;
  sql: string;
}

const migrationsDir = path.join(import.meta.dirname, 'migrations');

function loadMigrations(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .map((f) => ({ version: Number.parseInt(f.slice(0, 3), 10), sql: readFileSync(path.join(migrationsDir, f), 'utf8') }))
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply pending migrations in ascending order, each inside a transaction and
 * recorded in schema_migrations. Idempotent: already-applied versions skip.
 */
export function migrate(db: Db, now = Date.now()): MigrationResult {
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )`);
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    const applied = new Set(appliedRows.map((r) => r.version));
    const newlyApplied: number[] = [];
    const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)');
    for (const migration of loadMigrations()) {
      if (applied.has(migration.version)) continue;
      const run = db.transaction(() => {
        db.exec(migration.sql);
        insert.run(migration.version, now);
      });
      run();
      newlyApplied.push(migration.version);
    }
    const schemaVersion = loadMigrations().reduce((max, m) => Math.max(max, m.version), 0);
    return { applied: newlyApplied, schemaVersion };
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
