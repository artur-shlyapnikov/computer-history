import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { WorkflowsRepository, type NewWorkflowInput } from '../src/db/workflows-repository.js';

/**
 * M6 write side of workflows (brief-m6 §D6 item 2): atomic candidate
 * insertion (row + template + occurrences), confirm/reject transitions,
 * occurrence recording with running median, the episode-set index and the
 * candidate-only purge used by delete cascades.
 */
describe('WorkflowsRepository write side', () => {
  let db: Db;
  let home: string;
  let workflows: WorkflowsRepository;
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  const EP_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
  const EP_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
  const EP_C = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
  const EP_D = '01ARZ3NDEKTSV4RRFFQ69G5FAD';

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-wfwrite-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    workflows = new WorkflowsRepository(db);
    // Episodes exist up front so occurrence FKs hold; individual tests may
    // delete some to simulate evidence loss. A/B sit on UTC day 0 and C/D on
    // day 1 so threshold tests can span two distinct days.
    for (const [index, id] of [EP_A, EP_B, EP_C, EP_D].entries()) {
      const dayOffset = index < 2 ? 0 : DAY;
      seedEpisode(id, dayOffset + ((index % 2) + 1) * 1_000);
    }
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seedEpisode(id: string, startedAtMs: number): void {
    // Minimal episode row so occurrences can join to started_at_ms.
    db.prepare(
      `INSERT INTO episodes (
         id, started_at_ms, ended_at_ms, title, summary, intent, outcome,
         apps_json, entities_json, summary_model, summary_prompt_version,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 't', 's', NULL, NULL, '[]', '[]', 'm', 'v1', ?, ?)`,
    ).run(id, startedAtMs, startedAtMs + 1, NOW, NOW);
  }

  function candidate(overrides: Partial<NewWorkflowInput> = {}): NewWorkflowInput {
    return {
      name: 'Deploy checklist',
      purpose: 'Ship services without forgetting steps',
      template: { name: 'Deploy checklist', stableSteps: ['build', 'test', 'deploy'] },
      occurrences: [
        { episodeId: EP_A, similarity: 0.8 },
        { episodeId: EP_B, similarity: 0.9 },
      ],
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 2_000,
      ...overrides,
    };
  }

  it('inserts candidate + template + occurrences atomically and lists them back', () => {
    const id = workflows.insertWorkflow(candidate(), NOW);

    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    const wf = listed[0]!;
    expect(wf.id).toBe(id);
    expect(wf.status).toBe('candidate');
    expect(wf.occurrenceCount).toBe(2);
    expect(wf.medianSimilarity).toBeCloseTo(0.85, 12);
    expect(wf.template).toEqual({
      name: 'Deploy checklist',
      stableSteps: ['build', 'test', 'deploy'],
    });
    // Occurrences newest-episode-first with episode provenance attached.
    expect(wf.occurrences.map((o) => o.episodeId)).toEqual([EP_B, EP_A]);
    expect(wf.occurrences[0]).toMatchObject({ startedAtMs: 2_000, similarity: 0.9 });
    expect(wf.occurrences[1]).toMatchObject({ startedAtMs: 1_000, similarity: 0.8 });

    // Refusals happen before any row is written.
    expect(() => workflows.insertWorkflow(candidate({ occurrences: [] }), NOW)).toThrow();
    expect(workflows.listByStatus()).toHaveLength(1);
  });

  it('updateStatus moves rows to confirmed/rejected; unknown ids return null', () => {
    const id = workflows.insertWorkflow(candidate(), NOW);
    expect(workflows.updateStatus(id, 'confirmed', NOW)?.status).toBe('confirmed');
    expect(workflows.updateStatus(id, 'rejected', NOW + 1)?.status).toBe('rejected');
    expect(
      workflows.updateStatus('01ARZ3NDEKTSV4RRFFQ69G5FFF', 'confirm' as never, NOW),
    ).toBeNull();
  });

  it('recordOccurrence adds new pairs only and recomputes count/median/last_seen', () => {
    const id = workflows.insertWorkflow(candidate(), NOW);

    expect(workflows.recordOccurrence(id, { episodeId: EP_A, similarity: 0.99 }, NOW + 5)).toBe(
      false,
    ); // duplicate pair ignored
    expect(workflows.recordOccurrence(id, { episodeId: EP_C, similarity: 0.7 }, NOW + 5)).toBe(
      true,
    );

    const wf = workflows.getById(id)!;
    expect(wf.occurrenceCount).toBe(3);
    expect(wf.medianSimilarity).toBeCloseTo(0.8, 12); // median(0.8, 0.9, 0.7)
    expect(wf.lastSeenAtMs).toBe(NOW + 5); // MAX(wall-clock now, prior value)
  });

  it('indexes cluster-scoped episode sets per workflow for overlap suppression', () => {
    const id = workflows.insertWorkflow(candidate(), NOW);
    const { ledger } = workflows.suppressionInputs([EP_A, EP_B, EP_C]);
    expect(ledger.get(id)).toEqual(new Set([EP_A, EP_B]));
    expect(workflows.hasOccurrenceForEpisode(EP_A)).toBe(true);
    expect(workflows.hasOccurrenceForEpisode(EP_C)).toBe(false);
  });

  it('purges candidates below the 3-occurrence/2-day thresholds; confirmed/rejected persist', () => {
    const doomed = workflows.insertWorkflow(
      candidate({
        name: 'orphan-prone',
        occurrences: [
          { episodeId: EP_A, similarity: 0.8 },
          { episodeId: EP_B, similarity: 0.9 },
          { episodeId: EP_C, similarity: 0.85 },
        ],
        firstSeenAtMs: 1_000,
        lastSeenAtMs: DAY + 1_000,
      }),
      NOW,
    );
    // Both manual rows sit BELOW the thresholds on purpose: a manual decision
    // is immune to the cascade even when it could never be re-mined.
    const confirmed = workflows.insertWorkflow(candidate({ name: 'kept-confirmed' }), NOW);
    workflows.updateStatus(confirmed, 'confirmed', NOW);
    const rejected = workflows.insertWorkflow(candidate({ name: 'kept-rejected' }), NOW);
    workflows.updateStatus(rejected, 'rejected', NOW);

    // Nothing deleted while the candidate still meets both thresholds
    // (3 occurrences across 2 distinct UTC days).
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(0);
    expect(workflows.listByStatus()).toHaveLength(3);

    // Evidence loss (the future delete-range cascade): occurrences for the
    // deleted episodes are removed first (FK), then the episode rows
    // themselves, then the helper sweeps candidates left below threshold.
    for (const episodeId of [EP_A, EP_B]) {
      db.prepare('DELETE FROM workflow_occurrences WHERE episode_id = ?').run(episodeId);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId);
    }
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(1); // doomed: 1 occ / 1 day left
    expect(
      workflows
        .listByStatus()
        .map((w) => w.status)
        .sort(),
    ).toEqual(['confirmed', 'rejected']);
    expect(workflows.getById(doomed)).toBeNull();
    // Non-candidate rows are left completely untouched (count included).
    const kept = workflows.getById(confirmed)!;
    expect(kept.occurrenceCount).toBe(2); // denormalized count frozen (stale by design)
    expect(workflows.listByStatus({ status: 'confirmed' })[0]!.occurrences).toHaveLength(0);
    // A second pass has nothing left to do.
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(0);
  });

  it('purges a candidate that drops to one occurrence after evidence loss', () => {
    const id = workflows.insertWorkflow(
      candidate({
        name: 'partial-loss',
        occurrences: [
          { episodeId: EP_A, similarity: 0.8 },
          { episodeId: EP_D, similarity: 0.9 },
        ],
      }),
      NOW,
    );
    db.prepare('DELETE FROM workflow_occurrences WHERE episode_id = ?').run(EP_D);
    db.prepare('DELETE FROM episodes WHERE id = ?').run(EP_D);
    // occurrence_count 1 < 3 ⇒ below the candidate threshold (contracts
    // §M6→M7): the row is purged, not merely recounted.
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(1);
    expect(workflows.getById(id)).toBeNull();
  });

  it('purges a candidate whose occurrences all fall on a single UTC day', () => {
    const epE = '01ARZ3NDEKTSV4RRFFQ69G5FAE';
    seedEpisode(epE, 3_000);
    const id = workflows.insertWorkflow(
      candidate({
        name: 'same-day',
        occurrences: [
          { episodeId: EP_A, similarity: 0.8 },
          { episodeId: EP_B, similarity: 0.9 },
          { episodeId: epE, similarity: 0.85 },
        ],
      }),
      NOW,
    );
    // 3 occurrences but ONE distinct UTC day ⇒ below the candidate threshold.
    expect(workflows.purgeCandidatesBelowThreshold()).toBe(1);
    expect(workflows.getById(id)).toBeNull();
  });
});
