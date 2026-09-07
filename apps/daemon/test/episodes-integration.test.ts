import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EpisodeGetResultSchema,
  ServerHelloSchema,
  TimelineListResultSchema,
  assertFrame,
} from '@computer-history/protocol';

import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';

import {
  clientHello,
  connect,
  encodeFrame,
  readFrame,
  startDaemon,
  stopDaemon,
  type DaemonProcess,
} from './helpers/ipc.js';

const NOW = Date.now() - 3_600_000; // an hour back: below every watermark concern

interface EpisodeSummaryView {
  id: string;
  title: string;
  appNames: string[];
  stepCount: number;
  pendingJobs: number;
}

/**
 * M3 router integration (brief-m3 §D3 item 8): a REAL daemon over the real
 * unix socket answers timeline.list and episode.get from a SEEDED database.
 * The seed helper writes segments/steps/episodes directly (pre-start), so no
 * LLM or capture pipeline participates.
 */
describe('timeline.list / episode.get over the real unix socket (seeded DB)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let socket: net.Socket;

  const episodeIds: string[] = [];

  function seed(): void {
    mkdirSync(path.join(home, 'data'), { recursive: true });
    const db = openDatabase(path.join(home, 'data', 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    const segments = new SegmentsRepository(db);

    for (const spec of [
      { app: 'Safari', bundle: 'com.apple.Safari', stepCount: 2 },
      { app: 'Terminal', bundle: 'com.apple.Terminal', stepCount: 3 },
    ]) {
      const startedAtMs = NOW + episodeIds.length * 100_000;
      const segment = segments.createOpen(startedAtMs, `ev-${episodeIds.length}`, startedAtMs);
      const stepIds: string[] = [];
      for (let i = 0; i < spec.stepCount; i++) {
        const step: CoalescedStep = {
          action: 'type',
          appBundleId: spec.bundle,
          appName: spec.app,
          target: `t${i}`,
          text: `${spec.app} step ${i}`,
          startedAtMs: startedAtMs + i * 1000,
          endedAtMs: startedAtMs + i * 1000 + 500,
          firstEventId: ulid(startedAtMs),
          lastEventId: ulid(startedAtMs),
          eventCount: 1,
          targetRole: null,
        };
        stepIds.push(
          segments.appendStep(segment.id, step, { text: step.text, target: step.target, appName: spec.app }),
        );
      }
      segments.finalize(segment.id, 'finalized', startedAtMs + spec.stepCount * 1000, {});
      const episodeId = ulid(startedAtMs);
      episodeIds.push(episodeId);
      db.prepare(
        `INSERT INTO episodes (id, started_at_ms, ended_at_ms, title, summary, intent, outcome,
           apps_json, entities_json, summary_model, summary_prompt_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'v1', ?, ?)`,
      ).run(
        episodeId,
        startedAtMs,
        startedAtMs + spec.stepCount * 1000,
        `${spec.app} investigation`,
        `Summary of ${spec.app} work.`,
        'research',
        'unknown',
        JSON.stringify([spec.app]),
        JSON.stringify(['entity-1']),
        startedAtMs,
        startedAtMs,
      );
      // appendStep already mirrored each step into semantic_steps_fts; only
      // the episode-side links are added manually here (same shape
      // EpisodesRepository.insertEpisodesWithLinks writes).
      let ordinal = 0;
      const insertLink = db.prepare(
        'INSERT INTO episode_step_links (episode_id, semantic_step_id, ordinal) VALUES (?, ?, ?)',
      );
      for (const sid of stepIds) {
        insertLink.run(episodeId, sid, ordinal++);
      }
    }
    db.close();
  }

  async function request<T>(op: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: T; error?: { code: string; message: string } }> {
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op,
        requestId: ulid(),
        params,
      }),
    );
    for (;;) {
      const frame = await readFrame(socket);
      const value = frame.value;
      if (value.type === 'response') return value as { ok: boolean; result?: T; error?: { code: string; message: string } };
      // Skip server-pushed events (queue_update may arrive at any time).
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-episodes-e2e-'));
    seed();
    daemon = startDaemon(home);
    await daemon.ready;
    socket = await connect(daemon.socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello.value);
  }, 20_000);

  afterAll(async () => {
    socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('serves timeline.list newest-first with pendingJobs from the seeded episodes', async () => {
    const response = await request<{ episodes: EpisodeSummaryView[] }>('timeline.list', {});
    expect(response.ok).toBe(true);
    const result = response.result!;
    assertFrame(TimelineListResultSchema, { episodes: result.episodes });
    expect(result.episodes.map((e) => e.title)).toEqual([
      'Terminal investigation',
      'Safari investigation',
    ]);
    expect(result.episodes[0]!.stepCount).toBe(3);
    expect(result.episodes[0]!.appNames).toEqual(['Terminal']);
    expect(result.episodes[0]!.pendingJobs).toBe(0); // queue empty at boot
  });

  it('returns episode.get with the episode and its ordered steps', async () => {
    const response = await request<{ episode: { id: string }; steps: Array<{ ordinal: number }> }>(
      'episode.get',
      { id: episodeIds[1]! },
    );
    expect(response.ok).toBe(true);
    assertFrame(EpisodeGetResultSchema, response.result);
    expect(response.result.episode.id).toBe(episodeIds[1]);
    // Steps ordered by link ordinal, matching insertion order.
    expect(response.result.steps.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(response.result.steps[0]!.text).toContain('Terminal');
  });

  it('answers error.not_found for an unknown episode id', async () => {
    const response = await request<never>('episode.get', { id: ulid(NOW) });
    expect(response.ok).toBe(false);
    expect(response.error!.code).toBe('error.not_found');
  });

  it('shuts down cleanly (graceful shutdown path intact)', async () => {
    expect(await stopDaemon(daemon.child)).toBe(0);
    // Reopen readonly to prove WAL checkpoint left a consistent file.
    const db = new Database(path.join(home, 'data', 'history.db'), { readonly: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true }) as string;
      expect(integrity).toBe('ok');
      const n = db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      db.close();
    }
  });
});
