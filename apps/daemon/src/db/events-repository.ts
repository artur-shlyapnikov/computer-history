import type Database from 'better-sqlite3';

import { ActivityEventSchema, isFrame, type ActivityEvent } from '@computer-history/protocol';

import { privacyRejection, type RejectionReason } from '../ingest/validation.js';
import type { Db } from './database.js';

export interface InsertBatchCounts {
  accepted: number;
  duplicates: number;
  rejected: number;
}

export interface InsertBatchResult extends InsertBatchCounts {
  /** Rejection reason histogram for the batch (counts only, no content). */
  reasons: Partial<Record<RejectionReason, number>>;
}

const INSERT_SQL = `INSERT OR IGNORE INTO raw_events (
  id, observed_at_ms, monotonic_ns, capture_session_id,
  source, action,
  app_bundle_id, app_name, pid,
  window_title,
  target_role, target_subrole, target_label, target_identifier,
  content, content_policy, inserted_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface RawEventRow {
  id: string;
  observed_at_ms: number;
  monotonic_ns: number | null;
  capture_session_id: string | null;
  source: string;
  action: string;
  app_bundle_id: string;
  app_name: string | null;
  pid: number | null;
  window_title: string | null;
  target_role: string | null;
  target_subrole: string | null;
  target_label: string | null;
  target_identifier: string | null;
  content: string | null;
  content_policy: string;
}

function bump(reasons: Partial<Record<RejectionReason, number>>, reason: RejectionReason): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/**
 * raw_events storage (brief-m1 §D1 item 1). Duplicates resolve via the ULID
 * primary key with INSERT OR IGNORE inside one transaction. As defense in
 * depth every row re-passes wire-schema + privacy validation here, even though
 * the ingestor already filtered — spec §3.11 double enforcement.
 */
export class EventsRepository {
  private readonly insertBatchTx: (
    events: readonly unknown[],
    insertedAtMs: number,
  ) => InsertBatchResult;
  private readonly fetchUnprocessedStmt: Database.Statement;
  private readonly purgeOlderThanStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  /** One prepared UPDATE per distinct IN-clause arity (chunked id lists). */
  private readonly markProcessedStmts = new Map<number, Database.Statement>();

  constructor(private readonly db: Db) {
    const insert = db.prepare(INSERT_SQL);
    this.fetchUnprocessedStmt = db.prepare(
      `SELECT id, observed_at_ms, monotonic_ns, capture_session_id, source, action,
              app_bundle_id, app_name, pid, window_title,
              target_role, target_subrole, target_label, target_identifier,
              content, content_policy
       FROM raw_events
       WHERE processed_at_ms IS NULL AND observed_at_ms < ?
       ORDER BY observed_at_ms ASC, monotonic_ns ASC, id ASC
       LIMIT ?`,
    );
    // Retention must never destroy the pending queue: rows with
    // processed_at_ms IS NULL are still awaiting segmentation, so purging
    // them would silently drop never-processed history during a sustained
    // segmenter outage. The queue instead grows loudly (count/alerts) and
    // ages out only after processing.
    this.purgeOlderThanStmt = db.prepare(
      'DELETE FROM raw_events WHERE observed_at_ms < ? AND processed_at_ms IS NOT NULL',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM raw_events');
    this.insertBatchTx = db.transaction((events, insertedAtMs) => {
      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      const reasons: Partial<Record<RejectionReason, number>> = {};
      for (const value of events) {
        // Defense in depth: wire schema + privacy invariants re-checked here even
        // though the ingestor filtered already (spec §3.11 double enforcement).
        if (!isFrame(ActivityEventSchema, value)) {
          rejected += 1;
          bump(reasons, 'schema_invalid');
          continue;
        }
        const why = privacyRejection(value);
        if (why !== null) {
          rejected += 1;
          bump(reasons, why);
          continue;
        }
        const result = insert.run(
          value.id,
          value.observedAt,
          value.monotonicNs ?? null,
          value.captureSessionId ?? null,
          value.source,
          value.action,
          value.app.bundleId,
          value.app.name ?? null,
          value.app.pid ?? null,
          value.window?.title ?? null,
          value.target?.role ?? null,
          value.target?.subrole ?? null,
          value.target?.label ?? null,
          value.target?.identifier ?? null,
          value.content ?? null,
          value.contentPolicy,
          insertedAtMs,
        );
        if (result.changes === 1) accepted += 1;
        else duplicates += 1;
      }
      return { accepted, duplicates, rejected, reasons };
    });
  }

  insertBatch(
    events: readonly ActivityEvent[],
    insertedAtMs: number = Date.now(),
  ): InsertBatchResult {
    if (events.length === 0) return { accepted: 0, duplicates: 0, rejected: 0, reasons: {} };
    return this.insertBatchTx(events, insertedAtMs);
  }

  /**
   * Watermark bookkeeping; returns the number of rows actually marked.
   * Ids are chunked to stay under SQLite's bound-parameter limit.
   */
  markProcessed(ids: readonly string[], processedAtMs: number): number {
    let changed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      let stmt = this.markProcessedStmts.get(chunk.length);
      if (stmt === undefined) {
        const placeholders = chunk.map(() => '?').join(', ');
        stmt = this.db.prepare(
          `UPDATE raw_events SET processed_at_ms = ? WHERE id IN (${placeholders}) AND processed_at_ms IS NULL`,
        );
        this.markProcessedStmts.set(chunk.length, stmt);
      }
      changed += stmt.run(processedAtMs, ...chunk).changes;
    }
    return changed;
  }

  /**
   * Unprocessed events older than the watermark cutoff, ordered exactly as the
   * segmenter consumes them: observed_at_ms ASC, monotonic_ns ASC, id ASC
   * (contracts §Concurrency). Out-of-order arrival is fine — SQL sorts.
   *
   * Self-healing against poison rows: a single row failing wire
   * re-validation would otherwise head-of-line block the whole page forever
   * (the row stays unprocessed, canonical ORDER BY returns the same page on
   * every sweep, and segmentation stalls). On a batch-map failure we re-run
   * row-by-row: good rows are delivered, each failing row is quarantined by
   * marking it processed (retention then ages it out normally) and reported
   * via `onQuarantine` for logging.
   */
  fetchUnprocessed(
    olderThanWatermarkMs: number,
    limit: number,
    onQuarantine?: (id: string, errorMessage: string) => void,
  ): ActivityEvent[] {
    const rows = this.fetchUnprocessedStmt.all(olderThanWatermarkMs, limit) as RawEventRow[];
    try {
      return rows.map(toWireEvent);
    } catch {
      const good: ActivityEvent[] = [];
      for (const row of rows) {
        try {
          good.push(toWireEvent(row));
        } catch (err) {
          this.markProcessed([row.id], Date.now());
          onQuarantine?.(row.id, err instanceof Error ? err.message : String(err));
        }
      }
      return good;
    }
  }

  /** raw_events retention (48h); returns deleted row count. */
  purgeOlderThan(cutoffMs: number): number {
    return this.purgeOlderThanStmt.run(cutoffMs).changes;
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }
}

function toWireEvent(row: RawEventRow): ActivityEvent {
  const event = {
    id: row.id,
    observedAt: row.observed_at_ms,
    source: row.source,
    action: row.action,
    app: {
      bundleId: row.app_bundle_id,
      ...(row.app_name !== null ? { name: row.app_name } : {}),
      ...(row.pid !== null ? { pid: row.pid } : {}),
    },
    contentPolicy: row.content_policy,
    ...(row.monotonic_ns !== null ? { monotonicNs: row.monotonic_ns } : {}),
    ...(row.capture_session_id !== null ? { captureSessionId: row.capture_session_id } : {}),
    ...(row.window_title !== null ? { window: { title: row.window_title } } : {}),
    ...((row.target_role ?? row.target_subrole ?? row.target_label ?? row.target_identifier) !==
    null
      ? {
          target: {
            ...(row.target_role !== null ? { role: row.target_role } : {}),
            ...(row.target_subrole !== null ? { subrole: row.target_subrole } : {}),
            ...(row.target_label !== null ? { label: row.target_label } : {}),
            ...(row.target_identifier !== null ? { identifier: row.target_identifier } : {}),
          },
        }
      : {}),
    content: row.content,
  };
  // Rows come from SQLite, outside the compiler's reach: re-validate at the
  // boundary so the returned value is a proven ActivityEvent, not a cast.
  if (!isFrame(ActivityEventSchema, event)) {
    throw new TypeError(`raw_events row ${row.id} failed wire re-validation`);
  }
  return event;
}
