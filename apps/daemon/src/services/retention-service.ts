import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { CONSTANTS } from '../config.js';
import { JobsRepository, JOBS_RETENTION_DAYS } from '../db/jobs-repository.js';
import type { EventsRepository } from '../db/events-repository.js';
import type { SegmentsRepository } from '../db/segments-repository.js';
import type { MemoriesRepository } from '../db/memories-repository.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../logging.js';

export interface RetentionStats {
  /** raw_events rows older than 48h removed. */
  rawEventsDeleted: number;
  /** semantic_steps rows older than 30d removed (links + FTS cascade with them). */
  stepsDeleted: number;
  /** rejected memory_candidates older than 30d removed (manual rows spared). */
  rejectedMemoriesDeleted: number;
  /** superseded memory_candidates older than 30d removed (evidence goes with them). */
  supersededMemoriesDeleted: number;
  /** Non-manual rows without any evidence removed (contracts §memory.action semantics). */
  zeroEvidenceMemoriesDeleted: number;
  /** Segments that lost at least one step in the sweep. */
  segmentsAffectedByStepPurge: string[];
  /** Terminal (succeeded/dead) job rows older than 30d removed. */
  terminalJobsDeleted: number;
  /** daemon.jsonl lines older than 7d pruned. */
  logLinesPruned: number;
  /** other files under logsDir older than 7d removed. */
  logFilesRemoved: number;
}

export interface RetentionServiceOptions {
  db: Db;
  events: EventsRepository;
  segments: SegmentsRepository;
  /** M5 write-side owner of memory_candidates purges (rowid-keyed FTS). */
  memories: MemoriesRepository;
  /** Purges terminal job rows; defaults to a local handle over `db`. */
  jobs?: JobsRepository;
  logger: Logger;
  /** Directory holding recorder-facing + daemon log files. */
  logsDir: string;
  /** The daemon's own JSONL log; line-pruned rather than deleted. */
  logPath: string;
  now?: () => number;
  /** Injectable cadence for tests; pinned default 6 hours (spec §3.22). */
  intervalMs?: number;
}

/**
 * Retention job (spec §3.22, brief-m2 §D2 item 6): runs on daemon startup and
 * every 6 hours. Deletion order: raw_events → semantic_steps → rejected memory
 * candidates (+ zero-evidence non-manual memories, contracts §memory.action
 * semantics) → old logs. Episode summaries and memory evidence are never
 * deleted automatically along with raw telemetry; manually confirmed memories
 * survive every automatic memory purge.
 */
export class RetentionService {
  private readonly db: Db;
  private readonly events: EventsRepository;
  private readonly segments: SegmentsRepository;
  private readonly memories: MemoriesRepository;
  private readonly jobs: JobsRepository;
  private readonly logger: Logger;
  private readonly logsDir: string;
  private readonly logPath: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: RetentionServiceOptions) {
    this.db = options.db;
    this.events = options.events;
    this.segments = options.segments;
    this.memories = options.memories;
    this.jobs = options.jobs ?? new JobsRepository(options.db);
    this.logger = options.logger;
    this.logsDir = options.logsDir;
    this.logPath = options.logPath;
    this.now = options.now ?? Date.now;
    this.intervalMs =
      options.intervalMs ?? CONSTANTS.retentionIntervalHours * 60 * 60 * 1000;
  }

  run(): RetentionStats {
    const now = this.now();
    const rawCutoff = now - CONSTANTS.rawRetentionHours * 60 * 60 * 1000;
    const stepCutoff = now - CONSTANTS.semanticRetentionDays * 24 * 60 * 60 * 1000;
    const rejectedCutoff = now - CONSTANTS.rejectedMemoryRetentionDays * 24 * 60 * 60 * 1000;
    const jobsCutoff = now - JOBS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const logCutoff = now - CONSTANTS.logRetentionDays * 24 * 60 * 60 * 1000;

    // Each step is isolated: one throwing purge (e.g. an inconsistent FTS
    // mirror mid-delete) must not skip the remaining purges for the whole
    // sweep — unpruned logs and terminal job rows used to accumulate
    // silently while the stats line never fired. A failed step logs its own
    // error and reports 0; the next sweep retries it.
    const step = <T>(name: string, run: () => T, fallback: T): T => {
      try {
        return run();
      } catch (err) {
        this.logger.log('error', 'retention', `retention step failed: ${name}`, {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return fallback;
      }
    };

    // 1. Raw events (48h).
    const rawEventsDeleted = step('raw_events', () => this.events.purgeOlderThan(rawCutoff), 0);

    // 2. Semantic steps (30d); episode_step_links + FTS rows go in the same tx.
    const purge = step(
      'semantic_steps',
      () => this.segments.purgeStepsOlderThan(stepCutoff),
      { deletedSteps: 0, affectedSegmentIds: [] },
    );

    // 3. Rejected memory candidates (30d) + zero-evidence non-manual rows —
    // both via the M5 repository so FTS mirrors go by rowid in the same tx
    // and manual_confirmed_at rows are always spared.
    const rejectedMemoriesDeleted = step(
      'memory_candidates(rejected)',
      () => this.memories.purgeRejectedOlderThan(rejectedCutoff),
      0,
    );
    const supersededCutoff = now - CONSTANTS.semanticRetentionDays * 24 * 60 * 60 * 1000;
    const supersededMemoriesDeleted = step(
      'memory_candidates(superseded)',
      () => this.memories.purgeSupersededOlderThan(supersededCutoff),
      0,
    );
    const zeroEvidenceMemoriesDeleted = step(
      'memory_candidates(zero-evidence)',
      () => this.memories.purgeZeroEvidence(),
      0,
    );

    // 4. Terminal jobs (30d): succeeded/dead rows are pure history and the
    // queue's GROUP-BY counts poll them every 5s; pending/retrying/running
    // rows are never touched here.
    const terminalJobsDeleted = step('jobs(terminal)', () => this.jobs.purgeTerminalOlderThan(jobsCutoff), 0);

    // 5. Logs (7d): prune old lines from the daemon JSONL, delete stale files.
    const logLinesPruned = step('daemon.jsonl', () => this.pruneDaemonLog(now), 0);
    const logFilesRemoved = step('log files', () => this.pruneLogFiles(logCutoff), 0);

    const stats: RetentionStats = {
      rawEventsDeleted,
      stepsDeleted: purge.deletedSteps,
      segmentsAffectedByStepPurge: purge.affectedSegmentIds,
      rejectedMemoriesDeleted,
      supersededMemoriesDeleted,
      zeroEvidenceMemoriesDeleted,
      terminalJobsDeleted,
      logLinesPruned,
      logFilesRemoved,
    };
    // One summary line per run; counts only, never content.
    this.logger.log('info', 'retention', 'retention sweep complete', {
      rawEventsDeleted,
      stepsDeleted: purge.deletedSteps,
      segmentsAffected: purge.affectedSegmentIds.length,
      rejectedMemoriesDeleted,
      supersededMemoriesDeleted,
      zeroEvidenceMemoriesDeleted,
      terminalJobsDeleted,
      logLinesPruned,
      logFilesRemoved,
    });
    return stats;
  }

  /** Run once immediately, then on the injectable interval (unref'd). */
  start(): void {
    try {
      this.run();
    } catch (err) {
      this.logger.log('error', 'retention', 'retention sweep failed', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (err) {
        this.logger.log('error', 'retention', 'retention sweep failed', {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pruneDaemonLog(nowMs: number): number {
    // pruneOld drops exactly the daemon.jsonl lines older than the 7d window;
    // the cutoff derives from the same sweep clock as every other purge.
    return this.logger.pruneOld(CONSTANTS.logRetentionDays, nowMs);
  }

  private pruneLogFiles(cutoffMs: number): number {
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.logsDir);
    } catch {
      return 0;
    }
    const activeLog = path.basename(this.logPath);
    for (const entry of entries) {
      if (entry === activeLog) continue;
      const full = path.join(this.logsDir, entry);
      try {
        if (!statSync(full).isFile()) continue;
        if (statSync(full).mtimeMs < cutoffMs) {
          unlinkSync(full);
          removed += 1;
        }
      } catch {
        // A file vanishing mid-sweep must not abort retention.
      }
    }
    return removed;
  }
}
