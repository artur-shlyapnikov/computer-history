import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { Router } from '../src/ipc/router.js';
import { registerRetrievalOps } from '../src/ipc/retrieval-ops.js';

/**
 * Router-level integration for the M5 memory surface: grouped memories.list
 * (confirmed/suggestions/rejected; superseded hidden unless requested; unknown
 * status ⇒ error.invalid_params), the three memory.action flows and the
 * memories_changed event fired on every mutation.
 */
describe('memory router ops (in-process integration)', () => {
  let db: Db;
  let home: string;
  let router: Router;
  let memories: MemoriesRepository;
  const NOW = 1_800_000_000_000;
  let changedEvents = 0;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-memops-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    memories = new MemoriesRepository(db);
    changedEvents = 0;
    router = new Router({ log: () => undefined });
    registerRetrievalOps(router, {
      history: null as never,
      memories,
      workflows: null as never,
      onMemoriesChanged: () => {
        changedEvents += 1;
      },
      now: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const ACT_ID = ulid();
  const CAND_ID = ulid();
  const REJ_ID = ulid();
  const SUP_ID = ulid();
  const ONE_ID = ulid();
  const TWO_ID = ulid();
  const THREE_ID = ulid();

  function seed(
    id: string,
    status: 'active' | 'candidate' | 'rejected' | 'superseded',
    text: string,
    key = 'editor',
  ): void {
    db.prepare(
      `INSERT INTO memory_candidates
       (id, kind, canonical_key, text, confidence, status, first_seen_at_ms, last_seen_at_ms,
        evidence_count, created_at_ms, updated_at_ms, manual_confirmed_at_ms)
       VALUES (?, 'fact', ?, ?, 0.9, ?, ?, ?, 2, ?, ?, NULL)`,
    ).run(id, key, text, status, NOW - 1000, NOW, NOW - 1000, NOW);
    // Rowid convention mirror so FTS stays consistent.
    const row = db.prepare('SELECT rowid FROM memory_candidates WHERE id = ?').get(id) as {
      rowid: number;
    };
    db.prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)').run(
      row.rowid,
      text,
      key,
    );
  }

  async function dispatch(
    op: string,
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown; code?: string }> {
    const outcome = await router.dispatch(op, params);
    return outcome.ok
      ? { ok: true, result: outcome.result }
      : { ok: false, code: outcome.error.code };
  }

  it('groups live memories into confirmed/suggestions/rejected and hides superseded', async () => {
    seed(ACT_ID, 'active', 'uses vim');
    seed(CAND_ID, 'candidate', 'maybe nvim');
    seed(REJ_ID, 'rejected', 'was wrong');
    seed(SUP_ID, 'superseded', 'old value');

    const res = await dispatch('memories.list', {});
    expect(res.ok).toBe(true);
    const result = res.result as {
      groups: Array<{ status: string; memories: Array<{ id: string }> }>;
    };
    expect(result.groups.map((g) => g.status)).toEqual(['confirmed', 'suggestions', 'rejected']);
    expect(result.groups[0]?.memories.map((m) => m.id)).toEqual([ACT_ID]);
    expect(result.groups[1]?.memories.map((m) => m.id)).toEqual([CAND_ID]);
    expect(result.groups[2]?.memories.map((m) => m.id)).toEqual([REJ_ID]);

    // Superseded only via explicit request.
    const supersededOnly = await dispatch('memories.list', { status: 'superseded' });
    expect(supersededOnly.ok).toBe(true);
    expect((supersededOnly.result as typeof result).groups[0]?.status).toBe('superseded');
    expect((supersededOnly.result as typeof result).groups).toHaveLength(1);
  });

  it('answers error.invalid_params for an unknown status filter', async () => {
    const res = await dispatch('memories.list', { status: 'archived' });
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('error.invalid_params');
    // Empty DB still answers ok with the three fixed groups.
    const empty = await dispatch('memories.list', {});
    expect(empty.result).toEqual({
      groups: [
        { status: 'confirmed', memories: [] },
        { status: 'suggestions', memories: [] },
        { status: 'rejected', memories: [] },
      ],
    });
  });

  it('confirm activates immediately with a manual stamp; fires memories_changed', async () => {
    seed(ONE_ID, 'candidate', 'deploys friday', 'deploy_day');
    changedEvents = 0;

    const res = await dispatch('memory.action', { id: ONE_ID, action: 'confirm' });
    expect(res.ok).toBe(true);
    const updated = (res.result as { updated: { status: string; id: string } }).updated;
    expect(updated.status).toBe('active');
    const stamp = db
      .prepare('SELECT manual_confirmed_at_ms FROM memory_candidates WHERE id = ?')
      .get(ONE_ID) as { manual_confirmed_at_ms: number };
    expect(stamp.manual_confirmed_at_ms).toBe(NOW); // injectable clock honored
    expect(changedEvents).toBe(1);

    // Confirming again still works and keeps firing events.
    await dispatch('memory.action', { id: ONE_ID, action: 'confirm' });
    expect(changedEvents).toBe(2);
  });

  it('reject moves a row to rejected; forget hard-deletes including FTS', async () => {
    seed(TWO_ID, 'candidate', 'uses vim');

    const rejected = await dispatch('memory.action', { id: TWO_ID, action: 'reject' });
    expect(rejected.ok).toBe(true);
    expect((rejected.result as { updated: { status: string } }).updated.status).toBe('rejected');

    const gone = await dispatch('memory.action', { id: TWO_ID, action: 'forget' });
    expect(gone.ok).toBe(true);
    expect((gone.result as { updated: unknown }).updated).toBeNull();
    expect(memories.getById(TWO_ID)).toBeNull();
    // FTS absence proven by search.
    expect(memories.searchMemories({ query: 'vim' })).toHaveLength(0);

    // Unknown id → error.not_found for every action.
    for (const action of ['confirm', 'reject', 'forget'] as const) {
      const missing = await dispatch('memory.action', { id: ulid(), action });
      expect(missing.ok).toBe(false);
      expect((missing as { code?: string }).code).toBe('error.not_found');
    }
  });

  it('fires memories_changed exactly once per successful mutation, never on failures', async () => {
    seed(THREE_ID, 'candidate', 'nightly rebuild', 'build_flow');
    changedEvents = 0;
    await dispatch('memory.action', { id: THREE_ID, action: 'forget' });
    expect(changedEvents).toBe(1);

    changedEvents = 0;
    await dispatch('memory.action', { id: ulid(), action: 'forget' }); // not found
    await dispatch('memories.list', { status: 'archived' }); // invalid params
    await dispatch('memory.action', { id: 'nope', action: 'explode' as never }); // bad enum
    expect(changedEvents).toBe(0);
  });
});
