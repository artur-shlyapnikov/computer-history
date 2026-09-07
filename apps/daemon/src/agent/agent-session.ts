import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { LlmUnavailableError } from '../llm/pi-runtime.js';
import { CONSTANTS } from '../config.js';

/**
 * Chat agent session layer (spec §3.19, brief-m4 §D4 item 5). Chat sessions
 * are INDEPENDENT from the background job serialization: they never touch
 * JobWorker; each sessionId owns one Pi session and concurrent chat sessions
 * run concurrently.
 *
 * SEAM (contracts §LLM boundary — no live LLM in tests): everything above the
 * factory talks to the structural `ChatTransportSession` interface. Production
 * wires `createPiChatSessionFactory` (real SDK); tests inject scripted fakes.
 */

/** Structural subset of Pi session events consumed for delta relay. */
export interface ChatStreamEvent {
  type: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
}

export interface ChatTransportSession {
  subscribe(listener: (event: ChatStreamEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose?(): void;
}

export type ChatSessionFactory = () => Promise<ChatTransportSession>;

export interface ChatSendInput {
  sessionId: string;
  text: string;
  signal?: AbortSignal;
}

export type ChatErrorCode = 'llm_unavailable' | 'aborted' | 'internal' | 'busy';

/** Default cap on concurrent in-flight prompts across ALL sessions. */
export const CHAT_MAX_ACTIVE_RUNS = 8;
/** Default hard cap on live sessions in the map (LRU-evicted beyond this). */
export const CHAT_MAX_SESSIONS = 64;

/** Typed failure of a chat run; code is pinned by the wire contract. */
export class ChatRunError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface SessionEntry {
  session: ChatTransportSession;
  lastUsedMs: number;
  /** A prompt() is in flight; idle GC must not dispose this entry. */
  busy: boolean;
}

export interface ChatSessionManagerOptions {
  sessionFactory: ChatSessionFactory;
  /** Grounding preamble delivered with the first prompt of every new session. */
  systemPrompt: string;
  /** Idle age at which an unused session is disposed (pinned default 10 min). */
  idleGcMs?: number;
  gcSweepIntervalMs?: number;
  now?: () => number;
  /**
   * Max concurrent in-flight prompts across ALL sessions; excess sends are
   * rejected with a typed 'busy' error (default CHAT_MAX_ACTIVE_RUNS).
   */
  maxActiveRuns?: number;
  /**
   * Hard cap on live sessions: admitting a new sessionId disposes the
   * least-recently-used IDLE sessions first; when every session is busy,
   * admission fails with 'busy'. Busy entries are never evicted
   * (default CHAT_MAX_SESSIONS).
   */
  maxSessions?: number;
}

export class ChatSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  /** True once a sessionId has already received the grounding preamble. */
  private readonly groundedSessions = new Map<string, true>();
  /** Session creations currently in flight, keyed by sessionId (AG-04). */
  private readonly creating = new Map<string, Promise<SessionEntry>>();
  private readonly gcTimer: NodeJS.Timeout | undefined;
  private readonly idleGcMs: number;
  private readonly maxActiveRuns: number;
  private readonly maxSessions: number;
  /** Prompts currently in flight across all sessions (bounded by maxActiveRuns). */
  private running = 0;

  constructor(private readonly options: ChatSessionManagerOptions) {
    this.idleGcMs = options.idleGcMs ?? CONSTANTS.chatIdleGcMs;
    this.maxActiveRuns = Math.max(1, options.maxActiveRuns ?? CHAT_MAX_ACTIVE_RUNS);
    this.maxSessions = Math.max(1, options.maxSessions ?? CHAT_MAX_SESSIONS);
    const sweepMs = options.gcSweepIntervalMs ?? CONSTANTS.chatGcSweepIntervalMs;
    this.gcTimer =
      sweepMs > 0 ? setInterval(() => this.sweepIdle(), sweepMs) : undefined;
    this.gcTimer?.unref?.();
  }

  /**
   * Runs one user turn on the session, relaying assistant deltas exactly once
   * each: every message_update snapshot is diffed against the previous
   * snapshot and only the grown suffix is emitted.
   */
  async send(input: ChatSendInput, onDelta: (delta: string) => void): Promise<string> {
    const entry = await this.acquire(input.sessionId);
    if (entry.busy) {
      // M5-gate inheritance: a second concurrent send on the SAME session is
      // rejected with a typed error instead of interleaving two prompts in
      // one Pi session (deltas would interleave and cancel would be ambiguous).
      throw new ChatRunError(
        'busy',
        `session ${input.sessionId} already has a run in flight`,
      );
    }
    if (this.running >= this.maxActiveRuns) {
      throw new ChatRunError(
        'busy',
        `chat run limit reached (${this.running}/${this.maxActiveRuns} active)`,
      );
    }
    entry.busy = true;
    this.running += 1;
    let unsubscribe: (() => void) | undefined;
    const signal = input.signal;
    const onAbort = (): void => {
      void entry.session.abort();
    };
    try {
      // Snapshot-diff state lives per run; a fresh run starts a new turn.
      let snapshot = '';
      unsubscribe = entry.session.subscribe((event) => {
        if (event.type === 'message_start') {
          // A run with tool calls emits several assistant messages; each one
          // starts a fresh growth history. Without this reset the first
          // update of a post-tool message — typically shorter than the
          // accumulated snapshot — would be swallowed as a "rewind" and the
          // client would silently lose the rest of the answer.
          if (event.message?.role === 'assistant') snapshot = '';
          return;
        }
        if (event.type !== 'message_update') return;
        if (event.message?.role !== 'assistant') return;
        const text = assistantText(event.message.content);
        if (!text.startsWith(snapshot)) {
          // Replacement instead of growth (should not happen mid-message):
          // emit nothing rather than corrupt the stream with a rewind.
          snapshot = text;
          return;
        }
        const delta = text.slice(snapshot.length);
        snapshot = text;
        if (delta.length > 0) onDelta(delta);
      });
      if (signal !== undefined) {
        if (signal.aborted) {
          // Already-cancelled input: fail fast instead of running a full LLM
          // turn the client will never see (Pi's abort() is a no-op when idle).
          throw new ChatRunError(
            'aborted',
            `session ${input.sessionId} run cancelled before start`,
          );
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const grounded = this.groundedSessions.get(input.sessionId) === true;
      const promptText = grounded
        ? input.text
        : `${this.options.systemPrompt}\n\n---\n\n${input.text}`;
      await entry.session.prompt(promptText);
      // Grounding is committed only after the turn actually succeeded; a
      // failed first turn must re-send the preamble on its retry.
      this.groundedSessions.set(input.sessionId, true);
      return input.sessionId;
    } catch (err) {
      throw classifyChatError(err, signal?.aborted === true);
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      entry.busy = false;
      entry.lastUsedMs = this.now();
      this.running -= 1;
    }
  }

  /** Aborts the in-flight prompt of one session, if any. */
  abort(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (entry === undefined || !entry.busy) return false;
    void entry.session.abort();
    return true;
  }

  /** Number of live sessions (diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }

  async dispose(): Promise<void> {
    clearInterval(this.gcTimer);
    for (const entry of this.entries.values()) entry.session.dispose?.();
    this.entries.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async acquire(sessionId: string): Promise<SessionEntry> {
    const existing = this.entries.get(sessionId);
    if (existing !== undefined) {
      existing.lastUsedMs = this.now();
      return existing;
    }
    // Serialize creation per sessionId: two concurrent first sends must share
    // ONE factory call and ONE entry — otherwise the loser orphans the
    // winner's Pi session and both prompts interleave past the busy gate.
    const inFlight = this.creating.get(sessionId);
    if (inFlight !== undefined) return inFlight;
    const creation = this.createSession(sessionId);
    this.creating.set(sessionId, creation);
    const release = (): void => {
      if (this.creating.get(sessionId) === creation) {
        this.creating.delete(sessionId);
      }
    };
    // Settle-triggered cleanup; handled rejection avoids unhandledRejection
    // when every waiter has already observed the failure.
    void creation.then(release, release);
    return creation;
  }

  private async createSession(sessionId: string): Promise<SessionEntry> {
    this.evictForAdmission();
    try {
      const session = await this.options.sessionFactory();
      try {
        // Second cap check AFTER the await: N concurrent first-sends for
        // distinct sessionIds all pass the pre-factory check while size is
        // still below the cap; without this recheck they would overshoot by
        // up to N−1 until the next eviction/sweep. Idempotent with the first
        // call; busy entries are still never evicted.
        this.evictForAdmission();
      } catch (err) {
        // The freshly created session was never stored: dispose it instead
        // of leaking it when admission fails (e.g. every live session busy).
        session.dispose?.();
        throw err;
      }
      const entry: SessionEntry = { session, lastUsedMs: this.now(), busy: false };
      this.entries.set(sessionId, entry);
      return entry;
    } catch (err) {
      throw classifyChatError(err, false);
    }
  }

  /**
   * Hard session cap (LRU): before admitting a new sessionId, dispose the
   * least-recently-used IDLE sessions until there is room. Busy entries are
   * never evicted; if every live session is busy, admission fails with a
   * typed 'busy' error instead of exceeding the cap. An evicted session loses
   * its grounding state, so its next incarnation re-sends the preamble.
   */
  private evictForAdmission(): void {
    if (this.entries.size < this.maxSessions) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => !entry.busy)
      .sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
    while (this.entries.size >= this.maxSessions && idle.length > 0) {
      const [victimId] = idle.shift() as [string, SessionEntry];
      const victim = this.entries.get(victimId);
      if (victim === undefined) continue;
      victim.session.dispose?.();
      this.entries.delete(victimId);
      this.groundedSessions.delete(victimId);
    }
    if (this.entries.size >= this.maxSessions) {
      throw new ChatRunError(
        'busy',
        `chat session capacity exhausted (${this.maxSessions} live, all busy)`,
      );
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.idleGcMs;
    for (const [sessionId, entry] of this.entries) {
      if (entry.busy || entry.lastUsedMs > cutoff) continue;
      entry.session.dispose?.();
      this.entries.delete(sessionId);
      this.groundedSessions.delete(sessionId);
    }
  }
}

function assistantText(content: Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Wire-code classification (contracts §Protocol v1): aborts → 'aborted',
 * missing/unusable credentials or model catalog → 'llm_unavailable',
 * everything else → 'internal'.
 */
export function classifyChatError(err: unknown, aborted: boolean): ChatRunError {
  if (err instanceof ChatRunError) return err;
  if (aborted || isAbortError(err)) return new ChatRunError('aborted', 'chat run aborted');
  if (err instanceof LlmUnavailableError) {
    return new ChatRunError('llm_unavailable', err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/api key|unauthorized|authentication|credential|not authenticated|401|403/i.test(message)) {
    return new ChatRunError('llm_unavailable', message);
  }
  return new ChatRunError('internal', message);
}

/**
 * Structural abort markers ONLY: a provider-side fault whose message merely
 * mentions "abort" ('request aborted by server', undici socket aborts) must
 * stay 'internal' — genuine user cancels are already classified via the
 * signal flag in classifyChatError.
 */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR')
  );
}

// ---------------------------------------------------------------------------
// Production wiring (real SDK)
// ---------------------------------------------------------------------------

/** SDK model/runtime shapes kept structural exactly like src/llm/pi-runtime.ts. */
type PiSdkModel = Parameters<ModelRuntime['completeSimple']>[0];
type PiSdkRuntime = Awaited<ReturnType<(typeof ModelRuntime)['create']>>;

/**
 * Loads src/agent/system-prompt.md. Works both from TS sources (vitest) and
 * from dist/agent (the build copies agent/*.md next to the compiled JS).
 */
export function loadChatSystemPrompt(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [`${here}system-prompt.md`, `${here}../../src/agent/system-prompt.md`]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('chat system prompt file (src/agent/system-prompt.md) is missing from the build');
}
export function createPiChatSessionFactory(options: {
  modelRuntime: PiSdkRuntime;
  tools: ToolDefinition[];
  /** Lazily resolves provider + model so an empty catalog never crashes startup. */
  resolveChatModel: () => { providerId: string; model: PiSdkModel };
}): ChatSessionFactory {
  return async () => {
    const { providerId, model } = options.resolveChatModel();
    const auth = await options.modelRuntime.checkAuth(providerId).catch(() => undefined);
    if (auth === undefined) {
      throw new LlmUnavailableError(
        `no credentials available for chat model provider "${providerId}"`,
      );
    }
    const { session } = await createAgentSession({
      noTools: 'all',
      customTools: options.tools,
      modelRuntime: options.modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(),
    });
    // Library-boundary adaptation: AgentSession is structurally the transport
    // we consume (subscribe/prompt/abort/dispose); the SDK event union is a
    // superset of ChatStreamEvent.
    return session as ChatTransportSession;
  };
}
