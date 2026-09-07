import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/db/database.js';
import { JobsRepository, RETRY_SCHEDULE_MS } from '../src/db/jobs-repository.js';
import { migrate } from '../src/db/migrator.js';

describe('JobsRepository (spec §3.24 retry schedule, contracts §Numeric constants)', () => {
  let db: Db;
  let repo: JobsRepository;
  let home: string;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-jobs-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    repo = new JobsRepository(db);
    now = 1_000_000;
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function enqueueSample(type = 'summarize_segment'): string {
    return repo.enqueue(type, { segmentId: 'seg-1' }, now, now).id;
  }

  it('enqueues pending jobs with JSON payload and default run_after', () => {
    const job = repo.enqueue('summarize_segment', { segmentId: 'seg-9' }, now, now);
    expect(job.state).toBe('pending');
    const counts = repo.countsByState(now);
    expect(counts.pending).toBe(1);
    expect(counts.runnablePending).toBe(1);
    const row = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(job.id) as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json)).toEqual({ segmentId: 'seg-9' });
  });

  it('claimNext atomically claims the oldest due job and counts the attempt', () => {
    const first = enqueueSample();
    enqueueSample();
    const claimed = repo.claimNext(60_000, now);
    expect(claimed?.id).toBe(first);
    expect(claimed?.state).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leased_until_ms).toBe(now + 60_000);

    // A second claim takes the second job; attempts tracked per row.
    const secondClaim = repo.claimNext(60_000, now);
    expect(secondClaim?.id).not.toBe(first);
    // Nothing left to claim.
    expect(repo.claimNext(60_000, now)).toBeNull();
  });

  it('claimNext skips jobs whose run_after_ms is still in the future', () => {
    repo.enqueue('summarize_segment', { segmentId: 'later' }, now + 500_000, now);
    expect(repo.claimNext(60_000, now)).toBeNull();
    expect(repo.claimNext(60_000, now + 500_000)?.state).toBe('running');
  });

  it('complete marks the job succeeded', () => {
    const id = enqueueSample();
    const claimed = repo.claimNext(60_000, now);
    repo.complete(id, claimed?.leased_until_ms ?? null, now + 5);
    const counts = repo.countsByState(now);
    expect(counts.succeeded).toBe(1);
    expect(counts.running).toBe(0);
  });

  it(`fails back off exactly ${RETRY_SCHEDULE_MS.join(', ')}ms then goes dead after the 5th failure`, () => {
    const id = enqueueSample();
    let runAfter = now;
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt += 1) {
      const claimed = repo.claimNext(60_000, runAfter);
      expect(claimed?.attempts).toBe(attempt);
      const outcome = repo.fail(id, `boom #${attempt}`, runAfter, claimed?.leased_until_ms ?? null);
      if (attempt < RETRY_SCHEDULE_MS.length) {
        expect(outcome).toBe('retry');
        const row = db.prepare('SELECT state, run_after_ms FROM jobs WHERE id = ?').get(id) as {
          state: string;
          run_after_ms: number;
        };
        expect(row.state).toBe('retry');
        expect(row.run_after_ms - runAfter).toBe(RETRY_SCHEDULE_MS[attempt - 1]);
      } else {
        expect(outcome).toBe('dead');
        const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string };
        expect(row.state).toBe('dead');
      }
      runAfter += RETRY_SCHEDULE_MS[attempt - 1]! + 1;
    }
    // A dead job is never claimable again.
    expect(repo.claimNext(60_000, runAfter + 10_000_000)).toBeNull();
    expect(repo.countsByState().dead).toBe(1);
  });

  it('requeueExpiredLeases moves lapsed running jobs back to retry', () => {
    const id = enqueueSample();
    repo.claimNext(1_000, now); // lease until now+1000
    expect(repo.countsByState(now).running).toBe(1);
    const moved = repo.requeueExpiredLeases(now + 2_000);
    expect(moved).toBe(1);
    const row = db.prepare('SELECT state, run_after_ms, leased_until_ms FROM jobs WHERE id = ?').get(id) as {
      state: string;
      run_after_ms: number;
      leased_until_ms: number | null;
    };
    expect(row.state).toBe('retry');
    // The burned attempt schedules the pinned retry slot, not an immediate arm.
    expect(row.run_after_ms).toBe(now + 2_000 + RETRY_SCHEDULE_MS[0]);
    expect(row.leased_until_ms).toBeNull();

    // Unexpired leases are left alone.
    repo.claimNext(60_000, now + 3_000);
    expect(repo.requeueExpiredLeases(now + 3_000)).toBe(0);
  });

  it('requeueExpiredLeases marks a poison job dead when its FIFTH lease lapses (spec §3.24)', () => {
    const id = enqueueSample();
    let clock = now;
    // Burn four attempts through the normal fail path.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const claimed = repo.claimNext(1_000, clock);
      expect(claimed?.attempts).toBe(attempt);
      expect(repo.fail(id, `boom #${attempt}`, clock, claimed?.leased_until_ms ?? null)).toBe(
        'retry',
      );
      clock += RETRY_SCHEDULE_MS[attempt - 1]! + 1;
    }
    // Fifth claim leaves attempts=5 in running; then that lease lapses too.
    expect(repo.claimNext(1_000, clock)?.attempts).toBe(5);
    const moved = repo.requeueExpiredLeases(clock + 2_000);
    expect(moved).toBe(1);
    const row = db.prepare('SELECT state, leased_until_ms FROM jobs WHERE id = ?').get(id) as {
      state: string;
      leased_until_ms: number | null;
    };
    expect(row.state).toBe('dead');
    expect(row.leased_until_ms).toBeNull();
    // Dead matches fail()'s cutoff: never claimed again, no 6h forever-retry.
    expect(repo.claimNext(60_000, clock + 10_000_000)).toBeNull();
  });

  it('requeueExpiredLeases still requeues an expired attempts=4 lease onto the +2h slot', () => {
    const id = enqueueSample();
    let clock = now;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repo.claimNext(1_000, clock);
      expect(claimed?.attempts).toBe(attempt);
      expect(repo.fail(id, `boom #${attempt}`, clock, claimed?.leased_until_ms ?? null)).toBe(
        'retry',
      );
      clock += RETRY_SCHEDULE_MS[attempt - 1]! + 1;
    }
    expect(repo.claimNext(1_000, clock)?.attempts).toBe(4);
    const moved = repo.requeueExpiredLeases(clock + 2_000);
    expect(moved).toBe(1);
    const row = db.prepare('SELECT state, run_after_ms FROM jobs WHERE id = ?').get(id) as {
      state: string;
      run_after_ms: number;
    };
    expect(row.state).toBe('retry');
    expect(row.run_after_ms).toBe(clock + 2_000 + RETRY_SCHEDULE_MS[3]);
  });
  it('counts by state across a mixed queue', () => {
    const done = enqueueSample();
    enqueueSample();
    const claimed = repo.claimNext(60_000, now); // claims the first-enqueued job
    repo.complete(done, claimed?.leased_until_ms ?? null, now);
    const counts = repo.countsByState(now);
    expect(counts).toMatchObject({ pending: 1, succeeded: 1, running: 0, retry: 0, dead: 0 });
  });

  it('a stale worker cannot clobber the successor: complete/fail need the claim-time lease token', () => {
    const id = enqueueSample();
    // Worker A claims; its lease lapses while the handler is stuck.
    const stale = repo.claimNext(1_000, now);
    expect(repo.requeueExpiredLeases(now + 2_000)).toBe(1);
    // The successor claims the re-driven job — a NEW lease token.
    const successor = repo.claimNext(60_000, now + 2_000 + RETRY_SCHEDULE_MS[0]);
    expect(successor?.id).toBe(id);
    expect(successor?.leased_until_ms).not.toBe(stale?.leased_until_ms);

    // A's results arrive late: both must no-op against the successor's row.
    expect(repo.complete(id, stale?.leased_until_ms ?? null, now + 3_000)).toBe(false);
    expect(repo.fail(id, 'stale boom', now + 3_000, stale?.leased_until_ms ?? null)).toBe('stale');
    const row = db
      .prepare('SELECT state, leased_until_ms, last_error FROM jobs WHERE id = ?')
      .get(id) as { state: string; leased_until_ms: number | null; last_error: string | null };
    expect(row.state).toBe('running');
    expect(row.leased_until_ms).toBe(successor?.leased_until_ms);
    expect(row.last_error).toBeNull();

    // The successor's own token still works.
    expect(repo.complete(id, successor?.leased_until_ms ?? null, now + 3_000)).toBe(true);
  });
});
