import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { CONSTANTS } from '../../config.js';
import type { EpisodeRow } from '../../db/episodes-repository.js';
import type { SemanticStepDto } from '@computer-history/protocol';

export interface EpisodeGetPort {
  getEpisode(id: string): { episode: EpisodeRow; steps: SemanticStepDto[] } | null;
}

/** episode_get custom tool (spec §3.19): one episode with its ordered steps. */
export function createEpisodeGetTool(port: EpisodeGetPort) {
  return defineTool({
    name: 'episode_get',
    label: 'Get episode',
    description:
      'Fetch one history episode by id together with its ordered semantic steps ' +
      '(timestamps, applications, targets, texts).',
    parameters: Type.Object({
      episodeId: Type.String({ description: 'Episode id as returned by history_search' }),
    }),
    execute: async (_toolCallId, params) => {
      const found = port.getEpisode(params.episodeId);
      if (found === null) {
        // Thrown Errors surface to the model verbatim (contracts §Pi SDK pins).
        throw new Error(`episode_get: no episode with id "${params.episodeId}"`);
      }
      // AG-07: tool results feed the model verbatim (~200KB otherwise), so step
      // prose is clamped to the same per-step budget the summarizer applies
      // (CONSTANTS.summarizeStepTextChars = 500); ids/ordinals/timestamps stay intact.
      const serialized = {
        episode: found.episode,
        steps: found.steps.map((step) =>
          step.text !== null && step.text !== undefined && step.text.length > CONSTANTS.summarizeStepTextChars
            ? { ...step, text: `${step.text.slice(0, CONSTANTS.summarizeStepTextChars - 1)}…` }
            : step,
        ),
      };
      const text = JSON.stringify(serialized);
      return { content: [{ type: 'text', text }], details: found };
    },
  });
}
