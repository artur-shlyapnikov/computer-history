import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { WorkflowsRepository, type NewWorkflowInput } from '../src/db/workflows-repository.js';
import type { WorkflowDto, WorkflowListItem } from '@computer-history/protocol';

/**
 * PERF-04/05 read-side efficiency contracts: workflows.list is served with
 * exactly TWO queries (one page of rows + one batched occurrence ledger)
 * instead of one ledger query per row, and status-only consumers get a cheap
 * id→status projection instead of full DTOs + ledgers.
 */
describe('WorkflowsRepository read efficiency', () => {
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
    home = mkdtempSync(path.join(tmpdir(), 'ch-wfperf-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    workflows = new WorkflowsRepository(db);
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
      purpose: null,
      template: { stableSteps: ['build', 'test'] },
      occurrences: [
        { episodeId: EP_A, similarity: 0.8 },
        { episodeId: EP_B, similarity: 0.9 },
      ],
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 2_000,
      ...overrides,
    };
  }

  /**
   * The pre-PERF-04 implementation, kept verbatim as the behavioral
   * reference: N+1 ledger queries but the exact response contract.
   */
  function referenceListByStatus(
    status?: string,
  ): Array<WorkflowDto & { occurrences: WorkflowListItem['occurrences'] }> {
    const where = status !== undefined ? 'WHERE status = ?' : '';
    const values = status !== undefined ? [status] : [];
    const rows = db
      .prepare(`SELECT * FROM workflows ${where} ORDER BY last_seen_at_ms DESC, id ASC`)
      .all(...values) as Array<{
      id: string;
      status: string;
      template_json: string;
      occurrence_count: number;
      median_similarity: number;
      first_seen_at_ms: number;
      last_seen_at_ms: number;
      created_at_ms: number;
      updated_at_ms: number;
      name: string;
      purpose: string | null;
    }>;
    return rows
      .filter((r) => ['candidate', 'confirmed', 'rejected'].includes(r.status))
      .map((row) => ({
        id: row.id,
        name: row.name,
        purpose: row.purpose,
        status: row.status as WorkflowDto['status'],
        template: JSON.parse(row.template_json) as WorkflowDto['template'],
        occurrenceCount: row.occurrence_count,
        medianSimilarity: row.median_similarity,
        firstSeenAtMs: row.first_seen_at_ms,
        lastSeenAtMs: row.last_seen_at_ms,
        createdAtMs: row.created_at_ms,
        updatedAtMs: row.updated_at_ms,
        occurrences: db
          .prepare(
            `SELECT o.episode_id AS episodeId, o.similarity,
                    COALESCE(e.started_at_ms, 0) AS startedAtMs
             FROM workflow_occurrences o
             LEFT JOIN episodes e ON e.id = o.episode_id
             WHERE o.workflow_id = ?
             ORDER BY COALESCE(e.started_at_ms, 0) DESC, o.episode_id ASC`,
          )
          .all(row.id) as WorkflowListItem['occurrences'],
      }));
  }

  it('listByStatus issues exactly 2 queries and returns the reference DTOs', () => {
    const older = workflows.insertWorkflow(candidate(), NOW);
    const newer = workflows.insertWorkflow(
      candidate({
        name: 'Later routine',
        occurrences: [
          { episodeId: EP_C, similarity: 0.75 },
          { episodeId: EP_D, similarity: 0.95 },
          { episodeId: EP_A, similarity: 0.7 },
        ],
        lastSeenAtMs: 9_000,
      }),
      NOW,
    );
    const confirmed = workflows.insertWorkflow(
      candidate({ name: 'Confirmed one', lastSeenAtMs: 5_000 }),
      NOW,
    );
    workflows.updateStatus(confirmed, 'confirmed', NOW);

    // Unfiltered listing: exactly two statements — the row page and ONE
    // batched ledger query (was 1 + N before PERF-04).
    const prepareSpy = vi.spyOn(db, 'prepare');
    const listed = workflows.listByStatus();
    expect(prepareSpy).toHaveBeenCalledTimes(2);
    prepareSpy.mockRestore();

    expect(listed.map((w) => w.id)).toEqual([newer, confirmed, older]);
    // Deep-equal to the pre-fix reference implementation on the same data.
    expect(listed).toEqual(referenceListByStatus());
    // Per-ledger ordering survives the batching (newest episode first).
    expect(listed[0]!.occurrences.map((o) => o.episodeId)).toEqual([EP_D, EP_C, EP_A]);

    // Status-filtered listing stays at two queries too.
    const filterSpy = vi.spyOn(db, 'prepare');
    const confirmedOnly = workflows.listByStatus({ status: 'confirmed' });
    expect(filterSpy).toHaveBeenCalledTimes(2);
    filterSpy.mockRestore();
    expect(confirmedOnly.map((w) => w.id)).toEqual([confirmed]);
    expect(confirmedOnly).toEqual(referenceListByStatus('confirmed'));
  });

  it('listByStatus returns [] without touching the ledger table when no rows match', () => {
    const prepareSpy = vi.spyOn(db, 'prepare');
    expect(workflows.listByStatus()).toEqual([]);
    expect(prepareSpy).toHaveBeenCalledTimes(1); // only the (empty) row page
    prepareSpy.mockRestore();
  });

  it('listByStatus caps each workflow ledger to the newest window (PERF-06)', () => {
    // 60 distinct episodes at 1s spacing; occurrence i links episode i, so
    // newest-first order is reverse seed order.
    const count = 60;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVZ';
    const ids = Array.from({ length: count }, (_, i) =>
      `01ARZ3NDEKTSV4RRFFQ69G5F${alphabet[Math.floor(i / alphabet.length)]}${alphabet[i % alphabet.length]}`,
    );
    for (const [index, id] of ids.entries()) seedEpisode(id, 1_000 + index * 1_000);
    workflows.insertWorkflow(
      candidate({
        name: 'Long ledger',
        occurrences: ids.map((episodeId) => ({ episodeId, similarity: 0.5 })),
        lastSeenAtMs: NOW,
      }),
      NOW,
    );

    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(1);
    const item = listed[0]!;
    // The wire count stays the true total; only the ledger array is a window.
    expect(item.occurrenceCount).toBe(count);
    expect(item.occurrences).toHaveLength(50);
    expect(item.occurrences[0]!.episodeId).toBe(ids[count - 1]);
    expect(item.occurrences[49]!.episodeId).toBe(ids[count - 50]);
    // The window is exactly the newest 50 of the full (reference) ledger.
    expect(item.occurrences).toEqual(referenceListByStatus()[0]!.occurrences.slice(0, 50));
  });

  it('lists more than one IN-chunk of workflows without breaking on SQLite parameter limits', () => {
    // Round-33 pin: a single IN(...) over ALL workflow ids throws SQLITE_RANGE
    // past SQLite's host-parameter ceiling and workflows.list dies wholesale.
    // 501 minimal rows (multi-occurrence ledgers, join satisfied) prove the
    // chunked path returns every workflow with cross-chunk order AND per-ledger
    // episode order intact.
    const count = 501;
    const EPISODES_PER_WORKFLOW = 3;
    const episodeId = (i: number, j: number): string =>
      `01ROUND33EP${String(i).padStart(13, '0')}${String(j).padStart(2, '0')}`;
    // Workflow id -> expected ledger order (startedAtMs DESC, episodeId ASC),
    // built from the fixtures below — occurrences[0] is the newest episode.
    const expectedLedger = new Map<string, string[]>();
    for (let i = 0; i < count; i += 1) {
      const episodes: Array<{ id: string; startedAtMs: number }> = [];
      for (let j = 0; j < EPISODES_PER_WORKFLOW; j += 1) {
        const id = episodeId(i, j);
        const startedAtMs = NOW - i * 1_000 - j * 10_000;
        seedEpisode(id, startedAtMs);
        episodes.push({ id, startedAtMs });
      }
      const wfId = workflows.insertWorkflow(
        candidate({
          name: `wf ${i}`,
          occurrences: episodes.map(({ id }) => ({ episodeId: id, similarity: 0.5 })),
          lastSeenAtMs: NOW - i * 1_000,
        }),
        NOW,
      );
      expectedLedger.set(
        wfId,
        [...episodes]
          .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? -1 : 1))
          .map(({ id }) => id),
      );
    }

    const listed = workflows.listByStatus();
    expect(listed).toHaveLength(count);
    // Newest-activity-first ordering survives the chunk boundary (wf 500 is
    // the first id of the SECOND chunk, directly after chunk 0's wf 499).
    expect(listed[0]!.name).toBe('wf 0');
    expect(listed[count - 1]!.name).toBe(`wf ${count - 1}`);
    // Full response contract identical to the N+1 reference implementation.
    expect(listed.map((w) => w.id)).toEqual(referenceListByStatus().map((w) => w.id));
    // Every workflow keeps its own joined ledger despite the split IN(...),
    // and per-ledger newest-first ordering holds across the chunk boundary.
    for (const item of listed) {
      expect(item.occurrences).toHaveLength(EPISODES_PER_WORKFLOW);
      expect(item.occurrences[0]!.episodeId).toBe(expectedLedger.get(item.id)![0]);
      expect(item.occurrences.map((o) => o.episodeId)).toEqual(expectedLedger.get(item.id));
    }
  });

  it('suppressionInputs projects cluster-scoped ledgers and status for sharers only', () => {
    const a = workflows.insertWorkflow(candidate(), NOW); // ledger: EP_A, EP_B
    const b = workflows.insertWorkflow(
      candidate({ name: 'b', occurrences: [{ episodeId: EP_C, similarity: 0.7 }] }),
      NOW,
    );
    workflows.updateStatus(b, 'rejected', NOW);

    const onlyA = workflows.suppressionInputs([EP_A]);
    expect(onlyA.ledger.get(a)).toEqual(new Set([EP_A]));
    expect(onlyA.ledger.has(b)).toBe(false); // b's ledger has no cluster id
    expect(onlyA.status.get(a)).toBe('candidate');
    expect(onlyA.status.has(b)).toBe(false); // no shared id → not projected

    const both = workflows.suppressionInputs([EP_A, EP_C]);
    expect(both.ledger.get(a)).toEqual(new Set([EP_A]));
    expect(both.ledger.get(b)).toEqual(new Set([EP_C]));
    expect(both.status.get(a)).toBe('candidate');
    expect(both.status.get(b)).toBe('rejected');
  });
});
