import { ulid } from 'ulid';

import type Database from 'better-sqlite3';
import type { Db } from './database.js';

/**
 * Retry schedule per contracts §Numeric constants (spec §3.24): attempts 1..4
 * back off +1m, +5m, +30m, +2h; the FIFTH failure marks the job dead.
 */
export const RETRY_SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;

/**
 * Terminal (succeeded/dead) job rows are kept this many days after their last
 * state transition, then removed by the retention sweep — same horizon as
 * semantic steps / rejected candidates (spec §3.22 family of windows).
 */
export const JOBS_RETENTION_DAYS = 30;

/**
 * Payload shapes of the daemon's OWN job types — the single mapping both the
 * producers (segmenter close, summarizer fan-out) and the pipeline's handler
 * registrations derive from, so an enqueue site cannot disagree with the
 * handler about payload shape. The queue itself stays OPEN: `enqueue` keeps
 * accepting arbitrary `string` types with opaque payloads (contracts
 * §Additional pinned decisions — forward-enqueue is never an error).
 */
export interface JobPayloads {
  summarize_segment: { segmentId: string; stepOffset?: number };
  extract_memory: { episodeId: string };
  mine_workflows: { episodeId: string };
}
export type KnownJobType = keyof JobPayloads;

export type JobState = 'pending' | 'running' | 'retry' | 'succeeded' | 'dead';

export interface JobRow {
  id: string;
  type: string;
  state: JobState;
  payload_json: string;
  attempts: number;
  run_after_ms: number;
  leased_until_ms: number | null;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface EnqueuedJob {
  id: string;
  type: string;
  state: JobState;
  runAfterMs: number;
}

export interface JobCounts {
  pending: number;
  running: number;
  retry: number;
  succeeded: number;
  dead: number;
}

/**
 * Durable background-job queue (spec §3.9 jobs table, brief-m2 §D2 item 5).
 * The worker itself arrives in M3; this is the full persistence layer.
 *
 * Contracts §Additional pinned decisions: jobs whose `type` has no registered
 * handler stay pending untouched forever — forward-enqueue (e.g.
 * summarize_segment now, extract_memory from M3) is explicitly supported and
 * never an error. Attempts are counted at claim time so a crashed worker's
 * expired lease still burns its attempt on requeue.
 */
export class JobsRepository {
  private readonly insert: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly failSelectStmt: Database.Statement;
  private readonly failDeadStmt: Database.Statement;
  private readonly failRetryStmt: Database.Statement;
  private readonly retryDeadStmt: Database.Statement;
  /** Lease recovery: dead-cutoff UPDATE then bulk requeue UPDATE. */
  private readonly leaseDeaddenStmt: Database.Statement;
  private readonly leaseRequeueStmt: Database.Statement;
  private readonly purgeTerminalStmt: Database.Statement;
  private readonly countsByStateStmt: Database.Statement;
  /**
   * claimNext prepares one UPDATE…RETURNING per distinct claimable-type set
   * (the worker polls with the registered-handler filter every tick); keyed
   * by the sorted type list since IN-list order carries no meaning.
   */
  private readonly claimStmts = new Map<string, Database.Statement>();

  constructor(private readonly db: Db) {
    this.insert = db.prepare(
      `INSERT INTO jobs (id, type, state, payload_json, attempts, run_after_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(
      `SELECT id, type, state, payload_json, attempts, run_after_ms,
              leased_until_ms, last_error, created_at_ms, updated_at_ms
       FROM jobs WHERE id = ?`,
    );
    this.completeStmt = db.prepare(
      `UPDATE jobs SET state = 'succeeded', leased_until_ms = NULL, updated_at_ms = ?
       WHERE id = ? AND state = 'running' AND leased_until_ms = ?`,
    );
    this.failSelectStmt = db.prepare(
      `SELECT attempts FROM jobs WHERE id = ? AND state = 'running' AND leased_until_ms = ?`,
    );
    this.failDeadStmt = db.prepare(
      `UPDATE jobs SET state = 'dead', last_error = ?, leased_until_ms = NULL, updated_at_ms = ?
       WHERE id = ? AND state = 'running' AND leased_until_ms = ?`,
    );
    this.failRetryStmt = db.prepare(
      `UPDATE jobs SET state = 'retry', run_after_ms = ?, last_error = ?, leased_until_ms = NULL, updated_at_ms = ?
       WHERE id = ? AND state = 'running' AND leased_until_ms = ?`,
    );
    this.retryDeadStmt = db.prepare(
      `UPDATE jobs SET
         state = 'pending',
         attempts = 0,
         run_after_ms = ?,
         leased_until_ms = NULL,
         updated_at_ms = ?
       WHERE state = 'dead'`,
    );
    this.leaseDeaddenStmt = db.prepare(
      `UPDATE jobs SET state = 'dead', leased_until_ms = NULL, updated_at_ms = ?
       WHERE state = 'running' AND leased_until_ms IS NOT NULL AND leased_until_ms < ?
         AND attempts >= ?`,
    );
    this.leaseRequeueStmt = db.prepare(
      `UPDATE jobs SET
         state = 'retry',
         run_after_ms = ? + CASE attempts
           WHEN 1 THEN ?
           WHEN 2 THEN ?
           WHEN 3 THEN ?
           WHEN 4 THEN ?
           ELSE ?
         END,
         leased_until_ms = NULL, updated_at_ms = ?
       WHERE state = 'running' AND leased_until_ms IS NOT NULL AND leased_until_ms < ?`,
    );
    this.purgeTerminalStmt = db.prepare(
      `DELETE FROM jobs WHERE state IN ('succeeded', 'dead') AND updated_at_ms < ?`,
    );
    this.countsByStateStmt = db.prepare(
      `SELECT state, COUNT(*) AS n,
              SUM(CASE WHEN state IN ('pending','retry') AND run_after_ms <= ? THEN 1 ELSE 0 END) AS runnable
       FROM jobs GROUP BY state`,
    );
  }

  enqueue(
    type: string,
    payload: unknown,
    runAfterMs: number = Date.now(),
    createdAtMs: number = Date.now(),
  ): EnqueuedJob {
    const id = ulid(Math.min(runAfterMs, createdAtMs));
    this.insert.run(
      id,
      type,
      JSON.stringify(payload) ?? '{}',
      runAfterMs,
      createdAtMs,
      createdAtMs,
    );
    return { id, type, state: 'pending', runAfterMs };
  }

  /** Compile-checked producer for the daemon's own job types (JobPayloads). */
  enqueueTyped<K extends KnownJobType>(
    type: K,
    payload: JobPayloads[K],
    runAfterMs: number = Date.now(),
    createdAtMs: number = Date.now(),
  ): EnqueuedJob {
    return this.enqueue(type, payload, runAfterMs, createdAtMs);
  }

  /** Full row by id, or null when unknown (diagnostics + tests). */
  get(id: string): JobRow | null {
    const row = this.getStmt.get(id) as JobRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically claim the next runnable job: pending/retry with run_after_ms due,
   * oldest first. The conditional UPDATE…RETURNING makes concurrent claims safe.
   * Attempts increment here — one claim equals one attempt (spec §3.24).
   * When `types` is given only those job types are claimable: jobs whose type
   * has no registered handler stay pending untouched (contracts §Additional
   * pinned decisions — forward-enqueue is never an error).
   */
  claimNext(leaseMs: number, now: number, types?: readonly string[]): JobRow | null {
    const key = types === undefined || types.length === 0 ? '' : [...types].sort().join('\u0000');
    let stmt = this.claimStmts.get(key);
    if (stmt === undefined) {
      const typeFilter =
        types !== undefined && types.length > 0
          ? ` AND type IN (${types.map(() => '?').join(', ')})`
          : '';
      stmt = this.db.prepare(
        `UPDATE jobs SET
           state = 'running',
           leased_until_ms = ?,
           attempts = attempts + 1,
           updated_at_ms = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state IN ('pending', 'retry') AND run_after_ms <= ?${typeFilter}
           ORDER BY run_after_ms ASC, created_at_ms ASC
           LIMIT 1
         )
         RETURNING id, type, state, payload_json, attempts, run_after_ms,
                   leased_until_ms, last_error, created_at_ms, updated_at_ms`,
      );
      this.claimStmts.set(key, stmt);
    }
    const row = stmt.get(
      ...(key === '' ? [now + leaseMs, now, now] : [now + leaseMs, now, now, ...(types ?? [])]),
    );
    return row === undefined ? null : (row as JobRow);
  }

  /**
   * Marks a job succeeded — but only if the caller still owns the claim:
   * the lease token captured at claim time must still match. A worker that
   * overran its lease and lost the job to recovery must not clobber the
   * successor's state (a state-only guard let a stale worker mark
   * 'succeeded' a row another worker was actively re-running).
   */
  complete(id: string, leaseToken: number | null, now: number): boolean {
    return this.completeStmt.run(now, id, leaseToken).changes === 1;
  }

  /**
   * Records a failure for the CURRENT attempt: attempts 1..4 back off
   * +1m/+5m/+30m/+2h per RETRY_SCHEDULE_MS; the FIFTH failure marks the job
   * dead (spec §3.24: «После пятой ошибки: dead»). Only the worker still
   * holding the claim can fail the job — the lease token captured at claim
   * time must still match, so a stale worker whose lease expired and whose
   * job a successor now runs answers 'stale' (no throw) and moves on
   * instead of clearing the successor's lease or marking dead a job that
   * may be about to succeed.
   */
  fail(
    id: string,
    errorMessage: string,
    now: number,
    leaseToken: number | null,
  ): Extract<JobState, 'retry' | 'dead'> | 'stale' {
    const job = this.failSelectStmt.get(id, leaseToken) as { attempts: number } | undefined;
    if (job === undefined) {
      return 'stale';
    }
    if (job.attempts >= RETRY_SCHEDULE_MS.length) {
      return this.failDeadStmt.run(errorMessage, now, id, leaseToken).changes === 1
        ? 'dead'
        : 'stale';
    }
    const delay = RETRY_SCHEDULE_MS[job.attempts - 1];
    if (delay === undefined) {
      throw new Error(`fail(): no retry slot for attempt ${job.attempts} of job ${id}`);
    }
    return this.failRetryStmt.run(now + delay, errorMessage, now, id, leaseToken).changes === 1
      ? 'retry'
      : 'stale';
  }

  /**
   * Manual re-drive of dead jobs (spec §3.24 V1 pin, brief-m7 §D7 item 6):
   * dead jobs are NEVER auto-revived when the model heals; diagnostics op
   * `jobs.retryDead {}` moves them back to pending with run_after=now and a
   * FRESH attempt budget. Returns how many rows were re-driven.
   */
  retryDead(now: number): number {
    return this.retryDeadStmt.run(now, now).changes;
  }

  /**
   * Running jobs whose lease lapsed (crashed worker) go back to retry on the
   * same pinned schedule as a normal failure: the burned attempt picks the
   * RETRY_SCHEDULE_MS[min(attempts-1, 4)] slot instead of arming immediately.
   * A job whose FIFTH lease lapses is terminal — dead, mirroring fail()'s
   * attempts >= RETRY_SCHEDULE_MS.length cutoff (spec §3.24): without this a
   * poison job whose worker dies every run would be re-claimed every 6h forever.
   */
  requeueExpiredLeases(now: number): number {
    const deadded = this.leaseDeaddenStmt.run(now, now, RETRY_SCHEDULE_MS.length).changes;
    const requeued = this.leaseRequeueStmt.run(now, ...RETRY_SCHEDULE_MS, now, now).changes;
    return deadded + requeued;
  }

  /**
   * Retention purge (spec §3.22): removes terminal jobs — succeeded/dead —
   * whose last update predates `cutoffMs`. For terminal rows updated_at_ms IS
   * the completion time: complete() and fail()'s dead transition set state and
   * updated_at_ms together, and no later write ever touches a terminal row
   * (retryDead/requeueExpiredLeases move rows OUT of dead, bumping the stamp
   * as they leave). Pending/retrying/running rows are never purged here —
   * stuck leases are the requeue path's job, not retention's.
   */
  purgeTerminalOlderThan(cutoffMs: number): number {
    return this.purgeTerminalStmt.run(cutoffMs).changes;
  }

  countsByState(now: number = Date.now()): JobCounts & { runnablePending: number } {
    const rows = this.countsByStateStmt.all(now) as {
      state: JobState;
      n: number;
      runnable: number | null;
    }[];
    const counts: JobCounts & { runnablePending: number } = {
      pending: 0,
      running: 0,
      retry: 0,
      succeeded: 0,
      dead: 0,
      runnablePending: 0,
    };
    for (const row of rows) {
      counts[row.state] = row.n;
      counts.runnablePending += row.runnable ?? 0;
    }
    return counts;
  }
}
