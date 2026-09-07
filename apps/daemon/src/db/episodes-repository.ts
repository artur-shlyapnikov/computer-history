import { ulid } from 'ulid';

import type Database from 'better-sqlite3';

import type { SemanticStepDto } from '@computer-history/protocol';
import { CONSTANTS } from '../config.js';
import type { StepAction } from '../processing/event-coalescer.js';

import type { Db } from './database.js';

/**
 * One episode to persist, with the ordered semantic-step ids that make up its
 * full cover (spec §3.14: every step belongs to exactly one episode). The
 * caller — the episode summarizer — has already enforced the contiguity
 * invariants; this layer owns transactional durability only.
 */
export interface NewEpisode {
  startedAtMs: number;
  endedAtMs: number;
  title: string;
  summary: string;
  intent: string | null;
  outcome: string | null;
  apps: string[];
  entities: string[];
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  /**
   * Segment the covered steps belong to (migration 012). Stamped so the
   * summarize_segment dedupe latch survives episode_step_links purges;
   * legacy callers omit it and the row stays NULL (link-based latch only).
   */
  segmentId?: string | null;
  /**
   * Max ordinal among this episode's covered steps (migration 013). With
   * segmentId it forms the summarize_segment latch's primary signal:
   * `last_step_ordinal >= window max ordinal` is append-order and immune to
   * clock-regressed event timestamps, unlike the superseded timestamp-interval
   * intersection. Legacy callers omit it and the row stays NULL (link-based
   * latch only).
   */
  lastStepOrdinal?: number | null;
  /** Ordered step ids covered by this episode; link ordinal = position here. */
  steps: { id: string }[];
}

export interface EpisodeRow {
  id: string;
  startedAtMs: number;
  endedAtMs: number;
  title: string;
  summary: string;
  intent: string | null;
  outcome: string | null;
  apps: string[];
  entities: string[];
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Wire-shaped timeline entry (EpisodeSummaryDto without the pendingJobs count). */
export interface EpisodeSummary {
  id: string;
  startedAtMs: number;
  endedAtMs: number;
  title: string;
  appNames: string[];
  stepCount: number;
}

interface EpisodeSqlRow {
  id: string;
  started_at_ms: number;
  ended_at_ms: number;
  title: string;
  summary: string;
  intent: string | null;
  outcome: string | null;
  apps_json: string;
  entities_json: string;
  summary_model: string | null;
  summary_prompt_version: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Per-step join row used for JS-side distinct app-name aggregation. */
interface EpisodeStepNameRow {
  episode_id: string;
  app_name: string | null;
}

interface CountRow {
  n: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    // A valid-JSON wrong shape (e.g. `5` or `{"a":1}`) must degrade too —
    // only a real string array flows downstream.
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToEpisode(row: EpisodeSqlRow): EpisodeRow {
  return {
    id: row.id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    title: row.title,
    summary: row.summary,
    intent: row.intent,
    outcome: row.outcome,
    // App/entity shapes are pinned by protocol; malformed or wrong-shape
    // stored JSON degrades to an empty array rather than poisoning episode
    // list/get/search paths.
    apps: parseStringArray(row.apps_json),
    entities: parseStringArray(row.entities_json),
    summaryModel: row.summary_model,
    summaryPromptVersion: row.summary_prompt_version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Sanitizes free user text into a safe FTS5 MATCH query: double quotes (FTS5
 * phrase syntax) and control characters are stripped, then whitespace tokens
 * are re-joined with single spaces so FTS5's implicit AND applies per token.
 * Shared util for every history search surface (brief-m3 §D3 item 1).
 */
export function escapeMatchQuery(input: string): string {
  // Stripping control characters is the whole point here; the class is intentional.
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/["\u{0000}-\u{001F}\u{007F}]/gu, ' ');
  return stripped
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(' ');
}
/** Uppercase forms are FTS5 query operators and must never reach MATCH. */
const FTS5_KEYWORDS: Record<string, true> = { AND: true, OR: true, NOT: true, NEAR: true };

/** Kana, CJK ideographs (incl. compatibility) and Hangul syllables. */
const CJK_RUN = /[\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{AC00}-\u{D7AF}]/u;

/**
 * Upper bound on tokens reaching FTS5 MATCH. FTS5 query parsing cost grows
 * superlinearly in the number of terms and the daemon runs the parse on its
 * synchronous loop, so an adversarial 200k-token frame must never reach
 * SQLite uncapped — 64 tokens bounds the worst case while covering every
 * realistic free-text query (S1).
 */
export const MAX_MATCH_TOKENS = 64;

/**
 * Defense-in-depth over escapeMatchQuery(): no residual FTS5 syntax
 * (NEAR, AND/OR/NOT, parentheses, stray '/') may reach MATCH as an operator.
 * Shared sanitizer runs FIRST; every raw-user-text FTS surface
 * (history.search, memory_search) MUST pipe through BOTH (brief-m4 gate
 * inheritance: safeMatchQuery promoted to a shared util).
 *
 * Tokens carrying FTS5 syntax chars (column filters, grouping, NEAR/10,
 * first-term boost) are dropped WHOLE — splitting could turn the syntax into
 * accidental search terms. Every other token is SPLIT into whitelisted runs
 * on punctuation (`webhook-v2` → `webhook v2`): dropping such tokens whole
 * silently narrowed recall with no signal (round-25).
 */
export function safeMatchQuery(sanitized: string): string {
  const tokens = sanitized
    .normalize('NFC')
    .split(/\s+/)
    .flatMap(splitToken)
    .filter((t) => t.length > 0 && !(t.toUpperCase() in FTS5_KEYWORDS))
    .slice(0, MAX_MATCH_TOKENS);
  return (
    tokens
      // unicode61 keeps a whole CJK run as ONE token with no intra-run
      // boundaries, so a multi-char CJK term only matches as a run PREFIX:
      // append '*' to get prefix matching within the run. Matching a
      // middle-of-run substring remains impossible under unicode61 — a known
      // SQLite tokenizer limitation this layer cannot lift.
      .map((t) => (!t.endsWith('*') && CJK_RUN.test(t) ? `${t}*` : t))
      .join(' ')
  );
}

/** Chars that carry FTS5 query syntax even inside a token. */
const FTS_SYNTAX = /[():^/"{}]/;

/** Any run of token-safe chars; splitting happens on everything else. */
const TOKEN_RUN = /[\p{L}\p{N}\p{M}_]+/gu;

/**
 * One whitespace-separated token → zero or more whitelisted runs. A single
 * trailing '*' (user prefix intent) survives on the last run; a '*' anywhere
 * else, or any FTS syntax char, drops the token whole.
 */
function splitToken(raw: string): string[] {
  if (raw.length === 0) return [];
  const prefixed = raw.endsWith('*');
  const body = prefixed ? raw.slice(0, -1) : raw;
  if (body.length === 0 || body.includes('*') || FTS_SYNTAX.test(body)) return [];
  const runs = body.match(TOKEN_RUN) ?? [];
  if (prefixed && runs.length > 0) runs[runs.length - 1] += '*';
  return runs;
}

/**
 * episodes + episode_step_links + episodes_fts persistence (spec §3.9/§3.10,
 * brief-m3 §D3 item 1). FTS rows are maintained by these methods in the same
 * transaction as the primary rows — never SQL triggers; the FTS rowid mirrors
 * episodes.rowid so future joins stay possible (episodes themselves are never
 * purged by retention, spec §3.22).
 */
export class EpisodesRepository {
  /**
   * hasEpisodesForSteps statements: the segment + ordinal probe and the
   * legacy interval probe (each a single cached statement) plus the legacy
   * link fallback cached per IN-list size — bounded to the summarizer cap
   * plus one row of defensive slack (CONSTANTS.summarizeMaxInputSteps + 1);
   * larger sizes stay uncached.
   */
  private hasEpisodeForSegmentStmt?: Database.Statement;
  private hasLegacyIntervalStmt?: Database.Statement;
  private readonly hasEpisodesStmts = new Map<number, Database.Statement>();

  constructor(private readonly db: Db) {}

  /**
   * Writes every episode row, its ordered episode_step_links and its FTS
   * mirror inside ONE transaction — a crash mid-way leaves no partial episode
   * behind (spec §3.14 "никакие events из-за failure не теряются" applies to
   * persistence too). entities_flat/apps_flat are space-joined FTS columns.
   */
  insertEpisodesWithLinks(episodes: NewEpisode[], createdAtMs: number = Date.now()): string[] {
    if (episodes.length === 0) return [];
    // Post-013 stamp invariant (enforced, not by-convention): a stamped row
    // must carry its latch ordinal — `segment_id + last_step_ordinal >= window
    // max ordinal` is the clock-skew-immune primary latch signal. A caller
    // passing only segmentId would silently land the row in the legacy
    // NULL-ordinal interval-probe tier, reintroducing the round-31 hazard.
    for (const episode of episodes) {
      if (episode.segmentId != null && (episode.lastStepOrdinal == null)) {
        throw new Error(
          'insertEpisodesWithLinks: segmentId requires lastStepOrdinal (stamped ⇒ ordinal); omit both for legacy rows',
        );
      }
    }
    const insertEpisode = this.db.prepare(
      `INSERT INTO episodes (
         id, started_at_ms, ended_at_ms, title, summary, intent, outcome,
         apps_json, entities_json, summary_model, summary_prompt_version,
         segment_id, last_step_ordinal, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = this.db.prepare(
      'INSERT INTO episode_step_links (episode_id, semantic_step_id, ordinal) VALUES (?, ?, ?)',
    );
    const insertFts = this.db.prepare(
      `INSERT INTO episodes_fts (rowid, title, summary, intent, outcome, entities_flat, apps_flat)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      const ids: string[] = [];
      for (const episode of episodes) {
        const id = ulid(episode.startedAtMs);
        ids.push(id);
        const result = insertEpisode.run(
          id,
          episode.startedAtMs,
          episode.endedAtMs,
          episode.title,
          episode.summary,
          episode.intent,
          episode.outcome,
          JSON.stringify(episode.apps),
          JSON.stringify(episode.entities),
          episode.summaryModel,
          episode.summaryPromptVersion,
          episode.segmentId ?? null,
          episode.lastStepOrdinal ?? null,
          createdAtMs,
          createdAtMs,
        );
        for (let ordinal = 0; ordinal < episode.steps.length; ordinal++) {
          const step = episode.steps[ordinal];
          if (step === undefined) continue; // unreachable: length-bounded loop
          insertLink.run(id, step.id, ordinal);
        }
        insertFts.run(
          result.lastInsertRowid,
          episode.title,
          episode.summary,
          episode.intent ?? '',
          episode.outcome ?? '',
          episode.entities.join(' '),
          episode.apps.join(' '),
        );
      }
      return ids;
    });
    return run();
  }

  /** One episode with its steps ordered by link ordinal, or null. */
  getEpisode(id: string): { episode: EpisodeRow; steps: SemanticStepDto[] } | null {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as
      | EpisodeSqlRow
      | undefined;
    if (row === undefined) return null;
    const steps = this.db
      .prepare(
        `SELECT s.id, s.segment_id, l.ordinal AS link_ordinal, s.ordinal, s.started_at_ms,
                s.ended_at_ms, s.action, s.app_bundle_id, s.app_name, s.target, s.target_role, s.text
         FROM episode_step_links l
         JOIN semantic_steps s ON s.id = l.semantic_step_id
         WHERE l.episode_id = ?
         ORDER BY l.ordinal ASC`,
      )
      .all(id) as Array<{
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
    }>;
    return {
      episode: rowToEpisode(row),
      steps: steps.map((s) => ({
        id: s.id,
        segmentId: s.segment_id,
        ordinal: s.ordinal,
        startedAtMs: s.started_at_ms,
        endedAtMs: s.ended_at_ms ?? s.started_at_ms,
        action: s.action,
        appBundleId: s.app_bundle_id,
        appName: s.app_name,
        target: s.target,
        targetRole: s.target_role,
        text: s.text,
      })),
    };
  }

  /**
   * Mining pool for one window (spec §3.20: candidate lookup over the last
   * 30 days): episodes whose steps are still linked, with their ordered steps
   * attached. PERF-07: pass `limit` to page only the newest N episodes in
   * SQL — `includeIds` re-fetches in-range rows such as the mining seed that
   * fell outside the page, so a >N window no longer materializes every
   * episode (nor an unbounded IN-list for the step join). The default keeps
   * the historical full-window read. Two-to-three queries total — the
   * per-episode step fan-out is grouped in JS instead of N+1 getEpisode
   * calls — and step text is not selected (the miner's fingerprints never
   * read it).
   */
  listEpisodesWithStepsInRange(
    fromMs: number,
    toMs: number,
    opts: { limit?: number; includeIds?: readonly string[] } = {},
  ): Array<{
    id: string;
    startedAtMs: number;
    intent: string | null;
    title: string;
    summary: string;
    steps: Array<Omit<SemanticStepDto, 'text'>>;
  }> {
    type EpisodePageRow = {
      id: string;
      started_at_ms: number;
      intent: string | null;
      title: string;
      summary: string;
    };
    const base = `SELECT id, started_at_ms, intent, title, summary FROM episodes
       WHERE started_at_ms >= ? AND started_at_ms <= ?`;
    let rows: EpisodePageRow[];
    if (opts.limit === undefined) {
      rows = this.db
        .prepare(`${base} ORDER BY started_at_ms ASC, id ASC`)
        .all(fromMs, toMs) as EpisodePageRow[];
    } else {
      // Newest N, then restore ascending order. Rows re-fetched via
      // includeIds all sort strictly before the page (the page IS the
      // newest-N of the window), so prepending keeps the total order.
      const page = this.db
        .prepare(`${base} ORDER BY started_at_ms DESC, id DESC LIMIT ?`)
        .all(fromMs, toMs, opts.limit) as EpisodePageRow[];
      page.reverse();
      const include = (opts.includeIds ?? []).filter(
        (id) => !page.some((row) => row.id === id),
      );
      if (include.length === 0) {
        rows = page;
      } else {
        const placeholders = include.map(() => '?').join(', ');
        rows = this.db
          .prepare(
            `${base} AND id IN (${placeholders})
             ORDER BY started_at_ms ASC, id ASC`,
          )
          .all(fromMs, toMs, ...include) as EpisodePageRow[];
        rows.push(...page);
      }
    }
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(', ');
    const stepRows = this.db
      .prepare(
        `SELECT l.episode_id, s.id, s.segment_id, s.ordinal,
                s.started_at_ms, s.ended_at_ms, s.action, s.app_bundle_id, s.app_name,
                s.target, s.target_role
         FROM episode_step_links l
         JOIN semantic_steps s ON s.id = l.semantic_step_id
         WHERE l.episode_id IN (${placeholders})
         ORDER BY l.episode_id ASC, l.ordinal ASC`,
      )
      .all(...rows.map((r) => r.id)) as Array<
      { episode_id: string } & {
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
      }
    >;
    const stepsByEpisode = new Map<string, Array<Omit<SemanticStepDto, 'text'>>>();
    for (const row of stepRows) {
      let list = stepsByEpisode.get(row.episode_id);
      if (list === undefined) {
        list = [];
        stepsByEpisode.set(row.episode_id, list);
      }
      list.push({
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
      });
    }
    return rows.map((row) => ({
      id: row.id,
      startedAtMs: row.started_at_ms,
      intent: row.intent,
      title: row.title,
      summary: row.summary,
      steps: stepsByEpisode.get(row.id) ?? [],
    }));
  }

  /**
   * Timeline entries newest first, each denormalized with its display app
   * names (distinct linked-step app names) and stepCount (contracts:
   * timeline.list → episodes with appNames + stepCount). pendingJobs is a
   * queue-wide figure attached by the IPC op layer, not stored per episode.
   */
  listEpisodes(range: { from?: number; to?: number }, limit: number): EpisodeSummary[] {
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
    const rows = this.db
      .prepare(`SELECT * FROM episodes ${where} ORDER BY started_at_ms DESC LIMIT ?`)
      .all(...params, limit) as EpisodeSqlRow[];
    if (rows.length === 0) return [];

    const byEpisodeApp = new Map<string, Set<string>>();
    const byEpisodeCount = new Map<string, number>();
    const placeholders = rows.map(() => '?').join(', ');
    // Per-step rows aggregated in JS: GROUP_CONCAT would corrupt app names
    // containing the separator (e.g. "Acme, Inc.").
    const stepNames = this.db
      .prepare(
        `SELECT l.episode_id, s.app_name
         FROM episode_step_links l
         JOIN semantic_steps s ON s.id = l.semantic_step_id
         WHERE l.episode_id IN (${placeholders})`,
      )
      .all(...rows.map((r) => r.id)) as EpisodeStepNameRow[];
    for (const step of stepNames) {
      let names = byEpisodeApp.get(step.episode_id);
      if (names === undefined) {
        names = new Set<string>();
        byEpisodeApp.set(step.episode_id, names);
      }
      if (step.app_name !== null && step.app_name.length > 0) names.add(step.app_name);
      byEpisodeCount.set(step.episode_id, (byEpisodeCount.get(step.episode_id) ?? 0) + 1);
    }
    return rows.map((row) => ({
      id: row.id,
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      title: row.title,
      appNames: [...(byEpisodeApp.get(row.id) ?? [])],
      stepCount: byEpisodeCount.get(row.id) ?? 0,
    }));
  }

  /**
   * Raw FTS MATCH lookup over episodes_fts (title/summary/intent/outcome/
   * entities_flat/apps_flat), ranked by BM25, newest first on ties. The query
   * MUST pass through escapeMatchQuery() before reaching this method; it is
   * the scaffolding the M4 history-service builds on (brief-m3 §D3 item 1).
   */
  searchEpisodes(matchQuery: string, limit: number): EpisodeSummary[] {
    if (matchQuery.trim().length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM episodes_fts f
         JOIN episodes e ON e.rowid = f.rowid
         WHERE episodes_fts MATCH ?
         ORDER BY bm25(episodes_fts) ASC, e.started_at_ms DESC
         LIMIT ?`,
      )
      .all(matchQuery, limit) as EpisodeSqlRow[];
    const summaries = this.summariesFor(rows.map((r) => r.id));
    const order = new Map(rows.map((r, i) => [r.id, i]));
    return summaries.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }

  private summariesFor(ids: string[]): EpisodeSummary[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as EpisodeSqlRow[];
    // Same JS-side distinct aggregation as listEpisodes — GROUP_CONCAT would
    // split app names containing commas.
    const byEpisodeApp = new Map<string, Set<string>>();
    const byEpisodeCount = new Map<string, number>();
    const stepNames = this.db
      .prepare(
        `SELECT l.episode_id, s.app_name
         FROM episode_step_links l
         JOIN semantic_steps s ON s.id = l.semantic_step_id
         WHERE l.episode_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as EpisodeStepNameRow[];
    for (const step of stepNames) {
      let names = byEpisodeApp.get(step.episode_id);
      if (names === undefined) {
        names = new Set<string>();
        byEpisodeApp.set(step.episode_id, names);
      }
      if (step.app_name !== null && step.app_name.length > 0) names.add(step.app_name);
      byEpisodeCount.set(step.episode_id, (byEpisodeCount.get(step.episode_id) ?? 0) + 1);
    }
    return rows.map((row) => ({
      id: row.id,
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      title: row.title,
      appNames: [...(byEpisodeApp.get(row.id) ?? [])],
      stepCount: byEpisodeCount.get(row.id) ?? 0,
    }));
  }

  countEpisodes(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as CountRow;
    return row.n;
  }

  /**
   * True when at least one episode already covers ANY of these steps — the
   * re-delivery guard making summarize_segment idempotent even if the worker
   * crashes between persist and job-complete (brief-m3 §D3 item 2).
   * Window-aware, not a bare per-segment probe: suffix-chained jobs summarize
   * disjoint ordinal windows of ONE segment, so "any episode exists for this
   * segment" would skip every follow-up window and lose the tail on job
   * re-delivery.
   *
   * Primary signal (migration 013): episodes stamped with segment_id and the
   * max ORDINAL of their covered steps. Timestamps were the wrong latch key:
   * the earlier interval-intersection probe matched ANY episode of the
   * segment whose [started_at_ms, ended_at_ms] touched the window's range,
   * so with clock-skewed event timestamps inside one segment a
   * never-summarized chained window (first step starting before the prior
   * window's end) false-positived — persistTx never ran and the tail was
   * permanently lost. Append-order ordinals are monotonic per segment no
   * matter how timestamps regress, so `last_step_ordinal >= window max
   * ordinal` skips exactly the already-covered prefix: a same-window
   * re-delivery hits its own stamp, while the strictly-higher-ordinal next
   * window proceeds.
   *
   * Three tiers, first hit wins:
   * 1. Ordinal probe — 013-stamped rows (segment_id + last_step_ordinal
   *    set). Only for these does the latch survive retention
   *    purgeStepsOlderThan deleting episode_step_links after 30d.
   * 2. Legacy interval probe — rows whose segment_id was already stamped by
   *    migration-012-era runtime code but whose links were purged by
   *    retention before/after the upgrade, so 013's backfill left
   *    last_step_ordinal NULL. The ordinal probe can never match NULL, so
   *    this tier restores the round-31 interval intersection frozen to the
   *    legacy class via `last_step_ordinal IS NULL`: post-013 rows — the
   *    clock-skew false-positive hazard above — are untouched.
   * 3. Link fallback — pre-012 rows carry NULL segment_id/last_step_ordinal
   *    and are detected through their links, exactly as before.
   * Accepted gap: rows whose links were purged BEFORE migration 013 ran have
   * segment_id NULL too, are invisible to every tier, and still re-summarize
   * (round-31 semantics; accepted, shrinking population — episodes are never
   * purged, only their links).
   * Accepted boundary-touching hazard (tier 2, by design): for a legacy
   * NULL-ordinal row whose stored ended_at_ms exactly equals the next window's
   * first step started_at_ms (contiguous steps), the inclusive interval probe
   * (`ended_at_ms >= ?`) latches and that chained window's tail is skipped
   * forever. This is frozen to the shrinking pre-013-purge population —
   * post-013 rows use the ordinal probe and are immune — and round-31
   * semantics accept it.
   */
  hasEpisodesForSteps(
    steps: ReadonlyArray<{
      id: string;
      segmentId: string;
      startedAtMs: number;
      endedAtMs: number;
      ordinal: number;
    }>,
  ): boolean {
    if (steps.length === 0) return false;
    const first = steps[0];
    if (first === undefined) return false;
    let maxOrdinal = first.ordinal;
    let minWindowStartedAtMs = first.startedAtMs;
    let maxWindowEndedAtMs = first.endedAtMs;
    for (const step of steps) {
      if (step.ordinal > maxOrdinal) maxOrdinal = step.ordinal;
      if (step.startedAtMs < minWindowStartedAtMs) minWindowStartedAtMs = step.startedAtMs;
      if (step.endedAtMs > maxWindowEndedAtMs) maxWindowEndedAtMs = step.endedAtMs;
    }
    let segStmt = this.hasEpisodeForSegmentStmt;
    if (segStmt === undefined) {
      segStmt = this.db.prepare(
        `SELECT 1 FROM episodes
         WHERE segment_id = ? AND last_step_ordinal >= ?
         LIMIT 1`,
      );
      this.hasEpisodeForSegmentStmt = segStmt;
    }
    if (segStmt.get(first.segmentId, maxOrdinal) !== undefined) {
      return true;
    }
    // Tier 2: legacy stamped-but-purged rows (segment_id set, last_step_
    // ordinal NULL because 013's backfill had no links left to read).
    let legacyStmt = this.hasLegacyIntervalStmt;
    if (legacyStmt === undefined) {
      legacyStmt = this.db.prepare(
        `SELECT 1 FROM episodes
         WHERE segment_id = ? AND last_step_ordinal IS NULL
           AND started_at_ms <= ? AND ended_at_ms >= ?
         LIMIT 1`,
      );
      this.hasLegacyIntervalStmt = legacyStmt;
    }
    if (
      legacyStmt.get(first.segmentId, maxWindowEndedAtMs, minWindowStartedAtMs) !== undefined
    ) {
      return true;
    }
    // Legacy fallback: pre-013 episodes carry segment_id/last_step_ordinal
    // IS NULL and are only visible through their episode_step_links rows.
    // Prepared statements are cached per IN-list size, BOUNDED: the sole
    // caller (the summarizer latch) slices to CONSTANTS.summarizeMaxInputSteps,
    // so the +1 in the bound is defensive slack only; larger sizes prepare a
    // fresh uncached statement each call.
    const stepIds = steps.map((step) => step.id);
    let stmt = this.hasEpisodesStmts.get(stepIds.length);
    if (stmt === undefined) {
      stmt = this.db.prepare(
        `SELECT 1 FROM episode_step_links
         WHERE semantic_step_id IN (${stepIds.map(() => '?').join(', ')})
         LIMIT 1`,
      );
      if (stepIds.length <= CONSTANTS.summarizeMaxInputSteps + 1) {
        this.hasEpisodesStmts.set(stepIds.length, stmt);
      }
    }
    return stmt.get(...stepIds) !== undefined;
  }
}
