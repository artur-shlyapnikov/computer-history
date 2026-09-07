import { statfs } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Db } from '../db/database.js';
import type { Router } from '../ipc/router.js';
import { pageCountBytes } from '../db/database.js';

export interface StatusDeps {
  db: Db;
  startedAtMs: number;
  daemonVersion: string;
  schemaVersion: number;
  homeDir: string;
  /** Live recording state (M7 disk-pressure pause); defaults to active. */
  recording?: () => { paused: boolean; reason?: string };
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function jobCountByState(db: Db): Record<'pending' | 'retrying' | 'dead', number> {
  const rows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = 'retry' THEN 1 ELSE 0 END) AS retrying,
         SUM(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead
       FROM jobs`,
    )
    .get() as { pending: number | null; retrying: number | null; dead: number | null };
  return {
    pending: rows.pending ?? 0,
    retrying: rows.retrying ?? 0,
    dead: rows.dead ?? 0,
  };
}

/** Wire the fully-implemented `status.get` op (contracts §Protocol v1 shape). */
export function registerStatusOp(router: Router, deps: StatusDeps): void {
  router.register('status.get', () => {
    const queue = jobCountByState(deps.db);
    const result = {
      daemon: {
        version: deps.daemonVersion,
        schemaVersion: deps.schemaVersion,
        uptimeMs: Date.now() - deps.startedAtMs,
      },
      recording: deps.recording?.() ?? { paused: false },
      accessibilityRequired: false as const,
      queue,
      db: {
        rawEvents: count(deps.db, 'raw_events'),
        segments: count(deps.db, 'activity_segments'),
        steps: count(deps.db, 'semantic_steps'),
        episodes: count(deps.db, 'episodes'),
        memories: count(deps.db, 'memory_candidates'),
        workflows: count(deps.db, 'workflows'),
        pageCountBytes: pageCountBytes(deps.db),
      },
      diskFreeBytes: 0,
    };
    return statfs(deps.homeDir).then((stats) => ({
      ...result,
      diskFreeBytes: stats.bavail * Number(stats.bsize),
    }));
  });
}

export function daemonVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
