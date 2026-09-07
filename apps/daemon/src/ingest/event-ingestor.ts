import { TypeCompiler } from '@sinclair/typebox/compiler';

import { ActivityEventSchema, type ActivityEvent, type EventBatch } from '@computer-history/protocol';
import { CONSTANTS } from '../config.js';
import type { EventsRepository } from '../db/events-repository.js';
import { replaceWellFormedTarget } from '../util/text.js';
import type { Logger } from '../logging.js';
import { privacyRejection, type RejectionReason } from './validation.js';

export interface BatchOutcome {
  accepted: number;
  duplicates: number;
  rejected: number;
}

export type ReasonHistogram = Partial<Record<RejectionReason, number>>;

/**
 * M2 seam (brief D1 §2): notified with watermark-eligible events after each
 * debounced post-ack sweep. The real SegmenterCoordinator arrives in M2; the
 * no-op implementation keeps the pipeline observable end-to-end today.
 */
export interface SegmenterCoordinator {
  onEventsEligible(events: readonly ActivityEvent[]): void | Promise<void>;
}

/** No-op seam implementation until M2 lands the real segmenter. */
export class NoopSegmenterCoordinator implements SegmenterCoordinator {
  onEventsEligible(_events: readonly ActivityEvent[]): void {}
}

export interface EventIngestorOptions {
  repository: EventsRepository;
  logger: Logger;
  coordinator?: SegmenterCoordinator;
  /** Injectable wall clock for deterministic watermark tests. */
  now?: () => number;
  watermarkLagMs?: number;
  debounceMs?: number;
  sweepLimit?: number;
  /** Backoff before a failed sweep is retried; defaults to CONSTANTS.watermarkSweepRetryMs. */
  sweepRetryMs?: number;
}

// Compiled once per process; every inbound event runs through this check.
const activityEventCheck = TypeCompiler.Compile(ActivityEventSchema as never);

function bump(reasons: ReasonHistogram, reason: RejectionReason): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/**
 * Issue W2: lone UTF-16 surrogates pass TypeBox and round-trip through
 * SQLite, but Swift's JSONDecoder rejects the whole downstream frame at
 * parse time — so every persisted text field is sanitized at this boundary.
 * Returns the original object untouched when nothing needed replacing (the
 * hot path allocates nothing beyond the scan).
 */
function sanitizeEventText(event: ActivityEvent): ActivityEvent {
  const bundleId = replaceWellFormedTarget(event.app.bundleId);
  const appName = event.app.name === undefined ? undefined : replaceWellFormedTarget(event.app.name);
  const windowTitle =
    event.window?.title === undefined ? undefined : replaceWellFormedTarget(event.window.title);
  const role = event.target?.role === undefined ? undefined : replaceWellFormedTarget(event.target.role);
  const subrole =
    event.target?.subrole === undefined ? undefined : replaceWellFormedTarget(event.target.subrole);
  const label = event.target?.label === undefined ? undefined : replaceWellFormedTarget(event.target.label);
  const identifier =
    event.target?.identifier === undefined
      ? undefined
      : replaceWellFormedTarget(event.target.identifier);
  const content = typeof event.content === 'string' ? replaceWellFormedTarget(event.content) : event.content;
  if (
    bundleId === event.app.bundleId &&
    appName === event.app.name &&
    windowTitle === event.window?.title &&
    role === event.target?.role &&
    subrole === event.target?.subrole &&
    label === event.target?.label &&
    identifier === event.target?.identifier &&
    content === event.content
  ) {
    return event;
  }
  return {
    ...event,
    app: { ...event.app, bundleId, name: appName },
    window: windowTitle === event.window?.title ? event.window : { ...event.window, title: windowTitle },
    target:
      (role === event.target?.role &&
        subrole === event.target?.subrole &&
        label === event.target?.label &&
        identifier === event.target?.identifier) ||
      event.target === undefined
        ? event.target
        : { ...event.target, role, subrole, label, identifier },
    content,
  };
}

/**
 * Per-batch ingest pipeline (spec §3.11): TypeBox validation → privacy
 * invariant enforcement → transactional INSERT OR IGNORE → ack counts →
 * debounced watermark sweep notifying the SegmenterCoordinator.
 *
 * Privacy double-enforcement (contracts §Testing conventions): the recorder's
 * PrivacyFilter runs first; these daemon-side rejections are the second gate,
 * applied here AND again inside EventsRepository.insertBatch (defense in
 * depth). A batch is ALWAYS acknowledged, even when every event was rejected.
 */
export class EventIngestor {
  private readonly repository: EventsRepository;
  private readonly logger: Logger;
  private readonly coordinator: SegmenterCoordinator;
  private readonly now: () => number;
  private readonly watermarkLagMs: number;
  private readonly debounceMs: number;
  private readonly sweepLimit: number;
  private readonly sweepRetryMs: number;
  private pendingSweep: NodeJS.Timeout | null = null;
  // Round-33 audit (teardown ordering): latched on drainForShutdown entry.
  // SegmenterCoordinator.onEventsEligible is typed void | Promise<void>, so a
  // future async coordinator yields to the timer queue mid-drain — without the
  // latch an armed debounce/retry timer would fire runSweep concurrently with
  // the drain loop and hand the coordinator overlapping pages (duplicate
  // segments). dispose() cancels only the currently armed timer; this latch
  // also closes ingest()-traffic and retry re-arms during the drain.
  // Round-34 residual: an armed-but-not-yet-fired timer is not the only
  // overlap window. A sweep dispatched BEFORE the latch can still be parked
  // inside a pending `await this.coordinator.onEventsEligible(...)` when the
  // drain enters; for any async coordinator the drain would then re-fetch and
  // re-deliver the same rows. The in-flight delivery promise below closes it.
  private draining = false;
  private loggedDrainLatch = false;
  // Round-35 residual: a single slot tracked only the newest delivery — a
  // second sweep (full-page re-arm or ingest debounce) could park alongside
  // the first and overwrite the slot, so drainForShutdown awaited only the
  // newest while the older sweep stayed parked. Track every parked delivery.
  private readonly inFlightSweeps = new Set<Promise<void>>();
  // Round-36 audit (dispose-without-drain corner): after dispose() a
  // coordinator rejection re-arms via scheduleSweepIn, and each later tick
  // would throw on the closed repo, log, and re-arm — an infinite retry
  // loop. Latch all future re-arms once dispose() ran.
  private disposed = false;

  constructor(options: EventIngestorOptions) {
    this.repository = options.repository;
    this.logger = options.logger;
    this.coordinator = options.coordinator ?? new NoopSegmenterCoordinator();
    this.now = options.now ?? Date.now;
    this.watermarkLagMs = options.watermarkLagMs ?? CONSTANTS.watermarkLagMs;
    this.debounceMs = options.debounceMs ?? CONSTANTS.watermarkSweepDebounceMs;
    this.sweepLimit = options.sweepLimit ?? CONSTANTS.watermarkSweepLimit;
    this.sweepRetryMs = options.sweepRetryMs ?? CONSTANTS.watermarkSweepRetryMs;
  }

  /** Validates + inserts one wire batch; returns the ack counts. */
  ingest(batch: EventBatch): BatchOutcome {
    const reasons: ReasonHistogram = {};
    const insertable: ActivityEvent[] = [];
    for (const event of batch.events) {
      // Sanitize BEFORE validation/privacy: a lone surrogate is not part of
      // any privacy rule's needle set, but it must never reach SQLite
      // (issue W2: Swift JSONDecoder drops whole frames on lone surrogates).
      const checked = sanitizeEventText(event);
      // Invariant (d): contentPolicy enum validity is part of the wire schema.
      const reason = activityEventCheck.Check(checked) ? privacyRejection(checked) : 'schema_invalid';
      if (reason === null) insertable.push(checked);
      else bump(reasons, reason);
    }
    const inserted = this.repository.insertBatch(insertable);
    for (const [reason, n] of Object.entries(inserted.reasons) as [RejectionReason, number][]) {
      reasons[reason] = (reasons[reason] ?? 0) + n;
    }
    const outcome: BatchOutcome = {
      accepted: inserted.accepted,
      duplicates: inserted.duplicates,
      rejected: batch.events.length - inserted.accepted - inserted.duplicates,
    };

    // Structured JSONL batch stats: counts only, never content or titles.
    this.logger.log('info', 'ingest', 'batch processed', {
      batchId: batch.batchId,
      received: batch.events.length,
      ...outcome,
      ...(outcome.rejected > 0 ? { reasons: { ...reasons } } : {}),
    });

    this.scheduleWatermarkSweep();
    return outcome;
  }

  /**
   * Debounced (500ms) post-ack sweep: fetch unprocessed events older than
   * now − watermarkLagMs in canonical order and hand them to the coordinator.
   */
  private scheduleWatermarkSweep(): void {
    this.scheduleSweepIn(this.debounceMs);
  }

  /** Warns once; the drain can trip the latch from several re-arm paths. */
  private logDrainLatch(): void {
    if (this.loggedDrainLatch) return;
    this.loggedDrainLatch = true;
    this.logger.log('info', 'ingest', 'watermark sweep suppressed during shutdown drain');
  }

  private scheduleSweepIn(delayMs: number): void {
    // Silent: the drain-latch log line would mislead here — nothing is
    // draining; the ingestor is simply torn down.
    if (this.disposed) return;
    if (this.draining) {
      this.logDrainLatch();
      return;
    }
    if (this.pendingSweep !== null) clearTimeout(this.pendingSweep);
    this.pendingSweep = setTimeout(() => {
      this.pendingSweep = null;
      this.runSweep();
    }, delayMs);
    this.pendingSweep.unref();
  }

  private runSweep(): void {
    // An armed timer that slips past the latch (armed before drainForShutdown
    // entered) must stay inert: the drain loop already owns the eligible set.
    if (this.draining) {
      this.logDrainLatch();
      return;
    }
    // Round-36 audit: a still-parked delivery owns the current eligible
    // rows — fetching them now would hand the coordinator overlapping pages
    // (duplicate segments, the round-35 class), and on a never-settling
    // coordinator the full-page re-arm below would park a fresh delivery
    // every cycle: unbounded Set/page accumulation, and drainForShutdown
    // would block exit forever. Zero behavior change today: the real
    // SegmenterCoordinator is synchronous, so a delivery always settles
    // before any timer macrotask can fire. The skip's own re-arm replaces
    // the skipped full-page re-arm.
    if (this.inFlightSweeps.size > 0) {
      this.scheduleSweepIn(this.debounceMs);
      return;
    }
    // Timer-tick context: main.ts has no uncaughtException handler, so any
    // throw here (SQLITE_BUSY/IOERR from the page fetch) would kill the
    // daemon — and a persistent failure would crash-loop it on restart.
    let eligible: ActivityEvent[];
    try {
      eligible = this.repository.fetchUnprocessed(
        this.now() - this.watermarkLagMs,
        this.sweepLimit,
        (id, errorMessage) =>
          this.logger.log('error', 'ingest', 'watermark sweep quarantined poison row', {
            id,
            errorMessage,
          }),
      );
    } catch (err) {
      this.logger.log('error', 'ingest', 'watermark sweep failed', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // One-shot retry: re-arm via the same sweep timer with a backoff so a
      // quiet backlog (no ingest traffic) still drains once the transient
      // SQLITE_BUSY/IOERR heals. Each failure schedules at most one retry, so
      // a persistent failure retries at this cadence instead of crash-looping.
      this.scheduleSweepIn(this.sweepRetryMs);
      return;
    }
    if (eligible.length > 0) {
      // Timer-tick context: a failing coordinator (e.g. SQLITE_FULL/IOERR from
      // the segmenter's apply transaction) must not escape as an uncaught
      // exception — main.ts has no uncaughtException handler.
      // Round-34 residual: track the parked delivery so drainForShutdown can
      // await it before fetching its own page — otherwise an async
      // coordinator gets this page re-delivered by the drain (duplicates).
      const delivery = (async (): Promise<void> => {
        try {
          await this.coordinator.onEventsEligible(eligible);
        } catch (err) {
          this.logger.log('error', 'ingest', 'watermark sweep coordinator failed', {
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          // Round-32 audit: the only other re-arm paths are ingest() traffic
          // and the full-page re-arm below (skipped when eligible.length <
          // sweepLimit), so a coordinator failure during quiet hours used to
          // strand these rows forever. Re-arm via the same one-shot retry
          // backoff as the fetch-failure path above. scheduleSweepIn replaces
          // any timer the full-page re-arm armed, so this can never double-arm.
          this.scheduleSweepIn(this.sweepRetryMs);
        }
      })();
      this.inFlightSweeps.add(delivery);
      // The IIFE never rejects (internal catch): no unhandled-rejection risk.
      void delivery.finally(() => {
        // Delete-by-value: Set semantics need no identity guard.
        this.inFlightSweeps.delete(delivery);
      });
    }
    if (eligible.length === this.sweepLimit) {
      // Full page: more watermark-eligible rows likely remain. Re-arm so the
      // backlog self-drains without waiting for unrelated future ingest
      // traffic to debounce another sweep.
      this.scheduleWatermarkSweep();
    }
  }

  /**
   * Final teardown drain (round-32 audit): dispose() cancels the debounced
   * sweep and finalizeForShutdown() never touches raw_events, so without this
   * pass every event inside the last watermark-lag + debounce window would
   * stay processed_at_ms NULL forever — purgeOlderThan spares unprocessed
   * rows (permanent zombie growth) and a restart resurfaces them as per-event
   * 1-step straggler segments with inverted chronology. Cutoff = now() waives
   * the lag: at shutdown nothing is "too fresh" anymore. Failure-tolerant by
   * contract: logs and resolves — main.ts must never block exit on the drain.
   */
  async drainForShutdown(): Promise<void> {
    // Idempotent: main.ts's shuttingDown guard is the primary defense, but a
    // second call must never re-enter the loop — the coordinator would see
    // overlapping pages of the same rows (duplicate segments).
    if (this.draining) return;
    this.draining = true;
    // Round-34 residual: a sweep dispatched before the latch may still be
    // parked inside onEventsEligible; awaiting it ensures the drain's fetch
    // cannot overlap its page. Round-35: several sweeps can be parked
    // concurrently (full-page re-arm or ingest debounce firing while an
    // earlier delivery is still parked), so await ALL of them. A snapshot
    // after the latch suffices: runSweep is latch-inert, so no entry can be
    // added past this point, and the IIFE's catch-path re-arm
    // (scheduleSweepIn) is likewise latch-inert.
    await Promise.all([...this.inFlightSweeps]);
    try {
      let previousIds: readonly string[] | null = null;
      for (;;) {
        const eligible = this.repository.fetchUnprocessed(
          this.now(),
          this.sweepLimit,
          (id, errorMessage) =>
            this.logger.log('error', 'ingest', 'watermark sweep quarantined poison row', {
              id,
              errorMessage,
            }),
        );
        const ids = eligible.map((e) => e.id);
        // A coordinator that consumes nothing (succeeds but marks no rows)
        // would otherwise spin the full-page loop forever mid-shutdown.
        const previous: readonly string[] | null = previousIds;
        const stalled =
          previous !== null &&
          ids.length === previous.length &&
          ids.every((id, i) => id === previous[i]);
        if (stalled) {
          this.logger.log('warn', 'ingest', 'shutdown drain made no progress; leaving rows for next boot');
          return;
        }
        previousIds = ids;
        if (eligible.length > 0) await this.coordinator.onEventsEligible(eligible);
        if (eligible.length < this.sweepLimit) return;
      }
    } catch (err) {
      this.logger.log('error', 'ingest', 'shutdown drain failed; unprocessed rows survive for next boot', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Cancels any pending debounced sweep; called on graceful shutdown. */
  dispose(): void {
    this.disposed = true;
    if (this.pendingSweep !== null) {
      clearTimeout(this.pendingSweep);
      this.pendingSweep = null;
    }
  }
}
