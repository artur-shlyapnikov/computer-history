import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { WorkflowsRepository } from '../src/db/workflows-repository.js';

/**
 * READ-side repository contracts (brief-m4 §D4 item 2). Rows are seeded
 * directly — the write side lands M5/M6. memories_fts follows the M4-declared
 * rowid convention: fts.rowid === memory_candidates.rowid.
 */
describe('memories/workflows repositories (READ side)', () => {
  let home: string;
  let db: Db;
  let memories: MemoriesRepository;
  let workflows: WorkflowsRepository;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-readrepo-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    memories = new MemoriesRepository(db);
    workflows = new WorkflowsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seedMemory(opts: {
    id: string;
    text: string;
    kind?: string;
    status?: string;
    confidence?: number;
    canonicalKey?: string;
    lastSeenAtMs?: number;
  }): void {
    const now = opts.lastSeenAtMs ?? 1_700_000_000_000;
    const result = db
      .prepare(
        `INSERT INTO memory_candidates
         (id, kind, canonical_key, text, confidence, status, first_seen_at_ms, last_seen_at_ms,
          evidence_count, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?)`,
      )
      .run(
        opts.id,
        opts.kind ?? 'fact',
        opts.canonicalKey ?? `key${opts.id}`,
        opts.text,
        opts.confidence ?? 0.9,
        opts.status ?? 'active',
        now - 1000,
        now,
        now - 1000,
        now,
      );
    // Rowid convention owned here: fts row mirrors the candidate rowid.
    db.prepare('INSERT INTO memories_fts (rowid, text, canonical_key) VALUES (?, ?, ?)').run(
      Number(result.lastInsertRowid),
      opts.text,
      opts.canonicalKey ?? `key${opts.id}`,
    );
  }

  function seedWorkflow(opts: {
    id: string;
    name: string;
    purpose?: string | null;
    status?: string;
    occurrenceCount?: number;
    lastSeenAtMs?: number;
  }): void {
    const now = opts.lastSeenAtMs ?? 1_700_000_000_000;
    db.prepare(
      `INSERT INTO workflows
       (id, name, purpose, status, template_json, occurrence_count, median_similarity,
        first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, '{}', ?, 0.8, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.name,
      opts.purpose ?? null,
      opts.status ?? 'candidate',
      opts.occurrenceCount ?? 3,
      now - 1000,
      now,
      now - 1000,
      now,
    );
  }

  it('searches memories via fts with kinds/minConfidence/status filters', () => {
    seedMemory({ id: 'm1', text: 'user prefers dark mode', kind: 'preference', confidence: 0.95 });
    seedMemory({
      id: 'm2',
      text: 'deploys every friday',
      kind: 'fact',
      confidence: 0.6,
      status: 'candidate',
    });
    seedMemory({ id: 'm3', text: 'dark mode rollout plan', kind: 'fact', status: 'rejected' });
    seedMemory({
      id: 'm4',
      text: 'runs kubectl rollout restart',
      kind: 'procedure',
      confidence: 0.85,
    });

    // Default statuses = active+candidate: m3 (rejected) invisible even on hit.
    expect(memories.searchMemories({ query: 'dark mode' }).map((m) => m.id)).toEqual(['m1']);

    // kind filter.
    const procedures = memories.searchMemories({ query: 'rollout', kinds: ['procedure'] });
    expect(procedures.map((m) => m.id)).toEqual(['m4']);

    // minConfidence filter.
    expect(
      memories.searchMemories({ query: 'friday', minConfidence: 0.8 }),
    ).toHaveLength(0);
    expect(memories.searchMemories({ query: 'friday', minConfidence: 0.5 })).toHaveLength(1);

    // Opting into dead statuses surfaces them.
    expect(
      memories.searchMemories({ query: 'dark mode', statuses: ['rejected'] }).map((m) => m.id),
    ).toEqual(['m3']);

    // Canonical_key is searchable too.
    expect(memories.searchMemories({ query: 'keym1' })).toHaveLength(1);

    // Empty/blank queries return nothing (listings go through listByStatus).
    expect(memories.searchMemories({ query: '   ' })).toHaveLength(0);
  });

  it('clamps search limit into [1, 50] and orders bm25-best first', () => {
    for (let i = 0; i < 55; i++) {
      seedMemory({ id: `m${i}`, text: `recurring standup note ${i}` });
    }
    expect(memories.searchMemories({ query: 'standup' })).toHaveLength(10); // default
    expect(memories.searchMemories({ query: 'standup', limit: 0 })).toHaveLength(1);
    expect(memories.searchMemories({ query: 'standup', limit: 500 })).toHaveLength(50);
    expect(memories.searchMemories({ query: 'standup', limit: 3 }).map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
  });

  it('lists memories grouped-by-status compatible (status filter, newest activity first)', () => {
    seedMemory({ id: 'old', text: 'a', lastSeenAtMs: 1_000 });
    seedMemory({ id: 'new', text: 'b', lastSeenAtMs: 2_000 });
    expect(memories.listByStatus().map((m) => m.id)).toEqual(['new', 'old']);
    expect(memories.listByStatus({ status: 'active' }).map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('searches workflows case-insensitively on name/purpose with status filter', () => {
    seedWorkflow({ id: 'w1', name: 'Deploy slack bot', purpose: 'post release notes' });
    seedWorkflow({ id: 'w2', name: 'Weekly triage', purpose: 'SLACK digest', occurrenceCount: 5 });
    seedWorkflow({ id: 'w3', name: 'Unrelated', status: 'confirmed' });

    // LIKE is ASCII-case-insensitive: uppercase query hits lowercase names.
    expect(workflows.searchWorkflows({ query: 'SLACK' }).map((w) => w.id)).toEqual(['w2', 'w1']);
    // More occurrences first on equal relevance.
    expect(workflows.searchWorkflows({ query: 'release notes' }).map((w) => w.id)).toEqual(['w1']);
    // Status filter composes.
    expect(
      workflows.searchWorkflows({ query: 'slack', status: 'confirmed' }),
    ).toHaveLength(0);
    // % and _ in the query match literally (escaped).
    seedWorkflow({ id: 'w4', name: 'percent%hunt' });
    expect(workflows.searchWorkflows({ query: 'percent%' }).map((w) => w.id)).toEqual(['w4']);
    expect(workflows.searchWorkflows({ query: 'percentX' })).toHaveLength(0);
    // Limit clamp.
    expect(workflows.searchWorkflows({ limit: 2 })).toHaveLength(2);
    expect(workflows.searchWorkflows({ limit: 999 }).length).toBeLessThanOrEqual(50);
  });

  it('lists workflows filtered by status, newest first, with occurrence ledgers', () => {
    seedWorkflow({ id: 'wc', name: 'cand', lastSeenAtMs: 3_000 });
    seedWorkflow({ id: 'wk', name: 'conf', status: 'confirmed', lastSeenAtMs: 1_000 });
    expect(workflows.listByStatus().map((w) => w.id)).toEqual(['wc', 'wk']);
    expect(workflows.listByStatus({ status: 'confirmed' }).map((w) => w.id)).toEqual(['wk']);
    // M6 write side attaches (empty) occurrence ledgers to every listed row.
    expect(workflows.listByStatus()[0]?.occurrences).toEqual([]);
  });
});
