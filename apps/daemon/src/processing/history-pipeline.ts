import type { EventBatch } from '@computer-history/protocol';

import { CONSTANTS, type LlmConfig } from '../config.js';
import type { Db } from '../db/database.js';
import type { EpisodesRepository } from '../db/episodes-repository.js';
import type { EventsRepository } from '../db/events-repository.js';
import type { JobsRepository } from '../db/jobs-repository.js';
import type { MemoriesRepository } from '../db/memories-repository.js';
import type { SegmentsRepository } from '../db/segments-repository.js';
import type { WorkflowsRepository } from '../db/workflows-repository.js';
import type { StructuredTransport } from '../llm/structured-prompt-runner.js';

import { EventIngestor, type BatchOutcome } from '../ingest/event-ingestor.js';
import { JobWorker } from '../jobs/job-worker.js';
import type { Logger } from '../logging.js';
import { PiBackgroundTransport } from '../llm/pi-runtime.js';
import { EpisodeSummarizer } from './episode-summarizer.js';
import { MemoryExtractor } from './memory-extractor.js';
import { Segmenter } from './segmenter.js';
import { WorkflowMiner } from './workflow-miner.js';

/** Server events the processing graph itself can emit (chat_* never come from here). */
export type PipelineEventKind =
  | 'queue_update'
  | 'episodes_changed'
  | 'memories_changed'
  | 'workflows_changed';

export interface HistoryPipelineOptions {
  db: Db;
  events: EventsRepository;
  segments: SegmentsRepository;
  episodes: EpisodesRepository;
  memories: MemoriesRepository;
  workflows: WorkflowsRepository;
  jobs: JobsRepository;
  logger: Logger;
  /**
   * Wire seam for processing-side broadcasts. Invoked only once the IPC
   * surface is live (after server.listen()), so forwarding straight into
   * IpcServer.broadcastEvent is safe despite the construction-order forward
   * reference.
   */
  broadcastEvent(kind: PipelineEventKind, payload: Record<string, unknown>): void;
  /** Env-resolved LLM config; background transports are built lazily per job. */
  llmConfig: LlmConfig;
  /**
   * Test seam: replaces the lazy PiBackgroundTransport factory (contracts
   * §LLM boundary: zero live network in the suite). Production wiring omits it.
   */
  transportFactory?: () => Promise<StructuredTransport>;
  /** Injectable clock and sweep knobs (testing conventions); pinned defaults. */
  now?: () => number;
  watermarkLagMs?: number;
  debounceMs?: number;
}
/**
 * The background distillation graph behind one subsystem boundary.
 *
 * Owns everything main.ts used to know about HOW raw activity becomes
 * semantic history:
 *
 * - the ingest → watermark-sweep → segmenter handoff;
 * - the job topology (`summarize_segment` closes segments and schedules
 *   `extract_memory` + `mine_workflows`; summarization suffix-chains itself
 *   while steps remain);
 * - the serialization policy: all three LLM-bound handlers share ONE worker
 *   promise chain — exactly one background LLM job in flight process-wide
 *   (spec §3.15);
 * - the shared deduplicating queue_update sink (SVC-03): every enqueue-side
 *   and transition-side emitter feeds ONE last-value guard so a stale count
 *   can never strand;
 * - the shutdown drain/finalize ordering whose steps look arbitrary but are
 *   load-bearing (see `shutdown`).
 *
 * Daemon-level policy stays OUT: disk-pressure gating wraps `ingest` at the
 * composition root, retention/checkpoint/chat own their own lifecycles.
 */
export class HistoryPipeline {
  private readonly jobs: JobsRepository;
  private readonly logger: Logger;
  private readonly broadcastEvent: HistoryPipelineOptions['broadcastEvent'];
  readonly ingestor: EventIngestor;
  private readonly segmenter: Segmenter;
  private readonly jobWorker: JobWorker;
  /** Dedup state of the shared queue_update sink (null = nothing sent yet). */
  private lastQueuedBroadcast: number | null = null;

  constructor(options: HistoryPipelineOptions) {
    this.jobs = options.jobs;
    this.logger = options.logger;
    this.broadcastEvent = (kind, payload) => options.broadcastEvent(kind, payload);
    const segmenter = new Segmenter({
      db: options.db,
      events: options.events,
      segments: options.segments,
      jobs: options.jobs,
      onJobEnqueued: () => this.emitQueueUpdate(),
      logger: options.logger,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.segmenter = segmenter;
    this.ingestor = new EventIngestor({
      repository: options.events,
      logger: options.logger,
      coordinator: segmenter,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.watermarkLagMs !== undefined
        ? { watermarkLagMs: options.watermarkLagMs }
        : {}),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    });

    const transportFactory =
      options.transportFactory ?? (async () => new PiBackgroundTransport(options.llmConfig));
    const now = options.now;
    const summarizer = new EpisodeSummarizer({
      db: options.db,
      segments: options.segments,
      episodes: options.episodes,
      jobs: options.jobs,
      logger: options.logger,
      transportFactory,
      summaryModel: options.llmConfig.backgroundModel,
      onEpisodesChanged: () => this.broadcastEvent('episodes_changed', {}),
      onJobEnqueued: () => this.emitQueueUpdate(),
      ...(now !== undefined ? { now } : {}),
    });
    const memoryExtractor = new MemoryExtractor({
      db: options.db,
      episodes: options.episodes,
      memories: options.memories,
      logger: options.logger,
      transportFactory,
      onMemoriesChanged: () => this.broadcastEvent('memories_changed', {}),
      ...(now !== undefined ? { now } : {}),
    });
    const workflowMiner = new WorkflowMiner({
      episodes: options.episodes,
      workflows: options.workflows,
      logger: options.logger,
      transportFactory,
      onWorkflowsChanged: () => this.broadcastEvent('workflows_changed', {}),
      ...(now !== undefined ? { now } : {}),
    });

    const jobWorker = new JobWorker({
      jobs: options.jobs,
      logger: options.logger,
      pollIntervalMs: CONSTANTS.queuePollIntervalMs,
      leaseMs: CONSTANTS.jobLeaseMs,
      onQueueUpdate: (pendingJobs) => this.emitQueueUpdate(pendingJobs),
    });
    // Job topology lives HERE, not at the composition root: main.ts must not
    // need to know that these three types exist, that they chain each other,
    // or that they share one serialized chain (spec §3.15/§3.16/§3.20).
    jobWorker.registerSerialized('summarize_segment', (job) => summarizer.handle(job));
    // Memory extraction runs on the same serialized LLM chain — exactly one
    // background LLM job in flight process-wide.
    jobWorker.registerSerialized('extract_memory', (job) => memoryExtractor.handle(job));
    // Workflow mining likewise.
    jobWorker.registerSerialized('mine_workflows', (job) => workflowMiner.handle(job));
    this.jobWorker = jobWorker;
  }

  /**
   * Single dedup point for EVERY queue_update emitter (worker, job-ops,
   * segmenter close, summarizer fan-out): a per-emitter guard would strand a
   * stale count whenever another emitter moves the number in between.
   * Transition-side emitters pass their freshly computed count so the sink
   * need not re-run COUNT queries; enqueue-side emitters have no count and
   * recompute here.
   */
  emitQueueUpdate(known?: number): void {
    let queued = known;
    if (queued === undefined) {
      const counts = this.jobs.countsByState();
      queued = counts.pending + counts.retry;
    }
    if (queued === this.lastQueuedBroadcast) return;
    this.lastQueuedBroadcast = queued;
    this.broadcastEvent('queue_update', { pendingJobs: queued });
  }

  /** Validates + inserts one wire batch and arms the watermark sweep. */
  ingest(batch: EventBatch): BatchOutcome {
    return this.ingestor.ingest(batch);
  }

  /**
   * Starts background consumption. Callers MUST only start the pipeline once
   * the IPC surface is live: queue_update/episodes_changed broadcasts must
   * reach connected clients (spec §3.15).
   */
  start(): void {
    this.jobWorker.start();
  }

  /**
   * One poll cycle of the job worker. Test seam with the same contract as
   * `JobWorker.tick`: lets suites drive claims deterministically instead of
   * sleeping against the real interval.
   */
  tick(): void {
    this.jobWorker.tick();
  }

  /**
   * Drains and finalizes the processing graph for daemon shutdown. Order is
   * load-bearing:
   *
   * 1. dispose() kills the sweep timers BEFORE draining — it is synchronous
   *    timer teardown, and draining with the debounced sweep timer still
   *    armed would let a future async coordinator yield mid-drain and race
   *    runSweep into overlapping pages (= duplicate segments). The ingestor's
   *    own draining latch is the second belt.
   * 2. One final awaited watermark drain: finalizeForShutdown() never touches
   *    raw_events, so without it every event inside the watermark lag +
   *    debounce window would stay processed_at_ms NULL forever (retention
   *    spares unprocessed rows) and resurface after restart as per-event
   *    straggler segments. Failure-tolerant: a SQLITE_BUSY/FULL must never
   *    block exit.
   * 3. Stop the poll loop FIRST (drain any in-flight handler, then stop
   *    ticking) BEFORE the final enqueue: otherwise the still-live 1 s poll
   *    could claim and start an LLM summarize job mid-teardown, racing stop()'s
   *    drain grace window. Enqueued after the stop, the final summarize job
   *    simply persists queued for the next boot's startup recovery (SVC-01).
   * 4. Close the open activity segment (spec §3.13), enqueueing its
   *    summarize_segment job before the caller reaches the WAL checkpoint.
   */
  async shutdown(): Promise<void> {
    this.ingestor.dispose();
    await this.ingestor.drainForShutdown();
    await this.jobWorker.stop();
    this.segmenter.finalizeForShutdown();
    this.logger.log('info', 'pipeline', 'processing graph drained and finalized');
  }
}
