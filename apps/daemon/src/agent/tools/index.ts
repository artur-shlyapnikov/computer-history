import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { EpisodesRepository } from '../../db/episodes-repository.js';
import type { MemoriesRepository } from '../../db/memories-repository.js';
import type { WorkflowsRepository } from '../../db/workflows-repository.js';
import type { HistoryService } from '../../services/history-service.js';

import { createEpisodeGetTool, type EpisodeGetPort } from './episode-get.js';
import { createHistorySearchTool, type HistorySearchPort } from './history-search.js';
import { createMemorySearchTool, type MemorySearchPort } from './memory-search.js';
import { createWorkflowSearchTool, type WorkflowSearchPort } from './workflow-search.js';

export {
  createEpisodeGetTool,
  createHistorySearchTool,
  createMemorySearchTool,
  createWorkflowSearchTool,
  type EpisodeGetPort,
  type HistorySearchPort,
  type MemorySearchPort,
  type WorkflowSearchPort,
};

/**
 * The four pinned chat-agent custom tools (spec §3.19), wired to the real
 * repositories/service. Tests construct individual tools against fakes via
 * the per-tool factories instead.
 */
export function createChatTools(deps: {
  historyService: Pick<HistoryService, 'historySearch'>;
  episodes: Pick<EpisodesRepository, 'getEpisode'>;
  memories: Pick<MemoriesRepository, 'searchMemories'>;
  workflows: Pick<WorkflowsRepository, 'searchWorkflows'>;
}): ToolDefinition[] {
  const historySearch: HistorySearchPort = deps.historyService;
  const episodeGet: EpisodeGetPort = deps.episodes;
  const memorySearch: MemorySearchPort = deps.memories;
  const workflowSearch: WorkflowSearchPort = deps.workflows;
  return [
    createHistorySearchTool(historySearch),
    createEpisodeGetTool(episodeGet),
    createMemorySearchTool(memorySearch),
    createWorkflowSearchTool(workflowSearch),
  ];
}
