import { CONSTANTS } from '../config.js';
import type { Router } from './router.js';

export interface SettingsOpsDeps {
  /** Configured chat-model id (env-overridable LLM config). */
  chatModel: string;
  /** Configured background-model id (env-overridable LLM config). */
  backgroundModel: string;
}

/**
 * Read-only settings surface (contracts §Protocol v1): `settings.get` reports
 * the effective daemon settings — the env-resolved LLM model ids plus the
 * pinned retention constants. `settings.set` stays unregistered on purpose:
 * the Router answers error.not_implemented until mutation lands.
 */
export function registerSettingsOps(router: Router, deps: SettingsOpsDeps): void {
  router.register('settings.get', () => {
    // Both sides validated centrally by Router.dispatch against the pinned
    // registry entry; the handler only reports effective configuration.
    return {
      settings: {
        chatModel: deps.chatModel,
        backgroundModel: deps.backgroundModel,
        rawRetentionHours: CONSTANTS.rawRetentionHours,
        semanticRetentionDays: CONSTANTS.semanticRetentionDays,
      },
    };
  });
}
