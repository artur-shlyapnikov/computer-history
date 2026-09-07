import { describe, expect, it } from 'vitest';

import type { SemanticStepDto } from '@computer-history/protocol';

import type { EpisodeRow } from '../src/db/episodes-repository.js';
import type { HistorySearchResult } from '../src/services/history-service.js';
import { createEpisodeGetTool } from '../src/agent/tools/episode-get.js';
import { createHistorySearchTool } from '../src/agent/tools/history-search.js';
import { createMemorySearchTool } from '../src/agent/tools/memory-search.js';
import { createWorkflowSearchTool } from '../src/agent/tools/workflow-search.js';

/**
 * Contract tests for the four Pi custom tools (spec §3.19, brief-m4 §D4
 * item 7): parameter schema bounds, JSON-stringified text content, details
 * parity, filter mapping, and clear thrown errors. Fakes implement the
 * exported per-tool port interfaces — no DB, no SDK runtime.
 */

type AnyExecute = (
  toolCallId: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;

function execute(tool: { execute: unknown }, params: unknown) {
  return (tool.execute as AnyExecute)('tool-call-1', params, undefined, undefined, undefined);
}

/** Test seam: parse tool text content once so callers get fully typed values. */
function parseContent<T>(res: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(res.content[0]!.text) as T;
}

describe('history_search tool', () => {
  const result: HistorySearchResult = {
    hits: [
      {
        kind: 'episode',
        episodeId: 'e1',
        startedAtMs: 1,
        endedAtMs: 2,
        appNames: ['Safari'],
        snippet: 's',
        score: 0.9,
      },
    ],
  };

  it('forwards filters and returns JSON-stringified text content with details parity', async () => {
    const calls: unknown[] = [];
    const tool = createHistorySearchTool({
      historySearch: (params) => {
        calls.push(params);
        return result;
      },
    });
    const res = await execute(tool, { query: 'webhook', scope: 'both', limit: 25 });
    expect(calls).toEqual([{ query: 'webhook', scope: 'both', limit: 25 }]);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.type).toBe('text');
    expect(JSON.parse(res.content[0]!.text)).toEqual(result);
    expect(res.details).toEqual(result);
  });

  it('clamps per-hit prose (snippet/text) in the model-facing content, keeping details raw', async () => {
    const big: HistorySearchResult = {
      hits: [
        {
          kind: 'step',
          episodeId: 'e1',
          startedAtMs: 1,
          endedAtMs: 2,
          appNames: ['Safari'],
          snippet: 'y'.repeat(4096),
          score: 0.5,
          stepId: 's1',
          stepStartedAtMs: 1,
          stepEndedAtMs: 2,
          action: 'type',
          appName: null,
          target: null,
          text: 'x'.repeat(4096),
        },
      ],
    };
    const tool = createHistorySearchTool({ historySearch: () => big });
    const res = await execute(tool, { scope: 'steps' });
    const parsed = parseContent<HistorySearchResult>(res);
    const hit = parsed.hits[0]!;
    expect(hit.kind).toBe('step');
    if (hit.kind !== 'step') return;
    // Clamped to the summarizer's per-step budget (500 chars incl. ellipsis).
    expect(hit.text).toHaveLength(500);
    expect(hit.text?.endsWith('…')).toBe(true);
    expect(hit.snippet).toHaveLength(500);
    expect(hit.score).toBe(0.5);
    expect(hit.stepId).toBe('s1');
    expect(res.details).toEqual(big); // details stay unclamped for the harness
  });

  it('declares the pinned parameter bounds (limit 1..50, scope enum)', () => {
    const tool = createHistorySearchTool({ historySearch: () => result });
    const props = (tool.parameters as { properties: Record<string, { maximum?: number; minimum?: number; anyOf?: unknown[] }> })
      .properties;
    expect(props['limit']?.minimum).toBe(1);
    expect(props['query']).toBeDefined();
    // Mirrors the history.search wire bound (ipc.ts maxLength 512).
    expect(
      (props['query'] as { maxLength?: number } | undefined)?.maxLength,
    ).toBe(512);
    expect(props['scope']?.anyOf).toHaveLength(3);
  });
});

describe('episode_get tool', () => {
  const episode = { id: 'e1', title: 't' } as unknown as EpisodeRow;
  const steps = [{ id: 's1' }] as unknown as SemanticStepDto[];

  it('returns episode + ordered steps as JSON content', async () => {
    const tool = createEpisodeGetTool({ getEpisode: (id) => (id === 'e1' ? { episode, steps } : null) });
    const res = await execute(tool, { episodeId: 'e1' });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ episode, steps });
    expect(res.details).toEqual({ episode, steps });
  });

  it('pins the spec §3.19 parameter name episodeId', () => {
    const tool = createEpisodeGetTool({ getEpisode: () => null });
    // defineTool types parameters opaquely; the typebox shape IS the contract under test.
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props['episodeId']).toBeDefined();
    expect(props['id']).toBeUndefined();
  });
  it('clamps oversized step text in the model-facing content, keeping details raw', async () => {
    const longStep = { id: 's1', ordinal: 0, text: 'x'.repeat(4096) } as unknown as SemanticStepDto;
    const shortStep = { id: 's2', ordinal: 1, text: 'short' } as unknown as SemanticStepDto;
    const found = { episode, steps: [longStep, shortStep] };
    const tool = createEpisodeGetTool({ getEpisode: () => found });
    const res = await execute(tool, { episodeId: 'e1' });
    const parsed = parseContent<{ steps: Array<{ id: string; text?: string | null }> }>(res);
    expect(parsed.steps[0]!.text).toHaveLength(500); // summarizer per-step budget incl. ellipsis
    expect(parsed.steps[0]!.text?.endsWith('…')).toBe(true);
    expect(parsed.steps[1]!.text).toBe('short'); // short prose untouched
    expect(res.details).toEqual(found); // details stay unclamped for the harness
  });

  it('throws a clear error for unknown ids', async () => {
    const tool = createEpisodeGetTool({ getEpisode: () => null });
    await expect(execute(tool, { episodeId: 'nope' })).rejects.toThrow(
      'episode_get: no episode with id "nope"',
    );
  });
});

describe('memory_search tool', () => {
  const memories = [{ id: 'm1', text: 'prefers dark mode' }];

  it('maps minimumConfidence → minConfidence and wraps results in {memories}', async () => {
    const calls: unknown[] = [];
    const tool = createMemorySearchTool({
      searchMemories: (filters) => {
        calls.push(filters);
        return memories as never;
      },
    });
    const res = await execute(tool, {
      query: 'dark mode',
      kinds: ['preference'],
      minimumConfidence: 0.8,
      limit: 5,
    });
    expect(calls).toEqual([
      { query: 'dark mode', kinds: ['preference'], minConfidence: 0.8, limit: 5 },
    ]);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ memories });
  });

  it('declares minimumConfidence bound 0..1 and required query', () => {
    const tool = createMemorySearchTool({ searchMemories: () => memories as never });
    const props = (
      tool.parameters as { properties: Record<string, { minimum?: number; maximum?: number }> }
    ).properties;
    expect(props['minimumConfidence']?.minimum).toBe(0);
    expect(props['minimumConfidence']?.maximum).toBe(1);
    // Mirrors the shared FTS query bound (S1).
    expect((props['query'] as { maxLength?: number }).maxLength).toBe(512);
  });
});

describe('workflow_search tool', () => {
  const workflows = [{ id: 'w1', name: 'Deploy bot' }];

  it('passes query/status/limit and wraps results in {workflows}', async () => {
    const calls: unknown[] = [];
    const tool = createWorkflowSearchTool({
      searchWorkflows: (filters) => {
        calls.push(filters);
        return workflows as never;
      },
    });
    const res = await execute(tool, { query: 'deploy', status: 'confirmed', limit: 3 });
    expect(calls).toEqual([{ query: 'deploy', status: 'confirmed', limit: 3 }]);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ workflows });
  });

  it('accepts filter-only calls (all params optional)', async () => {
    const calls: unknown[] = [];
    const tool = createWorkflowSearchTool({
      searchWorkflows: (filters) => {
        calls.push(filters);
        return [];
      },
    });
    const res = await execute(tool, {});
    expect(calls).toEqual([{}]);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ workflows: [] });
  });

  it('declares the pinned parameter bounds (query maxLength 512, limit 1..50)', () => {
    const tool = createWorkflowSearchTool({ searchWorkflows: () => workflows as never });
    const props = (
      tool.parameters as {
        properties: Record<string, { maxLength?: number; minimum?: number; maximum?: number }>;
      }
    ).properties;
    // Mirrors the shared FTS query bound (ipc.ts maxLength 512).
    expect(props['query']?.maxLength).toBe(512);
    expect(props['limit']?.minimum).toBe(1);
    expect(props['limit']?.maximum).toBe(50);
  });
});
