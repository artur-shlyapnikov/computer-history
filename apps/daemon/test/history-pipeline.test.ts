import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEvent, EventBatch } from '@computer-history/protocol';

import { CONSTANTS } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { WorkflowsRepository } from '../src/db/workflows-repository.js';
import { migrate } from '../src/db/migrator.js';
import type { Logger } from '../src/logging.js';
import { HistoryPipeline, type PipelineEventKind } from '../src/processing/history-pipeline.js';
import { FakeTransport } from '../src/llm/fake-transport.js';
import { focusPair, typeEvent, T0 } from './helpers/events.js';
import type { StructuredTransport } from '../src/llm/structured-prompt-runner.js';

/**
 * Behavioral pins over the consolidated distillation graph (the coordination
 * previously spread across main.ts wiring + shutdown comments):
 * 1. raw ingest → watermark sweep → segment → idle-close → summarize_segment;
 * 2. a completed summary fans out extract_memory + mine_workflows;
 * 3. serialized LLM jobs never overlap (one in flight process-wide);
 * 4. pipeline.shutdown drains the backlog, finalizes the open segment and
 *    leaves its summarize job QUEUED for the next boot (SVC-01).
 */

const VALID_SPLIT = {
  episodes: [
    {
      firstStepOrdinal: 0,
      lastStepOrdinal: 0,
      title: 'Solo step',
      summary: 'One step.',
      intent: 'unknown',
      outcome: 'unknown',
      entities: [],
    },
  ],
};

/** Transport whose single completion is released manually (serialization pin). */
class ParkedTransport implements StructuredTransport {
  private release?: (payload: string) => void;
  readonly prompts: Array<{ systemPrompt: string }> = [];

  complete(systemPrompt: string): Promise<string> {
    this.prompts.push({ systemPrompt });
    return new Promise((resolve) => {
      this.release = () => resolve(JSON.stringify(VALID_SPLIT));
    });
  }

  unpark(): void {
    this.release?.(JSON.stringify(VALID_SPLIT));
  }
}

function makeBatch(events: ActivityEvent[]): EventBatch {
  return {
    protocolVersion: 1,
    messageId: 'test',
    type: 'event_batch',
    sentAt: 0,
    batchId: `batch-${events[0]?.id ?? 'empty'}`,
    events,
  };
}

describe('HistoryPipeline', () => {
  let home: string;
  let db: Db;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let now: number;
  let broadcasts: Array<[PipelineEventKind, Record<string, unknown>]>;
  /** Real timers: the debounced sweep needs a few macrotasks to fire. */
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-pipeline-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    jobs = new JobsRepository(db);
    segments = new SegmentsRepository(db);
    now = T0;
    broadcasts = [];
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function buildPipeline(transport: StructuredTransport): HistoryPipeline {
    const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };
    return new HistoryPipeline({
      db,
      events: new EventsRepository(db),
      segments,
      episodes: new EpisodesRepository(db),
      memories: new MemoriesRepository(db),
      workflows: new WorkflowsRepository(db),
      jobs,
      logger,
      llmConfig: { chatModel: 'test-chat', backgroundModel: 'test-background' },
      transportFactory: async () => transport,
      broadcastEvent: (kind, payload) => broadcasts.push([kind, payload]),
      now: () => now,
      watermarkLagMs: 0,
      debounceMs: 5,
    });
  }

  const segmentRows = (): Array<{ id: string; state: string; summarize_job_id: string | null }> =>
    db
      .prepare('SELECT id, state, summarize_job_id FROM activity_segments ORDER BY started_at_ms')
      .all() as Array<{ id: string; state: string; summarize_job_id: string | null }>;

  const jobRows = (): Array<{ id: string; type: string; state: string; payload_json: string }> =>
    db.prepare('SELECT id, type, state, payload_json FROM jobs ORDER BY created_at_ms').all() as never;

  it('raw ingest becomes a segment; crossing the idle boundary queues exactly one summarize_segment', async () => {
    const pipeline = buildPipeline(new ParkedTransport());
    // The sweep only delivers rows strictly older than `now − lag`, so run
    // the clock ahead of the ingested timestamps before waiting it out.
    pipeline.ingest(makeBatch(focusPair(100)));
    now = T0 + 5_000;
    await settled();
    // Mid-flight pins (restored): the sweep collapsed the focus pair into
    // ONE open segment immediately, and nothing enqueue-side broadcast a
    // queue_update before the idle-close boundary.
    const midFlight = segmentRows();
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0]).toMatchObject({ state: 'open', summarize_job_id: null });
    expect(broadcasts).toEqual([]);
    now = T0 + CONSTANTS.segmentIdleCloseMs + 60_000;
    pipeline.ingest(makeBatch([typeEvent({ observedAt: now })]));
    now += 5_000;
    await settled();

    const rows = segmentRows();
    expect(rows.map((r) => r.state)).toEqual(['finalized', 'open']);
    const summaries = jobRows().filter((j) => j.type === 'summarize_segment');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.state).toBe('pending');
    expect(JSON.parse(summaries[0]!.payload_json)).toEqual({ segmentId: rows[0]!.id });
    expect(rows[0]?.summarize_job_id).toBe(summaries[0]!.id);
    // SVC-03: the enqueue-side transition reached the shared sink immediately.
    expect(broadcasts).toContainEqual(['queue_update', { pendingJobs: 1 }]);
  });

  it('a completed summarize_segment persists its episode and fans out both downstream jobs', async () => {
    const pipeline = buildPipeline(new FakeTransport([JSON.stringify(VALID_SPLIT)]));
    pipeline.ingest(makeBatch(focusPair(100)));
    now = T0 + 5_000;
    await settled();
    now = T0 + CONSTANTS.segmentIdleCloseMs + 60_000;
    pipeline.ingest(makeBatch([typeEvent({ observedAt: now })]));
    now += 5_000;
    await settled();
    expect(jobRows().filter((j) => j.type === 'summarize_segment')).toHaveLength(1);

    // Drive the worker deterministically: claim + run the summary.
    pipeline.tick();
    await settled();

    const types = jobRows().map((j) => `${j.type}:${j.state}`);
    expect(types).toContain('summarize_segment:succeeded');
    // The persisted fan-out (ONE transaction with the episode insert):
    expect(types).toContain('extract_memory:pending');
    expect(types).toContain('mine_workflows:pending');
    const episodes = db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number };
    expect(episodes.n).toBe(1);
    expect(broadcasts).toContainEqual(['episodes_changed', {}]);
  });

  it('serialized LLM jobs never overlap: a parked summary blocks the whole chain', async () => {
    const parked = new ParkedTransport();
    const pipeline = buildPipeline(parked);

    // Two independent segments ⇒ two runnable summarize jobs. The clock
    // runs ahead of every batch so each sweep can deliver its rows.
    for (const offset of [0, CONSTANTS.segmentIdleCloseMs + 60_000]) {
      pipeline.ingest(makeBatch(focusPair(100, 't1')));
      now = T0 + offset + 5_000;
      await settled();
      // Cross the idle boundary: this close is what produces the job.
      pipeline.ingest(makeBatch([typeEvent({ observedAt: T0 + offset + CONSTANTS.segmentIdleCloseMs + 30_000 })]));
      now = T0 + offset + CONSTANTS.segmentIdleCloseMs + 65_000;
      await settled();
    }
    const summaries = jobRows().filter((j) => j.type === 'summarize_segment' && j.state === 'pending');
    expect(summaries.length).toBeGreaterThanOrEqual(2);

    // First claim starts the parked LLM completion…
    pipeline.tick();
    await settled();
    expect(parked.prompts).toHaveLength(1);

    // …and while it parks, NO other serialized job may be claimed
    // (spec §3.15: exactly one background LLM job in flight).
    pipeline.tick();
    pipeline.tick();
    await settled();
    const running = jobRows().filter((j) => j.state === 'running');
    expect(running.map((j) => j.type)).toEqual(['summarize_segment']);
    expect(parked.prompts).toHaveLength(1);

    parked.unpark();
    await settled();
  });

  it('shutdown drains the watermark backlog, finalizes the open segment, and leaves its job queued', async () => {
    const pipeline = buildPipeline(new ParkedTransport());

    pipeline.ingest(makeBatch(focusPair(100)));
    // The clock runs ahead of the batch: shutdown's final drain must still
    // deliver these rows even though no debounced sweep ever fired.
    now = T0 + 5_000;
    // NO sweep wait: shutdown itself must perform the final drain.
    await pipeline.shutdown();
    const unprocessed = db
      .prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NULL')
      .get() as { n: number };
    expect(unprocessed.n).toBe(0);
    // The open segment was closed and handed its summarize job…
    const rows = segmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('finalized');
    // …which persists QUEUED (worker already stopped): startup recovery owns it.
    const summaries = jobRows().filter((j) => j.type === 'summarize_segment');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.state).toBe('pending');
  });

  it('emitQueueUpdate dedups by last value: same count broadcasts once, a new count again', () => {
    const pipeline = buildPipeline(new ParkedTransport());
    // First broadcast establishes the baseline count.
    pipeline.emitQueueUpdate(3);
    expect(broadcasts).toEqual([['queue_update', { pendingJobs: 3 }]]);
    // SVC-03: the SAME count must not re-broadcast…
    pipeline.emitQueueUpdate(3);
    expect(broadcasts).toHaveLength(1);
    // …but a different count must.
    pipeline.emitQueueUpdate(4);
    expect(broadcasts).toEqual([
      ['queue_update', { pendingJobs: 3 }],
      ['queue_update', { pendingJobs: 4 }],
    ]);
  });

  it('emitQueueUpdate without a count recomputes and dedups against the last broadcast', () => {
    const pipeline = buildPipeline(new ParkedTransport());
    // Nothing ingested ⇒ pending + retry = 0; the recompute path dedups
    // against lastQueuedBroadcast exactly like the known-count path.
    pipeline.emitQueueUpdate();
    expect(broadcasts).toEqual([['queue_update', { pendingJobs: 0 }]]);
    pipeline.emitQueueUpdate();
    expect(broadcasts).toHaveLength(1);
  });
});
