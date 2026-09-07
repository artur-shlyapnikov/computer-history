import { ulid } from 'ulid';

import type { WorkflowDto, WorkflowListItem, WorkflowStatus } from '@computer-history/protocol';

import { median } from '../processing/workflow-fingerprint.js';
import { replaceWellFormedTarget } from '../util/text.js';

import type { Db } from './database.js';

/**
 * workflows + workflow_occurrences persistence (spec §3.9). READ side arrived
 * with M4 (brief-m4 §D4 item 2); M6 adds the miner's WRITE side (brief-m6
 * §D6 item 2): atomic candidate insertion, confirm/reject transitions,
 * occurrence recording with running median, and the candidate-only purge used
 * by delete cascades (confirmed/rejected rows persist per contracts).
 *
 * DOCUMENTED DEVIATION (accepted): workflow_search uses case-insensitive LIKE
 * over name/purpose instead of an FTS table — the schema has NO workflows_fts
 * (spec §3.10 pins exactly three FTS tables), and V1 template JSON is opaque,
 * so a trigram/prefix index would add schema surface without a consumer.
 */

const WORKFLOW_STATUSES: readonly string[] = ['candidate', 'confirmed', 'rejected'];

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/**
 * PERF-06: workflows.list ships at most this many ledger rows per workflow.
 * Confirmed workflows persist across years, so workflow_occurrences grows
 * unboundedly and the full ledger once serialized megabytes per refresh.
 * A newest-N window stays contract-compatible (the wire pins newest-first
 * ordering, not completeness) and WorkflowDto.occurrenceCount still carries
 * the true total for display.
 */
const LEDGER_VIEW_CAP = 50;

/**
 * Round-33 audit: listByStatus interpolates the workflow ids into one
 * IN(...) per batch. Past SQLite's host-parameter ceiling the prepared
 * statement throws SQLITE_RANGE and workflows.list breaks wholesale. The
 * bundled SQLite in better-sqlite3 on Node 24 is >= 3.32, where
 * SQLITE_MAX_VARIABLE_NUMBER defaults to 32766, so 500 is chosen purely
 * defensively: the bound parameters per statement (at most LEDGER_CHUNK_SIZE
 * ids plus one row-number-window parameter = 501) stay under both the legacy
 * 999 default and the modern 32766 one.
 */
const LEDGER_CHUNK_SIZE = 500;

/**
 * Candidate thresholds (spec §3.20: ≥3 occurrences across ≥2 distinct UTC
 * days). Mirrors MIN_OCCURRENCES / MIN_DISTINCT_DAYS in workflow-miner.ts;
 * duplicated here because the delete cascade (db layer) must not import the
 * miner (processing layer).
 */
const CANDIDATE_MIN_OCCURRENCES = 3;
const CANDIDATE_MIN_DISTINCT_DAYS = 2;

interface WorkflowSqlRow {
  id: string;
  name: string;
  purpose: string | null;
  status: string;
  template_json: string;
  occurrence_count: number;
  median_similarity: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WorkflowListFilters {
  status?: WorkflowStatus;
}

export interface WorkflowSearchFilters {
  query?: string;
  status?: WorkflowStatus;
  limit?: number;
}

/** Miner write-path input for {@link WorkflowsRepository.insertWorkflow}. */
export interface NewWorkflowInput {
  name: string;
  purpose: string | null;
  template: unknown;
  occurrences: ReadonlyArray<{ episodeId: string; similarity: number }>;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

/**
 * Read-side remediation (issue RA8-W2-READ): rows persisted before the
 * round-7 write-path fix store literal \uDXXX escape sequences in
 * template_json/name/purpose; JSON.parse resurrects those lone surrogates in
 * DTOs and response serialization re-emits them, so Swift's JSONDecoder
 * rejects the whole workflows.list/search frame. Walk every string value and
 * replace lone surrogates with U+FFFD; valid surrogate pairs (astral emoji)
 * survive byte-for-byte, and clean inputs keep their original reference.
 */
function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return replaceWellFormedTarget(value) as T;
  if (Array.isArray(value)) {
    const arr: unknown[] = value;
    let out: unknown[] | undefined;
    for (let i = 0; i < arr.length; i += 1) {
      const sanitized = sanitizeDeep(arr[i]);
      if (sanitized !== arr[i]) out ??= arr.slice();
      if (out) out[i] = sanitized;
    }
    return (out ?? arr) as T;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const key of Object.keys(obj)) {
      const sanitized = sanitizeDeep(obj[key]);
      if (sanitized !== obj[key]) out ??= { ...obj };
      if (out) out[key] = sanitized;
    }
    return (out ?? obj) as T;
  }
  return value;
}

function toDto(row: WorkflowSqlRow): WorkflowDto {
  let template: unknown;
  try {
    template = JSON.parse(row.template_json);
  } catch {
    template = {};
  }
  return {
    id: row.id,
    name: replaceWellFormedTarget(row.name),
    purpose: row.purpose === null ? null : replaceWellFormedTarget(row.purpose),
    status: row.status as WorkflowStatus,
    // Template shape is pinned by protocol; malformed stored JSON degrades to
    // an empty object rather than poisoning search results.
    template: sanitizeDeep(template) as WorkflowDto['template'],
    occurrenceCount: row.occurrence_count,
    medianSimilarity: row.median_similarity,
    firstSeenAtMs: row.first_seen_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** Rows arrive from our own SQLite; enum columns still get a guard. */
function isWorkflowStatus(value: string): value is WorkflowStatus {
  return WORKFLOW_STATUSES.includes(value);
}

export class WorkflowsRepository {
  constructor(private readonly db: Db) {}

  /**
   * All workflows of one status (or every status), newest activity first,
   * each with its occurrence ledger (contracts workflows.list shape:
   * {episodeId, startedAtMs, similarity}, newest episode first; a purged
   * episode degrades to startedAtMs 0 rather than dropping the row).
   */
  listByStatus(filters: WorkflowListFilters = {}): WorkflowListItem[] {
    const where = filters.status !== undefined ? 'WHERE status = ?' : '';
    const values = filters.status !== undefined ? [filters.status] : [];
    const rows = (
      this.db
        .prepare(`SELECT * FROM workflows ${where} ORDER BY last_seen_at_ms DESC, id ASC`)
        .all(...values) as WorkflowSqlRow[]
    ).filter((r) => isWorkflowStatus(r.status));
    if (rows.length === 0) return [];
    // PERF-04: one batched ledger query instead of one per row. Round-33:
    // the ids are chunked (LEDGER_CHUNK_SIZE per IN(...)) so a large table
    // cannot blow past SQLite's parameter ceiling. SAFE because ROW_NUMBER
    // partitions by workflow_id — each workflow's top-50 window is
    // independent of which other ids share its chunk. The merged rows are
    // re-sorted with the same keys as the per-chunk ORDER BY: concatenating
    // sorted chunks is not globally sorted, and grouping below relies on this
    // order to keep each workflow's per-ledger order.
    const occurrenceRows: Array<
      { workflowId: string } & WorkflowListItem['occurrences'][number]
    > = [];
    for (let start = 0; start < rows.length; start += LEDGER_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + LEDGER_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      occurrenceRows.push(
        ...(
          this.db
            .prepare(
              `SELECT workflowId, episodeId, similarity, startedAtMs
               FROM (
                 SELECT o.workflow_id AS workflowId, o.episode_id AS episodeId, o.similarity,
                        COALESCE(e.started_at_ms, 0) AS startedAtMs,
                        ROW_NUMBER() OVER (
                          PARTITION BY o.workflow_id
                          ORDER BY COALESCE(e.started_at_ms, 0) DESC, o.episode_id ASC
                        ) AS rn
                 FROM workflow_occurrences o
                 LEFT JOIN episodes e ON e.id = o.episode_id
                 WHERE o.workflow_id IN (${placeholders})
               )
               WHERE rn <= ?
               ORDER BY startedAtMs DESC, episodeId ASC`,
            )
            .all(...chunk.map((r) => r.id), LEDGER_VIEW_CAP) as Array<
            { workflowId: string } & WorkflowListItem['occurrences'][number]
          >
        ),
      );
    }
    occurrenceRows.sort(
      (a, b) =>
        b.startedAtMs - a.startedAtMs ||
        (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0),
    );
    const occurrencesByWorkflow = new Map<string, WorkflowListItem['occurrences']>();
    for (const occ of occurrenceRows) {
      let list = occurrencesByWorkflow.get(occ.workflowId);
      if (list === undefined) {
        list = [];
        occurrencesByWorkflow.set(occ.workflowId, list);
      }
      list.push({
        episodeId: occ.episodeId,
        similarity: occ.similarity,
        startedAtMs: occ.startedAtMs,
      });
    }
    return rows.map((row) => ({
      ...toDto(row),
      occurrences: occurrencesByWorkflow.get(row.id) ?? [],
    }));
  }

  /**
   * Overlap-suppression input for the miner (PERF-05): only workflows sharing
   * at least one cluster episode id can suppress or absorb, so one
   * IN-filtered scan returns (workflow_id → cluster ids already in its
   * ledger), (workflow_id → status), and (workflow_id → last_seen_at_ms)
   * for exactly those workflows. Cost is
   * proportional to the cluster (≤ pool cap 200 ids), not to history size —
   * the previous full statusMap + occurrenceEpisodeIds materialized the whole
   * workflows table and the whole occurrences ledger once per mining job.
   */
  suppressionInputs(episodeIds: ReadonlyArray<string>): {
    ledger: Map<string, Set<string>>;
    status: Map<string, WorkflowStatus>;
    lastSeen: Map<string, number>;
  } {
    const placeholders = episodeIds.map(() => '?').join(', ');
    const ledger = new Map<string, Set<string>>();
    for (const row of this.db
      .prepare(
        `SELECT workflow_id, episode_id FROM workflow_occurrences
         WHERE episode_id IN (${placeholders})`,
      )
      .all(...episodeIds) as Array<{ workflow_id: string; episode_id: string }>) {
      let ids = ledger.get(row.workflow_id);
      if (ids === undefined) {
        ids = new Set();
        ledger.set(row.workflow_id, ids);
      }
      ids.add(row.episode_id);
    }
    const status = new Map<string, WorkflowStatus>();
    const lastSeen = new Map<string, number>();
    const workflowIds = [...ledger.keys()];
    if (workflowIds.length > 0) {
      const workflowPlaceholders = workflowIds.map(() => '?').join(', ');
      for (const row of this.db
        .prepare(
          `SELECT id, status, last_seen_at_ms FROM workflows WHERE id IN (${workflowPlaceholders})`,
        )
        .all(...workflowIds) as Array<{ id: string; status: string; last_seen_at_ms: number }>) {
        if (isWorkflowStatus(row.status)) status.set(row.id, row.status);
        lastSeen.set(row.id, row.last_seen_at_ms);
      }
    }
    return { ledger, status, lastSeen };
  }

  /** Occurrence ledger of one workflow, newest episode first. */
  listOccurrences(workflowId: string): WorkflowListItem['occurrences'] {
    return this.db
      .prepare(
        `SELECT o.episode_id AS episodeId, o.similarity,
                COALESCE(e.started_at_ms, 0) AS startedAtMs
         FROM workflow_occurrences o
         LEFT JOIN episodes e ON e.id = o.episode_id
         WHERE o.workflow_id = ?
         ORDER BY COALESCE(e.started_at_ms, 0) DESC, o.episode_id ASC`,
      )
      .all(workflowId) as WorkflowListItem['occurrences'];
  }

  /**
   * Case-insensitive substring match on name OR purpose with optional status
   * filter. LIKE is already ASCII-case-insensitive in SQLite; % and _ in the
   * user query are escaped so they match literally.
   */
  searchWorkflows(filters: WorkflowSearchFilters): WorkflowDto[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.query !== undefined && filters.query.trim().length > 0) {
      const needle = `%${filters.query.trim().replace(/[%_\\]/g, '\\$&')}%`;
      conditions.push("(name LIKE ? ESCAPE '\\' OR purpose LIKE ? ESCAPE '\\')");
      values.push(needle, needle);
    }
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      values.push(filters.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM workflows ${where}
         ORDER BY occurrence_count DESC, last_seen_at_ms DESC
         LIMIT ?`,
      )
      .all(...values, clampLimit(filters.limit)) as WorkflowSqlRow[];
    return rows.filter((r) => isWorkflowStatus(r.status)).map(toDto);
  }

  getById(id: string): WorkflowDto | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      WorkflowSqlRow | undefined;
    return row === undefined ? null : toDto(row);
  }

  /**
   * Miner write path (spec §3.20): the candidate row, its template JSON and
   * ALL occurrence rows commit in ONE transaction — a crash mid-way leaves no
   * template-less workflow behind (brief-m6: "row created only WITH template
   * atomically"). The caller synthesizes the template BEFORE calling this.
   */
  insertWorkflow(input: NewWorkflowInput, now: number): string {
    if (input.occurrences.length === 0) {
      throw new TypeError('workflow candidate requires at least one occurrence');
    }
    const id = ulid(Math.min(now, input.lastSeenAtMs));
    const similarities = input.occurrences.map((o) => o.similarity);
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflows (
             id, name, purpose, status, template_json, occurrence_count,
             median_similarity, first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.purpose,
          // Defense-in-depth (issue W2): the miner sanitizes via
          // validateTemplate, but template_json round-trips \uDXXX escapes of
          // unpaired surrogates through SQLite verbatim — listByStatus would
          // re-parse them and poison workflows.list for Swift. Sanitize every
          // string during encoding; valid surrogate pairs pass untouched.
          JSON.stringify(input.template, (_key, value: unknown) =>
            typeof value === 'string' ? replaceWellFormedTarget(value) : (value as string),
          ),
          input.occurrences.length,
          median(similarities),
          input.firstSeenAtMs,
          input.lastSeenAtMs,
          now,
          now,
        );
      for (const occ of input.occurrences) {
        this.insertOccurrence(id, occ.episodeId, occ.similarity);
      }
    });
    run();
    return id;
  }

  /**
   * workflow.action confirm/reject (contracts): both transitions persist the
   * row; rejected rows additionally suppress future mining over ≥50%-overlapping
   * episode sets (noise control pinned by brief-m6 §D6 item 4).
   */
  updateStatus(
    id: string,
    status: Extract<WorkflowStatus, 'confirmed' | 'rejected'>,
    now: number,
  ): WorkflowDto | null {
    const changes = this.db
      .prepare('UPDATE workflows SET status = ?, updated_at_ms = ? WHERE id = ?')
      .run(status, now, id).changes;
    return changes === 1 ? this.getById(id) : null;
  }

  /**
   * Adds one occurrence idempotently and recomputes occurrence_count /
   * median_similarity / last_seen_at_ms from the durable ledger. Returns true
   * when the (workflow, episode) pair was new.
   */
  recordOccurrence(
    workflowId: string,
    occurrence: { episodeId: string; similarity: number },
    now: number,
  ): boolean {
    const run = this.db.transaction((): boolean => {
      const added = this.insertOccurrence(workflowId, occurrence.episodeId, occurrence.similarity);
      if (!added) return false;
      const rows = this.db
        .prepare('SELECT similarity FROM workflow_occurrences WHERE workflow_id = ?')
        .all(workflowId) as Array<{ similarity: number }>;
      this.db
        .prepare(
          `UPDATE workflows SET
             occurrence_count = ?,
             median_similarity = ?,
             last_seen_at_ms = MAX(last_seen_at_ms, ?),
             updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(rows.length, median(rows.map((r) => r.similarity)), now, now, workflowId);
      return true;
    });
    return run();
  }

  /**
   * Round-32 audit: batch absorb variant of {@link recordOccurrence}. The
   * miner's suppressedByExisting loop used to commit one transaction PER ROW;
   * a crash after the first row committed tripped hasOccurrenceForEpisode
   * (re-delivery latch on the seed) and the remaining episodes of that absorb
   * were never recorded — the ledger permanently under-counted vs the
   * template. All inserts plus ONE counter/median recompute now commit in a
   * single transaction: a crash mid-absorb leaves nothing behind. Returns the
   * number of newly inserted occurrences.
   */
  recordOccurrences(
    workflowId: string,
    occurrences: ReadonlyArray<{ episodeId: string; similarity: number }>,
    now: number,
  ): number {
    if (occurrences.length === 0) return 0;
    const run = this.db.transaction((): number => {
      let added = 0;
      for (const occurrence of occurrences) {
        if (this.insertOccurrence(workflowId, occurrence.episodeId, occurrence.similarity)) {
          added += 1;
        }
      }
      if (added === 0) return 0;
      const rows = this.db
        .prepare('SELECT similarity FROM workflow_occurrences WHERE workflow_id = ?')
        .all(workflowId) as Array<{ similarity: number }>;
      this.db
        .prepare(
          `UPDATE workflows SET
             occurrence_count = ?,
             median_similarity = ?,
             last_seen_at_ms = MAX(last_seen_at_ms, ?),
             updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(rows.length, median(rows.map((r) => r.similarity)), now, now, workflowId);
      return added;
    });
    return run();
  }

  private insertOccurrence(workflowId: string, episodeId: string, similarity: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO workflow_occurrences (workflow_id, episode_id, similarity)
           VALUES (?, ?, ?)`,
        )
        .run(workflowId, episodeId, similarity).changes === 1
    );
  }

  /** Re-delivery latch for mine_workflows: does this episode occur anywhere? */
  hasOccurrenceForEpisode(episodeId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS hit FROM workflow_occurrences WHERE episode_id = ? LIMIT 1')
        .get(episodeId) !== undefined
    );
  }

  /**
   * Runs inside the caller's transaction when invoked from the delete
   * service (better-sqlite3 nests transactions via savepoints).
   * Returns the number of deleted workflow rows.
   */
  purgeCandidatesBelowThreshold(): number {
    const run = this.db.transaction((): number => {
      this.db
        .prepare(
          `DELETE FROM workflow_occurrences
           WHERE episode_id NOT IN (SELECT id FROM episodes)
             AND workflow_id IN (SELECT id FROM workflows WHERE status = 'candidate')`,
        )
        .run();
      // The denormalized counts must track the surviving ledger before the
      // threshold sweep decides victims.
      const rows = this.db
        .prepare(
          `SELECT w.id, o.similarity, e.started_at_ms FROM workflows w
           LEFT JOIN workflow_occurrences o ON o.workflow_id = w.id
           LEFT JOIN episodes e ON e.id = o.episode_id
           WHERE w.status = 'candidate'`,
        )
        .all() as Array<{ id: string; similarity: number | null; started_at_ms: number | null }>;
      interface CandidateLedger {
        similarities: number[];
        days: Set<string>;
      }
      const byWorkflow = new Map<string, CandidateLedger>();
      for (const row of rows) {
        let ledger = byWorkflow.get(row.id);
        if (ledger === undefined) {
          ledger = { similarities: [], days: new Set() };
          byWorkflow.set(row.id, ledger);
        }
        if (row.similarity !== null) ledger.similarities.push(row.similarity);
        if (row.started_at_ms !== null) {
          ledger.days.add(new Date(row.started_at_ms).toISOString().slice(0, 10));
        }
      }
      const victims: string[] = [];
      for (const [id, ledger] of byWorkflow) {
        const belowThreshold =
          ledger.similarities.length < CANDIDATE_MIN_OCCURRENCES ||
          ledger.days.size < CANDIDATE_MIN_DISTINCT_DAYS;
        this.db
          .prepare('UPDATE workflows SET occurrence_count = ?, median_similarity = ? WHERE id = ?')
          .run(ledger.similarities.length, median(ledger.similarities), id);
        if (belowThreshold) victims.push(id);
      }
      let deleted = 0;
      for (const id of victims) {
        this.db.prepare('DELETE FROM workflow_occurrences WHERE workflow_id = ?').run(id);
        deleted += this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes;
      }
      return deleted;
    });
    return run();
  }
}
