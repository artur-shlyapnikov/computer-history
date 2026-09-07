import type { ChatStreamEvent, ChatTransportSession } from '../../src/agent/agent-session.js';

/**
 * Scripted fake Pi transport session (lifted from the makeFakeSession pattern
 * in chat-agent-session.test.ts; that file keeps its own copy). Records
 * prompts/aborts, parks each prompt until finishPrompt/failPrompt is called,
 * and relays assistant message_update snapshots to all subscribers.
 */
export interface FakeChatSession extends ChatTransportSession {
  listeners: Array<(event: ChatStreamEvent) => void>;
  prompts: string[];
  aborted: boolean;
  disposed: number;
  /** Emits an assistant snapshot with arbitrary content blocks. */
  emitContent(content: Array<{ type: string; text?: string }>): void;
  /** Emits an assistant single-text-block snapshot. */
  emitUpdate(text: string): void;
  finishPrompt(): void;
  failPrompt(err: Error): void;
}

export function makeFakeChatSession(): FakeChatSession {
  const session: FakeChatSession = {
    listeners: [],
    prompts: [],
    aborted: false,
    disposed: 0,
    subscribe(listener) {
      session.listeners.push(listener);
      return () => {
        session.listeners = session.listeners.filter((l) => l !== listener);
      };
    },
    async prompt(text) {
      session.prompts.push(text);
      await new Promise<void>((resolve, reject) => {
        session.finishPrompt = resolve;
        session.failPrompt = reject;
      });
    },
    abort() {
      session.aborted = true;
    },
    dispose() {
      session.disposed += 1;
    },
    emitContent(content) {
      for (const listener of [...session.listeners]) {
        listener({ type: 'message_update', message: { role: 'assistant', content } });
      }
    },
    emitUpdate(text: string) {
      session.emitContent([{ type: 'text', text }]);
    },
    finishPrompt() {},
    failPrompt() {},
  };
  return session;
}
