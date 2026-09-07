import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { JobWorker } from '../src/jobs/job-worker.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { migrate } from '../src/db/migrator.js';
import type { Logger } from '../src/logging.js';

/** Minimal stand-in for `Promise.withResolvers` (lib target predates ES2024). */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const START = 1_000_000;

/**
 * SVC-01 regression harness: main.ts must await jobWorker.stop()'s bounded
 * drain BEFORE wal_checkpoint(TRUNCATE) + db.close(), and a handler that
 * settles AFTER the database closed (stop() grace expired) must be absorbed
 * by run()'s finalization guard — never surfaced as an unhandled rejection,
 * which would kill the process mid-shutdown.
 */
describe('graceful shutdown drain ordering (SVC-01)', () => {
  let db: Db;
  let jobs: JobsRepository;
  let home: string;
  let logLines: Array<Record<string, unknown>>;
  let now: number;

  const logger: Logger = {
    log: (level, scope, message, fields) => {
      logLines.push({ level, scope, message, ...fields });
    },
    pruneOld: () => 0,
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-shutdown-'));
    db = openDatabase(path.join(home, 'history.db'));
    migrate(db);
    jobs = new JobsRepository(db);
    logLines = [];
    now = START;
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function rowOf(id: string): { id: string; state: string } {
    return db.prepare('SELECT id, state FROM jobs WHERE id = ?').get(id) as { id: string; state: string };
  }

  it('drains the in-flight handler before the caller closes the database', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-1' }, now, now);
    const gate = deferred();
    let started = false;
    const worker = new JobWorker({
      jobs,
      logger,
      now: () => now,
    });
    worker.registerSerialized('summarize_segment', async () => {
      started = true;
      await gate.promise;
    });

    worker.tick();
    // Stop is awaited while the handler is still running; the drain must
    // hold until the handler settles, then let main proceed.
    const stopping = worker.stop();
    gate.resolve();
    expect(await stopping).toBe(true);
    expect(rowOf(job.id).state).toBe('succeeded');
    expect(started).toBe(true);
    // The exact sequence main.ts runs once the drain resolved.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  });

  it('absorbs a late FAILURE after db.close() without an unhandled rejection', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-2' }, now, now);
    const gate = deferred();
    let started = false;
    const worker = new JobWorker({
      jobs,
      logger,
      now: () => now,
    });
    worker.registerSerialized('summarize_segment', async () => {
      started = true;
      await gate.promise;
    });

    worker.tick();
    await vi.waitFor(() => expect(started).toBe(true));

    // Grace expires under the live handler → main proceeds to db.close().
    expect(await worker.stop(5)).toBe(false);
    db.close();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      gate.reject(new Error('late LLM crash')); // handler wakes POST-close
      await worker.idle();
      for (let spins = 0; spins < 20; spins++) await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      // The guard logged instead of rethrowing: fail() threw "not open".
      const finalize = logLines.find((l) => l.message === 'job finalization failed after handler settled') as
        | { jobId: string; errorMessage: string }
        | undefined;
      expect(finalize?.jobId).toBe(job.id);
      expect(finalize?.errorMessage).toMatch(/not open/i);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('absorbs a late COMPLETION after db.close() without an unhandled rejection', async () => {
    const job = jobs.enqueue('extract_memory', { episodeId: 'e-3' }, now, now);
    const gate = deferred();
    let started = false;
    const worker = new JobWorker({
      jobs,
      logger,
      now: () => now,
    });
    worker.register('extract_memory', async () => {
      started = true;
      await gate.promise;
    });

    worker.tick();
    await vi.waitFor(() => expect(started).toBe(true));

    expect(await worker.stop(5)).toBe(false);
    db.close();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      gate.resolve(); // complete() now throws against the closed database
      await worker.idle();
      for (let spins = 0; spins < 20; spins++) await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      const finalize = logLines.find((l) => l.message === 'job finalization failed after handler settled') as
        | { jobId: string }
        | undefined;
      expect(finalize?.jobId).toBe(job.id);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
