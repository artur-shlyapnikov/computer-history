import path from 'node:path';
import { existsSync } from 'node:fs';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import type { LlmConfig } from '../config.js';
import type { StructuredTransport } from './structured-prompt-runner.js';

/** Thrown when no model catalog / credentials can serve a configured model id. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * The Pi SDK does not re-export its `Model` type from the package root and
 * pi-ai is only a transitive dependency, so the model shape stays a PRIVATE
 * structural alias derived from the exact method we call — never part of our
 * published contracts (library-boundary exception, not unchecked input).
 */
type PiSdkModel = Parameters<ModelRuntime['completeSimple']>[0];

/**
 * SEAM CHOICE (contracts §Pi SDK pins require picking ONE): this runtime builds
 * on `ModelRuntime.completeSimple(model, { systemPrompt, messages })` — the
 * sanctioned non-agent primitive — NOT on `createAgentSession`. Background
 * summarization is a single-shot, stateless, tool-free completion; the agent
 * loop would add session machinery and tool plumbing for zero benefit. The
 * zero-built-in-tools guarantee of spec §3.15 holds trivially: a plain Context
 * carries no tools at all.
 *
 * One ModelRuntime per process (spec §3.15: «Один shared ModelRuntime»);
 * creation is memoized so repeated job attempts reuse it. Absent credentials
 * are NOT a startup error: they surface at completion time and flow into the
 * job retry schedule (contracts §Pi SDK pins).
 */
export class PiRuntime {
  private static instance: Promise<PiRuntime> | null = null;

  private constructor(
    private readonly runtime: ModelRuntime,
    private readonly config: LlmConfig,
  ) {}

  /**
   * Process-wide singleton; concurrent callers share one creation promise.
   * A failed creation must NOT stick: the memo is cleared on rejection so the
   * next get() (e.g. the next retry-ladder attempt via PiBackgroundTransport)
   * re-attempts create() instead of instantly replaying a cached rejection.
   */
  static get(config: LlmConfig): Promise<PiRuntime> {
    if (PiRuntime.instance === null) {
      PiRuntime.instance = PiRuntime.create(config).catch((err: unknown) => {
        PiRuntime.instance = null;
        throw err;
      });
    }
    return PiRuntime.instance;
  }

  private static async create(config: LlmConfig): Promise<PiRuntime> {
    const options: Record<string, string> = {};
    if (config.agentDir !== undefined) {
      // Only point the SDK at an existing credential file; a missing auth.json
      // must not crash daemon startup.
      const authPath = path.join(config.agentDir, 'auth.json');
      if (existsSync(authPath)) options['authPath'] = authPath;
    }
    const createOptions =
      Object.keys(options).length > 0
        ? (options as unknown as Parameters<typeof ModelRuntime.create>[0])
        : undefined;
    return new PiRuntime(await ModelRuntime.create(createOptions), config);
  }

  /** Configured id → concrete SDK model, falling back per contracts pins. */
  private resolveModel(configuredId: string): PiSdkModel {
    const slash = configuredId.indexOf('/');
    const providerId = slash === -1 ? '' : configuredId.slice(0, slash);
    const modelId = slash === -1 ? configuredId : configuredId.slice(slash + 1);
    const exact = providerId !== '' ? this.runtime.getModel(providerId, modelId) : undefined;
    if (exact !== undefined) return exact;
    // Fallback chain pinned by contracts §Pi SDK pins: any model from the
    // configured provider, then any available model at all.
    const sameProvider = providerId !== '' ? this.runtime.getModels(providerId) : [];
    if (sameProvider[0] !== undefined) return sameProvider[0];
    const anyModel = this.runtime.getModels();
    if (anyModel[0] !== undefined) return anyModel[0];
    throw new LlmUnavailableError(`no LLM models available for configured id "${configuredId}"`);
  }

  getBackgroundModel(): PiSdkModel {
    return this.resolveModel(this.config.backgroundModel);
  }

  /** Underlying SDK runtime for the chat agent session factory (M4). */
  getSdkRuntime(): ModelRuntime {
    return this.runtime;
  }

  /** Provider/model pair for the chat session factory (resolved lazily). */
  resolveChat(): { providerId: string; model: PiSdkModel } {
    const model = this.getChatModel();
    return { providerId: (model as { provider: string }).provider, model };
  }

  /** Resolved background-model id (diagnostics/settings display). */
  getBackgroundModelId(): string {
    return this.getBackgroundModel().id;
  }

  getChatModel(): PiSdkModel {
    return this.resolveModel(this.config.chatModel);
  }

  /**
   * Single-shot text completion for background ('background') or future chat
   * use. Resolves with concatenated assistant text content; rejects with the
   * underlying SDK error so callers translate it into retry semantics.
   * Aborting the signal tears down the in-flight HTTP/SSE stream — a timed-out
   * caller must not leave tokens burning behind it.
   */
  async completeSimpleText(
    kind: 'chat' | 'background',
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const model = kind === 'chat' ? this.getChatModel() : this.getBackgroundModel();
    const message = await this.runtime.completeSimple(
      model,
      { systemPrompt, messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }] },
      { signal },
    );
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
    }
    return parts.join('');
  }
}

/**
 * Production StructuredTransport for background jobs: lazily resolves the
 * process-wide PiRuntime per completion, so missing credentials surface as a
 * job failure (retry schedule) instead of a daemon startup crash.
 */
export class PiBackgroundTransport implements StructuredTransport {
  constructor(private readonly config: LlmConfig) {}

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const runtime = await PiRuntime.get(this.config);
    // The timeout path rejects with a plain Error once the signal is aborted;
    // an attempt aborted while the runtime was still building must surface the
    // same way instead of completing useless setup work.
    if (signal?.aborted) throw new Error(`background completion aborted before start (signal aborted)`);
    return runtime.completeSimpleText('background', systemPrompt, userPrompt, signal);
  }
}
