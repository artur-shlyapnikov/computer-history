import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import {
  EpisodeSplitSchema,
  EpisodeSummarizer,
  toNewEpisode,
  validateSplit,
  type EpisodeSplit,
} from '../src/processing/episode-summarizer.js';
import { Value } from '@sinclair/typebox/value';
import { CONSTANTS } from '../src/config.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import {
  FakeTransport,
  FailingTransport,
} from '../src/llm/fake-transport.js';
import type { JobRow } from '../src/db/jobs-repository.js';

const NOW = 1_700_000_000_000;

describe('EpisodeSummarizer (spec §3.14, brief-m3 §D3 item 5 + test matrix)', () => {
  let db: Db;
  let episodes: EpisodesRepository;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let home: string;

  /** Silent logger satisfying the Logger interface. */
  const logger = {
    log: vi.fn(),
    pruneOld: () => 0,
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-summarizer-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    episodes = new EpisodesRepository(db);
    jobs = new JobsRepository(db);
    segments = new SegmentsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function seedSegment(stepCount: number): string {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    for (let i = 0; i < stepCount; i++) {
      const step: CoalescedStep = {
        action: (i % 2 === 0 ? 'type' : 'click'),
        appBundleId: i < stepCount / 2 ? 'com.apple.Safari' : 'com.apple.Terminal',
        appName: i < stepCount / 2 ? 'Safari' : 'Terminal',
        target: `target-${i}`,
        text: `step text ${i}`,
        startedAtMs: NOW + i * 60_000,
        endedAtMs: NOW + i * 60_000 + 30_000,
        firstEventId: `e${i}a`,
        lastEventId: `e${i}b`,
        eventCount: 1,
        targetRole: null,
      };
      segments.appendStep(segment.id, step, { text: step.text, target: step.target, appName: step.appName });
    }
    segments.finalize(segment.id, 'finalized', NOW + stepCount * 60_000, {});
    return segment.id;
  }

  function enqueueSummarize(segmentId: string): JobRow {
    const job = jobs.enqueue('summarize_segment', { segmentId }, NOW, NOW);
    return (
      db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow
    );
  }

  function buildSummarizer(
    responses: string[],
    onEpisodesChanged?: () => void,
    onJobEnqueued?: () => void,
  ): EpisodeSummarizer {
    return new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger: logger,
      transportFactory: async () => new FakeTransport(responses),
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
      onEpisodesChanged,
      onJobEnqueued,
    });
  }

  it('valid split persists 3 episodes with correct ranges, links and FTS-searchable titles; extract_memory enqueued per episode', async () => {
    const segmentId = seedSegment(6);
    const split: EpisodeSplit = {
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'Research phase', summary: 'Looked things up.', intent: 'research', outcome: 'unknown', entities: ['docs'] },
        { firstStepOrdinal: 2, lastStepOrdinal: 3, title: 'Implementation phase', summary: 'Wrote code.', intent: 'development', outcome: 'unknown', entities: [] },
        { firstStepOrdinal: 4, lastStepOrdinal: 5, title: 'Verification phase', summary: 'Ran tests.', intent: 'unknown', outcome: 'unknown', entities: ['CI'] },
      ],
    };
    let changedEmitted = 0;
    const summarizer = buildSummarizer(
      [JSON.stringify(split)],
      () => {
        changedEmitted++;
      },
    );
    await summarizer.handle(enqueueSummarize(segmentId));

    // Three episode rows with exact time ranges derived from covered steps.
    const rows = episodes.listEpisodes({}, 10);
    expect(rows).toHaveLength(3);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    const research = byTitle.get('Research phase')!;
    expect(research.startedAtMs).toBe(NOW);
    expect(research.endedAtMs).toBe(NOW + 90_000); // steps 0..1
    expect(research.stepCount).toBe(2);
    expect(byTitle.get('Verification phase')!.startedAtMs).toBe(NOW + 240_000);
    const researchRow = episodes.getEpisode(research.id)!.episode;
    expect(researchRow.summaryModel).toBe('test-background-model'); // episodes.summary_model set
    expect(researchRow.summaryPromptVersion).toBe('v1');

    // Links: every one of the 6 steps belongs to exactly one episode.
    const linkCounts = db
      .prepare(
        `SELECT e.title, COUNT(*) AS n FROM episode_step_links l
         JOIN episodes e ON e.id = l.episode_id GROUP BY e.id ORDER BY MIN(l.ordinal)`,
      )
      .all() as Array<{ title: string; n: number }>;
    expect(linkCounts.map((r) => r.n)).toEqual([2, 2, 2]);
    const totalLinks = db.prepare('SELECT COUNT(*) AS n FROM episode_step_links').get() as { n: number };
    expect(totalLinks.n).toBe(6);

    // FTS-searchable titles.
    expect(episodes.searchEpisodes('verification', 10)).toHaveLength(1);
    expect(episodes.searchEpisodes('implementation', 10)).toHaveLength(1);

    // One pending extract_memory job per episode (M5 handles them later).
    const extractJobs = db
      .prepare("SELECT payload_json FROM jobs WHERE type = 'extract_memory'")
      .all() as Array<{ payload_json: string }>;
    expect(extractJobs).toHaveLength(3);
    for (const row of extractJobs) {
      const payload: unknown = JSON.parse(row.payload_json);
      if (typeof payload !== 'object' || payload === null || !('episodeId' in payload)) {
        throw new Error(`extract_memory payload missing episodeId: ${row.payload_json}`);
      }
      expect(payload.episodeId).toEqual(expect.any(String));
    }
    // M6 chains mine_workflows right after each extract_memory (brief-m6 §D6
    // item 3) — same payload, same per-episode fan-out.
    const mineJobs = db
      .prepare("SELECT payload_json FROM jobs WHERE type = 'mine_workflows'")
      .all() as Array<{ payload_json: string }>;
    expect(mineJobs).toHaveLength(3);
    for (const row of mineJobs) {
      const payload: unknown = JSON.parse(row.payload_json);
      if (typeof payload !== 'object' || payload === null || !('episodeId' in payload)) {
        throw new Error(`mine_workflows payload missing episodeId: ${row.payload_json}`);
      }
      expect(payload.episodeId).toEqual(expect.any(String));
    }
    // GateM6 inherit fix (c): the extract_memory → mine_workflows chain order
    // per episode is load-bearing (the miner assumes the episode's summary is
    // durable before mining). Pin creation order with ORDER BY rowid: for
    // every episode the extract_memory row MUST precede its mine_workflows row.
    const chainOrder = db
      .prepare(
        `SELECT type, payload_json FROM jobs
         WHERE type IN ('extract_memory', 'mine_workflows') ORDER BY rowid`,
      )
      .all() as Array<{ type: string; payload_json: string }>;
    expect(chainOrder).toHaveLength(6);
    for (let i = 0; i < chainOrder.length; i += 2) {
      const extract = JSON.parse(chainOrder[i]!.payload_json) as { episodeId: string };
      const mine = JSON.parse(chainOrder[i + 1]!.payload_json) as { episodeId: string };
      expect(chainOrder[i]!.type).toBe('extract_memory');
      expect(chainOrder[i + 1]!.type).toBe('mine_workflows');
      expect(mine.episodeId).toBe(extract.episodeId);
    }
    // episodes_changed fired exactly once, AFTER the commit.
    expect(changedEmitted).toBe(1);
  });

  it('hallucinated ordinals (out of range / gap / overlap / disorder) are rejected pre-repair and repaired exactly once', async () => {
    const segmentId = seedSegment(4);
    // First response: overlapping disordered ranges. Second: valid cover.
    const bad = JSON.stringify({
      episodes: [
        { firstStepOrdinal: 2, lastStepOrdinal: 1, title: 'inverted', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
        { firstStepOrdinal: 1, lastStepOrdinal: 2, title: 'overlap', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
        { firstStepOrdinal: 7, lastStepOrdinal: 8, title: 'hallucinated steps', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
      ],
    });
    const good = JSON.stringify({
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'fixed-a', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
        { firstStepOrdinal: 2, lastStepOrdinal: 3, title: 'fixed-b', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
      ],
    });
    const transport = new FakeTransport([bad, good]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger: logger,
      transportFactory: async () => transport,
      now: () => NOW,
    });
    await summarizer.handle(enqueueSummarize(segmentId));

    expect(transport.prompts).toHaveLength(2); // ONE repair
    const repairPrompt = transport.prompts[1]!.userPrompt;
    expect(repairPrompt).toContain('breaks contiguity');
    expect(repairPrompt).toContain('out of range');
    expect(repairPrompt).toContain('range inverted');
    expect(episodes.listEpisodes({}, 10).map((e) => e.title)).toEqual(['fixed-b', 'fixed-a']);
  });

  it('twice-invalid split falls back to a single whole-segment episode — no event loss', async () => {
    const segmentId = seedSegment(4);
    const invalid = '"not a valid split at all"';
    const summarizer = buildSummarizer([invalid, invalid]);
    await summarizer.handle(enqueueSummarize(segmentId));

    const rows = episodes.listEpisodes({}, 10);
    expect(rows).toHaveLength(1);
    const fallback = rows[0]!;
    expect(fallback.stepCount).toBe(4); // whole segment covered
    expect(fallback.title).toMatch(/^(Safari|Terminal) · \d{2}:\d{2}–\d{2}:\d{2}$/); // dominant app + time range
    const found = episodes.getEpisode(fallback.id)!;
    expect(found.episode.intent).toBe('unknown');
    expect(found.episode.outcome).toBe('unknown');
    // Steps survive untouched and linked.
    expect(found.steps).toHaveLength(4);
    const rawSteps = db.prepare('SELECT COUNT(*) AS n FROM semantic_steps').get() as { n: number };
    expect(rawSteps.n).toBe(4);
  });

  it('re-delivered summarize job is idempotent — no duplicate episodes or extract_memory jobs', async () => {
    const segmentId = seedSegment(2);
    const split = JSON.stringify({
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'only', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
      ],
    });
    const transport = new FakeTransport([split]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger: logger,
      transportFactory: async () => transport,
      now: () => NOW,
    });
    const job = enqueueSummarize(segmentId);
    await summarizer.handle(job);
    await summarizer.handle(job); // crash-recovery re-delivery of the SAME job

    expect(episodes.countEpisodes()).toBe(1);
    const extractJobs = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'extract_memory'")
      .get() as { n: number };
    expect(extractJobs.n).toBe(1);
    expect(transport.prompts).toHaveLength(1); // LLM not consulted twice
  });

  it('re-delivery still latches after episode_step_links are purged — no duplicate episodes (round-31)', async () => {
    // Extended-outage scenario: the daemon crashes between persistTx commit
    // and job completion; by re-delivery, retention has deleted the links.
    // The segment_id stamp (migration 012) must keep the latch closed where
    // the old link-only check would have re-summarized duplicates.
    const segmentId = seedSegment(2);
    const split = JSON.stringify({
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'only', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
      ],
    });
    const transport = new FakeTransport([split]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger: logger,
      transportFactory: async () => transport,
      now: () => NOW,
    });
    const job = enqueueSummarize(segmentId);
    await summarizer.handle(job);

    // Retention purge removes the links (steps stay in this pin's scope).
    db.prepare('DELETE FROM episode_step_links').run();
    await summarizer.handle(job); // late crash-recovery re-delivery

    expect(episodes.countEpisodes()).toBe(1);
    expect(episodes.hasEpisodesForSteps(segments.getSteps(segmentId))).toBe(true);
    expect(transport.prompts).toHaveLength(1); // LLM not consulted again
  });

  it('LLM outage propagates to the worker retry path — no episodes written, no events emitted', async () => {
    const segmentId = seedSegment(3);
    const onEpisodesChanged = vi.fn();
    const summarizer = new EpisodeSummarizer({
      segments,
      episodes,
      db,
      jobs,
      logger: logger,
      transportFactory: async () => new FailingTransport(new Error('provider unreachable')),
      now: () => NOW,
      onEpisodesChanged,
    });
    await expect(summarizer.handle(enqueueSummarize(segmentId))).rejects.toThrowError(
      'provider unreachable',
    );
    expect(episodes.countEpisodes()).toBe(0);
    expect(onEpisodesChanged).not.toHaveBeenCalled();
    // The summarize job itself stays in its claimed state — worker.fail owns it (tested in job-worker suite).
    const steps = db.prepare('SELECT COUNT(*) AS n FROM semantic_steps').get() as { n: number };
    expect(steps.n).toBe(3); // raw history intact, searchable without LLM
  });

  it('validateSplit rejects each hallucination class explicitly', () => {
    const base = { title: 't', summary: 's', intent: 'unknown' as const, outcome: 'unknown' as const, entities: [] as string[] };
    expect(validateSplit({ episodes: [] }, 3)).toContain('episode count 0 outside 1..6');
    expect(validateSplit({ episodes: [{ ...base, firstStepOrdinal: 0, lastStepOrdinal: 5 }] }, 3)).toContain(
      'episodes[0].lastStepOrdinal 5 out of range [0, 2]',
    );
    expect(validateSplit({ episodes: [{ ...base, firstStepOrdinal: 0, lastStepOrdinal: 0 }] }, 3)).toContain(
      'ranges cover [0, 0] but segment has 3 steps',
    ); // gap
    expect(
      validateSplit(
        { episodes: [
          { ...base, firstStepOrdinal: 0, lastStepOrdinal: 1 },
          { ...base, firstStepOrdinal: 1, lastStepOrdinal: 2 },
        ] },
        3,
      ),
    ).toContain('episodes[1] breaks contiguity: expected firstStepOrdinal 2, got 1'); // overlap
    const disorderErrors = validateSplit(
      { episodes: [
        { ...base, firstStepOrdinal: 1, lastStepOrdinal: 2 },
        { ...base, firstStepOrdinal: 0, lastStepOrdinal: 0 },
      ] },
      3,
    );
    expect(disorderErrors.some((e) => e.includes('episodes[0] breaks contiguity'))).toBe(true); // disorder
    expect(
      validateSplit(
        { episodes: [
          { ...base, firstStepOrdinal: 0, lastStepOrdinal: 0 },
          { ...base, firstStepOrdinal: 1, lastStepOrdinal: 1 },
          { ...base, firstStepOrdinal: 2, lastStepOrdinal: 2 },
          { ...base, firstStepOrdinal: 0, lastStepOrdinal: 2 },
        ] },
        3,
      ).some((e) => e.includes('contiguity')),
    ).toBe(true);
    expect(
      validateSplit(
        { episodes: [
          { ...base, firstStepOrdinal: 0, lastStepOrdinal: 0 },
          { ...base, firstStepOrdinal: 1, lastStepOrdinal: 2 },
        ] },
        3,
      ),

    ).toEqual([]);
  });

  it('EpisodeSplitSchema bounds degenerate model output (summary/entity schema-class pins)', () => {
    const split = (episode: Record<string, unknown>) => ({
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 0, title: 't', intent: 'unknown', outcome: 'unknown', ...episode },
      ],
    });

    // summary ≤ 8000 chars.
    expect(Value.Check(EpisodeSplitSchema, split({ summary: 'x'.repeat(8000), entities: [] }))).toBe(true);
    expect(Value.Check(EpisodeSplitSchema, split({ summary: 'x'.repeat(8001), entities: [] }))).toBe(false);
    // entities: ≤ 50 items, each ≤ 120 chars.
    expect(
      Value.Check(EpisodeSplitSchema, split({ summary: 's', entities: Array.from({ length: 50 }, (_, i) => `e${i}`) })),
    ).toBe(true);
    expect(
      Value.Check(EpisodeSplitSchema, split({ summary: 's', entities: Array.from({ length: 51 }, (_, i) => `e${i}`) })),
    ).toBe(false);
    expect(Value.Check(EpisodeSplitSchema, split({ summary: 's', entities: ['x'.repeat(121)] }))).toBe(false);
    expect(Value.Check(EpisodeSplitSchema, split({ summary: 's', entities: ['x'.repeat(120)] }))).toBe(true);
  });

  it('enqueue failure rolls back the episode insert — re-delivery retries and eventually enqueues', async () => {
    const segmentId = seedSegment(2);
    const split = JSON.stringify({
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'only', summary: '', intent: 'unknown', outcome: 'unknown', entities: [] },
      ],
    });
    // Two scripted LLM responses: one per delivery (rollback replays the split).
    const summarizer = buildSummarizer([split, split]);
    const job = enqueueSummarize(segmentId);

    const realEnqueue = jobs.enqueue.bind(jobs);
    let enqueueCalls = 0;
    const enqueueSpy = vi
      .spyOn(jobs, 'enqueue')
      .mockImplementation((type, payload, runAfterMs, createdAtMs) => {
        enqueueCalls += 1;
        if (enqueueCalls === 1) throw new Error('simulated queue outage');
        return realEnqueue(type, payload, runAfterMs, createdAtMs);
      });

    // First delivery: extract_memory enqueue throws after the episode INSERT —
    // ONE transaction means the episodes (and their links/FTS rows) roll back.
    await expect(summarizer.handle(job)).rejects.toThrowError('simulated queue outage');
    expect(episodes.countEpisodes()).toBe(0);
    expect(episodes.hasEpisodesForSteps(segments.getSteps(segmentId))).toBe(false);
    const downstream = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('extract_memory', 'mine_workflows')")
      .get() as { n: number };
    expect(downstream.n).toBe(0);

    // Re-delivery (retry/crash path): nothing was latched away — full replay
    // persists the episodes and enqueues BOTH downstream jobs per episode.
    enqueueSpy.mockRestore();
    await summarizer.handle(job);
    expect(episodes.countEpisodes()).toBe(1);
    for (const type of ['extract_memory', 'mine_workflows']) {
      const enqueued = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE type = ?').get(type) as {
        n: number;
      };
      expect(enqueued.n).toBe(1);
    }
  });

  it('SEC-004: toNewEpisode defensive Error carries ordinals only — no LLM-derived content', () => {
    const episode = {
      firstStepOrdinal: 3,
      lastStepOrdinal: 2,
      title: 'CLASSIFIED-TITLE-FROM-CAPTURED-CONTENT',
      summary: 'CLASSIFIED-SUMMARY',
      intent: 'unknown' as const,
      outcome: 'unknown' as const,
      entities: [],
    };
    let message = '';
    try {
      toNewEpisode(episode, [], 'test-model');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('#3-2');
    expect(message).not.toContain('CLASSIFIED');
  });

  it('emits onJobEnqueued after the persist commit and before onEpisodesChanged (SVC-03 summarizer half)', async () => {
    const segmentId = seedSegment(6);
    const split: EpisodeSplit = {
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'Research phase', summary: 'Looked things up.', intent: 'research', outcome: 'unknown', entities: ['docs'] },
        { firstStepOrdinal: 2, lastStepOrdinal: 3, title: 'Implementation phase', summary: 'Wrote code.', intent: 'development', outcome: 'unknown', entities: [] },
        { firstStepOrdinal: 4, lastStepOrdinal: 5, title: 'Verification phase', summary: 'Ran tests.', intent: 'unknown', outcome: 'unknown', entities: ['CI'] },
      ],
    };
    const events: string[] = [];
    // persistTx is built inside the constructor from db.transaction; its first
    // observable step is insertEpisodesWithLinks inside that transaction.
    const originalInsert = episodes.insertEpisodesWithLinks.bind(episodes);
    vi.spyOn(episodes, 'insertEpisodesWithLinks').mockImplementation((eps, createdAtMs) => {
      events.push('persist');
      return originalInsert(eps, createdAtMs);
    });
    const onJobEnqueued = vi.fn(() => events.push('enqueued'));
    const onEpisodesChanged = vi.fn(() => events.push('episodes-changed'));
    const summarizer = buildSummarizer([JSON.stringify(split)], onEpisodesChanged, onJobEnqueued);

    await summarizer.handle(enqueueSummarize(segmentId));

    expect(onJobEnqueued).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['persist', 'enqueued', 'episodes-changed']);
    // Sanity: by enqueue time the split is durable — downstream queue_update
    // consumers never see counters for episodes that are not committed yet.
    expect(episodes.listEpisodes({}, 10)).toHaveLength(3);
  });

  it('early-return branches fire neither onJobEnqueued nor onEpisodesChanged (SVC-03)', async () => {
    const onJobEnqueued = vi.fn();
    const onEpisodesChanged = vi.fn();
    const segmentId = seedSegment(4);
    const split: EpisodeSplit = {
      episodes: [
        { firstStepOrdinal: 0, lastStepOrdinal: 1, title: 'Research phase', summary: 'Looked things up.', intent: 'research', outcome: 'unknown', entities: ['docs'] },
        { firstStepOrdinal: 2, lastStepOrdinal: 3, title: 'Implementation phase', summary: 'Wrote code.', intent: 'development', outcome: 'unknown', entities: [] },
      ],
    };
    // Scripted for the later already-summarized leg; the early-return legs
    // below must never reach the transport.
    const summarizer = buildSummarizer([JSON.stringify(split)], onEpisodesChanged, onJobEnqueued);

    // Missing segment (:152–160).
    await summarizer.handle(enqueueSummarize('segment-does-not-exist'));
    expect(onJobEnqueued).not.toHaveBeenCalled();
    expect(onEpisodesChanged).not.toHaveBeenCalled();

    // Empty segment — finalized with zero steps (:152–160).
    const empty = segments.createOpen(NOW, 'e-empty', NOW);
    segments.finalize(empty.id, 'finalized', NOW + 60_000, {});
    await summarizer.handle(enqueueSummarize(empty.id));
    expect(onJobEnqueued).not.toHaveBeenCalled();
    expect(onEpisodesChanged).not.toHaveBeenCalled();

    // Already summarized re-delivery (:161–168): a first valid run fires both
    // callbacks once; the re-delivered job must fire neither again.
    await summarizer.handle(enqueueSummarize(segmentId));
    expect(onJobEnqueued).toHaveBeenCalledTimes(1);
    expect(onEpisodesChanged).toHaveBeenCalledTimes(1);
    onJobEnqueued.mockClear();
    onEpisodesChanged.mockClear();

    await summarizer.handle(enqueueSummarize(segmentId));
    expect(onJobEnqueued).not.toHaveBeenCalled();
    expect(onEpisodesChanged).not.toHaveBeenCalled();
  });

  it('unparseable payload_json completes without side effects (no LLM call, no episode mutation)', async () => {
    const onJobEnqueued = vi.fn();
    const onEpisodesChanged = vi.fn();
    // Scripted response would surface as a spurious episode if the guard
    // failed to stop the run before the transport.
    const transport = new FakeTransport([JSON.stringify({ episodes: [] })]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => transport,
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
      onEpisodesChanged,
      onJobEnqueued,
    });

    const job = { ...enqueueSummarize('segment-irrelevant'), payload_json: '{' };
    await expect(summarizer.handle(job)).resolves.toBeUndefined();
    // No LLM call and no callbacks: the corrupt-payload branch returned early.
    expect(transport.prompts).toHaveLength(0);
    expect(onJobEnqueued).not.toHaveBeenCalled();
    expect(onEpisodesChanged).not.toHaveBeenCalled();
    expect(episodes.listEpisodes({}, 10)).toHaveLength(0);
  });

  /** Valid split covering a whole window with one episode (local ordinals). */
  function wholeWindowSplit(stepCount: number, title: string): string {
    return JSON.stringify({
      episodes: [
        {
          firstStepOrdinal: 0,
          lastStepOrdinal: stepCount - 1,
          title,
          summary: 's',
          intent: 'unknown',
          outcome: 'unknown',
          entities: [],
        },
      ],
    });
  }

  interface SummarizePayload {
    segmentId?: string;
    stepOffset?: number;
  }

  /** Our own summarizer produces this payload shape (trusted producer). */
  function summarizeJobPayload(row: JobRow): SummarizePayload {
    return JSON.parse(row.payload_json) as SummarizePayload;
  }

  function sentOrdinals(prompt: { userPrompt: string }): number[] {
    const payload = prompt.userPrompt.slice(
      prompt.userPrompt.indexOf('Input data:\n') + 'Input data:\n'.length,
      prompt.userPrompt.indexOf('\n\nRespond'),
    );
    const sent = JSON.parse(payload) as { steps: Array<{ ordinal: number }> };
    return sent.steps.map((step) => step.ordinal);
  }

  /** Latest enqueued summarize_segment job (the suffix-chained follow-up). */
  function latestSummarizeJob(): JobRow {
    return db
      .prepare("SELECT * FROM jobs WHERE type = 'summarize_segment' ORDER BY rowid DESC")
      .get() as JobRow;
  }

  it('a 450-step segment chains capped windows until ordinals 0..449 are ALL covered', async () => {
    const segmentId = seedSegment(450);
    const cap = CONSTANTS.summarizeMaxInputSteps;
    // Window sizes: [0..199], [200..399], [400..449].
    const transport = new FakeTransport([
      wholeWindowSplit(cap, 'w0'),
      wholeWindowSplit(cap, 'w1'),
      wholeWindowSplit(50, 'w2'),
    ]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => transport,
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
    });

    let job = enqueueSummarize(segmentId);
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      await summarizer.handle(job);
      if (i < 2) {
        const followUp = latestSummarizeJob();
        const followUpPayload = summarizeJobPayload(followUp);
        expect(followUpPayload.segmentId).toBe(segmentId);
        offsets.push(followUpPayload.stepOffset!);
        job = followUp;
      }
    }
    // Exactly two chained follow-ups at cap boundaries; nothing further.
    expect(offsets).toEqual([cap, 2 * cap]);
    const summarizeJobs = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'summarize_segment'")
      .get() as { n: number };
    expect(summarizeJobs.n).toBe(3); // original + 2 follow-ups

    // Every prompt stayed under the per-call cap with WINDOW-LOCAL ordinals
    // starting at 0 (validateSplit's coverage contract).
    expect(transport.prompts).toHaveLength(3);
    for (const prompt of transport.prompts) {
      const ordinals = sentOrdinals(prompt);
      expect(ordinals[0]).toBe(0);
      expect(ordinals).toEqual(ordinals.map((_, i) => i));
    }

    // Three episodes cover disjoint global windows; timestamps prove the
    // window→global mapping (step i starts at NOW + i*60_000).
    const rows = episodes.listEpisodes({}, 10);
    expect(rows.map((r) => r.title).sort()).toEqual(['w0', 'w1', 'w2']);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('w0')).toMatchObject({ startedAtMs: NOW, stepCount: cap });
    expect(byTitle.get('w1')).toMatchObject({
      startedAtMs: NOW + cap * 60_000,
      stepCount: cap,
    });
    expect(byTitle.get('w2')).toMatchObject({
      startedAtMs: NOW + 2 * cap * 60_000,
      stepCount: 50,
    });
    expect(byTitle.get('w2')!.endedAtMs).toBe(NOW + 449 * 60_000 + 30_000);

    // Every one of the 450 steps is linked EXACTLY once — no gap, no dupe.
    const coverage = db
      .prepare(`SELECT COUNT(DISTINCT l.semantic_step_id) AS covered, COUNT(*) AS links
                FROM episode_step_links l JOIN semantic_steps s ON s.id = l.semantic_step_id
                WHERE s.segment_id = ?`)
      .get(segmentId) as { covered: number; links: number };
    expect(coverage.covered).toBe(450);
    expect(coverage.links).toBe(450);
  });

  it('chains on the LAST COVERED ordinal under a purge-induced gap — tail is summarized, not skipped', async () => {
    // Regression pin: purged steps leave ordinal gaps, so chaining must use
    // the last covered row's actual ordinal, not stepOffset + window length
    // (count-based). With a mid-segment gap the count-based follow-up offset
    // points at an already-covered ordinal: its window overlaps the previous
    // one, hasEpisodesForSteps sees the linked IDs and skips, and the tail is
    // never summarized (permanent silent data loss).
    const cap = CONSTANTS.summarizeMaxInputSteps;
    const segmentId = seedSegment(cap + 2);
    // Purge one middle step → ordinals {1..cap+2} \ {2}; cap + 1 steps remain.
    db.prepare('DELETE FROM semantic_steps WHERE segment_id = ? AND ordinal = 2').run(segmentId);
    // First window covers ordinals [1, 3..cap+1] exactly (cap rows); only the
    // tail step (ordinal cap+2) remains.
    const transport = new FakeTransport([
      wholeWindowSplit(cap, 'w0'),
      wholeWindowSplit(1, 'tail'),
    ]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => transport,
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
    });

    await summarizer.handle(enqueueSummarize(segmentId));
    const followUp = latestSummarizeJob();
    const followUpPayload = summarizeJobPayload(followUp);
    expect(followUpPayload.segmentId).toBe(segmentId);
    // Count-based chaining would produce stepOffset = 0 + cap = cap here,
    // overlapping the already-covered ordinal cap + 1.
    expect(followUpPayload.stepOffset).toBe(cap + 1);

    await summarizer.handle(followUp);
    // The tail got an episode (old code: overlap → hasEpisodesForSteps skip).
    const rows = episodes.listEpisodes({}, 10);
    expect(rows.map((r) => r.title).sort()).toEqual(['tail', 'w0']);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('tail')).toMatchObject({ stepCount: 1 });

    // Every surviving step (cap + 1) is linked EXACTLY once.
    const coverage = db
      .prepare(`SELECT COUNT(DISTINCT l.semantic_step_id) AS covered, COUNT(*) AS links
                FROM episode_step_links l JOIN semantic_steps s ON s.id = l.semantic_step_id
                WHERE s.segment_id = ?`)
      .get(segmentId) as { covered: number; links: number };
    expect(coverage.covered).toBe(cap + 1);
    expect(coverage.links).toBe(cap + 1);
  });

  it('clock-regressed chained window still summarizes — the ordinal latch ignores timestamps', async () => {
    // Round-32 audit MEDIUM pin: window N+1's FIRST step REGRESSES before
    // window N's end (clock skew inside one segment). The superseded
    // interval-intersection latch saw that overlap, skipped the window,
    // persistTx never ran — the tail and its extract_memory/mine_workflows
    // jobs were silently lost forever. Append-order ordinals are monotonic,
    // so the chained window must proceed despite the timestamp overlap.
    const cap = CONSTANTS.summarizeMaxInputSteps;
    const segment = segments.createOpen(NOW, 'e0', NOW);
    for (let i = 0; i < cap + 2; i++) {
      // Strictly DESCENDING timestamps across append order: every step of
      // the second window starts before every step of the first ends.
      const startedAtMs = NOW - i * 60_000;
      const step: CoalescedStep = {
        action: 'type',
        appBundleId: 'com.apple.Safari',
        appName: 'Safari',
        target: `target-${i}`,
        text: `step text ${i}`,
        startedAtMs,
        endedAtMs: startedAtMs + 30_000,
        firstEventId: `e${i}a`,
        lastEventId: `e${i}b`,
        eventCount: 1,
        targetRole: null,
      };
      segments.appendStep(segment.id, step, { text: step.text, target: step.target, appName: step.appName });
    }
    segments.finalize(segment.id, 'finalized', NOW + 60_000, {});
    const transport = new FakeTransport([
      wholeWindowSplit(cap, 'w0'),
      wholeWindowSplit(2, 'tail'),
    ]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => transport,
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
    });

    await summarizer.handle(enqueueSummarize(segment.id));
    await summarizer.handle(latestSummarizeJob());
    // Old latch: follow-up skipped → only w0 exists, one prompt. New latch:
    // both windows summarized.
    expect(transport.prompts).toHaveLength(2);
    const rows = episodes.listEpisodes({}, 10);
    expect(rows.map((r) => r.title).sort()).toEqual(['tail', 'w0']);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('tail')).toMatchObject({ stepCount: 2 });
    // The tail got its downstream jobs too (old latch: zero for it).
    const downstream = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('extract_memory', 'mine_workflows')")
      .get() as { n: number };
    expect(downstream.n).toBe(4); // 2 episodes × {extract_memory, mine_workflows}
  });

  it('re-delivered FOLLOW-UP job is idempotent after its window persisted — no duplicate episodes or downstream jobs', async () => {
    const segmentId = seedSegment(CONSTANTS.summarizeMaxInputSteps + 5);
    const cap = CONSTANTS.summarizeMaxInputSteps;
    const transport = new FakeTransport([
      wholeWindowSplit(cap, 'w0'),
      wholeWindowSplit(5, 'w1'),
    ]);
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => transport,
      summaryModel: 'test-background-model',
      now: () => NOW + 9_000_000,
    });

    await summarizer.handle(enqueueSummarize(segmentId));
    const followUp = latestSummarizeJob();
    await summarizer.handle(followUp);
    expect(episodes.listEpisodes({}, 10).map((e) => e.title)).toEqual(['w1', 'w0']);

    // Crash-recovery re-delivery of the SAME follow-up job: the window latch
    // skips it without an LLM call or any new rows/jobs.
    await summarizer.handle(followUp);
    expect(episodes.listEpisodes({}, 10)).toHaveLength(2);
    expect(transport.prompts).toHaveLength(2);
    const extractJobs = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('extract_memory', 'mine_workflows')")
      .get() as { n: number };
    expect(extractJobs.n).toBe(4); // 2 episodes × 2 downstream types, no dupes
    const summarizeJobs = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'summarize_segment'")
      .get() as { n: number };
    expect(summarizeJobs.n).toBe(2); // original + ONE follow-up
  });
});
