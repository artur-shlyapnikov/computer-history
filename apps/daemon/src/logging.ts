import { DIAGNOSTICS_MAX_LAST_ERRORS } from '@computer-history/protocol';

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

/** Keys whose values must never reach the log file (content-redacted logging). */
const redactedKeys = new Set([
  'content',
  'text',
  'title',
  'snippet',
  'query',
  'windowTitle',
  'targetLabel',
  'password',
  'token',
  'apiKey',
  // Content-derived error strings can embed captured text verbatim
  // (defense-in-depth for SEC-004).
  'errorMessage',
]);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, scope: string, message: string, fields?: LogFields): void;
  /**
   * Drop log lines older than `retentionDays`; returns removed line count.
   * `nowMs` pins the cutoff clock (retention derives every window from one
   * sweep timestamp); defaults to Date.now().
   */
  pruneOld(retentionDays: number, nowMs?: number): number;
}

/** One entry of the in-memory error ring surfaced by `diagnostics.get`. */
export interface RecentError {
  at: number;
  scope: string;
  code: string;
  message: string;
}

function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const out: LogFields = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = redactedKeys.has(key) ? '[redacted]' : redactDeep(v);
    }
    return out;
  }
  return value;
}

/** Redacts sensitive keys at every depth so nested payloads never leak. */
function redact(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  return redactDeep(fields) as LogFields;
}

/** Newest torn (undatable) lines kept across prunes: crash-truncated tails survive one prune cycle each; beyond the cap the oldest torn lines are dropped so the file stays bounded. */
const TORN_LINE_KEEP_CAP = 50;

/**
 * JSONL file logger. One JSON object per line; sensitive field values are
 * replaced before serialization so content never reaches disk via logs.
 */
export function createLogger(logPath: string): Logger & { recentErrors(): RecentError[] } {
  // Newest-first tail served by diagnostics.get; the cap is the SAME bound
  // pinned as lastErrors maxItems in DiagnosticsGetResultSchema.
  const errorRing: RecentError[] = [];
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  try {
    // Tighten pre-existing installs created before the mode was enforced.
    chmodSync(logPath, 0o600);
  } catch {
    // Not created yet; first append below creates it with mode 0o600.
  }
  return {
    log(level, scope, message, fields) {
      const safeFields = redact(fields);
      if (level === 'error') {
        // code rides as a plain string when callers provide one; anything else
        // collapses to the pinned fallback so the wire shape always holds.
        const code = typeof safeFields.code === 'string' ? safeFields.code : 'error';
        errorRing.push({ at: Date.now(), scope, code, message });
        if (errorRing.length > DIAGNOSTICS_MAX_LAST_ERRORS) errorRing.shift();
      }
      const entry = {
        at: Date.now(),
        level,
        scope,
        message,
        ...safeFields,
      };
      try {
        writeFileSync(logPath, JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 });
      } catch {
        // Logging must never take the daemon down.
      }
    },
    /** Newest-first snapshot of the last errors, bounded by construction. */
    recentErrors(): RecentError[] {
      return [...errorRing].reverse();
    },
    pruneOld(retentionDays, nowMs = Date.now()) {
      let raw: string;
      try {
        if (!statSync(logPath).isFile()) return 0;
        raw = readFileSync(logPath, 'utf8');
      } catch {
        return 0;
      }
      const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const undatable: number[] = [];
      const kept: string[] = [];
      let removed = 0;
      lines.forEach((line, index) => {
        try {
          const parsed = JSON.parse(line) as { at?: number };
          // Datable lines keep the age-based rule; undatable lines (torn
          // crash-truncated writes, missing/non-numeric `at`) are collected
          // so the newest TORN_LINE_KEEP_CAP can survive.
          if (typeof parsed.at !== 'number') undatable.push(index);
          else if (parsed.at >= cutoff) kept.push(line);
          else removed++;
        } catch {
          undatable.push(index);
        }
      });
      // Keep only the cap newest torn lines so repeated crash truncation
      // cannot grow the log without bound.
      const evictedTorn = Math.max(0, undatable.length - TORN_LINE_KEEP_CAP);
      removed += evictedTorn;
      for (const index of undatable.slice(evictedTorn)) {
        const line = lines.at(index);
        if (line !== undefined) kept.push(line);
      }
      if (removed > 0) {
        const tmpPath = `${logPath}.tmp`;
        const content = kept.join('\n') + (kept.length > 0 ? '\n' : '');
        const fd = openSync(tmpPath, 'w', 0o600);
        try {
          writeSync(fd, content);
          // The rename alone is not durable: without fsync a crash can leave
          // the renamed log empty or partial (metadata not yet flushed).
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, logPath);
      }
      return removed;
    },
  };
}
