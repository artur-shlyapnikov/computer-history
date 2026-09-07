import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';

/**
 * SEC-003: the database file AND its WAL sidecars must be owner-only (0600).
 * Functional suites never notice a deleted chmod loop — exactly the silent
 * regression class these direct mode pins guard against.
 */

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

describe('openDatabase file modes (SEC-003)', () => {
  const homes: string[] = [];

  function freshHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-db-modes-'));
    homes.push(home);
    return home;
  }

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('a freshly created database file is 0600', () => {
    const dbPath = path.join(freshHome(), 'history.db');
    let db: Db | undefined;
    try {
      db = openDatabase(dbPath);
      expect(modeOf(dbPath)).toBe(0o600);
    } finally {
      db?.close();
    }
  });

  it('pre-existing -wal/-shm sidecars staged world-readable are tightened on reopen', () => {
    const home = freshHome();
    const dbPath = path.join(home, 'history.db');

    // SQLite removes -wal/-shm on clean close, so stage them by hand: the
    // tightening loop in openDatabase runs over whatever exists on disk.
    writeFileSync(`${dbPath}-wal`, '');
    writeFileSync(`${dbPath}-shm`, '');

    closeSync(openSync(dbPath, 'w')); // zero-length file = fresh SQLite db
    chmodSync(dbPath, 0o644);
    chmodSync(`${dbPath}-wal`, 0o644);
    chmodSync(`${dbPath}-shm`, 0o644);

    const reopened = openDatabase(dbPath);
    try {
      expect(modeOf(dbPath)).toBe(0o600);
      expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
      expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    } finally {
      reopened.close();
    }
  });

  it('enforceSidecarPerms tightens a lazily created WAL after a post-open write', () => {
    const dbPath = path.join(freshHome(), 'history.db');
    const db = openDatabase(dbPath);
    try {
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
      expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
      expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('the :memory: pseudo-path opens fine with no chmod attempted', () => {
    const db = openDatabase(':memory:');
    try {
      expect(db.open).toBe(true);
    } finally {
      db.close();
    }
  });

});
