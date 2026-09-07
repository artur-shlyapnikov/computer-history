import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePaths, type DaemonPaths } from '../src/config.js';
import { buildRuntime, type DaemonRuntime } from '../src/main.js';

const DAY = 86_400_000;

/**
 * Startup-hardening pins (R9-T1): buildRuntime's directory-tightening loop
 * (mkdir 0700 + UNCONDITIONAL chmod so pre-existing 0755 installs are pulled
 * back to 0700) and the startup log-prune branch that reports how many stale
 * JSONL lines it dropped. Functional suites never notice a deleted chmod loop
 * — db-file-modes.test.ts exists for exactly this reason but only covers the
 * DB/WAL/SHM file modes; a world-readable spool/logs dir defeats the 0600
 * modes of every file inside it.
 *
 * Safe in-process: buildRuntime takes fully injected paths, loadLlmConfig
 * tolerates absent credentials, PiRuntime creation is deferred into the chat
 * session factory, and shutdown() stops every timer it started.
 */

interface Line {
  at?: number;
  level?: string;
  scope?: string;
  message?: string;
  removed?: number;
  [key: string]: unknown;
}

function readLines(logPath: string): Line[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
}

describe('buildRuntime startup hardening', () => {
  let home: string;
  let rt: DaemonRuntime | null = null;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-startup-'));
  });

  afterEach(async () => {
    if (rt) {
      await rt.shutdown();
      rt = null;
    }
    rmSync(home, { recursive: true, force: true });
  });


  const fiveDirs = (p: DaemonPaths): string[] => [
    p.homeDir,
    p.runDir,
    p.spoolDir,
    p.logsDir,
    p.dataDir,
  ];

  function expectAllTightened(p: DaemonPaths): void {
    for (const dir of fiveDirs(p)) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  }

  it('tightens pre-existing loose directories to 0700', async () => {
    // Recursive mkdir alone would NOT tighten these — the unconditional
    // chmod is the whole point of the loop comment.
    const p = resolvePaths(home);
    for (const dir of fiveDirs(p)) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
    }

    rt = await buildRuntime(p);

    expectAllTightened(p);
  });

  it('creates fresh directories with mode 0700', async () => {
    // Guards a revert of `mode: 0o700` in the mkdir options.
    const p = resolvePaths(home);
    for (const dir of fiveDirs(p).slice(1)) expect(existsSync(dir)).toBe(false);

    rt = await buildRuntime(p);

    expectAllTightened(p);
  });

  it('prunes stale startup log lines and logs the sweep count', async () => {
    const p = resolvePaths(home);
    mkdirSync(p.logsDir, { recursive: true });
    const now = Date.now();
    const seeded: Line[] = [
      { at: now - 8 * DAY, level: 'info', scope: 'main', message: 'stale-one' },
      { at: now - 9 * DAY, level: 'info', scope: 'main', message: 'stale-two' },
      { at: now, level: 'info', scope: 'main', message: 'fresh-keeper' },
    ];
    writeFileSync(
      p.logPath,
      seeded.map((l) => JSON.stringify(l)).join('\n') + '\n',
      { mode: 0o600 },
    );

    rt = await buildRuntime(p);

    const lines = readLines(p.logPath);
    const messages = lines.map((l) => l.message);
    // Stale lines are gone, the fresh line survived the rewrite+append.
    expect(messages).not.toContain('stale-one');
    expect(messages).not.toContain('stale-two');
    expect(messages).toContain('fresh-keeper');
    // The sweep is announced exactly once with the removed count.
    const sweeps = lines.filter((l) => l.scope === 'logging' && l.message === 'pruned old log lines');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.removed).toBe(2);
  });

  it('emits no sweep entry when nothing was pruned', async () => {
    const p = resolvePaths(home);
    mkdirSync(p.logsDir, { recursive: true });
    writeFileSync(
      p.logPath,
      `${JSON.stringify({ at: Date.now(), level: 'info', scope: 'main', message: 'only-fresh' })}\n`,
      { mode: 0o600 },
    );

    rt = await buildRuntime(p);

    expect(
      readLines(p.logPath).some((l) => l.message === 'pruned old log lines'),
    ).toBe(false);
  });
});

