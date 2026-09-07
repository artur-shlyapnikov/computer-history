import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

import type { MemoryCandidateDto, MemoryKind } from '@computer-history/protocol';

export interface MemorySearchPort {
  searchMemories(filters: {
    query: string;
    kinds?: MemoryKind[];
    minConfidence?: number;
    limit?: number;
  }): MemoryCandidateDto[];
}

/**
 * memory_search custom tool (spec §3.19): FTS over durable memory claims.
 * Active+candidate statuses are searched by default; confidence filter maps
 * to the repository's minConfidence.
 */
export function createMemorySearchTool(port: MemorySearchPort) {
  return defineTool({
    name: 'memory_search',
    label: 'Search memories',
    description:
      'Search durable memories about the user (facts, preferences, procedures). ' +
      'Use for stable claims (“the user usually…”) rather than episodic questions.',
    parameters: Type.Object({
      query: Type.String({ description: 'Free-text query over claim texts', maxLength: 512 }),
      kinds: Type.Optional(
        Type.Array(Type.Union([Type.Literal('fact'), Type.Literal('preference'), Type.Literal('procedure')])),
      ),
      minimumConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (_toolCallId, params) => {
      const result = port.searchMemories({
        query: params.query,
        kinds: params.kinds,
        minConfidence: params.minimumConfidence,
        limit: params.limit,
      });
      const text = JSON.stringify({ memories: result });
      return { content: [{ type: 'text', text }], details: result };
    },
  });
}
