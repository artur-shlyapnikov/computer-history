import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoalescedStep } from '../src/processing/event-coalescer.js';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository, escapeMatchQuery } from '../src/db/episodes-repository.js';
import { HistoryService, MAX_SEARCH_LIMIT } from '../src/services/history-service.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed clock: deterministic recency math

/**
 * Golden corpus for the pinned ranking math (spec §3.18, brief-m4 §D4 item 7):
 * score = 0.8·normBM25 + 0.2·recency, normBM25 = (n − rank)/n over the FTS
 * candidate set, recency = exp(−age_days/30) on episode.start, recency OFF for
 * explicit from/to. The expected BM25 ranks are derived from SQLite itself (the
 * corpus is built so the relevance order is unambiguous); the golden asserts
 * the FORMULA on top of those ranks plus the ordering guarantees.
 */
describe('history-service ranking golden corpus', () => {
  let home: string;
  let db: Db;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let service: HistoryService;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-history-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    segments = new SegmentsRepository(db);
    episodes = new EpisodesRepository(db);
    service = new HistoryService(db, () => NOW);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function step(segmentId: string, at: number, text: string, appName = 'Safari'): string {
    const coalesced: CoalescedStep = {
      action: 'edit_text',
      appBundleId: 'com.example.app',
      appName,
      targetRole: null,
      target: 'editor',
      text,
      startedAtMs: at,
      endedAtMs: at + 1000,
      firstEventId: ulid(at),
      lastEventId: ulid(at + 999),
      eventCount: 3,
    };
    return segments.appendStep(segmentId, coalesced, { text, target: 'editor', appName }, at);
  }

  function episode(opts: {
    start: number;
    end: number;
    title: string;
    summary: string;
    stepIds: string[];
    apps?: string[];
  }): string {
    const [id] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: opts.start,
          endedAtMs: opts.end,
          title: opts.title,
          summary: opts.summary,
          intent: null,
          outcome: null,
          apps: opts.apps ?? ['Safari'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: opts.stepIds.map((id) => ({ id })),
        },
      ],
      opts.start,
    );
    return id!;
  }

  /** Expected score for a hit at bm25 rank r within n candidates. */
  function expectedScore(r: number, n: number, start: number, recencyOn: boolean): number {
    const norm = (n - r) / n;
    if (!recencyOn) return 0.8 * norm;
    const ageDays = Math.max(0, NOW - start) / DAY;
    return 0.8 * norm + 0.2 * Math.exp(-ageDays / 30);
  }

  it('ranks textual episode hits by 0.8·normBM25 + 0.2·recency within ε', () => {
    const segment = segments.createOpen(NOW - 40 * DAY, ulid(), NOW);
    // Three candidates, unambiguous relevance order: webhook×3, webhook×2, webhook×1.
    const a = episode({
      start: NOW - 40 * DAY,
      end: NOW - 40 * DAY + 3_600_000,
      title: 'webhook webhook webhook failures',
      summary: 'webhook',
      stepIds: [step(segment.id, NOW - 40 * DAY, 'filler')],
    });
    const b = episode({
      start: NOW - 5 * DAY,
      end: NOW - 5 * DAY + 3_600_000,
      title: 'webhook webhook retries',
      summary: 'other',
      stepIds: [step(segment.id, NOW - 5 * DAY, 'filler2')],
    });
    const c = episode({
      start: NOW - 1 * DAY,
      end: NOW - 1 * DAY + 3_600_000,
      title: 'webhook postmortem',
      summary: 'other2',
      stepIds: [step(segment.id, NOW - 1 * DAY, 'filler3')],
    });

    const result = service.historySearch({ query: 'webhook' });
    expect(result.hits).toHaveLength(3);

    // Derive the actual BM25 rank order from SQLite (corpus-independent truth).
    const ranked = (
      db
        .prepare(
          `SELECT e.id FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
           WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts) ASC`,
        )
        .all(escapeMatchQuery('webhook')) as Array<{ id: string }>
    ).map((r) => r.id);
    const n = ranked.length;
    const starts = new Map([
      [a, NOW - 40 * DAY],
      [b, NOW - 5 * DAY],
      [c, NOW - 1 * DAY],
    ]);

    result.hits.forEach((hit) => {
      const r = ranked.indexOf(hit.episodeId);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeCloseTo(expectedScore(r, n, starts.get(hit.episodeId)!, true), 10);
    });
    // Ordering is score-descending.
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
  });

  it('disables the recency term when from/to are explicit', () => {
    const segment = segments.createOpen(NOW - 40 * DAY, ulid(), NOW);
    episode({
      start: NOW - 40 * DAY,
      end: NOW - 40 * DAY + 3_600_000,
      title: 'webhook deep dive',
      summary: 'x',
      stepIds: [step(segment.id, NOW - 40 * DAY, 'filler')],
    });

    const withRange = service.historySearch({
      query: 'webhook',
      from: NOW - 45 * DAY,
      to: NOW,
    });
    expect(withRange.hits).toHaveLength(1);
    // rank 0 of 1 → normBM25 = 1 → exactly 0.8, no recency contribution.
    expect(withRange.hits[0]!.score).toBeCloseTo(0.8, 10);

    const noRange = service.historySearch({ query: 'webhook' });
    expect(noRange.hits[0]!.score).toBeGreaterThan(0.8); // recency added
  });

  it('merges both scopes into one score-ordered list with step provenance', () => {
    const segment = segments.createOpen(NOW - 10 * DAY, ulid(), NOW);
    const epStart = NOW - 10 * DAY;
    const stepId = step(segment.id, epStart + 1000, 'kubernetes deployment rollback');
    episode({
      start: epStart,
      end: epStart + 3_600_000,
      title: 'kubernetes incident',
      summary: 'unrelated words here',
      stepIds: [stepId],
      apps: ['Terminal'],
    });

    const result = service.historySearch({ query: 'kubernetes', scope: 'both' });
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(result.hits.map((h) => h.kind));
    expect(kinds).toContain('episode');
    expect(kinds).toContain('step');

    const stepHit = result.hits.find((h) => h.kind === 'step')!;
    expect(stepHit.kind === 'step' && stepHit.stepId).toBe(stepId);
    // Step provenance carries the OWNING EPISODE span + its app names.
    expect(stepHit.startedAtMs).toBe(epStart);
    expect(stepHit.appNames).toEqual(['Terminal']);
    // Scores descend across the merged list.
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
  });

  it('orders non-textual queries by startedAtMs desc with zero scores', () => {
    const segment = segments.createOpen(NOW - 3 * DAY, ulid(), NOW);
    episode({
      start: NOW - 3 * DAY,
      end: NOW - 3 * DAY + 1000,
      title: 'old',
      summary: '',
      stepIds: [step(segment.id, NOW - 3 * DAY, 'a')],
    });
    episode({
      start: NOW - 1 * DAY,
      end: NOW - 1 * DAY + 1000,
      title: 'new',
      summary: '',
      stepIds: [step(segment.id, NOW - 1 * DAY, 'b')],
    });
    episode({
      start: NOW - 2 * DAY,
      end: NOW - 2 * DAY + 1000,
      title: 'middle',
      summary: '',
      stepIds: [step(segment.id, NOW - 2 * DAY, 'c')],
    });

    const result = service.historySearch({});
    expect(result.hits.map((h) => h.episodeId)).toHaveLength(3);
    const starts = result.hits.map((h) => h.startedAtMs);
    expect([...starts].sort((x, y) => y - x)).toEqual(starts);
    for (const hit of result.hits) expect(hit.score).toBe(0);
  });

  it('clamps limit into [1, 50] and defaults to 10', () => {
    const segment = segments.createOpen(NOW - 60 * DAY, ulid(), NOW);
    const stepIds: string[] = [];
    const episodesToInsert = [];
    for (let i = 0; i < 60; i++) {
      const at = NOW - 60 * DAY + i * 1000;
      stepIds.push(step(segment.id, at, `filler ${i} common`));
      episodesToInsert.push({
        startedAtMs: at,
        endedAtMs: at + 100,
        title: `common episode ${i}`,
        summary: 'common',
        intent: null,
        outcome: null,
        apps: ['Safari'],
        entities: [],
        summaryModel: 'm',
        summaryPromptVersion: 'v1',
        steps: [{ id: stepIds[i]! }],
      });
    }
    episodes.insertEpisodesWithLinks(episodesToInsert, NOW);

    expect(service.historySearch({ query: 'common' }).hits).toHaveLength(10);
    expect(service.historySearch({ query: 'common', limit: 0 }).hits).toHaveLength(1);
    expect(service.historySearch({ query: 'common', limit: -5 }).hits).toHaveLength(1);
    expect(service.historySearch({ query: 'common', limit: 1000 }).hits).toHaveLength(
      MAX_SEARCH_LIMIT,
    );
    expect(service.historySearch({ query: 'common', limit: 1000 }).hits).toHaveLength(50);
    expect(service.historySearch({ query: 'common', limit: 3 }).hits).toHaveLength(3);
  });

  it('applies apps and time filters on the owning episode', () => {
    const segment = segments.createOpen(NOW - 5 * DAY, ulid(), NOW);
    episode({
      start: NOW - 5 * DAY,
      end: NOW - 5 * DAY + 1000,
      title: 'webhook safari work',
      summary: '',
      stepIds: [step(segment.id, NOW - 5 * DAY, 'x')],
      apps: ['Safari'],
    });
    episode({
      start: NOW - 2 * DAY,
      end: NOW - 2 * DAY + 1000,
      title: 'webhook slack work',
      summary: '',
      stepIds: [step(segment.id, NOW - 2 * DAY, 'y', 'Slack')],
      apps: ['Slack'],
    });

    expect(service.historySearch({ query: 'webhook', apps: ['Slack'] }).hits).toHaveLength(1);
    expect(service.historySearch({ query: 'webhook', from: NOW - 3 * DAY }).hits).toHaveLength(1);
    expect(service.historySearch({ query: 'webhook', to: NOW - 3 * DAY }).hits).toHaveLength(1);
    // Non-textual filter-only search over steps scope.
    const stepsOnly = service.historySearch({ apps: ['Slack'], scope: 'steps' });
    expect(stepsOnly.hits).toHaveLength(1);
    expect(stepsOnly.hits[0]!.kind).toBe('step');
  });

  it('survives adversarial queries via escapeMatchQuery (quotes, NEAR, asterisks, control chars, empty)', () => {
    const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
    episode({
      start: NOW - DAY,
      end: NOW - DAY + 1000,
      title: 'plain topic',
      summary: 'stable content',
      stepIds: [step(segment.id, NOW - DAY, 'z')],
    });
    const adversarial = [
      '"quoted phrase" OR 1',
      'a NEAR/100 b NOT c',
      'wild*card*',
      'tab\tnewline\nctl\u0007char',
      '   ',
      '',
      ')( AND OR *',
    ];
    for (const query of adversarial) {
      // MUST NOT throw; sanitized to tokens (or nothing).
      expect(() => service.historySearch({ query })).not.toThrow();
      const hits = service.historySearch({ query });
      expect(Array.isArray(hits.hits)).toBe(true);
    }
    expect(service.historySearch({ query: 'plain stable' }).hits).toHaveLength(1);
    // S5: a SUPPLIED query that sanitizes to zero tokens yields zero hits;
    // only an OMITTED query degrades to the newest-N listing.
    expect(service.historySearch({ query: '' }).hits).toHaveLength(0);
    expect(service.historySearch({}).hits).toHaveLength(1);
  });

  it('produces SQLite snippet() markers in textual hits', () => {
    const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
    episode({
      start: NOW - DAY,
      end: NOW - DAY + 1000,
      title: 'payments integration',
      summary: 'investigated webhook failures end to end',
      stepIds: [step(segment.id, NOW - DAY, 'note')],
    });
    const hits = service.historySearch({ query: 'webhook failures' });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]!.snippet).toContain('<b>');
    expect(hits.hits[0]!.snippet).toContain('</b>');
  });

  it('adds the recency bonus beyond the page: fresh deep hit outranks stale shallow hits from the other leg', () => {
    // Steps leg: 4 stale 'kubernetes' hits, BM25 order pinned by term
    // frequency (equal doc lengths ⇒ tf strictly orders bm25).
    const staleSegment = segments.createOpen(NOW - 60 * DAY, ulid(), NOW);
    const staleStepIds = [
      step(staleSegment.id, NOW - 60 * DAY, 'kubernetes kubernetes kubernetes kubernetes'),
      step(staleSegment.id, NOW - 60 * DAY + 1_000, 'kubernetes kubernetes kubernetes'),
      step(staleSegment.id, NOW - 60 * DAY + 2_000, 'kubernetes kubernetes'),
      step(staleSegment.id, NOW - 60 * DAY + 3_000, 'kubernetes'),
    ];
    for (const [i, stepId] of staleStepIds.entries()) {
      episode({
        start: NOW - 60 * DAY,
        end: NOW - 60 * DAY + 3_600_000,
        title: `stale session ${i}`,
        summary: 'unrelated filler words only',
        stepIds: [stepId],
      });
    }

    // Episode leg: 9 'kubernetes' candidates (> limit=3) so the fresh episode
    // lands at bm25 rank 3 ≥ limit — the rank the old guard used to skip.
    // Seniors are ancient (recency ≈ 0); tf descending pins their order.
    const ANCIENT = NOW - 365 * DAY;
    const tfs = [8, 7, 6, 5, 4, 3, 2, 1];
    const ancientIds = tfs.map((tf, i) =>
      episode({
        start: ANCIENT,
        end: ANCIENT + 3_600_000,
        title: `ancient archive ${i}`,
        summary: `${'kubernetes '.repeat(tf)}${'filler '.repeat(8 - tf)}`.trim(),
        stepIds: [],
      }),
    );
    const freshStepId = step(staleSegment.id, NOW, 'kubernetes');
    const freshId = episode({
      start: NOW,
      end: NOW + 3_600_000,
      title: 'fresh fix',
      summary: `${'kubernetes '.repeat(5)}${'filler '.repeat(3)}`.trim(),
      stepIds: [freshStepId],
    });

    const result = service.historySearch({ query: 'kubernetes', scope: 'both', limit: 3 });
    const scores = new Map(result.hits.map((h) => [h.episodeId, h.score]));

    // Fresh deep hit (leg rank 3 ≥ limit) makes the page and its score
    // follows the pinned formula UNCONDITIONALLY — recency included even
    // though it sits beyond the page boundary in its own leg. Under the old
    // rank<limit guard it scored bare 0.8·normBM25 = 0.8·6/9 ≈ 0.533, lost
    // to the stale steps hit at ≈ 0.627, and fell off the page entirely.
    expect(result.hits).toHaveLength(3);
    expect(result.hits[2]!.episodeId).toBe(freshId);
    expect(scores.get(freshId)).toBeCloseTo(expectedScore(3, 9, NOW, true), 9);
    expect(scores.get(freshId)!).toBeGreaterThan(0.8 * (6 / 9));

    // It climbs past the shallow-but-stale steps hits: the rank-1 stale step
    // (≈ 0.627) used to slip past it and is no longer on the page.
    expect(result.hits.some((h) => h.kind === 'step' && h.stepId === staleStepIds[1])).toBe(false);

    // Deep-rank scores across BOTH legs follow 0.8·normBM25 + 0.2·recency.
    expect(result.hits[0]!.kind === 'step' && result.hits[0]!.stepId).toBe(staleStepIds[0]);
    expect(result.hits[0]!.score).toBeCloseTo(expectedScore(0, 4, NOW - 60 * DAY, true), 9);
    const topAncient = result.hits.find((h) => h.episodeId === ancientIds[0]);
    expect(topAncient!.score).toBeCloseTo(expectedScore(0, 9, ANCIENT, true), 9);
  });

  // R9-T3: parseAppNames malformed-payload fallbacks. The repository always
  // writes a JSON array, so hostile payloads are injected with raw SQL —
  // exactly what a legacy/corrupt row would look like at read time.
  function corruptApps(id: string, raw: string): void {
    db.prepare('UPDATE episodes SET apps_json = ? WHERE id = ?').run(raw, id);
  }

  it('a non-JSON apps_json degrades to an empty appNames list without throwing', () => {
    const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
    const id = episode({
      start: NOW - DAY,
      end: NOW - DAY + 1000,
      title: 'corruptapps needle',
      summary: '',
      stepIds: [step(segment.id, NOW - DAY, 'note')],
    });
    corruptApps(id, 'not json{');

    const result = service.historySearch({ query: 'corruptapps' });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.kind).toBe('episode');
    expect(hit.appNames).toEqual([]);
    // The rest of the hit mapping is intact.
    expect(hit.episodeId).toBe(id);
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(hit.score).toBeGreaterThan(0);
  });

  it('non-array JSON and non-string array members fall back per the guards', () => {
    const stringId = episode({
      start: NOW - DAY,
      end: NOW - DAY + 1000,
      title: 'corruptapps scalar',
      summary: '',
      stepIds: [],
    });
    const mixedId = episode({
      start: NOW - DAY + 1000,
      end: NOW - DAY + 2000,
      title: 'corruptapps mixed',
      summary: '',
      stepIds: [],
    });
    corruptApps(stringId, '"just a string"');
    corruptApps(mixedId, '[1, "Safari", null, 42]');

    const hits = service.historySearch({ query: 'corruptapps' }).hits;
    expect(hits).toHaveLength(2);
    const byId = new Map(hits.map((h) => [h.episodeId, h]));
    // isArray guard: JSON string → [].
    expect(byId.get(stringId)!.appNames).toEqual([]);
    // typeof filter: only the string member survives.
    expect(byId.get(mixedId)!.appNames).toEqual(['Safari']);
  });

  it('step hits apply the same fallback through the owning-episode join', () => {
    const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
    const stepId = step(segment.id, NOW - DAY, 'corruptapps step needle');
    const id = episode({
      start: NOW - DAY,
      end: NOW - DAY + 1000,
      title: 'corruptapps parent',
      summary: '',
      stepIds: [stepId],
    });
    corruptApps(id, '{broken');

    const result = service.historySearch({ query: 'corruptapps', scope: 'both' });
    const stepHit = result.hits.find((h) => h.kind === 'step')!;
    expect(stepHit.kind === 'step' && stepHit.stepId).toBe(stepId);
    expect(stepHit.appNames).toEqual([]);
  });
});
