import { Type, type Static } from '@sinclair/typebox';

import type { Logger } from '../logging.js';
import type { EpisodesRepository } from '../db/episodes-repository.js';
import type { WorkflowsRepository } from '../db/workflows-repository.js';
import { replaceWellFormedTarget } from '../util/text.js';
import { CONSTANTS } from '../config.js';
import {
  StructuredPromptRunner,
  StructuredValidationError,
  type StructuredTransport,
} from '../llm/structured-prompt-runner.js';
import {
  APP_JACCARD_POOL_MIN,
  CANDIDATE_MEDIAN_MIN,
  MAX_STEPS,
  MIN_STEPS,
  OCCURRENCE_SIMILARITY_MIN,
  buildEpisodeFingerprint,
  episodeAppSet,
  episodeSimilarity,
  median,
  type EpisodeFingerprint,
} from './workflow-fingerprint.js';

/**
 * mine_workflows handler (spec §3.20, brief-m6 §D6 item 3). Enqueued by the
 * summarizer right AFTER extract_memory for each persisted episode.
 *
 * Pipeline: load the 30-day pool → greedy cluster around the seed episode →
 * gate on ≥3 occurrences / ≥2 distinct UTC days / median occurrence
 * similarity ≥0.78 →
 * suppress when an existing workflow already covers ≥50% of the cluster's
 * episode ids (REJECTED rows suppress too — pinned noise control) → synthesize
 * the LLM template → insert row + occurrences + template in ONE transaction.
 * A template failure throws, so the job re-enters the pinned retry schedule
 * and NO workflow row exists without a template.
 */

/** Bumped whenever the miner prompt materially changes. */
export const WORKFLOW_PROMPT_VERSION = 'v1';
/**
 * Mining pool horizon, DERIVED from the semantic_steps retention horizon
 * (CONSTANTS.semanticRetentionDays) so the two cannot drift: steps are purged
 * at that horizon, so a larger window would silently query guaranteed-empty
 * rows and a smaller one would under-mine. Larger retention ⇒ larger window;
 * the pool never reads purged rows by construction.
 */
export const MINING_WINDOW_MS =
  CONSTANTS.semanticRetentionDays * 24 * 60 * 60 * 1000;
export const MIN_OCCURRENCES = 3;
export const MIN_DISTINCT_DAYS = 2;
/**
 * PERF-01: clustering cost grows superlinearly with pool size (every fixpoint
 * pass rescores each unclaimed entry against every current member), so the
 * mining pool is capped at the WORKFLOW_MINING_POOL_MAX most recent episodes
 * of the 30-day window; the seed always stays in its own pool. Pools under
 * the cap cluster exactly as before.
 */
export const WORKFLOW_MINING_POOL_MAX = 200;

/** Existing-workflow overlap fraction that blocks candidate creation. */
export const OVERLAP_SUPPRESSION_RATIO = 0.5;

const UTC_DAY_LENGTH = 10; // 'YYYY-MM-DD'.length

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, UTC_DAY_LENGTH);
}

const SYSTEM_PROMPT =
  'You detect a repeating computer workflow from observed occurrences. ' +
  'You receive several episodes (title, summary, intent and numbered steps) that the ' +
  'miner already established as repeats of the SAME procedure. Name the procedure, state ' +
  'its purpose, list preconditions, the STABLE steps shared by every occurrence, the ' +
  'inputs that vary between runs, and the expected outcome. Return JSON only.';

/**
 * Lenient shape-only LLM schema; deterministic clamps below keep ONE bad
 * string from burning the single repair attempt (same pattern as M5).
 */
const TemplateLlmSchema = Type.Object(
  {
    name: Type.String(),
    purpose: Type.String(),
    preconditions: Type.Array(Type.String()),
    stableSteps: Type.Array(Type.String()),
    variableInputs: Type.Array(Type.String()),
    expectedOutcome: Type.String(),
  },
  { additionalProperties: false },
);
export type WorkflowTemplateLlm = Static<typeof TemplateLlmSchema>;

const MAX_NAME_CHARS = 120;
const MAX_SENTENCE_CHARS = 300;
const MAX_LIST_ITEMS = 20;
/** Issue W2: sanitize LLM strings before persistence — lone surrogates pass
 * Node-side JSON parsing but make Swift's JSONDecoder drop whole frames. */
function clampList(items: readonly string[]): string[] {
  return items
    .map((item) => replaceWellFormedTarget(item.trim()))
    .filter((item) => item !== '')
    .slice(0, MAX_LIST_ITEMS);
}

/** Deterministic post-validation: sanitize, trim, drop empties, cap sizes. */
export function validateTemplate(raw: WorkflowTemplateLlm): {
  name: string;
  purpose: string;
  template: WorkflowTemplateLlm;
} {
  // Clamp BEFORE sanitizing: slicing after sanitization could split a surrogate
  // pair at the boundary and re-create the very lone surrogate we just removed.
  const name = replaceWellFormedTarget(raw.name.trim().slice(0, MAX_NAME_CHARS));
  if (name === '') throw new StructuredValidationError(['empty template name'], [], []);
  const purpose = replaceWellFormedTarget(raw.purpose.trim().slice(0, MAX_SENTENCE_CHARS));
  const template: WorkflowTemplateLlm = {
    name,
    purpose,
    preconditions: clampList(raw.preconditions),
    stableSteps: clampList(raw.stableSteps),
    variableInputs: clampList(raw.variableInputs),
    expectedOutcome: replaceWellFormedTarget(
      raw.expectedOutcome.trim().slice(0, MAX_SENTENCE_CHARS),
    ),
  };
  return { name, purpose, template };
}

export interface WorkflowMinerOptions {
  episodes: EpisodesRepository;
  workflows: WorkflowsRepository;
  logger: Logger;
  /** Lazy transport factory — absent Pi credentials surface as job retries. */
  transportFactory: () => Promise<StructuredTransport>;
  now?: () => number;
  timeoutMs?: number;
  /** Fired after a new candidate commits (daemon wires it to workflows_changed). */
  onWorkflowsChanged?: () => void;
}

interface PoolEntry {
  id: string;
  startedAtMs: number;
  intent: string | null;
  title: string;
  summary: string;
  fingerprint: EpisodeFingerprint;
}

interface ClusterOutcome {
  memberIds: string[];
  /**
   * Qualifying pair similarity per member (spec §3.20: an episode counts as
   * an occurrence iff similarity ≥ 0.74). Each non-seed member records the
   * admission similarity — the score of the FIRST current member that cleared
   * the bar at join time (PERF-01: the member scan short-circuits there) — so
   * every persisted occurrence.similarity clears the 0.74 bar even when
   * membership came transitively through another member.
   */
  occurrenceSimilarity: Map<string, number>;
  /**
   * Gate quantity for the 0.78 candidate bar: median of the occurrence
   * similarities above — the SAME values inserted into workflow_occurrences,
   * so the repository-recomputed median_similarity always matches the gate.
   */
  medianSimilarity: number;
}

/**
 * Greedy clustering (brief-m6 §D6 item 3): seed = target episode; an episode
 * joins when its similarity to ANY current member is ≥ 0.74; fixpoint over
 * the pool in ascending startedAtMs order. Exported for boundary tests.
 */
export function clusterAround(seed: PoolEntry, pool: ReadonlyArray<PoolEntry>): ClusterOutcome {
  const members: PoolEntry[] = [seed]; // seed qualifies trivially (sim 1)
  const occurrenceSimilarity = new Map<string, number>([[seed.id, 1]]);
  // PERF-07: member scores are monotone per candidate — the member set only
  // grows, so a sub-bar score can never rise on a rescan. Each candidate
  // remembers how many members it has already scored and scores only the
  // newly added ones, instead of rescoring every member on every fixpoint
  // pass. Admission order and the recorded first-crossing similarity are
  // unchanged (scores are deterministic; members [0, from) already proved
  // sub-bar for this candidate).
  const scoredUpTo = new Map<string, number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of pool) {
      if (occurrenceSimilarity.has(candidate.id)) continue;
      // PERF-01: stop at the first member clearing the bar — membership only
      // needs ONE qualifying member, and each episodeSimilarity is an
      // O(signatures²) edit distance.
      let best = 0;
      const from = scoredUpTo.get(candidate.id) ?? 0;
      for (let mi = from; mi < members.length; mi += 1) {
        const member = members[mi];
        if (member === undefined) break; // mi < members.length; satisfies no-non-null-assertion
        const sim = episodeSimilarity(candidate.fingerprint, member.fingerprint);
        scoredUpTo.set(candidate.id, mi + 1);
        if (sim >= OCCURRENCE_SIMILARITY_MIN) {
          best = sim;
          break;
        }
      }
      if (best >= OCCURRENCE_SIMILARITY_MIN) {
        members.push(candidate);
        occurrenceSimilarity.set(candidate.id, best);
        grew = true;
      }
    }
  }
  return {
    memberIds: members.map((m) => m.id),
    occurrenceSimilarity,
    medianSimilarity: median([...occurrenceSimilarity.values()]),
  };
}

/**
 * PERF-01 pool cap: keeps at most WORKFLOW_MINING_POOL_MAX rows — the most
 * recent of the window (rows arrive in ascending startedAtMs order). If the
 * seed fell outside that slice it takes the oldest kept slot, so a seed is
 * never dropped by its own mining run and the output stays ascending.
 * Exported for boundary tests.
 */
export function capPool<Row extends { id: string; startedAtMs: number }>(
  rows: ReadonlyArray<Row>,
  seedId: string,
): Array<Row> {
  if (rows.length <= WORKFLOW_MINING_POOL_MAX) return [...rows];
  const recent = [...rows.slice(-WORKFLOW_MINING_POOL_MAX)];
  if (!recent.some((row) => row.id === seedId)) {
    const seed = rows.find((row) => row.id === seedId);
    if (seed !== undefined) recent[0] = seed;
  }
  return recent;
}

export class WorkflowMiner {
  private readonly episodes: EpisodesRepository;
  private readonly workflows: WorkflowsRepository;
  private readonly logger: Logger;
  private readonly transportFactory: () => Promise<StructuredTransport>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly onWorkflowsChanged?: () => void;

  constructor(options: WorkflowMinerOptions) {
    this.episodes = options.episodes;
    this.workflows = options.workflows;
    this.logger = options.logger;
    this.transportFactory = options.transportFactory;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONSTANTS.promptTimeoutMs;
    this.onWorkflowsChanged = options.onWorkflowsChanged;
  }

  async handle(job: { id: string; payload_json: string }): Promise<void> {
    let payload: { episodeId?: string };
    try {
      payload = JSON.parse(job.payload_json) as { episodeId?: string };
    } catch {
      // Corrupt/truncated payload: retrying cannot fix it.
      this.logger.log('error', 'workflow-miner', 'mine_workflows payload unparseable', {
        jobId: job.id,
      });
      return; // unfixable payload: complete without side effects
    }
    if (typeof payload.episodeId !== 'string') {
      this.logger.log('error', 'workflow-miner', 'mine_workflows payload missing episodeId', {
        jobId: job.id,
      });
      return; // unfixable payload: complete without side effects
    }
    const episodeId = payload.episodeId;
    if (this.workflows.hasOccurrenceForEpisode(episodeId)) {
      // Re-delivery after a crash between commit and job-complete (spec §3.16
      // idempotency pattern): the episode already belongs to some workflow.
      this.logger.log('info', 'workflow-miner', 'episode already mined; skipping re-delivery', {
        jobId: job.id,
        episodeId,
      });
      return;
    }

    const windowEnd = this.now();
    const pool = this.loadPool(episodeId, windowEnd - MINING_WINDOW_MS, windowEnd);
    const seed = pool.find((entry) => entry.id === episodeId);
    if (seed === undefined) {
      this.logger.log('info', 'workflow-miner', 'seed episode missing or unminable; skipping', {
        jobId: job.id,
        episodeId,
      });
      return;
    }

    const candidates = pool.filter((entry) => entry.id !== seed.id);
    const cluster = clusterAround(seed, candidates);
    // PERF-01: one Set for every membership probe below (Array.includes is O(n)).
    const memberIds = new Set(cluster.memberIds);

    if (
      cluster.memberIds.length < MIN_OCCURRENCES ||
      cluster.medianSimilarity < CANDIDATE_MEDIAN_MIN
    ) {
      this.logSkip(job.id, episodeId, cluster, 'cluster gates unmet');
      return;
    }
    const days = new Set(pool.filter((e) => memberIds.has(e.id)).map((e) => utcDay(e.startedAtMs)));
    if (days.size < MIN_DISTINCT_DAYS) {
      this.logSkip(job.id, episodeId, cluster, `only ${days.size} distinct day(s)`);
      return;
    }
    if (this.suppressedByExisting(cluster)) return;

    const runner = new StructuredPromptRunner({
      transport: await this.transportFactory(),
      timeoutMs: this.timeoutMs,
    });
    // The LLM call happens AFTER every free gate: a template failure retries
    // the job without ever persisting a template-less row (brief-m6 item 3).
    const occurrences = pool
      .filter((e) => memberIds.has(e.id))
      .map((e) => ({
        id: e.id,
        title: e.title,
        summary: e.summary,
        intent: e.intent,
        steps: e.fingerprint.signatures,
        startedAtMs: e.startedAtMs,
      }));
    let llmResult: WorkflowTemplateLlm;
    try {
      llmResult = await runner.run({
        schema: TemplateLlmSchema,
        systemPrompt: SYSTEM_PROMPT,
        input: buildOccurrencesInput(occurrences),
      });
    } catch (err) {
      if (!(err instanceof StructuredValidationError)) throw err; // outage → retry schedule
      this.logger.log('warn', 'workflow-miner', 'template response invalid after repair', {
        jobId: job.id,
        episodeId,
      });
      throw err; // unusable template ⇒ retry schedule; no row without template
    }
    const { name, purpose, template } = validateTemplate(llmResult);

    const memberEpisodes = occurrences.map((o) => ({ id: o.id, startedAtMs: o.startedAtMs }));
    const firstSeenAtMs = Math.min(...memberEpisodes.map((m) => m.startedAtMs));
    const lastSeenAtMs = Math.max(...memberEpisodes.map((m) => m.startedAtMs));
    this.workflows.insertWorkflow(
      {
        name,
        purpose: purpose === '' ? null : purpose,
        template,
        occurrences: [...cluster.occurrenceSimilarity.entries()].map(([ep, similarity]) => ({
          episodeId: ep,
          similarity,
        })),
        firstSeenAtMs,
        lastSeenAtMs,
      },
      this.now(),
    );
    this.logger.log('info', 'workflow-miner', 'workflow candidate created', {
      jobId: job.id,
      seedEpisodeId: episodeId,
      promptVersion: WORKFLOW_PROMPT_VERSION,
      occurrences: cluster.memberIds.length,
      medianSimilarity: cluster.medianSimilarity,
    });
    this.onWorkflowsChanged?.();
  }
  /**
   * Overlap suppression (contracts/brief-m6): an existing workflow sharing
   * ≥50% of the cluster's episode ids blocks creation; REJECTED rows always
   * do (pinned noise control), while exactly ONE live row absorbs the NEW
   * episodes via recordOccurrence instead of spawning a duplicate candidate.
   * Among eligible live rows the single absorber is the highest-overlap one;
   * ties break by freshest last_seen_at_ms, then by workflow id, so the
   * many-to-many duplication of episodes across workflows is impossible.
   */
  private suppressedByExisting(cluster: ClusterOutcome): boolean {
    const clusterIds = new Set(cluster.memberIds);
    // PERF-05: the ledger comes back restricted to cluster ids — every set
    // entry is an overlap, and `episodeIds.has(id)` below still answers
    // "occurrence row exists for (workflow, id)" exactly as before.
    const { ledger, status: byStatus, lastSeen } = this.workflows.suppressionInputs(
      cluster.memberIds,
    );
    let suppressed = false;
    let absorberId: string | undefined;
    let absorberEpisodeIds: Set<string> | undefined;
    for (const [workflowId, episodeIds] of ledger) {
      if (episodeIds.size / clusterIds.size < OVERLAP_SUPPRESSION_RATIO) continue;
      if (byStatus.get(workflowId) === 'rejected') {
        // Rejected rows are unconditional suppressors — never absorb into them.
        suppressed = true;
        continue;
      }
      // Narrowed copies keep the tie-break free of non-null assertions:
      // absorberEpisodeIds !== undefined implies absorberId is set (they are
      // only assigned together below).
      const absorberLastSeen = absorberId === undefined ? undefined : lastSeen.get(absorberId);
      const workflowLastSeen = lastSeen.get(workflowId) ?? 0;
      if (
        absorberEpisodeIds === undefined ||
        absorberId === undefined ||
        absorberLastSeen === undefined ||
        episodeIds.size > absorberEpisodeIds.size ||
        (episodeIds.size === absorberEpisodeIds.size &&
          (workflowLastSeen > absorberLastSeen ||
            (workflowLastSeen === absorberLastSeen && workflowId < absorberId)))
      ) {
        absorberId = workflowId;
        absorberEpisodeIds = episodeIds;
      }
    }
    if (absorberId !== undefined && absorberEpisodeIds !== undefined) {
      // Round-32 audit: one batched transaction for the whole absorb — a
      // per-row transaction loop let a mid-absorb crash commit one episode,
      // latch hasOccurrenceForEpisode on re-delivery, and permanently drop
      // the rest of this workflow's ledger updates.
      const absorbed: Array<{ episodeId: string; similarity: number }> = [];
      for (const id of clusterIds) {
        if (absorberEpisodeIds.has(id)) continue;
        const similarity = cluster.occurrenceSimilarity.get(id);
        if (similarity !== undefined) absorbed.push({ episodeId: id, similarity });
      }
      this.workflows.recordOccurrences(absorberId, absorbed, this.now());
      suppressed = true;
    }
    return suppressed;
  }

  /**
   * 30-day pool with pinned filters applied (spec §3.20): stepCount within
   * 3..40 for EVERY member including the seed, and app-set Jaccard ≥ 0.50
   * against the seed for everyone else. The pool is capped at the most recent
   * WORKFLOW_MINING_POOL_MAX episodes (PERF-01): the cap is pushed into SQL
   * (PERF-07 — the repository pages only the newest N, re-fetching the seed
   * via includeIds) and {@link capPool} remains the owner of the seed-slot
   * replacement rule on the ≤N+1 rows that reach JS.
   */
  private loadPool(seedId: string, fromMs: number, toMs: number): PoolEntry[] {
    const rows = capPool(
      this.episodes.listEpisodesWithStepsInRange(fromMs, toMs, {
        limit: WORKFLOW_MINING_POOL_MAX,
        includeIds: [seedId],
      }),
      seedId,
    );
    const seedRow = rows.find((row) => row.id === seedId);
    if (
      seedRow === undefined ||
      seedRow.steps.length < MIN_STEPS ||
      seedRow.steps.length > MAX_STEPS
    ) {
      return [];
    }
    const seedFingerprint = buildEpisodeFingerprint(seedRow.steps, seedRow.intent);
    const entries: PoolEntry[] = [];
    for (const row of rows) {
      if (row.steps.length < MIN_STEPS || row.steps.length > MAX_STEPS) continue;
      // PERF: the pool bar needs only the app set. Building full per-step
      // signatures (regex normalization per step) for episodes the bar then
      // rejects wasted most of the pool's fingerprint work; signatures are
      // built only for members that pass the bar.
      const apps = episodeAppSet(row.steps);
      const isSeed = row.id === seedId;
      if (!isSeed && !meetsPoolBar(apps, seedFingerprint.apps)) continue;
      entries.push({
        id: row.id,
        startedAtMs: row.startedAtMs,
        intent: row.intent,
        title: row.title,
        summary: row.summary,
        fingerprint: isSeed ? seedFingerprint : buildEpisodeFingerprint(row.steps, row.intent),
      });
    }
    return entries;
  }

  private logSkip(jobId: string, episodeId: string, cluster: ClusterOutcome, reason: string): void {
    this.logger.log('info', 'workflow-miner', 'no workflow created', {
      jobId,
      episodeId,
      clusterSize: cluster.memberIds.length,
      medianSimilarity: cluster.medianSimilarity,
      reason,
    });
  }
}

function meetsPoolBar(candidateApps: ReadonlySet<string>, seedApps: ReadonlySet<string>): boolean {
  let intersection = 0;
  for (const app of candidateApps) if (seedApps.has(app)) intersection += 1;
  const union = candidateApps.size + seedApps.size - intersection;
  return union === 0 || intersection / union >= APP_JACCARD_POOL_MIN;
}

interface OccurrenceInput {
  id: string;
  title: string;
  summary: string;
  intent: string | null;
  steps: readonly string[];
  startedAtMs: number;
}

const MAX_INPUT_OCCURRENCES = 10;
const MAX_INPUT_STEP_LINES = 40;

function buildOccurrencesInput(occurrences: ReadonlyArray<OccurrenceInput>): string {
  const lines: string[] = [`Occurrences: ${occurrences.length}`];
  for (const occ of occurrences.slice(0, MAX_INPUT_OCCURRENCES)) {
    lines.push(`## ${occ.title} (${new Date(occ.startedAtMs).toISOString()})`);
    lines.push(`Summary: ${occ.summary}`);
    lines.push(`Intent: ${occ.intent ?? 'unknown'}`);
    for (const [index, signature] of occ.steps.slice(0, MAX_INPUT_STEP_LINES).entries()) {
      lines.push(`${index + 1}. ${signature}`);
    }
  }
  return lines.join('\n');
}
