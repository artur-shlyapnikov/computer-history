import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

import type { SemanticStepDto } from '@computer-history/protocol';

import { CONSTANTS } from '../config.js';
import { replaceWellFormedTarget } from '../util/text.js';
import type { Db } from '../db/database.js';
import type { EpisodesRepository, NewEpisode } from '../db/episodes-repository.js';
import type { JobRow, JobsRepository } from '../db/jobs-repository.js';
import type { SegmentsRepository } from '../db/segments-repository.js';
import type { Logger } from '../logging.js';
import {
  StructuredPromptRunner,
  StructuredValidationError,
  type StructuredTransport,
} from '../llm/structured-prompt-runner.js';

/** Allowed values for intent/outcome per brief-m3 §D3 item 5 (incl. 'unknown'). */
export const EPISODE_INTENT_OUTCOME = [
  'research',
  'communication',
  'creation',
  'browsing',
  'development',
  'meeting',
  'media',
  'planning',
  'unknown',
] as const;

const IntentOutcome = Type.Union(EPISODE_INTENT_OUTCOME.map((v) => Type.Literal(v)));

/**
 * LLM output contract for summarize_segment (spec §3.14). firstStepOrdinal/
 * lastStepOrdinal are ZERO-BASED positions in the ordered step list; the
 * contiguity invariants below are enforced in validateSplit and share the
 * single repair attempt.
 */
export const EpisodeSplitSchema = Type.Object(
  {
    episodes: Type.Array(
      Type.Object({
        firstStepOrdinal: Type.Integer({ minimum: 0 }),
        lastStepOrdinal: Type.Integer({ minimum: 0 }),
        title: Type.String({ maxLength: 120 }),
        // summary/entities are bounded like title so a degenerate model
        // response cannot persist multi-MB blobs into episodes (+FTS) and
        // trip the recorder's 1 MiB IPC frame guard, which would silently
        // drop the episode frame while the DB row stays bloated.
        summary: Type.String({ maxLength: 8000 }),
        intent: IntentOutcome,
        outcome: IntentOutcome,
        entities: Type.Array(Type.String({ maxLength: 120 }), { maxItems: 50 }),
      }),
      { minItems: 1, maxItems: 6 },
    ),
  },
  { additionalProperties: false },
);
export type EpisodeSplit = Static<typeof EpisodeSplitSchema>;

/** Bumped whenever the summarizer prompt materially changes. */
export const SUMMARY_PROMPT_VERSION = 'v1';

export interface EpisodeSummarizerOptions {
  segments: SegmentsRepository;
  /**
   * Shared SQLite handle; episode persistence and the per-episode
   * extract_memory/mine_workflows enqueues commit in ONE transaction, so an
   * enqueue failure can no longer strand persisted episodes without their
   * downstream jobs (the hasEpisodesForSteps latch would then skip them
   * forever on re-delivery). better-sqlite3 nests the repository's own
   * transaction via savepoints.
   */
  db: Db;
  episodes: EpisodesRepository;
  jobs: JobsRepository;
  logger: Logger;
  /**
   * Lazy transport factory: Pi credentials may be absent at daemon startup, so
   * the transport is only built when a job actually runs — its failure then
   * flows into the normal retry schedule instead of crashing the worker.
   */
  transportFactory: () => Promise<StructuredTransport>;
  /** Injectable clock. */
  now?: () => number;
  /** Per-attempt prompt timeout; pinned default 120_000 ms. */
  timeoutMs?: number;
  /** Model id recorded on persisted episodes (episodes.summary_model). */
  summaryModel?: string;
  /** Invoked AFTER the episodes commit (daemon wires it to `episodes_changed`). */
  onEpisodesChanged?: () => void;
  /**
   * Invoked after persistTx commits its extract_memory/mine_workflows
   * enqueues (SVC-03): enqueue-side transitions must reach connected
   * recorders as queue_update immediately — tick() early-returns while the
   * serialized chain is busy, so the next worker claim could be minutes away.
   * Daemon wires this to the same JobsRepository-backed counter emit as
   * JobWorker.onQueueUpdate.
   */
  onJobEnqueued?: () => void;
}

/**
 * summarize_segment handler (spec §3.14): segment meta + numbered steps → LLM
 * split → hard validation → ONE repair → fallback single episode covering the
 * whole segment. Persistence, extract_memory enqueue and the episodes_changed
 * event happen exactly once per accepted split; no events are ever lost to an
 * LLM failure (spec §3.14 «Никакие events из-за failure не теряются»).
 */
export class EpisodeSummarizer {
  private readonly db: Db;
  private readonly persistTx: (
    episodes: NewEpisode[],
    followUpStepOffset: number | null,
    segmentId: string,
    createdAtMs: number,
  ) => void;
  private readonly episodes: EpisodesRepository;
  private readonly onJobEnqueued?: () => void;
  private readonly segments: SegmentsRepository;
  private readonly jobs: JobsRepository;
  private readonly logger: Logger;
  private readonly transportFactory: () => Promise<StructuredTransport>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly summaryModel: string;
  private readonly onEpisodesChanged?: () => void;
  constructor(options: EpisodeSummarizerOptions) {
    this.db = options.db;
    // ONE transaction for insert + enqueue loop: a crash or enqueue throw rolls
    // back BOTH sides, so re-delivery replays the whole summarize instead of
    // hitting the hasEpisodesForSteps skip with downstream jobs missing.
    // The same transaction enqueues the suffix-chained follow-up
    // summarize_segment job (stepOffset payload) when steps remain beyond the
    // per-call cap — episodes and their continuation commit atomically.
    this.persistTx = this.db.transaction(
      (
        episodes: NewEpisode[],
        followUpStepOffset: number | null,
        segmentId: string,
        createdAtMs: number,
      ) => {
        const ids = this.episodes.insertEpisodesWithLinks(episodes, createdAtMs);
        for (const id of ids) {
          // M5 owns extract_memory handling; M6 chains mine_workflows right AFTER
          // it (brief-m6 §D6 item 3). Unknown-type jobs stay pending by design.
          this.jobs.enqueueTyped('extract_memory', { episodeId: id }, createdAtMs, createdAtMs);
          this.jobs.enqueueTyped('mine_workflows', { episodeId: id }, createdAtMs, createdAtMs);
        }
        if (followUpStepOffset !== null) {
          this.jobs.enqueueTyped(
            'summarize_segment',
            { segmentId, stepOffset: followUpStepOffset },
            createdAtMs,
            createdAtMs,
          );
        }
      },
    );
    this.segments = options.segments;
    this.episodes = options.episodes;
    this.jobs = options.jobs;
    this.logger = options.logger;
    this.transportFactory = options.transportFactory;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONSTANTS.promptTimeoutMs;
    this.summaryModel = options.summaryModel ?? 'unknown';
    this.onEpisodesChanged = options.onEpisodesChanged;
    this.onJobEnqueued = options.onJobEnqueued;
  }

  async handle(job: JobRow): Promise<void> {
    let payload: { segmentId?: string; stepOffset?: number };
    try {
      payload = JSON.parse(job.payload_json) as { segmentId?: string; stepOffset?: number };
    } catch {
      // Corrupt/truncated payload: retrying cannot fix it.
      this.logger.log('error', 'summarizer', 'summarize_segment payload unparseable', { jobId: job.id });
      return; // unfixable payload: complete without side effects
    }
    if (typeof payload.segmentId !== 'string') {
      this.logger.log('error', 'summarizer', 'summarize_segment payload missing segmentId', { jobId: job.id });
      return; // unfixable payload: complete without side effects
    }
    if (
      payload.stepOffset !== undefined &&
      (!Number.isInteger(payload.stepOffset) || payload.stepOffset < 0)
    ) {
      this.logger.log('error', 'summarizer', 'summarize_segment payload has invalid stepOffset', {
        jobId: job.id,
      });
      return; // unfixable payload: complete without side effects
    }
    const stepOffset = payload.stepOffset ?? 0;
    const segment = this.segments.getSegment(payload.segmentId);
    // Fetch only this job's window (cap + 1 probe row decides chaining)
    // instead of the whole segment: chained suffix jobs previously re-read
    // every step of the segment per window, O(n²/cap) row reads across a
    // chain. `stepOffset` is an ORDINAL bound, not an array index: ordinals
    // are 1-based per segment but can have gaps (retention purges delete
    // arbitrary time-cutoff steps), so windows are chained on actual
    // ordinals — `ordinal > stepOffset` returns exactly the unsummarized
    // suffix under any gap pattern.
    const window =
      segment === null
        ? []
        : this.segments.getStepsRange(
            payload.segmentId,
            stepOffset,
            CONSTANTS.summarizeMaxInputSteps + 1,
          );
    const hasMore = window.length > CONSTANTS.summarizeMaxInputSteps;
    const inputSteps = hasMore
      ? window.slice(0, CONSTANTS.summarizeMaxInputSteps)
      : window;
    if (segment === null || window.length === 0) {
      // Nothing left to summarize — deleted range / purged steps, or a
      // suffix window past the current step count. Not a failure.
      this.logger.log(
        'info',
        'summarizer',
        stepOffset === 0 ? 'segment missing or empty; skipping' : 'suffix window beyond segment steps; skipping',
        {
          segmentId: payload.segmentId,
          stepOffset,
        },
      );
      return;
    }
    // Pathological segments (thousands of steps) would otherwise produce a
    // multi-MB prompt that providers reject as context-length overflow. The
    // cap stays per LLM call; instead of silently dropping the tail, the run
    // covers [stepOffset, stepOffset + cap) and persistTx chains a follow-up
    // summarize_segment job for the next window. The model sees and returns
    // WINDOW-LOCAL ordinals starting at 0 (validateSplit's coverage contract);
    // toNewEpisode maps them back onto the global slice below.
    if (this.episodes.hasEpisodesForSteps(inputSteps)) {
      // Re-delivery after a crash between persist and job-complete: the split
      // is already durable — completing again would duplicate episodes.
      this.logger.log('info', 'summarizer', 'segment window already summarized; skipping re-delivery', {
        segmentId: payload.segmentId,
        jobId: job.id,
        stepOffset,
      });
      return;
    }
    if (stepOffset > 0 || hasMore) {
      this.logger.log('info', 'summarizer', 'summarizing capped step window of oversized segment', {
        segmentId: payload.segmentId,
        stepOffset,
        windowSteps: inputSteps.length,
        chained: hasMore,
      });
    }

    const runner = new StructuredPromptRunner({
      transport: await this.transportFactory(),
      timeoutMs: this.timeoutMs,
    });
    let split: EpisodeSplit;
    try {
      split = await runner.run({
        schema: EpisodeSplitSchema,
        systemPrompt: SYSTEM_PROMPT,
        input: buildSegmentInput(segment.id, segment.started_at_ms, inputSteps),
        validate: (value) => validateSplit(value, inputSteps.length),
      });
    } catch (err) {
      if (!(err instanceof StructuredValidationError)) throw err; // outage → retry schedule
      this.logger.log('warn', 'summarizer', 'split invalid after repair; falling back to single episode', {
        jobId: job.id,
        segmentId: payload.segmentId,
      });
      split = fallbackSplit(inputSteps);
    }
    const createdAtMs = this.now();
    // Window-local ordinals in, global steps out: toNewEpisode keys each
    // episode on its step's real `ordinal` (gap-aware after retention
    // purges), never on local index arithmetic.
    const newEpisodes = split.episodes.map((episode) =>
      toNewEpisode(episode, inputSteps, this.summaryModel),
    );
    // Chain on the LAST COVERED ROW's actual ordinal, not stepOffset +
    // inputSteps.length: purged steps leave ordinal gaps, so the count-based
    // value can point at an already-covered ordinal and make the follow-up
    // window overlap this one (hasEpisodesForSteps then skips it and the
    // segment tail is never summarized).
    const lastCoveredStep = inputSteps.at(-1);
    if (lastCoveredStep === undefined) {
      // Unreachable: empty windows early-return before the LLM call.
      throw new Error('summarize_segment window empty after early returns');
    }
    const nextOffset = lastCoveredStep.ordinal;
    this.persistTx(
      newEpisodes,
      hasMore ? nextOffset : null,
      payload.segmentId,
      createdAtMs,
    );
    this.logger.log('info', 'summarizer', 'episodes persisted', {
      segmentId: payload.segmentId,
      count: newEpisodes.length,
    });
    this.onJobEnqueued?.();
    this.onEpisodesChanged?.();
  }
}

const SYSTEM_PROMPT =
  'You summarize computer-activity segments into episodic memories. ' +
  'You receive a numbered list of semantic steps with timestamps, apps, targets and text. ' +
  'Split them into 1–6 contiguous episodes covering EVERY step exactly once, in order, ' +
  'without overlaps or gaps. Use zero-based step ordinals. Titles are short human summaries ' +
  '(≤ 120 chars). intent and outcome must be one of the enum values; use "unknown" when unclear.';

interface SegmentInputStep {
  ordinal: number;
  startedAtIso: string;
  endedAtIso: string;
  app: string;
  target: string | null;
  text: string | null;
}

function buildSegmentInput(segmentId: string, startedAtMs: number, steps: SemanticStepDto[]): string {
  const body: SegmentInputStep[] = steps.map((step, index) => ({
    ordinal: index,
    startedAtIso: new Date(step.startedAtMs).toISOString(),
    endedAtIso: new Date(step.endedAtMs).toISOString(),
    app: step.appName ?? step.appBundleId,
    target: step.target ?? null,
    text:
      step.text !== null && step.text !== undefined && step.text.length > CONSTANTS.summarizeStepTextChars
        ? step.text.slice(0, CONSTANTS.summarizeStepTextChars)
        : (step.text ?? null),
  }));
  return JSON.stringify({ segmentId, segmentStartedAtIso: new Date(startedAtMs).toISOString(), steps: body });
}

/**
 * Spec §3.14 hard invariants, checked BEFORE acceptance and fed into the one
 * repair attempt on violation: 1..6 episodes; each range within [0, n-1];
 * first ≤ last; ranges ascend contiguously from 0 and cover every step.
 */
export function validateSplit(split: EpisodeSplit, stepCount: number): string[] {
  const errors: string[] = [];
  const count = split.episodes.length;
  if (count < 1 || count > 6) {
    errors.push(`episode count ${count} outside 1..6`);
    return errors;
  }
  let expectedNext = 0;
  for (const [i, episode] of split.episodes.entries()) {
    const label = `episodes[${i}]`;
    if (episode.firstStepOrdinal < 0 || episode.firstStepOrdinal >= stepCount) {
      errors.push(`${label}.firstStepOrdinal ${episode.firstStepOrdinal} out of range [0, ${stepCount - 1}]`);
    }
    if (episode.lastStepOrdinal < 0 || episode.lastStepOrdinal >= stepCount) {
      errors.push(`${label}.lastStepOrdinal ${episode.lastStepOrdinal} out of range [0, ${stepCount - 1}]`);
    }
    if (episode.firstStepOrdinal > episode.lastStepOrdinal) {
      errors.push(`${label} range inverted (${episode.firstStepOrdinal} > ${episode.lastStepOrdinal})`);
    }
    if (episode.firstStepOrdinal !== expectedNext) {
      errors.push(
        `${label} breaks contiguity: expected firstStepOrdinal ${expectedNext}, got ${episode.firstStepOrdinal}`,
      );
    }
    expectedNext = episode.lastStepOrdinal + 1;
  }
  if (expectedNext !== stepCount) {
    errors.push(`ranges cover [0, ${expectedNext - 1}] but segment has ${stepCount} steps`);
  }
  return errors;
}

/** Whole-segment single episode (spec §3.14 second-failure fallback). */
function fallbackSplit(steps: SemanticStepDto[]): EpisodeSplit {
  const apps = new Map<string, number>();
  for (const step of steps) {
    const name = step.appName ?? step.appBundleId;
    apps.set(name, (apps.get(name) ?? 0) + 1);
  }
  let dominantApp = 'unknown';
  let dominantCount = -1;
  for (const [name, n] of apps) {
    if (n > dominantCount) {
      dominantApp = name;
      dominantCount = n;
    }
  }
  const format = (ms: number) => {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  };
  const firstStep = steps.at(0);
  const lastStep = steps.at(-1);
  const range =
    firstStep !== undefined && lastStep !== undefined
      ? `${format(firstStep.startedAtMs)}–${format(lastStep.endedAtMs)}`
      : 'unknown';
  const title = `${dominantApp} · ${range}`.slice(0, 120);
  return {
    episodes: [
      {
        firstStepOrdinal: 0,
        lastStepOrdinal: steps.length - 1,
        title,
        summary: `Unsplit activity across ${steps.length} steps after failed summarization.`,
        intent: 'unknown',
        outcome: 'unknown',
        entities: [],
      },
    ],
  };
}

/**
 * Exported for the SEC-004 test: the defensive no-steps Error must not embed
 * LLM-derived content (it reaches jobs.last_error + logs via job-worker).
 */
export function toNewEpisode(
  episode: EpisodeSplit['episodes'][number],
  steps: SemanticStepDto[],
  summaryModel: string,
): NewEpisode {
  const covered = steps.slice(episode.firstStepOrdinal, episode.lastStepOrdinal + 1);
  const appSet = new Set<string>();
  for (const step of covered) {
    appSet.add(step.appName ?? step.appBundleId);
  }
  const firstCovered = covered.at(0);
  const lastCovered = covered.at(-1);
  if (firstCovered === undefined || lastCovered === undefined) {
    // Ordinals only — never episode.title or any other LLM-derived content
    // (SEC-004: Error messages persist to jobs.last_error and logs).
    throw new Error(
      `toNewEpisode: episode #${episode.firstStepOrdinal}-${episode.lastStepOrdinal} covers no steps ` +
        `of ${steps.length}`,
    );
  }
  return {
    startedAtMs: firstCovered.startedAtMs,
    endedAtMs: lastCovered.endedAtMs,
    // Issue W2: LLM text may carry lone surrogates that pass JSON parsing on
    // Node but make Swift's JSONDecoder reject the whole downstream frame.
    title: replaceWellFormedTarget(episode.title),
    summary: replaceWellFormedTarget(episode.summary),
    intent: episode.intent,
    outcome: episode.outcome,
    apps: [...appSet],
    entities: episode.entities.map(replaceWellFormedTarget),
    summaryModel,
    summaryPromptVersion: SUMMARY_PROMPT_VERSION,
    // Purge-proof dedupe latch signal (migrations 012/013): stamped so
    // hasEpisodesForSteps survives episode_step_links retention purges and
    // keys on monotonic append-order ordinals instead of clock-skew-prone
    // timestamps. For the window's final episode this equals the window max
    // ordinal — the value the latch's probe compares against.
    segmentId: firstCovered.segmentId,
    lastStepOrdinal: lastCovered.ordinal,
    steps: covered.map((step) => ({ id: step.id })),
  };
}
