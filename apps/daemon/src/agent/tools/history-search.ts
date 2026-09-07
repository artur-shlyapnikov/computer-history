import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { CONSTANTS } from '../../config.js';
import type { HistorySearchResult } from '../../services/history-service.js';

/** Tool-visible subset of HistoryService — tests inject fakes against this. */
export interface HistorySearchPort {
  historySearch(params: {
    query?: string;
    from?: number;
    to?: number;
    apps?: string[];
    scope?: 'episodes' | 'steps' | 'both';
    limit?: number;
  }): HistorySearchResult;
}

/**
 * history_search custom tool (spec §3.19): free-text + filter search over
 * episodes/steps. Parameter schemas use Pi's own typebox 1.x (contracts
 * §Pi SDK pins); wire schemas stay on @sinclair/typebox inside protocol.
 */
export function createHistorySearchTool(port: HistorySearchPort) {
  return defineTool({
    name: 'history_search',
    label: 'Search history',
    description:
      'Search the user’s computer-use history (episodes and semantic steps). ' +
      'Ranking applies only for textual queries; pass absolute epoch-ms from/to ranges ' +
      '(convert relative time expressions yourself before calling).',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: 'Free-text query; omit for filter-only listing',
          // Mirrors history.search wire bound (ipc.ts) so the model cannot
          // push an oversized query past the tool layer (S1).
          maxLength: 512,
        }),
      ),
      from: Type.Optional(Type.Number({ description: 'Absolute range start, Unix epoch ms' })),
      to: Type.Optional(Type.Number({ description: 'Absolute range end, Unix epoch ms' })),
      apps: Type.Optional(Type.Array(Type.String(), { description: 'Filter by application names' })),
      scope: Type.Optional(
        Type.Union([Type.Literal('episodes'), Type.Literal('steps'), Type.Literal('both')]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (_toolCallId, params) => {
      const result = port.historySearch({
        query: params.query,
        from: params.from,
        to: params.to,
        apps: params.apps,
        scope: params.scope,
        limit: params.limit,
      });
      // AG-07: hits feed the model verbatim (StepHistoryHit.text alone can be
      // 4096 chars × 50 hits), so prose fields are clamped to the same per-step
      // budget the summarizer applies (CONSTANTS.summarizeStepTextChars = 500);
      // scores/ids/ordinals stay intact. details keep the unclamped result.
      const max = CONSTANTS.summarizeStepTextChars;
      const clampText = (value: string | null): string | null =>
        value !== null && value.length > max ? `${value.slice(0, max - 1)}…` : value;
      const clampSnippet = (value: string): string =>
        value.length > max ? `${value.slice(0, max - 1)}…` : value;
      const serialized: HistorySearchResult = {
        hits: result.hits.map((hit) =>
          hit.kind === 'step'
            ? { ...hit, snippet: clampSnippet(hit.snippet), text: clampText(hit.text) }
            : { ...hit, snippet: clampSnippet(hit.snippet) },
        ),
      };
      const text = JSON.stringify(serialized);
      return { content: [{ type: 'text', text }], details: result };
    },
  });
}
