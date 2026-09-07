import { describe, expect, it, vi, type Mock } from 'vitest';

import type { Logger } from '../src/logging.js';
import { DiskGuard, DISK_CHECK_INTERVAL_MS, DISK_LOW_BYTES, DISK_RESUME_BYTES } from '../src/services/disk-guard.js';

/**
 * Fault-injection decision table over DiskGuard (spec §3.25): every
 * (state, probe) → transition row, driven through evaluate()/gateBatch() —
 * except case 9, which drives the 60 s timer path itself. Since round-32 the
 * retention sweep completes INLINE inside evaluate() before the pause
 * decision re-samples, so every row is fully synchronous once its evaluate()
 * promise resolves.
 */
describe('DiskGuard fault paths and boundaries', () => {
  const LOW = DISK_LOW_BYTES;

  interface Harness {
    guard: DiskGuard;
    probes: Array<number | Error>;
    statfsCalls: () => number;
    retention: Mock;
    states: Array<[boolean, string?]>;
    logs: Mock;
  }

  /** `probes` is consumed front-to-back; a trailing entry repeats forever. */
  function makeHarness(probes: Array<number | Error>, retention?: (...args: []) => void): Harness {
    const queue = [...probes];
    let calls = 0;
    const retentionFn = vi.fn(retention ?? (() => {}));
    const logs = vi.fn();
    const logger: Logger = { log: logs, pruneOld: () => 0 };
    const states: Array<[boolean, string?]> = [];
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => {
        calls += 1;
        if (queue.length > 1) {
          const next = queue.shift()!;
          if (next instanceof Error) throw next;
          return { freeBytes: next };
        }
        const last = queue[0]!;
        if (last instanceof Error) throw last;
        return { freeBytes: last };
      },
      triggerRetention: () => retentionFn(),
      onRecordingStateChanged: (paused, reason) => states.push([paused, reason]),
    });
    return { guard, probes: queue, statfsCalls: () => calls, retention: retentionFn, states, logs };
  }

  it('case 1: probe failure holds "ok", warns, never triggers retention, ingest stays open', async () => {
    const h = makeHarness([new Error('ENOENT'), LOW * 10]);
    expect(await h.guard.evaluate()).toBe('ok');
    expect(h.logs).toHaveBeenCalledWith(
      'warn',
      'disk-guard',
      'statfs failed',
      expect.objectContaining({ errorMessage: 'ENOENT' }),
    );
    expect(h.retention).not.toHaveBeenCalled();
    // The gate re-probes internally; failure keeps the previous (open) state.
    expect(await h.guard.gateBatch()).toEqual({ ok: true });
  });

  it('case 2: probe failure holds "paused" (fail-safe) and the batch gate refuses', async () => {
    const h = makeHarness([LOW - 1, LOW - 1, new Error('ENOENT')]);
    expect(await h.guard.evaluate()).toBe('paused');
    expect(h.states).toEqual([[true, 'disk_pressure']]);
    h.states.length = 0;
    // A failing probe must never silently resume recording.
    expect(await h.guard.evaluate()).toBe('paused');
    expect(h.states).toEqual([]);
    const gate = await h.guard.gateBatch();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('error.disk_pressure');
  });

  it('case 3: free space EXACTLY at the low threshold is not low (<, not <=)', async () => {
    const h = makeHarness([LOW]);
    expect(await h.guard.evaluate()).toBe('ok');
    expect(h.retention).not.toHaveBeenCalled();
    expect(h.statfsCalls()).toBe(1); // no post-retention recheck probe either
  });

  it('case 4: low fires retention ONCE inline, rechecks with a FRESH probe, then pauses', async () => {
    const h = makeHarness([LOW - 1, LOW - 1]);
    expect(await h.guard.evaluate()).toBe('paused');
    // Round-32 ordering: the sweep COMPLETED before the pause decision — on
    // the round-31 setImmediate deferral this count was still 0 here and only
    // reached 1 after flushing one macrotask.
    expect(h.retention).toHaveBeenCalledTimes(1);
    expect(h.states).toEqual([[true, 'disk_pressure']]);
    expect(h.statfsCalls()).toBe(2); // initial + fresh post-sweep recheck
    expect(h.logs).toHaveBeenCalledWith(
      'warn',
      'disk-guard',
      'free space below 1GiB; triggering retention',
      { freeBytes: LOW - 1 },
    );
  });

  it('case 5: retention freeing space ends the episode and resets the latch', async () => {
    // Probes: pre-sweep low, then the post-sweep recheck sees the freed space.
    const h = makeHarness([LOW - 1, LOW + 1024 * 1024 * 1024]);
    // Episode 1: low ⇒ retention runs INLINE and "frees" enough; the fresh
    // recheck observes the higher number so recording never pauses and the
    // latch resets. On round-31 code the recheck sampled BEFORE the deferred
    // sweep, so this evaluation paused instead — the branch was unreachable.
    expect(await h.guard.evaluate()).toBe('ok');
    expect(h.states).toEqual([]);
    expect(h.retention).toHaveBeenCalledTimes(1);

    // Episode 2 (fresh probes): the latch was reset → retention fires AGAIN.
    h.probes.splice(0, h.probes.length, LOW - 1, LOW - 1);
    expect(await h.guard.evaluate()).toBe('paused');
    expect(h.retention).toHaveBeenCalledTimes(2);
    expect(h.states).toEqual([[true, 'disk_pressure']]);
  });

  it('case 6: a throwing retention trigger is contained, logged, and ingest still answers', async () => {
    const h = makeHarness([LOW - 1, LOW - 1], () => {
      throw new Error('retention exploded');
    });
    // The inline sweep's throw is caught inside runRetention; the pause
    // decision proceeds on the fresh recheck and evaluate() resolves.
    expect(await h.guard.evaluate()).toBe('paused');
    expect(h.states).toEqual([[true, 'disk_pressure']]);
    expect(h.logs).toHaveBeenCalledWith(
      'error',
      'disk-guard',
      'retention trigger failed',
      { errorMessage: 'retention exploded' },
    );
    const gate = await h.guard.gateBatch();
    expect(gate.ok).toBe(false); // still low ⇒ refused, never a hang or throw
    if (!gate.ok) expect(gate.code).toBe('error.disk_pressure');
  });

  it('case 7: failed recheck keeps the previous state AND the latch armed', async () => {
    const h = makeHarness([LOW - 1, new Error('recheck ENOENT')]);
    expect(await h.guard.evaluate()).toBe('ok'); // pre-recheck state survives
    expect(h.states).toEqual([]);
    expect(h.retention).toHaveBeenCalledTimes(1); // ran inline despite the failing recheck

    // Latch stayed true → the next low evaluation does NOT re-fire retention,
    // but its successful recheck still pauses.
    h.probes.splice(0, h.probes.length, LOW - 1, LOW - 1);
    expect(await h.guard.evaluate()).toBe('paused');
    expect(h.retention).toHaveBeenCalledTimes(1);
    expect(h.states).toEqual([[true, 'disk_pressure']]);
  });

  it('case 8: hysteresis dead-band below resume; exact resume value recovers', async () => {
    const h = makeHarness([LOW - 1, LOW - 1]);
    expect(await h.guard.evaluate()).toBe('paused');

    h.probes.splice(0, h.probes.length, DISK_RESUME_BYTES - 1);
    expect(await h.guard.evaluate()).toBe('paused'); // one byte short of the dead-band exit

    h.probes.splice(0, h.probes.length, DISK_RESUME_BYTES);
    expect(await h.guard.evaluate()).toBe('ok'); // >= at the exact boundary
    expect(h.states).toEqual([[true, 'disk_pressure'], [false, undefined]]);
  });

  it('case 9: a throwing state-change callback on the TIMER path is contained and logged, never an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      const logs = vi.fn();
      const logger: Logger = { log: logs, pruneOld: () => 0 };
      // IpcServer.broadcastEvent throws TypeError on payload-schema mismatch;
      // onRecordingStateChanged is that broadcast's seam.
      const guard = new DiskGuard({
        path: '/tmp/unused',
        logger,
        statfs: () => ({ freeBytes: LOW - 1 }),
        onRecordingStateChanged: () => {
          throw new TypeError('recording_state payload schema mismatch');
        },
      });
      guard.start();
      // Drives the interval callback exactly as production does; if the
      // tick's promise escaped unconsumed, this rejects unhandled and fails
      // the run instead of reaching the assertions below.
      await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS);
      expect(guard.isPaused()).toBe(true); // the pause decision still completed
      expect(logs).toHaveBeenCalledWith(
        'error',
        'disk-guard',
        'retention tick failed',
        expect.objectContaining({ errorMessage: 'recording_state payload schema mismatch' }),
      );
      guard.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('case 10: a throwing resume broadcast keeps the gate PAUSED until a later tick retries it', async () => {
    const logs = vi.fn();
    const logger: Logger = { log: logs, pruneOld: () => 0 };
    const RECOVERED = DISK_RESUME_BYTES;
    // Two low samples drive the pause evaluate(); everything after is past
    // the hysteresis threshold.
    const samples: number[] = [LOW - 1, LOW - 1];
    const broadcasts: Array<[boolean, string?]> = [];
    let callbackCalls = 0;
    const guard = new DiskGuard({
      path: '/tmp/unused',
      logger,
      statfs: () => ({ freeBytes: samples.length > 0 ? samples.shift()! : RECOVERED }),
      triggerRetention: () => {},
      onRecordingStateChanged: (paused, reason) => {
        callbackCalls += 1;
        if (callbackCalls === 2) {
          // First resume attempt: the recording_state broadcast throws
          // (IpcServer.broadcastEvent TypeError on payload-schema mismatch —
          // the only throw path out of evaluate()'s resume branch).
          throw new TypeError('recording_state payload schema mismatch');
        }
        broadcasts.push([paused, reason]);
      },
    });

    // Pause episode: broadcast succeeds, gate refuses.
    await guard.evaluate();
    expect(guard.isPaused()).toBe(true);
    expect(broadcasts).toEqual([[true, 'disk_pressure']]);

    // Space recovers but the resume broadcast throws: evaluate() rejects and
    // the guard MUST stay paused (fail-safe mirror of the pause branch —
    // flipping state before the broadcast would leave gate=ok while the
    // recorder never learned recording resumed).
    await expect(guard.evaluate()).rejects.toThrow('recording_state payload schema mismatch');
    expect(guard.isPaused()).toBe(true);

    // Next tick retries the resume: callback succeeds, state flips to ok.
    const resumed = await guard.evaluate();
    expect(resumed).toBe('ok');
    expect(guard.isPaused()).toBe(false);
    expect(callbackCalls).toBe(3);
    expect(broadcasts).toEqual([
      [true, 'disk_pressure'],
      [false, undefined],
    ]);
  });
});
