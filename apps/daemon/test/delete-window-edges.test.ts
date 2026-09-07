import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import type { ActivityEvent } from '@computer-history/protocol';

import type { Db } from '../src/db/database.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { WorkflowsRepository } from '../src/db/workflows-repository.js';
import { DeleteService } from '../src/services/delete-service.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import type { Logger } from '../src/logging.js';

/**
 * One-sided windows, inclusive-overlap edge values, instant windows, chunked
 * victim loops and the whole-cascade transaction guarantee of DeleteService
 * (spec §3.23). Complements the mid-band/'all' coverage of
 * delete-service.test.ts.
 */

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY_MS = 86_400_000;

describe('DeleteService window edges and rollback', () => {
  let db: Db;
  let home: string;
  let events: EventsRepository;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let workflows: WorkflowsRepository;
  const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };
  let stepSeq = 0;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-delete-edges-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    events = new EventsRepository(db);
    segments = new SegmentsRepository(db);
    episodes = new EpisodesRepository(db);
    memories = new MemoriesRepository(db);
    workflows = new WorkflowsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function makeService(over: { purge?: () => number } = {}): DeleteService {
    return new DeleteService({
      db,
      workflows: over.purge !== undefined ? { purgeCandidatesBelowThreshold: over.purge } : workflows,
      logger,
      now: () => NOW,
    });
  }

  function seedRawEvent(observedAtMs: number): string {
    const id = ulid(observedAtMs);
    const event: ActivityEvent = {
      id,
      observedAt: observedAtMs,
      source: 'accessibility',
      app: { bundleId: 'com.test.App', name: 'TestApp', pid: 1 },
      window: { title: 'Window' },
      action: 'click',
      target: { role: 'AXButton', label: 'Send' },
      contentPolicy: 'allow',
    };
    const result = events.insertBatch([event], observedAtMs);
    expect(result.accepted, JSON.stringify(result)).toBe(1);
    return id;
  }

  /** One finalized segment carrying ONE step spanning [startMs, endMs]. */
  function seedStep(token: string, startMs: number, endMs: number): string {
    const segment = segments.createOpen(startMs, `first-${token}`, startMs);
    stepSeq += 1;
    const step: CoalescedStep = {
      action: 'edit_text',
      appBundleId: 'com.test.App',
      appName: 'TestApp',
      target: 'field',
      text: `${token} body text`,
      startedAtMs: startMs,
      endedAtMs: endMs,
      firstEventId: `fe-${stepSeq}`,
      lastEventId: `le-${stepSeq}`,
      eventCount: 1,
      targetRole: null,
    };
    segments.appendStep(segment.id, step, {
      text: step.text,
      target: step.target,
      appName: step.appName,
    });
    segments.finalize(segment.id, 'finalized', endMs, {});
    return segment.id;
  }

  function seedEpisodeWithOneStep(token: string, startMs: number): string {
    const segmentId = seedStep(token, startMs, startMs + 30_000);
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: startMs,
          endedAtMs: startMs + 60_000,
          title: `${token} episode`,
          summary: `${token} summary`,
          intent: 'test intent',
          outcome: 'done',
          apps: ['TestApp'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: segments.getSteps(segmentId).map((s) => ({ id: s.id })),
        },
      ],
      startMs,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  function ftsHits(fTable: string, term: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${fTable} WHERE ${fTable} MATCH ?`).get(term) as {
        n: number;
      }
    ).n;
  }
  it('a from-only window deletes by surviving-end inclusively', () => {
    // Survivor ends BEFORE `from`; the victim ends EXACTLY at `from`
    // (COALESCE(end,start) >= from matches at equality).
    const keep = seedStep('edgekeep', NOW, NOW + 500);
    const victim = seedStep('edgevictim', NOW + 900, NOW + 1_000);

    const stats = makeService().deleteRange({ from: NOW + 1_000 });
    expect(stats.steps).toBe(1);

    expect(ftsHits('semantic_steps_fts', 'edgevictim')).toBe(0);
    expect(segments.getSteps(victim)).toHaveLength(0);
    expect(segments.getSteps(keep)).toHaveLength(1);
    expect(ftsHits('semantic_steps_fts', 'edgekeep')).toBe(1);
  });

  it('a to-only window deletes by start inclusively — a row starting EXACTLY at `to` dies', () => {
    seedStep('edgec', NOW, NOW + 1_000);
    const d = seedStep('edged', NOW + 2_000, NOW + 3_000);
    const e = seedStep('edgee', NOW + 2_001, NOW + 3_000);

    const stats = makeService().deleteRange({ to: NOW + 2_000 });
    expect(stats.steps).toBe(2); // C and D (D.start == to is INCLUSIVE)

    expect(segments.getSteps(d)).toHaveLength(0);
    expect(segments.getSteps(e)).toHaveLength(1);
  });

  it('an instant window (from === to) kills exactly-timestamped raw events only', () => {
    seedRawEvent(NOW - 1);
    seedRawEvent(NOW);
    seedRawEvent(NOW + 1);

    const stats = makeService().deleteRange({ from: NOW, to: NOW });
    expect(stats.rawEvents).toBe(1);
    expect(events.count()).toBe(2);
  });

  it('a workflow-purge failure rolls back the ENTIRE cascade', () => {
    const doomedEpisode = seedEpisodeWithOneStep('rollback', NOW);
    seedRawEvent(NOW + 1_000);
    const mem = memories.upsertCandidate(
      { kind: 'fact', canonicalKey: 'kw-rb', text: 'rollback claim quartz', confidence: 0.9 },
      { episodeId: doomedEpisode, confidence: 0.9, observedAtMs: NOW },
      NOW,
    );

    const service = makeService({
      purge: () => {
        throw new Error('purge exploded');
      },
    });
    expect(() => service.deleteRange({ from: NOW, to: NOW + 3_600_000 })).toThrow('purge exploded');

    // Nothing moved: every cascade stage reverted with the outer transaction.
    expect(events.count()).toBe(1);
    expect(episodes.getEpisode(doomedEpisode)).not.toBeNull();
    expect(ftsHits('episodes_fts', 'rollback')).toBe(1);
    expect(ftsHits('semantic_steps_fts', 'rollback')).toBe(1);
    const evidence = db
      .prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?')
      .get(mem.memoryId) as { n: number };
    expect(evidence.n).toBe(1);
  });

  it('deletes 501 chunk-boundary episodes without leaving orphans', () => {
    const TOTAL = 501;
    for (let i = 0; i < TOTAL; i += 1) {
      seedEpisodeWithOneStep(`bulk${i}`, NOW + i * 1_000);
    }
    const survivor = seedEpisodeWithOneStep('bulksurvivor', NOW + DAY_MS);

    const stats = makeService().deleteRange({ from: NOW, to: NOW + TOTAL * 1_000 });
    expect(stats.episodes).toBe(TOTAL);

    expect(count('episode_step_links')).toBe(1); // survivor link only
    expect(count('episodes_fts')).toBe(1);
    expect(count('semantic_steps')).toBe(1);
    expect(episodes.getEpisode(survivor)).not.toBeNull();
    expect(ftsHits('episodes_fts', 'bulksurvivor')).toBe(1);
  });

  it('a manually confirmed memory survives a one-sided window with zeroed evidence', () => {
    const doomed = seedEpisodeWithOneStep('manualband', NOW);
    const confirmed = memories.upsertCandidate(
      { kind: 'procedure', canonicalKey: 'kw-manual', text: 'manual claim xenon', confidence: 0.7 },
      { episodeId: doomed, confidence: 0.7, observedAtMs: NOW },
      NOW,
    );
    memories.confirm(confirmed.memoryId, NOW + 1);

    const stats = makeService().deleteRange({ from: NOW });
    expect(stats.episodes).toBe(1);
    expect(stats.memories).toBe(0); // manual confirm is immune

    const row = memories.getById(confirmed.memoryId);
    expect(row).not.toBeNull();
    const evidenceCount = db
      .prepare('SELECT evidence_count AS n FROM memory_candidates WHERE id = ?')
      .get(confirmed.memoryId) as { n: number };
    expect(evidenceCount.n).toBe(0); // evidence left, the row stayed
  });
});
