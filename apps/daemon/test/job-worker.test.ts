import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';
import { ulid } from 'ulid';

import { openDatabase, type Db } from '../src/db/database.js';
import { DEFAULT_LEASE_MS, JobWorker } from '../src/jobs/job-worker.js';
import { JobsRepository, RETRY_SCHEDULE_MS } from '../src/db/jobs-repository.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { Segmenter } from '../src/processing/segmenter.js';
import { migrate } from '../src/db/migrator.js';

/** Minimal stand-in for `Promise.withResolvers` (lib target predates ES2024). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Minimal canonical event for segmenter-driven enqueue tests (SVC-03). */
function makeActivityEvent(observedAt: number): ActivityEvent {
  return {
    id: ulid(Math.max(observedAt, 1)),
    observedAt,
    monotonicNs: observedAt * 1_000,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    window: { title: 'Doc' },
    action: 'text_change',
    target: { role: 'AXTextArea', identifier: 'body' },
    content: `text-${observedAt}`,
    contentPolicy: 'allow',
  };
}

const START = 1_000_000;

describe('JobWorker (spec §3.24 retry semantics, brief-m3 §D3 item 2 + matrix)', () => {
  let db: Db;
  let jobs: JobsRepository;
  let home: string;
  let now: number;
  const tickClock = (delta = 0) => {
    now += delta;
    return now;
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-worker-'));
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

  function rowOf(id: string) {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as {
      id: string;
      type: string;
      state: string;
      attempts: number;
      run_after_ms: number;
      leased_until_ms: number | null;
      last_error: string | null;
      payload_json: string;
    };
  }

  function buildWorker(handlers: Record<string, (job: never) => Promise<void>>, serialized: string[] = [], onQueueUpdate?: (n: number) => void): JobWorker {
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

  it('walks pending→running→retry with run_after +1m and attempts=1; steps/history untouched', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-1' }, now, now);
    const handled: string[] = [];
    const worker = buildWorker({
      summarize_segment: async () => {
        handled.push(rowOf(job.id).state); // observed inside the handler = running
        throw new Error('LLM outage');
      },
    }, ['summarize_segment']);

    worker.tick();
    await worker.idle();
    expect(handled).toEqual(['running']);
    const afterFirst = rowOf(job.id);
    expect(afterFirst.state).toBe('retry');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.run_after_ms).toBe(START + RETRY_SCHEDULE_MS[0]); // exactly +1 minute
    expect(afterFirst.last_error).toBe('LLM outage');

    // Not runnable before its run_after; claimable again after the delay.
    worker.tick();
    await worker.idle();
    expect(rowOf(job.id).attempts).toBe(1);
    tickClock(RETRY_SCHEDULE_MS[0] + 1);
    const worker2 = buildWorker({
      summarize_segment: async () => undefined,
    }, ['summarize_segment']);
    worker2.tick();
    await worker2.idle();
    expect(rowOf(job.id).state).toBe('succeeded');
    expect(rowOf(job.id).attempts).toBe(2);
  });

  it('sends a job dead after five failures with the full backoff table', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-9' }, now, now);
    const failing = buildWorker(
      {
        summarize_segment: async () => {
          throw new Error('always fails');
        },
      },
      ['summarize_segment'],
    );

    // Table-driven proof of every pinned retry slot: attempts 1..4 back off
    // (+1m/+5m/+30m/+2h) and the FIFTH failure is terminal (spec §3.24).
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      const failedAt = now;
      failing.tick();
      await failing.idle();
      const row = rowOf(job.id);
      if (attempt < RETRY_SCHEDULE_MS.length) {
        expect(row.state).toBe('retry');
        expect(row.run_after_ms).toBe(failedAt + RETRY_SCHEDULE_MS[attempt - 1]!);
        tickClock(RETRY_SCHEDULE_MS[attempt - 1]! + 1);
      } else {
        expect(row.state).toBe('dead');
        expect(row.last_error).toBe('always fails');
      }
    }
    const reviving = buildWorker({ summarize_segment: async () => undefined }, ['summarize_segment']);
    tickClock(100_000_000);
    reviving.tick();
    await reviving.idle();
    expect(rowOf(job.id).state).toBe('dead');
  });

  it('leaves unregistered job types pending untouched (forward-enqueue rule)', async () => {
    jobs.enqueue('extract_memory', { episodeId: 'ep-1' }, now, now);
    const worker = buildWorker({ summarize_segment: async () => undefined }, ['summarize_segment']);
    worker.tick();
    await worker.idle();
    const row = db.prepare('SELECT state, attempts FROM jobs').get() as { state: string; attempts: number };
    expect(row.state).toBe('pending'); // M5 will own these
    expect(row.attempts).toBe(0);
  });

  it('emits queue_update counts across state transitions', async () => {
    const updates: number[] = [];
    const job = jobs.enqueue('summarize_segment', {}, now, now);
    const worker = buildWorker({
      summarize_segment: async () => {
        throw new Error('boom');
      },
    }, ['summarize_segment'], (n) => updates.push(n));

    void job;
    worker.tick(); // claim → running (pending drops)
    await worker.idle(); // fail → retry (waiting again)
    tickClock(RETRY_SCHEDULE_MS[0] + 1); // wait out the +1m backoff
    worker.tick();
    await worker.idle();
    // Claimed once (0 waiting while running), failed (1 waiting), claimed again.
    expect(updates).toContain(1);
    expect(updates).toContain(0);
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('recovers expired leases with a fake clock and lets the successor claim', async () => {

    const job = jobs.enqueue('summarize_segment', {}, now, now);
    const stalledGate = deferred();

    const stalled = new JobWorker({
      jobs,
      logger: { log: vi.fn(), pruneOld: () => 0 },
      now: () => now,
    });
    stalled.registerSerialized('summarize_segment', async () => {
      await stalledGate.promise; // crashed-worker stand-in: parked past its lease
    });
    stalled.tick();
    const running = rowOf(job.id);
    expect(running.state).toBe('running');
    expect(running.leased_until_ms).toBe(START + DEFAULT_LEASE_MS);

    // Clock jumps past the lease — the crashed worker never returns.
    tickClock(DEFAULT_LEASE_MS + 1);
    const recovering = buildWorker({ summarize_segment: async () => undefined }, ['summarize_segment']);
    recovering.start(); // startup recovery requeues the expired lease
    const requeued = rowOf(job.id);
    expect(requeued.state).toBe('retry');
    expect(requeued.attempts).toBe(1); // the burned attempt stays counted
    // Recovery schedules the pinned retry slot for the burned attempt —
    // NOT an immediate re-arm (run_after = recovery time + RETRY_SCHEDULE_MS[0]).
    expect(requeued.run_after_ms).toBe(START + DEFAULT_LEASE_MS + 1 + RETRY_SCHEDULE_MS[0]);
    // The stale worker finally finishes — guarded complete() must NOT clobber.
    stalledGate.resolve();
    await stalled.idle();
    expect(rowOf(job.id).state).toBe('retry');

    // Successor claims after run_after passes and completes cleanly.
    tickClock(RETRY_SCHEDULE_MS[0] + 1);
    recovering.tick();
    await recovering.idle();
    expect(rowOf(job.id).state).toBe('succeeded');
    expect(rowOf(job.id).attempts).toBe(2);
    void recovering.stop();
  });

  // CONSTANTS.jobLeaseMs wiring: an explicit leaseMs must drive the claimNext
  // window (leased_until_ms), not just sit unused next to the default.
  it('derives the claim lease window from the configured leaseMs', () => {
    const leaseMs = 5_000;
    const job = jobs.enqueue('summarize_segment', {}, now, now);
    const wired = new JobWorker({
      jobs,
      logger: { log: vi.fn(), pruneOld: () => 0 },
      now: () => now,
      leaseMs,
    });
    wired.register('summarize_segment', async () => undefined);
    wired.tick();
    expect(rowOf(job.id).state).toBe('running');
    expect(rowOf(job.id).leased_until_ms).toBe(START + leaseMs);
  });

  // A worker whose lease expired and whose job was requeued must not crash
  // when its handler finally fails: fail() answers 'stale', run() logs and
  // discards — no rejection, no unhandled promise.
  it('swallows the stale fail path for a plain handler without rejecting', async () => {
    const gate = deferred();
    const stale = buildWorker({
      retention_sweep: async () => {
        await gate.promise;
        throw new Error('late failure after lease loss');
      },
    });
    const id = jobs.enqueue('retention_sweep', {}, now, now).id;
    stale.tick();
    expect(rowOf(id).state).toBe('running');

    tickClock(DEFAULT_LEASE_MS + 1); // lease lapses; recovery hands the job to a successor
    const successor = buildWorker({ retention_sweep: async () => undefined });
    successor.start();
    expect(rowOf(id).state).toBe('retry');

    gate.resolve(); // the losing worker's handler throws — must not reject
    await stale.idle();
    expect(rowOf(id).state).toBe('retry'); // successor's state untouched
    void successor.stop();
  });

  it('swallows the stale fail path for a serialized handler without rejecting', async () => {
    const gate = deferred();
    const stale = buildWorker({
      summarize_segment: async () => {
        await gate.promise;
        throw new Error('late failure after lease loss');
      },
    }, ['summarize_segment']);
    const id = jobs.enqueue('summarize_segment', {}, now, now).id;
    stale.tick();
    expect(rowOf(id).state).toBe('running');

    tickClock(DEFAULT_LEASE_MS + 1);
    const successor = buildWorker({ summarize_segment: async () => undefined }, ['summarize_segment']);
    successor.start();
    expect(rowOf(id).state).toBe('retry');

    gate.resolve();
    await stale.idle();
    expect(rowOf(id).state).toBe('retry');
    void successor.stop();
  });

  it('never overlaps two serialized LLM jobs but runs non-LLM handlers in parallel with them', async () => {
    const events: string[] = [];
    const llmGate = deferred();
    const segmentIdOf = (payloadJson: string): string => {
      const payload: unknown = JSON.parse(payloadJson);
      if (typeof payload === 'object' && payload !== null && 'segmentId' in payload && typeof payload.segmentId === 'string') {
        return payload.segmentId;
      }
      throw new Error(`summarize_segment payload missing string segmentId: ${payloadJson}`);
    };
    const worker = new JobWorker({
      jobs,
      logger: { log: vi.fn(), pruneOld: () => 0 },
      now: () => now,
    });
    worker.registerSerialized('summarize_segment', async (job) => {
      events.push(`llm-start:${segmentIdOf(job.payload_json)}`);
      await llmGate.promise;
      events.push(`llm-end:${segmentIdOf(job.payload_json)}`);
    });
    worker.register('retention_sweep', async () => {
      events.push('non-llm-start');
      // Deterministic yield: let the event loop turn while LLM #1 holds its gate.
      await Promise.resolve();
      await Promise.resolve();
      events.push('non-llm-end');
    });

    jobs.enqueue('summarize_segment', { segmentId: 'A' }, now, now);
    jobs.enqueue('summarize_segment', { segmentId: 'B' }, now, now);
    jobs.enqueue('retention_sweep', {}, now, now);

    worker.tick(); // claims LLM A (serialized chain now busy)
    worker.tick(); // claims retention_sweep; B is deliberately LEFT pending —
    // §3.15: a serialized job is claimed exactly when it can start, never
    // parked behind the chain where its lease would burn.
    worker.tick(); // no-op: only B remains and the chain is still busy
    // Non-LLM job dispatched even though LLM #1 still holds its gate: drain
    // the macrotask queue until its handler ran to completion.
    for (let spins = 0; spins < 20 && !events.includes('non-llm-end'); spins++) {
      await new Promise((r) => setImmediate(r));
    }
    llmGate.resolve();
    await worker.idle();
    // Chain settled → the successor tick finally claims and starts B.
    worker.tick();
    await worker.idle();

    const starts = events.filter((e) => e.startsWith('llm-start'));
    const ends = events.filter((e) => e.startsWith('llm-end'));
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    // Strict serialization: each LLM start comes only after the previous end.
    expect(events.indexOf(starts[1]!)).toBeGreaterThan(events.indexOf(ends[0]!));
    // Parallelism: the non-LLM job completed before the first LLM one ended.
    expect(events.indexOf('non-llm-end')).toBeLessThan(events.indexOf(ends[0]!));
  });

  // SVC-01: stop() must not return while a serialized LLM handler is still
  // running — the pre-fix fire-and-forget allSettled let main.ts proceed to
  // wal_checkpoint/db.close under a live handler.
  it('stop() resolves only after the in-flight serialized handler settles', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-drain' }, now, now);
    const gate = deferred();
    let started = false;
    const worker = buildWorker({
      summarize_segment: async () => {
        started = true;
        await gate.promise;
      },
    }, ['summarize_segment']);

    worker.tick();
    await vi.waitFor(() => expect(started).toBe(true));

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    // Give the (bounded) drain every chance to settle prematurely: with the
    // handler still gated, it must stay pending.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(rowOf(job.id).state).toBe('succeeded'); // drained BEFORE close, completed cleanly
  });

  // SVC-01: the drain is bounded — a wedged transport must not stall SIGTERM.
  it('stop() gives up after the grace timeout when a handler never settles', async () => {
    const job = jobs.enqueue('extract_memory', { episodeId: 'e-wedge' }, now, now);
    const gate = deferred();
    const worker = buildWorker({
      extract_memory: async () => {
        await gate.promise;
      },
    });

    worker.tick();
    const drained = await worker.stop(50);
    expect(drained).toBe(false); // timed out, did not hang
    expect(rowOf(job.id).state).toBe('running'); // abandoned mid-flight, lease intact

    gate.resolve();
    await worker.idle(); // late settle must not reject or hang the test
    expect(rowOf(job.id).state).toBe('succeeded');
  });

  // SVC-03: enqueue-side transitions reach recorders immediately, even while
  // tick() refuses to claim serialized types (chain busy) — main.ts wires the
  // segmenter's onJobEnqueued to the same queue_update sink as the worker.
  it('announces queue_update at enqueue time while the serialized chain is busy', async () => {
    const updates: number[] = [];
    const recordPendingJobs = (): void => {
      const counts = jobs.countsByState();
      updates.push(counts.pending + counts.retry);
    };
    const gate = deferred();
    let started = false;
    const worker = buildWorker({
      summarize_segment: async () => {
        started = true;
        await gate.promise;
      },
    }, ['summarize_segment'], (pendingJobs) => updates.push(pendingJobs));

    jobs.enqueue('summarize_segment', { segmentId: 'seg-warm' }, now, now);
    worker.tick(); // claims warm-up job → serialized chain busy
    await vi.waitFor(() => expect(started).toBe(true));
    updates.length = 0; // drop claim-time emissions; observe enqueue-time only

    const events = new EventsRepository(db);
    const segments = new SegmentsRepository(db);
    const segmenter = new Segmenter({
      db,
      events,
      segments,
      jobs,
      logger: { log: vi.fn(), pruneOld: () => 0 },
      idleCloseMs: 1000,
      // Enqueue run_after must use the WORKER's fake clock, or the job is
      // never runnable (run_after_ms in real epoch vs START in fake time).
      now: () => now,
      onJobEnqueued: recordPendingJobs,
    });
    const first = makeActivityEvent(Date.now());
    events.insertBatch([first]);
    segmenter.onEventsEligible([first]);
    const later = makeActivityEvent(Date.now() + 2000);
    events.insertBatch([later]);
    segmenter.onEventsEligible([later]); // idle threshold hit → closeSegment → enqueue

    // The recorder learned about the new pending job NOW, without any tick.
    expect(updates).toEqual([1]); // summarize job pending; warm-up job running (not counted)
    const enqueued = db.prepare('SELECT id FROM jobs WHERE type = ? AND state = ?').get('summarize_segment', 'pending') as { id: string };
    // And even an explicit tick cannot claim it while the chain is busy.
    worker.tick();
    expect(rowOf(enqueued.id).state).toBe('pending');

    gate.resolve();
    await worker.idle();
    worker.tick();
    await worker.idle();
    expect(rowOf(enqueued.id).state).toBe('succeeded');
  });

  it('survives a repository throw inside the tick and keeps claiming on later ticks', async () => {
    // Round-31 MEDIUM pin: tick() runs SQLite work synchronously on the
    // interval callback; before the poll-loop guard, a transient SQLITE_BUSY
    // escaped as an unhandled rejection (node default = crash). A flaky
    // claimNext must cost one logged error — not the worker.
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-flaky' }, now, now);
    const logSpy = vi.fn();
    let failClaim = true;
    // Shadow claimNext on a prototype-linked stub: throws once, then
    // delegates to the real repository so the next tick can claim.
    const flakyJobs = Object.create(jobs) as JobsRepository;
    Object.defineProperty(flakyJobs, 'claimNext', {
      value: (leaseMs: number, at: number, types: string[]) => {
        if (failClaim) throw new Error('SQLITE_BUSY: database is locked');
        return jobs.claimNext(leaseMs, at, types);
      },
      configurable: true,
    });
    const handled: string[] = [];
    const worker = new JobWorker({
      jobs: flakyJobs,
      logger: { log: logSpy, pruneOld: () => 0 },
      now: () => now,
    });
    worker.registerSerialized('summarize_segment', async () => {
      handled.push(rowOf(job.id).state);
    });

    // Tick 1: claimNext throws → absorbed, error logged, nothing claimed.
    expect(() => worker.tick()).not.toThrow();
    await worker.idle();
    expect(rowOf(job.id).state).toBe('pending');
    expect(logSpy).toHaveBeenCalledWith(
      'error',
      'job-worker',
      'job poll tick failed; keeping poll loop alive',
      { errorMessage: 'SQLITE_BUSY: database is locked' },
    );

    // Tick 2 (the pinned recovery): next tick still claims and dispatches.
    failClaim = false;
    worker.tick();
    await worker.idle();
    expect(handled).toEqual(['running']);
    expect(rowOf(job.id).state).toBe('succeeded');
  });

  // Round-32 pin: countsByState() throwing AFTER claimNext succeeded must not
  // strand the claimed row — a stats failure is log-only and the handler still
  // runs; without the isolation the tick catch would swallow dispatch until
  // the 600s lease expired.
  it('dispatches a claimed job even when post-claim queue-update counting throws', async () => {
    const job = jobs.enqueue('summarize_segment', {}, now, now);
    const logSpy = vi.fn();
    const failCounts = { value: true };
    const flakyJobs = Object.create(jobs) as JobsRepository;
    Object.defineProperty(flakyJobs, 'countsByState', {
      value: () => {
        if (failCounts.value) throw new Error('SQLITE_BUSY: database is locked');
        return jobs.countsByState(now);
      },
      configurable: true,
    });
    const handled: string[] = [];
    const worker = new JobWorker({
      jobs: flakyJobs,
      logger: { log: logSpy, pruneOld: () => 0 },
      now: () => now,
      onQueueUpdate: () => undefined,
    });
    worker.registerSerialized('summarize_segment', async () => {
      handled.push(rowOf(job.id).state);
    });

    expect(() => worker.tick()).not.toThrow();
    await worker.idle();
    // The job was dispatched despite the stats failure — not stranded leased.
    expect(handled).toEqual(['running']);
    expect(rowOf(job.id).state).toBe('succeeded');
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'job-worker',
      'queue update after claim failed; dispatching anyway',
      { jobId: job.id, errorMessage: 'SQLITE_BUSY: database is locked' },
    );

    // Once counting recovers, updates flow again.
    failCounts.value = false;
    const id2 = jobs.enqueue('retention_sweep', {}, now, now).id;
    worker.register('retention_sweep', async () => undefined);
    worker.tick();
    await worker.idle();
    expect(rowOf(id2).state).toBe('succeeded');
  });
});

