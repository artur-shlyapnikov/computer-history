import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { CorruptDatabaseError } from '../src/db/database.js';
import { CONSTANTS } from '../src/config.js';

/**
 * DB integrity drill (spec §3.25, brief-m7 §D7 item 3): a deliberately
 * corrupted history DB makes the daemon exit with the TYPED code
 * CONSTANTS.dbCorruptExitCode (46) WITHOUT recreating or deleting the file,
 * logging «History database needs recovery» for the supervisor.
 */

describe('database integrity handling', () => {
  let home: string;

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  function seedHome(): string {
    home = mkdtempSync(path.join(tmpdir(), 'ch-corrupt-'));
    const dataDir = path.join(home, 'data');
    const paths = [home, dataDir, path.join(home, 'run'), path.join(home, 'logs')];
    for (const dir of paths.slice(1)) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dataDir, 'history.db');
    const db = openDatabase(dbPath);
    migrate(db);
    db.close();
    return dbPath;
  }

  function corruptGarbageHeader(dbPath: string): void {
    // A valid SQLite file starts with "SQLite format 3\0"; overwrite it so
    // even the open() call fails with SQLITE_NOTADB.
    const bytes = Buffer.from('NOT A DATABASE HEADER AT ALL.....', 'utf8');
    const fd = readFileSync(dbPath);
    bytes.copy(fd, 0);
    writeFileSync(dbPath, fd);
  }

  function corruptMidPage(dbPath: string): void {
    // Keep the magic header but destroy page 2 so integrity_check fails.
    const fd = readFileSync(dbPath);
    const offset = 4096;
    for (let i = 0; i < 512; i += 1) fd[offset + i] = 0xde;
    writeFileSync(dbPath, fd);
  }

  it('maps a garbage-header file to CorruptDatabaseError at open time', () => {
    const dbPath = seedHome();
    corruptGarbageHeader(dbPath);
    expect(() => openDatabase(dbPath)).toThrow(CorruptDatabaseError);
  });

  it('maps a mid-page corruption to a failed integrity_check', () => {
    const dbPath = seedHome();
    corruptMidPage(dbPath);
    expect(() => openDatabase(dbPath)).toThrow(CorruptDatabaseError);
  });

  function spawnDaemon(homeDir: string): Promise<{ code: number | null; stderr: string }> {
    const entry = path.join(import.meta.dirname, '..', 'dist', 'main.js');
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, COMPUTER_HISTORY_HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve) => {
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
  }

  it(`spawns: garbage-header DB ⇒ exit ${CONSTANTS.dbCorruptExitCode}, file untouched, recovery log line`, async () => {
    const dbPath = seedHome();
    // A clean close must leave no -wal/-shm sidecars; drop them defensively
    // so the drill corrupts exactly one self-contained file.
    for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

    const fd = readFileSync(dbPath);
    Buffer.from('NOT A DATABASE HEADER AT ALL.....', 'utf8').copy(fd, 0);
    writeFileSync(dbPath, fd);
    const sizeBefore = statSync(dbPath).size;
    const corruptedBytes = readFileSync(dbPath);

    const { code, stderr } = await spawnDaemon(home);
    expect(code, `stderr was: ${stderr}`).toBe(CONSTANTS.dbCorruptExitCode);

    // The daemon must NOT have recreated/deleted/repaired the file.
    expect(statSync(dbPath).size).toBe(sizeBefore);
    expect(readFileSync(dbPath).equals(corruptedBytes)).toBe(true);

    // Supervisor-facing log line (spec §3.25 UI string, verbatim).
    const logText = readFileSync(path.join(home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(logText).toContain('History database needs recovery');
  }, 20_000);
});
