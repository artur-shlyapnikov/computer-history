import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';

import { CONSTANTS } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { migrate } from '../src/db/migrator.js';
import {
  EventIngestor,
  NoopSegmenterCoordinator,
  type SegmenterCoordinator,
} from '../src/ingest/event-ingestor.js';
import type { Logger } from '../src/logging.js';

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(),
    observedAt: 1_000_000,
    monotonicNs: 500,
    source: 'workspace',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    action: 'app_focus',
    contentPolicy: 'metadata_only',
    ...overrides,
  };
}

function makeBatch(events: ActivityEvent[]): {
  protocolVersion: 1;
  messageId: string;
  type: 'event_batch';
  sentAt: number;
  batchId: string;
  events: ActivityEvent[];
} {
  return {
    protocolVersion: 1,
    messageId: ulid(),
    type: 'event_batch',
    sentAt: 1,
    batchId: ulid(),
    events,
  };
}

interface HarnessOptions {
  coordinator?: SegmenterCoordinator;
  /** Override the default watermark page size for backlog-drain tests. */
  sweepLimit?: number;
  /** Override the failed-sweep retry backoff for retry tests. */
  sweepRetryMs?: number;
}

interface IngestorHarness {
  ingestor: EventIngestor;
  repo: EventsRepository;
  logLines: Array<{ level: string; scope: string; message: string; fields?: Record<string, unknown> }>;
  db: Db;
  setNow(ms: number): void;
  readonly now: number;
  cleanup(): void;
}
/** Real repository on a temp db; fake clock + recording logger for determinism. */
function makeHarness({ coordinator, sweepLimit, sweepRetryMs }: HarnessOptions = {}): IngestorHarness {
  const home = mkdtempSync(path.join(tmpdir(), 'ch-ingestor-'));
  const db = openDatabase(path.join(home, 'history.db'));
  migrate(db);
  const repo = new EventsRepository(db);
  const logLines: Array<{ level: string; scope: string; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    log(level, scope, message, fields) {
      logLines.push({ level, scope, message, fields });
    },
    pruneOld: () => 0,
  };
  let currentMs = 10_000_000;
  const ingestor = new EventIngestor({
    repository: repo,
    logger,
    ...(coordinator ? { coordinator } : {}),
    ...(sweepLimit !== undefined ? { sweepLimit } : {}),
    ...(sweepRetryMs !== undefined ? { sweepRetryMs } : {}),
    now: () => currentMs,
  });
  return {
    ingestor,
    repo,
    logLines,
    db,
    setNow: (ms: number) => {
      currentMs = ms;
    },
    get now(): number {
      return currentMs;
    },
    cleanup: () => {
      // Dispose FIRST: a stray debounce timer firing runSweep against the
      // closed db would log 'watermark sweep failed' and re-arm forever.
      ingestor.dispose();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('EventIngestor privacy invariants', () => {
  let h: IngestorHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('(a) rejects redacted_secure_field events whose content is not null', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_secure_field', target: { subrole: 'AXSecureTextField' }, content: 'hunter2' }),
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_secure_field', target: { subrole: 'AXSecureTextField' }, content: null }),
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_secure_field', target: { subrole: 'AXSecureTextField' }, content: undefined }),
      ]),
    );
    expect(outcome).toEqual({ accepted: 2, duplicates: 0, rejected: 1 });
    expect(h.repo.count()).toBe(2);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      reasons: { secure_field_with_content: 1 },
    });
  });

  it("(a') rejects any AXSecureTextField-targeted event that carries content", () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        makeEvent({ action: 'text_change', contentPolicy: 'allow', target: { subrole: 'AXSecureTextField' }, content: 'secret' }),
      ]),
    );
    expect(outcome).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.repo.count()).toBe(0);
  });

  it("(a'') rejects content smuggled under content-dropping policies", () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_sensitive_target', content: 'AKIAIOSFODNN7EXAMPLE' }),
        makeEvent({ action: 'click', contentPolicy: 'metadata_only', content: 'hunter2' }),
        makeEvent({ action: 'scroll', contentPolicy: 'excluded_app', content: 'smuggled' }),
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_oversize', content: 'smuggled' }),
        // Empty string is NOT null (spec §3.11): still counts as smuggled content.
        makeEvent({ action: 'click', contentPolicy: 'metadata_only', content: '' }),
        // Documented exemption: the scrubbed `[REDACTED]` text of
        // redacted_secret_pattern IS the wire shape and stays acceptable.
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_secret_pattern', content: '[REDACTED] AKIAIOSFODNN7EXAMPLE' }),
        // Null content under those policies stays legitimate.
        makeEvent({ action: 'text_change', contentPolicy: 'redacted_sensitive_target', content: null }),
      ]),
    );
    expect(outcome).toEqual({ accepted: 2, duplicates: 0, rejected: 5 });
    expect(h.repo.count()).toBe(2);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      reasons: { redacted_policy_with_content: 5 },
    });
  });

  it('(b) rejects typing_activity with content but accepts null/absent content', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        makeEvent({ source: 'input', action: 'typing_activity', contentPolicy: 'allow', content: 'typed text' }),
        makeEvent({ source: 'input', action: 'typing_activity', contentPolicy: 'allow', content: null }),
        makeEvent({ source: 'input', action: 'typing_activity', contentPolicy: 'allow' }),
      ]),
    );
    expect(outcome).toEqual({ accepted: 2, duplicates: 0, rejected: 1 });
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      reasons: { typing_activity_with_content: 1 },
    });
  });

  it('(c) accepts exactly-2048-char content and rejects anything longer', () => {
    const boundary = makeEvent({ action: 'text_change', contentPolicy: 'allow', content: 'x'.repeat(CONSTANTS.maxContentChars) });
    const oversize = makeEvent({ action: 'text_change', contentPolicy: 'allow', content: 'x'.repeat(CONSTANTS.maxContentChars + 1) });
    const outcome = h.ingestor.ingest(makeBatch([boundary, oversize]));
    expect(outcome).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    expect(h.logLines.at(-1)?.fields).toMatchObject({ reasons: { content_oversize: 1 } });
  });

  it('(d) rejects an unknown contentPolicy as schema_invalid', () => {
    const outcome = h.ingestor.ingest(makeBatch([makeEvent({ contentPolicy: 'kind_of_fine' as never })]));
    expect(outcome).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.logLines.at(-1)?.fields).toMatchObject({ reasons: { schema_invalid: 1 } });
  });

  it('always acks — even a batch where every event is rejected inserts nothing', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        makeEvent({ contentPolicy: 'redacted_secure_field', content: 'nope' }),
        makeEvent({ source: 'input', action: 'typing_activity', content: 'nope' }),
        makeEvent({ content: 'z'.repeat(CONSTANTS.maxContentChars + 5) }),
      ]),
    );
    expect(outcome).toEqual({ accepted: 0, duplicates: 0, rejected: 3 });
    expect(h.repo.count()).toBe(0);
    expect(h.logLines.at(-1)?.fields).toMatchObject({ received: 3, accepted: 0, rejected: 3 });
  });

  it('counts duplicates across redelivered batches and logs batch stats without content', () => {
    const batch = makeBatch([makeEvent(), makeEvent()]);
    const first = h.ingestor.ingest(batch);
    const second = h.ingestor.ingest(batch);
    expect(first).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(second).toEqual({ accepted: 0, duplicates: 2, rejected: 0 });
    const fields = h.logLines.at(-1)?.fields ?? {};
    expect(fields).toMatchObject({ batchId: batch.batchId, accepted: 0, duplicates: 2 });
    // the JSONL stats line must never carry user content
    expect(JSON.stringify(fields)).not.toContain('Doc');
  });
});

describe('EventIngestor watermark sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps once, debounced, with only watermark-eligible events in canonical order', async () => {
    const seen: ActivityEvent[][] = [];
    const coordinator: SegmenterCoordinator = {
      onEventsEligible(events) {
        seen.push([...events]);
      },
    };
    const h = makeHarness({ coordinator });
    try {
      const eligibleOld = makeEvent({ observedAt: h.now - 5_000, monotonicNs: 20 });
      const eligibleYounger = makeEvent({ observedAt: h.now - 4_000, monotonicNs: 30 });
      const tooFresh = makeEvent({ observedAt: h.now - CONSTANTS.watermarkLagMs + 100 });
      h.ingestor.ingest(makeBatch([eligibleYounger, tooFresh, eligibleOld]));

      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs - 1);
      expect(seen).toHaveLength(0); // debounce not yet elapsed

      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toHaveLength(1);
      // canonical order: observed_at ASC; the too-fresh event stays excluded
      expect(seen[0]!.map((e) => e.id)).toEqual([eligibleOld.id, eligibleYounger.id]);
    } finally {
      h.cleanup();
    }
  });

  it('resets the debounce window on every ingested batch (one sweep for a burst)', async () => {
    let sweeps = 0;
    const h = makeHarness({
      coordinator: { onEventsEligible() { sweeps += 1; } },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs - 100);
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs - 100);
      expect(sweeps).toBe(0); // both batches reset the timer
      h.ingestor.ingest(makeBatch([]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(sweeps).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('excludes events already marked processed and skips empty sweeps', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      coordinator: { onEventsEligible(events) { seen.push([...events]); } },
    });
    try {
      const processed = makeEvent({ observedAt: h.now - 9_000 });
      h.ingestor.ingest(makeBatch([processed]));
      h.repo.markProcessed([processed.id], h.now);
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(0); // nothing eligible left → no callback
    } finally {
      h.cleanup();
    }
  });

  it('dispose() cancels a pending debounced sweep', async () => {
    let sweeps = 0;
    const h = makeHarness({
      coordinator: { onEventsEligible() { sweeps += 1; } },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      h.ingestor.dispose();
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs * 2);
      expect(sweeps).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('defaults to the no-op coordinator without crashing the pipeline', () => {
    const h = makeHarness();
    try {
      expect(new NoopSegmenterCoordinator().onEventsEligible([])).toBeUndefined();
      expect(() => h.ingestor.ingest(makeBatch([makeEvent()]))).not.toThrow();
    } finally {
      h.cleanup();
    }
  });

  it('re-arms after a full page so the backlog self-drains without new traffic', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      sweepLimit: 2,
      coordinator: {
        onEventsEligible(events) {
          seen.push([...events]);
          // Model the real segmenter: consumed rows leave the eligible set.
          h.repo.markProcessed(events.map((e) => e.id), h.now);
        },
      },
    });
    try {
      h.ingestor.ingest(makeBatch([
        makeEvent({ observedAt: h.now - 9_000 }),
        makeEvent({ observedAt: h.now - 8_000 }),
        makeEvent({ observedAt: h.now - 7_000 }),
      ]));

      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(2); // exactly one full page consumed

      // The full page re-armed the sweep: the stranded third event drains
      // after one more debounce, with no further ingest() calls.
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toHaveLength(1);

      // Drained backlog does not loop forever.
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs * 3);
      expect(seen).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('logs and swallows a throwing coordinator instead of crashing the timer tick', async () => {
    const h = makeHarness({
      coordinator: {
        onEventsEligible() {
          throw new Error('SQLITE_FULL: database or disk is full');
        },
      },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      const errorLine = h.logLines.find((l) => l.level === 'error');
      expect(errorLine?.scope).toBe('ingest');
      expect(errorLine?.message).toBe('watermark sweep coordinator failed');
      expect(String(errorLine?.fields?.errorMessage)).toContain('SQLITE_FULL');
    } finally {
      h.cleanup();
    }
  });

  it('logs and swallows an async-rejecting coordinator', async () => {
    const h = makeHarness({
      coordinator: {
        onEventsEligible() {
          return Promise.reject(new Error('IOERR: write race lost'));
        },
      },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      await Promise.resolve(); // let the rejection handler run
      await Promise.resolve();
      const errorLine = h.logLines.find((l) => l.level === 'error');
      expect(errorLine?.message).toBe('watermark sweep coordinator failed');
      expect(String(errorLine?.fields?.errorMessage)).toContain('IOERR');
    } finally {
      h.cleanup();
    }
  });
  it('logs and swallows a throwing fetchUnprocessed instead of crashing the timer tick', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      coordinator: { onEventsEligible(events) { seen.push([...events]); } },
    });
    try {
      const fetch = vi.spyOn(h.repo, 'fetchUnprocessed');
      fetch.mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      const errorLine = h.logLines.find((l) => l.level === 'error');
      expect(errorLine?.scope).toBe('ingest');
      expect(errorLine?.message).toBe('watermark sweep failed');
      expect(String(errorLine?.fields?.errorMessage)).toContain('SQLITE_BUSY');

      // The timer context survived the failure: once the fetch heals, a later
      // ingested batch still sweeps normally.
      fetch.mockRestore();
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('re-arms a retry sweep after a failed fetch so a quiet backlog still drains', async () => {
    const seen: ActivityEvent[][] = [];
    const retryMs = 5_000;
    const h = makeHarness({
      sweepRetryMs: retryMs,
      coordinator: { onEventsEligible(events) { seen.push([...events]); } },
    });
    try {
      const fetch = vi.spyOn(h.repo, 'fetchUnprocessed').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(0); // first sweep failed
      expect(fetch).toHaveBeenCalledTimes(1);

      // No further ingest traffic: the failure re-armed its own sweep, so the
      // backlog drains once the backoff elapses.
      await vi.advanceTimersByTimeAsync(retryMs - 1);
      expect(fetch).toHaveBeenCalledTimes(1); // still inside the backoff window
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2); // retried without any ingest()
      expect(seen).toHaveLength(1); // processing recovered

      // Drained backlog does not crash-loop: no further sweeps fire.
      await vi.advanceTimersByTimeAsync(retryMs * 3);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('re-arms a retry sweep when the async coordinator rejects so quiet-hour failures still drain', async () => {
    const seen: ActivityEvent[][] = [];
    const retryMs = 5_000;
    let failFirst = true;
    const h = makeHarness({
      sweepRetryMs: retryMs,
      coordinator: {
        onEventsEligible(events) {
          if (failFirst) {
            failFirst = false;
            return Promise.reject(new Error('SQLITE_FULL: database or disk is full'));
          }
          seen.push([...events]);
          h.repo.markProcessed(events.map((e) => e.id), h.now);
        },
      },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      await Promise.resolve(); // settle the rejection handler
      expect(seen).toHaveLength(0); // first delivery failed

      // No further ingest traffic: the failure re-armed its own sweep, so
      // quiet hours no longer strand rows until the backoff elapses.
      await vi.advanceTimersByTimeAsync(retryMs);
      expect(seen).toHaveLength(1); // retried without any ingest()
      const row = h.db.prepare('SELECT processed_at_ms FROM raw_events').get() as {
        processed_at_ms: number | null;
      };
      expect(row.processed_at_ms).not.toBeNull();

      // Drained backlog does not loop forever.
      await vi.advanceTimersByTimeAsync(retryMs * 3);
      expect(seen).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('quarantines a poison row while still delivering the good rows of its page', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      coordinator: { onEventsEligible(events) { seen.push([...events]); } },
    });
    try {
      // Poison row written directly to storage: content_policy violates the
      // wire enum, so toWireEvent's re-validation throws for this row only.
      h.db
        .prepare(
          `INSERT INTO raw_events (id, observed_at_ms, source, action, app_bundle_id, content_policy, inserted_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('01POISONROW', h.now - 9_500, 'keyboard', 'press', 'com.example.app', 'not-a-policy', h.now);
      const good = makeEvent({ observedAt: h.now - 9_000 });
      h.ingestor.ingest(makeBatch([good]));

      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.map((e) => e.id)).toEqual([good.id]);

      // Quarantine: the poison row was marked processed and an error logged.
      const quarantined = h.db
        .prepare('SELECT processed_at_ms FROM raw_events WHERE id = ?')
        .get('01POISONROW') as { processed_at_ms: number | null };
      expect(quarantined.processed_at_ms).not.toBeNull();
      const errorLine = h.logLines.find((l) => l.level === 'error');
      expect(errorLine?.message).toBe('watermark sweep quarantined poison row');
      expect(errorLine?.fields?.id).toBe('01POISONROW');
      expect(String(errorLine?.fields?.errorMessage)).toContain('wire re-validation');
    } finally {
      h.cleanup();
    }
  });

  it('drainForShutdown processes events inside the watermark window that the debounced sweep never reached', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      coordinator: {
        onEventsEligible(events) {
          seen.push([...events]);
          h.repo.markProcessed(events.map((e) => e.id), h.now);
        },
      },
    });
    try {
      // Inside the lag window: the debounced sweep would exclude this row.
      const fresh = makeEvent({ observedAt: h.now - 100 });
      h.ingestor.ingest(makeBatch([fresh]));
      h.ingestor.dispose(); // teardown cancels the pending debounce
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs * 2);
      expect(seen).toHaveLength(0); // no timer fired — the row is stranded

      await h.ingestor.drainForShutdown();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.map((e) => e.id)).toEqual([fresh.id]);
      const row = h.db.prepare('SELECT processed_at_ms FROM raw_events WHERE id = ?').get(fresh.id) as {
        processed_at_ms: number | null;
      };
      expect(row.processed_at_ms).not.toBeNull(); // no zombie survives shutdown
    } finally {
      h.cleanup();
    }
  });

  it('drainForShutdown drains a full multi-page backlog', async () => {
    const seen: ActivityEvent[][] = [];
    const h = makeHarness({
      sweepLimit: 2,
      coordinator: {
        onEventsEligible(events) {
          seen.push([...events]);
          h.repo.markProcessed(events.map((e) => e.id), h.now);
        },
      },
    });
    try {
      const events = [
        makeEvent({ observedAt: h.now - 9_000 }),
        makeEvent({ observedAt: h.now - 8_000 }),
        makeEvent({ observedAt: h.now - 7_000 }),
      ];
      for (const event of events) h.repo.insertBatch([event]);
      await h.ingestor.drainForShutdown();
      expect(seen.map((page) => page.length)).toEqual([2, 1]); // paged to exhaustion
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NULL').get()).toMatchObject({
        n: 0,
      });
    } finally {
      h.cleanup();
    }
  });

  it('drainForShutdown logs and resolves on coordinator failure instead of blocking shutdown', async () => {
    const h = makeHarness({
      coordinator: {
        onEventsEligible() {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      },
    });
    try {
      h.repo.insertBatch([makeEvent({ observedAt: h.now - 9_000 })]);
      await expect(h.ingestor.drainForShutdown()).resolves.toBeUndefined();
      const errorLine = h.logLines.at(-1);
      expect(errorLine?.message).toBe('shutdown drain failed; unprocessed rows survive for next boot');
      expect(String(errorLine?.fields?.errorMessage)).toContain('SQLITE_BUSY');
    } finally {
      h.cleanup();
    }
  });

  it('drainForShutdown stops instead of spinning when the coordinator consumes nothing', async () => {
    let deliveries = 0;
    const h = makeHarness({
      sweepLimit: 2,
      coordinator: {
        onEventsEligible() {
          deliveries += 1; // succeeds but never marks rows processed
        },
      },
    });
    try {
      h.repo.insertBatch([
        makeEvent({ observedAt: h.now - 9_000 }),
        makeEvent({ observedAt: h.now - 8_000 }),
      ]);
      await h.ingestor.drainForShutdown(); // would loop forever without the stall guard
      expect(deliveries).toBe(1);
      expect(h.logLines.at(-1)?.level).toBe('warn');
    } finally {
      h.cleanup();
    }
  });

  it('an armed sweep timer stays inert while drainForShutdown runs', async () => {
    // Round-33 pin: onEventsEligible is typed void | Promise<void>; an async
    // coordinator parks the drain mid-loop while ingest()-armed timers are
    // still pending. Without the draining latch the timer fires runSweep and
    // hands the coordinator a second, overlapping page (duplicate segments).
    const seen: ActivityEvent[][] = [];
    let releaseDrain: (() => void) | null = null;
    const h = makeHarness({
      coordinator: {
        async onEventsEligible(events) {
          seen.push([...events]);
          await new Promise<void>((resolve) => {
            releaseDrain = resolve;
          });
        },
      },
    });
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      const drained = h.ingestor.drainForShutdown();
      // The debounce timer fires while the drain is parked in the coordinator.
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs * 2);
      expect(releaseDrain).not.toBeNull(); // drain really is parked mid-page
      expect(seen).toHaveLength(1); // no overlapping second delivery
      expect(h.logLines.some((l) => l.message === 'watermark sweep suppressed during shutdown drain')).toBe(true);

      releaseDrain!();
      await drained;
      expect(seen).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('drainForShutdown awaits an in-flight parked sweep instead of re-delivering its page', async () => {
    // Round-34 pin: a sweep dispatched BEFORE drainForShutdown sets draining
    // can still be parked inside `await onEventsEligible` when the drain loop
    // fetches. Without the in-flight-sweep await, an async coordinator gets
    // the same page handed over twice (duplicate segments).
    const seen: ActivityEvent[][] = [];
    let releaseSweep: (() => void) | null = null;
    let coordinatorCalls = 0;
    const h = makeHarness({
      coordinator: {
        async onEventsEligible(events) {
          seen.push([...events]);
          coordinatorCalls += 1;
          if (coordinatorCalls === 1) {
            // Park the post-ack sweep mid-delivery.
            await new Promise<void>((resolve) => {
              releaseSweep = resolve;
            });
          }
          // Model the real segmenter: consumed rows leave the eligible set,
          // so the drain terminates once it finally gets to fetch.
          h.repo.markProcessed(events.map((e) => e.id), h.now);
        },
      },
    });
    const fetchSpy = vi.spyOn(h.repo, 'fetchUnprocessed');
    try {
      h.ingestor.ingest(makeBatch([makeEvent({ observedAt: h.now - 9_000 })]));
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(releaseSweep).not.toBeNull(); // sweep really is parked mid-page
      expect(seen).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const drained = h.ingestor.drainForShutdown();
      // Flush microtasks + timers: the drain must stay parked behind the
      // in-flight sweep, not fetch (and re-deliver) the same rows.
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // drain has not fetched yet

      releaseSweep!();
      await drained;
      // Exactly-once across both paths: sweep delivery + drain, no duplicates.
      expect(coordinatorCalls).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // drain fetched once, found nothing
      const deliveredIds = seen.flat().map((e) => e.id);
      expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
      expect(
        h.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NULL').get(),
      ).toMatchObject({ n: 0 });
    } finally {
      h.cleanup();
    }
  });

  it('a parked sweep suppresses overlapping sweeps until it settles', async () => {
    // Round-36 pin (supersedes the round-35 two-concurrent-parks pin): while
    // any delivery is parked inside onEventsEligible, runSweep must SKIP
    // instead of fetching. A parked delivery owns the current eligible rows —
    // re-fetching them hands the coordinator overlapping pages (duplicate
    // segments, the round-35 class), and on a never-settling coordinator the
    // old full-page re-arm parks a fresh delivery every cycle: unbounded
    // Set/page accumulation, and drainForShutdown blocks exit forever. The
    // coordinator consumes each page BEFORE parking (the real segmenter
    // applies rows, then does async work), so pages stay distinct and the
    // skip is observable purely through fetch counts.
    const seen: ActivityEvent[][] = [];
    const releases: Array<() => void> = [];
    let coordinatorCalls = 0;
    const h = makeHarness({
      sweepLimit: 1,
      coordinator: {
        async onEventsEligible(events) {
          seen.push([...events]);
          coordinatorCalls += 1;
          // Model the real segmenter: consumed rows leave the eligible set,
          // so later sweeps see distinct pages and the drain terminates.
          h.repo.markProcessed(events.map((e) => e.id), h.now);
          // Park every delivery until the test releases it.
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        },
      },
    });
    const fetchSpy = vi.spyOn(h.repo, 'fetchUnprocessed');
    try {
      h.ingestor.ingest(
        makeBatch([
          makeEvent({ observedAt: h.now - 9_000 }),
          makeEvent({ observedAt: h.now - 8_000 }),
        ]),
      );
      // First debounce: S1 dispatches, consumes page 1, parks mid-delivery.
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(releases).toHaveLength(1); // S1 parked
      expect(seen).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second debounce while S1 is still parked: the sweep must SKIP — no
      // fetch, no second delivery (the skip's own re-arm replaces the old
      // full-page re-arm). Under a skip-revert this is fetch=2 / releases=2.
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(releases).toHaveLength(1);
      expect(seen).toHaveLength(1);

      // Settle S1: the skip re-arm fires and delivers the DISTINCT page 2.
      releases[0]!();
      await vi.advanceTimersByTimeAsync(CONSTANTS.watermarkSweepDebounceMs);
      expect(coordinatorCalls).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(seen[1]!.map((e) => e.id)).not.toEqual(seen[0]!.map((e) => e.id));

      // While S2 is parked, drainForShutdown must not fetch its page either:
      // the drain stays behind the parked sweep (round-34/35 coverage).
      const drained = h.ingestor.drainForShutdown();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // drain has not fetched yet

      releases[1]!();
      await drained;
      // Exactly-once across all paths: distinct ids, the drain's own final
      // empty fetch found nothing left, no zombie rows survive shutdown.
      expect(coordinatorCalls).toBe(2);
      expect(seen).toHaveLength(2);
      const deliveredIds = seen.flat().map((e) => e.id);
      expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // drain fetched once, found nothing
      expect(
        h.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE processed_at_ms IS NULL').get(),
      ).toMatchObject({ n: 0 });
    } finally {
      h.cleanup();
    }
  });

  it('a second drainForShutdown call is a no-op (drain latch)', async () => {
    let deliveries = 0;
    const h = makeHarness({
      coordinator: {
        onEventsEligible() {
          deliveries += 1; // succeeds but never marks rows processed
        },
      },
    });
    try {
      h.repo.insertBatch([makeEvent({ observedAt: h.now - 9_000 })]);
      await h.ingestor.drainForShutdown();
      await h.ingestor.drainForShutdown();
      // The stall guard alone would deliver the same page twice; the latch
      // makes the second call return without touching the coordinator.
      expect(deliveries).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
