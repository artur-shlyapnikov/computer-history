import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoalescedStep } from '../src/processing/event-coalescer.js';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import {
  EpisodesRepository,
  escapeMatchQuery,
  MAX_MATCH_TOKENS,
  safeMatchQuery,
} from '../src/db/episodes-repository.js';
import { HistoryService } from '../src/services/history-service.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/**
 * Search-input sanitization behaviors (round-6 S1/S4/S5): NFC + combining
 * marks survive tokenization, CJK terms match as unicode61 run prefixes, the
 * token cap bounds the FTS5 MATCH parse, and a supplied-but-empty-sanitized
 * query yields zero hits instead of the newest-N listing.
 */
describe('search sanitization', () => {
  let home: string;
  let db: Db;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let service: HistoryService;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-search-'));
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

  function step(segmentId: string, at: number, text: string): string {
    const coalesced: CoalescedStep = {
      action: 'edit_text',
      appBundleId: 'com.example.app',
      appName: 'Notes',
      targetRole: null,
      target: 'editor',
      text,
      startedAtMs: at,
      endedAtMs: at + 1000,
      firstEventId: ulid(at),
      lastEventId: ulid(at + 999),
      eventCount: 3,
    };
    return segments.appendStep(segmentId, coalesced, { text, target: 'editor', appName: 'Notes' }, at);
  }

  function episodeWithStep(text: string): string {
    const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
    const stepId = step(segment.id, NOW - DAY, text);
    const [id] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW - DAY,
          endedAtMs: NOW - DAY + 1000,
          title: 'seed',
          summary: text,
          intent: null,
          outcome: null,
          apps: ['Notes'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: [{ id: stepId }],
        },
      ],
      NOW - DAY,
    );
    return id!;
  }

  describe('safeMatchQuery', () => {
    it('NFC-normalizes so NFD input keeps its base word (S4)', () => {
      expect(safeMatchQuery('cafe\u0301')).toBe('café');
      // Non-precomposable sequences (cedilla + acute has no single code
      // point) keep their marks via \p{M} instead of being dropped wholesale.
      expect(safeMatchQuery('a\u0327\u0301b')).toBe('á̧b');
    });

    it('still drops FTS5 operators and syntax tokens', () => {
      expect(safeMatchQuery('a NEAR/10 b NOT (c)')).toBe('a b');
      expect(safeMatchQuery('AND OR NOT NEAR')).toBe('');
    });

    it('caps the token count so the FTS5 parse stays bounded (S1)', () => {
      const tokens = Array.from({ length: 500 }, (_, i) => `tok${i}`);
      const out = safeMatchQuery(tokens.join(' '));
      expect(out.split(' ')).toHaveLength(MAX_MATCH_TOKENS);
      expect(out).toContain('tok0');
      expect(out).toContain(`tok${MAX_MATCH_TOKENS - 1}`);
      expect(out).not.toContain('tok64');
    });

    it('appends * to CJK tokens for unicode61 run-prefix matching', () => {
      expect(safeMatchQuery('東京')).toBe('東京*');
      expect(safeMatchQuery('東京タワー')).toBe('東京タワー*');
      // Already-prefixed tokens are left alone; latin tokens are not widened.
      expect(safeMatchQuery('webhook*')).toBe('webhook*');
      expect(safeMatchQuery('webhook')).toBe('webhook');
    });
  });

  describe('against a seeded database', () => {
    it('matches NFD-accented queries against NFC content (S4)', () => {
      episodeWithStep('café planning notes');
      const hits = service.historySearch({ query: 'cafe\u0301' });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]!.score).toBeGreaterThan(0);
    });

    it('matches CJK queries as run prefixes (S4)', () => {
      episodeWithStep('東京タワーの近くで会議');
      expect(service.historySearch({ query: '東京' }).hits).toHaveLength(1);
      expect(service.historySearch({ query: '東京タワー' }).hits).toHaveLength(1);
      // Documented unicode61 limitation: mid-run substrings cannot match.
      expect(service.historySearch({ query: '京タ' }).hits).toHaveLength(0);
    });

    it('ignores tokens beyond the cap instead of parsing them (S1)', () => {
      const fillers = Array.from({ length: MAX_MATCH_TOKENS - 1 }, (_, i) => `filler${i}`);
      episodeWithStep([...fillers, 'needle'].join(' '));
      // Exactly at the cap every token reaches FTS5 and matches.
      const atCap = [...fillers, 'needle'].join(' ');
      expect(service.historySearch({ query: atCap }).hits).toHaveLength(1);
      // One token over the cap: the LAST token ('needle') is dropped, so the
      // implicit-AND query can no longer match — the parse stays bounded.
      const overCap = ['zzz', ...fillers, 'needle'].join(' ');
      expect(service.historySearch({ query: overCap }).hits).toHaveLength(0);
    });

    it('returns zero hits for a supplied query that sanitizes empty, listing only when omitted (S5)', () => {
      episodeWithStep('webhook deliveries failed');
      for (const query of ['*', '🎉🎊', '', '   ', ')( AND OR *']) {
        expect(service.historySearch({ query }).hits, JSON.stringify(query)).toHaveLength(0);
      }
      // Omitted query keeps the intended newest-N listing behavior.
      const listed = service.historySearch({});
      expect(listed.hits).toHaveLength(1);
      expect(listed.hits[0]!.score).toBe(0);
    });

    it('splits punctuation-joined tokens instead of dropping them whole (round-25)', () => {
      const segment = segments.createOpen(NOW - DAY, ulid(), NOW);
      const stepId1 = step(segment.id, NOW - DAY, 'webhook v2 rollout finished');
      const stepId2 = step(segment.id, NOW - DAY + 2000, 'webhook v3 planning');
      episodes.insertEpisodesWithLinks(
        [
          {
            startedAtMs: NOW - DAY,
            endedAtMs: NOW - DAY + 1000,
            title: 'seed',
            summary: stepId1 && 'webhook v2 rollout finished',
            intent: null,
            outcome: null,
            apps: ['Notes'],
            entities: [],
            summaryModel: 'test-model',
            summaryPromptVersion: 'v1',
            steps: [{ id: stepId1 }],
          },
          {
            startedAtMs: NOW - DAY + 2000,
            endedAtMs: NOW - DAY + 3000,
            title: 'seed',
            summary: 'webhook v3 planning',
            intent: null,
            outcome: null,
            apps: ['Notes'],
            entities: [],
            summaryModel: 'test-model',
            summaryPromptVersion: 'v1',
            steps: [{ id: stepId2 }],
          },
        ],
        NOW - DAY,
      );
      // Whole-token drops silently narrowed recall: 'webhook-v2' used to
      // sanitize to '' and return zero hits for data containing 'webhook'.
      expect(service.historySearch({ query: 'webhook-v2' }).hits).toHaveLength(1);
      expect(service.historySearch({ query: 'rollout.finished' }).hits).toHaveLength(1);
      // A leading '-' is punctuation, not FTS5 negation: search the word.
      expect(service.historySearch({ query: '-webhook' }).hits).toHaveLength(2);
      // Prefix intent survives the split, attached to the last run.
      expect(service.historySearch({ query: 'webhook v*' }).hits).toHaveLength(2);
    });
  });

  it('escapeMatchQuery still strips phrase/control syntax before sanitization', () => {
    expect(escapeMatchQuery('"webhook" failures\u0007')).toBe('webhook failures');
  });
});
