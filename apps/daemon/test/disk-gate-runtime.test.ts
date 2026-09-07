import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';

import type { EventBatch } from '@computer-history/protocol';

import { resolvePaths, type DaemonPaths } from '../src/config.js';
// vi.mock is hoisted above these imports, so main.ts (and transitively
// disk-guard.ts) see the mocked statfsSync.
import { buildRuntime, type DaemonRuntime } from '../src/main.js';

// Module-level statfs mock (established pattern, cf. daemon-version-fallback
// and config-env tests): DiskGuard's default probe reads node:fs.statfsSync,
// so forcing a below-threshold sample here exercises the REAL buildRuntime
// wiring — the gate.ok check in main.ts's registerBatch closure — with no
// DiskGuard-level injection.
const statfsMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: statfsMock };
});

/** One valid ingest event (same shape as the protocol fixture batch). */
function freshBatch(): EventBatch {
  const base = {
    observedAt: Date.now() - 1_000,
    monotonicNs: 1_000,
    source: 'accessibility' as const,
    app: { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 7 },
    action: 'text_change' as const,
    target: { role: 'AXTextArea', identifier: 'body' },
    contentPolicy: 'allow' as const,
    content: 'disk-pressure gate probe',
  };
  return {
    protocolVersion: 1,
    messageId: ulid(),
    type: 'event_batch',
    sentAt: Date.now(),
    batchId: ulid(),
    events: [{ ...base, id: ulid() }],
  };
}

describe('buildRuntime disk-pressure gate over the real wiring', () => {
  let home: string;
  let paths: DaemonPaths;
  let rt: DaemonRuntime | null = null;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-disk-gate-'));
    paths = resolvePaths(home);
    for (const dir of [paths.homeDir, paths.runDir, paths.spoolDir, paths.logsDir, paths.dataDir]) {
      mkdirSync(dir, { recursive: true });
    }
    // Free space pinned far below the 1 GiB pause threshold. Retention runs
    // once, rechecks, still sees the pinned low sample ⇒ paused.
    statfsMock.mockReturnValue({ bavail: 1, bsize: 512 });
  });

  afterEach(async () => {
    if (rt) {
      await rt.shutdown();
      rt = null;
    }
    statfsMock.mockReset();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses events.batch with error.disk_pressure through the real router and ingests nothing', async () => {
    rt = await buildRuntime(paths);

    const outcome = await rt.router.dispatchBatch(freshBatch());

    expect(outcome).toMatchObject({ ok: false, error: { code: 'error.disk_pressure' } });

    // Zero ingested events: the gate refused BEFORE touching the ingestor.
    await rt.shutdown();
    rt = null;
    const db = new Database(paths.dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('ingests normally when free space is above the pause threshold', async () => {
    // Plenty of free space: the gate must pass counts through untouched.
    statfsMock.mockReturnValue({ bavail: 8 * 1024 * 1024 * 1024, bsize: 512 });
    rt = await buildRuntime(paths);

    const outcome = await rt.router.dispatchBatch(freshBatch());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.counts).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });
    }
  });
});
