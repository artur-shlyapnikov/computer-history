import { describe, expect, it, vi } from 'vitest';

import type { MemoryCandidateDto, SemanticStepDto, WorkflowDto } from '@computer-history/protocol';

import type { EpisodeRow } from '../src/db/episodes-repository.js';
import type { HistorySearchResult } from '../src/services/history-service.js';
import {
  createChatTools,
  createHistorySearchTool,
  createMemorySearchTool,
} from '../src/agent/tools/index.js';

/**
 * Behavioral validation of the chat tools' runtime failure path plus a wiring
 * smoke over createChatTools (design P2-6, REDUCED SCOPE).
 *
 * SCOPE REDUCTION (adjudicated): the design's parameter-validation cases
 * (`limit: 0`, `scope: 'bogus'`, missing required `query`, `limit: 51` →
 * "tool call fails before the port is touched") rest on a FALSE premise.
 * The tool execute() functions forward params unvalidated — bounds are
 * declared in the typebox parameter schemas and enforced by the Pi SDK host
 * layer BEFORE execute() is ever invoked. Unit-level calls with invalid
 * params therefore REACH the ports, and there is nothing to assert at this
 * layer. Those cases are dropped; what remains is:
 *   (a) port-failure surfacing — a failing port surfaces its error to the
 *       Pi host verbatim without crashing or poisoning the tool (DEVIATION:
 *       the design injected `Promise.reject`, but every tool port signature
 *       is SYNCHRONOUS, so the real failure shape under test is a thrown
 *       error propagated through execute()'s async wrapper);
 *   (b) createChatTools wiring smoke — exactly the four pinned tools bound
 *       to the provided ports.
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

describe('chat tool port failures surface to the Pi host', () => {
  it('a failing historySearch port surfaces its error VERBATIM (no wrapping), then the tool keeps working', async () => {
    const boom = new Error('fts exploded');
    let healthy = false;
    const tool = createHistorySearchTool({
      historySearch: () => {
        if (!healthy) throw boom;
        return { hits: [] };
      },
    });

    // The raw Error reaches the caller untouched — execute()'s async wrapper
    // turns it into a rejected promise, which the Pi SDK host layer converts
    // into a failed tool result; execute() adds NO wrapper of its own
    // (pinned from history-search.ts source).
    await expect(execute(tool, { query: 'keto' })).rejects.toBe(boom);
    await expect(execute(tool, { query: 'keto' })).rejects.toThrow('fts exploded');

    // No crash / no poisoned state: once the port recovers, the SAME tool
    // instance serves results again.
    healthy = true;
    const res = await execute(tool, { query: 'keto' });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ hits: [] });
  });

  it('a memory_search port throw surfaces verbatim as well', async () => {
    const boom = new Error('memory index offline');
    const tool = createMemorySearchTool({
      searchMemories: () => {
        throw boom;
      },
    });
    await expect(execute(tool, { query: 'dark mode' })).rejects.toBe(boom);
  });
});

describe('createChatTools wiring smoke', () => {
  const hits: HistorySearchResult = {
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
  const found = {
    episode: { id: 'e1', title: 't' } as unknown as EpisodeRow,
    steps: [{ id: 's1' }] as unknown as SemanticStepDto[],
  };
  const memories = [
    { id: 'm1', text: 'prefers dark mode' },
  ] as unknown as MemoryCandidateDto[];
  const workflows = [{ id: 'w1', name: 'Deploy bot' }] as unknown as WorkflowDto[];

  function build() {
    const historyService = { historySearch: vi.fn(() => hits) };
    const episodes = { getEpisode: vi.fn(() => found) };
    const memoriesPort = { searchMemories: vi.fn(() => memories) };
    const workflowsPort = { searchWorkflows: vi.fn(() => workflows) };
    const tools = createChatTools({
      historyService,
      episodes,
      memories: memoriesPort,
      workflows: workflowsPort,
    });
    return { tools, historyService, episodes, memoriesPort, workflowsPort };
  }

  it('returns exactly the four pinned §3.19 tool names, in order', () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual([
      'history_search',
      'episode_get',
      'memory_search',
      'workflow_search',
    ]);
  });

  it('each tool is bound to ITS provided port and streams the port result into content', async () => {
    const { tools, historyService, episodes, memoriesPort, workflowsPort } = build();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const historyRes = await execute(byName.get('history_search')!, {});
    expect(historyService.historySearch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(historyRes.content[0]!.text)).toEqual(hits);

    const episodeRes = await execute(byName.get('episode_get')!, { episodeId: 'e1' });
    expect(episodes.getEpisode).toHaveBeenCalledWith('e1');
    expect(JSON.parse(episodeRes.content[0]!.text)).toEqual(found);

    const memoryRes = await execute(byName.get('memory_search')!, { query: 'dark mode' });
    expect(memoriesPort.searchMemories).toHaveBeenCalledTimes(1);
    expect(JSON.parse(memoryRes.content[0]!.text)).toEqual({ memories });

    const workflowRes = await execute(byName.get('workflow_search')!, { query: 'deploy' });
    expect(workflowsPort.searchWorkflows).toHaveBeenCalledTimes(1);
    expect(JSON.parse(workflowRes.content[0]!.text)).toEqual({ workflows });
  });
});
