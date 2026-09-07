import Database from 'better-sqlite3';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { CONSTANTS } from '../config.js';

/** Thrown when PRAGMA integrity_check fails; the caller must never recreate the file. */
export class CorruptDatabaseError extends Error {
  readonly integrityResult: string;
  constructor(integrityResult: string) {
    super(`SQLite database failed integrity_check: ${integrityResult}`);
    this.name = 'CorruptDatabaseError';
    this.integrityResult = integrityResult;
  }
}

export type Db = Database.Database;

export function openDatabase(dbPath: string): Db {
  let db: Db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    // A garbage header never gets as far as integrity_check; map the two
    // corruption-shaped open failures onto the same typed error so callers
    // keep ONE supervisor contract (exit 46, never recreate).
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') {
      throw new CorruptDatabaseError(`open failed: ${code}`);
    }
    throw err;
  }
  let integrity: string;
  try {
    // better-sqlite3 may defer the actual open to the first statement, so a
    // garbage header can surface HERE instead of in the constructor.
    // PINNED by architecture §startup + spec §3.25 (exit 46 contract).
    // Measured cost is O(db size) — a full-file page scan on EVERY boot:
    // ~0.2s @ 33MB soak DB, ~5-8s @ 907MB (round 19). Diagnostics uses
    // quick_check for interactivity; boot keeps the full check BY DESIGN.
    integrity = db.pragma('integrity_check', { simple: true }) as string;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') {
      throw new CorruptDatabaseError(`open failed: ${code}`);
    }
    throw err;
  }
  if (integrity !== 'ok') {
    db.close();
    throw new CorruptDatabaseError(integrity);
  }
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${CONSTANTS.busyTimeoutMs}`);
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // SEC-003: SQLite creates the db file (and later the WAL sidecars)
  // world-readable by default; tighten everything to owner-only.
  // Nothing to tighten for the ':memory:' pseudo-path.
  if (dbPath !== ':memory:') {
    chmodSync(dbPath, 0o600);
    enforceSidecarPerms(dbPath);
  }
  return db;
}

/**
 * SEC-003: chmod the -wal/-shm sidecars to owner-only when they exist. The
 * WAL may be created lazily after open, so callers re-run this post-migration
 * and from the checkpoint watch.
 */
export function enforceSidecarPerms(dbPath: string): void {
  for (const sidecar of [dbPath + '-wal', dbPath + '-shm']) {
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }
}

/**
 * Anti checkpoint-starvation watch (contracts §Concurrency): if the WAL file
 * grows beyond `thresholdBytes`, force a passive checkpoint. Returns a stop
 * function; interval is unref'd so it never keeps the process alive alone.
 */
export function startCheckpointWatch(
  db: Db,
  dbPath: string,
  thresholdBytes: number,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    let walSize = 0;
    try {
      const wal = statSync(dbPath + '-wal');
      walSize = wal.size;
      // SEC-003: cover lazy sidecar recreation (e.g. corruption recovery);
      // cheap no-op unless the mode drifted from owner-only.
      if ((wal.mode & 0o777) !== 0o600) chmodSync(dbPath + '-wal', 0o600);
      enforceSidecarPerms(dbPath);
    } catch {
      return;
    }
    if (walSize > thresholdBytes) {
      db.pragma('wal_checkpoint(PASSIVE)');
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Total size of the database in bytes (page_count × page_size). */
export function pageCountBytes(db: Db): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pages * pageSize;
}
