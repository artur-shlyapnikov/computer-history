import { describe, expect, it } from 'vitest';

import {
  jaccard,
  levenshtein,
  levenshteinSeq,
  median,
  sequenceScore,
} from '../src/processing/workflow-fingerprint.js';

/**
 * Property-based tests for the fingerprint metric layer (round-11 spec §2.5).
 * Seeded mulberry32 PRNG, fixed seed ⇒ bit-reproducible; no shrinking (the
 * failing input is embedded in each assertion message).
 */

/** Inline mulberry32 (spec §2.2). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xb0bfe001;

const STRING_ALPHABET = 'ab';
const LIST_ALPHABET = ['a', 'b', 'c'];
const SET_ALPHABET = ['a', 'b', 'c', 'd', 'e'];

function genString(rng: () => number): string {
  const len = Math.floor(rng() * 25);
  let out = '';
  for (let i = 0; i < len; i += 1) out += STRING_ALPHABET[Math.floor(rng() * STRING_ALPHABET.length)];
  return out;
}

function genList(rng: () => number): string[] {
  const len = Math.floor(rng() * 21);
  const out: string[] = [];
  for (let i = 0; i < len; i += 1) out.push(LIST_ALPHABET[Math.floor(rng() * LIST_ALPHABET.length)] ?? 'a');
  return out;
}

/** Fisher–Yates with the seeded rng: permutation-invariance witness. */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] ?? out[j];
    const b = out[j];
    if (b !== undefined) out[i] = b;
    if (a !== undefined) out[j] = a;
  }
  return out;
}

describe('fingerprint metric properties', () => {
  it('string Levenshtein is symmetric', () => {
    const rng = mulberry32(SEED ^ 1);
    for (let trial = 0; trial < 300; trial += 1) {
      const a = genString(rng);
      const b = genString(rng);
      expect(levenshtein(a, b), `trial ${trial}: lev(${JSON.stringify(a)}, ${JSON.stringify(b)}) asymmetric`).toBe(
        levenshtein(b, a),
      );
    }
  });

  it('list Levenshtein over signature lists is symmetric', () => {
    const rng = mulberry32(SEED ^ 2);
    for (let trial = 0; trial < 300; trial += 1) {
      const x = genList(rng);
      const y = genList(rng);
      expect(levenshteinSeq(x, y), `trial ${trial}: seq asymmetry ${JSON.stringify([x, y])}`).toBe(
        levenshteinSeq(y, x),
      );
    }
  });

  it('identity gives distance zero and distances respect length bounds (both variants)', () => {
    const rng = mulberry32(SEED ^ 3);
    for (let trial = 0; trial < 300; trial += 1) {
      const s = genString(rng);
      const l = genList(rng);
      expect(levenshtein(s, s)).toBe(0);
      expect(levenshteinSeq(l, l)).toBe(0);

      const t = genString(rng);
      const m = genList(rng);
      const lowerS = Math.abs(s.length - t.length);
      const upperS = Math.max(s.length, t.length);
      const dS = levenshtein(s, t);
      expect(dS >= lowerS && dS <= upperS, `trial ${trial}: string bounds violated ${JSON.stringify([s, t])}`).toBe(true);
      const lowerL = Math.abs(l.length - m.length);
      const upperL = Math.max(l.length, m.length);
      const dL = levenshteinSeq(l, m);
      expect(dL >= lowerL && dL <= upperL, `trial ${trial}: list bounds violated ${JSON.stringify([l, m])}`).toBe(true);
    }
  });

  it('sequenceScore/jaccard obey range + identity laws and are permutation invariant; median lies in range', () => {
    const rng = mulberry32(SEED ^ 4);
    for (let trial = 0; trial < 300; trial += 1) {
      const x = genList(rng);
      const y = genList(rng);
      const sx = sequenceScore(x, y);
      expect(sx >= 0 && sx <= 1, `trial ${trial}: sequenceScore out of range ${sx}`).toBe(true);
      expect(sequenceScore(x, x)).toBe(1);

      const setA = new Set(shuffled(SET_ALPHABET.slice(0, Math.floor(rng() * 6)), rng));
      const setB = new Set(shuffled(SET_ALPHABET.slice(0, Math.floor(rng() * 6)), rng));
      const j = jaccard(setA, setB);
      expect(j >= 0 && j <= 1, `trial ${trial}: jaccard out of range ${j}`).toBe(true);
      expect(jaccard(setA, setA)).toBe(1);
      // Order-of-insertion invariance.
      expect(jaccard(new Set(shuffled([...setA], rng)), setB)).toBe(jaccard(setA, setB));

      // Median within [min, max], permutation-invariant, odd and even lengths.
      const values: number[] = [];
      const count = 1 + Math.floor(rng() * 10); // odd and even lengths both hit
      for (let i = 0; i < count; i += 1) values.push(Math.floor(rng() * 100));
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const m = median(values);
      expect(m >= lo && m <= hi, `trial ${trial}: median ${m} outside [${lo}, ${hi}]`).toBe(true);
      expect(median(shuffled(values, rng))).toBe(m);
    }
  });
});
