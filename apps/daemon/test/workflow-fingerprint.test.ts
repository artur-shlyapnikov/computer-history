import { describe, expect, it } from 'vitest';

import {
  APP_JACCARD_POOL_MIN,
  CANDIDATE_MEDIAN_MIN,
  MAX_STEPS,
  MIN_STEPS,
  OCCURRENCE_SIMILARITY_MIN,
  episodeSimilarity,
  intentsEqual,
  jaccard,
  levenshtein,
  levenshteinSeq,
  median,
  normalizeAppBundleId,
  normalizeTargetClass,
  sequenceScore,
  stepFingerprint,
} from '../src/processing/workflow-fingerprint.js';
import { clusterAround } from '../src/processing/workflow-miner.js';
import type { EpisodeFingerprint } from '../src/processing/workflow-fingerprint.js';

/**
 * Pure mining math (brief-m6 §D6 item 5): golden fingerprint table with the
 * spec §3.20 examples verbatim, Levenshtein edges and a hand-computed
 * similarity fixture held to ±1e-9.
 */
describe('stepFingerprint golden table', () => {
  const CASES: Array<{
    name: string;
    step: { appBundleId: string; action: string; targetRole?: string | null; target?: string | null };
    expected: string;
  }> = [
    {
      // Spec §3.20 example, verbatim.
      name: 'slack create button (spec example)',
      step: { appBundleId: 'Slack', action: 'click', targetRole: 'button', target: 'Create' },
      expected: 'slack.click.button.create',
    },
    {
      // Spec §3.20 example, verbatim — dynamic ticket label reduces to nothing.
      name: 'jira textarea with ticket id (spec example)',
      step: { appBundleId: 'Jira', action: 'text_edit', targetRole: 'textarea', target: 'Fix TANGO-123' },
      expected: 'jira.text_edit.textarea',
    },
    {
      name: 'reverse-DNS bundle id collapses to its tail',
      step: { appBundleId: 'com.apple.Safari', action: 'click', target: 'Reload' },
      expected: 'safari.click.reload',
    },
    {
      name: 'uuid label strips to nothing',
      step: {
        appBundleId: 'com.apple.finder',
        action: 'click',
        targetRole: 'cell',
        target: '3F2B8A4C-1E5D-4F6A-9B7C-2D3E4F5A6B7C',
      },
      expected: 'finder.click.cell',
    },
    {
      // Contracts §workflow semantics: the pinned shape is [A-Z]+-[0-9]+ —
      // a SINGLE-letter prefix (B-2) is a ticket id too, not a class word.
      name: 'single-letter ticket prefix strips to nothing',
      step: { appBundleId: 'app', action: 'click', targetRole: 'button', target: 'Fix B-2' },
      expected: 'app.click.button',
    },
    {
      name: 'pure-digit label strips to nothing',
      step: { appBundleId: 'app', action: 'click', targetRole: 'row', target: '12345' },
      expected: 'app.click.row',
    },
    {
      name: 'identifier path keeps only the last class word minus digits',
      step: { appBundleId: 'app', action: 'click', target: 'sidebar/item-42' },
      expected: 'app.click.item',
    },
    {
      name: 'quotes are stripped before tokenizing',
      step: { appBundleId: 'app', action: 'click', targetRole: 'button', target: '"Create"' },
      expected: 'app.click.button.create',
    },
    {
      name: 'missing role and target degrade gracefully',
      step: { appBundleId: 'App.X', action: 'SCROLL' },
      expected: 'x.scroll',
    },
    {
      name: 'lowercasing applies to every segment',
      step: { appBundleId: 'JIRA.CLOUD', action: 'Text_Edit', targetRole: 'TextArea', target: 'Summary' },
      expected: 'cloud.text_edit.textarea.summary',
    },
  ];

  for (const c of CASES) {
    it(`maps ${c.name} → ${c.expected}`, () => {
      expect(stepFingerprint(c.step)).toBe(c.expected);
    });
  }

  it('normalizes bundle ids and target classes directly', () => {
    expect(normalizeAppBundleId('com.tinyspeck.slackmacgap')).toBe('slackmacgap');
    expect(normalizeAppBundleId('Slack')).toBe('slack');
    expect(normalizeTargetClass('Fix TANGO-123')).toBe('');
    expect(normalizeTargetClass('Release 2.1')).toBe('');
    expect(normalizeTargetClass('Settings / General')).toBe('general');
    expect(normalizeTargetClass('   ')).toBe('');
  });
});

describe('levenshtein edges', () => {
  it('handles empty, equal and disjoint inputs', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'abcd')).toBe(4);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('abc', 'xyz')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshteinSeq([], ['a'])).toBe(1);
    expect(levenshteinSeq(['a', 'b'], ['a', 'b'])).toBe(0);
    // Substitution costs 1 at list level too.
    expect(levenshteinSeq(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
  });

  it('sequenceScore normalizes by max length and treats two empties as identical', () => {
    expect(sequenceScore([], [])).toBe(1);
    expect(sequenceScore(['a'], ['a', 'b', 'c', 'd'])).toBe(1 - 3 / 4);
  });

  it('jaccard handles disjoint, overlapping and both-empty sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']))).toBe(0.5);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('intent equality requires non-empty identical normalized keys', () => {
    expect(intentsEqual('File a Bug!', 'file a bug')).toBe(true);
    expect(intentsEqual(null, null)).toBe(false); // unknown earns no bonus
    expect(intentsEqual('research', 'triage')).toBe(false);
  });
});

describe('similarity math (hand-computed fixture)', () => {
  const fp = (signatures: string[], apps: string[], intentKey: string): EpisodeFingerprint => ({
    signatures,
    apps: new Set(apps),
    intentKey,
  });
  it('reproduces 0.6·seq + 0.25·app + 0.15·intent to ±1e-9', () => {
    // Sequence lists ['x','y'] vs ['x','z']: distance 1 of maxLen 2 ⇒ seq 0.5.
    // J({a,b,c},{a,b,d}) = 0.5. Intents equal ⇒ 1.
    const a = fp(['x', 'y'], ['a', 'b', 'c'], 'ship');
    const b = fp(['x', 'z'], ['a', 'b', 'd'], 'ship');
    const expected = 0.6 * 0.5 + 0.25 * 0.5 + 0.15 * 1;
    expect(Math.abs(episodeSimilarity(a, b) - expected)).toBeLessThan(1e-9);
    expect(episodeSimilarity(a, b)).toBeCloseTo(0.575, 9);
  });

  it('identical episodes score exactly 1', () => {
    const a = fp(['s.click.create', 'j.edit.textarea'], ['s', 'j'], 'file bug');
    const twin: EpisodeFingerprint = {
      signatures: [...a.signatures],
      apps: new Set(a.apps),
      intentKey: a.intentKey,
    };
    expect(episodeSimilarity(a, twin)).toBe(1);
  });

  it('pins the threshold constants from contracts', () => {
    expect(OCCURRENCE_SIMILARITY_MIN).toBe(0.74);
    expect(CANDIDATE_MEDIAN_MIN).toBe(0.78);
    expect(APP_JACCARD_POOL_MIN).toBe(0.5);
    expect(MIN_STEPS).toBe(3);
    expect(MAX_STEPS).toBe(40);
  });
});

describe('clustering boundary decisions', () => {
  const fp = (signatures: string[], apps: string[], intentKey: string): EpisodeFingerprint => ({
    signatures,
    apps: new Set(apps),
    intentKey,
  });
  const entry = (id: string, fingerprint: EpisodeFingerprint) => ({
    id,
    startedAtMs: 0,
    intent: fingerprint.intentKey,
    title: id,
    summary: '',
    fingerprint,
  });

  it('admits a pair whose similarity computes to exactly ≥0.74 (float-safe above)', () => {
    // seq = 1 − 1/10 (one substituted signature of ten), J = 1/5, intent equal:
    // sim = 0.54 + 0.05 + 0.15 = 0.74 (IEEE-754 lands just ABOVE the gate).
    const base = fp(
      Array.from({ length: 10 }, (_, i) => `sig${i}`),
      ['shared', 'one', 'two'],
      'same',
    );
    const twinApps = fp(
      Array.from({ length: 10 }, (_, i) => (i === 0 ? 'zzz' : `sig${i}`)),
      ['shared', 'three', 'four'],
      'same',
    );
    const similarity = episodeSimilarity(base, twinApps);
    expect(similarity).toBeGreaterThanOrEqual(OCCURRENCE_SIMILARITY_MIN);
    const cluster = clusterAround(entry('seed', base), [entry('twin', twinApps)]);
    expect(cluster.memberIds).toEqual(['seed', 'twin']);
  });

  it('rejects the same construction without the intent bonus (well below 0.74)', () => {
    const base = fp(
      Array.from({ length: 10 }, (_, i) => `sig${i}`),
      ['shared', 'one', 'two'],
      'same',
    );
    const other = fp(
      Array.from({ length: 10 }, (_, i) => (i === 0 ? 'zzz' : `sig${i}`)),
      ['shared', 'three', 'four'],
      'different',
    );
    expect(episodeSimilarity(base, other)).toBeLessThan(OCCURRENCE_SIMILARITY_MIN);
    expect(clusterAround(entry('seed', base), [entry('other', other)]).memberIds).toEqual(['seed']);
  });

  it('excludes a pair just below the bar: 0.54 + 0.25·(1/6) + 0.15 ≈ 0.7317 < 0.74', () => {
    // Same single-substitution sequence score (0.9) as the admitted pair, but
    // a thinner app overlap (J = 1/6) drops the total under the membership
    // bar — the ≥0.74 gate is exclusive on the low side (brief-m6 item 5).
    const base = fp(
      Array.from({ length: 10 }, (_, i) => `sig${i}`),
      ['a', 'b', 'c'],
      'same',
    );
    const near = fp(
      Array.from({ length: 10 }, (_, i) => (i === 0 ? 'zzz' : `sig${i}`)),
      ['a', 'd', 'e', 'f'],
      'same',
    );
    const similarity = episodeSimilarity(base, near);
    expect(similarity).toBeCloseTo(0.6 * 0.9 + 0.25 * (1 / 6) + 0.15, 12);
    expect(similarity).toBeLessThan(OCCURRENCE_SIMILARITY_MIN);
    expect(similarity).toBeGreaterThan(0.7); // genuinely NEAR the boundary
    expect(clusterAround(entry('seed', base), [entry('near', near)]).memberIds).toEqual(['seed']);
  });

  it('median gate: 0.7799 fails, 0.78 passes (>= semantics pinned by contracts)', () => {
    expect(median([0.74, 0.7799, 0.9])).toBe(0.7799);
    expect(median([0.74, 0.7799, 0.9]) >= CANDIDATE_MEDIAN_MIN).toBe(false);
    expect(median([0.74, 0.78, 0.9])).toBe(0.78);
    expect(median([0.74, 0.78, 0.9]) >= CANDIDATE_MEDIAN_MIN).toBe(true);
  });

  it('median handles even counts and empty input deterministically', () => {
    expect(median([0.9, 0.7])).toBe(0.8);
    expect(median([])).toBe(0);
  });

  it('records each qualifying admission similarity, never below 0.74', () => {
    // S = 12-signature base. B substitutes 4 ⇒ sim(S,B)=0.8; C shares B's 4
    // substitutions and adds 2 more ⇒ sim(B,C)=0.9 but sim(S,C)=0.7 < 0.74.
    // C joins THROUGH B, so its stored occurrence similarity must be the
    // qualifying 0.9 — never the below-bar 0.7 measured against the seed.
    const base = Array.from({ length: 12 }, (_, i) => `sig${i}`);
    const sub = (positions: number[], tag: string): string[] =>
      base.map((s, i) => (positions.includes(i) ? `${tag}${s}` : s));
    const fpS = fp(base, ['a'], 'same');
    const fpB = fp(sub([0, 1, 2, 3], 'b'), ['a'], 'same');
    const fpC = fp(sub([0, 1, 2, 3, 4, 5], 'b'), ['a'], 'same');
    expect(episodeSimilarity(fpS, fpB)).toBeCloseTo(0.8, 12);
    expect(episodeSimilarity(fpS, fpC)).toBeCloseTo(0.7, 12); // below the bar
    expect(episodeSimilarity(fpB, fpC)).toBeCloseTo(0.9, 12);

    const cluster = clusterAround(entry('S', fpS), [entry('B', fpB), entry('C', fpC)]);
    expect(cluster.memberIds.sort()).toEqual(['B', 'C', 'S']);
    expect(cluster.occurrenceSimilarity.get('B')).toBeCloseTo(0.8, 12);
    expect(cluster.occurrenceSimilarity.get('C')).toBeCloseTo(0.9, 12); // NOT 0.7
    for (const similarity of cluster.occurrenceSimilarity.values()) {
      expect(similarity).toBeGreaterThanOrEqual(OCCURRENCE_SIMILARITY_MIN);
    }
    // 0.78 gate quantity = median over the occurrence similarities (spec §3.20).
    expect(cluster.medianSimilarity).toBeCloseTo(median([1, 0.8, 0.9]), 12);
  });
});
