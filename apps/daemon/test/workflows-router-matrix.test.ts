import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ulid } from 'ulid';
import type { WorkflowListItem } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { WorkflowsRepository, type NewWorkflowInput } from '../src/db/workflows-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { HistoryService } from '../src/services/history-service.js';
import { registerRetrievalOps } from '../src/ipc/retrieval-ops.js';
import { Router } from '../src/ipc/router.js';
import type { Logger } from '../src/logging.js';

/**
 * GateM6 inherit fix (b): ROUTER-LEVEL matrix for workflows.list and
 * workflow.action (retrieval-ops registration path). Covers: listing by each
 * status, junk status → invalid_params, valid confirm/reject persisting with
 * workflows_changed fired exactly once per mutation, unknown id → not_found.
 */

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);

describe('router-level workflows.list / workflow.action matrix', () => {
  let db: Db;
  let home: string;
  let workflows: WorkflowsRepository;
  let router: Router;
  let clockMs: number;
  let changedEvents: number;
  let episodeIds: string[];

  function candidate(overrides: Partial<NewWorkflowInput> = {}): NewWorkflowInput {
    return {
      name: 'Routine procedure',
      purpose: null,
      template: { name: 'Routine procedure', stableSteps: ['a'] },
      occurrences: episodeIds.map((episodeId, i) => ({
        episodeId,
        similarity: 0.88 + i * 0.01,
      })),
      firstSeenAtMs: NOW - 86_400_000,
      lastSeenAtMs: NOW + 86_400_000,
      ...overrides,
    };
  }

  /** workflow_occurrences FK-references real episodes — seed the ledger rows. */
  function seedEpisode(startedAtMs: number): string {
    const id = ulid(startedAtMs);
    db.prepare(
      `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, summary, apps_json, entities_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'seed', '', '[]', '[]', ?, ?)`,
    ).run(id, startedAtMs, startedAtMs + 60_000, startedAtMs, startedAtMs);
    return id;
  }
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-wf-router-'));
    db = openDatabase(path.join(home, 'history.db'));
    migrate(db);
    workflows = new WorkflowsRepository(db);
    const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };
    router = new Router(logger);
    changedEvents = 0;
    clockMs = NOW;
    episodeIds = [
      seedEpisode(NOW - 86_400_000),
      seedEpisode(NOW),
      seedEpisode(NOW + 86_400_000),
    ];
    registerRetrievalOps(router, {
      history: new HistoryService(db),
      memories: new MemoriesRepository(db),
      workflows,
      onWorkflowsChanged: () => {
        changedEvents += 1;
      },
      now: () => clockMs,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function dispatch(op: string, params: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const outcome = await router.dispatch(op, params);
    return { ok: outcome.ok, body: outcome as unknown as Record<string, unknown> };
  }

  it('lists seeded candidates with occurrence ledgers', async () => {
    workflows.insertWorkflow(candidate(), NOW);
    const list = await dispatch('workflows.list', {});
    expect(list.ok).toBe(true);
    const rows = (list.body.result as { workflows: WorkflowListItem[] }).workflows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('candidate');
    expect(rows[0]!.occurrences).toHaveLength(3);

    const filtered = await dispatch('workflows.list', { status: 'candidate' });
    expect(filtered.ok).toBe(true);
    expect((filtered.body.result as { workflows: WorkflowListItem[] }).workflows).toHaveLength(1);
  });

  it('answers invalid_params for a junk status filter', async () => {
    const response = await dispatch('workflows.list', { status: 'bogus' });
    expect(response.ok).toBe(false);
    expect((response.body.error as { code: string }).code).toBe('error.invalid_params');
  });

  it('confirm persists candidate→confirmed and fires workflows_changed once', async () => {
    const id = workflows.insertWorkflow(candidate(), NOW);
    const response = await dispatch('workflow.action', { id, action: 'confirm' });
    expect(response.ok).toBe(true);
    const updated = (response.body.result as { updated: { status: string } }).updated;
    expect(updated.status).toBe('confirmed');
    expect(workflows.getById(id)!.status).toBe('confirmed');
    expect(changedEvents).toBe(1);
  });

  it('reject persists too; a later confirm on a rejected row still wins', async () => {
    const id = workflows.insertWorkflow(candidate(), NOW);
    await dispatch('workflow.action', { id, action: 'rejected' as never }).catch(() => undefined);
    // 'reject' is the pinned literal — the line above must have been rejected
    // by schema validation, so changedEvents stays 0.
    expect(changedEvents).toBe(0);

    const rejection = await dispatch('workflow.action', { id, action: 'reject' });
    expect(rejection.ok).toBe(true);
    expect((rejection.body.result as { updated: { status: string } }).updated.status).toBe('rejected');
    expect(changedEvents).toBe(1);

    // Manual decisions are terminal states, not one-way traps: confirm on a
    // rejected row is a legal transition (contracts workflow.action).
    clockMs = NOW + 1000;
    const confirm = await dispatch('workflow.action', { id, action: 'confirm' });
    expect(confirm.ok).toBe(true);
    expect((confirm.body.result as { updated: { status: string } }).updated.status).toBe('confirmed');
    expect(changedEvents).toBe(2);
  });

  it('answers not_found for an unknown workflow id on both ops', async () => {
    const action = await dispatch('workflow.action', { id: ulid(NOW), action: 'confirm' });
    expect(action.ok).toBe(false);
    expect((action.body.error as { code: string }).code).toBe('error.not_found');

    // Empty listing stays ok:true (an absent resource is not an op failure here),
    // but action against a missing id is always typed not_found.
    const list = await dispatch('workflows.list', {});
    expect(list.ok).toBe(true);
    expect((list.body.result as { workflows: WorkflowListItem[] }).workflows).toHaveLength(0);
  });

  it('answers invalid_params for a junk action literal', async () => {
    const id = workflows.insertWorkflow(candidate(), NOW);
    const response = await dispatch('workflow.action', { id, action: 'forget' });
    expect(response.ok).toBe(false);
    expect((response.body.error as { code: string }).code).toBe('error.invalid_params');
    expect(changedEvents).toBe(0);
  });
});
