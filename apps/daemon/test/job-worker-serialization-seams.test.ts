import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/database.js';
import { openDatabase } from '../src/db/database.js';
import { JobWorker } from '../src/jobs/job-worker.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { migrate } from '../src/db/migrator.js';

/**
 * The serialization seams the main suite proves only indirectly: the
 * claim-filter that keeps serialized jobs UNLEASED while the LLM chain is
 * busy ("claimed exactly when it can start"), the startup lease-recovery
 * broadcast, and idle() spanning the whole serialized chain.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const START = 1_000_000;

describe('JobWorker serialization seams', () => {
  let db: Db;
  let jobs: JobsRepository;
  let home: string;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-worker-seams-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    jobs = new JobsRepository(db);
    now = START;
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function rowOf(id: string): { id: string; state: string; leased_until_ms: number | null } {
    return db.prepare('SELECT id, state, leased_until_ms FROM jobs WHERE id = ?').get(id) as {
      id: string;
      state: string;
      leased_until_ms: number | null;
    };
  }

  function buildWorker(
    handlers: Record<string, (job: never) => Promise<void>>,
    serialized: string[] = [],
    onQueueUpdate?: (n: number) => void,
  ): JobWorker {
    const worker = new JobWorker({
      jobs,
      logger: { log: vi.fn(), pruneOld: () => 0 },
      now: () => now,
      onQueueUpdate,
    });
    for (const [type, handler] of Object.entries(handlers)) {
      if (serialized.includes(type)) worker.registerSerialized(type, handler as never);
      else worker.register(type, handler as never);
    }
    return worker;
  }

  it('does NOT lease a serialized job while the chain is busy; claims it when free', async () => {
    const gateA = deferred();
    const jobA = jobs.enqueue('llm_a', {}, now, now);
    const worker = buildWorker(
      {
        llm_a: () => gateA.promise,
        llm_b: async () => {},
        plain_c: async () => {},
      },
      ['llm_a', 'llm_b'],
    );

    // Tick 1: A is claimed and starts (it can run immediately).
    worker.tick();
    await vi.waitFor(() => expect(rowOf(jobA.id).state).toBe('running'));

    // Queue work behind the busy chain: serialized B + non-serialized C.
    const jobB = jobs.enqueue('llm_b', {}, now, now);
    const jobC = jobs.enqueue('plain_c', {}, now, now);

    // Tick 2 while A is parked: C may be claimed, B must stay UNLEASED
    // (a leased-but-parked job would burn its lease in the queue).
    worker.tick();
    await vi.waitFor(() => expect(rowOf(jobC.id).state).toBe('running'));
    const rowB = rowOf(jobB.id);
    expect(rowB.state).toBe('pending');
    expect(rowB.leased_until_ms).toBeNull();

    // Release A; the next tick can finally claim B.
    gateA.resolve();
    await worker.idle();
    worker.tick();
    await worker.idle();
    expect(rowOf(jobB.id).state).toBe('succeeded');
    expect(rowOf(jobC.id).state).toBe('succeeded');
  });

  it('startup recovery emits one queue_update carrying the recovered count', async () => {
    const staleLeaseUntil = START - 60_000;
    const job = jobs.enqueue('summarize_segment', {}, START - 120_000, START - 120_000);
    db.prepare("UPDATE jobs SET state = 'running', leased_until_ms = ? WHERE id = ?").run(
      staleLeaseUntil,
      job.id,
    );

    const updates: number[] = [];
    const logSpy = vi.fn();
    const worker = new JobWorker({
      jobs,
      logger: { log: logSpy, pruneOld: () => 0 },
      now: () => now,
      onQueueUpdate: (n) => updates.push(n),
    });

    worker.start();
    try {
      // pending + retry AFTER recovery = exactly this one requeued job.
      expect(updates).toEqual([1]);
      const row = rowOf(job.id);
      expect(row.state).toBe('retry'); // recovery parks on the retry schedule…
      expect(row.leased_until_ms).toBeNull(); // …with the lease fully released
    } finally {
      await worker.stop();
    }
  });

  it('idle() spans the serialized chain end-to-end', async () => {
    const gate = deferred();
    const job = jobs.enqueue('llm_slow', {}, now, now);
    const worker = buildWorker({ llm_slow: () => gate.promise }, ['llm_slow']);

    worker.tick();
    await vi.waitFor(() => expect(rowOf(job.id).state).toBe('running'));

    let idleSettled = false;
    const idlePromise = worker.idle().then(() => {
      idleSettled = true;
    });
    // Drain the microtask queue deterministically: nothing here uses timers,
    // so a spurious settle would have to happen within these turns.
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
    expect(idleSettled).toBe(false); // parked handler holds idle() open

    gate.resolve();
    await idlePromise;
    expect(rowOf(job.id).state).toBe('succeeded');
  });
});
