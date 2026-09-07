import type { MemoryCandidateDto, MemoryKind, MemoryStatus } from '@computer-history/protocol';

import { ulid } from 'ulid';

import type { Db } from './database.js';

import { escapeMatchQuery, safeMatchQuery } from './episodes-repository.js';

/**
 * memories repository over memory_candidates + memory_evidence + memories_fts
 * (spec §3.9/§3.10/§3.16–§3.17). READ side landed with M4; M5 owns WRITE side:
 *
 * - upsertCandidate implements the V1 contradiction rule: same canonical_key +
 *   SAME value ⇒ evidence accumulates on the existing row; DIFFERENT value ⇒ a
 *   NEW competing candidate row — an active memory's text is NEVER overwritten.
 * - Every mutation keeps memories_fts in the SAME transaction, with
 *   fts.rowid = memory_candidates.rowid (M4-gate inheritance; no triggers).
 * - manual_confirmed_at_ms marks a user decision (memory.action confirm);
 *   such rows are immune to auto-supersession and to every retention purge.
 */

const MEMORY_STATUSES: readonly string[] = ['candidate', 'active', 'rejected', 'superseded'];
const MEMORY_KINDS: readonly string[] = ['fact', 'preference', 'procedure'];

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
/** Search covers live claims only unless the caller opts into dead ones. */
const DEFAULT_SEARCH_STATUSES: readonly string[] = ['active', 'candidate'];

export interface MemorySqlRow {
  id: string;
  kind: string;
  canonical_key: string;
  text: string;
  confidence: number;
  status: string;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  evidence_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  manual_confirmed_at_ms: number | null;
}

export interface MemoryListFilters {
  status?: MemoryStatus;
  /** Row cap appended as SQL LIMIT (wire schema bounds it to 1–200). */
  limit?: number;
}

export interface MemorySearchFilters {
  query: string;
  kinds?: MemoryKind[];
  minConfidence?: number;
  statuses?: MemoryStatus[];
  limit?: number;
}

/** New claim offered by the extractor (spec §3.16 candidate shape). */
export interface MemoryUpsertInput {
  kind: MemoryKind;
  canonicalKey: string;
  text: string;
  confidence: number;
}

/** One observation backing a claim (unique pair: memory × episode). */
export interface MemoryEvidenceInput {
  episodeId: string;
  confidence: number;
  observedAtMs: number;
  /** What was observed, quoted from the extractor (spec §3.16); extractor always supplies it. */
  evidenceDescription?: string;
}

export interface UpsertOutcome {
  memoryId: string;
  /** true when the value differed under this canonical_key ⇒ NEW competing row. */
  competing: boolean;
  /** false when the (memory, episode) pair already existed (idempotent re-run). */
  evidenceAdded: boolean;
}

/** Auto consolidation verdict for one row (spec §3.16–§3.17 transitions). */
export interface StatusTransition {
  id: string;
  toStatus: Extract<MemoryStatus, 'active' | 'superseded'>;
}

function toDto(row: MemorySqlRow): MemoryCandidateDto {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    canonicalKey: row.canonical_key,
    text: row.text,
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    firstSeenAtMs: row.first_seen_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    evidenceCount: row.evidence_count,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** Rows arrive trusted from our own SQLite; enum columns still get a guard. */
function isKnown<T extends string>(value: string, known: readonly string[]): value is T {
  return known.includes(value);
}

/** V1 same-value rule: normalized text equality, case-insensitive, trimmed. */
function sameValue(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class MemoriesRepository {
  constructor(private readonly db: Db) {}

  /** All memories of one status (or every status), newest activity first. */
  listByStatus(filters: MemoryListFilters = {}): MemoryCandidateDto[] {
    const where = filters.status !== undefined ? 'WHERE status = ?' : '';
    const values: unknown[] = filters.status !== undefined ? [filters.status] : [];
    let sql = `SELECT * FROM memory_candidates ${where} ORDER BY last_seen_at_ms DESC, id ASC`;
    if (filters.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filters.limit);
    }
    const rows = this.db.prepare(sql).all(...values) as MemorySqlRow[];
    return rows.filter((r) => isKnown(r.status, MEMORY_STATUSES)).map(toDto);
  }

  /**
   * FTS search via memories_fts (text + canonical_key). Raw user text passes
   * escapeMatchQuery() THEN safeMatchQuery() — residual FTS5 operators are
   * dropped so a query can never inject MATCH syntax. Empty results when the
   * sanitized query empties out; callers wanting listings use listByStatus.
   */
  searchMemories(filters: MemorySearchFilters): MemoryCandidateDto[] {
    const matchQuery = safeMatchQuery(escapeMatchQuery(filters.query));
    if (matchQuery.length === 0) return [];
    const conditions: string[] = ['memories_fts MATCH ?'];
    const values: unknown[] = [matchQuery];
    const statuses =
      filters.statuses !== undefined && filters.statuses.length > 0
        ? filters.statuses
        : DEFAULT_SEARCH_STATUSES;
    conditions.push(`m.status IN (${statuses.map(() => '?').join(', ')})`);
    values.push(...statuses);
    if (filters.kinds !== undefined && filters.kinds.length > 0) {
      conditions.push(`m.kind IN (${filters.kinds.map(() => '?').join(', ')})`);
      values.push(...filters.kinds);
    }
    if (filters.minConfidence !== undefined) {
      conditions.push('m.confidence >= ?');
      values.push(filters.minConfidence);
    }
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memory_candidates m ON m.rowid = f.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(memories_fts) ASC, m.last_seen_at_ms DESC
         LIMIT ?`,
      )
      .all(...values, clampLimit(filters.limit)) as MemorySqlRow[];
    return rows
      .filter((r) => isKnown<MemoryStatus>(r.status, MEMORY_STATUSES))
      .filter((r) => isKnown<MemoryKind>(r.kind, MEMORY_KINDS))
      .map(toDto);
  }

  /** Single memory lookup for the episode_get-style tool surface and actions. */
  getById(id: string): MemoryCandidateDto | null {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as
      | MemorySqlRow
      | undefined;
    return row === undefined ? null : toDto(row);
  }

  /**
   * Write-side core (spec §3.16/§3.17): accumulate evidence on the same-value
   * row under this canonical_key, or create a NEW competing candidate when the
   * value differs — the active row is never rewritten. The (memory, episode)
   * unique pair makes repeated extractions idempotent. Candidate insert, first
   * evidence and the FTS mirror commit in ONE transaction.
   */
  upsertCandidate(input: MemoryUpsertInput, evidence: MemoryEvidenceInput, now: number): UpsertOutcome {
    const run = this.db.transaction((): UpsertOutcome => {
      const existing = this.db
        .prepare(
          `SELECT * FROM memory_candidates WHERE canonical_key = ?
           ORDER BY created_at_ms ASC, id ASC`,
        )
        .all(input.canonicalKey) as MemorySqlRow[];
      // A twin must be the same kind (different kinds have different promotion
      // matrices) and must still be live: rejected rows never absorb evidence,
      // so they age out on schedule instead of being refreshed forever.
      const liveCandidates = existing.filter((row) => row.kind === input.kind && row.status !== 'rejected');
      const twin = liveCandidates.find((row) => sameValue(row.text, input.text));
      if (twin !== undefined) {
        const added = this.addEvidence(twin.id, evidence);
        this.db
          .prepare(
            `UPDATE memory_candidates SET
               evidence_count = (SELECT COUNT(*) FROM memory_evidence WHERE memory_id = ?),
               last_seen_at_ms = MAX(last_seen_at_ms, ?),
               confidence = MAX(confidence, ?),
               updated_at_ms = ?
             WHERE id = ?`,
          )
          .run(twin.id, evidence.observedAtMs, Math.max(input.confidence, evidence.confidence), now, twin.id);
        return { memoryId: twin.id, competing: false, evidenceAdded: added };
      }

      const id = ulid(Math.min(now, evidence.observedAtMs));
      const inserted = this.db
        .prepare(
          `INSERT INTO memory_candidates (
             id, kind, canonical_key, text, confidence, status,
             first_seen_at_ms, last_seen_at_ms, evidence_count,
             created_at_ms, updated_at_ms, manual_confirmed_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, 1, ?, ?, NULL)`,
        )
        .run(
          id,
          input.kind,
          input.canonicalKey,
          input.text,
          Math.max(input.confidence, evidence.confidence),
          evidence.observedAtMs,
          evidence.observedAtMs,
          now,
          now,
        );
      const rowid = Number(inserted.lastInsertRowid);
      // FTS mirror in the SAME transaction with rowid = memory_candidates.rowid.
      this.db
        .prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)')
        .run(rowid, input.text, input.canonicalKey);
      this.addEvidence(id, evidence);
      // A brand-new claim under an EMPTY key group is not a competitor —
      // competing means a DIFFERENT value met a LIVE existing one under this
      // canonical_key (spec §3.17); rejected rows are not twins and do not count.
      const competing = liveCandidates.length > 0;
      return { memoryId: id, competing, evidenceAdded: true };
    });
    return run();
  }

  private addEvidence(memoryId: string, evidence: MemoryEvidenceInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_evidence (memory_id, episode_id, confidence, created_at_ms, evidence_description)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        evidence.episodeId,
        evidence.confidence,
        evidence.observedAtMs,
        evidence.evidenceDescription ?? '',
      );
    return result.changes === 1;
  }

  /** All rows of one canonical_key group, oldest first (consolidator input). */
  listByKey(canonicalKey: string): MemorySqlRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_candidates WHERE canonical_key = ?
         ORDER BY created_at_ms ASC, id ASC`,
      )
      .all(canonicalKey) as MemorySqlRow[];
  }

  /** Evidence ledger of one memory, oldest observation first. */
  listEvidence(memoryId: string): Array<{
    episodeId: string;
    createdAtMs: number;
    confidence: number;
    evidenceDescription: string;
  }> {
    return this.db
      .prepare(
        `SELECT episode_id AS episodeId, created_at_ms AS createdAtMs, confidence,
                evidence_description AS evidenceDescription
         FROM memory_evidence WHERE memory_id = ? ORDER BY created_at_ms ASC, episode_id ASC`,
      )
      .all(memoryId) as Array<{
      episodeId: string;
      createdAtMs: number;
      confidence: number;
      evidenceDescription: string;
    }>;
  }

  /** Idempotency latch for extract_memory: any evidence from this episode yet? */
  hasEvidenceForEpisode(episodeId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM memory_evidence WHERE episode_id = ? LIMIT 1')
      .get(episodeId) as { hit?: number } | undefined;
    return row !== undefined;
  }

  /**
   * Applies automatic consolidation verdicts in ONE transaction. Rows carrying
   * a manual confirmation are refused here too — defense in depth behind the
   * consolidator's own filter (spec §3.17: manual decision wins).
   */
  applyStatusTransitions(transitions: StatusTransition[], now: number): number {
    if (transitions.length === 0) return 0;
    let applied = 0;
    const run = this.db.transaction(() => {
      for (const t of transitions) {
        applied += this.db
          .prepare(
            `UPDATE memory_candidates
             SET status = ?, updated_at_ms = ?
             WHERE id = ? AND status != ? AND manual_confirmed_at_ms IS NULL`,
          )
          .run(t.toStatus, now, t.id, t.toStatus).changes;
      }
    });
    run();
    return applied;
  }

  /**
   * memory.action confirm (contracts): status becomes active IMMEDIATELY from
   * any status, stamped manual_confirmed_at_ms — one evidence is enough and
   * automation can never demote or supersede the row afterwards.
   */
  confirm(id: string, now: number): MemoryCandidateDto | null {
    const changes = this.db
      .prepare(
        `UPDATE memory_candidates
         SET status = 'active', manual_confirmed_at_ms = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(now, now, id).changes;
    return changes === 1 ? this.getById(id) : null;
  }

  /**
   * memory.action reject: status → rejected (retention purges it after 30d).
   * A prior manual confirmation is cleared — the newer manual decision governs.
   */
  reject(id: string, now: number): MemoryCandidateDto | null {
    const changes = this.db
      .prepare(
        `UPDATE memory_candidates
         SET status = 'rejected', manual_confirmed_at_ms = NULL, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(now, id).changes;
    return changes === 1 ? this.getById(id) : null;
  }

  /**
   * memory.action forget (spec §3.23 hard delete): memory row + evidence +
   * FTS mirror in ONE transaction, FTS keyed by rowid. Returns false when the
   * id is unknown.
   */
  forget(id: string): boolean {
    const run = this.db.transaction(() => {
      this.deleteFtsRowFor(id);
      this.db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(id);
      return this.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(id).changes === 1;
    });
    return run();
  }

  /**
   * Retention (spec §3.22): rejected candidates older than 30d, EXCEPT rows
   * with a manual confirmation. FTS deletion keys on the rowid convention.
   */
  purgeRejectedOlderThan(cutoffMs: number): number {
    const victims = this.db
      .prepare(
        `SELECT id FROM memory_candidates
         WHERE status = 'rejected' AND manual_confirmed_at_ms IS NULL AND updated_at_ms < ?`,
      )
      .all(cutoffMs) as Array<{ id: string }>;
    return this.hardDeleteIds(victims.map((v) => v.id));
  }

  /**
   * Retention (spec §3.22): superseded candidates older than the semantic
   * window. §3.22 pins only rejected candidates and is silent on superseded
   * ones, so no manual-confirmed sparing applies here (decision: once a row
   * is superseded it is terminal history and ages out regardless of a past
   * confirmation — its incumbent replacement carries the content forward).
   */
  purgeSupersededOlderThan(cutoffMs: number): number {
    const victims = this.db
      .prepare(
        `SELECT id FROM memory_candidates
         WHERE status = 'superseded' AND updated_at_ms < ?`,
      )
      .all(cutoffMs) as Array<{ id: string }>;
    return this.hardDeleteIds(victims.map((v) => v.id));
  }

  /**
   * Retention zero-evidence cleanup (contracts §memory.action semantics):
   * non-manual rows without any evidence are deleted — during RETENTION only,
   * never automatically by consolidation.
   */
  purgeZeroEvidence(): number {
    const victims = this.db
      .prepare(
        `SELECT id FROM memory_candidates m
         WHERE m.manual_confirmed_at_ms IS NULL
           AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memory_id = m.id)`,
      )
      .all() as Array<{ id: string }>;
    return this.hardDeleteIds(victims.map((v) => v.id));
  }

  /** Shared hard-delete: FTS mirror (rowid), evidence, then the row — one tx. */
  private hardDeleteIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    let deleted = 0;
    const run = this.db.transaction(() => {
      for (const id of ids) {
        this.deleteFtsRowFor(id);
        this.db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(id);
        deleted += this.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(id).changes;
      }
    });
    run();
    return deleted;
  }

  /** FTS rows follow the rowid convention — no content matching, no triggers. */
  private deleteFtsRowFor(id: string): void {
    this.db
      .prepare(
        `DELETE FROM memories_fts
         WHERE rowid = (SELECT rowid FROM memory_candidates WHERE id = ?)`,
      )
      .run(id);
  }
}
