import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
import { createLogger } from '../src/logging.js';
import { migrate } from '../src/db/migrator.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import { RetentionService, type RetentionStats } from '../src/services/retention-service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Ctx {
  db: Db;
  events: EventsRepository;
  segments: SegmentsRepository;
  memories: MemoriesRepository;
  home: string;
  logsDir: string;
  logPath: string;
  logLines: Array<Record<string, unknown>>;
  service: RetentionService;
}

function wireEvent(observedAt: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(Math.max(observedAt, 1)),
    observedAt,
    monotonicNs: observedAt * 1000,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 7 },
    action: 'scroll',
    contentPolicy: 'metadata_only',
    ...overrides,
  };
}

function step(at: number, overrides: Partial<CoalescedStep> = {}): CoalescedStep {
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
    ...overrides,
  };
}

describe('RetentionService (spec §3.22 deletion order + stats)', () => {
  let ctx: Ctx;

  beforeEach(() => {
    const home = mkdtempSync(path.join(tmpdir(), 'ch-retention-'));
    const db = openDatabase(path.join(home, 'history.db'));
    migrate(db);
    const events = new EventsRepository(db);
    const segments = new SegmentsRepository(db);
    const memories = new MemoriesRepository(db);
    const logsDir = path.join(home, 'logs');
    const logPath = path.join(logsDir, 'daemon.jsonl');
    const logLines: Array<Record<string, unknown>> = [];
    const logger = createLogger(logPath);
    const spy: typeof logger = {
      log: (level, scope, message, fields) => {
        logLines.push({ level, scope, message, ...fields });
        logger.log(level, scope, message, fields);
      },
      pruneOld: (days, nowMs) => logger.pruneOld(days, nowMs),
      recentErrors: () => logger.recentErrors(),
    };
    ctx = {
      db,
      events,
      segments,
      memories,
      home,
      logsDir,
      logLines,
      logPath,
      service: new RetentionService({
        db,
        events,
        segments,
        memories,
        logger: spy,
        logsDir,
        logPath,
      }),
    };
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.home, { recursive: true, force: true });
  });

  it('purges processed raw_events older than 48h and keeps fresh ones', () => {
    const now = Date.now();
    const oldBatch = [wireEvent(now - 49 * HOUR), wireEvent(now - 48 * HOUR - 1)];
    const freshBatch = [wireEvent(now - 47 * HOUR)];
    ctx.events.insertBatch(oldBatch);
    ctx.events.insertBatch(freshBatch);
    // New semantics: the pending queue is never retention-purged — only
    // processed rows age out. Mark the old batch consumed by the pipeline.
    ctx.events.markProcessed(oldBatch.map((e) => e.id), now);

    const stats = ctx.service.run();
    expect(stats.rawEventsDeleted).toBe(2);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n).toBe(1);
    expect(
      (ctx.db.prepare('SELECT observed_at_ms FROM raw_events').get() as { observed_at_ms: number })
        .observed_at_ms,
    ).toBe(now - 47 * HOUR);
  });

  it('keeps unprocessed (never-segmented) events even when older than the raw cutoff', () => {
    // Sustained segmenter failure must not silently destroy pending events:
    // they survive retention and the queue grows loudly instead.
    const now = Date.now();
    const stale = wireEvent(now - 72 * HOUR);
    ctx.events.insertBatch([stale]);

    const stats = ctx.service.run();
    expect(stats.rawEventsDeleted).toBe(0);
    expect(ctx.events.fetchUnprocessed(now, 10).map((e) => e.id)).toEqual([stale.id]);
  });

  it('purges semantic_steps older than 30d with their FTS rows and episode links; keeps everything else', () => {
    const now = Date.now();

    // Old segment with two old steps; one is referenced by an episode link.
    const oldSeg = ctx.segments.createOpen(now - 40 * DAY, ulid(1));
    const oldA = ctx.segments.appendStep(oldSeg.id, step(now - 40 * DAY, { text: 'ancient needle alpha' }), {
      text: 'ancient needle alpha',
      target: 'body',
      appName: 'Safari',
    });
    void ctx.segments.appendStep(oldSeg.id, step(now - 39 * DAY), {
      text: 'old two',
      target: 'body',
      appName: 'Safari',
    });
    ctx.segments.finalize(oldSeg.id, 'finalized', now - 39 * DAY, {});

    // Fresh segment that must survive intact.
    const freshSeg = ctx.segments.createOpen(now - HOUR, ulid(now - HOUR));
    const freshStep = ctx.segments.appendStep(freshSeg.id, step(now - HOUR, { text: 'fresh needle beta' }), {
      text: 'fresh needle beta',
      target: 'body',
      appName: 'Safari',
    });

    // Episode linkage for the cascade check (schema has no ON DELETE CASCADE).
    ctx.db
      .prepare(
        `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
         VALUES ('ep-old', ?, ?, 'Old episode', ?, ?)`,
      )
      .run(now - 40 * DAY, now - 39 * DAY, now - 39 * DAY, now - 39 * DAY);
    ctx.db
      .prepare(`INSERT INTO episode_step_links (episode_id, semantic_step_id, ordinal) VALUES ('ep-old', ?, 1)`)
      .run(oldA);

    // Both needles searchable before the sweep.
    const matchCount = (needle: string): number =>
      (
        ctx.db
          .prepare(`SELECT COUNT(*) AS n FROM semantic_steps_fts WHERE semantic_steps_fts MATCH ?`)
          .get(needle) as { n: number }
      ).n;
    expect(matchCount('ancient')).toBe(1);
    expect(matchCount('fresh')).toBe(1);

    const stats = ctx.service.run();
    expect(stats.stepsDeleted).toBe(2);
    expect(stats.segmentsAffectedByStepPurge).toEqual([oldSeg.id]);

    // Right rows deleted…
    expect(ctx.segments.getSegment(oldSeg.id)).not.toBeNull(); // segment row survives

    // …wrong rows intact.
    expect(matchCount('fresh')).toBe(1); // FTS synced: fresh still searchable
    expect(matchCount('ancient')).toBe(0); // FTS absence proven by search
    expect(
      (ctx.db.prepare('SELECT id FROM semantic_steps').all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual([freshStep]); // exactly the fresh step survives

    // Link cascaded away, episode summary kept (spec: episodes never auto-deleted).
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM episode_step_links').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (ctx.db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE id = 'ep-old'").get() as { n: number }).n,
    ).toBe(1);
  });

  it('purges rejected memory candidates older than 30d including memories_fts rows', () => {
    const now = Date.now();
    const insertCandidate = (id: string, status: string, updatedAt: number, text: string): void => {
      ctx.db
        .prepare(
          `INSERT INTO memory_candidates (id, kind, canonical_key, text, confidence, status, first_seen_at_ms, last_seen_at_ms, evidence_count, created_at_ms, updated_at_ms)
           VALUES (?, 'fact', ?, ?, 0.9, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, `key-${id}`, text, status, updatedAt, updatedAt, updatedAt, updatedAt);
      ctx.db
        .prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)')
        .run(
          (ctx.db.prepare('SELECT rowid FROM memory_candidates WHERE id = ?').get(id) as { rowid: number }).rowid,
          text,
          `key-${id}`,
        );
    };
    insertCandidate('mem-old-rejected', 'rejected', now - 31 * DAY, 'stale claim');
    insertCandidate('mem-fresh-rejected', 'rejected', now - 29 * DAY, 'recent rejection');
    insertCandidate('mem-active', 'active', now - 31 * DAY, 'durable claim');
    // Zero-evidence cleanup (contracts §memory.action semantics) would wipe
    // non-manual rows without observations, so the two survivors get evidence.
    ctx.db
      .prepare(
        `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
         VALUES ('ep-x', ?, ?, 'e', ?, ?)`,
      )
      .run(now, now, now, now);
    const withEvidence = ctx.db.prepare(
      `INSERT INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms)
       SELECT id, 'ep-x', 0.9, ? FROM memory_candidates WHERE id IN ('mem-active', 'mem-fresh-rejected')`,
    );
    withEvidence.run(now);

    const ftsHas = (text: string): number =>
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
          .get(text) as { n: number }
      ).n;

    const stats = ctx.service.run();
    expect(stats.rejectedMemoriesDeleted).toBe(1);
    const statuses = ctx.db.prepare('SELECT id, status FROM memory_candidates').all() as Array<{
      id: string;
      status: string;
    }>;
    expect(statuses.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'mem-active', status: 'active' },
      { id: 'mem-fresh-rejected', status: 'rejected' },
    ]);
    expect(ftsHas('stale')).toBe(0);
    expect(ftsHas('durable')).toBe(1);
  });

  it('purges superseded candidates older than 30d with their evidence; keeps fresh ones', () => {
    const now = Date.now();
    const insertSuperseded = (id: string, updatedAt: number, text: string): void => {
      ctx.db
        .prepare(
          `INSERT INTO memory_candidates (id, kind, canonical_key, text, confidence, status,
             first_seen_at_ms, last_seen_at_ms, evidence_count, created_at_ms, updated_at_ms)
           VALUES (?, 'fact', ?, ?, 0.9, 'superseded', ?, ?, 1, ?, ?)`,
        )
        .run(id, `key-${id}`, text, updatedAt, updatedAt, updatedAt, updatedAt);
      const { rowid } = ctx.db.prepare('SELECT rowid FROM memory_candidates WHERE id = ?').get(id) as {
        rowid: number;
      };
      ctx.db
        .prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)')
        .run(rowid, text, `key-${id}`);
      // The incumbent replacement carries the content; the superseded row's
      // evidence ledger must go WITH the row (no FK cascade).
      ctx.db
        .prepare(
          `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'e', ?, ?)`,
        )
        .run(`ep-${id}`, now, now, now, now);
      ctx.db
        .prepare(
          'INSERT INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms) VALUES (?, ?, 0.9, ?)',
        )
        .run(id, `ep-${id}`, now);
    };
    insertSuperseded('mem-old-superseded', now - 31 * DAY, 'stale superseded claim');
    insertSuperseded('mem-fresh-superseded', now - 29 * DAY, 'fresh superseded claim');

    const stats = ctx.service.run();
    expect(stats.supersededMemoriesDeleted).toBe(1);
    const statuses = ctx.db.prepare('SELECT id FROM memory_candidates').all() as Array<{ id: string }>;
    expect(statuses).toEqual([{ id: 'mem-fresh-superseded' }]);
    // Evidence ledger of the purged row went in the same transaction.
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?').get('mem-old-superseded') as { n: number }).n,
    ).toBe(0);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?').get('mem-fresh-superseded') as { n: number }).n,
    ).toBe(1);
    // FTS mirror gone by rowid.
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get('stale') as { n: number }).n,
    ).toBe(0);
  });

  it('a superseded candidate EXACTLY at its cutoff survives (strict <)', () => {
    const now = Date.now();
    const at = now - CONSTANTS.semanticRetentionDays * DAY;
    ctx.db
      .prepare(
        `INSERT INTO memory_candidates (id, kind, canonical_key, text, confidence, status,
           first_seen_at_ms, last_seen_at_ms, evidence_count, created_at_ms, updated_at_ms)
         VALUES ('mem-edge', 'fact', 'key-edge', 'edge claim', 0.9, 'superseded', ?, ?, 0, ?, ?)`,
      )
      .run(at, at, at, at);

    // Evidence keeps the zero-evidence purge out of the picture so this pin
    // isolates the superseded age comparison.
    ctx.db
      .prepare(
        `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
         VALUES ('ep-edge', ?, ?, 'e', ?, ?)`,
      )
      .run(now, now, now, now);
    ctx.db
      .prepare(
        'INSERT INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms) VALUES (?, ?, 0.9, ?)',
      )
      .run('mem-edge', 'ep-edge', now);

    // Pinned clock: the shared ctx.service defaults to Date.now(), and a
    // later wall-clock sample would push the cutoff past the fixture.
    const service = new RetentionService({
      db: ctx.db,
      events: ctx.events,
      segments: ctx.segments,
      memories: ctx.memories,
      logger: createLogger(ctx.logPath),
      logsDir: ctx.logsDir,
      logPath: ctx.logPath,
      now: () => now,
    });
    const stats = service.run();
    expect(stats.supersededMemoriesDeleted).toBe(0);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE id = ?').get('mem-edge') as { n: number }).n,
    ).toBe(1);
  });

  it('prunes old daemon.jsonl lines and removes stale log files but never the active log', () => {
    const nowMs = Date.now();
    const staleFile = path.join(ctx.logsDir, 'recorder-old.log');
    writeFileSync(staleFile, 'stale\n');
    const freshFile = path.join(ctx.logsDir, 'recorder-new.log');
    writeFileSync(freshFile, 'fresh\n');
    const eightDaysAgo = new Date(nowMs - 8 * DAY);
    utimesSync(staleFile, eightDaysAgo, eightDaysAgo);

    const stats = ctx.service.run();
    expect(stats.logFilesRemoved).toBe(1);
    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    expect(existsSync(ctx.logPath)).toBe(true);

    // Line-level pruning: seed an old line directly, run again.
    const line = readFileSync(ctx.logPath, 'utf8');
    const oldLine = `${JSON.stringify({ at: nowMs - 8 * DAY, level: 'info', scope: 't', message: 'ancient' })}\n`;
    writeFileSync(ctx.logPath, oldLine + line);
    const second = ctx.service.run();
    expect(second.logLinesPruned).toBeGreaterThanOrEqual(1);
    expect(readFileSync(ctx.logPath, 'utf8')).not.toContain('ancient');
  });

  it('logs exactly one stats summary line per run with counts only', () => {
    ctx.service.run();
    const summaries = ctx.logLines.filter((l) => l.message === 'retention sweep complete');
    expect(summaries).toHaveLength(1);
    const keys = Object.keys(summaries[0] ?? {}).sort();
    expect(keys).toEqual([
      'level',
      'logFilesRemoved',
      'logLinesPruned',
      'message',
      'rawEventsDeleted',
      'rejectedMemoriesDeleted',
      'scope',
      'segmentsAffected',
      'stepsDeleted',
      'supersededMemoriesDeleted',
      'terminalJobsDeleted',
      'zeroEvidenceMemoriesDeleted',
    ]);
  });

  it('zero-evidence cleanup removes non-manual memories but spares manual_confirmed rows', () => {
    const now = Date.now();
    const insertMemory = (
      id: string,
      text: string,
      manualAt: number | null,
      withEvidence: boolean,
    ): void => {
      ctx.db
        .prepare(
          `INSERT INTO memory_candidates (id, kind, canonical_key, text, confidence, status,
             first_seen_at_ms, last_seen_at_ms, evidence_count, created_at_ms, updated_at_ms,
             manual_confirmed_at_ms)
           VALUES (?, 'fact', ?, ?, 0.9, 'active', ?, ?, 0, ?, ?, ?)`,
        )
        .run(id, `key-${id}`, text, now - 1000, now, now - 1000, now, manualAt);
      const { rowid } = ctx.db
        .prepare('SELECT rowid FROM memory_candidates WHERE id = ?')
        .get(id) as { rowid: number };
      ctx.db
        .prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)')
        .run(rowid, text, `key-${id}`);
      if (!withEvidence) return;
      ctx.db
        .prepare(
          `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'e', ?, ?)`,
        )
        .run(`ep-${id}`, now, now, now, now);
      ctx.db
        .prepare(
          'INSERT INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms) VALUES (?, ?, 0.9, ?)',
        )
        .run(id, `ep-${id}`, now);
    };

    insertMemory('mem-orphan', 'lonely claim', null, false); // purged
    insertMemory('mem-manual', 'kept claim', now, false); // spared
    insertMemory('mem-backed', 'evidenced claim', null, true); // spared

    const ftsHas = (needle: string): number =>
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
          .get(needle) as { n: number }
      ).n;

    const stats = ctx.service.run();
    expect(stats.zeroEvidenceMemoriesDeleted).toBe(1);
    expect(ftsHas('lonely')).toBe(0); // FTS mirror gone by rowid
    expect(ftsHas('kept')).toBe(1);
    expect(ftsHas('evidenced')).toBe(1);
  });

  it('start() runs immediately then repeats on the injectable interval; stop() cancels', () => {
    vi.useFakeTimers();
    try {
      const runs: number[] = [];
      const counting = new RetentionService({
        db: ctx.db,
        events: ctx.events,
        segments: ctx.segments,
        logger: {
          log: (_level, _scope, message) => {
            if (message === 'retention sweep complete') runs.push(Date.now());
          },
          pruneOld: () => 0,
        },
        memories: ctx.memories,
        logsDir: ctx.logsDir,
        logPath: ctx.logPath,
        intervalMs: 20,
      });

      counting.start();
      expect(runs).toHaveLength(1); // immediate startup run
      vi.advanceTimersByTime(20);
      vi.advanceTimersByTime(20);
      expect(runs).toHaveLength(3); // + two interval ticks

      counting.stop();
      vi.advanceTimersByTime(200);
      expect(runs).toHaveLength(3); // timer cancelled, no further ticks
    } finally {
      vi.useRealTimers();
    }
  });

  // R9-T2a: the readdirSync try/catch must degrade the file sweep to a zero
  // count instead of throwing AFTER the destructive DB purges have committed
  // (the interval callback would swallow the throw as silent per-6h failures).
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable logsDir degrades to logFilesRemoved 0 while DB sweeps still ran',
    () => {
      const now = Date.now();
      const stale = wireEvent(now - 49 * HOUR);
      ctx.events.insertBatch([stale]);
      ctx.events.markProcessed([stale.id], now);
      chmodSync(ctx.logsDir, 0o000);
      try {
        let stats: RetentionStats | undefined;
        expect(() => {
          stats = ctx.service.run();
        }).not.toThrow();
        // Ordering claim: raw_events purge already ran BEFORE the failed
        // readdir — the sweep reached step 5 with the filesystem leg dead.
        expect(stats!.logFilesRemoved).toBe(0);
        expect(stats!.rawEventsDeleted).toBe(1);
      } finally {
        chmodSync(ctx.logsDir, 0o700);
      }
    },
  );

  // R9-T2b: a per-entry statSync failure (dangling symlink → ENOENT, no
  // mocks) skips that entry but must not abort the remaining unlink work.
  it('an entry vanishing mid-sweep does not abort retention', () => {
    const now = Date.now();
    const oldLog = path.join(ctx.logsDir, 'old.log');
    const ghostLog = path.join(ctx.logsDir, 'ghost.log');
    writeFileSync(oldLog, 'stale\n');
    utimesSync(oldLog, new Date(now - 8 * DAY), new Date(now - 8 * DAY));
    symlinkSync(path.join(ctx.logsDir, 'nonexistent.target'), ghostLog);

    const stats = ctx.service.run();

    expect(stats.logFilesRemoved).toBe(1);
    expect(existsSync(oldLog)).toBe(false); // ancient regular file unlinked
    expect(lstatSync(ghostLog).isSymbolicLink()).toBe(true); // statSync threw → skipped, never unlinked
  });
});

it('pins the retention cadence constant from contracts', () => {
  // Direct pin: the sweep cadence is contracts-pinned at 6 hours; a silent
  // retune of CONSTANTS.retentionIntervalHours must fail loudly here.
  expect(CONSTANTS.retentionIntervalHours).toBe(6);
});
