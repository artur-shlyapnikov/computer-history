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
 * PERF-02 regression: memories.list must cap each group's rows. The schema
 * bounds `limit` to 1–200; the op handler defaults an omitted param to 200 so
 * a default recorder call (no params) can never serialize the whole table.
 */
describe('memories.list limit', () => {
  let db: Db;
  let home: string;
  let router: Router;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-memlimit-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    router = new Router({ log: () => undefined });
    registerRetrievalOps(router, {
      history: null as never,
      memories: new MemoriesRepository(db),
      workflows: null as never,
      now: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  interface Group {
    status: string;
    memories: Array<{ id: string }>;
  }

  async function dispatch(params: unknown): Promise<{ ok: boolean; groups?: Group[] }> {
    const outcome = await router.dispatch('memories.list', params);
    return outcome.ok
      ? { ok: true, groups: (outcome.result as { groups: Group[] }).groups }
      : { ok: false };
  }

  /**
   * Seed `count` candidates; returns ids in expected list order
   * (last_seen_at_ms DESC). Unique timestamps keep that order unambiguous.
   */
  function seedCandidates(count: number, status = 'candidate'): string[] {
    const insert = db.prepare(
      `INSERT INTO memory_candidates
       (id, kind, canonical_key, text, confidence, status, first_seen_at_ms, last_seen_at_ms,
        evidence_count, created_at_ms, updated_at_ms, manual_confirmed_at_ms)
       VALUES (?, 'fact', ?, ?, 0.9, ?, ?, ?, 1, ?, ?, NULL)`,
    );
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = ulid();
      insert.run(id, `key_${i}`, `text ${i}`, status, NOW - i, NOW - i, NOW - i, NOW - i);
      ids.push(id);
    }
    return ids;
  }

  it('caps each group at the requested limit and preserves ordering', async () => {
    const seeded = seedCandidates(30);
    const res = await dispatch({ limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.groups).toHaveLength(3); // confirmed/suggestions/rejected still present
    const suggestions = res.groups?.find((g) => g.status === 'suggestions');
    expect(suggestions?.memories.map((m) => m.id)).toEqual(seeded.slice(0, 5));
  });

  it('defaults an omitted limit to 200', async () => {
    seedCandidates(205);
    const res = await dispatch({});
    expect(res.ok).toBe(true);
    const suggestions = res.groups?.find((g) => g.status === 'suggestions');
    expect(suggestions?.memories).toHaveLength(200);
  });

  it('limits an explicit single-status group too', async () => {
    seedCandidates(12);
    const res = await dispatch({ status: 'suggestions', limit: 3 });
    expect(res.ok).toBe(true);
    expect(res.groups).toHaveLength(1);
    expect(res.groups?.[0]?.status).toBe('suggestions');
    expect(res.groups?.[0]?.memories).toHaveLength(3);
  });

  it('rejects out-of-schema limits before the repository runs', async () => {
    seedCandidates(2);
    for (const limit of [0, 201]) {
      const res = await dispatch({ limit });
      expect(res.ok).toBe(false);
    }
  });

  it('emits groups in canonical MEMORY_GROUP_ORDER regardless of seed order', async () => {
    // Seed in REVERSE canonical order (rejected → suggestions → confirmed);
    // the daemon must still emit confirmed/suggestions/rejected — the recorder
    // renders whatever order arrives (D4-7).
    seedCandidates(2, 'rejected');
    seedCandidates(2, 'candidate'); // DB status behind the "suggestions" group
    seedCandidates(2, 'active'); // DB status behind the "confirmed" group
    const res = await dispatch({});
    expect(res.ok).toBe(true);
    expect(res.groups?.map((g) => g.status)).toEqual(['confirmed', 'suggestions', 'rejected']);
    for (const g of res.groups ?? []) {
      expect(g.memories).toHaveLength(2);
    }
  });
});
