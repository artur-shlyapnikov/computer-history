import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoalescedStep } from '../src/processing/event-coalescer.js';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { HistoryService } from '../src/services/history-service.js';

const NOW = 1_800_000_000_000; // fixed clock: deterministic ranking math

/**
 * Unlinked steps (the §3.24 LLM-outage scenario: no episode exists yet) must
 * survive episode-level apps/from/to filters via the
 * `l.episode_id IS NULL OR (...)` soft-join disjunct, falling back to their
 * OWN provenance; linked steps stay filtered. Also pins CANDIDATE_CAP = 200:
 * applyScores' normalization window n over each FTS leg.
 */
describe('history-service unlinked steps under episode-level filters', () => {
  let home: string;
  let db: Db;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let service: HistoryService;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-history-unlinked-'));
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
          steps: opts.stepIds.map((stepId) => ({ id: stepId })),
        },
      ],
      opts.start,
    );
    return id!;
  }

  it('keeps an unlinked step visible under an apps filter, with its own provenance', () => {
    const segment = segments.createOpen(NOW, ulid(), NOW);
    const linked = step(segment.id, NOW, 'alpha deploy');
    episode({ start: NOW, end: NOW + 60_000, title: 'alpha session', summary: 'alpha', stepIds: [linked] });
    const unlinked = step(segment.id, NOW + 1_000, 'alpha debug', 'Xcode');

    const result = service.historySearch({ query: 'alpha', apps: ['Safari'], scope: 'both' });

    const stepHits = result.hits.filter((h) => h.kind === 'step');
    const byStep = new Map(stepHits.map((h) => [h.stepId, h]));
    expect(byStep.has(linked)).toBe(true);
    expect(byStep.has(unlinked)).toBe(true);
    // The unlinked hit falls back to its OWN step provenance per COALESCE.
    const ownProvenance = byStep.get(unlinked)!;
    expect(ownProvenance.episodeId).toBe('');
    expect(ownProvenance.appName).toBe('Xcode');
    expect(ownProvenance.startedAtMs).toBe(NOW + 1_000);
  });

  it('keeps an unlinked step visible under a time window its own timestamp does not satisfy', () => {
    const segment = segments.createOpen(NOW, ulid(), NOW);
    const unlinked = step(segment.id, NOW, 'beta notes');
    const outsideLinked = step(segment.id, NOW + 2_000, 'beta review');
    episode({
      start: NOW + 2_000,
      end: NOW + 62_000,
      title: 'beta session',
      summary: 'beta',
      stepIds: [outsideLinked],
    });

    // Window starts far beyond every seeded timestamp.
    const result = service.historySearch({
      query: 'beta',
      from: NOW + 1_000_000,
      scope: 'both',
    });

    const stepIds = new Set(result.hits.filter((h) => h.kind === 'step').map((h) => h.stepId));
    expect(stepIds.has(unlinked)).toBe(true); // e.-predicate never applies to it
    expect(stepIds.has(outsideLinked)).toBe(false); // linked control stays filtered
  });

  it('still filters LINKED steps by episode-level apps (negative control)', () => {
    const segment = segments.createOpen(NOW, ulid(), NOW);
    const linked = step(segment.id, NOW, 'gamma research');
    episode({ start: NOW, end: NOW + 60_000, title: 'gamma session', summary: 'gamma', stepIds: [linked] });

    const result = service.historySearch({ query: 'gamma', apps: ['Firefox'], scope: 'both' });

    expect(result.hits).toHaveLength(0);
  });

  it('normalizes scores over a 200-candidate window even with 210 FTS matches', () => {
    const rows = Array.from({ length: 210 }, (_, i) => ({
      startedAtMs: NOW + i,
      endedAtMs: NOW + i + 1_000,
      title: `delta session ${i}`,
      summary: 'delta body',
      intent: null,
      outcome: null,
      apps: ['Safari'],
      entities: [],
      summaryModel: 'test-model',
      summaryPromptVersion: 'v1',
      steps: [],
    }));
    episodes.insertEpisodesWithLinks(rows, NOW);

    // recency OFF via explicit from (golden-corpus convention).
    const result = service.historySearch({ query: 'delta', from: 0, limit: 50 });

    expect(result.hits).toHaveLength(50);
    // Second-ranked hit: n = 200 (CANDIDATE_CAP), rank 1 → 0.8·199/200.
    expect(result.hits[1]?.score).toBeCloseTo((0.8 * 199) / 200, 9);
    expect(result.hits[0]?.score).toBeCloseTo(0.8, 9);
  });
});
