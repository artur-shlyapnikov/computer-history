import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logging.js';

/**
 * Direct unit pins for Logger.pruneOld (design P3-2): line-age arithmetic,
 * returned removal count, crash-tolerance of the active log, and the 0600
 * file mode surviving a prune rewrite.
 *
 * DEVIATION from the design doc resolved in round 29: the implementation now
 * matches the doc's crash-tolerance — an undatable line (unparseable JSON or
 * missing/non-numeric `at`) SURVIVES pruning; only lines with a parsed
 * timestamp older than the cutoff are dropped and counted.
 *
 * Timestamps are crafted so the "kept" boundary carries a 10 s guard band
 * against scheduler jitter between capturing `Date.now()` here and inside
 * pruneOld; any unit confusion (seconds/days vs ms) or sign flip in the age
 * computation moves the cutoff by orders of magnitude more than that band
 * and flips the assertions.
 */

const DAY_MS = 86_400_000;
const GUARD_BAND_MS = 10_000;

let dir: string;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function line(at: number): string {
  return `${JSON.stringify({ at, level: 'info', scope: 'test', message: 'm' })}\n`;
}

describe('createLogger().pruneOld', () => {
  it('removes exactly the 8-day-old line at pruneOld(7); younger lines survive', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    // Seed oldest first, then capture the near-cutoff timestamp LAST so the
    // distance to pruneOld's internal Date.now() stays within the guard band.
    const ancient = Date.now() - 8 * DAY_MS;
    const now = Date.now();
    const nearCutoff = Date.now() - 7 * DAY_MS + GUARD_BAND_MS;
    writeFileSync(
      logPath,
      line(ancient) + line(now) + line(nearCutoff),
      { mode: 0o600 },
    );

    const removed = createLogger(logPath).pruneOld(7);

    expect(removed).toBe(1);
    const survivors = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { at: number }).at);
    expect(survivors).toHaveLength(2);
    expect(survivors).toContain(now);
    expect(survivors).toContain(nearCutoff);
    expect(survivors).not.toContain(ancient);
  });

  it('keeps an unparseable trailing line and removes nothing', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fresh = Date.now();
    writeFileSync(logPath, line(fresh) + '{corrupted truncated\n', { mode: 0o600 });

    const removed = createLogger(logPath).pruneOld(7);

    expect(removed).toBe(0);
    const rest = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(rest).toHaveLength(2);
    expect((JSON.parse(rest[0]!) as { at: number }).at).toBe(fresh);
    expect(rest[1]).toBe('{corrupted truncated');
  });

  it('keeps a parseable line whose `at` is not numeric, prunes only the dated stale line', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    const stale = Date.now() - 9 * DAY_MS;
    writeFileSync(
      logPath,
      line(stale) + `${JSON.stringify({ at: 'yesterday', level: 'info' })}\n`,
      { mode: 0o600 },
    );

    const removed = createLogger(logPath).pruneOld(7);

    expect(removed).toBe(1);
    const rest = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(rest).toHaveLength(1);
    expect(JSON.parse(rest[0]!)).toEqual({ at: 'yesterday', level: 'info' });
  });

  it('keeps the file at mode 0600 after the prune rewrite', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    const logger = createLogger(logPath);
    logger.log('info', 'test', 'seed'); // first append creates the file 0600
    // Overwrite with one stale + one fresh line (mode of the EXISTING file
    // is untouched by writeFileSync).
    const stale = Date.now() - 9 * DAY_MS;
    writeFileSync(logPath, line(stale) + line(Date.now()), { flag: 'w' });

    const removed = logger.pruneOld(7);

    expect(removed).toBe(1);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
  it('keeps only the newest TORN_LINE_KEEP_CAP torn lines and counts evictions in the return', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    const torn = 'torn-crash-truncated-write';
    const parts: string[] = [];
    for (let i = 0; i < 60; i++) {
      parts.push(`${torn}-${i}`);
      parts.push(line(Date.now() - i * 1000));
    }
    writeFileSync(logPath, parts.join('\n') + '\n', { mode: 0o600 });

    const removed = createLogger(logPath).pruneOld(7);

    // All 60 datable lines are fresh enough to survive; the return must
    // include the 60 - cap evicted oldest torn lines.
    expect(removed).toBe(60 - 50);
    const survivors = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(survivors).toHaveLength(110); // 50 torn + 60 datable
    expect(survivors.filter((l) => l.startsWith(torn))).toHaveLength(50);
    // The newest torn lines survive; the oldest are gone.
    expect(survivors).toContain(`${torn}-59`);
    expect(survivors).toContain(`${torn}-10`);
    expect(survivors).not.toContain(`${torn}-9`);
    expect(survivors).not.toContain(`${torn}-0`);
  });

  it('honors an injected nowMs so the retention sweep derives the cutoff from one clock', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ch-log-prune-'));
    const logPath = path.join(dir, 'logs', 'daemon.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    const nowMs = Date.UTC(2026, 7, 15, 12, 0, 0);
    writeFileSync(logPath, line(nowMs - 8 * DAY_MS) + line(nowMs - 6 * DAY_MS));

    const removed = createLogger(logPath).pruneOld(7, nowMs);

    expect(removed).toBe(1);
    const rest = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(rest).toEqual([line(nowMs - 6 * DAY_MS).trimEnd()]);
  });
});
