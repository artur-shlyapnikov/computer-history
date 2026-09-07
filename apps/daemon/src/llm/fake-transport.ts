import type { StructuredTransport } from './structured-prompt-runner.js';

/**
 * Scripted transport for tests (contracts §LLM boundary: zero live network in
 * the suite). Responses are consumed in order — one per complete() call, so a
 * test scripts [malformed, valid] to exercise exactly one repair attempt.
 * Every received prompt is recorded for repair-content assertions.
 */
export class FakeTransport implements StructuredTransport {
  private readonly responses: string[];
  readonly prompts: Array<{ systemPrompt: string; userPrompt: string; signal?: AbortSignal }> = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    this.prompts.push({ systemPrompt, userPrompt, signal });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('FakeTransport scripted responses exhausted');
    }
    return next;
  }
}

/** Transport that always fails the way an LLM outage does (spec §3.24 path). */
export class FailingTransport implements StructuredTransport {
  constructor(private readonly error: Error) {}

  async complete(): Promise<string> {
    throw this.error;
  }
}
