import { Type, type Static } from '@sinclair/typebox';

import type { MemoryKind } from '@computer-history/protocol';

import { CONSTANTS } from '../config.js';
import type { Db } from '../db/database.js';
import type { EpisodesRepository } from '../db/episodes-repository.js';
import type { MemoriesRepository } from '../db/memories-repository.js';
import type { Logger } from '../logging.js';
import {
  StructuredPromptRunner,
  StructuredValidationError,
  type StructuredTransport,
} from '../llm/structured-prompt-runner.js';
import { replaceWellFormedTarget } from '../util/text.js';
import { runConsolidation } from './memory-consolidator.js';

/**
 * extract_memory handler (spec §3.16): finalized episode → LLM candidates →
 * deterministic post-validation → transactional evidence accumulation →
 * consolidation pass over every touched canonical_key. Idempotent: an episode
 * that already contributed evidence is skipped entirely, and the unique
 * (memory, episode) pair guards against duplicates anyway.
 */

/** Bumped whenever the extractor prompt materially changes. */
export const MEMORY_PROMPT_VERSION = 'v1';

export const MAX_CANDIDATES = 10;
export const MAX_CANONICAL_KEY_LENGTH = 80;
export const MAX_CLAIM_LENGTH = 300;

const SYSTEM_PROMPT =
  'You extract durable long-term memories from computer-activity episodes. ' +
  'Return 0..10 candidates: stable facts, preferences or procedures about the USER ' +
  '(never episodic narration). Each candidate needs a snake_case canonicalKey naming the ' +
  'logical claim (≤ 80 chars), a single-sentence claim text (≤ 300 chars), a confidence ' +
  'in [0,1] and a short evidenceDescription quoting what was observed. Return JSON only.';

/**
 * Lenient LLM-facing schema: shape only. Hard field constraints are enforced
 * by deterministic post-validation below so ONE malformed candidate never
 * burns the whole response on the single repair attempt.
 */
const CandidateLlmSchema = Type.Object(
  {
    kind: Type.String(),
    canonicalKey: Type.String(),
    text: Type.String(),
    confidence: Type.Number(),
    evidenceDescription: Type.String(),
  },
  { additionalProperties: false },
);

export const MemoryCandidatesSchema = Type.Object(
  { candidates: Type.Array(CandidateLlmSchema) },
  { additionalProperties: false },
);
export type MemoryCandidatesLlm = Static<typeof MemoryCandidatesSchema>;

/** Post-validated candidate ready for persistence. */
export interface ValidatedMemoryCandidate {
  kind: MemoryKind;
  canonicalKey: string;
  text: string;
  confidence: number;
  evidenceDescription: string;
}

export interface ExtractionCounts {
  /** Raw candidate count as produced by the LLM. */
  received: number;
  /** Dropped as extra beyond the 0..10 budget (first MAX_CANDIDATES win). */
  clampedOverBudget: number;
  /** Dropped for failing a field constraint (kind/key/text/evidenceDescription). */
  droppedInvalid: number;
  /** Confidence values pulled into [0,1] instead of dropping the candidate. */
  clampedConfidence: number;
}

export interface ValidationResult {
  candidates: ValidatedMemoryCandidate[];
  counts: ExtractionCounts;
  /** canonical_keys that received new evidence or rows this pass. */
  touchedKeys: string[];
}

const MEMORY_KINDS: readonly string[] = ['fact', 'preference', 'procedure'];

/**
 * V1 canonical-key normalization: lowercase, non-alphanumeric runs collapse
 * to '_', trimmed of edge underscores, capped at 80 chars (a trailing slice
 * underscore is re-trimmed). Empty result ⇒ the candidate is dropped.
 */
export function normalizeCanonicalKey(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '');
  return collapsed.slice(0, MAX_CANONICAL_KEY_LENGTH).replace(/_+$/, '');
}

/**
 * Deterministic post-validation (spec §3.16): clamp what is clampable,
 * drop what is not, count everything for the job log line. Order-stable —
 * the first MAX_CANDIDATES valid entries win.
 */
export function validateMemoryCandidates(raw: MemoryCandidatesLlm): ValidationResult {
  const counts: ExtractionCounts = {
    received: raw.candidates.length,
    clampedOverBudget: Math.max(0, raw.candidates.length - MAX_CANDIDATES),
    droppedInvalid: 0,
    clampedConfidence: 0,
  };
  const candidates: ValidatedMemoryCandidate[] = [];
  const touchedKeys = new Set<string>();
  for (const entry of raw.candidates.slice(0, MAX_CANDIDATES)) {
    if (!MEMORY_KINDS.includes(entry.kind)) {
      counts.droppedInvalid += 1;
      continue;
    }
    // Issue W2: sanitize LLM text before persistence — lone surrogates pass
    // Node-side JSON parsing but make Swift's JSONDecoder drop whole frames.
    const text = replaceWellFormedTarget(entry.text.replace(/\s+/g, ' ').trim());
    if (text.length === 0 || text.length > MAX_CLAIM_LENGTH) {
      counts.droppedInvalid += 1;
      continue;
    }
    const canonicalKey = normalizeCanonicalKey(entry.canonicalKey);
    if (canonicalKey.length === 0) {
      counts.droppedInvalid += 1;
      continue;
    }
    let confidence = entry.confidence;
    if (!Number.isFinite(confidence)) confidence = 0;
    if (confidence < 0 || confidence > 1) {
      confidence = Math.min(1, Math.max(0, confidence));
      counts.clampedConfidence += 1;
    }
    const evidenceDescription = replaceWellFormedTarget(
      entry.evidenceDescription.replace(/\s+/g, ' ').trim(),
    );
    if (evidenceDescription.length === 0) {
      counts.droppedInvalid += 1;
      continue;
    }
    candidates.push({
      kind: entry.kind as MemoryKind,
      canonicalKey,
      text,
      confidence,
      evidenceDescription,
    });
    touchedKeys.add(canonicalKey);
  }
  return { candidates, counts, touchedKeys: [...touchedKeys] };
}

export interface MemoryExtractorOptions {
  episodes: EpisodesRepository;
  memories: MemoriesRepository;
  logger: Logger;
  /**
   * Raw database handle. When wired, the whole candidate apply (upsert loop +
   * consolidation) runs in ONE transaction (SVC-02): a crash or throw mid-loop
   * rolls back everything, so the hasEvidenceForEpisode latch can never fire
   * on a partial evidence set.
   */
  db?: Db;
  /**
   * Lazy transport factory: Pi credentials may be absent at daemon startup;
   * failures flow into the normal retry schedule (spec §3.24).
   */
  transportFactory: () => Promise<StructuredTransport>;
  /** Injectable clock. */
  now?: () => number;
  /** Per-attempt prompt timeout; pinned default 120_000 ms. */
  timeoutMs?: number;
  /** Fired after any mutation (evidence added or status changed). */
  onMemoriesChanged?: () => void;
}

/** Everything one extraction pass persists, applied atomically when db is wired. */
interface ApplyInput {
  episodeId: string;
  observedAtMs: number;
  now: number;
  candidates: ValidatedMemoryCandidate[];
  touchedKeys: string[];
}

interface ApplyOutcome {
  mutated: boolean;
  changedKeys: string[];
}

interface EpisodeInputStep {
  action: string;
  appName?: string | null;
  target?: string | null;
  text?: string | null;
}

const MAX_INPUT_STEPS = 40;
const MAX_STEP_TEXT_CHARS = 200;

export class MemoryExtractor {
  private readonly episodes: EpisodesRepository;
  private readonly memories: MemoriesRepository;
  private readonly logger: Logger;
  private readonly transportFactory: () => Promise<StructuredTransport>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly onMemoriesChanged?: () => void;
  /**
   * ONE transaction for the whole apply (SVC-02), mirroring the summarizer's
   * persistTx: a crash or throw mid-loop rolls back the upserts AND the
   * consolidation writes together, so re-delivery replays the full extraction
   * instead of hitting the evidence latch with a partial set. Undefined when
   * no db handle is wired (legacy per-statement behavior).
   */
  private readonly applyTx?: (apply: ApplyInput) => ApplyOutcome;

  constructor(options: MemoryExtractorOptions) {
    this.episodes = options.episodes;
    this.memories = options.memories;
    this.logger = options.logger;
    this.transportFactory = options.transportFactory;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONSTANTS.promptTimeoutMs;
    this.onMemoriesChanged = options.onMemoriesChanged;
    this.applyTx = options.db?.transaction((apply: ApplyInput): ApplyOutcome =>
      persistApply(this.memories, apply),
    );
  }

  async handle(job: { id: string; payload_json: string }): Promise<void> {
    let payload: { episodeId?: string };
    try {
      payload = JSON.parse(job.payload_json) as { episodeId?: string };
    } catch {
      // Corrupt/truncated payload: retrying cannot fix it.
      this.logger.log('error', 'memory-extractor', 'extract_memory payload unparseable', {
        jobId: job.id,
      });
      return; // unfixable payload: complete without side effects
    }
    if (typeof payload.episodeId !== 'string') {
      this.logger.log('error', 'memory-extractor', 'extract_memory payload missing episodeId', {
        jobId: job.id,
      });
      return; // unfixable payload: complete without side effects
    }
    if (this.memories.hasEvidenceForEpisode(payload.episodeId)) {
      // Re-delivery after a crash between persist and job-complete: this
      // episode already contributed its evidence — extracting again would
      // double-count observations (spec §3.16 idempotent re-run). Safe against
      // partial applies because the whole apply commits in ONE transaction.
      this.logger.log('info', 'memory-extractor', 'episode already extracted; skipping re-delivery', {
        jobId: job.id,
        episodeId: payload.episodeId,
      });
      return;
    }
    const found = this.episodes.getEpisode(payload.episodeId);
    if (found === null || found.steps.length === 0) {
      this.logger.log('info', 'memory-extractor', 'episode missing or empty; skipping', {
        jobId: job.id,
        episodeId: payload.episodeId,
      });
      return;
    }

    const runner = new StructuredPromptRunner({
      transport: await this.transportFactory(),
      timeoutMs: this.timeoutMs,
    });
    let llmResult: MemoryCandidatesLlm;
    try {
      llmResult = await runner.run({
        schema: MemoryCandidatesSchema,
        systemPrompt: SYSTEM_PROMPT,
        input: buildEpisodeInput(found.episode.title, found.episode.summary, found.steps),
      });
    } catch (err) {
      if (!(err instanceof StructuredValidationError)) throw err; // outage → retry schedule
      // No invented fallback for memories: an unusable response retries on the
      // pinned schedule rather than persisting garbage (spec §3.16 honesty).
      this.logger.log('warn', 'memory-extractor', 'candidate response invalid after repair', {
        jobId: job.id,
        episodeId: payload.episodeId,
      });
      throw err;
    }

    const { candidates, counts, touchedKeys } = validateMemoryCandidates(llmResult);
    const observedAtMs = found.episode.startedAtMs;
    const now = this.now();
    const apply: ApplyInput = {
      episodeId: payload.episodeId,
      observedAtMs,
      now,
      candidates,
      touchedKeys,
    };
    const { mutated, changedKeys } =
      this.applyTx !== undefined ? this.applyTx(apply) : persistApply(this.memories, apply);
    if (mutated || changedKeys.length > 0) {
      this.onMemoriesChanged?.();
    }
    this.logger.log('info', 'memory-extractor', 'extraction complete', {
      jobId: job.id,
      episodeId: payload.episodeId,
      promptVersion: MEMORY_PROMPT_VERSION,
      ...counts,
      consolidatedKeys: changedKeys.length,
    });
  }
}

/**
 * Plain (non-transactional) apply used directly when no db handle is wired;
 * inside applyTx it runs as the single transaction body. Each upsert is
 * itself transactional; only the db-wired path makes the WHOLE pass atomic.
 */
function persistApply(memories: MemoriesRepository, apply: ApplyInput): ApplyOutcome {
  let mutated = false;
  for (const candidate of apply.candidates) {
    const outcome = memories.upsertCandidate(
      candidate,
      {
        episodeId: apply.episodeId,
        confidence: candidate.confidence,
        observedAtMs: apply.observedAtMs,
        evidenceDescription: candidate.evidenceDescription,
      },
      apply.now,
    );
    if (outcome.evidenceAdded) mutated = true;
  }
  return { mutated, changedKeys: runConsolidation(memories, apply.touchedKeys, apply.now) };
}

function buildEpisodeInput(
  title: string,
  summary: string,
  steps: EpisodeInputStep[],
): string {
  const lines = [
    `Title: ${title}`,
    `Summary: ${summary}`,
    'Steps:',
  ];
  for (const step of steps.slice(0, MAX_INPUT_STEPS)) {
    const text = (step.text ?? '').slice(0, MAX_STEP_TEXT_CHARS);
    lines.push(
      `- ${step.action} · ${step.appName ?? 'unknown app'} · ${step.target ?? 'no target'}${text === '' ? '' : ` · ${text}`}`,
    );
  }
  return lines.join('\n');
}
