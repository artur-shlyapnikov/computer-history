import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONSTANTS } from '../src/config.js';
import type { Logger } from '../src/logging.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodeSummarizer } from '../src/processing/episode-summarizer.js';
import { MemoryExtractor } from '../src/processing/memory-extractor.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import { FakeTransport } from '../src/llm/fake-transport.js';
import type { JobRow } from '../src/db/jobs-repository.js';

const NOW = 1_700_000_000_000;

/**
 * LLM input budgets: the summarizer's broken-payload guard (complete without
 * side effects), the summarizeStepTextChars clip on the segment prompt, and
 * the extractor's MAX_INPUT_STEPS=40 / MAX_STEP_TEXT_CHARS=200 prompt caps.
 * FakeTransport records every prompt; no transport I/O, injected clocks.
 */
describe('llm input budgets', () => {
  let db: Db;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let home: string;

  const logSpy = vi.fn<(level: string, scope: string, message: string, fields?: Record<string, unknown>) => void>();
  const logger: Logger = { log: logSpy, pruneOld: () => 0 };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-input-budgets-'));
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
    vi.clearAllMocks();
  });

  function appendStep(segmentId: string, index: number, text: string): void {
    const step: CoalescedStep = {
      action: 'type',
      appBundleId: 'com.apple.Safari',
      appName: 'Safari',
      target: `target-${index}`,
      text,
      startedAtMs: NOW + index * 60_000,
      endedAtMs: NOW + index * 60_000 + 30_000,
      firstEventId: `e${index}a`,
      lastEventId: `e${index}b`,
      eventCount: 1,
      targetRole: null,
    };
    segments.appendStep(segmentId, step, { text: step.text, target: step.target, appName: step.appName });
  }

  function seedSegment(stepCount: number, textOf: (index: number) => string): string {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    for (let i = 0; i < stepCount; i++) appendStep(segment.id, i, textOf(i));
    segments.finalize(segment.id, 'finalized', NOW + stepCount * 60_000, {});
    return segment.id;
  }

  function seedEpisodeWithSteps(stepCount: number, textOf: (index: number) => string): string {
    const segmentId = seedSegment(stepCount, textOf);
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + stepCount * 60_000,
          title: 'Browsing session',
          summary: 'Read docs in Safari',
          intent: 'research',
          outcome: 'done',
          apps: ['Safari'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: segments.getSteps(segmentId).map((s) => ({ id: s.id })),
        },
      ],
      NOW,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function jobRow(type: string, payload: unknown): JobRow {
    const job = jobs.enqueue(type, payload, NOW, NOW);
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow;
  }

  /**
   * The embedded input of the first captured prompt — everything after the
   * runner's 'Input data:' marker up to the closing instruction block.
   */
  function inputOf(transport: FakeTransport): string {
    const userPrompt = transport.prompts[0]?.userPrompt ?? '';
    const marker = 'Input data:\n';
    const start = userPrompt.indexOf(marker) + marker.length;
    const end = userPrompt.indexOf('\n\nRespond', start);
    return userPrompt.slice(start, end === -1 ? undefined : end);
  }

  it('summarizer completes a broken payload with zero side effects and an error log', async () => {
    const getSegmentSpy = vi.spyOn(segments, 'getSegment');
    const summarizer = new EpisodeSummarizer({
      db,
      segments,
      episodes,
      jobs,
      logger,
      transportFactory: async () => new FakeTransport([]),
      summaryModel: 'test-background-model',
      now: () => NOW,
    });

    await expect(summarizer.handle(jobRow('summarize_segment', {}))).resolves.toBeUndefined();

    expect(getSegmentSpy).not.toHaveBeenCalled();
    expect(episodes.listEpisodes({}, 10)).toHaveLength(0); // no episode writes
    expect(logSpy).toHaveBeenCalledWith(
      'error',
      'summarizer',
      expect.stringContaining('payload missing segmentId'),
      expect.anything(),
    );
  });

  it('clips each summarizer prompt step text to summarizeStepTextChars', async () => {
    const longText = 'z'.repeat(5000);
    const segmentId = seedSegment(1, () => longText);
    const split = {
      episodes: [
        {
          firstStepOrdinal: 0,
          lastStepOrdinal: 0,
          title: 'Single episode',
          summary: 'One step.',
          intent: 'unknown',
          outcome: 'unknown',
          entities: [],
        },
      ],
    };
    const transport = new FakeTransport([JSON.stringify(split)]);
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

    await summarizer.handle(jobRow('summarize_segment', { segmentId }));

    expect(transport.prompts).toHaveLength(1);
    const body = JSON.parse(inputOf(transport)) as {
      segmentId: string;
      steps: Array<{ text: string | null }>;
    };
    expect(body.segmentId).toBe(segmentId);
    expect(body.steps).toHaveLength(1);
    // Producer contract: JSON.stringify({segmentId, steps}) with clipped text.
    expect(body.steps[0]?.text).toHaveLength(CONSTANTS.summarizeStepTextChars);
  });

  it('caps the extractor prompt at 40 steps and 200 chars per step text', async () => {
    const textOf = (i: number) => `#${i}:` + 'y'.repeat(300 - String(i).length - 2);
    const episodeId = seedEpisodeWithSteps(45, textOf);
    const transport = new FakeTransport([JSON.stringify({ candidates: [] })]);
    const extractor = new MemoryExtractor({
      db,
      episodes,
      memories,
      logger,
      transportFactory: async () => transport,
      now: () => NOW,
    });

    await extractor.handle(jobRow('extract_memory', { episodeId }));

    expect(transport.prompts).toHaveLength(1);
    const body = inputOf(transport);
    const lines = body.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(40);
    for (const line of lines) {
      const textPortion = line.split(' · ').pop() ?? '';
      expect(textPortion.length).toBeLessThanOrEqual(200);
    }
    // Steps 41–45 are entirely absent from the prompt.
    for (const absent of [40, 41, 42, 43, 44]) {
      expect(body).not.toContain(`#${absent}:`);
    }
  });
});
