
import { describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import type { ActivityEvent } from '@computer-history/protocol';

import { CONSTANTS } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import type { Logger } from '../src/logging.js';
import { Segmenter } from '../src/processing/segmenter.js';

const T0 = 1_700_000_000_000;

function makeEvent(observedAt: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(Math.max(observedAt, 1)),
    observedAt,
    monotonicNs: observedAt * 1_000,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    window: { title: 'Doc' },
    action: 'text_change',
    target: { role: 'AXTextArea', identifier: 'body' },
    content: `text-${observedAt}`,
    contentPolicy: 'allow',
    ...overrides,
  };
}

interface Harness {
  db: Db;
  events: EventsRepository;
  segments: SegmentsRepository;
  jobs: JobsRepository;
  segmenter: Segmenter;
  clock: { now: number };
  logLines: Array<Record<string, unknown>>;
}

function makeHarness(idleCloseMs?: number, maxDurationMs?: number): Harness {
  const db = openDatabase(':memory:');
  migrate(db);
  const events = new EventsRepository(db);
  const segments = new SegmentsRepository(db);
  const jobs = new JobsRepository(db);
  const clock = { now: T0 };
  const logLines: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    log: (_level, _scope, message, fields) => {
      logLines.push({ message, ...fields });
    },
    pruneOld: () => 0,
  };
  const segmenter = new Segmenter({
    db,
    events,
    segments,
    jobs,
    logger,
    now: () => clock.now,
    idleCloseMs,
    maxDurationMs,
  });
  return { db, events, segments, jobs, segmenter, clock, logLines };
}

describe('Segmenter lifecycle (spec §3.13 exact numbers)', () => {
  it('opens a single global segment on first events and marks them processed', () => {
    const h = makeHarness();
    const events = [makeEvent(T0), makeEvent(T0 + 1_000)];
    for (const e of events) h.events.insertBatch([e]);
    h.segmenter.onEventsEligible(events);

    const open = h.segments.getOpenSegment();
    expect(open).not.toBeNull();
    expect(open?.state).toBe('open');
    expect(open?.started_at_ms).toBe(T0);
    expect(open?.first_event_id).toBe(events[0]?.id);
    expect(h.segments.stepCount(open!.id)).toBe(1);

    const rows = h.db.prepare('SELECT processed_at_ms FROM raw_events ORDER BY observed_at_ms').all() as {
      processed_at_ms: number | null;
    }[];
    expect(rows.every((r) => r.processed_at_ms !== null)).toBe(true);
    h.db.close();
  });

  it('keeps one step when idle stays just inside the 300000ms boundary', () => {
    const h = makeHarness();
    const first = makeEvent(T0);
    const second = makeEvent(T0 + CONSTANTS.segmentIdleCloseMs - 1);
    h.events.insertBatch([first, second]);
    h.segmenter.onEventsEligible([first, second]);

    expect(h.segments.getOpenSegment()?.started_at_ms).toBe(T0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM activity_segments').get()).toEqual({ n: 1 });
    expect(h.jobs.countsByState().pending).toBe(0);
    h.db.close();
  });

  it('closes on idle ≥300000ms, enqueues exactly one summarize_segment job with payload, opens a fresh segment', () => {
    const h = makeHarness();
    const first = makeEvent(T0);
    const later = makeEvent(T0 + CONSTANTS.segmentIdleCloseMs);
    h.events.insertBatch([first]);
    h.segmenter.onEventsEligible([first]);

    h.clock.now = T0 + 10;
    h.events.insertBatch([later]);
    h.segmenter.onEventsEligible([later]);

    const all = h.db.prepare('SELECT * FROM activity_segments ORDER BY started_at_ms').all() as Array<{
      id: string;
      state: string;
      started_at_ms: number;
      ended_at_ms: number | null;
      summarize_job_id: string | null;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0]?.state).toBe('finalized');
    // Ended at last activity before the gap, not at the closing event.
    expect(all[0]?.ended_at_ms).toBe(T0);
    expect(all[0]?.summarize_job_id).toBeTypeOf('string');
    expect(all[1]?.state).toBe('open');
    expect(all[1]?.started_at_ms).toBe(T0 + CONSTANTS.segmentIdleCloseMs);

    const jobRows = h.db
      .prepare("SELECT id, type, state, payload_json FROM jobs WHERE type = 'summarize_segment'")
      .all() as Array<{ id: string; state: string; payload_json: string }>;
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.state).toBe('pending');
    expect(JSON.parse(jobRows[0]?.payload_json ?? '{}')).toEqual({ segmentId: all[0]?.id });
    expect(jobRows[0]?.id).toBe(all[0]?.summarize_job_id);
    h.db.close();
  });

  it('closes the open segment when a delivered event is OLDER than its last activity; straggler opens a fresh segment', () => {
    const h = makeHarness();
    // Two chronological events open one segment whose lastActivityMs = T0+1000.
    const first = makeEvent(T0);
    const second = makeEvent(T0 + 1_000);
    h.events.insertBatch([first, second]);
    h.segmenter.onEventsEligible([first, second]);
    const openBefore = h.segments.getOpenSegment();
    expect(openBefore?.started_at_ms).toBe(T0);

    // A later-swept but genuinely older event (watermark sweep / recorder
    // replay) must NOT be appended into the open segment: that would break
    // step chronology. Only regressions beyond the watermark lag (2s) count
    // as stragglers; smaller backward steps are NTP corrections and append in
    // place (see the backward-clock pin below). This one lands 3s behind the
    // open segment's last activity (T0+1000), so it closes it.
    const straggler = makeEvent(T0 - 2_000);
    h.events.insertBatch([straggler]);
    h.segmenter.onEventsEligible([straggler]);
    const all = h.db
      .prepare('SELECT * FROM activity_segments ORDER BY started_at_ms')
      .all() as Array<{
      id: string;
      state: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }>;
    expect(all).toHaveLength(2);
    // The straggler's segment starts earlier, so it sorts first.
    expect(all[0]?.started_at_ms).toBe(T0 - 2_000);
    expect(all[0]?.state).toBe('open');
    expect(all[1]?.id).toBe(openBefore?.id);
    expect(all[1]?.state).toBe('finalized');
    expect(all[1]?.ended_at_ms).toBe(T0 + 1_000);

    // No step may run backwards in time within either segment.
    const steps = h.db
      .prepare(
        'SELECT segment_id, ordinal, started_at_ms FROM semantic_steps ORDER BY segment_id, ordinal',
      )
      .all() as Array<{ segment_id: string; ordinal: number; started_at_ms: number }>;
    for (const [index, step] of steps.entries()) {
      const prev = steps[index - 1];
      if (prev && prev.segment_id === step.segment_id) {
        expect(step.started_at_ms).toBeGreaterThanOrEqual(prev.started_at_ms);
      }
    }
    // The straggler's activity belongs to the NEW segment, not the old one.
    expect(
      h.segments.getSteps(all[0]!.id).some((s) => s.startedAtMs === T0 - 2_000),
    ).toBe(true);
    h.db.close();
  });


  it('appends a small backward clock step (NTP correction) to the open segment without closing it', () => {
    const h = makeHarness();
    // A typing burst opens a segment whose lastActivityMs = T0+1000.
    const first = makeEvent(T0, { action: 'typing_activity', content: undefined });
    const second = makeEvent(T0 + 1_000, { action: 'typing_activity', content: undefined });
    h.events.insertBatch([first, second]);
    h.segmenter.onEventsEligible([first, second]);
    const openBefore = h.segments.getOpenSegment();
    expect(openBefore?.started_at_ms).toBe(T0);

    // A backward wall-clock correction lands 500ms behind the last activity —
    // inside the watermark-lag tolerance, so it must append in place instead
    // of fragmenting the healthy segment with a spurious close + summarize.
    const corrected = makeEvent(T0 + 500, { action: 'typing_activity', content: undefined });
    h.events.insertBatch([corrected]);
    h.segmenter.onEventsEligible([corrected]);

    const all = h.db.prepare('SELECT * FROM activity_segments').all() as Array<{
      id: string;
      state: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }>;
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(openBefore?.id);
    expect(all[0]?.state).toBe('open');
    expect(all[0]?.ended_at_ms).toBeNull();
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'summarize_segment'").get(),
    ).toEqual({ n: 0 });

    // The correction became its own step (no merge) with non-inverted bounds:
    // a single-event burst has startedAt == endedAt.
    const steps = h.segments.getSteps(all[0]!.id);
    const correctedStep = steps.find((s) => s.startedAtMs === T0 + 500);
    expect(correctedStep).toBeDefined();
    expect(correctedStep?.endedAtMs).toBe(correctedStep?.startedAtMs);
    h.db.close();
  });

  it('closes on duration ≥1800000ms even without an idle gap', () => {
    const h = makeHarness();
    // Steps every 200s: no gap ever exceeds the idle threshold.
    const stamps = [0, 200_000, 400_000, 600_000, 800_000, 1_000_000, 1_200_000, 1_400_000, 1_600_000];
    const events = stamps.map((s) => makeEvent(T0 + s));
    h.events.insertBatch(events);
    h.segmenter.onEventsEligible(events);
    expect(h.segments.getOpenSegment()).not.toBeNull();

    const crossing = makeEvent(T0 + 1_800_000);
    h.events.insertBatch([crossing]);
    h.segmenter.onEventsEligible([crossing]);

    const all = h.db.prepare('SELECT * FROM activity_segments ORDER BY started_at_ms').all() as Array<{
      state: string;
      started_at_ms: number;
      ended_at_ms: number | null;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0]?.state).toBe('finalized');
    expect(all[0]?.ended_at_ms).toBe(T0 + 1_600_000);
    expect(all[1]?.started_at_ms).toBe(T0 + 1_800_000);
    h.db.close();
  });

  it('treats midnight as a non-boundary: one segment spans the day flip', () => {
    const h = makeHarness();
    // Day boundary at a round multiple of 24h after T0.
    const midnight = Math.ceil(T0 / 86_400_000) * 86_400_000;
    const before = makeEvent(midnight - 60_000);
    const after = makeEvent(midnight + 60_000);
    h.events.insertBatch([before, after]);
    h.segmenter.onEventsEligible([before, after]);

    expect(h.db.prepare('SELECT COUNT(*) AS n FROM activity_segments').get()).toEqual({ n: 1 });
    const steps = h.db.prepare('SELECT started_at_ms FROM semantic_steps ORDER BY ordinal').all() as Array<{
      started_at_ms: number;
    }>;
    expect(steps.map((s) => s.started_at_ms)).toEqual([midnight - 60_000, midnight + 60_000]);
    h.db.close();
  });

  it('finalizes the open segment on graceful shutdown and never double-enqueues', () => {
    const h = makeHarness();
    const events = [makeEvent(T0), makeEvent(T0 + 500)];
    h.events.insertBatch(events);
    h.segmenter.onEventsEligible(events);

    h.clock.now = T0 + 9_999;
    const closedId = h.segmenter.finalizeForShutdown();
    expect(closedId).toBeTypeOf('string');

    const seg = h.segments.getSegment(closedId!);
    expect(seg?.state).toBe('finalized');
    expect(seg?.ended_at_ms).toBe(T0 + 500);

    // Second shutdown call is a no-op; no duplicate job, no state change.
    expect(h.segmenter.finalizeForShutdown()).toBeNull();
    expect(h.jobs.countsByState().pending).toBe(1);

    // New activity after shutdown starts a brand-new open segment.
    const next = makeEvent(T0 + 20_000);
    h.events.insertBatch([next]);
    h.segmenter.onEventsEligible([next]);
    const reopened = h.segments.getOpenSegment();
    expect(reopened?.id).not.toBe(closedId);
    h.db.close();
  });

  it('attributes focus-noise drops to the open segment raw-event total', () => {
    const h = makeHarness();
    const click = makeEvent(T0, { action: 'click', target: { role: 'AXButton', label: 'Send' }, content: null });
    const collapsedFocus = makeEvent(T0 + 100, {
      action: 'focus_change',
      target: { role: 'AXButton', label: 'Send' },
      content: null,
    });
    h.events.insertBatch([click, collapsedFocus]);
    h.segmenter.onEventsEligible([click, collapsedFocus]);

    const open = h.segments.getOpenSegment();
    expect(h.segments.stepCount(open!.id)).toBe(1); // click absorbed the focus
    expect(open!.event_count).toBe(2);
    h.db.close();
  });

  it('attributes noise drops across a close/create boundary chronologically', () => {
    const h = makeHarness(60_000);
    const buttonTarget = { role: 'AXButton', label: 'Menu' };
    const sidebarTarget = { role: 'AXButton', label: 'Sidebar' };
    // One batch crossing an idle boundary: drops on both sides of the close.
    const batch = [
      makeEvent(T0),
      makeEvent(T0 + 500),
      makeEvent(T0 + 1_000, { action: 'focus_change', target: buttonTarget, content: null }),
      // Focus-noise drop inside the old segment's window.
      makeEvent(T0 + 1_300, { action: 'focus_change', target: buttonTarget, content: null }),
      // Idle boundary: closes segment 1, opens segment 2.
      makeEvent(T0 + 61_000),
      makeEvent(T0 + 61_500, { action: 'focus_change', target: sidebarTarget, content: null }),
      // Focus-noise drop inside the new segment's window.
      makeEvent(T0 + 61_800, { action: 'focus_change', target: sidebarTarget, content: null }),
    ];
    h.events.insertBatch(batch);
    h.segmenter.onEventsEligible(batch);

    const all = h.db.prepare('SELECT * FROM activity_segments ORDER BY started_at_ms').all() as Array<{
      id: string;
      state: string;
      event_count: number;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0]?.state).toBe('finalized');
    expect(all[1]?.state).toBe('open');
    // Segment 1: two text edits + one focus step folded + its own-side drop.
    expect(all[0]?.event_count).toBe(4);
    // Segment 2: one text edit + one focus step folded + its own-side drop.
    expect(all[1]?.event_count).toBe(3);
    // Accounting identity: every raw event of the batch lands somewhere.
    expect((all[0]?.event_count ?? 0) + (all[1]?.event_count ?? 0)).toBe(batch.length);
    expect(h.segments.stepCount(all[0]!.id)).toBe(2);
    expect(h.segments.stepCount(all[1]!.id)).toBe(2);
    h.db.close();
  });

  it('keeps trailing noise drops after an end-of-batch close accounted', () => {
    const h = makeHarness(60_000);
    const seed = makeEvent(T0);
    h.events.insertBatch([seed]);
    h.segmenter.onEventsEligible([seed]);
    const segId = h.segments.getOpenSegment()!.id;

    // Batch whose first step closes the seeded segment and whose later step
    // closes that fresh segment again; the focus-noise drop between them lands
    // mid-batch inside the middle segment's window, so lump-tallying it onto
    // whichever segment is open at end-of-batch would inflate the last one.
    const buttonTarget = { role: 'AXButton', label: 'Menu' };
    const tail = [
      makeEvent(T0 + 61_000),
      makeEvent(T0 + 61_500, { action: 'focus_change', target: buttonTarget, content: null }),
      makeEvent(T0 + 61_800, { action: 'focus_change', target: buttonTarget, content: null }),
      makeEvent(T0 + 122_000),
    ];
    h.events.insertBatch(tail);
    h.segmenter.onEventsEligible(tail);

    const seeded = h.segments.getSegment(segId)!;
    expect(seeded.state).toBe('finalized');
    expect(seeded.event_count).toBe(1); // untouched by the tail batch's drops
    const rows = h.db
      .prepare('SELECT id, event_count FROM activity_segments ORDER BY started_at_ms')
      .all() as Array<{ id: string; event_count: number }>;
    // Chronological attribution: seed=1; segment 2 carries both its steps plus
    // the mid-batch drop (3); segment 3 carries only its own closing step (1).
    // Lump-tallying would shift the drop into segment 3 ([1, 2, 2]).
    expect(rows.map((r) => r.event_count)).toEqual([1, 3, 1]);
    // Accounting identity: every raw event of both batches lands somewhere.
    expect(rows.reduce((n, r) => n + r.event_count, 0)).toBe(5);
    expect(h.segments.stepCount(rows[1]!.id)).toBe(2);
    expect(h.segments.stepCount(rows[2]!.id)).toBe(1);
    h.db.close();
  });

  it('hydrates the pre-existing open segment from sqlite after restart', () => {
    const first = makeHarness();
    const early = makeEvent(T0);
    first.events.insertBatch([early]);
    first.segmenter.onEventsEligible([early]);
    const segId = first.segments.getOpenSegment()!.id;
    first.db.close();

    // A second Segmenter instance over the same logical store must adopt the
    // existing open segment instead of opening a second one.
    const db2 = openDatabase(':memory:');
    void db2;
    const resumed = makeHarness();
    const row = {
      id: segId,
      started_at_ms: T0,
      ended_at_ms: null,
      state: 'open' as const,
      first_event_id: early.id,
      last_event_id: early.id,
      event_count: 1,
      summarize_job_id: null,
      created_at_ms: T0,
    };
    resumed.db
      .prepare(
        `INSERT INTO activity_segments (id, started_at_ms, ended_at_ms, state, first_event_id, last_event_id, event_count, summarize_job_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.started_at_ms, row.ended_at_ms, row.state, row.first_event_id, row.last_event_id, row.event_count, row.summarize_job_id, row.created_at_ms);
    resumed.db
      .prepare(
        `INSERT INTO semantic_steps (id, segment_id, ordinal, started_at_ms, ended_at_ms, action, app_bundle_id, app_name, target, text, first_event_id, last_event_id, created_at_ms)
         VALUES ('step-1', ?, 1, ?, ?, 'edit_text', 'com.apple.Safari', 'Safari', 'body', 'seeded', ?, ?, ?)`,
      )
      .run(segId, T0, T0, early.id, early.id, T0);

    const next = makeEvent(T0 + 299_999); // still just inside the idle window vs seeded activity
    resumed.events.insertBatch([next]);
    resumed.segmenter.onEventsEligible([next]);
    expect(resumed.db.prepare('SELECT COUNT(*) AS n FROM activity_segments').get()).toEqual({ n: 1 });
    resumed.db.close();
  });

  it('logs one finalized line per close with counts only', () => {
    const h = makeHarness();
    const first = makeEvent(T0);
    const later = makeEvent(T0 + CONSTANTS.segmentIdleCloseMs);
    h.events.insertBatch([first, later]);
    h.segmenter.onEventsEligible([first, later]);
    const finalizeLines = h.logLines.filter((l) => l.message === 'activity segment finalized');
    expect(finalizeLines).toHaveLength(1);
    expect(Object.keys(finalizeLines[0] ?? {}).sort()).toEqual([
      'eventCount',
      'message',
      'segmentId',
      'summarizeJobId',
    ]);
    h.db.close();
  });
});

describe('Segmenter injected thresholds (test seam)', () => {
  it('honors injectable idle/duration overrides for deterministic tests', () => {
    const h = makeHarness(1_000, 10_000);
    const a = makeEvent(T0);
    h.events.insertBatch([a]);
    h.segmenter.onEventsEligible([a]);

    const b = makeEvent(T0 + 1_000);
    h.events.insertBatch([b]);
    h.segmenter.onEventsEligible([b]);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM activity_segments').get() as { n: number }).n).toBe(2);
    h.db.close();
  });
});


describe('Segmenter crash-atomicity (ReviewM2d F1/F2)', () => {
  const totalSteps = (h: Harness): number =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM semantic_steps').get() as { n: number }).n;
  const processedCount = (h: Harness): number =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NOT NULL').get() as {
      n: number;
    }).n;

  it('rolls back the whole apply phase when markProcessed fails, so a re-sweep creates no duplicates (F1)', () => {
    const h = makeHarness();
    const events = [makeEvent(T0), makeEvent(T0 + 1_000), makeEvent(T0 + 2_000)];
    for (const e of events) h.events.insertBatch([e]);

    // Inject a crash between the insert phase and markProcessed.
    vi.spyOn(h.events, 'markProcessed').mockImplementationOnce(() => {
      throw new Error('injected crash before markProcessed');
    });
    expect(() => h.segmenter.onEventsEligible(events)).toThrow('injected crash before markProcessed');

    // Nothing committed: no steps, no processed events, no open segment.
    expect(totalSteps(h)).toBe(0);
    expect(h.segments.getOpenSegment()).toBeNull();
    expect(processedCount(h)).toBe(0);

    // The next sweep re-coalesces the same events — applied exactly once.
    h.segmenter.onEventsEligible(events);
    const stepsAfterRecovery = totalSteps(h);
    expect(stepsAfterRecovery).toBeGreaterThan(0);
    expect(processedCount(h)).toBe(events.length);

    // Identical to a clean single sweep over the same events (no duplicates).
    const baseline = makeHarness();
    for (const e of events) baseline.events.insertBatch([e]);
    baseline.segmenter.onEventsEligible(events);
    expect(stepsAfterRecovery).toBe(totalSteps(baseline));
    h.db.close();
    baseline.db.close();
  });

  it('crash after enqueue before finalize strands nothing; re-close enqueues exactly one summarize_segment (F2)', () => {
    const h = makeHarness();
    const events = [makeEvent(T0), makeEvent(T0 + 1_000)];
    h.events.insertBatch(events);
    h.segmenter.onEventsEligible(events);

    // Inject a crash after enqueue succeeds but before finalize runs.
    vi.spyOn(h.jobs, 'enqueue').mockImplementationOnce((type, payload, runAfterMs, createdAtMs) => {
      JobsRepository.prototype.enqueue.call(h.jobs, type, payload, runAfterMs, createdAtMs);
      throw new Error('injected crash after enqueue');
    });
    expect(() => h.segmenter.finalizeForShutdown()).toThrow('injected crash after enqueue');

    // The aborted close left no trace: still open, no marker, no pending job.
    const stillOpen = h.segments.getOpenSegment();
    expect(stillOpen?.state).toBe('open');
    expect(stillOpen?.summarize_job_id).toBeNull();
    expect(h.jobs.countsByState().pending).toBe(0);

    // Recovery: closing again finalizes with exactly ONE pending summarize job.
    const id = h.segmenter.finalizeForShutdown();
    expect(id).toBe(stillOpen?.id);
    const closed = h.segments.getSegment(id!);
    expect(closed?.state).toBe('finalized');
    expect(closed?.summarize_job_id).toBeTypeOf('string');
    const pendingJobs = h.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'summarize_segment' AND state = 'pending'`)
      .get() as { n: number };
    expect(pendingJobs.n).toBe(1);
    h.db.close();
  });
});
