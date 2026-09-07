import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { JobsRepository, RETRY_SCHEDULE_MS, type JobRow } from '../src/db/jobs-repository.js';
import { JobWorker } from '../src/jobs/job-worker.js';
import { registerJobOps } from '../src/ipc/job-ops.js';
import { Router } from '../src/ipc/router.js';
import type { Logger } from '../src/logging.js';
import { ulid } from 'ulid';

/**
 * Model-outage resilience suite (spec §3.24, brief-m7 §D7 item 5). With a
 * transport that ALWAYS throws:
 *   - the summarize job backs off +1m/+5m/+30m/+2h and is dead after
 *     EXACTLY 5 attempts;
 *   - queue_update counts pending+retry and excludes dead;
 *   - dead jobs are NEVER auto-revived when the transport heals;
 *   - `jobs.retryDead {}` is the only revival path (run_after = now), after
 *     which a healed transport completes the re-driven job.
 * Raw/semantic history stays searchable throughout (spec release criterion).
 */

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const MIN = 60_000;

describe('model outage resilience (always-throwing transport)', () => {
  let db: Db;
  let home: string;
  let jobs: JobsRepository;
  let worker: JobWorker;
  let clockMs: number;
  let queueUpdates: number[];
  let transportThrows: boolean;
  let handlerCalls: number;
  let processedPayloads: string[];

  const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-outage-'));
    db = openDatabase(path.join(home, 'history.db'));
    migrate(db);
    jobs = new JobsRepository(db);
    clockMs = T0;
    queueUpdates = [];
    transportThrows = true;
    handlerCalls = 0;
    processedPayloads = [];
    worker = new JobWorker({
      jobs,
      logger,
      pollIntervalMs: 1000,
      now: () => clockMs,
      onQueueUpdate: (n) => queueUpdates.push(n),
    });
    worker.registerSerialized('summarize_segment', async (job: JobRow) => {
      handlerCalls += 1;
      if (transportThrows) throw new Error('model unavailable');
      processedPayloads.push((JSON.parse(job.payload_json) as { segmentId: string }).segmentId);
    });
  });

  afterEach(async () => {
    await worker.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('cycles a failing job through the pinned schedule to dead after exactly 5 attempts', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-1' }, clockMs, clockMs);

    // Attempts 1..4 arm the NEXT pinned backoff slot; the FIFTH failure is
    // terminal (spec §3.24: «После пятой ошибки: dead»). The clock jumps to
    // the job's own run_after before every tick.
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      const due = (
        db.prepare('SELECT run_after_ms FROM jobs WHERE id = ?').get(job.id) as {
          run_after_ms: number;
        }
      ).run_after_ms;
      clockMs = Math.max(clockMs, due);
      worker.tick();
      await worker.idle();
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as {
        state: string;
        attempts: number;
        run_after_ms: number;
      };
      expect(row.attempts).toBe(attempt);
      if (attempt < RETRY_SCHEDULE_MS.length) {
        expect(row.state).toBe('retry');
        expect(row.run_after_ms - clockMs).toBe(RETRY_SCHEDULE_MS[attempt - 1]);
      } else {
        expect(row.state).toBe('dead');
      }
    }
    expect(handlerCalls).toBe(RETRY_SCHEDULE_MS.length);

    // A dead job is never claimed again — further ticks are no-ops.
    clockMs += 10 * MIN;
    worker.tick();
    await worker.idle();
    expect(handlerCalls).toBe(RETRY_SCHEDULE_MS.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='dead'").get() as { n: number }).n).toBe(1);
  });

  it('emits queue_update counts as pending+retry, excluding running and dead', async () => {
    const dying = jobs.enqueue('summarize_segment', { segmentId: 'seg-q' }, clockMs, clockMs);
    // A second job whose type has NO handler stays pending untouched.
    jobs.enqueue('future_job', {}, clockMs, clockMs);

    worker.tick();
    await worker.idle();
    // After the claim: running(1) + pending(1) → pendingJobs counts 1.
    // After the failure: retry(1) + pending(1) → 2.
    expect(queueUpdates).toContain(2);
    const counts = jobs.countsByState(clockMs);
    expect(counts.dead).toBe(0);
    expect(counts.pending).toBe(1); // the unknown-type job
    expect(counts.retry).toBe(1);

    void dying;
    // Drive to dead: dead rows drop OUT of pendingJobs.
    transportThrows = true;
    for (let attempt = 2; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      clockMs += RETRY_SCHEDULE_MS[attempt - 2]!;
      worker.tick();
      await worker.idle();
    }
    const finalCounts = jobs.countsByState(clockMs);
    expect(finalCounts.dead).toBe(1);
    expect(finalCounts.pending + finalCounts.retry).toBe(1); // only the future job
    expect(queueUpdates[queueUpdates.length - 1]).toBe(1);
  });

  it('healed transport does NOT auto-revive dead jobs; jobs.retryDead is the only path', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-dead' }, clockMs, clockMs);
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      worker.tick();
      await worker.idle();
      clockMs += RETRY_SCHEDULE_MS[Math.min(attempt - 1, 4)]!;
    }
    expect((db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state).toBe('dead');

    // Transport heals: dead stays dead (V1 pin).
    transportThrows = false;
    clockMs += 24 * 60 * MIN;
    worker.tick();
    await worker.idle();
    expect(handlerCalls).toBe(RETRY_SCHEDULE_MS.length);
    expect((db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state).toBe('dead');

    // jobs.retryDead {}: dead → pending, run_after = now, FRESH attempt budget.
    const router = new Router(logger);
    registerJobOps(router, {
      jobs,
      now: () => clockMs,
      onQueueUpdate: (n) => queueUpdates.push(n),
    });
    const outcome = await router.dispatch('jobs.retryDead', {});
    expect(outcome.ok).toBe(true);
    expect((outcome as { result: { retried: number } }).result.retried).toBe(1);

    const revived = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as {
      state: string;
      attempts: number;
      run_after_ms: number;
    };
    expect(revived.state).toBe('pending');
    expect(revived.attempts).toBe(0);
    expect(revived.run_after_ms).toBe(clockMs);

    // The healed transport now completes the re-driven job on the next tick.
    worker.tick();
    await worker.idle();
    expect(processedPayloads).toEqual(['seg-dead']);
    expect((db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state).toBe(
      'succeeded',
    );
  });

  it('keeps ingest → segmentation flowing while summarize jobs die (release criterion)', async () => {
    const events = new EventsRepository(db);
    const segments = new SegmentsRepository(db);
    const observedAt = T0 - 10_000; // watermark-eligible (now − 2s lag)
    events.insertBatch(
      [
        {
          id: ulid(observedAt),
          observedAt,
          source: 'accessibility',
          app: { bundleId: 'com.test.App', name: 'TestApp', pid: 1 },
          action: 'click',
          target: { role: 'AXButton', label: 'Send' },
          contentPolicy: 'allow',
        },
      ],
      observedAt,
    );
    // Coalescer/segmenter path is LLM-free: a step is appended while the
    // summarize job for a previous segment is dying on the schedule.
    const segment = segments.createOpen(observedAt, 'first-event', observedAt);
    const stepId = segments.appendStep(
      segment.id,
      {
        action: 'click',
        appBundleId: 'com.test.App',
        appName: 'TestApp',
        targetRole: 'AXButton',
        target: 'Send',
        text: null,
        startedAtMs: observedAt,
        endedAtMs: observedAt,
        firstEventId: 'first-event',
        lastEventId: 'first-event',
        eventCount: 1,
      },
      { text: null, target: 'Send', appName: 'TestApp' },
      observedAt,
    );
    expect(segments.getSteps(segment.id).map((s) => s.id)).toEqual([stepId]);

    // Meanwhile the failing job still walks its schedule.
    jobs.enqueue('summarize_segment', { segmentId: 'seg-other' }, clockMs, clockMs);
    worker.tick();
    await worker.idle();
    expect(handlerCalls).toBe(1);
    const counts = jobs.countsByState(clockMs);
    expect(counts.retry).toBe(1);
  });
});
