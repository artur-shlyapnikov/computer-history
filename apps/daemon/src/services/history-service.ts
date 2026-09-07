import type Database from 'better-sqlite3';

import type { Db } from '../db/database.js';
import { escapeMatchQuery, safeMatchQuery } from '../db/episodes-repository.js';

/**
 * History retrieval API (spec §3.18, brief-m4 §D4 item 1). Read-only search
 * over episodes and their linked semantic steps with pinned ranking math:
 *
 *   score = 0.8 × normBM25 + 0.2 × recency        (textual queries only)
 *   normBM25 = (n − rank) / n                     (rank 0 = best → 1.0, last → 1/n)
 *   recency  = exp(−age_days / 30)                (age of episode.start)
 *   explicit from/to  ⇒  recency term dropped entirely
 *   non-textual query ⇒  no scoring, order startedAtMs desc, score = 0
 *
 * normBM25 maps the BM25 RANK (not the raw bm25() value, whose scale is
 * corpus-dependent) onto [1/n, 1] within the candidate set so the two term
 * weights stay comparable across corpora. The candidate set per FTS leg is
 * capped at CANDIDATE_CAP rows before normalization — a documented bound that
 * keeps the ranking window finite while far exceeding any useful page size.
 *
 * Time/apps filters always apply to the OWNING EPISODE: provenance fields are
 * episode-level on both hit kinds, so filtering is uniform across legs.
 *
 * snippet() uses the SQLite ≥3.53 six-argument signature
 * (tbl, colnum, before, after, ellipsis, maxTokens ≤ 64).
 *
 * DO NOT defer snippet() to a post-ranking "survivors" query (looks like a
 * ~40-47% win on dense terms): with the bundled SQLite, auxiliary functions
 * CORRUPT under MATCH + any rowid constraint (`rowid = ?`, `rowid IN (...)`,
 * joined or bare) — the row FILTER is correct but snippet() returns another
 * row's text (verified round 18, better-sqlite3 13.0.3). snippet() is only
 * trustworthy in a plain MATCH scan, so it stays in the candidate query and
 * is evaluated per scanned candidate. The rest of the per-candidate cost is
 * also pinned: the `JOIN semantic_steps` per candidate carries the
 * bm25-tie break (started_at_ms) and must stay in-SQL or the LIMIT cut
 * diverges on tied ranks (round-13: ties are real).
 */

export type HistoryScope = 'episodes' | 'steps' | 'both';

export interface HistoryQuery {
  query?: string;
  from?: number;
  to?: number;
  apps?: string[];
  scope?: HistoryScope;
  limit?: number;
}

/** Episode-level hit: provenance is the episode record itself. */
export interface EpisodeHistoryHit {
  kind: 'episode';
  episodeId: string;
  /** Episode span — the provenance timestamps carried on the wire hit. */
  startedAtMs: number;
  endedAtMs: number;
  appNames: string[];
  snippet: string;
  score: number;
}

/** Step-level hit: carries the owning-episode provenance PLUS step fields. */
export interface StepHistoryHit {
  kind: 'step';
  /** Owning episode (spec §3.18: step hits come WITH parent provenance). */
  episodeId: string;
  /** Episode span — the provenance timestamps carried on the wire hit. */
  startedAtMs: number;
  endedAtMs: number;
  appNames: string[];
  snippet: string;
  score: number;
  // --- step fields ---
  stepId: string;
  stepStartedAtMs: number;
  stepEndedAtMs: number;
  action: string;
  appName: string | null;
  target: string | null;
  text: string | null;
}

export type HistoryHit = EpisodeHistoryHit | StepHistoryHit;

export interface HistorySearchResult {
  hits: HistoryHit[];
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

/** Upper bound of FTS candidates per leg entering the normBM25 window. */
const CANDIDATE_CAP = 200;
const DAY_MS = 86_400_000;
const RECENCY_SCALE_DAYS = 30;
/** Non-textual hits have no MATCH context → no snippet(); JS truncation instead. */
const FALLBACK_SNIPPET_CHARS = 160;

interface EpisodeCandidateRow {
  id: string;
  started_at_ms: number;
  ended_at_ms: number;
  title: string;
  summary: string;
  apps_json: string;
  rank: number;
  snip: string | null;
}

interface StepCandidateRow {
  step_id: string;
  step_started_at_ms: number;
  step_ended_at_ms: number | null;
  action: string;
  app_name: string | null;
  target: string | null;
  text: string | null;
  episode_id: string;
  ep_started_at_ms: number;
  ep_ended_at_ms: number;
  apps_json: string;
  rank: number;
  snip: string | null;
}

interface LegOptions {
  params: Pick<HistoryQuery, 'from' | 'to' | 'apps'>;
  textual: boolean;
  matchQuery: string;
  limit: number;
  recencyOn: boolean;
  nowMs: number;
}

export class HistoryService {
  /** Prepared per (leg, textual, filter-shape); the filter grammar has a
   * bounded variant set (from/to/apps presence), so the map stays tiny. */
  private readonly searchStmts = new Map<string, Database.Statement>();

  private stmt(key: string, sql: string): Database.Statement {
    let stmt = this.searchStmts.get(key);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.searchStmts.set(key, stmt);
    }
    return stmt;
  }

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  historySearch(params: HistoryQuery): HistorySearchResult {
    const scope = params.scope ?? 'episodes';
    const limit =
      params.limit === undefined || Number.isNaN(params.limit)
        ? DEFAULT_SEARCH_LIMIT
        : Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(params.limit)));
    const rawQuery = params.query;
    const matchQuery = safeMatchQuery(escapeMatchQuery(rawQuery ?? ''));
    const textual = matchQuery.length > 0;
    // A query that was SUPPLIED but sanitizes to zero tokens ('-webhook',
    // '*', emoji-only) must not degrade into the newest-N listing — that
    // would be indistinguishable from genuine zero-score matches. Only an
    // OMITTED query keeps the listing behavior (S5).
    if (rawQuery !== undefined && !textual) {
      return { hits: [] };
    }
    // Explicit time constraint ⇒ recency bonus disabled (spec §3.18).
    const legOpts: LegOptions = {
      params,
      textual,
      matchQuery,
      limit,
      recencyOn: textual && params.from === undefined && params.to === undefined,
      nowMs: this.now(),
    };

    const wantEpisodes = scope === 'episodes' || scope === 'both';
    const wantSteps = scope === 'steps' || scope === 'both';
    const episodeHits = wantEpisodes ? this.episodeHits(legOpts) : [];
    const stepHits = wantSteps ? this.stepHits(legOpts) : [];

    if (!textual) {
      // Non-textual queries: each leg already newest-first; merge on same key.
      const merged = [...episodeHits, ...stepHits].sort((a, b) => b.startedAtMs - a.startedAtMs);
      return { hits: merged.slice(0, limit) };
    }
    const ranked = [...episodeHits, ...stepHits];
    ranked.sort((a, b) => b.score - a.score || b.startedAtMs - a.startedAtMs);
    return { hits: ranked.slice(0, limit) };
  }

  private episodeHits(opts: LegOptions): EpisodeHistoryHit[] {
    if (!opts.textual) {
      const where = episodeFilters(opts.params, '');
      const rows = this.stmt(
        `ep|list|${where.sql}`,
        `SELECT e.*, 0 AS rank, NULL AS snip FROM episodes e
           WHERE ${where.sql.length > 0 ? where.sql : '1=1'}
           ORDER BY e.started_at_ms DESC LIMIT ?`,
      ).all(...where.values, opts.limit) as EpisodeCandidateRow[];
      return rowsToEpisodeHits(rows);
    }
    const where = episodeFilters(opts.params, 'e.');
    const rows = this.stmt(
      `ep|fts|${where.sql}`,
      `SELECT e.*, bm25(episodes_fts) AS rank,
                snippet(episodes_fts, -1, '<b>', '</b>', '…', 64) AS snip
         FROM episodes_fts f
         JOIN episodes e ON e.rowid = f.rowid
         WHERE episodes_fts MATCH ?${where.sql.length > 0 ? ` AND ${where.sql}` : ''}
         ORDER BY bm25(episodes_fts) ASC, e.started_at_ms DESC
         LIMIT ?`,
    ).all(opts.matchQuery, ...where.values, CANDIDATE_CAP) as EpisodeCandidateRow[];
    return applyScores(rowsToEpisodeHits(rows), opts);
  }

  private stepHits(opts: LegOptions): StepHistoryHit[] {
    // Spec §3.24 release criterion: semantic history stays searchable even
    // when NO episode exists yet (full LLM outage ⇒ summarization stalls).
    // Steps match on their OWN row; the owning episode is joined SOFTLY and
    // unlinked steps fall back to step-level provenance.
    const select = `SELECT s.id AS step_id, s.started_at_ms AS step_started_at_ms,
           s.ended_at_ms AS step_ended_at_ms, s.action, s.app_name, s.target, s.text,
           COALESCE(e.id, '') AS episode_id,
           COALESCE(e.started_at_ms, s.started_at_ms) AS ep_started_at_ms,
           COALESCE(e.ended_at_ms, COALESCE(s.ended_at_ms, s.started_at_ms)) AS ep_ended_at_ms,
           COALESCE(e.apps_json, '[]') AS apps_json`;
    // Episode-level filters must not hide UNLINKED steps: they apply only
    // when the step already belongs to an episode.
    const ef = episodeFilters(opts.params, 'e.');
    const filterSql = ef.sql.length > 0 ? ` AND (l.episode_id IS NULL OR (${ef.sql}))` : '';
    if (!opts.textual) {
      const rows = this.stmt(
        `step|list|${filterSql}`,
        `${select}, 0 AS rank, NULL AS snip
           FROM semantic_steps s
           LEFT JOIN episode_step_links l ON l.semantic_step_id = s.id
           LEFT JOIN episodes e ON e.id = l.episode_id
           WHERE 1=1${filterSql}
           ORDER BY s.started_at_ms DESC LIMIT ?`,
      ).all(...ef.values, opts.limit) as StepCandidateRow[];
      return rowsToStepHits(rows);
    }
    const rows = this.stmt(
      `step|fts|${filterSql}`,
      `${select}, bm25(semantic_steps_fts) AS rank,
                snippet(semantic_steps_fts, -1, '<b>', '</b>', '…', 64) AS snip
         FROM semantic_steps_fts f
         JOIN semantic_steps s ON s.rowid = f.rowid
         LEFT JOIN episode_step_links l ON l.semantic_step_id = s.id
         LEFT JOIN episodes e ON e.id = l.episode_id
         WHERE semantic_steps_fts MATCH ?${filterSql}
         ORDER BY bm25(semantic_steps_fts) ASC, s.started_at_ms DESC
         LIMIT ?`,
    ).all(opts.matchQuery, ...ef.values, CANDIDATE_CAP) as StepCandidateRow[];
    return applyScores(rowsToStepHits(rows), opts);
  }
}

// ------------------------------------------------------------------- shared

/**
 * Time/apps predicates over the OWNING EPISODE table (uniform semantics for
 * both legs: provenance fields are episode-level, so filters are too).
 * `prefix` is '' for plain scans or 'e.' inside FTS joins.
 */
function episodeFilters(
  params: Pick<HistoryQuery, 'from' | 'to' | 'apps'>,
  prefix: string,
): { sql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.from !== undefined) {
    conditions.push(`${prefix}started_at_ms >= ?`);
    values.push(params.from);
  }
  if (params.to !== undefined) {
    conditions.push(`${prefix}started_at_ms <= ?`);
    values.push(params.to);
  }
  if (params.apps !== undefined && params.apps.length > 0) {
    const placeholders = params.apps.map(() => '?').join(', ');
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(${prefix}apps_json) ja WHERE ja.value IN (${placeholders}))`,
    );
    values.push(...params.apps);
  }
  return { sql: conditions.join(' AND '), values };
}

/**
 * Pinned ranking math over one candidate set (spec §3.18): hits arrive
 * BM25-best-first, get normalized onto [1/n, 1], and the recency term is
 * added to EVERY candidate when enabled — score = 0.8·normBM25 + 0.2·recency
 * unconditionally, not only on-page hits. A fresh deep hit in one leg must
 * stay competitive against stale shallow hits from the other leg once the
 * legs merge; capping the bonus at the page boundary broke that.
 */
function applyScores<T extends { startedAtMs: number; score: number }>(
  hits: T[],
  opts: Pick<LegOptions, 'recencyOn' | 'nowMs'>,
): T[] {
  const n = hits.length;
  for (const [rank, hit] of hits.entries()) {
    const normBm25 = (n - rank) / n;
    let score = 0.8 * normBm25;
    if (opts.recencyOn) {
      const ageDays = Math.max(0, opts.nowMs - hit.startedAtMs) / DAY_MS;
      score += 0.2 * Math.exp(-ageDays / RECENCY_SCALE_DAYS);
    }
    hit.score = score;
  }
  return hits;
}

function parseAppNames(appsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(appsJson);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowsToEpisodeHits(rows: EpisodeCandidateRow[]): EpisodeHistoryHit[] {
  return rows.map((row) => ({
    kind: 'episode' as const,
    episodeId: row.id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    appNames: parseAppNames(row.apps_json),
    snippet: row.snip ?? fallbackSnippet([row.title, row.summary]),
    score: 0,
  }));
}

function rowsToStepHits(rows: StepCandidateRow[]): StepHistoryHit[] {
  return rows.map((row) => ({
    kind: 'step' as const,
    episodeId: row.episode_id,
    startedAtMs: row.ep_started_at_ms,
    endedAtMs: row.ep_ended_at_ms,
    appNames: parseAppNames(row.apps_json),
    snippet: row.snip ?? fallbackSnippet([row.text, row.target, row.action]),
    stepId: row.step_id,
    stepStartedAtMs: row.step_started_at_ms,
    stepEndedAtMs: row.step_ended_at_ms ?? row.step_started_at_ms,
    action: row.action,
    appName: row.app_name,
    target: row.target,
    text: row.text,
    score: 0,
  }));
}

function fallbackSnippet(parts: Array<string | null>): string {
  const text = parts.find((p) => p !== null && p.trim().length > 0)?.trim() ?? '';
  return text.length > FALLBACK_SNIPPET_CHARS ? `${text.slice(0, FALLBACK_SNIPPET_CHARS)}…` : text;
}
