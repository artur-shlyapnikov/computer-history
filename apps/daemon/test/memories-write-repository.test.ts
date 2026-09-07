import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';

/**
 * WRITE-side repository contracts (brief-m5 §D5 item 1): V1 upsert rule,
 * transactional FTS discipline (rowid = memory_candidates.rowid), forget /
 * purge semantics honoring manual_confirmed_at.
 */
describe('memories repository (WRITE side)', () => {
  let home: string;
  let db: Db;
  let repo: MemoriesRepository;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-writerepo-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    repo = new MemoriesRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seedEpisode(id: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, NOW - 1000, NOW, id, NOW, NOW);
  }

  function upsert(
    episodeId: string,
    overrides: Partial<{
      kind: 'fact' | 'preference' | 'procedure';
      canonicalKey: string;
      text: string;
      confidence: number;
      observedAtMs: number;
    }> = {},
  ) {
    seedEpisode(episodeId);
    return repo.upsertCandidate(
      {
        kind: overrides.kind ?? 'fact',
        canonicalKey: overrides.canonicalKey ?? 'editor',
        text: overrides.text ?? 'uses vim',
        confidence: overrides.confidence ?? 0.9,
      },
      {
        episodeId,
        confidence: overrides.confidence ?? 0.9,
        observedAtMs: overrides.observedAtMs ?? NOW - 1000,
      },
      NOW,
    );
  }

  function ftsHits(query: string): string[] {
    return (
      db
        .prepare(
          `SELECT m.id FROM memories_fts f JOIN memory_candidates m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?`,
        )
        .all(query) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  it('inserts a new candidate row + first evidence + rowid-keyed FTS mirror', () => {
    const outcome = upsert('ep1');
    const row = db.prepare('SELECT * FROM memory_candidates').get() as {
      status: string;
      evidence_count: number;
      manual_confirmed_at_ms: number | null;
    };
    expect(outcome).toMatchObject({ competing: false, evidenceAdded: true });
    expect(row.status).toBe('candidate');
    expect(row.evidence_count).toBe(1);
    expect(row.manual_confirmed_at_ms).toBeNull();

    // FTS mirror shares the candidate's rowid (M4-gate invariant).
    const ids = ftsHits('vim');
    expect(ids).toHaveLength(1);
    const [ftsRowid] =
      db.prepare('SELECT rowid FROM memories_fts LIMIT 1').all() as Array<{ rowid: number }>;
    const [candidateRowid] =
      db.prepare('SELECT rowid FROM memory_candidates LIMIT 1').all() as Array<{ rowid: number }>;
    expect(ftsRowid?.rowid).toBe(candidateRowid?.rowid);
  });

  it('accumulates evidence on the SAME-value row (case/trim-insensitive match)', () => {
    const first = upsert('ep1', { text: 'Uses Vim' });
    const second = upsert('ep2', { text: '  uses vim  ', confidence: 0.7 });
    expect(second.memoryId).toBe(first.memoryId);
    expect(second.competing).toBe(false);

    const row = db.prepare('SELECT * FROM memory_candidates').get() as {
      evidence_count: number;
      confidence: number;
      last_seen_at_ms: number;
    };
    expect(row.evidence_count).toBe(2);
    // Row confidence keeps the TOP observation; last_seen advances.
    expect(row.confidence).toBe(0.9);
    expect(row.last_seen_at_ms).toBe(NOW - 1000);

    // Unique (memory, episode) pair: re-extracting the same episode is a no-op.
    const third = repo.upsertCandidate(
      { kind: 'fact', canonicalKey: 'editor', text: 'uses vim', confidence: 0.5 },
      { episodeId: 'ep2', confidence: 0.5, observedAtMs: NOW - 1000 },
      NOW,
    );
    expect(third.evidenceAdded).toBe(false);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get() as { n: number }).n,
    ).toBe(2);
  });

  it('same text but DIFFERENT kind is not a twin — a fresh candidate is created', () => {
    // fact vs preference have different promotion matrices and must not merge.
    const first = upsert('ep1', { kind: 'fact', text: 'uses vim' });
    const second = upsert('ep2', { kind: 'preference', canonicalKey: 'editor', text: 'USES VIM' });

    expect(second.memoryId).not.toBe(first.memoryId);
    const rows = db
      .prepare('SELECT kind, evidence_count FROM memory_candidates ORDER BY created_at_ms')
      .all() as Array<{ kind: string; evidence_count: number }>;
    expect(rows).toEqual([
      { kind: 'fact', evidence_count: 1 },
      { kind: 'preference', evidence_count: 1 },
    ]);
  });

  it('a REJECTED twin never absorbs evidence — a fresh candidate appears instead', () => {
    const original = upsert('ep1', { text: 'uses vim' });
    repo.reject(original.memoryId, NOW);
    db.prepare('UPDATE memory_candidates SET updated_at_ms = ? WHERE id = ?')
      .run(NOW - 1000, original.memoryId); // pretend the rejection aged a bit

    const fresh = upsert('ep2', { text: '  uses vim  ' });
    expect(fresh.memoryId).not.toBe(original.memoryId);

    const rejectedRow = db
      .prepare('SELECT updated_at_ms FROM memory_candidates WHERE id = ?')
      .get(original.memoryId) as { updated_at_ms: number };
    // The rejection timestamp was NOT refreshed — the row can age out on schedule.
    expect(rejectedRow.updated_at_ms).toBe(NOW - 1000);

    const rows = db
      .prepare('SELECT status, evidence_count FROM memory_candidates ORDER BY created_at_ms')
      .all() as Array<{ status: string; evidence_count: number }>;
    expect(rows).toEqual([
      { status: 'rejected', evidence_count: 1 }, // untouched by the re-extraction
      { status: 'candidate', evidence_count: 1 },
    ]);
  });

  it('a fresh candidate over a REJECTED same-value twin is NOT competing — rejected rows are not twins', () => {
    const original = upsert('ep1', { text: 'uses vim' });
    repo.reject(original.memoryId, NOW);

    // Same value re-asserted by the user's own extractor: only the rejected row
    // exists under this key, so nothing LIVE was contradicted.
    const fresh = upsert('ep2', { text: '  uses vim  ' });
    expect(fresh.competing).toBe(false);
    expect(fresh.memoryId).not.toBe(original.memoryId);

    // A genuinely different value still meets a live row and stays competing.
    const challenger = upsert('ep3', { text: 'uses nvim now' });
    expect(challenger.competing).toBe(true);
  });

  it('creates a COMPETING candidate for a different value under the same key — active row never overwritten', () => {
    db.prepare(
      `UPDATE memory_candidates SET status = 'active' WHERE id = ?`,
    ).run(upsert('ep1', { text: 'uses vim' }).memoryId);
    const challenger = upsert('ep2', { text: 'uses nvim now' });

    expect(challenger.competing).toBe(true);
    expect(challenger.memoryId).not.toBe(upsert('ep1', { text: 'uses vim' }).memoryId);

    const rows = db
      .prepare('SELECT text, status FROM memory_candidates ORDER BY created_at_ms')
      .all() as Array<{ text: string; status: string }>;
    expect(rows).toEqual([
      { text: 'uses vim', status: 'active' }, // untouched
      { text: 'uses nvim now', status: 'candidate' },
    ]);
    // The new evidence belongs ONLY to the challenger.
    const vimEvidence = db
      .prepare(`SELECT COUNT(*) AS n FROM memory_evidence e JOIN memory_candidates m ON m.id = e.memory_id
                WHERE m.text = 'uses vim' AND e.episode_id = 'ep2'`)
      .get() as { n: number };
    expect(vimEvidence.n).toBe(0);
  });

  it('forget hard-deletes row + evidence + FTS mirror in one transaction', () => {
    const { memoryId } = upsert('ep1');
    upsert('ep2', { text: 'uses nvim now' });

    expect(repo.forget(memoryId)).toBe(true);
    expect(repo.getById(memoryId)).toBeNull();
    expect(repo.hasEvidenceForEpisode('ep1')).toBe(false);
    // FTS absence proven by search, not by count alone.
    expect(ftsHits('vim')).toHaveLength(0);
    expect(ftsHits('nvim')).toHaveLength(1);
    expect(repo.forget(memoryId)).toBe(false); // unknown id → false
  });

  it('purges rejected rows older than cutoff but spares manually confirmed ones', () => {
    const rejected = upsert('ep1', { text: 'old rejection' });
    db.prepare(`UPDATE memory_candidates SET status = 'rejected', updated_at_ms = ? WHERE id = ?`)
      .run(NOW - 31 * 24 * 3600_000, rejected.memoryId);

    const manual = upsert('ep2', { text: 'confirmed then rejected' });
    repo.confirm(manual.memoryId, NOW - 40 * 24 * 3600_000);
    db.prepare(`UPDATE memory_candidates SET status = 'rejected', updated_at_ms = ? WHERE id = ?`)
      .run(NOW - 31 * 24 * 3600_000, manual.memoryId);

    const purged = repo.purgeRejectedOlderThan(NOW - 30 * 24 * 3600_000);
    expect(purged).toBe(1); // only the non-manual victim
    expect(repo.getById(rejected.memoryId)).toBeNull();
    expect(ftsHits('rejection')).toHaveLength(0);
    expect(repo.getById(manual.memoryId)).not.toBeNull();
  });

  it('zero-evidence cleanup removes non-manual rows only', () => {
    const orphan = upsert('ep1'); // will lose its evidence below
    repo.confirm(orphan.memoryId, NOW); // manual orphan must survive

    const autoOrphan = upsert('ep2', { text: 'orphaned claim' });
    db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(autoOrphan.memoryId);

    const purged = repo.purgeZeroEvidence();
    expect(purged).toBe(1);
    expect(repo.getById(autoOrphan.memoryId)).toBeNull();
    expect(repo.getById(orphan.memoryId)).not.toBeNull(); // manual survivor
  });

  it('confirm activates immediately from any status and stamps manual_confirmed_at; reject clears it', () => {
    const { memoryId } = upsert('ep1');
    const confirmed = repo.confirm(memoryId, NOW);
    expect(confirmed).toMatchObject({ status: 'active' });
    const raw = db
      .prepare('SELECT manual_confirmed_at_ms FROM memory_candidates WHERE id = ?')
      .get(memoryId) as { manual_confirmed_at_ms: number };
    expect(raw.manual_confirmed_at_ms).toBe(NOW);

    const rejected = repo.reject(memoryId, NOW + 1);
    expect(rejected).toMatchObject({ status: 'rejected' });
    const afterReject = db
      .prepare('SELECT manual_confirmed_at_ms FROM memory_candidates WHERE id = ?')
      .get(memoryId) as { manual_confirmed_at_ms: number | null };
    expect(afterReject.manual_confirmed_at_ms).toBeNull();
    expect(repo.confirm('missing-id', NOW)).toBeNull();
  });
});
