import type {
  EpisodesRepository,
  EpisodeRow,
} from '../db/episodes-repository.js';

import type { JobsRepository } from '../db/jobs-repository.js';
import type { SegmentsRepository } from '../db/segments-repository.js';
import { OpError, type Router } from './router.js';

export interface TimelineOpsDeps {
  segments: SegmentsRepository;
  episodes: EpisodesRepository;
  jobs: JobsRepository;
}

/** "Activities waiting for processing": pending + retry (spec §3.24 UI). */
function waitingJobs(jobs: JobsRepository): number {
  const counts = jobs.countsByState();
  return counts.pending + counts.retry;
}

/**
 * `segments.list` (contracts §Additional pinned decisions), the LIVE
 * `timeline.list` (episodes-based, brief-m3 §D3 item 8 — replaces the M2
 * empty-array stub) and `episode.get` (episode + ordered steps).
 */
export function registerSegmentsOps(router: Router, deps: TimelineOpsDeps): void {
  router.register('segments.list', (params) => {
    return {
      segments: deps.segments.getSegments(
        { from: params.from, to: params.to },
        params.limit ?? 50,
      ),
    };
  });

  router.register('timeline.list', (params) => {
    const pendingJobs = waitingJobs(deps.jobs);
    // Both sides of this op are validated by Router.dispatch against the
    // pinned registry entry; the handler only implements behavior.
    return {
      episodes: deps.episodes
        .listEpisodes({ from: params.from, to: params.to }, params.limit ?? 50)
        .map((episode) => ({ ...episode, pendingJobs })),
    };
  });

  router.register('episode.get', (params) => {
    const found = deps.episodes.getEpisode(params.id);
    if (found === null) {
      throw new OpError('error.not_found', `no episode with id ${params.id}`);
    }
    return { episode: toEpisodeDto(found.episode), steps: found.steps };
  });
}

function toEpisodeDto(episode: EpisodeRow) {
  return {
    id: episode.id,
    startedAtMs: episode.startedAtMs,
    endedAtMs: episode.endedAtMs,
    title: episode.title,
    summary: episode.summary,
    intent: episode.intent,
    outcome: episode.outcome,
    apps: episode.apps,
    entities: episode.entities,
    summaryModel: episode.summaryModel,
    summaryPromptVersion: episode.summaryPromptVersion,
    createdAtMs: episode.createdAtMs,
    updatedAtMs: episode.updatedAtMs,
  };
}
