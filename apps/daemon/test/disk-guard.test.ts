import { describe, expect, it, vi } from 'vitest';

import { DiskGuard, DISK_LOW_BYTES, DISK_RESUME_BYTES } from '../src/services/disk-guard.js';
import type { Logger } from '../src/logging.js';


describe('DiskGuard (spec §3.25, brief-m7 §D7 item 3 — injected statfs)', () => {
  const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };

  function makeGuard(freeBytes: number, hooks: { retention?: () => void; state?: (paused: boolean, reason?: string) => void }) {
    return new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => ({ freeBytes }),
      triggerRetention: hooks.retention,
      onRecordingStateChanged: hooks.state,
    });
  }

  it('stays ok above the pinned 1 GiB threshold', async () => {
    const guard = makeGuard(DISK_LOW_BYTES + 1, {});
    expect(await guard.evaluate()).toBe('ok');
    expect(guard.isPaused()).toBe(false);
    expect(await guard.gateBatch()).toEqual({ ok: true });
  });

  it('gateBatch awaits the retention sweep; the recheck observes POST-sweep free space', async () => {
    const states: Array<[boolean, string?]> = [];
    let freeBytes = DISK_LOW_BYTES - 1;
    const probed: number[] = [];
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => {
        probed.push(freeBytes);
        return { freeBytes };
      },
      triggerRetention: () => {
        // The sweep frees a tracked file BEFORE the pause decision re-samples.
        freeBytes = DISK_LOW_BYTES + 512 * 1024 * 1024;
      },
      onRecordingStateChanged: (paused, reason) => states.push([paused, reason]),
    });
    // Round-31 pin asserted the OPPOSITE contract ('gateBatch resolves before
    // the scheduled sweep body runs'): there the setImmediate deferral made
    // the recheck sample LOW-1, so the guard paused and refused the batch
    // even though retention had freed plenty — this assertion fails on it.
    await expect(guard.gateBatch()).resolves.toEqual({ ok: true });
    // Probe sequence proves ordering: initial low sample, then a fresh
    // POST-sweep recheck that already saw the freed space.
    expect(probed).toEqual([DISK_LOW_BYTES - 1, DISK_LOW_BYTES + 512 * 1024 * 1024]);
    expect(states).toEqual([]); // never paused: retention recovered in-line
  });

  it('fires retention exactly ONCE (inline), then pauses and refuses batches below 1 GiB', async () => {
    let retentionRuns = 0;
    const states: Array<[boolean, string?]> = [];
    // Retention "frees" nothing here: still low ⇒ pause (the fresh recheck
    // runs after the inline sweep completed).
    const guard = makeGuard(DISK_LOW_BYTES - 1, {
      retention: () => {
        retentionRuns += 1;
      },
      state: (paused, reason) => states.push([paused, reason]),
    });

    expect(await guard.evaluate()).toBe('paused');
    expect(retentionRuns).toBe(1); // completed before the pause decision
    expect(guard.isPaused()).toBe(true);
    expect(states).toEqual([[true, 'disk_pressure']]);

    // Repeated evaluations must not re-fire retention nor re-broadcast.
    await guard.evaluate();
    await guard.evaluate();
    expect(retentionRuns).toBe(1);
    expect(states).toHaveLength(1);

    const gate = await guard.gateBatch();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('error.disk_pressure');
  });

  it('never pauses when the inline sweep frees past the low threshold', async () => {
    let freeBytes = DISK_LOW_BYTES - 1;
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => ({ freeBytes }),
      triggerRetention: () => {
        freeBytes = DISK_LOW_BYTES + 512 * 1024 * 1024; // sweep frees ~1.5 GiB
      },
    });
    // Spec §3.25 ordering: retention completes FIRST, then the recheck sees
    // the freed space — no transient pause, unlike the round-31 deferral.
    expect(await guard.evaluate()).toBe('ok');
    expect(guard.isPaused()).toBe(false);
    expect(await guard.gateBatch()).toEqual({ ok: true });
  });

  it('resumes only past the 1.2 GiB hysteresis and resets the retention latch', async () => {
    const states: Array<[boolean, string?]> = [];
    let freeBytes = DISK_LOW_BYTES - 1;
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => ({ freeBytes }),
      triggerRetention: () => undefined,
      onRecordingStateChanged: (paused, reason) => states.push([paused, reason]),
    });
    await guard.evaluate();
    expect(guard.isPaused()).toBe(true);

    // Between 1 GiB and 1.2 GiB: recovered-ish but STILL paused (hysteresis).
    freeBytes = DISK_RESUME_BYTES - 1024;
    expect(await guard.evaluate()).toBe('paused');

    freeBytes = DISK_RESUME_BYTES;
    expect(await guard.evaluate()).toBe('ok');
    expect(guard.isPaused()).toBe(false);
    expect(states).toEqual([
      [true, 'disk_pressure'],
      [false, undefined],
    ]);

    // After recovery a NEW low episode may fire retention again.
    freeBytes = DISK_LOW_BYTES - 1;
    await guard.evaluate();
    expect(guard.isPaused()).toBe(true);
  });

  it('fires retention first on every low episode, even when retention itself recovers', async () => {
    let freeBytes = DISK_LOW_BYTES - 1;
    let retentionRuns = 0;
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => ({ freeBytes }),
      triggerRetention: () => {
        retentionRuns += 1;
        freeBytes = DISK_LOW_BYTES + 512 * 1024 * 1024; // sweep frees ~1.5 GiB
      },
    });

    // Episode 1: low ⇒ the inline sweep frees enough, the recheck sees the
    // freed space, and recording never pauses.
    expect(await guard.evaluate()).toBe('ok');
    expect(retentionRuns).toBe(1);
    expect(guard.isPaused()).toBe(false);

    // Episode 2: dips below 1 GiB again; the latch reset above lets retention
    // fire FIRST again, and the post-sweep recheck recovers once more.
    freeBytes = DISK_LOW_BYTES - 1;
    expect(await guard.evaluate()).toBe('ok');
    expect(retentionRuns).toBe(2);
    expect(guard.isPaused()).toBe(false);
  });
});
