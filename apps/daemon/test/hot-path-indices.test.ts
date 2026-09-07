import { describe, expect, it } from 'vitest';

import type { Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { tempDb } from './helpers/db.js';

/**
 * Migration 006 (DB-01..04) exists purely for planner behavior: four hot
 * lookups used to full-scan unbounded tables. This file pins that the indices
 * EXIST and that the production-shaped queries actually USE them. Plan-string
 * assertions match on the index NAME substring only — SQLite's `detail`
 * wording drifts across versions.
 */

interface IndexRow {
  name: string;
  tbl_name: string;
}

interface MemoryRow {
  id: string;
}

const EXPECTED_INDICES: Array<{ name: string; table: string }> = [
  { name: 'idx_memory_candidates_canonical_key', table: 'memory_candidates' },
  { name: 'idx_memory_evidence_episode', table: 'memory_evidence' },
  { name: 'idx_workflow_occurrences_episode', table: 'workflow_occurrences' },
  { name: 'idx_episode_step_links_step', table: 'episode_step_links' },
];

/** EXPLAIN QUERY PLAN detail lines for a statement (shared by every plan case). */
function planDetails(db: Db, sql: string, ...params: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

describe('migration 006 hot-path indices', () => {
  it('creates the four named indices on their pinned tables', () => {
    const h = tempDb();
    try {
      const rows = h.db
        .prepare('SELECT name, tbl_name FROM sqlite_master WHERE type = ?')
        .all('index') as IndexRow[];
      for (const expected of EXPECTED_INDICES) {
        const row = rows.find((r) => r.name === expected.name);
        expect(row, `missing index ${expected.name}`).toBeDefined();
        expect(row?.tbl_name).toBe(expected.table);
      }
    } finally {
      h.close();
    }
  });

  it("upsertCandidate/listByKey probe uses the canonical-key index without an ORDER BY temp b-tree", () => {
    // Mirror of memories-repository.ts listByKey / upsertCandidate probe.
    const h = tempDb();
    try {
      const details = planDetails(
        h.db,
        `SELECT * FROM memory_candidates WHERE canonical_key = ?
         ORDER BY created_at_ms ASC, id ASC`,
        'k1',
      );
      expect(details.some((d) => d.includes('idx_memory_candidates_canonical_key'))).toBe(true);
      expect(details.some((d) => d.includes('SCAN memory_candidates'))).toBe(false);
      // The composite tail must serve the sort — no temporary b-tree anywhere.
      expect(details.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('hasEvidenceForEpisode probes memory_evidence via its episode index', () => {
    // Mirror of memories-repository.ts hasEvidenceForEpisode.
    const h = tempDb();
    try {
      const details = planDetails(
        h.db,
        'SELECT 1 AS hit FROM memory_evidence WHERE episode_id = ? LIMIT 1',
        'ep-1',
      );
      expect(details.some((d) => d.includes('idx_memory_evidence_episode'))).toBe(true);
      expect(details.some((d) => d.includes('SCAN memory_evidence'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('hasOccurrenceForEpisode probes workflow_occurrences via its episode index', () => {
    // Mirror of workflows-repository.ts hasOccurrenceForEpisode.
    const h = tempDb();
    try {
      const details = planDetails(
        h.db,
        'SELECT 1 AS hit FROM workflow_occurrences WHERE episode_id = ? LIMIT 1',
        'ep-1',
      );
      expect(details.some((d) => d.includes('idx_workflow_occurrences_episode'))).toBe(true);
      expect(details.some((d) => d.includes('SCAN workflow_occurrences'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('retention/delete step-link lookup searches episode_step_links by semantic_step_id', () => {
    // Mirror of delete-service.ts / segments-repository.ts step-link purge:
    //   DELETE FROM episode_step_links WHERE semantic_step_id IN (…)
    const h = tempDb();
    try {
      const details = planDetails(
        h.db,
        `DELETE FROM episode_step_links WHERE semantic_step_id IN (?, ?, ?)`,
        's1', 's2', 's3',
      );
      expect(details.some((d) => d.includes('idx_episode_step_links_step'))).toBe(true);
      expect(details.some((d) => d.includes('SCAN episode_step_links'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('re-running migrate is a no-op and leaves the four index rows untouched', () => {
    const h = tempDb();
    try {
      const snapshot = () =>
        EXPECTED_INDICES.map(({ name }) =>
          h.db.prepare('SELECT name, sql FROM sqlite_master WHERE name = ?').get(name),
        );
      const before = snapshot();
      expect(migrate(h.db).applied).toEqual([]);
      expect(snapshot()).toEqual(before);
    } finally {
      h.close();
    }
  });

  it('listByKey-shaped SELECT over 2000 same-key candidates returns every row via the indexed plan', () => {
    // Determinism guard: wall-clock timings below are a DEBUG AID only and are
    // never asserted — CI machines are noisy; the contract is the plan shape
    // pinned above, not milliseconds.
    const h = tempDb();
    try {
      const insert = h.db.prepare(
        `INSERT INTO memory_candidates (
           id, kind, canonical_key, text, confidence, status,
           first_seen_at_ms, last_seen_at_ms, evidence_count,
           created_at_ms, updated_at_ms, manual_confirmed_at_ms
         ) VALUES (?, 'fact', ?, ?, 0.5, 'candidate', 1, 1, 1, ?, ?, NULL)`,
      );
      h.db.transaction(() => {
        for (let i = 0; i < 2000; i += 1) {
          insert.run(`m${String(i).padStart(4, '0')}`, 'hot-key', `claim ${i}`, i, i);
        }
      })();

      const indexedSql = `SELECT * FROM memory_candidates WHERE canonical_key = ?
         ORDER BY created_at_ms ASC, id ASC`;
      const unindexedSql = `SELECT * FROM memory_candidates NOT INDEXED WHERE canonical_key = ?
         ORDER BY created_at_ms ASC, id ASC`;

      // The indexed plan must be the one pinned above even under real data.
      const details = planDetails(h.db, indexedSql, 'hot-key');
      expect(details.some((d) => d.includes('idx_memory_candidates_canonical_key'))).toBe(true);

      let start = process.hrtime.bigint(); // debug aid — never asserted
      const indexedRows = h.db.prepare(indexedSql).all('hot-key') as unknown as MemoryRow[];
      console.debug(`indexed listByKey-shaped scan took ${Number(process.hrtime.bigint() - start) / 1e6} ms`);
      start = process.hrtime.bigint();
      const unindexedRows = h.db.prepare(unindexedSql).all('hot-key') as unknown as MemoryRow[];
      console.debug(`forced-unindexed twin took ${Number(process.hrtime.bigint() - start) / 1e6} ms`);

      expect(indexedRows.length).toBe(2000);
      expect(unindexedRows.length).toBe(2000);
      // Same ordering contract either way: oldest creation first.
      expect(indexedRows[0]?.id).toBe(unindexedRows[0]?.id);
      expect(indexedRows.at(-1)?.id).toBe(unindexedRows.at(-1)?.id);
    } finally {
      h.close();
    }
  });
});
