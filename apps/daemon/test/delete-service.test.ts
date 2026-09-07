import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import type { ActivityEvent } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { WorkflowsRepository, type NewWorkflowInput } from '../src/db/workflows-repository.js';
import { DeleteService } from '../src/services/delete-service.js';
import type { CoalescedStep, StepAction } from '../src/processing/event-coalescer.js';
import type { Logger } from '../src/logging.js';

/**
 * delete-service cascade unit tests (spec §3.23, brief-m7 §D7 item 1): ONE
 * transaction deletes raw events → overlapping steps (+links+FTS) →
 * overlapping episodes (+FTS) → evidence → invalidated non-manual memories →
 * occurrences → below-threshold candidate workflows. FTS mirrors follow the
 * rowid conventions; manually confirmed memories and confirmed/rejected
 * workflows survive even the 'all' preset (contracts interpretation).
 */

const NOON = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY_MS = 86_400_000;

describe('DeleteService cascade', () => {
  let db: Db;
  let home: string;
  let events: EventsRepository;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let workflows: WorkflowsRepository;
  let service: DeleteService;
  const logger: Logger = {
    log: vi.fn(),
    pruneOld: () => 0,
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-delete-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    events = new EventsRepository(db);
    segments = new SegmentsRepository(db);
    episodes = new EpisodesRepository(db);
    memories = new MemoriesRepository(db);
    workflows = new WorkflowsRepository(db);
    service = new DeleteService({
      db,
      workflows,
      logger,
      now: () => NOON + DAY_MS,
    });
    stepSeq = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  let stepSeq = 0;

  function seedRawEvent(observedAtMs: number, content: string): void {
    const event: ActivityEvent = {
      id: ulid(observedAtMs),
      observedAt: observedAtMs,
      source: 'accessibility',
      app: { bundleId: 'com.test.App', name: 'TestApp', pid: 1 },
      window: { title: 'Window' },
      action: 'click',
      target: { role: 'AXButton', label: 'Send' },
      contentPolicy: 'allow',
      content,
    };
    const result = events.insertBatch([event], observedAtMs);
    expect(result.accepted, JSON.stringify(result)).toBe(1);
  }

  function rawEventCount(): number {
    return events.count();
  }

  function seedEpisodeWithSteps(
    token: string,
    startMs: number,
    stepSpecs: Array<{ action: StepAction; target: string; text?: string }> = [
      { action: 'click', target: `${token} button` },
      { action: 'edit_text', target: 'field', text: `${token} typed text` },
    ],
  ): string {
    const segment = segments.createOpen(startMs, `first-${token}`, startMs);
    let t = startMs;
    for (const spec of stepSpecs) {
      stepSeq += 1;
      const step: CoalescedStep = {
        action: spec.action,
        appBundleId: 'com.test.App',
        appName: 'TestApp',
        target: spec.target,
        text: spec.text ?? null,
        startedAtMs: t,
        endedAtMs: t + 30_000,
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
      t += 60_000;
    }
    segments.finalize(segment.id, 'finalized', t, {});
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: startMs,
          endedAtMs: t,
          title: `${token} episode`,
          summary: `${token} summary`,
          intent: 'test intent',
          outcome: 'done',
          apps: ['TestApp'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: segments.getSteps(segment.id).map((s) => ({ id: s.id })),
        },
      ],
      startMs,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function episodeFtsHits(match: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM episodes_fts WHERE episodes_fts MATCH ?`).get(match) as {
        n: number;
      }
    ).n;
  }

  function stepFtsHits(match: string): number {
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM semantic_steps_fts WHERE semantic_steps_fts MATCH ?`)
        .get(match) as { n: number }
    ).n;
  }

  function memoryFtsHits(text: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?`).get(text) as {
        n: number;
      }
    ).n;
  }

  function candidate(overrides: Partial<NewWorkflowInput> = {}): NewWorkflowInput {
    return {
      name: 'Routine procedure',
      purpose: null,
      template: { name: 'Routine procedure', stableSteps: ['a'] },
      occurrences: [],
      firstSeenAtMs: NOON - DAY_MS,
      lastSeenAtMs: NOON,
      ...overrides,
    };
  }

  it('deletes a mid-band range with exact stats and FTS absence proofs', () => {
    seedRawEvent(NOON - DAY_MS, 'ancient keep');
    seedRawEvent(NOON + 60_000, 'doomed click');
    seedRawEvent(NOON + DAY_MS, 'future keep');
    const keptBefore = seedEpisodeWithSteps('beforeband', NOON - DAY_MS);
    seedEpisodeWithSteps('bandmark', NOON);
    const keptAfter = seedEpisodeWithSteps('afterband', NOON + DAY_MS);

    const stats = service.deleteRange({ from: NOON, to: NOON + 3_600_000 });
    expect(stats).toEqual({ rawEvents: 1, steps: 2, episodes: 1, memories: 0, workflows: 0 });

    // Per-table presence/absence.
    expect(rawEventCount()).toBe(2); // ancient + future survive
    expect(episodes.getEpisode(keptBefore)).not.toBeNull();
    expect(episodes.getEpisode(keptAfter)).not.toBeNull();
    const remainingLinks = db.prepare('SELECT COUNT(*) AS n FROM episode_step_links').get() as {
      n: number;
    };
    expect(remainingLinks.n).toBe(4); // 2 steps × 2 surviving episodes

    // FTS search-absence proofs: nothing matching the deleted band remains…
    expect(episodeFtsHits('bandmark')).toBe(0);
    expect(stepFtsHits('bandmark')).toBe(0);
    // …while both survivor bands stay fully searchable.
    expect(episodeFtsHits('beforeband')).toBe(1);
    expect(episodeFtsHits('afterband')).toBe(1);
    expect(stepFtsHits('beforeband')).toBeGreaterThan(0);
  });

  it('invalidates zero-evidence non-manual memories but spares multi-episode evidence and manual confirms', () => {
    const doomed = seedEpisodeWithSteps('memband', NOON);
    const kept = seedEpisodeWithSteps('memkeep', NOON + DAY_MS);

    // A: all evidence inside the doomed band ⇒ invalidated (deleted).
    const onlyDoomed = memories.upsertCandidate(
      { kind: 'fact', canonicalKey: 'kw-a', text: 'alpha claim zebra', confidence: 0.9 },
      { episodeId: doomed, confidence: 0.9, observedAtMs: NOON },
      NOON,
    );
    // B: evidence spans doomed + kept ⇒ still has live evidence ⇒ survives.
    const spanning = memories.upsertCandidate(
      { kind: 'preference', canonicalKey: 'kw-b', text: 'beta claim yak', confidence: 0.8 },
      { episodeId: doomed, confidence: 0.8, observedAtMs: NOON },
      NOON,
    );
    memories.upsertCandidate(
      { kind: 'preference', canonicalKey: 'kw-b', text: 'beta claim yak', confidence: 0.8 },
      { episodeId: kept, confidence: 0.8, observedAtMs: NOON + DAY_MS },
      NOON + DAY_MS,
    );
    // C: single-doomed-episode evidence BUT manually confirmed ⇒ survives.
    const manual = memories.upsertCandidate(
      { kind: 'procedure', canonicalKey: 'kw-c', text: 'gamma claim xenon', confidence: 0.7 },
      { episodeId: doomed, confidence: 0.7, observedAtMs: NOON },
      NOON,
    );
    memories.confirm(manual.memoryId, NOON + 1);

    const stats = service.deleteRange({ from: NOON, to: NOON + 3_600_000 });
    expect(stats.episodes).toBe(1);
    expect(stats.memories).toBe(1); // only the invalidated non-manual row

    expect(memories.getById(onlyDoomed.memoryId)).toBeNull();
    expect(memoryFtsHits('zebra')).toBe(0);
    expect(memories.getById(spanning.memoryId)).not.toBeNull(); // live evidence elsewhere
    expect(memoryFtsHits('yak')).toBe(1);
    expect(memories.getById(manual.memoryId)).not.toBeNull(); // manual confirm wins
    expect(memoryFtsHits('xenon')).toBe(1);
  });

  it('recomputes evidence_count on the surviving candidate when evidence is deleted', () => {
    const doomedA = seedEpisodeWithSteps('evband-a', NOON);
    const doomedB = seedEpisodeWithSteps('evband-b', NOON + 120_000);
    const kept = seedEpisodeWithSteps('evkeep', NOON + DAY_MS);

    // One candidate across all three episodes: 2 evidences land in the
    // doomed band, 1 survives outside it.
    const claim = {
      kind: 'fact' as const,
      canonicalKey: 'kw-count',
      text: 'count claim quartz',
      confidence: 0.9,
    };
    const seeded = memories.upsertCandidate(
      claim,
      { episodeId: doomedA, confidence: 0.9, observedAtMs: NOON },
      NOON,
    );
    memories.upsertCandidate(
      claim,
      { episodeId: doomedB, confidence: 0.9, observedAtMs: NOON + 120_000 },
      NOON + 120_000,
    );
    memories.upsertCandidate(
      claim,
      { episodeId: kept, confidence: 0.9, observedAtMs: NOON + DAY_MS },
      NOON + DAY_MS,
    );
    expect(memories.getById(seeded.memoryId)?.evidenceCount).toBe(3);

    const stats = service.deleteRange({ from: NOON, to: NOON + 3_600_000 });
    expect(stats.episodes).toBe(2);
    expect(stats.memories).toBe(0); // still has live evidence ⇒ not invalidated

    const survivor = memories.getById(seeded.memoryId);
    expect(survivor).not.toBeNull();
    expect(survivor?.evidenceCount).toBe(1); // stale 3 would drift vs list/UI
  });

  it('purges below-threshold candidates via the cascade while confirmed workflows stay frozen', () => {
    const dayA = seedEpisodeWithSteps('wfa', NOON - DAY_MS);
    const dayB = seedEpisodeWithSteps('wfb', NOON);
    const dayC = seedEpisodeWithSteps('wfc', NOON + DAY_MS);

    const doomedWf = workflows.insertWorkflow(
      candidate({
        name: 'candidate victim',
        occurrences: [
          { episodeId: dayB, similarity: 0.9 },
          { episodeId: dayC, similarity: 0.88 },
          { episodeId: dayA, similarity: 0.92 },
        ],
      }),
      NOON,
    );
    const confirmed = workflows.insertWorkflow(
      candidate({
        name: 'confirmed keeper',
        occurrences: [
          { episodeId: dayB, similarity: 0.9 },
          { episodeId: dayC, similarity: 0.88 },
          { episodeId: dayA, similarity: 0.92 },
        ],
      }),
      NOON,
    );
    workflows.updateStatus(confirmed, 'confirmed', NOON);

    // Deleting the middle day strips one occurrence from each workflow:
    // the candidate drops to 2 occurrences < 3 ⇒ purged by the cascade…
    const stats = service.deleteRange({ from: NOON, to: NOON + 3_600_000 });
    expect(stats.workflows).toBe(1);
    expect(workflows.getById(doomedWf)).toBeNull();

    // …while the confirmed row is NEVER rewritten (stale count frozen) and
    // keeps its two surviving ledger rows.
    const kept = workflows.listByStatus({ status: 'confirmed' })[0]!;
    expect(kept.id).toBe(confirmed);
    expect(kept.occurrenceCount).toBe(3); // frozen denormalized count
    expect(kept.occurrences.map((o) => o.episodeId).sort()).toEqual([dayA, dayC].sort());
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(0); // second pass no-op
  });

  it('resolves presets against the injected clock with UTC day boundaries', () => {
    // now() is pinned to NOON + DAY_MS; «today» starts at that day's UTC
    // midnight. Bounds are inclusive on both ends.
    const nowMs = NOON + DAY_MS;
    const midnightUtc = new Date(nowMs).setUTCHours(0, 0, 0, 0);
    seedRawEvent(midnightUtc, 'exactly midnight today start');
    seedRawEvent(midnightUtc - 1, 'just before today');
    seedRawEvent(nowMs - 5 * 60_000, 'inside last ten minutes');
    seedRawEvent(nowMs - 11 * 60_000, 'outside last ten minutes');

    const tenMinutes = service.deleteRange({ preset: 'last_10_minutes' });
    expect(tenMinutes.rawEvents).toBe(1);

    const today = service.deleteRange({ preset: 'today' });
    expect(today.rawEvents).toBe(2);
    expect(rawEventCount()).toBe(1); // only "just before today" remains
  });

  it('is idempotent: a double delete answers zeros and touches nothing', () => {
    seedEpisodeWithSteps('idem', NOON + DAY_MS - 60_000); // inside last_hour
    const first = service.deleteRange({ preset: 'last_hour' });
    expect(first.episodes).toBe(1);
    const second = service.deleteRange({ preset: 'last_hour' });
    expect(second).toEqual({ rawEvents: 0, steps: 0, episodes: 0, memories: 0, workflows: 0 });
  });

  it('leaves zero orphan links or FTS mirrors when an episode straddles the window edge', () => {
    // 'edgemark' starts inside the window (its whole episode dies, including
    // a step that ends beyond `to`); 'pastbound' starts one ms past `to` and
    // must survive completely — rows AND search mirrors.
    const windowTo = NOON + 3_600_000;
    seedEpisodeWithSteps('edgemark', NOON);
    const pastBound = seedEpisodeWithSteps('pastbound', windowTo + 1);

    const stats = service.deleteRange({ from: NOON, to: windowTo });
    expect(stats.steps).toBe(2);
    expect(stepFtsHits('edgemark')).toBe(0);
    expect(episodes.getEpisode(pastBound)).not.toBeNull();
    expect(stepFtsHits('pastbound')).toBeGreaterThan(0);
    const orphanCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM episode_step_links l
            WHERE NOT EXISTS (SELECT 1 FROM episodes e WHERE e.id = l.episode_id)
               OR NOT EXISTS (SELECT 1 FROM semantic_steps s WHERE s.id = l.semantic_step_id)
           ) AS orphanLinks,
           (SELECT COUNT(*) FROM semantic_steps_fts f
            WHERE NOT EXISTS (SELECT 1 FROM semantic_steps s WHERE s.rowid = f.rowid)
           ) AS orphanStepFts,
           (SELECT COUNT(*) FROM episodes_fts f
            WHERE NOT EXISTS (SELECT 1 FROM episodes e WHERE e.rowid = f.rowid)
           ) AS orphanEpisodeFts`,
      )
      .get() as { orphanLinks: number; orphanStepFts: number; orphanEpisodeFts: number };
    expect(orphanCounts).toEqual({ orphanLinks: 0, orphanStepFts: 0, orphanEpisodeFts: 0 });
  });
});
