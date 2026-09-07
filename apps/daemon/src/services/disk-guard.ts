import { statfsSync } from 'node:fs';

import type { Logger } from '../logging.js';

/** Pinned disk-pressure thresholds (spec §3.25, brief-m7 §D7 item 3). */
export const DISK_LOW_BYTES = 1024 * 1024 * 1024; // 1 GiB: pause below this
export const DISK_RESUME_BYTES = Math.round(1.2 * 1024 * 1024 * 1024); // 1.2 GiB hysteresis
/** Pinned check cadence. */
export const DISK_CHECK_INTERVAL_MS = 60_000;

export interface StatfsResult {
  freeBytes: number;
}

export type DiskPressureState = 'ok' | 'low' | 'paused';

export interface DiskGuardOptions {
  /** Filesystem path to watch (daemon home dir). */
  path: string;
  logger: Logger;
  /** Injectable statfs for tests; defaults to fs.statfsSync over `path`. */
  statfs?: () => StatfsResult;
  intervalMs?: number;
  lowBytes?: number;
  resumeBytes?: number;
  /**
   * Retention trigger (spec §3.25: «сначала запускается retention»): invoked
   * at most once per low-disk episode BEFORE pausing.
   */
  triggerRetention?: () => void;
  /**
   * Recording-state sink wired to the `recording_state` broadcast: paused
   * with reason 'disk_pressure' on pause entry, active on hysteresis resume.
   */
  onRecordingStateChanged?: (paused: boolean, reason?: string) => void;
  now?: () => number;
}

/**
 * Disk-pressure guard (spec §3.25): checked before every ingest batch and on
 * a 60s timer. free < 1 GiB ⇒ run retention ONCE ⇒ recheck ⇒ still low ⇒
 * recording pauses (recording_state paused/disk_pressure broadcast) and
 * events.batch is refused with the typed error `error.disk_pressure` — the
 * recorder then spools locally (bounded, honest backpressure, NO silent drop).
 * Recovery requires the 1.2 GiB hysteresis so a flapping filesystem cannot
 * toggle recording.
 */
export class DiskGuard {
  private readonly path: string;
  private readonly logger: Logger;
  private readonly statfs: () => StatfsResult;
  private readonly intervalMs: number;
  private readonly lowBytes: number;
  private readonly resumeBytes: number;
  private readonly triggerRetention?: () => void;
  private readonly onRecordingStateChanged?: (paused: boolean, reason?: string) => void;
  private state: DiskPressureState = 'ok';
  private retentionFiredForEpisode = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: DiskGuardOptions) {
    this.path = options.path;
    this.logger = options.logger;
    const injectable = options.statfs;
    this.statfs =
      injectable ??
      (() => {
        const stats = statfsSync(options.path);
        return { freeBytes: stats.bavail * Number(stats.bsize) };
      });
    this.intervalMs = options.intervalMs ?? DISK_CHECK_INTERVAL_MS;
    this.lowBytes = options.lowBytes ?? DISK_LOW_BYTES;
    this.resumeBytes = options.resumeBytes ?? DISK_RESUME_BYTES;
    this.triggerRetention = options.triggerRetention;
    this.onRecordingStateChanged = options.onRecordingStateChanged;
  }

  /**
   * One statfs sample, or null when the probe fails (a failing statfs must
   * never stop ingest — the guard keeps its previous state instead).
   */
  private sample(): number | null {
    try {
      return this.statfs().freeBytes;
    } catch (err) {
      this.logger.log('warn', 'disk-guard', 'statfs failed', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Runs the retention sweep INLINE (round-32 fix): round-31 deferred it via
   * setImmediate, which guaranteed evaluate()'s recheck sampled PRE-sweep
   * free space — the «retention freed enough space» latch reset below was
   * unreachable from synchronous callers. Spec §3.25 orders retention BEFORE
   * the pause decision's fresh sample, so the evaluate()/gateBatch() path
   * completes the sweep right here. The sweep body stays synchronous (single
   * writer).
   */
  // MUST stay synchronous end-to-end: evaluate() samples free space only
  // after this returns, and no guard protects against re-entrancy.
  private runRetention(): void {
    try {
      this.triggerRetention?.();
    } catch (err) {
      this.logger.log('error', 'disk-guard', 'retention trigger failed', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Current pressure state after evaluating one statfs sample. When the low
   * branch triggers retention, the sweep COMPLETES inline before this
   * resolves, so callers awaiting it never observe stale pre-sweep space.
   */
  async evaluate(): Promise<DiskPressureState> {
    let freeBytes = this.sample();
    if (freeBytes === null) return this.state;
    if (this.state !== 'paused' && freeBytes < this.lowBytes) {
      if (!this.retentionFiredForEpisode) {
        // Spec §3.25: retention runs once first; it may free enough space.
        // The sweep runs INLINE (round-32): the round-31 setImmediate
        // deferral made the fresh recheck below sample BEFORE the sweep
        // completed, so a still-low probe paused even when retention freed
        // plenty and the latch reset in the else branch never executed.
        this.retentionFiredForEpisode = true;
        this.logger.log('warn', 'disk-guard', 'free space below 1GiB; triggering retention', {
          freeBytes,
        });
        this.runRetention();
      }
      // Spec §3.25: «сначала запускается retention. Если всё ещё < 1 GiB» —
      // the pause decision uses a FRESH statfs sample taken after the
      // inline sweep above completed.
      const rechecked = this.sample();
      if (rechecked === null) return this.state;
      freeBytes = rechecked;
      if (freeBytes < this.lowBytes) {
        this.state = 'paused';
        this.logger.log('warn', 'disk-guard', 'disk pressure: recording paused', { freeBytes });
        this.onRecordingStateChanged?.(true, 'disk_pressure');
      } else {
        // Retention freed enough space: the episode ends here, so the NEXT
        // low episode attempts retention first again (spec §3.25).
        this.retentionFiredForEpisode = false;
        this.logger.log('info', 'disk-guard', 'retention freed enough space; recording continues', {
          freeBytes,
        });
      }
      return this.state;
    }

    if (this.state === 'paused' && freeBytes >= this.resumeBytes) {
      // Fail-safe mirror of the pause branch: broadcast FIRST, flip state only
      // on success. If the resume broadcast throws, staying paused keeps gate
      // and recorder consistent and the next tick retries the resume.
      this.onRecordingStateChanged?.(false);
      this.state = 'ok';
      this.retentionFiredForEpisode = false;
      this.logger.log('info', 'disk-guard', 'disk recovered past hysteresis; recording resumes', {
        freeBytes,
      });
    }
    return this.state;
  }

  /**
   * Ingest gate (brief-m7 §D7 item 3): ok while not paused; when paused the
   * batch is refused with the typed wire error so the recorder spools instead
   * of losing events. Awaiting evaluate() means a first-in-episode low probe
   * finishes the retention sweep before the verdict samples free space.
   */
  async gateBatch(): Promise<{ ok: true } | { ok: false; code: 'error.disk_pressure'; message: string }> {
    await this.evaluate();
    return this.state === 'paused'
      ? { ok: false, code: 'error.disk_pressure', message: 'disk pressure: recording paused, batch refused' }
      : { ok: true };
  }

  isPaused(): boolean {
    return this.state === 'paused';
  }

  /** Starts the 60s timer (unref'd; tests drive evaluate()/gateBatch() directly). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      // Fire-and-forget, but CONSUMED: the realistic throw path is a
      // synchronous exception from onRecordingStateChanged (IpcServer's
      // broadcastEvent throws TypeError on payload-schema mismatch); the
      // tick's logger.log calls are unguarded too, but only fail on
      // logger-internal faults. On the
      // gateBatch()/events.batch path either error is handled upstream; here it
      // would escape as an unhandled rejection and kill the daemon exactly
      // under disk pressure. Each tick still completes its own inline sweep
      // before sampling; nothing consumes the returned state.
      this.evaluate().catch((err: unknown) => {
        this.logger.log('error', 'disk-guard', 'retention tick failed', {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
