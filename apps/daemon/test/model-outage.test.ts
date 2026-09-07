import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClientHelloSchema,
  ServerHelloSchema,
  TimelineListResultSchema,
  assertFrame,
} from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { JobsRepository, RETRY_SCHEDULE_MS } from '../src/db/jobs-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { WorkflowsRepository } from '../src/db/workflows-repository.js';
import { HistoryService } from '../src/services/history-service.js';
import { EventIngestor } from '../src/ingest/event-ingestor.js';
import { JobWorker } from '../src/jobs/job-worker.js';
import { Router } from '../src/ipc/router.js';
import { registerJobOps } from '../src/ipc/job-ops.js';
import { registerSegmentsOps } from '../src/ipc/timeline-ops.js';
import { registerRetrievalOps } from '../src/ipc/retrieval-ops.js';
import type { ActivityEvent } from '@computer-history/protocol';
import type { Logger } from '../src/logging.js';

/**
 * Model-outage resilience (spec §3.24 release criterion, brief-m7 §D7 item 6):
 * with the transport ALWAYS throwing —
 *   - ingest → segmentation continues,
 *   - summarize jobs walk the EXACT retry schedule to dead after 5 attempts,
 *   - timeline.list / segments.list / history.search stay fully functional,
 *   - queue_update counts are correct throughout,
 *   - healing does NOT auto-revive dead jobs; `jobs.retryDead {}` re-drives.
 */

const NOW = Date.UTC(2026, 4, 1, 10, 0, 0);

describe('model outage resilience', () => {
  let db: Db;
  let home: string;
  let jobs: JobsRepository;
  let segments: SegmentsRepository;
  let episodes: EpisodesRepository;
  let memories: MemoriesRepository;
  let workflows: WorkflowsRepository;
  let history: HistoryService;
  let worker: JobWorker;
  let router: Router;
  let clockMs: number;
  const queueUpdates: number[] = [];

  const logger: Logger = {
    log: vi.fn(),
    pruneOld: () => 0,
  };

  function setClock(ms: number): void {
    clockMs = ms;
  }

  /** One poll tick against the fake clock. */
  async function tick(): Promise<void> {
    worker.tick();
    await worker.idle();
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-outage-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    jobs = new JobsRepository(db);
    segments = new SegmentsRepository(db);
    episodes = new EpisodesRepository(db);
    memories = new MemoriesRepository(db);
    workflows = new WorkflowsRepository(db);
    history = new HistoryService(db);
    clockMs = NOW;
    queueUpdates.length = 0;

    worker = new JobWorker({
      jobs,
      logger,
      now: () => clockMs,
      onQueueUpdate: (n) => queueUpdates.push(n),
    });
    router = new Router(logger);
    registerJobOps(router, {
      jobs,
      now: () => clockMs,
      onQueueUpdate: () => undefined,
    });
    registerSegmentsOps(router, { segments, episodes, jobs });
    registerRetrievalOps(router, {
      history,
      memories,
      workflows,
    });

    // Seed one finalized segment + steps so retrieval has real content even
    // while NO episode ever gets summarized (transport is down).
    const segment = segments.createOpen(NOW, 'first', NOW);
    segments.appendStep(
      segment.id,
      {
        action: 'click',
        appBundleId: 'com.test.App',
        appName: 'TestApp',
        target: 'submit button outageword',
        text: null,
        startedAtMs: NOW,
        endedAtMs: NOW + 1000,
        firstEventId: 'fe1',
        lastEventId: 'le1',
        eventCount: 1,
        targetRole: 'AXButton',
      },
      { text: null, target: 'submit button outageword', appName: 'TestApp' },
    );
    segments.finalize(segment.id, 'finalized', NOW + 2000, {});

    // Ingest keeps working: a fresh batch flows through with the transport dead.
    const ingestor = new EventIngestor({ repository: new EventsRepository(db), logger });
    const batchEvent: ActivityEvent = {
      id: ulid(),
      observedAt: NOW + 5000,
      source: 'accessibility',
      app: { bundleId: 'com.test.App', name: 'TestApp', pid: 3 },
      window: { title: 'Outage window' },
      action: 'click',
      target: { role: 'AXButton', label: 'Retry' },
      contentPolicy: 'allow',
      content: null,
    };
    const ack = ingestor.ingest({
      type: 'event_batch',
      protocolVersion: 1,
      messageId: ulid(),
      sentAt: NOW + 5000,
      batchId: ulid(),
      events: [batchEvent],
    });
    expect(ack.accepted).toBe(1);

    // The ALWAYS-THROWING "transport": every summarize attempt fails.
    worker.registerSerialized('summarize_segment', async () => {
      throw new Error('llm transport unavailable (simulated outage)');
    });
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function dispatch(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return router.dispatch(op, params);
  }

  it('walks the exact pinned schedule to dead; retrieval stays functional throughout', async () => {
    const enqueued = jobs.enqueue('summarize_segment', { segmentId: 'seg-x' }, clockMs, clockMs);

    // Attempts 1..4 arm RETRY_SCHEDULE_MS[attempts-1]; the FIFTH failure is
    // terminal (spec §3.24: «После пятой ошибки: dead»).
    let at = clockMs;
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt += 1) {
      await tick();
      const row = jobs.get(enqueued.id)!;
      if (attempt < RETRY_SCHEDULE_MS.length) {
        expect(row.state).toBe('retry');
        expect(row.attempts).toBe(attempt);
        expect(row.run_after_ms - at).toBe(RETRY_SCHEDULE_MS[attempt - 1]);
      } else {
        expect(row.state).toBe('dead');
        expect(row.attempts).toBe(RETRY_SCHEDULE_MS.length);
        expect(row.last_error).toContain('llm transport unavailable');
      }
      // Retrieval remains FULLY functional mid-outage (release criterion).
      const timeline = await dispatch('timeline.list', {});
      expect(timeline.ok).toBe(true);
      assertFrame(TimelineListResultSchema, timeline.result as never);
      const segs = await dispatch('segments.list', {});
      expect(segs.ok).toBe(true);
      const hits = await dispatch('history.search', { query: 'outageword', scope: 'steps' });
      expect(hits.ok).toBe(true);
      expect((hits.result as { hits: Array<{ snippet: string }> }).hits.length).toBeGreaterThan(0);

      at += RETRY_SCHEDULE_MS[attempt - 1] ?? 0;
      setClock(at);
    }
    // A seventh tick changes nothing: dead is terminal under outage.
    await tick();
    expect(jobs.get(enqueued.id)!.state).toBe('dead');
  });

  it('reports correct queue_update counts during the outage', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-y' }, clockMs, clockMs);
    queueUpdates.length = 0;
    await tick(); // claim → running (pendingJobs drops), fail → retry (back up)
    expect(jobs.get(job.id)!.state).toBe('retry');
    const pendingCount = queueUpdates.at(-1)!;
    const counts = jobs.countsByState(clockMs);
    expect(pendingCount).toBe(counts.pending + counts.retry);
    expect(counts.pending).toBe(0); // the retrying job is NOT pending
    expect(counts.retry).toBe(1);
  });

  it('does NOT auto-revive dead jobs when the transport heals; jobs.retryDead re-drives them', async () => {
    const job = jobs.enqueue('summarize_segment', { segmentId: 'seg-z' }, clockMs, clockMs);
    for (let attempt = 0; attempt < RETRY_SCHEDULE_MS.length; attempt += 1) {
      await tick();
      setClock(clockMs + RETRY_SCHEDULE_MS[Math.min(attempt, 4)]! + 1_000);
    }
    expect(jobs.get(job.id)!.state).toBe('dead');

    // Transport heals: a healthy handler takes over. Dead stays DEAD.
    let healedCalls = 0;
    worker.registerSerialized('summarize_segment', async () => {
      healedCalls += 1;
    });
    setClock(clockMs + 7 * 24 * 60 * 60 * 1000);
    await tick();
    await tick();
    expect(healedCalls).toBe(0);
    expect(jobs.get(job.id)!.state).toBe('dead');

    // Manual re-drive via the diagnostics op (the ONLY revival path).
    const outcome = await router.dispatch('jobs.retryDead', {});
    expect(outcome).toEqual({ ok: true, result: { retried: 1 } });
    const revived = jobs.get(job.id)!;
    expect(revived.state).toBe('pending');
    expect(revived.run_after_ms).toBeLessThanOrEqual(clockMs);
    expect(revived.attempts).toBe(0); // fresh attempt budget

    await tick();
    expect(healedCalls).toBe(1);
    expect(jobs.get(job.id)!.state).toBe('succeeded');
  });

  it('handshake fixture stays schema-valid (wire sanity while touching protocol ops)', () => {
    assertFrame(ClientHelloSchema, clientHello() as never);
    assertFrame(ServerHelloSchema, serverHello() as never);
  });

  function clientHello(): object {
    return {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'client_hello',
      sentAt: Date.now(),
      appVersion: 'test',
    };
  }

  function serverHello(): object {
    return {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'server_hello',
      sentAt: Date.now(),
      daemonVersion: 'test',
      databaseSchemaVersion: 4,
    };
  }
});
