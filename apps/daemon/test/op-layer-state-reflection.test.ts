import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import {
  StatusResultSchema,
  assertFrame,
  type EventBatch,
} from '@computer-history/protocol';

import type { Db } from '../src/db/database.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { OpError, Router, type BatchAckCounts } from '../src/ipc/router.js';
import { registerStatusOp, type StatusDeps } from '../src/ipc/status.js';
import type { Logger } from '../src/logging.js';
import { DiskGuard, DISK_LOW_BYTES } from '../src/services/disk-guard.js';

/**
 * Daemon-side plumbing the unit suites never pinned: status.get must reflect
 * the LIVE recording closure (main.ts wiring), and the main-wired batch
 * closure must gate BEFORE the ingestor ever sees a batch (spec §3.25).
 */

const logger: Logger = { log: vi.fn(), pruneOld: () => 0 };

describe('op-layer state reflection', () => {
  let db: Db;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-op-reflection-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function baseDeps(recording?: StatusDeps['recording']): StatusDeps {
    return {
      db,
      startedAtMs: Date.now(),
      daemonVersion: 'test',
      schemaVersion: 1,
      homeDir: home,
      ...(recording !== undefined ? { recording } : {}),
    };
  }

  it('status.get reports the live recording state and passes its own contract', async () => {
    const router = new Router(logger);
    registerStatusOp(router, baseDeps(() => ({ paused: true, reason: 'disk_pressure' })));

    const outcome = await router.dispatch('status.get', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Deep-equal INCLUDING reason: dropping it would blind the recorder UI.
    expect((outcome.result as { recording: unknown }).recording).toEqual({
      paused: true,
      reason: 'disk_pressure',
    });
    // The self-check at registration time holds for the paused shape too.
    expect(() => assertFrame(StatusResultSchema, outcome.result)).not.toThrow();
  });

  it('status.get defaults to an active recording shape without deps.recording', async () => {
    const router = new Router(logger);
    registerStatusOp(router, baseDeps());

    const outcome = await router.dispatch('status.get', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.result as { recording: unknown }).recording).toEqual({ paused: false });
  });

  function makePausedGuard(): DiskGuard {
    let call = 0;
    return new DiskGuard({
      path: home,
      logger,
      statfs: () => {
        call += 1;
        // First evaluation consumes both probes → paused; later probes fail so
        // the guard HOLDS paused instead of silently resuming.
        if (call <= 2) return { freeBytes: DISK_LOW_BYTES - 1 };
        throw new Error('ENOENT');
      },
    });
  }

  function wireBatchClosure(
    guard: DiskGuard,
    ingest: (batch: EventBatch) => BatchAckCounts,
  ): Router {
    // EXACT main.ts closure shape: gate first, ingest second.
    const router = new Router(logger);
    router.registerBatch(async (batch) => {
      const gate = await guard.gateBatch();
      if (!gate.ok) throw new OpError(gate.code, gate.message);
      return ingest(batch);
    });
    return router;
  }

  it('the gated batch handler refuses under disk pressure without touching the ingestor', async () => {
    const guard = makePausedGuard();
    await guard.evaluate(); // drive to paused
    const ingest = vi.fn(() => ({ accepted: 0, duplicates: 0, rejected: 0 }));
    const batch = {
      type: 'event_batch',
      id: ulid(),
      ts: Date.now(),
      batchId: ulid(),
      events: [],
    } as unknown as EventBatch;

    const outcome = await wireBatchClosure(guard, ingest).dispatchBatch(batch);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'error.disk_pressure' } });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('the gated batch handler passes counts through when the guard is ok', async () => {
    const guard = new DiskGuard({
      path: home,
      logger,
      statfs: () => ({ freeBytes: DISK_LOW_BYTES * 100 }),
    });
    const counts = { accepted: 3, duplicates: 1, rejected: 0 };
    const ingest = vi.fn(() => counts);
    const batch = {
      type: 'event_batch',
      id: ulid(),
      ts: Date.now(),
      batchId: ulid(),
      events: [],
    } as unknown as EventBatch;

    const outcome = await wireBatchClosure(guard, ingest).dispatchBatch(batch);
    expect(outcome).toEqual({ ok: true, counts });
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
