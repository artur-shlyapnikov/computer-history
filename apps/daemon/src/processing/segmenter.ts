import type { ActivityEvent } from '@computer-history/protocol';

import { CONSTANTS } from '../config.js';
import type { Db } from '../db/database.js';
import type { EventsRepository } from '../db/events-repository.js';
import type { JobsRepository } from '../db/jobs-repository.js';
import { SegmentsRepository, type SegmentRow } from '../db/segments-repository.js';
import type { Logger } from '../logging.js';
import type { SegmenterCoordinator } from '../ingest/event-ingestor.js';
import { coalesceEvents, compareEvents, type CoalescedStep } from './event-coalescer.js';

export interface SegmenterOptions {
  events: EventsRepository;
  segments: SegmentsRepository;
  jobs: JobsRepository;
  /** Shared SQLite handle; the apply and close phases each commit in one transaction (ReviewM2d F1/F2). */
  db: Db;
  logger: Logger;
  /** Injectable clock (contracts §Testing conventions); wall clock by default. */
  now?: () => number;
  /** Idle close threshold; pinned default 300_000 ms (spec §3.13). */
  idleCloseMs?: number;
  /** Max segment duration; pinned default 1_800_000 ms (spec §3.13). */
  maxDurationMs?: number;
  /** Straggler tolerance for late-arrival closes; pinned default 2_000 ms. */
  watermarkLagMs?: number;
  /**
   * Invoked after closeSegment commits its summarize_segment enqueue (SVC-03):
   * enqueue-side transitions must reach connected recorders as queue_update
   * immediately, not on the worker's next claim. Daemon wires this to the
   * same JobsRepository-backed counter emit as JobWorker.onQueueUpdate.
   */
  onJobEnqueued?: () => void;
}

interface OpenSegment {
  row: SegmentRow;
  /** Timestamp of the most recent activity folded into the segment. */
  lastActivityMs: number;
  lastEventId: string | null;
}

interface DroppedGroup {
  /** Index of the first step starting after these drops (steps.length when trailing). */
  beforeStep: number;
  events: ActivityEvent[];
}

/**
 * Events the coalescer consumed without folding into any step (focus-noise
 * drops). A coalesced step always folds a contiguous ascending run of the
 * sorted batch, delimited by its first/last event ids, so every index outside
 * those runs is a drop. Groups are chronological and each carries the step
 * index it precedes, letting applyTx interleave drops into the sweep.
 */
function groupDroppedEvents(
  sorted: readonly ActivityEvent[],
  steps: readonly CoalescedStep[],
): DroppedGroup[] {
  let folded = 0;
  for (const step of steps) folded += step.eventCount;
  if (folded === sorted.length) return [];

  const indexOfId = new Map(sorted.map((event, i) => [event.id, i] as const));
  const spans = steps.map((step) => {
    const start = indexOfId.get(step.firstEventId);
    const end = indexOfId.get(step.lastEventId);
    if (start === undefined || end === undefined || end < start) {
      throw new Error(`coalesced step span ${step.firstEventId}..${step.lastEventId} missing from batch`);
    }
    return [start, end] as const;
  });

  const groups: DroppedGroup[] = [];
  let si = 0;
  for (const [i, event] of sorted.entries()) {
    let span = spans[si];
    while (span !== undefined && i > span[1]) {
      si++;
      span = spans[si];
    }
    if (span !== undefined && i >= span[0]) continue; // folded into steps[si]
    const last = groups[groups.length - 1];
    if (last !== undefined && last.beforeStep === si) last.events.push(event);
    else groups.push({ beforeStep: si, events: [event] });
  }
  return groups;
}

/**
 * Turns watermark-eligible raw events into semantic steps inside activity
 * segments (spec §3.12–3.13, brief-m2 §D2 items 3–4, 8).
 *
 * One open activity_segment exists globally. A segment closes — and a
 * summarize_segment job is enqueued exactly once (summarize_job_id dedupe
 * guard) — when idle ≥ 5 minutes, duration ≥ 30 minutes, or on graceful
 * shutdown. Midnight is NOT a boundary: only event-timestamp gaps matter.
 */
export class Segmenter implements SegmenterCoordinator {
  private readonly events: EventsRepository;
  private readonly onJobEnqueued?: () => void;
  private readonly segments: SegmentsRepository;
  private readonly jobs: JobsRepository;
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idleCloseMs: number;
  private readonly maxDurationMs: number;
  private readonly watermarkLagMs: number;
  private readonly applyTx: (sorted: readonly ActivityEvent[], steps: readonly CoalescedStep[]) => void;
  private readonly closeTx: (
    segmentId: string,
    endedAtMs: number,
    lastEventId: string | undefined,
    now: number,
  ) => string;
  private openSegment: OpenSegment | null = null;
  constructor(options: SegmenterOptions) {
    this.db = options.db;
    this.onJobEnqueued = options.onJobEnqueued;
    this.events = options.events;
    this.segments = options.segments;
    this.jobs = options.jobs;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idleCloseMs = options.idleCloseMs ?? CONSTANTS.segmentIdleCloseMs;
    this.maxDurationMs = options.maxDurationMs ?? CONSTANTS.segmentMaxDurationMs;
    this.watermarkLagMs = options.watermarkLagMs ?? CONSTANTS.watermarkLagMs;

    // ReviewM2d F1: the entire apply phase (step inserts + markProcessed of
    // this batch) commits atomically — a crash mid-apply can no longer leave
    // inserted steps behind unprocessed events, which would re-coalesce into
    // duplicates on the next sweep.
    this.applyTx = this.db.transaction(
      (sorted: readonly ActivityEvent[], steps: readonly CoalescedStep[]) => {
        // Focus-noise drops never become steps but are consumed and still
        // marked processed. Attribute each one chronologically: it tallies
        // against the segment window open at its own timestamp under the same
        // close/create boundaries the step sweep applies, so a batch that
        // crosses a boundary cannot inflate — or lose track of — whichever
        // segment happens to be open at end-of-batch.
        const droppedGroups = groupDroppedEvents(sorted, steps);
        let groupIdx = 0;
        /** Drops seen while no window was open; land in the next window this batch opens. */
        let orphaned: ActivityEvent[] = [];
        /** Last segment this batch appended to, created, or tallied; null until then. */
        let lastTouchedId: string | null = null;

        const tallyDrop = (event: ActivityEvent): void => {
          const open = this.settleBoundary(event.observedAt);
          if (open === null) {
            orphaned.push(event);
            return;
          }
          // Drops never advance last_event_id; watermarking stays step-driven.
          this.segments.tallyEvents(open.row.id, 1, null);
          lastTouchedId = open.row.id;
        };

        for (const [k, step] of steps.entries()) {
          const preceding =
            groupIdx < droppedGroups.length && droppedGroups[groupIdx]?.beforeStep === k
              ? droppedGroups[groupIdx++]
              : undefined;
          if (preceding !== undefined) {
            for (const event of preceding.events) tallyDrop(event);
          }
          this.append(step, orphaned);
          orphaned = [];
          lastTouchedId = this.openSegment?.row.id ?? lastTouchedId;
        }
        const trailing =
          groupIdx < droppedGroups.length ? droppedGroups[groupIdx++] : undefined;
        if (trailing !== undefined) {
          for (const event of trailing.events) tallyDrop(event);
        }
        // A batch that touched at least one window may not lose its tail
        // drops: they land in the last real window it touched. Only a batch
        // that creates no segment at all may leave drops unattributed.
        if (orphaned.length > 0 && lastTouchedId !== null) {
          this.segments.tallyEvents(lastTouchedId, orphaned.length, null);
        }

        this.events.markProcessed(
          sorted.map((e) => e.id),
          this.now(),
        );
      },
    );

    // ReviewM2d F2: enqueue → finalize → setSummarizeJobId commit as one
    // transaction, so a crash can no longer strand an open segment with a
    // pending job (re-close ⇒ duplicate summarize_segment) or a finalized
    // segment with a null marker forever.
    this.closeTx = this.db.transaction(
      (segmentId: string, endedAtMs: number, lastEventId: string | undefined, now: number): string => {
        const job = this.jobs.enqueueTyped('summarize_segment', { segmentId }, now, now);
        this.segments.finalize(segmentId, 'finalized', endedAtMs, { lastEventId });
        this.segments.setSummarizeJobId(segmentId, job.id);
        return job.id;
      },
    );
  }

  /**
   * Pipeline entry wired as the ingestor's coordinator (debounced sweep, lag
   * 2000ms upstream). Events arrive canonically ordered from SQL; the sort is
   * repeated defensively because the contract requires it regardless of caller.
   */
  onEventsEligible(events: readonly ActivityEvent[]): void {
    if (events.length === 0) return;
    const sorted = [...events].sort(compareEvents);
    const steps = coalesceEvents(sorted);
    try {
      this.applyTx(sorted, steps);
    } catch (err) {
      // The transaction rolled back, so the cached handle may point at rows
      // that never committed; re-hydrate from SQLite on the next sweep.
      this.openSegment = null;
      throw err;
    }
  }

  /** Graceful shutdown hook: finalize the open segment (spec §3.13). */
  finalizeForShutdown(): string | null {
    const open = this.current();
    if (open === null) return null;
    this.logger.log('info', 'segmenter', 'finalizing open segment for shutdown', {
      segmentId: open.row.id,
    });
    this.closeSegment(open);
    return open.row.id;
  }

  /** Currently cached open segment, hydrated from SQLite on first touch. */
  private current(): OpenSegment | null {
    if (this.openSegment !== null) return this.openSegment;
    const row = this.segments.getOpenSegment();
    if (row === null) return null;
    this.openSegment = {
      row,
      lastActivityMs: this.segments.lastStepActivityMs(row.id) ?? row.started_at_ms,
      lastEventId: row.last_event_id,
    };
    return this.openSegment;
  }

  private append(step: CoalescedStep, orphanedDrops: readonly ActivityEvent[]): void {
    let open = this.settleBoundary(step.startedAtMs);
    if (open === null) {
      open = this.createFor(step);
    }
    // Drops orphaned earlier in this batch precede the step chronologically
    // and belong to the window it just opened.
    if (orphanedDrops.length > 0) {
      this.segments.tallyEvents(open.row.id, orphanedDrops.length, null);
    }

    this.segments.appendStep(open.row.id, step, {
      text: step.text,
      target: step.target,
      appName: step.appName,
    });
    this.segments.tallyEvents(open.row.id, step.eventCount, step.lastEventId);
    open.lastActivityMs = step.endedAtMs;
    open.lastEventId = step.lastEventId;
  }

  /**
   * Close boundaries applied to an incoming activity timestamp: idle ≥
   * threshold since last activity, else total duration ≥ max. Returns the
   * still-open segment, or null once the timestamp lies beyond a closed
   * boundary.
   */
  private settleBoundary(atMs: number): OpenSegment | null {
    let open = this.current();
    if (open !== null && atMs < open.lastActivityMs - this.watermarkLagMs) {
      // Late arrival: the watermark sweep can deliver events older than the
      // open segment's last activity (recorder retry/reconnect replays an
      // older batch after newer events were swept). Appending would make
      // semantic_steps non-chronological and skew summarizer time ranges —
      // close the segment and let the straggler open a fresh one.
      // semantic_steps carries no monotonic timestamp, so a backward wall
      // clock step (NTP correction) is indistinguishable from a straggler by
      // ordering alone; only regressions beyond the watermark lag (2s) count
      // as genuine stragglers. Smaller corrections append in place, keeping
      // one NTP step from fragmenting a healthy segment.
      this.closeSegment(open);
      open = null;
    }
    if (open !== null && atMs - open.lastActivityMs >= this.idleCloseMs) {
      this.closeSegment(open);
      open = null;
    }
    if (open !== null && atMs - open.row.started_at_ms >= this.maxDurationMs) {
      this.closeSegment(open);
      open = null;
    }
    return open;
  }

  private createFor(step: CoalescedStep): OpenSegment {
    const row = this.segments.createOpen(step.startedAtMs, step.firstEventId, this.now());
    const open: OpenSegment = { row, lastActivityMs: step.startedAtMs, lastEventId: null };
    this.openSegment = open;
    return open;
  }

  /**
   * Finalize + enqueue summarize_segment exactly once, in one transaction
   * (ReviewM2d F2). The summarize_job_id guard makes a repeat call (crash
   * recovery, double shutdown signal) a no-op instead of a second job
   * (brief-m2 §D2 item 4).
   */
  private closeSegment(open: OpenSegment): void {
    this.openSegment = null;
    const fresh = this.segments.getSegment(open.row.id);
    if (fresh === null || fresh.state !== 'open' || fresh.summarize_job_id !== null) {
      return;
    }
    const now = this.now();
    const jobId = this.closeTx(fresh.id, open.lastActivityMs, open.lastEventId ?? undefined, now);
    this.logger.log('info', 'segmenter', 'activity segment finalized', {
      segmentId: fresh.id,
      summarizeJobId: jobId,
      eventCount: fresh.event_count,
    });
    this.onJobEnqueued?.();
  }
}
