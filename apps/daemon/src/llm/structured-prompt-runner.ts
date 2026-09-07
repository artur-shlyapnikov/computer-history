import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import type { TSchema, Static } from '@sinclair/typebox';
import { CONSTANTS } from '../config.js';

/**
 * The transport seam behind every structured prompt (spec §3.15 semantics).
 * Production wires it to PiRuntime.completeSimpleText; tests inject scripted
 * FakeTransport instances — zero live network in the suite (contracts
 * §LLM boundary). The runner aborts the signal when its per-attempt timeout
 * fires: an abandoned attempt must stop burning tokens, or the job retry
 * ladder stacks a second concurrent inference on top of the first.
 */
export interface StructuredTransport {
  complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string>;
}

export interface StructuredRunnerOptions {
  transport: StructuredTransport;
  /** Per-attempt completion timeout; pinned default 120_000 ms. */
  timeoutMs?: number;
}

/** Raised after BOTH the initial attempt and the single repair attempt fail. */
export class StructuredValidationError extends Error {
  /** Validation errors of the first (unrepaired) response. */
  readonly initialErrors: string[];
  /** Validation errors of the repaired response. */
  readonly repairErrors: string[];
  /** Raw model outputs for diagnostics; may contain sensitive content — never log. */
  readonly responses: string[];

  constructor(initialErrors: string[], repairErrors: string[], responses: string[]) {
    super(
      `structured output failed validation after one repair attempt\n` +
        `initial: ${initialErrors.slice(0, 5).join('; ')}\n` +
        `repair: ${repairErrors.slice(0, 5).join('; ')}`,
    );
    this.name = 'StructuredValidationError';
    this.initialErrors = initialErrors;
    this.repairErrors = repairErrors;
    this.responses = responses;
  }
}

interface ParsedAttempt {
  ok: boolean;
  errors: string[];
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * StructuredPromptRunner<T> (spec §3.15): prompt → final text → extract JSON →
 * TypeBox validate → ONE repair attempt embedding the validation errors →
 * typed error.
 *
 * JSON extraction accepts a direct parse first, then a ```json fenced block.
 * Timeouts apply per attempt via a racing timer (default 120 s); transports
 * that support aborts can be wired through their own signal — the seam keeps
 * this optional by contract.
 */
export class StructuredPromptRunner {
  private readonly transport: StructuredTransport;
  private readonly timeoutMs: number;

  constructor(options: StructuredRunnerOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? CONSTANTS.promptTimeoutMs;
  }

  async run<S extends TSchema>(args: {
    schema: S;
    systemPrompt: string;
    input: unknown;
    /** Semantic checks beyond TypeBox (e.g. spec §3.14 episode invariants);
     * returned errors join schema errors and share the ONE repair attempt. */
    validate?: (value: Static<S>) => string[];
  }): Promise<Static<S>> {
    const userPrompt = buildUserPrompt(args.schema, args.input);
    const responses: string[] = [];

    // Transport-level failure (outage/timeout) propagates untouched: NOT a
    // validation case, no repair attempt — the job retry schedule owns it.
    const first = await this.completeWithTimeout(args.systemPrompt, userPrompt);
    responses.push(first);
    const firstParse = this.parseAndValidate(args.schema, first, args.validate);
    if (firstParse.ok) {
      return Value.Parse(args.schema, extractJson(first));
    }
    const initialErrors = firstParse.errors;

    // ONE repair attempt embedding the validation errors (spec §3.14).
    const repairPrompt =
      `${userPrompt}\n\n` +
      `Your previous response was invalid.\n` +
      `Previous response:\n${first}\n\n` +
      `Validation errors:\n${initialErrors.map((e) => `- ${e}`).join('\n')}\n\n` +
      `Respond again with corrected JSON only.`;
    const second = await this.completeWithTimeout(args.systemPrompt, repairPrompt);
    responses.push(second);
    const secondParse = this.parseAndValidate(args.schema, second, args.validate);
    if (secondParse.ok) {
      return Value.Parse(args.schema, extractJson(second));
    }
    throw new StructuredValidationError(initialErrors, secondParse.errors, responses);
  }
  private completeWithTimeout(systemPrompt: string, userPrompt: string): Promise<string> {
    // Aborting on timeout is the point: without it the abandoned attempt keeps
    // streaming tokens while the job retry ladder stacks a second concurrent
    // inference on top (double cost on every slow attempt).
    const controller = new AbortController();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`structured prompt timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.transport
        .complete(systemPrompt, userPrompt, controller.signal)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }
  private parseAndValidate<S extends TSchema>(
    schema: S,
    text: string,
    validate?: (value: Static<S>) => string[],
  ): ParsedAttempt {
    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    const compiled = TypeCompiler.Compile(schema);
    if (!compiled.Check(raw)) {
      return {
        ok: false,
        errors: [...Value.Errors(schema as never, raw)].map(
          (e: { path?: string; message?: string }) =>
            `${e.path || '/'} ${e.message ?? 'failed validation'}`,
        ),
      };
    }
    if (validate === undefined) return { ok: true, errors: [] };
    const semanticErrors = validate(raw);
    return semanticErrors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: semanticErrors };
  }
}

/** Direct JSON parse first; then the first fenced ```json block. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through to fence extraction
  }
  const match = FENCED_JSON.exec(text);
  if (match !== null && match[1] !== undefined) {
    return JSON.parse(match[1].trim());
  }
  throw new Error('response contains no parsable JSON');
}

function buildUserPrompt(schema: TSchema, input: unknown): string {
  return [
    'You must answer with a single JSON value matching exactly this JSON Schema:',
    JSON.stringify(schema),
    '',
    'Input data:',
    typeof input === 'string' ? input : JSON.stringify(input),
    '',
    'Respond with ONLY the JSON value — no prose, no code fences.',
  ].join('\n');
}
