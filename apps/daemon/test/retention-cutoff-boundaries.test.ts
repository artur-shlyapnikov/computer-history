import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import type { ActivityEvent } from '@computer-history/protocol';

import { CONSTANTS } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import {
  JobsRepository,
  JOBS_RETENTION_DAYS,
  RETRY_SCHEDULE_MS,
} from '../src/db/jobs-repository.js';
import { createLogger } from '../src/logging.js';
import { migrate } from '../src/db/migrator.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import { RetentionService, type RetentionStats } from '../src/services/retention-service.js';

/**
 * Boundary-value pins over data DESTRUCTION (spec §3.22): a row exactly AT a
 * cutoff must survive (every purge comparison is strict <); plus the only
 * uncovered branch of the service — the interval callback's catch.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function wireEvent(observedAt: number): ActivityEvent {
  return {
    id: ulid(Math.max(observedAt, 1)),
    observedAt,
    monotonicNs: observedAt * 1000,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 7 },
    action: 'scroll',
    contentPolicy: 'metadata_only',
  };
}

function step(at: number): CoalescedStep {
  return {
    action: 'edit_text',
    appBundleId: 'com.apple.Safari',
    appName: 'Safari',
    target: 'body',
    targetRole: null,
    text: `text-at-${at}`,
    startedAtMs: at,
    endedAtMs: at,
    firstEventId: ulid(Math.max(at, 1)),
    lastEventId: ulid(Math.max(at, 1) + 1),
    eventCount: 1,
  };
}

describe('RetentionService cutoff boundaries', () => {
  let db: Db;
  let home: string;
  let events: EventsRepository;
  let segments: SegmentsRepository;
  let memories: MemoriesRepository;
  let logsDir: string;
  let logPath: string;
  const logLines: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-retention-bounds-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    events = new EventsRepository(db);
    segments = new SegmentsRepository(db);
    memories = new MemoriesRepository(db);
    logsDir = path.join(home, 'logs');
    logPath = path.join(logsDir, 'daemon.jsonl');
    logLines.length = 0;
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function makeService(intervalMs?: number): RetentionService {
    const realLogger = createLogger(logPath);
    return new RetentionService({
      db,
      events,
      segments,
      memories,
      logger: {
        log: (level, scope, message, fields) => {
          logLines.push({ level, scope, message, ...fields });
          realLogger.log(level, scope, message, fields);
        },
        pruneOld: (days) => realLogger.pruneOld(days),
      },
      logsDir,
      logPath,
      intervalMs,
      now: () => NOW,
    });
  }

  function rowCount(sql: string): number {
    return (db.prepare(sql).get() as { n: number }).n;
  }

  it('a raw event EXACTLY at the 48h cutoff survives (strict <)', () => {
    const cutoff = NOW - CONSTANTS.rawRetentionHours * HOUR;
    const preCutoff = wireEvent(cutoff - 1);
    events.insertBatch([wireEvent(cutoff), preCutoff]);
    // Round-27: only processed rows age out (the pending queue is never
    // retention-purged), so the pre-cutoff row must be processed to purge.
    events.markProcessed([preCutoff.id], NOW);
    const stats = makeService().run();
    expect(stats.rawEventsDeleted).toBe(1);
    expect(rowCount('SELECT COUNT(*) AS n FROM raw_events')).toBe(1);
    expect(
      (db.prepare('SELECT observed_at_ms FROM raw_events').get() as { observed_at_ms: number })
        .observed_at_ms,
    ).toBe(cutoff);
  });

  it('a semantic step EXACTLY at the 30d cutoff survives; older ones are purged and reported', () => {
    const cutoff = NOW - CONSTANTS.semanticRetentionDays * DAY;

    const oldSeg = segments.createOpen(cutoff - HOUR, ulid(1));
    segments.appendStep(oldSeg.id, step(cutoff - HOUR), { text: 'ancient', target: 'body', appName: 'Safari' });
    segments.finalize(oldSeg.id, 'finalized', cutoff - HOUR, {});

    const edgeSeg = segments.createOpen(cutoff, ulid(cutoff));
    segments.appendStep(edgeSeg.id, step(cutoff), { text: 'edge survivor', target: 'body', appName: 'Safari' });
    segments.finalize(edgeSeg.id, 'finalized', cutoff, {});

    const stats: RetentionStats = makeService().run();
    expect(stats.stepsDeleted).toBe(1);
    expect(stats.segmentsAffectedByStepPurge).toEqual([oldSeg.id]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM semantic_steps').get() as { n: number }).n,
    ).toBe(1);
  });

  it('a rejected candidate EXACTLY at its cutoff survives; older purged; manual rows always spared', () => {
    const cutoff = NOW - CONSTANTS.rejectedMemoryRetentionDays * DAY;
    const insert = (
      id: string,
      updatedAt: number,
      opts: { manual?: number; evidence?: boolean } = {},
    ): void => {
      db.prepare(
        `INSERT INTO memory_candidates
           (id, kind, canonical_key, text, confidence, status, first_seen_at_ms, last_seen_at_ms,
            evidence_count, created_at_ms, updated_at_ms, manual_confirmed_at_ms)
         VALUES (?, 'fact', ?, ?, 0.9, 'rejected', ?, ?, 1, ?, ?, ?)`,
      ).run(id, `key-${id}`, `text ${id}`, updatedAt, updatedAt, updatedAt, updatedAt, opts.manual ?? null);
      if (opts.evidence === true) {
        db.prepare(
          `INSERT INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms)
           VALUES (?, 'ep-x', 0.9, ?)`,
        ).run(id, NOW);
      }
    };
    db.prepare(
      `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
       VALUES ('ep-x', ?, ?, 'evidence host', ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);

    // At-cutoff survivor needs evidence so zero-evidence cleanup spares it.
    insert('mem-edge', cutoff, { evidence: true });
    // Older non-manual row dies.
    insert('mem-old', cutoff - 1);
    // Ancient MANUAL row is immune to every automatic memory purge.
    insert('mem-manual', cutoff - 10 * DAY, { manual: cutoff - 10 * DAY, evidence: false });
    // Zero-evidence sweep guard: give the manual row confirmed-status safety by
    // keeping it manual (manual rows are never auto-deleted).

    const stats = makeService().run();
    expect(stats.rejectedMemoriesDeleted).toBe(1);
    const ids = (
      db.prepare('SELECT id FROM memory_candidates ORDER BY id').all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(['mem-edge', 'mem-manual']);
  });

  it('log-file mtime boundary is strict < and the active log is never removed', () => {
    const logCutoff = NOW - CONSTANTS.logRetentionDays * DAY;
    writeFileSync(path.join(logsDir, 'at-cutoff.log'), 'x');
    writeFileSync(path.join(logsDir, 'one-under.log'), 'x');
    writeFileSync(path.join(logsDir, 'daemon.jsonl'), '{}'); // active log, ancient mtime
    utimesSync(path.join(logsDir, 'at-cutoff.log'), new Date(logCutoff), new Date(logCutoff));
    utimesSync(path.join(logsDir, 'one-under.log'), new Date(logCutoff - 1), new Date(logCutoff - 1));
    utimesSync(path.join(logsDir, 'daemon.jsonl'), new Date(1_000), new Date(1_000));

    const stats = makeService().run();
    expect(stats.logFilesRemoved).toBe(1);
    expect(existsSync(path.join(logsDir, 'one-under.log'))).toBe(false);
    expect(existsSync(path.join(logsDir, 'at-cutoff.log'))).toBe(true);
    expect(existsSync(path.join(logsDir, 'daemon.jsonl'))).toBe(true);
  });

  it('an interval sweep failure is swallowed once and the timer keeps ticking', () => {
    vi.useFakeTimers();
    try {
      let sweepCalls = 0;
      const service = makeService(5); // injectable cadence: 3 ticks = 15ms
      const realPurge = memories.purgeZeroEvidence.bind(memories);
      vi.spyOn(memories, 'purgeZeroEvidence').mockImplementation(() => {
        sweepCalls += 1;
        if (sweepCalls === 2) throw new Error('transient sweep failure');
        return realPurge();
      });

      service.start(); // initial immediate run = call 1 (healthy)
      try {
        vi.advanceTimersByTime(5); // tick 1 = call 2 (throws)
        vi.advanceTimersByTime(5); // tick 2 = call 3 (healthy again)
        vi.advanceTimersByTime(5); // tick 3 = call 4 (proves the timer survived)

        // Round-26: steps are isolated — the failing PURGE logs a per-step
        // error and the sweep itself completes, so the outer 'retention
        // sweep failed' line no longer fires.
        const failures = logLines.filter((l) =>
          String(l.message).startsWith('retention step failed'),
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ level: 'error', scope: 'retention' });
        expect(sweepCalls).toBe(4); // all four sweeps actually ran
      } finally {
        service.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminal jobs older than the 30d cutoff are purged; non-terminal rows survive at any age', () => {
    const jobs = new JobsRepository(db);
    const cutoff = NOW - JOBS_RETENTION_DAYS * DAY;

    const succeedAt = (at: number): string => {
      const job = jobs.enqueue('noop', {}, at, at);
      const claimed = jobs.claimNext(1_000, at + 1, ['noop']);
      expect(claimed?.id).toBe(job.id);
      expect(jobs.complete(job.id, claimed?.leased_until_ms ?? null, at)).toBe(true);
      return job.id;
    };

    // Exactly AT the cutoff survives (strict <), one day older goes.
    const survivor = succeedAt(cutoff);
    succeedAt(cutoff - DAY);

    // Dead via the real fail path: the fifth failure marks it dead.
    const deadJob = jobs.enqueue('noop', {}, cutoff - 2 * DAY, cutoff - 2 * DAY);
    let t = cutoff - 2 * DAY;
    const failures: Array<'retry' | 'dead' | 'stale'> = [];
    for (const delay of RETRY_SCHEDULE_MS) {
      const claimed = jobs.claimNext(60_000, t, ['noop']);
      expect(claimed?.id).toBe(deadJob.id);
      failures.push(jobs.fail(deadJob.id, 'boom', t, claimed?.leased_until_ms ?? null));
      t += delay + 1; // clear the backoff armed by this failure
    }
    expect(failures[failures.length - 1]).toBe('dead');

    // Non-terminal rows of any age are never purge candidates. Distinct
    // run_after stamps make the claim order deterministic: running (oldest),
    // then retry, while pending stays unclaimed.
    const oldRunningJob = jobs.enqueue('noop', {}, cutoff - 4 * DAY, cutoff - 4 * DAY);
    expect(jobs.claimNext(60_000, cutoff - 4 * DAY, ['noop'])?.id).toBe(oldRunningJob.id);
    const oldRetryJob = jobs.enqueue('noop', {}, cutoff - 3 * DAY, cutoff - 3 * DAY);
    const claimedRetry = jobs.claimNext(60_000, cutoff - 3 * DAY, ['noop']);
    expect(claimedRetry?.id).toBe(oldRetryJob.id);
    expect(
      jobs.fail(oldRetryJob.id, 'boom', cutoff - 3 * DAY, claimedRetry?.leased_until_ms ?? null),
    ).toBe('retry');
    const oldPending = jobs.enqueue('noop', {}, cutoff - 2 * DAY, cutoff - 2 * DAY);

    const stats = makeService().run();
    expect(stats.terminalJobsDeleted).toBe(2); // old succeeded + old dead
    expect(jobs.get(survivor)?.state).toBe('succeeded');
    for (const id of [oldPending.id, oldRunningJob.id, oldRetryJob.id]) {
      expect(jobs.get(id)).not.toBeNull();
    }
    expect(rowCount("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('succeeded','dead')")).toBe(1);
    expect(logLines.at(-1)).toMatchObject({ scope: 'retention', terminalJobsDeleted: 2 });
  });
});
