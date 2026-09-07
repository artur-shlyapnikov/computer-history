import { describe, expect, it } from 'vitest';

import { Type } from '@sinclair/typebox';

import { extractJson } from '../src/llm/structured-prompt-runner.js';
import {
  StructuredPromptRunner,
  StructuredValidationError,
  type StructuredTransport,
} from '../src/llm/structured-prompt-runner.js';

/**
 * extractJson partition table (the parser behind EVERY model response) plus
 * the two failure classes of the repair attempt: timeout and transport
 * rejection. Timeout races use real timers with a never-settling transport
 * and a tiny timeoutMs — no fake timers needed.
 */

const Schema = Type.Object({ n: Type.Integer() });

describe('extractJson partition table', () => {
  it('parses a bare JSON object directly', () => {
    expect(extractJson('{"n":1}')).toEqual({ n: 1 });
  });

  it('extracts a ```json fenced block', () => {
    expect(extractJson('Sure:\n```json\n{"n":2}\n```\ndone')).toEqual({ n: 2 });
  });

  it('extracts a fence WITHOUT a language tag (pins the (?:json)? branch)', () => {
    expect(extractJson('```\n{"n":3}\n```')).toEqual({ n: 3 });
  });

  it('the FIRST fenced block wins over later fences and prose decoys', () => {
    const text = [
      'decoy {"n":99} in prose',
      '```json\n{"n":1}\n```',
      'middle',
      '```json\n{"n":2}\n```',
    ].join('\n');
    expect(extractJson(text)).toEqual({ n: 1 });
  });

  it('propagates the inner JSON.parse error for invalid fence content', () => {
    expect(() => extractJson('```json\n{nope}\n```')).toThrow(Error);
  });

  it('throws the typed no-JSON error for whitespace-only input and plain prose', () => {
    expect(() => extractJson('   \n\t  ')).toThrow('response contains no parsable JSON');
    expect(() => extractJson('no json here at all')).toThrow('response contains no parsable JSON');
  });

  it('parses a top-level JSON array (validation is the caller\'s concern)', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });
});

/** Transport whose complete() never settles — loses every tiny-timeout race. */
const neverSettling: StructuredTransport = {
  complete: () => new Promise<string>(() => {}),
};

describe('runner repair-attempt failure classes', () => {
  it('a timeout DURING repair surfaces as a transport-level Error, not a validation outcome', async () => {
    let calls = 0;
    const transport: StructuredTransport = {
      complete: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve('nope') : neverSettling.complete('s', 'u');
      },
    };
    const runner = new StructuredPromptRunner({ transport, timeoutMs: 20 });
    const err = await runner.run({ schema: Schema, systemPrompt: 's', input: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StructuredValidationError);
    expect((err as Error).message).toContain('structured prompt timed out');
    expect(calls).toBe(2); // initial + repair both attempted
  });

  it('a transport rejection during repair propagates untouched after exactly 2 prompts', async () => {
    let calls = 0;
    const boom = new Error('ERR');
    const transport: StructuredTransport = {
      complete: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve('still not json');
        return Promise.reject(boom);
      },
    };
    const runner = new StructuredPromptRunner({ transport, timeoutMs: 1000 });
    await expect(runner.run({ schema: Schema, systemPrompt: 's', input: {} })).rejects.toBe(boom);
    expect(calls).toBe(2);
  });
});
