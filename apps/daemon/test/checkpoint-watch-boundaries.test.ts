import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db, openDatabase, startCheckpointWatch } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';

const CHECKPOINT_PRAGMA = 'wal_checkpoint(PASSIVE)';
const TICK_MS = 1_000;
/** Test trigger sits well below production's pinned 32 MiB constant. */
const THRESHOLD_BYTES = 256 * 1024;

describe('checkpoint watch boundary semantics', () => {
  let home: string;
  let dbPath: string;
  let db: Db;

  /** Count only checkpoint calls — spied pragmas include unrelated calls. */
  function checkpointCalls(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((call) => call[0] === CHECKPOINT_PRAGMA).length;
  }


  /**
   * Spy on pragma BEFORE starting the watch so every tick is observed, then
   * run the watch against an injected 1 s interval under fake timers. The
   * pragma is mocked: the staged -wal sidecar is synthetic bytes, not a real
   * WAL SQLite may touch, and the contract under test is only WHICH pragma
   * the watch issues.
   */
  function watchWithSpiedPragma() {
    const spy = vi.spyOn(db, 'pragma').mockImplementation(() => undefined);
    const stop = startCheckpointWatch(db, dbPath, THRESHOLD_BYTES, TICK_MS);
    return { spy, stop };
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-checkpoint-boundaries-'));
    dbPath = path.join(home, 'history.db');
    db = openDatabase(dbPath);
    migrate(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  // PINNED CURRENT BEHAVIOR (database.ts:79): the trigger is STRICTLY
  // greater-than. A watch that starts checkpointing AT the threshold fires
  // every minute forever on a steady-state WAL and starves writers.
  it('does not checkpoint when the WAL is exactly at the threshold', () => {
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(THRESHOLD_BYTES));
    const { spy, stop } = watchWithSpiedPragma();
    try {
      vi.advanceTimersByTime(TICK_MS);
      expect(checkpointCalls(spy)).toBe(0);
    } finally {
      stop();
    }
  });

  it('does not checkpoint when the WAL is one byte below the threshold', () => {
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(THRESHOLD_BYTES - 1));
    const { spy, stop } = watchWithSpiedPragma();
    try {
      vi.advanceTimersByTime(TICK_MS);
      expect(checkpointCalls(spy)).toBe(0);
    } finally {
      stop();
    }
  });

  // The catch-and-return branch must swallow a missing -wal sidecar without
  // killing the interval: later oversized ticks MUST still checkpoint.
  it('survives a missing WAL file and keeps watching', () => {
    rmSync(`${dbPath}-wal`, { force: true });
    const { spy, stop } = watchWithSpiedPragma();
    try {
      // Missing sidecar ticks are silent no-ops (advancing must not throw).
      vi.advanceTimersByTime(TICK_MS * 3);
      expect(checkpointCalls(spy)).toBe(0);

      // The watch is still scheduled: an oversized tick after recovery fires.
      writeFileSync(`${dbPath}-wal`, Buffer.alloc(THRESHOLD_BYTES + 1));
      vi.advanceTimersByTime(TICK_MS);
      expect(checkpointCalls(spy)).toBe(1);
    } finally {
      stop();
    }
  });

  it('stop() halts all further checkpoint ticks', () => {
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(THRESHOLD_BYTES + 1));
    const { spy, stop } = watchWithSpiedPragma();
    stop();
    vi.advanceTimersByTime(TICK_MS * 10);
    expect(checkpointCalls(spy)).toBe(0);
  });

  // Control re-asserting the existing contract cheaply: exactly one passive
  // checkpoint per tick while oversized and running.
  it('checkpoints exactly once per tick when oversized', () => {
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(THRESHOLD_BYTES + 1));
    const { spy, stop } = watchWithSpiedPragma();
    try {
      vi.advanceTimersByTime(TICK_MS);
      expect(checkpointCalls(spy)).toBe(1);
      expect(spy).toHaveBeenCalledWith(CHECKPOINT_PRAGMA);
    } finally {
      stop();
    }
  });
});
