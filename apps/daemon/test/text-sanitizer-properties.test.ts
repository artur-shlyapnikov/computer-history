import { describe, expect, it } from 'vitest';

import { replaceWellFormedTarget } from '../src/util/text.js';

/**
 * Property-based tests for `replaceWellFormedTarget` (round-11 spec §2.3).
 * No dependency: seeded mulberry32 PRNG, fixed seed ⇒ bit-reproducible.
 * On failure the message embeds trial index + JSON.stringify(input) (with
 * escapes) so rerunning the file reproduces the exact input — no shrinking.
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

const SEED = 0xa11ce001;

/** Pair-aware scan: true iff every surrogate is half of a well-formed pair. */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * TextEncoder replaces unpaired surrogates with U+FFFD when encoding — a
 * strict encode→decode round-trip reproduces its input exactly iff the input
 * was well-formed. Independent second witness besides the code-unit scan.
 */
function survivesTextEncoderRoundTrip(s: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(s)) === s;
}

/** Boundary-weighted soup generator (spec §2.3): 0–40 UTF-16 code units. */
const ALPHABET: readonly string[] = ['\uD7FF', '\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uE000', 'A', '中'];

function genSoup(rng: () => number): string {
  const len = Math.floor(rng() * 41);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const r = rng();
    if (r < 0.5) {
      out += ALPHABET[Math.floor(rng() * ALPHABET.length)] ?? '';
    } else if (r < 0.75) {
      out += String.fromCharCode(0xd800 + Math.floor(rng() * 0x800));
    } else {
      // Whole astral char: a valid high/low surrogate pair.
      out += String.fromCodePoint(0x10000 + Math.floor(rng() * 0x10000));
    }
  }
  return out;
}

/** JSON.stringify with non-ASCII escaped so lone surrogates print readably. */
function show(s: string): string {
  return JSON.stringify(s, (_key, value: unknown) =>
    typeof value === 'string'
      ? value.replace(/[\uD800-\uDFFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      : value,
  );
}

describe('replaceWellFormedTarget properties', () => {
  it('always produces well-formed UTF-16 output (TextEncoder round-trip witness)', () => {
    const rng = mulberry32(SEED ^ 1);
    for (let trial = 0; trial < 500; trial += 1) {
      const s = genSoup(rng);
      const f = replaceWellFormedTarget(s);
      expect(
        isWellFormedUtf16(f),
        `trial ${trial}: output not well-formed for input ${show(s)}`,
      ).toBe(true);
      expect(
        survivesTextEncoderRoundTrip(f),
        `trial ${trial}: output fails TextEncoder round-trip for input ${show(s)}`,
      ).toBe(true);
    }
  });

  it('is idempotent: f(f(s)) === f(s)', () => {
    const rng = mulberry32(SEED ^ 2);
    for (let trial = 0; trial < 500; trial += 1) {
      const s = genSoup(rng);
      const once = replaceWellFormedTarget(s);
      expect(replaceWellFormedTarget(once), `trial ${trial}: not idempotent on ${show(s)}`).toBe(
        once,
      );
    }
  });

  it('fixed-point biconditional: f(s) === s ⟺ s is well-formed UTF-16', () => {
    const rng = mulberry32(SEED ^ 3);
    for (let trial = 0; trial < 500; trial += 1) {
      const s = genSoup(rng);
      const unchanged = Object.is(replaceWellFormedTarget(s), s);
      const wellFormed = isWellFormedUtf16(s);
      expect(
        unchanged === wellFormed,
        `trial ${trial}: biconditional violated for ${show(s)} ` +
          `(unchanged=${String(unchanged)}, wellFormed=${String(wellFormed)})`,
      ).toBe(true);
    }
    // Boundary pair-straddlers the existing suites never exercise (§2.3).
    expect(isWellFormedUtf16('\uDBFF\uDC00')).toBe(true); // valid U+7FC00
    expect(Object.is(replaceWellFormedTarget('\uDBFF\uDC00'), '\uDBFF\uDC00')).toBe(true);
  });

  it('returns the identical reference on clean input (allocation-free hot path)', () => {
    const rng = mulberry32(SEED ^ 4);
    for (let trial = 0; trial < 500; trial += 1) {
      const s = genSoup(rng);
      if (!isWellFormedUtf16(s)) continue;
      expect(
        Object.is(replaceWellFormedTarget(s), s),
        `trial ${trial}: clean input not identity-returned: ${show(s)}`,
      ).toBe(true);
    }
  });

  it('never grows the string: f(s).length <= s.length', () => {
    const rng = mulberry32(SEED ^ 5);
    for (let trial = 0; trial < 500; trial += 1) {
      const s = genSoup(rng);
      const out = replaceWellFormedTarget(s);
      expect(out.length, `trial ${trial}: length grew for ${show(s)}`).toBeLessThanOrEqual(
        s.length,
      );
    }
  });
});
