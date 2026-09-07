import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusResultSchema, TimelineListResultSchema, assertFrame } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { JobsRepository } from '../src/db/jobs-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { registerStatusOp } from '../src/ipc/status.js';
import { registerSegmentsOps } from '../src/ipc/timeline-ops.js';
import { Router } from '../src/ipc/router.js';

/**
 * Three derived-number contracts over the SAME jobs table:
 * 1. status.get retrying counts only state='retry' — running jobs do not
 *    inflate it (status.ts jobCountByState);
 * 2. timeline.list pendingJobs = pending + retry — running/dead invisible
 *    (timeline-ops.ts waitingJobs, "activities waiting for processing");
 * 3. claimNext orders by run_after_ms ASC then created_at_ms ASC: a due retry
 *    beats an older-created pending job, ties break by creation order.
 * No worker loops; every repository call gets an explicit `now`.
 */

const T = 1_700_000_000_000;

describe('job queue derived counters', () => {
  let home: string;
  let db: Db;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-job-counters-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Seeds 1 pending + 2 retry + 1 running + 1 dead with explicit clocks. */
  function seedMixedQueue(jobs: JobsRepository): void {
    const claimAndFail = (): void => {
      const enq = jobs.enqueue('extract_memory', {}, T, T);
      const claimed = jobs.claimNext(600_000, T);
      expect(claimed?.id).toBe(enq.id);
      jobs.fail(enq.id, 'boom', T, claimed?.leased_until_ms ?? null);
    };
    // Claim/fail one at a time so each claim deterministically takes the job
    // just enqueued (the earlier retries are not yet due at T).
    claimAndFail();
    claimAndFail();
    const running = jobs.enqueue('extract_memory', {}, T, T);
    expect(jobs.claimNext(600_000, T)?.id).toBe(running.id);
    const dead = jobs.enqueue('extract_memory', {}, T, T);
    expect(jobs.claimNext(600_000, T)?.id).toBe(dead.id);
    db.prepare(`UPDATE jobs SET state = 'dead' WHERE id = ?`).run(dead.id);
    // The lone pending row last: it must survive the claims above.
    jobs.enqueue('extract_memory', {}, T, T);
  }

  it('status.get retrying counts only retry rows (running excluded)', async () => {
    const jobs = new JobsRepository(db);
    seedMixedQueue(jobs); // 1 pending + 2 retry + 1 running + 1 dead

    const router = new Router({ log: () => undefined });
    registerStatusOp(router, {
      db,
      startedAtMs: Date.now(),
      daemonVersion: 'test',
      schemaVersion: 1,
      homeDir: home,
    });

    const outcome = await router.dispatch('status.get', {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      assertFrame(StatusResultSchema, outcome.result);
      // The actively-running job must NOT inflate retrying (mirrors
      // waitingJobs/emitQueueUpdate: "waiting for processing" = pending + retry).
      expect(outcome.result.queue).toEqual({ pending: 1, retrying: 2, dead: 1 });
    }
  });

  it('timeline.list pendingJobs counts only pending + retry (running and dead invisible)', async () => {
    const jobs = new JobsRepository(db);
    seedMixedQueue(jobs);

    const episodes = new EpisodesRepository(db);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: T,
          endedAtMs: T + 60_000,
          title: 'one episode',
          summary: 'summary',
          intent: null,
          outcome: null,
          apps: ['Safari'],
          entities: [],
          summaryModel: 'test-model',
          summaryPromptVersion: 'v1',
          steps: [],
        },
      ],
      T,
    );

    const segments = new SegmentsRepository(db);
    const router = new Router({ log: () => undefined });
    registerSegmentsOps(router, { segments, episodes, jobs });

    const outcome = await router.dispatch('timeline.list', {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      assertFrame(TimelineListResultSchema, outcome.result);
      expect(outcome.result.episodes).toHaveLength(1);
      for (const episode of outcome.result.episodes) {
        expect(episode.pendingJobs).toBe(3); // 2 retry + 1 pending
      }
    }
  });

  it('claimNext prefers earlier run_after_ms over older creation, ties by created_at', () => {
    const jobs = new JobsRepository(db);

    // Part i: A is created EARLIER but due LATER; B becomes a due retry.
    const a = jobs.enqueue('extract_memory', { which: 'A' }, T + 200_000, T);
    const b = jobs.enqueue('extract_memory', { which: 'B' }, T + 1_000, T + 1_000);
    // Fail B at T+1000 → retry with run_after = T+61_000 (< A's T+200_000).
    const claimedB = jobs.claimNext(600_000, T + 1_000);
    expect(claimedB?.id).toBe(b.id);
    expect(jobs.fail(b.id, 'boom', T + 1_000, claimedB?.leased_until_ms ?? null)).toBe('retry');

    const first = jobs.claimNext(600_000, T + 200_000);
    expect(first?.id).toBe(b.id); // run_after dominates creation age
    const second = jobs.claimNext(600_000, T + 200_000);
    expect(second?.id).toBe(a.id);

    // Part ii: equal run_after → the earlier-created pending wins. Inserted in
    // reverse creation order so dropping the tie-break flips the result.
    const lateCreated = jobs.enqueue('extract_memory', {}, T + 500_000, T + 500_000);
    const earlyCreated = jobs.enqueue('extract_memory', {}, T + 500_000, T + 499_000);
    expect(jobs.claimNext(600_000, T + 500_000)?.id).toBe(earlyCreated.id);
    expect(jobs.claimNext(600_000, T + 500_000)?.id).toBe(lateCreated.id);
  });
});
