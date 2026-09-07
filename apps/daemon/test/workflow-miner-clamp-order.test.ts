import { describe, expect, it } from 'vitest';

import { validateTemplate, type WorkflowTemplateLlm } from '../src/processing/workflow-miner.js';

/**
 * Issue RA8-W2-SLICE: validateTemplate must clamp BEFORE sanitizing. Slicing
 * after replaceWellFormedTarget can split a surrogate pair exactly at the
 * length boundary (e.g. 119 BMP chars + U+1F46B cut at 120), re-introducing a
 * lone surrogate that Swift's JSONDecoder rejects.
 */

const MAX_NAME_CHARS = 120;
const MAX_SENTENCE_CHARS = 300;

/** True if the string contains any unpaired (lone) surrogate code unit. */
function hasLoneSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Lone-surrogate escape check on the serialized form, as Swift would see it. */
const jsonHasLoneSurrogateEscape = (s: string): boolean =>
  /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/.test(JSON.stringify(s));

function base(fields: Partial<WorkflowTemplateLlm>): WorkflowTemplateLlm {
  return {
    name: 'ok',
    purpose: 'ok',
    preconditions: [],
    stableSteps: [],
    variableInputs: [],
    expectedOutcome: 'ok',
    ...fields,
  };
}

describe('validateTemplate clamp-before-sanitize ordering', () => {
  it('name ending exactly at the 120-unit cap keeps its astral emoji intact', () => {
    // 118 BMP chars + one astral emoji = 120 UTF-16 units; the pair starts at
    // index 118 (<= limit - 2), so clamping keeps both halves whole.
    const raw = 'a'.repeat(118) + '\u{1F46B}';
    expect(raw.length).toBe(MAX_NAME_CHARS);

    const { name } = validateTemplate(base({ name: raw }));
    expect(name.length).toBe(MAX_NAME_CHARS);
    expect(hasLoneSurrogates(name)).toBe(false);
    expect(jsonHasLoneSurrogateEscape(name)).toBe(false);
    expect([...name].at(-1)).toBe('\u{1F46B}');
  });

  it('name whose emoji straddles the 120-unit cut yields U+FFFD, not a lone surrogate', () => {
    // The original probe: 119 BMP chars put the pair across the cut. After the
    // reorder, the split half is sanitized to U+FFFD instead of surviving raw.
    const raw = 'a'.repeat(119) + '\u{1F46B}';
    const { name } = validateTemplate(base({ name: raw }));
    expect(name.length).toBe(MAX_NAME_CHARS);
    expect(hasLoneSurrogates(name)).toBe(false);
    expect(jsonHasLoneSurrogateEscape(name)).toBe(false);
    expect([...name].at(-1)).toBe('\uFFFD');
  });

  it('purpose with an in-bounds astral pair before the 300 cut is lone-surrogate-free', () => {
    const raw = 'b'.repeat(298) + '\u{1F46B}' + 'trailing';

    const { purpose } = validateTemplate(base({ purpose: raw }));
    expect(purpose.length).toBe(MAX_SENTENCE_CHARS); // pair fits fully inside
    expect(hasLoneSurrogates(purpose)).toBe(false);
    expect(jsonHasLoneSurrogateEscape(purpose)).toBe(false);
    expect(purpose.endsWith('\u{1F46B}')).toBe(true);
  });

  it('expectedOutcome pair straddling the 300 cut is replaced, never split', () => {
    const raw = 'c'.repeat(299) + '\u{1F980}' + 'tail';
    const { template } = validateTemplate(base({ expectedOutcome: raw }));

    expect(template.expectedOutcome.length).toBe(MAX_SENTENCE_CHARS);
    expect(hasLoneSurrogates(template.expectedOutcome)).toBe(false);
    expect(jsonHasLoneSurrogateEscape(template.expectedOutcome)).toBe(false);
    expect([...template.expectedOutcome].at(-1)).toBe('\uFFFD');
  });

  it('clean astral emoji already inside the bounds survives untouched', () => {
    const emoji = '\u{1F46B}';
    const name = `release ${emoji} flow`;
    const { template } = validateTemplate(base({ name }));
    expect(template.name).toBe(name);
    expect(hasLoneSurrogates(template.name)).toBe(false);
  });

  it('a pre-existing lone surrogate in the input is still sanitized', () => {
    const loneName = 'bad \uD83D name';
    const { template } = validateTemplate(base({ name: loneName }));
    expect(hasLoneSurrogates(template.name)).toBe(false);
    expect(template.name).toContain('\uFFFD');
  });
});
