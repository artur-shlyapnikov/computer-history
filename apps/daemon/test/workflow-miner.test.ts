import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { WorkflowsRepository } from '../src/db/workflows-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { FakeTransport } from '../src/llm/fake-transport.js';
import {
  OCCURRENCE_SIMILARITY_MIN,
  buildEpisodeFingerprint,
  episodeSimilarity,
} from '../src/processing/workflow-fingerprint.js';
import {
  MINING_WINDOW_MS,
  WORKFLOW_MINING_POOL_MAX,
  WorkflowMiner,
  capPool,
  clusterAround,
} from '../src/processing/workflow-miner.js';
import type { CoalescedStep, StepAction } from '../src/processing/event-coalescer.js';
import type { Logger } from '../src/logging.js';

/**
 * Acceptance dataset END-TO-END (brief-m6 §D6 item 5): three synthetic days of
 * Slack(find problem) → Jira(create issue) → Slack(follow-up) with realistic
 * steps. After the third mine run exactly ONE candidate exists with
 * occurrence_count = 3 and median ≥ 0.78; a GitHub-PR variant episode enters
 * the pool (app-Jaccard 2/3 ≥ 0.50) but stays below the 0.74 membership bar.
 */

// Three distinct UTC days (10:00 UTC each).
const DAY = Date.UTC(2026, 0, 20, 10, 0, 0);
const DAY_MS = 86_400_000;

const ROUTINE: Array<{ app: string; appName: string; action: StepAction; target: string | null }> = [
  { app: 'com.slack.Slack', appName: 'Slack', action: 'focus', target: 'Slack' },
  { app: 'com.slack.Slack', appName: 'Slack', action: 'click', target: 'Create' },
  { app: 'com.slack.Slack', appName: 'Slack', action: 'edit_text', target: 'message box' },
  { app: 'com.google.Chrome', appName: 'Chrome', action: 'focus', target: 'docs' },
  { app: 'com.jira.Jira', appName: 'Jira', action: 'click', target: 'New Issue' },
  { app: 'com.jira.Jira', appName: 'Jira', action: 'edit_text', target: 'Fix TANGO-123' },
  { app: 'com.jira.Jira', appName: 'Jira', action: 'click', target: 'Submit' },
  { app: 'com.slack.Slack', appName: 'Slack', action: 'focus', target: 'thread' },
  { app: 'com.slack.Slack', appName: 'Slack', action: 'scroll', target: null },
];

const VARIANT_MIDDLE: typeof ROUTINE = [
  { app: 'com.github.GitHub', appName: 'GitHub', action: 'click', target: 'New pull request' },
  { app: 'com.github.GitHub', appName: 'GitHub', action: 'edit_text', target: 'Describe changes' },
  { app: 'com.github.GitHub', appName: 'GitHub', action: 'click', target: 'Merge' },
];

const TEMPLATE_JSON = JSON.stringify({
  name: 'Bug triage routine',
  purpose: 'Investigate reported problems and file tracked issues.',
  preconditions: ['A problem report exists'],
  stableSteps: ['Find the discussion in Slack', 'Create a ticket', 'Follow up in Slack'],
  variableInputs: ['problem description', 'ticket id'],
  expectedOutcome: 'Ticket filed and follow-up posted',
});

describe('WorkflowMiner (scripted transports)', () => {
  let db: Db;
  let home: string;
  let episodes: EpisodesRepository;
  let workflows: WorkflowsRepository;
  let segments: SegmentsRepository;
  const logLines: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    log: vi.fn((level: string, scope: string, message: string, fields?: Record<string, unknown>) => {
      logLines.push({ level, scope, message, ...fields });
    }),
    pruneOld: () => 0,
  };
  let changedEvents = 0;
  let nextEv = 0;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-miner-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    episodes = new EpisodesRepository(db);
    workflows = new WorkflowsRepository(db);
    segments = new SegmentsRepository(db);
    changedEvents = 0;
    logLines.length = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function ev(): string {
    nextEv += 1;
    return `ev-${nextEv}`;
  }

  /** Seeds one full routine episode at the given day offset. */
  function seedEpisode(
    title: string,
    startMs: number,
    middle: Array<{ app: string; appName: string; action: StepAction; target: string | null }>,
    _unused?: number,
    _also?: unknown[],
    stepsOverride?: Array<{ app: string; appName: string; action: StepAction; target: string | null }>,
  ): string {
    void _unused;
    void _also;
    const specs =
      stepsOverride ??
      [...ROUTINE.slice(0, 4), ...middle, ...ROUTINE.slice(7)];
    const segment = segments.createOpen(startMs, ev(), startMs);
    let t = startMs;
    for (const spec of specs) {
      const step: CoalescedStep = {
        action: spec.action,
        appBundleId: spec.app,
        appName: spec.appName,
        target: spec.target,
        text: spec.action === 'edit_text' ? `${spec.target} text ${ev()}` : null,
        startedAtMs: t,
        endedAtMs: t + 30_000,
        firstEventId: ev(),
        lastEventId: ev(),
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
    const apps = [...new Set(specs.map((s) => s.appName))];
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: startMs,
          endedAtMs: t,
          title,
          summary: `${title} summary`,
          intent: 'triage bug report',
          outcome: 'done',
          apps,
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

  function routineDay(index: number): string {
    return seedEpisode(`routine day ${index}`, DAY + index * DAY_MS, []);
  }

  function buildMiner(transport: FakeTransport, windowEndMs: number = DAY + 3 * DAY_MS): WorkflowMiner {
    return new WorkflowMiner({
      episodes,
      workflows,
      logger,
      transportFactory: async () => transport,
      now: () => windowEndMs,
      onWorkflowsChanged: () => {
        changedEvents += 1;
      },
    });
  }

  async function mine(miner: WorkflowMiner, episodeId: string): Promise<void> {
    await miner.handle({ id: `job-${episodeId}`, payload_json: JSON.stringify({ episodeId }) });
  }

  it('acceptance dataset: one candidate after the third run, count=3, median≥0.78', async () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const d3 = routineDay(2);

    // Each run mirrors production timing: the miner's 30-day window ends
    // shortly after that day's episode finalized, so run N only sees days ≤ N.
    const transport = new FakeTransport([TEMPLATE_JSON]);
    const run = (episodeId: string, dayIndex: number): Promise<void> =>
      mine(buildMiner(transport, DAY + dayIndex * DAY_MS + 2 * 3_600_000), episodeId);
    await run(d1, 0);
    expect(workflows.listByStatus()).toHaveLength(0); // 1 occurrence
    await run(d2, 1);
    expect(workflows.listByStatus()).toHaveLength(0); // 2 occurrences
    await run(d3, 2);

    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    const wf = listed[0]!;
    expect(wf.occurrenceCount).toBe(3);
    expect(wf.medianSimilarity).toBeGreaterThanOrEqual(0.78);
    expect(wf.status).toBe('candidate');
    expect(wf.name).toBe('Bug triage routine');
    expect(wf.template).toEqual(JSON.parse(TEMPLATE_JSON));
    for (const occurrence of wf.occurrences) {
      expect(occurrence.similarity).toBeCloseTo(1, 9); // identical routines
    }
    expect(wf.occurrences.map((o) => o.episodeId).sort()).toEqual([d1, d2, d3].sort());
    expect(changedEvents).toBe(1);

    // The GitHub-PR variant enters the pool but stays below 0.74 and is not
    // absorbed into the live candidate row (no suppressedByExisting merge).
    const variant = seedVariant();
    await mine(buildMiner(transport, DAY + 2 * DAY_MS + 4 * 3_600_000), variant);
    expect(workflows.listByStatus()).toHaveLength(1); // no second row
    // listByStatus() rebuilds occurrences per call, so re-read the live row
    // after the mine instead of asserting on the pre-mine snapshot `wf`.
    const after = workflows.listByStatus()[0]!;
    expect(after.occurrenceCount).toBe(3);
    expect(after.occurrences.map((o) => o.episodeId)).not.toContain(variant);
    expect(changedEvents).toBe(1); // no second creation event
  });

  function seedVariant(): string {
    return seedEpisode('variant day', DAY + 2 * DAY_MS + 3_600_000, VARIANT_MIDDLE);
  }

  it('variant similarity computed through the shipped episodeSimilarity stays below 0.74', () => {
    // Contracts §workflow semantics: gate-critical goldens MUST run through the
    // shipped episodeSimilarity function — no constant-vs-constant tautology.
    // Executed dist check (2026-08-23): base vs GitHub-PR variant over the
    // seeded shapes ⇒ 9 signatures with the middle three substituted
    // (seq = 1 − 3/9), apps {slack,chrome,jira} vs {slack,chrome,github}
    // (J = 2/4), identical intents ⇒ 0.6·(2/3) + 0.25·(1/2) + 0.15 = 0.675.
    const toStepInput = (s: (typeof ROUTINE)[number]) => ({
      appBundleId: s.app,
      action: s.action,
      target: s.target,
    });
    const variantSpecs = [...ROUTINE.slice(0, 4), ...VARIANT_MIDDLE, ...ROUTINE.slice(7)];
    const sim = episodeSimilarity(
      buildEpisodeFingerprint(ROUTINE.map(toStepInput), 'triage bug report'),
      buildEpisodeFingerprint(variantSpecs.map(toStepInput), 'triage bug report'),
    );
    expect(sim).toBeCloseTo(0.675, 9);
    expect(sim).toBeLessThan(OCCURRENCE_SIMILARITY_MIN);
  });

  it('two occurrences are insufficient even when identical', async () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const miner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    await mine(miner, d1);
    await mine(miner, d2);
    expect(workflows.listByStatus()).toHaveLength(0);
  });

  it('same-day-only occurrences never form a candidate (≥2 distinct UTC days)', async () => {
    const e1 = seedEpisode('morning', DAY, []);
    const e2 = seedEpisode('noon', DAY + 3_600_000, []);
    const e3 = seedEpisode('evening', DAY + 7_200_000, []);
    const miner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    await mine(miner, e1);
    await mine(miner, e2);
    await mine(miner, e3);
    expect(workflows.listByStatus()).toHaveLength(0);
    // Skip reason is observable in the log stream.
    expect(logLines.some((l) => typeof l.reason === 'string' && l.reason.includes('distinct day'))).toBe(true);
  });

  it('chained cluster forms a candidate when median OCCURRENCE similarity ≥ 0.78', async () => {
    // A == B identical (admissions 1 and 1); C substitutes five of twelve
    // signatures ⇒ sim(C,A)=sim(C,B)=0.75 and it chains in through them.
    // Spec §3.20 gates on the occurrences' own similarities —
    // median(1, 1, 0.75) = 1 ≥ 0.78 — not on the median of all pairwise
    // similarities (0.75), which is what blocked this cluster before the
    // bookkeeping was conformed to the spec.
    const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const altLabels = ['alpha', 'bravo', 'mike', 'november', 'oscar', 'papa', 'quebec', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const twelveStep = (title: string, targets: string[], startMs: number): string =>
      seedTwelve(title, targets, startMs);
    const a = twelveStep('chain-a', labels, DAY);
    const b = twelveStep('chain-b', labels, DAY + DAY_MS);
    const c = twelveStep('chain-c', altLabels, DAY + 2 * DAY_MS);
    const miner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    await mine(miner, a);
    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.occurrenceCount).toBe(3);
    expect(listed[0]!.medianSimilarity).toBeGreaterThanOrEqual(0.78);
    expect(listed[0]!.occurrences.map((o) => o.episodeId).sort()).toEqual([a, b, c].sort());
    // Every persisted occurrence similarity clears the §3.20 bar.
    for (const occurrence of listed[0]!.occurrences) {
      expect(occurrence.similarity).toBeGreaterThanOrEqual(OCCURRENCE_SIMILARITY_MIN);
    }
  });

  it('miner persists validateTemplate output into name/purpose columns (seam pin)', async () => {
    // Poisoned LLM template: the name exceeds the 120-unit cap AND carries a
    // lone surrogate; the purpose carries a lone surrogate. Post-round-8
    // toDto masks poisoned columns at wire level, so only VALUE-level DTO
    // equality pins the validateTemplate seam (workflow-miner.ts:322) — a
    // mutation that skips validateTemplate and inserts llmResult directly
    // fails these exact-equality assertions even though every witness-style
    // `not.toContain('\ud800')` check would still pass.
    const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const a = seedTwelve('poison-a', labels, DAY);
    seedTwelve('poison-b', labels, DAY + DAY_MS);
    seedTwelve('poison-c', labels, DAY + 2 * DAY_MS);
    const poisoned = JSON.stringify({
      name: `${'n'.repeat(118)}\ud83d\ude00 check\ud800`,
      purpose: '\ud800ship',
      preconditions: ['ci \ud800'],
      stableSteps: ['build'],
      variableInputs: [],
      expectedOutcome: 'ok',
    });
    await mine(buildMiner(new FakeTransport([poisoned])), a);

    const dto = workflows.listByStatus()[0]!;
    // Clamp ran first (slice to 120 units keeps the astral pair intact), then
    // sanitize dropped the sliced-away trailing lone surrogate's siblings:
    // the persisted name is exactly MAX_NAME_CHARS units ending on 🚀.
    expect(dto.name).toHaveLength(120);
    expect(dto.name).toBe(`${'n'.repeat(118)}\ud83d\ude00`);
    // Sanitize ran: leading lone surrogate became U+FFFD.
    expect(dto.purpose).toBe('\uFFFDship');
    // The validated scalars also land inside the persisted template object.
    expect(dto.template.name).toBe(`${'n'.repeat(118)}\ud83d\ude00`);
    expect(dto.template.purpose).toBe('\uFFFDship');
    expect(dto.template.preconditions).toEqual(['ci \uFFFD']);
    // clampList passthrough: unpoisoned items survive byte-for-byte.
    expect(dto.template.stableSteps).toEqual(['build']);
  });

  it('miner maps an empty validated purpose to a NULL column', async () => {
    // Pins workflow-miner.ts:330 (purpose === '' ? null): an LLM template
    // with empty purpose must persist SQL NULL, not ''.
    const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const a = seedTwelve('empty-a', labels, DAY);
    seedTwelve('empty-b', labels, DAY + DAY_MS);
    seedTwelve('empty-c', labels, DAY + 2 * DAY_MS);
    const emptyPurpose = JSON.stringify({
      name: 'Empty purpose routine',
      purpose: '',
      preconditions: [],
      stableSteps: ['build'],
      variableInputs: [],
      expectedOutcome: 'ok',
    });
    await mine(buildMiner(new FakeTransport([emptyPurpose])), a);

    const dto = workflows.listByStatus()[0]!;
    expect(dto.purpose).toBeNull();
    expect(dto.template.purpose).toBe('');
  });

  it('candidate blocked when median occurrence similarity is 0.75 (< 0.78)', async () => {
    // Three related-but-distinct routines: B and C substitute disjoint
    // five-signature blocks, so every admission similarity is exactly 0.75
    // and median(1, 0.75, 0.75) < 0.78 ⇒ no candidate and NO LLM call.
    const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const sub = (targets: string[], positions: number[], tag: string): string[] =>
      targets.map((t, i) => (positions.includes(i) ? `${tag}-${t}` : t));
    const twelveStep = (title: string, targets: string[], startMs: number): string =>
      seedTwelve(title, targets, startMs);
    const a = twelveStep('med-a', labels, DAY);
    twelveStep('med-b', sub(labels, [0, 1, 2, 3, 4], 'x'), DAY + DAY_MS);
    twelveStep('med-c', sub(labels, [7, 8, 9, 10, 11], 'y'), DAY + 2 * DAY_MS);
    const transport = new FakeTransport([TEMPLATE_JSON]);
    const miner = buildMiner(transport);
    await mine(miner, a);
    expect(workflows.listByStatus()).toHaveLength(0);
    expect(transport.prompts).toHaveLength(0); // gates precede template synthesis
  });

  function seedTwelve(title: string, targets: string[], startMs: number): string {
    const segment = segments.createOpen(startMs, ev(), startMs);
    let t = startMs;
    for (const target of targets) {
      const step: CoalescedStep = {
        action: 'click',
        appBundleId: 'com.test.App',
        appName: 'TestApp',
        target,
        text: null,
        startedAtMs: t,
        endedAtMs: t + 10_000,
        firstEventId: ev(),
        lastEventId: ev(),
        eventCount: 1,
        targetRole: null,
      };
      segments.appendStep(segment.id, step, {
        text: null,
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
          title,
          summary: `${title} summary`,
          intent: 'repetitive admin',
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

  it('rejected workflow suppresses candidate creation over ≥50% shared episodes', async () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const d3 = routineDay(2);
    // User already rejected this pattern.
    const rejectedId = workflows.insertWorkflow(
      {
        name: 'old noise',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d1, similarity: 0.9 },
          { episodeId: d2, similarity: 0.9 },
          { episodeId: d3, similarity: 0.9 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + 2 * DAY_MS,
      },
      DAY + 3 * DAY_MS,
    );
    workflows.updateStatus(rejectedId, 'rejected', DAY + 3 * DAY_MS);

    const miner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    await mine(miner, d3);
    expect(workflows.listByStatus()).toHaveLength(1); // only the rejected row
    expect(workflows.listByStatus()[0]!.status).toBe('rejected');
    // No fresh evidence was folded into the rejected row either.
    expect(workflows.listByStatus()[0]!.occurrenceCount).toBe(3);
    expect(changedEvents).toBe(0);
  });

  it('live overlapping workflow absorbs new episodes via recordOccurrences instead of duplicating', async () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const d3 = routineDay(2);
    const liveId = workflows.insertWorkflow(
      {
        name: 'earlier find',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d1, similarity: 0.95 },
          { episodeId: d2, similarity: 0.85 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + DAY_MS,
      },
      DAY + 3 * DAY_MS,
    );
    const transport = new FakeTransport([TEMPLATE_JSON]);
    const miner = buildMiner(transport);
    await mine(miner, d3);
    expect(workflows.listOccurrences(liveId).map((o) => o.episodeId)).toContain(d3);
    expect(workflows.listByStatus()).toHaveLength(1);
    expect(workflows.getById(liveId)!.occurrenceCount).toBe(3);
    // No LLM call was needed — suppression happens before template synthesis.
    expect(transport.prompts).toHaveLength(0);
    expect(changedEvents).toBe(0);
  });

  it('two live workflows ≥50% overlapping absorb into exactly ONE — the higher-overlap one', async () => {
    const d0 = routineDay(0);
    const d1 = routineDay(1);
    const d2 = routineDay(2);
    const d3 = routineDay(3);
    const highId = workflows.insertWorkflow(
      {
        name: 'three-day find',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d0, similarity: 0.95 },
          { episodeId: d1, similarity: 0.9 },
          { episodeId: d2, similarity: 0.85 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + 2 * DAY_MS,
      },
      DAY + 3 * DAY_MS,
    );
    // Stale but equal-overlap rival would win only via lastSeen/id tie-breaks;
    // here ratios differ, so `high` (3/4 vs 2/4) must take everything.
    const lowId = workflows.insertWorkflow(
      {
        name: 'two-day find',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d0, similarity: 0.95 },
          { episodeId: d1, similarity: 0.9 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + 3 * DAY_MS - 1, // fresher than high on purpose
      },
      DAY + 3 * DAY_MS,
    );
    const transport = new FakeTransport([TEMPLATE_JSON]);
    await mine(buildMiner(transport), d3);
    expect(workflows.listByStatus()).toHaveLength(2); // no new row — suppressed
    expect(workflows.getById(highId)!.occurrenceCount).toBe(4);
    expect(workflows.listOccurrences(highId).map((o) => o.episodeId)).toContain(d3);
    // The loser's occurrence set is untouched.
    expect(workflows.getById(lowId)!.occurrenceCount).toBe(2);
    expect(workflows.listOccurrences(lowId).map((o) => o.episodeId)).toEqual([d1, d0]);
    expect(transport.prompts).toHaveLength(0); // no LLM call
    expect(changedEvents).toBe(0);
  });

  it('equal overlap: the fresher last_seen_at_ms workflow wins the absorb', async () => {
    const d0 = routineDay(0);
    const d1 = routineDay(1);
    const d2 = routineDay(2);
    const olderId = workflows.insertWorkflow(
      {
        name: 'older twin',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d0, similarity: 0.95 },
          { episodeId: d1, similarity: 0.9 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + DAY_MS,
      },
      DAY + 3 * DAY_MS,
    );
    const fresherId = workflows.insertWorkflow(
      {
        name: 'fresher twin',
        purpose: null,
        template: {},
        occurrences: [
          { episodeId: d0, similarity: 0.95 },
          { episodeId: d1, similarity: 0.9 },
        ],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY + 2 * DAY_MS,
      },
      DAY + 3 * DAY_MS,
    );
    const transport = new FakeTransport([TEMPLATE_JSON]);
    await mine(buildMiner(transport), d2);
    expect(workflows.listByStatus()).toHaveLength(2);
    expect(workflows.getById(fresherId)!.occurrenceCount).toBe(3);
    expect(workflows.listOccurrences(fresherId).map((o) => o.episodeId)).toContain(d2);
    expect(workflows.getById(olderId)!.occurrenceCount).toBe(2);
    expect(workflows.listOccurrences(olderId).map((o) => o.episodeId)).toEqual([d1, d0]);
    expect(transport.prompts).toHaveLength(0);
    expect(changedEvents).toBe(0);
  });

  it('recordOccurrences commits the whole absorb atomically; a mid-transaction failure leaves the ledger untouched', () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const d3 = routineDay(2);
    const liveId = workflows.insertWorkflow(
      {
        name: 'earlier find',
        purpose: null,
        template: {},
        occurrences: [{ episodeId: d1, similarity: 0.95 }],
        firstSeenAtMs: DAY,
        lastSeenAtMs: DAY,
      },
      DAY + 3 * DAY_MS,
    );
    // Round-32 audit: the absorb loop used one transaction PER ROW, so a crash
    // after the first commit latched hasOccurrenceForEpisode on re-delivery
    // and silently dropped the remaining episodes. Force exactly that crash:
    // every transaction (the whole batch is ONE) rolls back.
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });
    try {
      expect(() =>
        workflows.recordOccurrences(
          liveId,
          [
            { episodeId: d2, similarity: 0.8 },
            { episodeId: d3, similarity: 0.7 },
          ],
          DAY + 4 * DAY_MS,
        ),
      ).toThrow('SQLITE_FULL');
    } finally {
      txSpy.mockRestore();
    }
    expect(workflows.getById(liveId)!.occurrenceCount).toBe(1); // nothing committed
    expect(workflows.listOccurrences(liveId).map((o) => o.episodeId)).toEqual([d1]);

    // Clean retry records all episodes with correct counters in one pass.
    expect(
      workflows.recordOccurrences(
        liveId,
        [
          { episodeId: d2, similarity: 0.8 },
          { episodeId: d3, similarity: 0.7 },
        ],
        DAY + 4 * DAY_MS,
      ),
    ).toBe(2);
    const wf = workflows.getById(liveId)!;
    expect(wf.occurrenceCount).toBe(3);
    expect(workflows.listOccurrences(liveId).map((o) => o.episodeId)).toEqual([d3, d2, d1]); // newest-first
  });

  it('template failure leaves no row and the retry succeeds atomically', async () => {
    routineDay(0);
    routineDay(1);
    const d3 = routineDay(2);
    const badMiner = buildMiner(new FakeTransport(['not json at all', '{"name":']));
    await expect(mine(badMiner, d3)).rejects.toThrow();
    expect(workflows.listByStatus()).toHaveLength(0); // no template-less row

    // Retry (new attempt, fresh scripted response) commits everything.
    const goodMiner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    await mine(goodMiner, d3);
    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.occurrenceCount).toBe(3);
    expect(listed[0]!.template).toEqual(JSON.parse(TEMPLATE_JSON));
    expect(changedEvents).toBe(1);
  });

  it('mining an already-mined episode is a no-op (idempotency latch)', async () => {
    const d1 = routineDay(0);
    const d2 = routineDay(1);
    const d3 = routineDay(2);
    const transport = new FakeTransport([TEMPLATE_JSON]);
    const miner = buildMiner(transport);
    await mine(miner, d1);
    await mine(miner, d2);
    await mine(miner, d3);
    expect(workflows.listByStatus()).toHaveLength(1);
    const calls = transport.prompts.length;
    await mine(miner, d3);
    expect(transport.prompts).toHaveLength(calls);
    expect(workflows.listByStatus()).toHaveLength(1);
  });

  it('clusterAround expands transitively through chained members', () => {
    const fp = (signatures: string[]) => ({
      signatures,
      apps: new Set(['a']),
      intentKey: 'x',
    });
    const entry = (id: string, signatures: string[]) => ({
      id,
      startedAtMs: 0,
      intent: 'x',
      title: id,
      summary: '',
      fingerprint: fp(signatures),
    });
    // B chains to C but not A; A chains to B ⇒ transitive membership.
    const seed = entry('seed', ['s1', 's2', 's3']);
    const near = entry('near', ['s1', 's2', 'zzz']);
    const far = entry('far', ['s1', 'yyy', 'zzz']);
    expect(clusterAround(seed, [near, far]).memberIds.sort()).toEqual(['far', 'near', 'seed'].sort());
  });

  it('window and payload guards skip without side effects', async () => {
    const miner = buildMiner(new FakeTransport([TEMPLATE_JSON]));
    // Unknown episode.
    await mine(miner, '01ARZ3NDEKTSV4RRFFQ69G5FZZ');
    // Broken payload.
    await miner.handle({ id: 'j', payload_json: '{}' });
    // Regression pin (T5): UNPARSEABLE payload ('{' — invalid JSON) must hit
    // the parse guard: no throw, no LLM call, no workflow rows.
    const transport = new FakeTransport([TEMPLATE_JSON]);
    const corruptMiner = buildMiner(transport);
    await expect(corruptMiner.handle({ id: 'j2', payload_json: '{' })).resolves.toBeUndefined();
    expect(transport.prompts).toHaveLength(0);
    // Episode outside the 30-day window (seeded far in the past).
    const ancient = seedEpisode('ancient', DAY - MINING_WINDOW_MS - DAY_MS, []);
    await mine(miner, ancient);
    expect(workflows.listByStatus()).toHaveLength(0);
  });
  it('capPool keeps the most recent slice and never drops the seed', () => {
    const row = (id: string, startedAtMs: number) => ({ id, startedAtMs });
    const rows = Array.from({ length: 250 }, (_, i) => row(`e${i}`, i * 1_000));
    // Under the cap: unchanged contents and order.
    expect(capPool(rows.slice(0, 10), 'e0')).toEqual(rows.slice(0, 10));
    // Over the cap: exactly the WORKFLOW_MINING_POOL_MAX most recent rows.
    const capped = capPool(rows, 'e249');
    expect(capped).toHaveLength(WORKFLOW_MINING_POOL_MAX);
    expect(capped[0]!.id).toBe('e50');
    expect(capped[capped.length - 1]!.id).toBe('e249');
    // A seed older than the whole window takes the oldest kept slot instead
    // of being dropped by its own mining run; order stays ascending.
    const cappedWithOldSeed = capPool(
      [...rows.slice(0, 1), row('seed', -1), ...rows.slice(1)],
      'seed',
    );
    expect(cappedWithOldSeed).toHaveLength(WORKFLOW_MINING_POOL_MAX);
    expect(cappedWithOldSeed[0]!.id).toBe('seed');
    const times = cappedWithOldSeed.map((r) => r.startedAtMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('short-circuit admission clusters identically to the max-over-members reference', () => {
    // PERF-01 replaced the full max-over-members scan with a first-crossing
    // short-circuit. Membership must be identical: both accept a candidate
    // iff ANY current member scores ≥ OCCURRENCE_SIMILARITY_MIN. Compared
    // against the pre-fix reference on deterministic random fingerprints.
    interface FixtureEntry {
      id: string;
      startedAtMs: number;
      intent: string;
      title: string;
      summary: string;
      fingerprint: { signatures: string[]; apps: Set<string>; intentKey: string };
    }
    function referenceMemberIds(seed: FixtureEntry, pool: FixtureEntry[]): string[] {
      const members = [seed];
      const seen = new Set([seed.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of pool) {
          if (seen.has(candidate.id)) continue;
          const best = Math.max(
            ...members.map((m) => episodeSimilarity(candidate.fingerprint, m.fingerprint)),
          );
          if (best >= OCCURRENCE_SIMILARITY_MIN) {
            members.push(candidate);
            seen.add(candidate.id);
            grew = true;
          }
        }
      }
      return members.map((m) => m.id);
    }
    function makeEntry(id: string, signatures: string[], apps: string[], intentKey: string) {
      return {
        id,
        startedAtMs: 0,
        intent: intentKey,
        title: id,
        summary: '',
        fingerprint: { signatures, apps: new Set(apps), intentKey },
      };
    }
    // mulberry32 — tiny seeded PRNG so fixtures are reproducible.
    let prngState = 0x2f6e2b1;
    const rand = (): number => {
      prngState |= 0;
      prngState = (prngState + 0x6d2b79f5) | 0;
      let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
    for (let fixture = 0; fixture < 40; fixture += 1) {
      const pool = Array.from({ length: 12 }, (_, i) =>
        makeEntry(
          `e${i}`,
          Array.from({ length: 3 + Math.floor(rand() * 5) }, () =>
            pick(['s1', 's2', 's3', 's4', 's5', 's6']),
          ),
          Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(['a', 'b', 'c'])),
          pick(['x', 'y']),
        ),
      );
      const seed = pool.shift()!;
      const expected = referenceMemberIds(seed, [...pool]).sort();
      expect(clusterAround(seed, pool).memberIds.sort()).toEqual(expected);
    }
  });

  it('pool cap: mining sees only the most recent WORKFLOW_MINING_POOL_MAX episodes', async () => {
    // >cap identical episodes inside the window: without the cap the cluster
    // (and occurrence_count) would be WORKFLOW_MINING_POOL_MAX + 2.
    const ids: string[] = [];
    for (let i = 0; i < WORKFLOW_MINING_POOL_MAX + 2; i += 1) {
      ids.push(seedTwelve(`tiny ${i}`, ['t1', 't2', 't3'], DAY + (i % 2) * DAY_MS + i));
    }
    const transport = new FakeTransport([TEMPLATE_JSON]);
    await mine(buildMiner(transport), ids[ids.length - 1]!);
    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.occurrenceCount).toBe(WORKFLOW_MINING_POOL_MAX);
    // PERF-06: workflows.list caps the ledger view at its newest 50 rows;
    // the pool cap itself is proven by occurrenceCount above.
    expect(listed[0]!.occurrences).toHaveLength(50);
    expect(transport.prompts).toHaveLength(1); // single LLM call despite >cap pool
  });

  it('pool cap is pushed into SQL: a seed older than the newest window still mines (PERF-07)', async () => {
    // >cap identical episodes; mine from the OLDEST, which falls outside the
    // newest WORKFLOW_MINING_POOL_MAX page. The SQL page must not drop the
    // seed: includeIds re-fetches it and capPool hands it the oldest kept
    // slot, so exactly one in-window row besides the seed loses its slot.
    const ids: string[] = [];
    for (let i = 0; i < WORKFLOW_MINING_POOL_MAX + 2; i += 1) {
      ids.push(seedEpisode(`bulk ${i}`, DAY + (i % 2) * DAY_MS + i, []));
    }
    const transport = new FakeTransport([TEMPLATE_JSON]);
    await mine(buildMiner(transport), ids[0]!);
    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.occurrenceCount).toBe(WORKFLOW_MINING_POOL_MAX);
    expect(transport.prompts).toHaveLength(1); // single LLM call despite >cap pool
    // The full ledger (the listByStatus view caps at its newest 50 rows):
    const wfRow = db.prepare('SELECT id FROM workflows').get() as { id: string };
    const ledger = new Set(
      (
        db
          .prepare('SELECT episode_id FROM workflow_occurrences WHERE workflow_id = ?')
          .all(wfRow.id) as Array<{ episode_id: string }>
      ).map((r) => r.episode_id),
    );
    expect(ledger.has(ids[0]!)).toBe(true); // seed survived the page
    expect(ledger.has(ids[2]!)).toBe(false); // outside the newest-N page
    expect(ledger.has(ids[4]!)).toBe(false); // displaced by the seed's slot-0 takeover
    expect(ledger.has(ids[ids.length - 1]!)).toBe(true); // newest survives
  });
});
