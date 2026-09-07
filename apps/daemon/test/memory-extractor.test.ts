import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import {
  MemoryExtractor,
  MAX_CANDIDATES,
  normalizeCanonicalKey,
  validateMemoryCandidates,
} from '../src/processing/memory-extractor.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';
import { FakeTransport } from '../src/llm/fake-transport.js';
import type { JobRow } from '../src/db/jobs-repository.js';
import type { Logger } from '../src/logging.js';

const NOW = 1_700_000_000_000;

/**
 * extract_memory handler (brief-m5 §D5 item 7): scripted FakeTransport only —
 * clamp to the 0..10 budget, invalid candidates dropped with counts, canonical
 * key normalization and idempotent double-extract (no duplicate evidence).
 */
describe('MemoryExtractor (scripted transports)', () => {
  let db: Db;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let home: string;
  const logLines: Array<Record<string, unknown>> = [];
  const logSpy = vi.fn((level: string, scope: string, message: string, fields?: Record<string, unknown>) => {
    logLines.push({ level, scope, message, ...fields });
  });
  const logger: Logger = {
    log: logSpy,
    pruneOld: () => 0,
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-extractor-'));
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
    logLines.length = 0;
  });

  function seedEpisodeWithSteps(stepCount = 2): string {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    for (let i = 0; i < stepCount; i++) {
      const step: CoalescedStep = {
        action: 'type',
        appBundleId: 'com.apple.Safari',
        appName: 'Safari',
        target: `target-${i}`,
        text: `step text ${i}`,
        startedAtMs: NOW + i * 60_000,
        endedAtMs: NOW + i * 60_000 + 30_000,
        firstEventId: `e${i}a`,
        lastEventId: `e${i}b`,
        eventCount: 1,
        targetRole: null,
      };
      void segments.appendStep(segment.id, step, {
        text: step.text,
        target: step.target,
        appName: step.appName,
      });
    }
    segments.finalize(segment.id, 'finalized', NOW + stepCount * 60_000, {});
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
          steps: segments.getSteps(segment.id).map((s) => ({ id: s.id })),
        },
      ],
      NOW,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function enqueueExtract(episodeId: string): JobRow {
    const job = jobs.enqueue('extract_memory', { episodeId }, NOW, NOW);
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow;
  }

  function candidateJson(entries: Array<Record<string, unknown>>): string {
    return JSON.stringify({ candidates: entries });
  }

  function buildExtractor(
    transport: FakeTransport,
    onMemoriesChanged?: () => void,
  ): MemoryExtractor {
    return new MemoryExtractor({
      db,
      episodes,
      memories,
      logger,
      transportFactory: async () => transport,
      now: () => NOW,
      onMemoriesChanged,
    });
  }

  it('persists valid candidates as competing rows under one canonical key', async () => {
    const episodeId = seedEpisodeWithSteps();
    const transport = new FakeTransport([
      candidateJson([
        {
          kind: 'preference',
          canonicalKey: 'Editor Preference',
          text: 'User prefers vim keybindings',
          confidence: 0.9,
          evidenceDescription: 'typed in vim all session',
        },
        {
          kind: 'fact',
          canonicalKey: 'docs_site',
          text: 'Reads TypeScript docs on developer.mozilla.org',
          confidence: 0.85,
          evidenceDescription: 'visited mdn',
        },
      ]),
    ]);
    let changedFired = 0;
    await buildExtractor(transport, () => {
      changedFired += 1;
    }).handle(enqueueExtract(episodeId));

    const keys = memories.listByKey('editor_preference');
    expect(keys).toHaveLength(1); // normalized snake_case
    expect(memories.searchMemories({ query: 'vim' })).toHaveLength(1);
    // evidence anchored to the episode start (observedAtMs).
    const evidence = memories.listEvidence(keys[0]?.id ?? '');
    expect(evidence).toEqual([
      { episodeId, createdAtMs: NOW, confidence: 0.9, evidenceDescription: 'typed in vim all session' },
    ]);
    expect(changedFired).toBe(1);
  });

  it('clamps to the 0..10 budget, clamps confidence, drops invalid entries and logs counts', async () => {
    const episodeId = seedEpisodeWithSteps();
    const entry = (over: Partial<Record<string, unknown>>) =>
      ({
        kind: 'fact',
        canonicalKey: 'some_claim',
        text: `claim ${Math.random()}`,
        confidence: 0.5,
        evidenceDescription: 'x',
        ...over,
      }) as Record<string, unknown>;
    // 12 entries: two beyond the budget; among the first 10 several are invalid.
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) entries.push(entry({ text: `claim number ${i}` }));
    entries[1] = entry({ kind: 'gossip' }); // bad kind → drop
    entries[2] = entry({ canonicalKey: '!!!' }); // normalizes to empty → drop
    entries[3] = entry({ text: '' }); // empty claim → drop
    entries[4] = entry({ confidence: 4.2 }); // out-of-range → CLAMPED not dropped
    entries[5] = entry({ text: 'x'.repeat(301) }); // over-length claim → drop

    const transport = new FakeTransport([candidateJson(entries)]);
    await buildExtractor(transport).handle(enqueueExtract(episodeId));

    const counts = logLines.find((l) => l.message === 'extraction complete') ?? {};
    expect(counts.received).toBe(12);
    expect(counts.clampedOverBudget).toBe(2);
    expect(counts.droppedInvalid).toBe(4);
    expect(counts.clampedConfidence).toBe(1);

    const kept = memories.searchMemories({
      query: 'claim',
      statuses: ['candidate'],
      limit: 50,
    });
    expect(kept).toHaveLength(6); // 10 - 4 dropped
    const clamped = kept.find((m) => m.canonicalKey === 'some_claim' && m.confidence === 1);
    expect(clamped).toBeDefined(); // the 4.2-confidence entry survived, clamped to 1
  });

  it('normalizes canonical keys: case, separators, length cap, edge underscores', () => {
    expect(normalizeCanonicalKey('--deep__nested--key--')).toBe('deep_nested_key');
    expect(normalizeCanonicalKey('x'.repeat(95))).toBe('x'.repeat(80));
    expect(normalizeCanonicalKey('a b\tc')).toBe('a_b_c');
    expect(normalizeCanonicalKey('***')).toBe('');
  });

  it('is idempotent: a second extract for the same episode adds NO evidence', async () => {
    const episodeId = seedEpisodeWithSteps();
    const payload = candidateJson([
      {
        kind: 'preference',
        canonicalKey: 'dark_mode',
        text: 'Prefers dark mode everywhere',
        confidence: 0.88,
        evidenceDescription: 'settings toggled',
      },
    ]);
    const extractor = buildExtractor(new FakeTransport([payload]));
    await extractor.handle(enqueueExtract(episodeId));
    const evidenceBefore = db
      .prepare('SELECT COUNT(*) AS n FROM memory_evidence')
      .get() as { n: number };

    // Re-delivery (crash between persist and job-complete): skipped wholesale.
    await extractor.handle(enqueueExtract(episodeId));
    const evidenceAfter = db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get() as {
      n: number;
    };
    expect(evidenceAfter.n).toBe(evidenceBefore.n);
    expect(evidenceAfter.n).toBe(1);
    expect(memories.listByKey('dark_mode')[0]?.evidence_count).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      'info',
      'memory-extractor',
      'episode already extracted; skipping re-delivery',
      expect.objectContaining({ episodeId }),
    );
  });

  it('rolls back the WHOLE apply when one upsert throws mid-loop; retry re-applies all', async () => {
    const episodeId = seedEpisodeWithSteps();
    const payload = candidateJson([
      {
        kind: 'fact',
        canonicalKey: 'first_fact',
        text: 'First fact survives alone pre-fix',
        confidence: 0.9,
        evidenceDescription: 'observed one',
      },
      {
        kind: 'fact',
        canonicalKey: 'second_fact',
        text: 'Second fact is where the crash hits',
        confidence: 0.8,
        evidenceDescription: 'observed two',
      },
      {
        kind: 'preference',
        canonicalKey: 'third_pref',
        text: 'Third candidate must not be lost',
        confidence: 0.7,
        evidenceDescription: 'observed three',
      },
    ]);

    // Fail the SECOND upsert like a mid-apply SQLITE_FULL would.
    const original = memories.upsertCandidate.bind(memories);
    let calls = 0;
    const spy = vi
      .spyOn(memories, 'upsertCandidate')
      .mockImplementation((...args: Parameters<MemoriesRepository['upsertCandidate']>) => {
        calls += 1;
        if (calls === 2) throw new Error('SQLITE_FULL: database or disk is full');
        return original(...args);
      });

    await expect(
      buildExtractor(new FakeTransport([payload])).handle(enqueueExtract(episodeId)),
    ).rejects.toThrow('SQLITE_FULL');

    // Pre-fix behavior (probe-verified): the first upsert had already committed,
    // so a retry hit the any-evidence latch and the tail candidates were lost.
    // The transactional apply must leave NOTHING behind — no candidates, no
    // evidence, no FTS mirror rows.
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get()).toEqual({ n: 0 });

    // Retry after the transient failure: latch does NOT fire, all 3 land.
    spy.mockRestore();
    await buildExtractor(new FakeTransport([payload])).handle(enqueueExtract(episodeId));
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get()).toEqual({ n: 3 });
    expect(memories.listByKey('first_fact')).toHaveLength(1);
    expect(memories.listByKey('second_fact')).toHaveLength(1);
    expect(memories.listByKey('third_pref')).toHaveLength(1);

    // And once fully applied, the latch still skips further re-deliveries.
    await buildExtractor(new FakeTransport([])).handle(enqueueExtract(episodeId));
    expect(logSpy).toHaveBeenCalledWith(
      'info',
      'memory-extractor',
      'episode already extracted; skipping re-delivery',
      expect.objectContaining({ episodeId }),
    );
  });

  it('skips silently when the episode is gone, payload is broken, or payload_json is unparseable', async () => {
    const missingExtractor = buildExtractor(new FakeTransport([]));
    await missingExtractor.handle(enqueueExtract('01AAAAAAAAAAAAAAAAAAAAAAAA'));
    expect(memories.listByStatus()).toEqual([]);

    const job = jobs.enqueue('extract_memory', {}, NOW, NOW);
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow;
    await buildExtractor(new FakeTransport([])).handle(row);
    // No LLM prompt was ever issued for a broken payload.
    expect(memories.listByStatus()).toEqual([]);

    // Regression pin (T5): a TRUNCATED payload ('{' — invalid JSON) must hit
    // the parse guard, not the missing-field branch: no throw and no LLM call.
    const transport = new FakeTransport([candidateJson([])]);
    const corrupt = {
      ...enqueueExtract('01AAAAAAAAAAAAAAAAAAAAAAAA'),
      payload_json: '{',
    };
    await expect(buildExtractor(transport).handle(corrupt)).resolves.toBeUndefined();
    expect(transport.prompts).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(
      'error',
      'memory-extractor',
      'extract_memory payload unparseable',
      expect.objectContaining({ jobId: corrupt.id }),
    );
    expect(memories.listByStatus()).toEqual([]);
  });

  it('post-validation unit surface mirrors the handler rules', () => {
    const result = validateMemoryCandidates({
      candidates: [
        { kind: 'procedure', canonicalKey: 'Deploy Steps', text: 'Runs deploy script', confidence: 2, evidenceDescription: 'e' },
        { kind: 'weird', canonicalKey: 'k', text: 't', confidence: 0.5, evidenceDescription: 'e' },
      ],
    });
    expect(result.candidates).toEqual([
      { kind: 'procedure', canonicalKey: 'deploy_steps', text: 'Runs deploy script', confidence: 1, evidenceDescription: 'e' },
    ]);
    expect(result.counts.droppedInvalid).toBe(1);
    expect(result.counts.clampedConfidence).toBe(1);
    expect(MAX_CANDIDATES).toBe(10);
  });
});
