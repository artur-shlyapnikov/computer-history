import type {
  HistorySearchResult,
  MemoriesListStatus,
  MemoryCandidateDto,
  MemoryStatus,
} from '@computer-history/protocol';

import type { MemoriesRepository } from '../db/memories-repository.js';
import type { WorkflowsRepository } from '../db/workflows-repository.js';
import type { EpisodeHistoryHit, HistoryService, StepHistoryHit } from '../services/history-service.js';
import { OpError, type Router } from './router.js';


export interface RetrievalOpsDeps {
  history: HistoryService;
  memories: MemoriesRepository;
  workflows: WorkflowsRepository;
  /** Fired after every memory mutation (contracts: `memories_changed`). */
  onMemoriesChanged?: () => void;
  /** Fired after every workflow mutation (contracts: `workflows_changed`). */
  onWorkflowsChanged?: () => void;
  /** Injectable clock for manual-action timestamps (testing conventions). */
  now?: () => number;
}

/**
 * Memories view grouping (brief-m5 §D5 item 5): the UI's Confirmed /
 * Suggestions / Rejected sections map onto DB statuses active / candidate /
 * rejected; superseded rows are hidden unless explicitly requested.
 */
const MEMORY_GROUP_ORDER: readonly MemoriesListStatus[] = ['confirmed', 'suggestions', 'rejected'];
const GROUP_TO_DB_STATUS: Record<MemoriesListStatus, MemoryStatus> = {
  confirmed: 'active',
  suggestions: 'candidate',
  rejected: 'rejected',
  superseded: 'superseded',
};

/** Per-group cap when a memories.list request omits `limit` (schema maxes at 200). */
const DEFAULT_MEMORIES_LIST_LIMIT = 200;

/**
 * Retrieval + memory-management ops. history.search / workflows.list arrived
 * with M4 (read-only); M5 completes the surface with grouped memories.list
 * and the memory.action semantics pinned by contracts: confirm → active
 * immediately (+ manual_confirmed_at), reject → rejected, forget → hard
 * delete of row, evidence and FTS mirror in one transaction.
 *
 * `episode.get` is NOT registered here: timeline-ops owns it (registering it
 * in both was a silent shadow — Router.register now rejects duplicates).
 */
export function registerRetrievalOps(router: Router, deps: RetrievalOpsDeps): void {
  router.register('history.search', (params) => {
    return toWireResult(deps.history.historySearch(params));
  });

  router.register('memories.list', (params) => {
    // `status` is already schema-pinned to the closed group union; an
    // unknown value never reaches this handler (error.invalid_params).
    const groupNames: readonly MemoriesListStatus[] =
      params.status !== undefined ? [params.status] : MEMORY_GROUP_ORDER;
    const limit = params.limit ?? DEFAULT_MEMORIES_LIST_LIMIT;
    return {
      groups: groupNames.map((name) => ({
        status: name,
        memories: deps.memories.listByStatus({ status: GROUP_TO_DB_STATUS[name], limit }),
      })),
    };
  });

  router.register('memory.action', (params) => {
    const now = deps.now?.() ?? Date.now();
    if (deps.memories.getById(params.id) === null) {
      throw new OpError('error.not_found', `no memory with id ${params.id}`);
    }
    let updated: MemoryCandidateDto | null;
    switch (params.action) {
      case 'confirm':
        updated = deps.memories.confirm(params.id, now);
        break;
      case 'reject':
        updated = deps.memories.reject(params.id, now);
        break;
      case 'forget':
        deps.memories.forget(params.id);
        updated = null;
        break;
    }
    // Broadcast committed state BEFORE answering: clients must already have
    // the memories_changed truth when the result frame arrives.
    deps.onMemoriesChanged?.();
    return { updated };
  });

  router.register('workflows.list', (params) => {
    // `status` is already schema-pinned to the workflow-status union.
    return {
      workflows: deps.workflows.listByStatus(
        params.status !== undefined ? { status: params.status } : {},
      ),
    };
  });

  router.register('workflow.action', (params) => {
    const now = deps.now?.() ?? Date.now();
    const updated = deps.workflows.updateStatus(
      params.id,
      params.action === 'confirm' ? 'confirmed' : 'rejected',
      now,
    );
    if (updated === null) {
      throw new OpError('error.not_found', `no workflow with id ${params.id}`);
    }
    // Broadcast committed state BEFORE answering: clients must already have
    // the workflows_changed truth when the result frame arrives.
    deps.onWorkflowsChanged?.();
    return { updated };
  });
}



/** Service hit → pinned wire shape: episode provenance + optional stepId. */
function toWireResult(result: { hits: Array<EpisodeHistoryHit | StepHistoryHit> }): HistorySearchResult {
  return {
    hits: result.hits.map((hit) => ({
      source:
        hit.kind === 'step'
          ? {
              episodeId: hit.episodeId === '' ? undefined : hit.episodeId,
              stepId: hit.stepId,
              startedAtMs: hit.startedAtMs,
              endedAtMs: hit.endedAtMs,
              appNames: hit.appNames,
              snippet: hit.snippet,
            }
          : {
              episodeId: hit.episodeId,
              startedAtMs: hit.startedAtMs,
              endedAtMs: hit.endedAtMs,
              appNames: hit.appNames,
              snippet: hit.snippet,
            },
      score: hit.score,
    })),
  };
}
