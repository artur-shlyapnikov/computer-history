import { CONSTANTS } from '../config.js';
import type { ChatChunkPayload, ChatErrorPayload } from '@computer-history/protocol';

import { ulid } from 'ulid';

import {
  CHAT_MAX_ACTIVE_RUNS,
  classifyChatError,
  type ChatSessionManager,
} from '../agent/agent-session.js';
import { replaceWellFormedTarget } from '../util/text.js';
import type { Logger } from '../logging.js';
import { type OpHandler, type Router } from './router.js';

export interface ChatOpsDeps {
  chat: ChatSessionManager;
  /** Broadcast seam (IpcServer.broadcastEvent) — events reach handshaken peers. */
  broadcastEvent(
    kind: 'chat_chunk' | 'chat_done' | 'chat_error',
    payload: Record<string, unknown>,
  ): void;
  logger: Logger;
  /**
   * Max concurrently in-flight chat runs tracked at the op layer. Excess
   * chat.send ops are still ACKed ({requestId, sessionId}), then immediately
   * fail their run with a 'busy' chat_error — the same surface as the
   * per-session M5 gate (default CHAT_MAX_ACTIVE_RUNS).
   */
  maxActiveRuns?: number;
}

interface ActiveRun {
  controller: AbortController;
}

/**
 * chat.send / chat.cancel (contracts §Protocol v1). The response returns
 * immediately with {requestId, sessionId}; the LLM run continues async and
 * streams chat_chunk/chat_done/chat_error events. Runs are fire-and-forget
 * per request — chat concurrency is independent from job serialization.
 *
 * Bounded by maxActiveRuns (default CHAT_MAX_ACTIVE_RUNS): runs beyond the
 * cap are ACKed, then immediately fail with a 'busy' chat_error instead of
 * piling up unbounded LLM work. The agent layer enforces its own identical
 * cap — double-enforcement is deliberate.
 */
export function registerChatOps(router: Router, deps: ChatOpsDeps): void {
  const maxActiveRuns = Math.max(1, deps.maxActiveRuns ?? CHAT_MAX_ACTIVE_RUNS);
  const active = new Map<string, ActiveRun>();

  const sendHandler: OpHandler<'chat.send'> = (params) => {
    const requestId = ulid();
    const sessionId = params.sessionId ?? ulid();
    const controller = new AbortController();
    active.set(requestId, { controller });
    // Admission is decided SYNCHRONOUSLY while `active` holds exactly the
    // runs registered so far (`<=` because this run is already counted);
    // deciding inside the deferred callback would also see later-arriving
    // runs and wrongly reject earlier ones.
    const admitted = active.size <= maxActiveRuns;

    const chunk = (delta: string): void => {
      // Issue W2: an LLM delta with a lone surrogate would make Swift's
      // JSONDecoder reject the entire chat_chunk frame — sanitize at the
      // emission boundary instead of dropping the frame client-side.
      const payload: ChatChunkPayload = { requestId, delta: replaceWellFormedTarget(delta) };
      deps.broadcastEvent('chat_chunk', payload);
    };
    // Deferred one macrotask so the {requestId, sessionId} RESPONSE frame is
    // always written before the first streamed event (deterministic client
    // ordering; the protocol does not pin it, but clients depend on the ack).
    setImmediate(() => {
      // Over-cap runs are ACKed above, then immediately fail with a 'busy'
      // chat_error — same surface as the per-session M5 gate. An
      // already-cancelled over-cap run is silently dropped (its requester
      // got cancelled:true and expects no terminal event).
      if (!admitted) {
        active.delete(requestId);
        if (!controller.signal.aborted) {
          const payload: ChatErrorPayload = {
            requestId,
            code: 'busy',
            // Issue W2 parity with chunk(): every text field crossing the wire
            // must be well-formed UTF-16 or Swift drops the whole frame.
            message: replaceWellFormedTarget(
              `chat run limit reached (${maxActiveRuns} active)`,
            ),
          };
          deps.broadcastEvent('chat_error', payload);
          deps.logger.log('warn', 'chat', 'chat run rejected at concurrency cap', {
            requestId,
            code: 'busy',
            errorMessage: payload.message,
          });
        }
        return;
      }
      let timedOut = false;
      // Watchdog: deps.chat.send (agent-session) has no transport timeout of
      // its own, so a stalled LLM prompt would occupy one of maxActiveRuns
      // slots forever (only user cancel releases it) — a handful of stuck
      // slots wedges every future chat.send as ACK-then-busy until restart.
      // CONSTANTS.promptTimeoutMs is the right bound because this is the same
      // LLM-prompt-hang class workflow-miner already bounds with it.
      const watchdog = setTimeout(() => {
        timedOut = true;
        // The existing abort path (signal listener → session.abort) unwedges
        // the transport; the .catch below reports it as a timeout.
        controller.abort();
      }, CONSTANTS.promptTimeoutMs);
      void deps.chat
        .send({ sessionId, text: params.text, signal: controller.signal }, chunk)
        .then(() => {
          deps.broadcastEvent('chat_done', { requestId, sessionId });
        })
        .catch((err: unknown) => {
          const classified = classifyChatError(err, controller.signal.aborted);
          // The watchdog rewrite happens BEFORE the payload is built:
          // IpcServer.broadcastEvent serializes the frame immediately, so a
          // post-broadcast mutation of `payload` would never reach peers —
          // they would see 'aborted' instead of the committed contract
          // {code:'llm_unavailable', message:'chat run timed out …'}. The
          // log line keeps the raw classification detail for diagnosis.
          const code = timedOut ? ('llm_unavailable' as const) : classified.code;
          const message = timedOut
            ? replaceWellFormedTarget(
                `chat run timed out after ${CONSTANTS.promptTimeoutMs}ms`,
              )
            : // Issue W2: transport errors embed upstream text — a lone
              // surrogate here would make Swift drop the chat_error frame
              // and wedge the turn (isTurnPending never clears). Sanitize at
              // the emission boundary, same as chat_chunk.
              replaceWellFormedTarget(classified.message);
          const payload: ChatErrorPayload = {
            requestId,
            code,
            message,
          };
          deps.broadcastEvent('chat_error', payload);
          deps.logger.log('warn', 'chat', 'chat run failed', {
            requestId,
            code: classified.code,
            errorMessage: classified.message,
          });
        })
        .finally(() => {
          clearTimeout(watchdog);
          active.delete(requestId);
        });
    });

    // Result validated centrally by Router.dispatch against the pinned
    // registry entry before the ack frame is written.
    return { requestId, sessionId };
  };

  const cancelHandler: OpHandler<'chat.cancel'> = (params) => {
    const run = active.get(params.requestId);
    if (run === undefined) return { cancelled: false };
    run.controller.abort();
    return { cancelled: true };
  };

  router.register('chat.send', sendHandler);
  router.register('chat.cancel', cancelHandler);
}
