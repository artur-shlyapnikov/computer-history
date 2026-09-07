import type { JobRow, JobsRepository } from '../db/jobs-repository.js';
import type { Logger } from '../logging.js';
import { CONSTANTS } from '../config.js';

export interface JobWorkerOptions {
  jobs: JobsRepository;
  logger: Logger;
  /** Poll cadence; pinned default 1000 ms (brief-m3 §D3 item 2). */
  pollIntervalMs?: number;
  /** Lease window passed to claimNext; production wiring uses CONSTANTS.jobLeaseMs. */
  leaseMs?: number;
  /** Injectable clock (contracts §Testing conventions). */
  now?: () => number;
  /**
   * Queue-state sink: invoked after every state transition with the number of
   * "activities waiting for processing" (pending + retry, spec §3.24 UI).
   * The daemon main wires this to the `queue_update` IPC event.
   */
  onQueueUpdate?: (pendingJobs: number) => void;
}

/**
 * A job handler receives the claimed row and either finishes it (resolve) or
 * fails it (throw / reject). Failures flow through JobsRepository.fail —
 * attempts back off on the pinned schedule and the FIFTH failure marks the
 * job dead (spec §3.24).
 */
export type JobHandler = (job: JobRow) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = CONSTANTS.queuePollIntervalMs;
/** Pinned default for leaseMs; sizing rationale lives on CONSTANTS.jobLeaseMs in config.ts. */
export const DEFAULT_LEASE_MS = CONSTANTS.jobLeaseMs;

/**
 * Bounded grace for stop()'s drain (SVC-01): shutdown awaits in-flight
 * handlers before the WAL checkpoint/db.close, but a wedged LLM transport
 * must never stall SIGTERM past this window.
 */
export const DEFAULT_STOP_GRACE_MS = 10_000;

/**
 * Background-job poll loop (spec §3.9 jobs, brief-m3 §D3 item 2):
 *
 * - 1 s tick: recover expired leases, then claim the oldest runnable job whose
 *   type has a registered handler. Unknown types stay pending untouched
 *   (contracts §Additional pinned decisions — forward-enqueue is never an
 *   error), so claimNext filters by the registered set.
 * - LLM-bound handlers registered via registerSerialized run through one
 *   promise chain ⇒ exactly ONE LLM job in flight process-wide
 *   (contracts §LLM boundary); non-LLM handlers run concurrently.
 * - Every state change re-emits the queue counters through onQueueUpdate.
 *
 * The tick is exposed as tick() so tests drive it deterministically with a
 * fake clock instead of sleeping against the real interval.
 */
export class JobWorker {
  private readonly jobs: JobsRepository;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly onQueueUpdate?: (pendingJobs: number) => void;
  private readonly handlers = new Map<string, JobHandler>();
  /** Types whose handlers must never overlap — executed on one promise chain. */
  private readonly serializedTypes = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  /** True while a serialized dispatch is queued on or running down the chain. */
  private chainBusy = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private ticking = false;

  constructor(options: JobWorkerOptions) {
    this.jobs = options.jobs;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? Date.now;
    this.onQueueUpdate = options.onQueueUpdate;
  }

  /** Register a plain handler; multiple invocations of its type may run in parallel. */
  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Register an LLM-bound handler. All such handlers share ONE promise chain,
   * so two background LLM jobs can never overlap regardless of registration
   * order or claim timing (spec §3.15: background concurrency = 1).
   */
  registerSerialized(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
    this.serializedTypes.add(type);
  }

  /** Startup recovery + poll loop. The interval is unref'd. */
  start(): void {
    const recovered = this.jobs.requeueExpiredLeases(this.now());
    if (recovered > 0) {
      this.logger.log('info', 'job-worker', 'requeued expired leases at startup', { recovered });
      this.emitQueueUpdate();
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * Stop polling and drain in-flight handlers (SVC-01). Resolves true once
   * every dispatched job has fully settled — including the serialized chain
   * tail — so the caller may safely checkpoint/close the database; resolves
   * false if the drain exceeds graceMs, so a wedged LLM transport cannot
   * stall SIGTERM indefinitely. Abandoned jobs stay leased and are recovered
   * by requeueExpiredLeases on the next startup.
   */
  async stop(graceMs: number = DEFAULT_STOP_GRACE_MS): Promise<boolean> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain whatever is already running; no new claims happen without ticks.
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.idle().then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), graceMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  /**
   * One poll cycle: lease recovery, then at most one claim + dispatch.
   * Reentrancy-safe: overlapping timers coalesce into the running tick.
   *
   * While the serialized chain is unsettled, serialized types are EXCLUDED
   * from the claim set (spec §3.15 concurrency=1): a claim starts the lease
   * clock, and a job leased-but-parked behind minutes of queued LLM work
   * would expire before run() begins and get double-dispatched by a later
   * tick. A serialized job is therefore claimed exactly when it can start.
   */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const recovered = this.jobs.requeueExpiredLeases(this.now());
      if (recovered > 0) this.emitQueueUpdate();
      const types = [...this.handlers.keys()].filter(
        (type) => !this.chainBusy || !this.serializedTypes.has(type),
      );
      if (types.length === 0) return;
      const job = this.jobs.claimNext(this.leaseMs, this.now(), types);
      if (job === null) return;
      // Post-claim stats emission is log-only: countsByState() can hit a
      // transient SQLITE_BUSY for an already-successfully-claimed job. If that
      // escaped to the tick catch below, the row would sit leased with no
      // handler dispatched and not in inflight until the 600s lease expires —
      // so a stats failure must never prevent dispatch.
      try {
        this.emitQueueUpdate();
      } catch (err) {
        this.logger.log('warn', 'job-worker', 'queue update after claim failed; dispatching anyway', {
          jobId: job.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      const dispatch: Promise<void> = this.serializedTypes.has(job.type)
        ? this.chain.then(() => this.run(job))
        : this.run(job);
      // Serialized jobs join the chain; the tail reference keeps the chain
      // alive and clears the busy flag once the job fully settles.
      if (this.serializedTypes.has(job.type)) {
        this.chainBusy = true;
        this.chain = dispatch
          .catch(() => undefined)
          .finally(() => {
            this.chainBusy = false;
          });
      }
      const tracked = dispatch.finally(() => this.inflight.delete(tracked));
      this.inflight.add(tracked);
    } catch (err) {
      // Poll-loop hardening: requeueExpiredLeases/claimNext/countsByState all
      // hit SQLite synchronously on the interval callback. A transient
      // SQLITE_BUSY or data edge must degrade to a logged error — an escaping
      // throw surfaces as an unhandled rejection (node default = crash) and
      // takes the whole daemon down. Keep polling either way.
      this.logger.log('error', 'job-worker', 'job poll tick failed; keeping poll loop alive', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.ticking = false;
    }
  }

  /** Resolves when every handler dispatched so far has settled (test/stop seam). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    await this.chain;
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (handler === undefined) return; // unreachable: claims filter to registered types
    // SVC-01 guard: complete/fail/queue-update all touch SQLite. If shutdown
    // closed the database under a still-draining handler (stop() grace timed
    // out), those calls throw better-sqlite3 errors — logged here, never
    // rethrown, so the drain promise cannot surface them as an unhandled
    // rejection. Healthy-database semantics are untouched.
    try {
      try {
        await handler(job);
        this.jobs.complete(job.id, job.leased_until_ms, this.now());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const outcome = this.jobs.fail(job.id, message, this.now(), job.leased_until_ms);
        if (outcome === 'stale') {
          // Lease lost to recovery while the handler was still running: the
          // successor owns the job now — log and discard, never rethrow.
          this.logger.log('warn', 'job-worker', 'job failed after lease loss; result discarded', {
            jobId: job.id,
            type: job.type,
            errorMessage: message,
          });
        } else {
          this.logger.log(outcome === 'dead' ? 'error' : 'warn', 'job-worker', 'job failed', {
            jobId: job.id,
            type: job.type,
            attempts: job.attempts,
            outcome,
            errorMessage: message,
          });
        }
      }
      this.emitQueueUpdate();
    } catch (err) {
      this.logger.log('error', 'job-worker', 'job finalization failed after handler settled', {
        jobId: job.id,
        type: job.type,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emitQueueUpdate(): void {
    if (!this.onQueueUpdate) return;
    // Dedup lives at the single shared sink (main.ts emitQueueUpdate): several
    // emitters feed the same queue_update event, so a per-emitter last-value
    // guard would strand a stale count when another emitter moves the number.
    const counts = this.jobs.countsByState(this.now());
    this.onQueueUpdate(counts.pending + counts.retry);
  }
}
