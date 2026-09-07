import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { JobWorker } from '../src/jobs/job-worker.js';
import { FakeTransport } from '../src/llm/fake-transport.js';
import { MemoryExtractor } from '../src/processing/memory-extractor.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import type { Logger } from '../src/logging.js';

const NOW = 1_700_000_000_000;

/**
 * Backlog drain end-to-end (spec §3.9 forward-enqueue + §3.16 idempotent
 * re-run): extract_memory jobs enqueued BEFORE any handler is registered must
 * be claimed and completed once a real MemoryExtractor lands behind JobWorker
 * via the main-style registerSerialized LLM chain (main.ts). Each episode's
 * evidence may exist exactly once — the idempotency latch holds across
 * serialized re-claims.
 */
describe('extract_memory backlog drain through JobWorker (scripted transport)', () => {
  let db: Db;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let home: string;
  const logger: Logger = {
    log: vi.fn(),
    pruneOld: () => 0,
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-drain-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    episodes = new EpisodesRepository(db);
    memories = new MemoriesRepository(db);
    jobs = new JobsRepository(db);
    segments = new SegmentsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seedEpisodeWithSteps(title: string): string {
    const segment = segments.createOpen(NOW, `${title}-e0`, NOW);
    const step: CoalescedStep = {
      action: 'type',
      appBundleId: 'com.apple.Safari',
      appName: 'Safari',
      target: 'settings',
      targetRole: null,
      text: `switched editor (${title})`,
      startedAtMs: NOW,
      endedAtMs: NOW + 30_000,
      firstEventId: `${title}-ea`,
      lastEventId: `${title}-eb`,
      eventCount: 1,
    };
    void segments.appendStep(segment.id, step, {
      text: step.text,
      target: step.target,
      appName: step.appName,
    });
    segments.finalize(segment.id, 'finalized', NOW + 60_000, {});
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 60_000,
          title,
          summary: `Editor switch observed in ${title}`,
          intent: 'configure',
          outcome: 'done',
          apps: ['Safari'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: segments.getSteps(segment.id).map((s) => ({ id: s.id })),
        },
      ],
      NOW,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function jobState(id: string): string {
    return (
      db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as {
        state: string;
      }
    ).state;
  }

  it('drains three jobs enqueued before handler registration; evidence lands exactly once per episode', async () => {
    // Three finalized episodes…
    const episodeIds = [
      seedEpisodeWithSteps('session-vim'),
      seedEpisodeWithSteps('session-nvim'),
      seedEpisodeWithSteps('session-emacs'),
    ];
    // …whose extract_memory jobs are enqueued while NO handler exists yet
    // (forward-enqueue rule: unknown types stay pending untouched).
    const enqueued = episodeIds.map((episodeId) =>
      jobs.enqueue('extract_memory', { episodeId }, NOW, NOW),
    );
    expect(enqueued.map((j) => j.state)).toEqual(['pending', 'pending', 'pending']);

    // One scripted LLM response per episode, in claim order (oldest first).
    const transport = new FakeTransport(
      ['editor=vim', 'editor=nvim', 'editor=emacs'].map((text) =>
        JSON.stringify({
          candidates: [
            {
              kind: 'preference',
              canonicalKey: 'editor_preference',
              text,
              confidence: 0.6,
              evidenceDescription: `user set ${text}`,
            },
          ],
        }),
      ),
    );

    // Main-style wiring: real extractor behind the serialized LLM chain.
    const worker = new JobWorker({ jobs, logger, now: () => NOW, });
    const extractor = new MemoryExtractor({
      db,
      episodes,
      memories,
      logger,
      transportFactory: async () => transport,
      now: () => NOW,
    });
    worker.registerSerialized('extract_memory', (job) => extractor.handle(job));

    // Tick until quiet: one claim per tick, chain drained between ticks.
    for (let i = 0; i < 10; i += 1) {
      worker.tick();
      await worker.idle();
      const counts = jobs.countsByState(NOW);
      if (counts.pending + counts.retry + counts.running === 0) break;
    }

    expect(enqueued.map((j) => jobState(j.id))).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    // Evidence landed EXACTLY once per episode — no double-counted ledger
    // entries even though every job passed the serialized chain separately.
    const evidencePerEpisode = db
      .prepare(
        `SELECT episode_id AS episodeId, COUNT(*) AS n
         FROM memory_evidence GROUP BY episode_id ORDER BY episode_id`,
      )
      .all() as Array<{ episodeId: string; n: number }>;
    expect(evidencePerEpisode).toHaveLength(3);
    expect(new Set(evidencePerEpisode.map((r) => r.episodeId))).toEqual(
      new Set(episodeIds),
    );
    expect(evidencePerEpisode.every((r) => r.n === 1)).toBe(true);

    // And the three observations became three competing rows under one key,
    // all still candidates (single observation never promotes, spec §3.16).
    // Order-insensitive: rows share last_seen_at_ms, so listByKey falls back
    // to id ordering.
    const rows = memories.listByKey('editor_preference').map((r) => r.text).sort();
    expect(rows).toEqual(['editor=emacs', 'editor=nvim', 'editor=vim']);
    expect(
      memories
        .listByKey('editor_preference')
        .every((r) => r.status === 'candidate'),
    ).toBe(true);
  });
});
