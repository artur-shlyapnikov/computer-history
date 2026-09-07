import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';

import { startDaemon, stopDaemon, type DaemonProcess } from './helpers/ipc.js';

/**
 * DB integrity drill (spec §3.25, brief-m7 §D7 item 2): a deliberately
 * corrupted history.db makes the daemon exit with the typed supervisor
 * contract DB_CORRUPT / exit code 46 — WITHOUT deleting or recreating the
 * file — and log the pinned phrase "History database needs recovery".
 */
describe('daemon DB integrity drill (real process, temp home)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-integrity-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function corruptDb(): { dbPath: string; bytesBefore: Buffer } {
    const dbPath = path.join(home, 'data', 'history.db');
    mkdirSync(path.join(home, 'data'), { recursive: true });
    const db = openDatabase(dbPath);
    migrate(db);
    db.close();

    const bytesBefore = readFileSync(dbPath);
    // Splice 4KiB of garbage in at offset 8192: integrity_check fails on the
    // next open, but the SQLite header remains readable so better-sqlite3 can
    // open the file and run the pragma (typed CorruptDatabaseError, never an
    // auto-recreate).
    const garbage = Buffer.alloc(4096, 0xde);
    garbage.write('CORRUPTED-BY-DRILL', 0, 'utf8');
    const corrupted = Buffer.concat([
      bytesBefore.subarray(0, 8192),
      garbage,
      bytesBefore.subarray(8192 + 4096),
    ]);
    writeFileSync(dbPath, corrupted);
    return { dbPath, bytesBefore: corrupted };
}

  it('exits DB_CORRUPT (46) without recreating or replacing the corrupt database', async () => {
    const { dbPath, bytesBefore } = corruptDb();

    let daemon: DaemonProcess | null = null;
    try {
      daemon = startDaemon(home);
      await expect(daemon.ready).rejects.toThrow(/never started accepting/);
    } finally {
      if (daemon) await stopDaemon(daemon.child); // reap the already-dead process
    }

    expect(daemon.child.exitCode).toBe(46);
    // The typed contract must also reach stderr (supervisor-visible), not just the JSONL log.
    expect(daemon.stderrText()).toContain('History database needs recovery');
    expect(readFileSync(dbPath)).toEqual(bytesBefore); // NOT recreated/replaced

    const log = readFileSync(path.join(home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).toContain('History database needs recovery');

    // The corrupt run failed BEFORE WAL mode was enabled — no side files.
    expect(existsSync(dbPath + '-wal')).toBe(false);
  }, 20_000);
});
