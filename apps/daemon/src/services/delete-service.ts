import type { Db } from '../db/database.js';
import type { WorkflowsRepository } from '../db/workflows-repository.js';
import type { Logger } from '../logging.js';

/**
 * User-initiated history deletion (spec §3.23, brief-m7 §D7 item 1). ONE
 * transaction per delete executes the pinned cascade order:
 *
 *   1. raw events in range
 *   2. semantic_steps overlapping the range (+ episode_step_links +
 *      semantic_steps_fts mirrors by rowid)
 *   3. episodes overlapping the range (+ episodes_fts mirrors by rowid)
 *   4. memory_evidence pointing at deleted episodes; surviving candidates
 *      get their denormalized evidence_count recomputed in the same
 *      transaction (mirrors MemoriesRepository.upsertCandidate)
 *   5. INVALIDATED memories: rows that lost their LAST evidence above and
 *      carry no manual confirmation are hard-deleted (+ memories_fts by
 *      rowid). manual_confirmed rows survive EVERY range including 'all'
 *      (contracts §memory.action semantics — recorded interpretation).
 *   6. workflow_occurrences for deleted episodes
 *   7. workflows dropping below candidate thresholds (<3 occurrences OR
 *      single UTC day) auto-purge — ONLY status='candidate'; confirmed/
 *      rejected rows are never rewritten, their stale denormalized counts
 *      stay frozen (contracts §M6→M7 inherit decisions)
 *
 * All FTS index updates happen inside the same transaction; no SQL triggers
 * exist (spec §3.10). The caller (ipc/delete-ops) fires the three *_changed
 * events exactly once AFTER this transaction committed.
 *
 * Presets resolve against the injected clock; «today» uses UTC calendar-day
 * boundaries (midnight UTC → now), matching the uniform UTC-day rule pinned
 * in contracts. Bounds are inclusive on both ends; 'all' is unbounded.
 * A second identical call finds nothing and answers zero stats instead of
 * failing (idempotent double-delete).
 */

export type DeletePreset = 'last_10_minutes' | 'last_hour' | 'today' | 'all';

export interface DeleteRangeInput {
  from?: number;
  to?: number;
  preset?: DeletePreset;
}

export interface DeleteStats {
  rawEvents: number;
  steps: number;
  episodes: number;
  memories: number;
  workflows: number;
}

/** Fixed-length presets; 'today' derives from the clock, 'all' is unbounded. */
export const PRESET_DURATION_MS: Record<'last_10_minutes' | 'last_hour', number> = {
  last_10_minutes: 10 * 60_000,
  last_hour: 60 * 60_000,
};

export interface DeleteServiceOptions {
  db: Db;
  /** Candidate-threshold purge runs inside the same outer transaction. */
  workflows: Pick<WorkflowsRepository, 'purgeCandidatesBelowThreshold'>;
  logger: Logger;
  now?: () => number;
}

interface ResolvedRange {
  fromMs: number | null;
  toMs: number | null;
}

/**
 * WHERE fragment selecting rows whose [start, COALESCE(end,start)] interval
 * overlaps the inclusive window; '' means unbounded ('all').
 */
function overlapWhere(startColumn: string, endColumn: string, range: ResolvedRange): string {
  const endExpr = `COALESCE(${endColumn}, ${startColumn})`;
  const clauses: string[] = [];
  if (range.fromMs !== null) clauses.push(`${endExpr} >= ${range.fromMs}`);
  if (range.toMs !== null) clauses.push(`${startColumn} <= ${range.toMs}`);
  return clauses.join(' AND ');
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class DeleteService {
  private readonly db: Db;
  private readonly workflows: DeleteServiceOptions['workflows'];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: DeleteServiceOptions) {
    this.db = options.db;
    this.workflows = options.workflows;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** Resolves {from,to}|preset into an inclusive window; 'all' is unbounded. */
  resolveRange(input: DeleteRangeInput): ResolvedRange {
    if (input.preset !== undefined) {
      const nowMs = this.now();
      if (input.preset === 'all') return { fromMs: null, toMs: null };
      if (input.preset === 'today') {
        // UTC calendar-day boundary (contracts pin uniform UTC days).
        return { fromMs: new Date(nowMs).setUTCHours(0, 0, 0, 0), toMs: nowMs };
      }
      return { fromMs: nowMs - PRESET_DURATION_MS[input.preset], toMs: nowMs };
    }
    return { fromMs: input.from ?? null, toMs: input.to ?? null };
  }

  deleteRange(input: DeleteRangeInput): DeleteStats {
    const range = this.resolveRange(input);
    const run = this.db.transaction((): DeleteStats => {
      // 1. Raw events in range.
      const rawEvents = this.deleteInWindow('raw_events', 'observed_at_ms', range);

      // 2. Semantic steps overlapping the range (+links +FTS mirrors).
      const steps = this.deleteSteps(range);

      // Episodes overlapping the range. Evidence/occurrence/link rows must
      // leave BEFORE the episode rows themselves (the FKs have no ON DELETE
      // cascade by design — no triggers, no implicit deletes).
      const episodeVictims = this.selectInWindow(
        'episodes',
        'started_at_ms',
        'ended_at_ms',
        range,
      ) as Array<{ id: string; rowid: number }>;
      let memories = 0;
      for (const chunk of chunks(episodeVictims.map((e) => e.id), 500)) {
        const placeholders = chunk.map(() => '?').join(', ');

        // 4. Evidence for deleted episodes; remember whose evidence vanished.
        const affectedMemories = (
          this.db
            .prepare(
              `SELECT DISTINCT memory_id AS id FROM memory_evidence
               WHERE episode_id IN (${placeholders})`,
            )
            .all(...chunk) as Array<{ id: string }>
        ).map((r) => r.id);
        this.db
          .prepare(`DELETE FROM memory_evidence WHERE episode_id IN (${placeholders})`)
          .run(...chunk);

        // 5. Invalidated memories: affected rows with no evidence left and no
        // manual confirmation die here — including under the 'all' preset.
        memories += this.hardDeleteInvalidatedMemories(affectedMemories);

        // Survivors keep their denormalized count truthful: recompute
        // evidence_count exactly like MemoriesRepository.upsertCandidate.
        for (const idChunk of chunks(affectedMemories, 500)) {
          const idPlaceholders = idChunk.map(() => '?').join(', ');
          this.db
            .prepare(
              `UPDATE memory_candidates
               SET evidence_count = (
                 SELECT COUNT(*) FROM memory_evidence WHERE memory_id = memory_candidates.id
               )
               WHERE id IN (${idPlaceholders})`,
            )
            .run(...idChunk);
        }

        // 6. Occurrences for deleted episodes.
        this.db
          .prepare(`DELETE FROM workflow_occurrences WHERE episode_id IN (${placeholders})`)
          .run(...chunk);

        // Links into the dying episode (the far-side step may survive).
        this.db
          .prepare(`DELETE FROM episode_step_links WHERE episode_id IN (${placeholders})`)
          .run(...chunk);
      }

      // 3. The episode rows themselves + FTS mirrors (rowid convention).
      for (const chunk of chunks(episodeVictims.map((e) => String(e.rowid)), 500)) {
        this.db.prepare(`DELETE FROM episodes_fts WHERE rowid IN (${chunk.join(', ')})`).run();
      }
      for (const chunk of chunks(episodeVictims.map((e) => e.id), 500)) {
        const placeholders = chunk.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM episodes WHERE id IN (${placeholders})`).run(...chunk);
      }

      // 7. Workflows below candidate thresholds — candidates only, inside
      // this same transaction (better-sqlite3 nests via savepoints).
      const workflows = this.workflows.purgeCandidatesBelowThreshold();

      return { rawEvents, steps, episodes: episodeVictims.length, memories, workflows };
    });

    const stats = run();
    this.logger.log('info', 'delete', 'delete.range committed', { ...stats });
    return stats;
  }

  /** Unconditional-count delete of one table over the resolved window. */
  private deleteInWindow(table: string, timeColumn: string, range: ResolvedRange): number {
    const where = overlapWhere(timeColumn, timeColumn, range);
    const sql = where === '' ? `DELETE FROM ${table}` : `DELETE FROM ${table} WHERE ${where}`;
    return this.db.prepare(sql).run().changes;
  }

  private selectInWindow(
    table: string,
    startColumn: string,
    endColumn: string,
    range: ResolvedRange,
  ): unknown[] {
    const where = overlapWhere(startColumn, endColumn, range);
    const sql =
      where === ''
        ? `SELECT id, rowid FROM ${table}`
        : `SELECT id, rowid FROM ${table} WHERE ${where}`;
    return this.db.prepare(sql).all();
  }

  /** Steps overlapping the window lose their links and FTS rows first. */
  private deleteSteps(range: ResolvedRange): number {
    const where = overlapWhere('started_at_ms', 'ended_at_ms', range);
    const selectSql =
      where === ''
        ? 'SELECT id, rowid FROM semantic_steps'
        : `SELECT id, rowid FROM semantic_steps WHERE ${where}`;
    const victims = this.db.prepare(selectSql).all() as Array<{ id: string; rowid: number }>;
    for (const chunk of chunks(victims.map((v) => v.id), 500)) {
      const placeholders = chunk.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM episode_step_links WHERE semantic_step_id IN (${placeholders})`)
        .run(...chunk);
    }
    for (const chunk of chunks(victims.map((v) => String(v.rowid)), 500)) {
      this.db.prepare(`DELETE FROM semantic_steps_fts WHERE rowid IN (${chunk.join(', ')})`).run();
    }
    for (const chunk of chunks(victims.map((v) => v.id), 500)) {
      const placeholders = chunk.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM semantic_steps WHERE id IN (${placeholders})`).run(...chunk);
    }
    return victims.length;
  }

  /**
   * Hard-deletes non-manual zero-evidence memories among the given ids,
   * mirroring the memories_fts rowid convention used by MemoriesRepository
   * (rowid = memory_candidates.rowid; no content matching, no triggers).
   * Victims are decided BEFORE any FTS deletion so a row with surviving
   * evidence keeps its search mirror intact.
   */
  private hardDeleteInvalidatedMemories(ids: readonly string[]): number {
    let deleted = 0;
    for (const chunk of chunks(ids, 500)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const victimRowids = (
        this.db
          .prepare(
            `SELECT rowid FROM memory_candidates
             WHERE id IN (${placeholders})
               AND manual_confirmed_at_ms IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM memory_evidence WHERE memory_id = memory_candidates.id
               )`,
          )
          .all(...chunk) as Array<{ rowid: number }>
      ).map((r) => String(r.rowid));
      if (victimRowids.length === 0) continue;
      this.db
        .prepare(`DELETE FROM memories_fts WHERE rowid IN (${victimRowids.join(', ')})`)
        .run();
      for (const subChunk of chunks(victimRowids, 500)) {
        const idPlaceholders = subChunk.map(() => '?').join(', ');
        deleted += this.db
          .prepare(`DELETE FROM memory_candidates WHERE rowid IN (${idPlaceholders})`)
          .run(...subChunk).changes;
      }
    }
    return deleted;
  }
}
