import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logging.js';

describe('logger redaction', () => {
  it('redacts sensitive keys at every nesting depth', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-log-'));
    try {
      const logPath = path.join(dir, 'daemon.log');
      const logger = createLogger(logPath);
      logger.log('info', 'test', 'nested payload', {
        query: 'secret query',
        nested: {
          content: 'inner secret',
          ok: 'visible value',
          deeper: [{ text: 'deep secret' }, { title: 'secret title', snippet: 's' }],
        },
        flat: 'top-level visible',
      });
      const entry = JSON.parse(readFileSync(logPath, 'utf8')) as {
        query: string;
        nested: {
          content: string;
          ok: string;
          deeper: Array<{ text?: string; title?: string; snippet?: string }>;
        };
        flat: string;
      };
      expect(entry.query).toBe('[redacted]');
      expect(entry.nested.content).toBe('[redacted]');
      expect(entry.nested.ok).toBe('visible value');
      expect(entry.nested.deeper[0]?.text).toBe('[redacted]');
      expect(entry.nested.deeper[1]?.title).toBe('[redacted]');
      expect(entry.nested.deeper[1]?.snippet).toBe('[redacted]');
      expect(entry.flat).toBe('top-level visible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger file permissions (SEC-001)', () => {
  it('creates the log file with mode 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-log-'));
    try {
      const logPath = path.join(dir, 'logs', 'daemon.jsonl');
      const logger = createLogger(logPath);
      logger.log('info', 'test', 'first line');
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens a pre-existing log file to mode 0600', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-log-'));
    try {
      const logPath = path.join(dir, 'daemon.jsonl');
      writeFileSync(logPath, 'old install\n', { mode: 0o644 });
      chmodSync(logPath, 0o644);
      const logger = createLogger(logPath);
      logger.log('info', 'test', 'appended line');
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(logPath, 'utf8')).toContain('old install');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('errorMessage redaction (SEC-004 defense-in-depth)', () => {
  it('redacts errorMessage values at any depth', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ch-log-'));
    try {
      const logPath = path.join(dir, 'daemon.jsonl');
      const logger = createLogger(logPath);
      logger.log('error', 'db', 'History database needs recovery', {
        errorMessage: 'open failed: captured secret content',
        nested: { errorMessage: 'inner error secret' },
        plain: 'visible',
      });
      const entry = JSON.parse(readFileSync(logPath, 'utf8')) as {
        errorMessage: string;
        nested: { errorMessage: string };
        plain: string;
      };
      expect(entry.errorMessage).toBe('[redacted]');
      expect(entry.nested.errorMessage).toBe('[redacted]');
      expect(entry.plain).toBe('visible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
