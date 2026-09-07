import type { JobsRepository } from '../db/jobs-repository.js';
import type { Router } from './router.js';

export interface JobOpsDeps {
  jobs: JobsRepository;
  /** Queue-counter sink (same wiring as the job worker's queue_update). */
  onQueueUpdate: (pendingJobs: number) => void;
  /** Injectable clock (contracts §Testing conventions). */
  now?: () => number;
}

/**
 * `jobs.retryDead {}` (brief-m7 §D7 item 5): manual re-drive of the dead-job
 * letterbox. V1 pins that dead jobs are never auto-revived when a transport
 * heals; this diagnostics op is the ONLY revival path — dead → pending with
 * run_after = now. Unknown to connected recorders before this wave; additive.
 */
export function registerJobOps(router: Router, deps: JobOpsDeps): void {
  router.register('jobs.retryDead', () => {
    const retried = deps.jobs.retryDead(deps.now?.() ?? Date.now());
    // A successful re-drive changes pending counts ⇒ queue_update fires.
    const counts = deps.jobs.countsByState();
    deps.onQueueUpdate(counts.pending + counts.retry);
    // Nothing dead right now is not an error — answer honestly.
    return { retried };
  });
}
