import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryKind } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import {
  consolidateGroup,
  promotionQualifies,
  runConsolidation,
  type ConsolidationGroup,
  type ConsolidationRow,
  type EvidenceObservation,
} from '../src/processing/memory-consolidator.js';

/**
 * Promotion + supersession rules (spec §3.16–§3.17), pinned constants from
 * contracts: conf ≥ 0.80; fact ≥2 episodes; preference/procedure ≥3 episodes
 * AND ≥2 distinct UTC days; supersession at EXACTLY ≥2 newer evidences;
 * manual rows immune. Pure matrix first, then a seeded end-to-end flow.
 */
describe('memory consolidator — promotion matrix (pure)', () => {
  const ev = (episodeId: string, dayMs: number): EvidenceObservation => ({
    episodeId,
    createdAtMs: dayMs,
    confidence: 0.9,
  });

  // Table: [kind, episodes given, distinct days spanned, top conf, promotes?]
  const matrix: Array<[string, number, number, number, boolean]> = [
    // fact boundaries
    ['fact', 1, 1, 0.80, false], // single action NEVER promotes
    ['fact', 2, 1, 0.79, false], // just below the confidence threshold
    ['fact', 2, 1, 0.80, true], // exactly at both thresholds
    ['fact', 2, 1, 0.99, true],
    ['fact', 3, 3, 0.80, true],
    // preference boundaries
    ['preference', 2, 2, 0.95, false], // below the episode count
    ['preference', 3, 1, 0.95, false], // enough episodes, ONE day only
    ['preference', 3, 2, 0.79, false], // just below confidence
    ['preference', 3, 2, 0.80, true], // exactly at every threshold
    ['preference', 4, 4, 0.80, true],
    // procedure mirrors preference
    ['procedure', 3, 1, 0.99, false],
    ['procedure', 3, 2, 0.80, true],
  ];

  for (const [kind, episodes, days, conf, promotes] of matrix) {
    it(`${promotes ? 'promotes' : 'keeps'} ${kind} with ${episodes} eps / ${days} days / conf ${conf}`, () => {
      const evidence: EvidenceObservation[] = [];
      for (let i = 0; i < episodes; i++) {
        evidence.push(ev(`ep-${i}`, Date.UTC(2026, 0, 1 + Math.floor(i * (days / episodes)))));
      }
      expect(promotionQualifies(kind as 'fact', evidence, conf)).toBe(promotes);
    });
  }

  it('computes distinct UTC calendar days across midnight correctly', () => {
    const sameDay = [
      ev('a', Date.UTC(2026, 0, 1, 23, 59)),
      ev('b', Date.UTC(2026, 0, 1, 0, 0)),
    ];
    const acrossMidnight = [
      ev('a', Date.UTC(2026, 0, 1, 23, 59)),
      ev('b', Date.UTC(2026, 0, 2, 0, 1)),
    ];
    expect(promotionQualifies('preference', sameDay, 0.9)).toBe(false); // 2 eps anyway < 3
    // 3 episodes over 2 UTC days ⇒ qualifies even though two are minutes apart.
    const threeAcrossTwoDays = [...sameDay, ev('c', Date.UTC(2026, 0, 2, 12))];
    expect(promotionQualifies('preference', threeAcrossTwoDays, 0.9)).toBe(true);
    void acrossMidnight;
  });
});

describe('memory consolidator — group engine (pure)', () => {
  function row(id: string, status: string, text: string, manual: number | null = null) {
    return {
      id,
      kind: 'preference',
      canonical_key: 'editor',
      text,
      confidence: 0.9,
      status,
      first_seen_at_ms: 1,
      last_seen_at_ms: 10,
      evidence_count: 2,
      created_at_ms: 1,
      updated_at_ms: 10,
      manualConfirmedAtMs: manual,
    };
  }

  function group(rows: ReturnType<typeof row>[], evidence: Map<string, EvidenceObservation[]>) {
    return { canonicalKey: 'editor', rows, evidenceByMemory: evidence } satisfies ConsolidationGroup;
  }

  it('supersedes an active value at EXACTLY 2 newer evidences and activates the challenger', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const active = row('vim-active', 'active', 'editor=vim');
    const challenger = row('nvim-cand', 'candidate', 'editor=nvim');
    const one = new Map([
      ['vim-active', [ev0(T0)]],
      ['nvim-cand', [{ episodeId: 'e1', createdAtMs: T0 + 1000, confidence: 0.5 }]],
    ]);
    // One newer observation: NOT enough — old value stays active.
    expect(consolidateGroup(group([active, challenger], one))).toEqual([]);

    const two = new Map([
      ['vim-active', [ev0(T0)]],
      [
        'nvim-cand',
        [
          { episodeId: 'e1', createdAtMs: T0 + 1000, confidence: 0.5 },
          { episodeId: 'e2', createdAtMs: T0 + 2000, confidence: 0.5 },
        ],
      ],
    ]);
    expect(consolidateGroup(group([active, challenger], two))).toEqual([
      { id: 'vim-active', toStatus: 'superseded' },
      { id: 'nvim-cand', toStatus: 'active' },
    ]);

    function ev0(at: number): EvidenceObservation {
      return { episodeId: 'e0', createdAtMs: at, confidence: 0.9 };
    }
  });

  it('never supersedes or demotes a manually confirmed row', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const manualActive = row('manual', 'active', 'editor=vim', T0);
    const challenger = row('nvim-cand', 'candidate', 'editor=nvim');
    const evidence = new Map([
      ['manual', [{ episodeId: 'e0', createdAtMs: T0 - 1, confidence: 0.9 }]],
      [
        'nvim-cand',
        [
          { episodeId: 'e1', createdAtMs: T0 + 1000, confidence: 0.9 },
          { episodeId: 'e2', createdAtMs: T0 + 2000, confidence: 0.9 },
        ],
      ],
    ]);
    expect(consolidateGroup(group([manualActive, challenger], evidence))).toEqual([]);
  });

  it('never resurrects a user-rejected row as a contradiction challenger (§3.17)', () => {
    // reject() clears manual_confirmed_at_ms, so the rejected row looks
    // "auto" — fresh evidence must still NOT flip it back to active.
    const T0 = Date.UTC(2026, 0, 1);
    const active = row('vim-active', 'active', 'editor=vim');
    const rejected = row('nvim-rejected', 'rejected', 'editor=nvim');
    const evidence = new Map([
      ['vim-active', [{ episodeId: 'e0', createdAtMs: T0, confidence: 0.9 }]],
      [
        'nvim-rejected',
        [
          { episodeId: 'e1', createdAtMs: T0 + 1000, confidence: 0.9 },
          { episodeId: 'e2', createdAtMs: T0 + 2000, confidence: 0.9 },
        ],
      ],
    ]);
    expect(consolidateGroup(group([active, rejected], evidence))).toEqual([]);
  });

  it('does not treat the same logical claim as its own contradiction', () => {
    const active = row('a', 'active', 'Editor = Vim ');
    const twin = row('b', 'candidate', 'editor=vim');
    const evidence = new Map([
      ['a', []],
      ['b', [{ episodeId: 'x', createdAtMs: 999, confidence: 0.9 }],],
    ]);
    expect(consolidateGroup(group([active, twin], evidence))).toEqual([]);
  });
});

/**
 * §3.17 promotion-vs-incumbent gate (GateM5 fix-forward): a qualifying
 * candidate under a key that already holds an ACTIVE row with different text
 * must never plain-promote — the interleaved vim/nvim ledger used to leave
 * BOTH rows active permanently because each side had only one observation
 * newer than the other's newest, so supersession never fired.
 */
describe('memory consolidator — §3.17 promotion-vs-incumbent gate', () => {
  function row(
    id: string,
    status: string,
    text: string,
    kind: MemoryKind = 'fact',
    manualConfirmedAtMs: number | null = null,
  ) {
    return {
      id,
      kind,
      canonical_key: 'editor',
      text,
      confidence: 0.95,
      status,
      first_seen_at_ms: 1,
      last_seen_at_ms: 10,
      evidence_count: 2,
      created_at_ms: 1,
      updated_at_ms: 10,
      manualConfirmedAtMs,
    };
  }

  function group(
    rows: ConsolidationRow[],
    evidenceByMemory: Map<string, EvidenceObservation[]>,
  ): ConsolidationGroup {
    return { canonicalKey: 'editor', rows, evidenceByMemory };
  }

  it('interleaved vim/nvim evidence ends with EXACTLY ONE active row (incumbent stays)', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const vim = row('vim-active', 'active', 'editor=vim');
    const nvim = row('nvim-cand', 'candidate', 'editor=nvim');
    const interleaved = new Map([
      [
        'vim-active',
        [
          { episodeId: 'e-vim-1', createdAtMs: T0, confidence: 0.95 },
          { episodeId: 'e-vim-2', createdAtMs: T0 + 2000, confidence: 0.95 },
        ],
      ],
      [
        'nvim-cand',
        [
          { episodeId: 'e-nvim-1', createdAtMs: T0 + 1000, confidence: 0.95 },
          { episodeId: 'e-nvim-2', createdAtMs: T0 + 3000, confidence: 0.95 },
        ],
      ],
    ]);
    // Both rows reach their promotion thresholds, but each side has only ONE
    // observation newer than the other side's newest (< 2): nvim must stay a
    // candidate instead of becoming a second active row.
    expect(consolidateGroup(group([vim, nvim], interleaved))).toEqual([]);
  });

  it('challenger with ≥2 newer evidences swaps via the supersession pair, not a second activation', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const vim = row('vim-active', 'active', 'editor=vim');
    const nvim = row('nvim-cand', 'candidate', 'editor=nvim');
    // nvim's whole ledger is newer than vim's newest observation.
    const newer = new Map([
      ['vim-active', [{ episodeId: 'e-vim-1', createdAtMs: T0 + 1000, confidence: 0.95 }]],
      [
        'nvim-cand',
        [
          { episodeId: 'e-nvim-1', createdAtMs: T0 + 2000, confidence: 0.95 },
          { episodeId: 'e-nvim-2', createdAtMs: T0 + 3000, confidence: 0.95 },
        ],
      ],
    ]);
    expect(consolidateGroup(group([vim, nvim], newer))).toEqual([
      { id: 'vim-active', toStatus: 'superseded' },
      { id: 'nvim-cand', toStatus: 'active' },
    ]);
  });

  it('challenger reaching thresholds but <2 newer evidences stays candidate', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const emacs = row('emacs-active', 'active', 'editor=emacs');
    const helix = row('helix-cand', 'candidate', 'editor=helix');
    // Qualifies for promotion on its own (fact, 2 episodes, conf ≥ 0.80)…
    const evidence = new Map([
      ['emacs-active', [{ episodeId: 'e-emacs-9', createdAtMs: T0 + 5000, confidence: 0.95 }]],
      [
        'helix-cand',
        [
          { episodeId: 'e-helix-1', createdAtMs: T0, confidence: 0.95 },
          { episodeId: 'e-helix-2', createdAtMs: T0 + 1000, confidence: 0.95 },
        ],
      ],
    ]);
    // …but ZERO evidences are newer than emacs' newest: no swap, no promotion.
    expect(consolidateGroup(group([emacs, helix], evidence))).toEqual([]);
  });

  it('manual-immunity preserved: a manual incumbent blocks auto-promotion even at ≥2 newer evidences', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const manualVim = row('vim-manual', 'active', 'editor=vim', 'fact', T0);
    const nvim = row('nvim-cand', 'candidate', 'editor=nvim');
    const evidence = new Map([
      ['vim-manual', [{ episodeId: 'e-vim-1', createdAtMs: T0 - 1, confidence: 0.95 }]],
      [
        'nvim-cand',
        [
          { episodeId: 'e-nvim-1', createdAtMs: T0 + 1000, confidence: 0.95 },
          { episodeId: 'e-nvim-2', createdAtMs: T0 + 2000, confidence: 0.95 },
        ],
      ],
    ]);
    expect(consolidateGroup(group([manualVim, nvim], evidence))).toEqual([]);
  });
});

/**
 * AG-01 regression: the contradiction pass must uphold the §3.17
 * single-active invariant WITHIN one consolidateGroup call — exactly one
 * challenger wins activation per pass, and pass-2 snapshots reflect
 * effective post-pass-1 status (a pass-1-demoted incumbent is not an active).
 */
describe('memory consolidator — §3.17 single-writer race in contradiction pass', () => {
  function row(
    id: string,
    status: string,
    text: string,
    kind: MemoryKind = 'preference',
  ): ConsolidationRow {
    return {
      id,
      kind,
      canonical_key: 'editor',
      text,
      confidence: 0.9,
      status,
      first_seen_at_ms: 1,
      last_seen_at_ms: 10,
      evidence_count: 2,
      created_at_ms: 1,
      updated_at_ms: 10,
      manualConfirmedAtMs: null,
    };
  }

  function group(
    rows: ConsolidationRow[],
    evidenceByMemory: Map<string, EvidenceObservation[]>,
  ): ConsolidationGroup {
    return { canonicalKey: 'editor', rows, evidenceByMemory };
  }

  const ep = (id: string, at: number): EvidenceObservation => ({
    episodeId: id,
    createdAtMs: at,
    confidence: 0.9,
  });

  it('two qualifying challengers against one active yield EXACTLY ONE activation', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const rows = [
      row('vim-active', 'active', 'editor=vim'),
      // preferences with 2 episodes each: below the §3.16 matrix (needs ≥3),
      // so the entire resolution happens in the contradiction pass.
      row('nvim-cand', 'candidate', 'editor=nvim'),
      row('helix-cand', 'candidate', 'editor=helix'),
    ];
    const evidence = new Map([
      ['vim-active', [ep('e-vim', T0 + 1000)]],
      // Both challengers hold ≥2 evidences newer than vim's newest…
      ['nvim-cand', [ep('e-nvim-1', T0 + 2000), ep('e-nvim-2', T0 + 3000)]],
      // …but helix's evidence is FRESHER than nvim's.
      ['helix-cand', [ep('e-helix-1', T0 + 4000), ep('e-helix-2', T0 + 5000)]],
    ]);
    const transitions = consolidateGroup(group(rows, evidence));
    // …yet only ONE activates, and it is the challenger with the FRESHEST
    // evidence — not merely the first in created_at ASC order (AG-01 keeps
    // exactly one activation; freshness decides which).
    expect(transitions).toEqual([
      { id: 'vim-active', toStatus: 'superseded' },
      { id: 'helix-cand', toStatus: 'active' },
    ]);
    // Replay the transitions over the input statuses: never two actives.
    const finalStatus: Record<string, string> = {
      'vim-active': 'active',
      'nvim-cand': 'candidate',
      'helix-cand': 'candidate',
    };
    for (const t of transitions) finalStatus[t.id] = t.toStatus;
    expect(Object.values(finalStatus).filter((s) => s === 'active')).toHaveLength(1);
  });

  it('a pass-1-demoted incumbent is not an active in the contradiction pass', () => {
    const T0 = Date.UTC(2026, 0, 1);
    const rows = [
      row('vim-active', 'active', 'editor=vim'),
      // fact with 2 newer episodes: qualifies → pass 1 swaps vim out…
      row('nvim-cand', 'candidate', 'editor=nvim', 'fact'),
      // …while helix is already superseded on entry.
      row('helix-sup', 'superseded', 'editor=helix'),
    ];
    const evidence = new Map([
      ['vim-active', [ep('e-vim', T0 + 1000)]],
      ['nvim-cand', [ep('e-nvim-1', T0 + 8000), ep('e-nvim-2', T0 + 9000)]],
      // Newer than vim's newest but OLDER than nvim's: must stay superseded.
      ['helix-sup', [ep('e-helix-1', T0 + 1200), ep('e-helix-2', T0 + 1300)]],
    ]);
    // The demoted vim must not be re-examined as an active: helix finds no
    // contradictable incumbent and keeps its non-active status.
    expect(consolidateGroup(group(rows, evidence))).toEqual([
      { id: 'vim-active', toStatus: 'superseded' },
      { id: 'nvim-cand', toStatus: 'active' },
    ]);
  });
});

/**
 * Seeded flow through the REAL repository (brief-m5 §D5 item 7): active pref
 * "editor=vim"; nvim claims accumulate ×1 then ×2 newer evidences.
 */
describe('memory consolidator — seeded repository flow', () => {
  let home: string;
  let db: Db;
  let repo: MemoriesRepository;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-conso-'));
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

  function seedEpisode(id: string, at: number): void {
    db.prepare(
      `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, at, at, id, at, at);
  }

  function observe(episodeId: string, key: string, text: string, at: number, conf: number): void {
    seedEpisode(episodeId, at);
    repo.upsertCandidate(
      { kind: 'preference', canonicalKey: key, text, confidence: conf },
      { episodeId, confidence: conf, observedAtMs: at },
      NOW,
    );
  }

  it('supersedes editor=vim exactly when nvim reaches 2 newer evidences; manual confirm blocks', () => {
    const T0 = Date.UTC(2026, 5, 1);
    observe('ep-vim-1', 'editor_preference', 'editor=vim', T0, 0.95);
    observe('ep-vim-2', 'editor_preference', 'editor=VIM', T0 + 3600_000, 0.95);
    const vimId =
      repo.listByKey('editor_preference').find((r) => r.text === 'editor=vim')?.id ?? '';
    // Establish the baseline: automation promoted the old value to active.
    repo.applyStatusTransitions([{ id: vimId, toStatus: 'active' }], NOW);
    // Both vim observations collapse into ONE row (same value, case-insensitive).
    expect(repo.listByKey('editor_preference').map((r) => [r.text, r.status])).toEqual([
      ['editor=vim', 'active'],
    ]);

    // ×1 newer evidence: NO change — supersession needs exactly ≥ 2.
    observe('ep-nvim-1', 'editor_preference', 'editor=nvim', T0 + 86_400_000, 0.7);
    expect(runConsolidation(repo, ['editor_preference'], NOW)).toEqual([]);
    expect(
      repo.listByKey('editor_preference').map((r) => [r.text, r.status]),
    ).toEqual([
      ['editor=vim', 'active'],
      ['editor=nvim', 'candidate'],
    ]);

    // ×2 newer evidences: EXACTLY the supersession trigger.
    observe('ep-nvim-2', 'editor_preference', 'editor=nvim', T0 + 2 * 86_400_000, 0.7);
    expect(runConsolidation(repo, ['editor_preference'], NOW)).toContain('editor_preference');
    const statuses = new Map(
      repo.listByKey('editor_preference').map((r) => [r.text, r.status] as const),
    );
    expect(statuses.get('editor=vim')).toBe('superseded');
    expect(statuses.get('editor=nvim')).toBe('active');


    // Manual confirm beats automation afterwards: the confirmed row can never
    // be auto-superseded/demoted by later consolidation passes.
    const nvimId =
      repo.listByKey('editor_preference').find((r) => r.text === 'editor=nvim')?.id ?? '';
    repo.confirm(nvimId, NOW);
    observe('ep-emacs-1', 'editor_preference', 'editor=emacs', T0 + 3 * 86_400_000, 0.99);
    observe('ep-emacs-2', 'editor_preference', 'editor=emacs', T0 + 4 * 86_400_000, 0.99);
    runConsolidation(repo, ['editor_preference'], NOW);
    const after = new Map(
      repo.listByKey('editor_preference').map((r) => [r.text, r.status] as const),
    );
    expect(after.get('editor=nvim')).toBe('active'); // still active, manual stamp intact
    expect(after.get('editor=emacs')).toBe('candidate'); // never auto-promotes past manual
  });

  it('single confirm action makes a candidate active immediately (one evidence is enough)', () => {
    observe('ep-solo', 'deploy_day', 'deploys on friday', NOW, 0.55);
    const solo = repo.listByKey('deploy_day')[0];
    if (solo === undefined) throw new Error('seed failed');
    // Automation must NOT have promoted a single-observation candidate…
    expect(solo.status).toBe('candidate');
    // …but the user's single confirm does, instantly.
    const confirmed = repo.confirm(solo.id, NOW + 1);
    expect(confirmed).toMatchObject({ status: 'active' });
    // And consolidation leaves it alone forever after.
    runConsolidation(repo, ['deploy_day'], NOW + 2);
    expect(repo.getById(solo.id)?.status).toBe('active');
  });
});
