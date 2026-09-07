import { ulid } from 'ulid';

import type Database from 'better-sqlite3';
import type { SemanticStepDto } from '@computer-history/protocol';

import type { Db } from './database.js';
import type { CoalescedStep, StepAction } from '../processing/event-coalescer.js';

export type SegmentState = 'open' | 'finalized' | 'failed';

export interface SegmentRow {
  id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  state: SegmentState;
  first_event_id: string | null;
  last_event_id: string | null;
  event_count: number;
  summarize_job_id: string | null;
  created_at_ms: number;
}

/**
 * FTS mirror columns for one step. Repository methods maintain
 * semantic_steps_fts in the same transaction as semantic_steps — never SQL
 * triggers (spec §3.10).
 */
export interface StepFtsFields {
  text: string | null;
  target: string | null;
  appName: string | null;
}

/** Wire-shaped segment with its ordered steps and denormalized stepCount. */
export interface SegmentWithSteps {
  id: string;
  startedAtMs: number;
  endedAtMs: number | null;
  state: SegmentState;
  stepCount: number;
  steps: SemanticStepDto[];
}

export interface PurgeStepsResult {
  deletedSteps: number;
  /** Segments that lost at least one step (spec §3.22 deletion order). */
  affectedSegmentIds: string[];
}

interface SemanticStepRow {
  id: string;
  segment_id: string;
  ordinal: number;
  started_at_ms: number;
  ended_at_ms: number | null;
  action: StepAction;
  app_bundle_id: string;
  app_name: string | null;
  target: string | null;
  target_role: string | null;
  text: string | null;
}

function toStepDto(row: SemanticStepRow): SemanticStepDto {
  return {
    id: row.id,
    segmentId: row.segment_id,
    ordinal: row.ordinal,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms ?? row.started_at_ms,
    action: row.action,
    appBundleId: row.app_bundle_id,
    appName: row.app_name,
    target: row.target,
    targetRole: row.target_role,
    text: row.text,
  };
}

/**
 * activity_segments + semantic_steps persistence (brief-m2 §D2 item 2).
 *
 * FTS rowid convention: semantic_steps_fts rows are inserted with
 * rowid = semantic_steps.rowid, so purges remove both sides in one transaction
 * without triggers or contentless-table bookkeeping. episode_step_links rows of
 * purged steps are deleted explicitly inside the same transaction — the schema
 * FK has no ON DELETE clause, so this implements the documented "steps deleted
 * ⇒ links cascade" behavior (spec §3.22, brief-m2 §D2 item 2). In V1 no
 * episodes exist yet, so this path is defensive.
 */
export class SegmentsRepository {
  private readonly insertStepStmt: Database.Statement;
  private readonly insertFtsStepStmt: Database.Statement;
  private readonly appendStepTx: (
    id: string,
    segmentId: string,
    step: CoalescedStep,
    fts: StepFtsFields,
    createdAtMs: number,
  ) => void;
  private readonly createOpenStmt: Database.Statement;
  private readonly getOpenSegmentStmt: Database.Statement;
  private readonly getSegmentStmt: Database.Statement;
  private readonly tallyEventsStmt: Database.Statement;
  private readonly finalizeStmt: Database.Statement;
  private readonly setSummarizeJobIdStmt: Database.Statement;
  private readonly getStepsStmt: Database.Statement;
  private readonly getStepsRangeStmt: Database.Statement;
  private readonly stepCountStmt: Database.Statement;
  private readonly lastStepActivityMsStmt: Database.Statement;
  private readonly segmentPageStmts = new Map<string, Database.Statement>();
  /** getSegments steps query per IN-clause arity (page size bounded ≤ limit). */
  private readonly segmentStepsStmts = new Map<number, Database.Statement>();

  constructor(private readonly db: Db) {
    this.insertStepStmt = db.prepare(
      `INSERT INTO semantic_steps (
        id, segment_id, ordinal, started_at_ms, ended_at_ms,
        action, app_bundle_id, app_name, target, target_role, text,
        first_event_id, last_event_id, created_at_ms
      ) VALUES (?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM semantic_steps WHERE segment_id = ?),
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // FTS rowid mirrors semantic_steps.rowid (see class doc).
    this.insertFtsStepStmt = db.prepare(
      'INSERT INTO semantic_steps_fts (rowid, text, target, app_name) VALUES (?, ?, ?, ?)',
    );
    // Built once here: creating the transaction wrapper per appendStep call
    // re-generated a closure over fresh statement handles every step.
    this.appendStepTx = db.transaction(
      (
        id: string,
        segmentId: string,
        step: CoalescedStep,
        fts: StepFtsFields,
        createdAtMs: number,
      ) => {
        const result = this.insertStepStmt.run(
          id,
          segmentId,
          segmentId,
          step.startedAtMs,
          step.endedAtMs,
          step.action,
          step.appBundleId,
          step.appName,
          step.target,
          step.targetRole,
          step.text,
          step.firstEventId,
          step.lastEventId,
          createdAtMs,
        );
        this.insertFtsStepStmt.run(result.lastInsertRowid, fts.text, fts.target, fts.appName);
      },
    );
    this.createOpenStmt = db.prepare(
      `INSERT INTO activity_segments (id, started_at_ms, state, first_event_id, last_event_id, event_count, created_at_ms)
       VALUES (?, ?, 'open', ?, NULL, 0, ?)`,
    );
    this.getOpenSegmentStmt = db.prepare(
      "SELECT * FROM activity_segments WHERE state = 'open' ORDER BY started_at_ms DESC LIMIT 1",
    );
    this.getSegmentStmt = db.prepare('SELECT * FROM activity_segments WHERE id = ?');
    this.tallyEventsStmt = db.prepare(
      `UPDATE activity_segments SET
         event_count = event_count + ?,
         last_event_id = COALESCE(?, last_event_id)
       WHERE id = ?`,
    );
    this.finalizeStmt = db.prepare(
      `UPDATE activity_segments SET
         state = ?,
         ended_at_ms = ?,
         last_event_id = COALESCE(?, last_event_id),
         event_count = event_count + ?
      WHERE id = ? AND state = 'open'`,
    );
    this.setSummarizeJobIdStmt = db.prepare(
      'UPDATE activity_segments SET summarize_job_id = ? WHERE id = ? AND summarize_job_id IS NULL',
    );
    this.getStepsStmt = db.prepare(
      `SELECT id, segment_id, ordinal, started_at_ms, ended_at_ms,
              action, app_bundle_id, app_name, target, target_role, text
       FROM semantic_steps
       WHERE segment_id = ?
       ORDER BY ordinal ASC`,
    );
    this.getStepsRangeStmt = db.prepare(
      `SELECT id, segment_id, ordinal, started_at_ms, ended_at_ms,
              action, app_bundle_id, app_name, target, target_role, text
       FROM semantic_steps
       WHERE segment_id = ? AND ordinal > ?
       ORDER BY ordinal ASC
       LIMIT ?`,
    );
    this.stepCountStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM semantic_steps WHERE segment_id = ?',
    );
    this.lastStepActivityMsStmt = db.prepare(
      'SELECT MAX(COALESCE(ended_at_ms, started_at_ms)) AS m FROM semantic_steps WHERE segment_id = ?',
    );
  }

  createOpen(
    startedAtMs: number,
    firstEventId: string,
    createdAtMs: number = Date.now(),
  ): SegmentRow {
    const id = ulid(startedAtMs);
    this.createOpenStmt.run(id, startedAtMs, firstEventId, createdAtMs);
    return {
      id,
      started_at_ms: startedAtMs,
      ended_at_ms: null,
      state: 'open',
      first_event_id: firstEventId,
      last_event_id: null,
      event_count: 0,
      summarize_job_id: null,
      created_at_ms: createdAtMs,
    };
  }

  /** The single globally-open segment, or null (spec §3.13: one open segment). */
  getOpenSegment(): SegmentRow | null {
    const row = this.getOpenSegmentStmt.get() as SegmentRow | undefined;
    return row ?? null;
  }

  getSegment(id: string): SegmentRow | null {
    const row = this.getSegmentStmt.get(id) as SegmentRow | undefined;
    return row ?? null;
  }

  /**
   * Transactional append of one coalesced step plus its FTS mirror row.
   * Ordinal is derived inside the transaction (per-segment max + 1), so steps
   * stay contiguous even when several are appended back-to-back.
   */
  appendStep(
    segmentId: string,
    step: CoalescedStep,
    fts: StepFtsFields,
    createdAtMs: number = Date.now(),
  ): string {
    const id = ulid(step.startedAtMs);
    this.appendStepTx(id, segmentId, step, fts, createdAtMs);
    return id;
  }

  /** Fold raw-event accounting into the segment (last_event_id + event_count). */
  tallyEvents(segmentId: string, eventCountDelta: number, lastEventId: string | null): void {
    if (eventCountDelta <= 0 && lastEventId === null) return;
    this.tallyEventsStmt.run(eventCountDelta, lastEventId, segmentId);
  }

  finalize(
    segmentId: string,
    state: Extract<SegmentState, 'finalized' | 'failed'>,
    endedAtMs: number,
    counts: { lastEventId?: string; eventCountDelta?: number },
  ): void {
    this.finalizeStmt.run(
      state,
      endedAtMs,
      counts.lastEventId ?? null,
      counts.eventCountDelta ?? 0,
      segmentId,
    );
  }

  /** Idempotent dedupe guard: only the first caller wins (brief-m2 §D2 item 4). */
  setSummarizeJobId(segmentId: string, jobId: string): boolean {
    return this.setSummarizeJobIdStmt.run(jobId, segmentId).changes === 1;
  }

  getSegments(range: { from?: number; to?: number }, limit: number): SegmentWithSteps[] {
    const conditions: string[] = [];
    const params: number[] = [];
    if (range.from !== undefined) {
      conditions.push('started_at_ms >= ?');
      params.push(range.from);
    }
    if (range.to !== undefined) {
      conditions.push('started_at_ms <= ?');
      params.push(range.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const pageKey = conditions.length > 0 ? conditions.join('&') : '';
    let pageStmt = this.segmentPageStmts.get(pageKey);
    if (pageStmt === undefined) {
      pageStmt = this.db.prepare(
        `SELECT * FROM activity_segments ${where} ORDER BY started_at_ms DESC LIMIT ?`,
      );
      this.segmentPageStmts.set(pageKey, pageStmt);
    }
    const segments = pageStmt.all(...params, limit) as SegmentRow[];

    if (segments.length === 0) return [];
    const ids = segments.map((s) => s.id);
    let stepsStmt = this.segmentStepsStmts.get(ids.length);
    if (stepsStmt === undefined) {
      const placeholders = ids.map(() => '?').join(', ');
      stepsStmt = this.db.prepare(
        `SELECT id, segment_id, ordinal, started_at_ms, ended_at_ms,
                action, app_bundle_id, app_name, target, target_role, text
         FROM semantic_steps
         WHERE segment_id IN (${placeholders})
         ORDER BY segment_id ASC, ordinal ASC`,
      );
      this.segmentStepsStmts.set(ids.length, stepsStmt);
    }
    const stepRows = stepsStmt.all(...ids) as SemanticStepRow[];
    const bySegment = new Map<string, SemanticStepDto[]>();
    for (const row of stepRows) {
      const list = bySegment.get(row.segment_id);
      if (list === undefined) bySegment.set(row.segment_id, [toStepDto(row)]);
      else list.push(toStepDto(row));
    }
    return segments.map((segment) => {
      const steps = bySegment.get(segment.id) ?? [];
      return {
        id: segment.id,
        startedAtMs: segment.started_at_ms,
        endedAtMs: segment.ended_at_ms,
        state: segment.state,
        stepCount: steps.length,
        steps,
      };
    });
  }

  /** Ordered steps of one segment (summarizer input, brief-m3 §D3 item 5). */
  getSteps(segmentId: string): SemanticStepDto[] {
    const rows = this.getStepsStmt.all(segmentId) as SemanticStepRow[];
    return rows.map(toStepDto);
  }

  /**
   * Bounded window of steps past an ordinal bound (summarizer suffix
   * chaining). `afterOffset` is an ORDINAL bound, not an array index:
   * ordinals are 1-based per segment but NOT necessarily contiguous, because
   * retention purges (purgeStepsOlderThan) delete arbitrary time-cutoff
   * steps and leave gaps. Callers therefore chain on the LAST COVERED ROW's
   * actual ordinal; `ordinal > afterOffset` returns exactly the unsummarized
   * suffix under any gap pattern. Backed by
   * idx_semantic_steps_segment(segment_id, ordinal): index seek plus a scan
   * bounded by LIMIT, instead of loading every step of the segment.
   */
  getStepsRange(segmentId: string, afterOffset: number, limit: number): SemanticStepDto[] {
    const rows = this.getStepsRangeStmt.all(segmentId, afterOffset, limit) as SemanticStepRow[];
    return rows.map(toStepDto);
  }

  stepCount(segmentId: string): number {
    return (this.stepCountStmt.get(segmentId) as { n: number }).n;
  }

  /** Latest step activity timestamp within a segment, or null when it has no steps. */
  lastStepActivityMs(segmentId: string): number | null {
    const row = this.lastStepActivityMsStmt.get(segmentId) as { m: number | null };
    return row.m;
  }

  /**
   * semantic_steps retention (30 days default, spec §3.22): delete steps older
   * than the cutoff regardless of episode linkage (V1 policy — episodes keep
   * their summaries), removing FTS rows and episode_step_links in the same
   * transaction.
   */
  purgeStepsOlderThan(cutoffMs: number): PurgeStepsResult {
    // Sargable OR-form: COALESCE(ended_at_ms, started_at_ms) < ? is an
    // expression no index serves — every purge full-scanned semantic_steps
    // (linear in retained history). The multi-index OR pairs branch 1 with
    // idx_semantic_steps_ended (migration 009) and branch 2 with
    // idx_semantic_steps_started (migration 008). Victims are selected in
    // bounded pages inside the transaction instead of materializing the full
    // victim set up front.
    const selectVictims = this.db.prepare(
      `SELECT id, segment_id, rowid FROM semantic_steps
       WHERE (ended_at_ms IS NOT NULL AND ended_at_ms < ?)
          OR (ended_at_ms IS NULL AND started_at_ms < ?)
       LIMIT 500`,
    );
    const run = this.db.transaction(() => {
      let deletedSteps = 0;
      const affected = new Set<string>();
      for (;;) {
        const chunk = selectVictims.all(cutoffMs, cutoffMs) as {
          id: string;
          segment_id: string;
          rowid: number;
        }[];
        if (chunk.length === 0) break;
        const idPlaceholders = chunk.map(() => '?').join(', ');
        const rowidPlaceholders = chunk.map(() => '?').join(', ');
        this.db
          .prepare(`DELETE FROM episode_step_links WHERE semantic_step_id IN (${idPlaceholders})`)
          .run(...chunk.map((v) => v.id));
        this.db
          .prepare(`DELETE FROM semantic_steps_fts WHERE rowid IN (${rowidPlaceholders})`)
          .run(...chunk.map((v) => v.rowid));
        this.db
          .prepare(`DELETE FROM semantic_steps WHERE id IN (${idPlaceholders})`)
          .run(...chunk.map((v) => v.id));
        deletedSteps += chunk.length;
        for (const v of chunk) affected.add(v.segment_id);
      }
      return { deletedSteps, affectedSegmentIds: [...affected] };
    });
    return run();
  }
}
