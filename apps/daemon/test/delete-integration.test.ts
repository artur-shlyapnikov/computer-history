import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoriesListResultSchema,
  assertFrame,
  type ActivityEvent,
} from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import { EpisodesRepository } from '../src/db/episodes-repository.js';
import { MemoriesRepository } from '../src/db/memories-repository.js';
import { WorkflowsRepository, type NewWorkflowInput } from '../src/db/workflows-repository.js';
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

/**
 * delete.range over the REAL unix socket (brief-m7 §D7 item 2): a fully
 * seeded history DB is loaded BEFORE the daemon boots, then wire-level
 * assertions prove per-table absence, FTS search-absence, manual-memory
 * survival and candidate-workflow purge end-to-end.
 */

const HOUR = 3_600_000;
const NOW = Date.now();

describe('daemon delete.range integration (real unix socket, seeded DB)', () => {
  let home: string;
  let dbPath: string;
  let db: Db;
  let daemon: DaemonProcess;
  let socket: net.Socket;
  let socketPath: string;

  const DOOM_TOKEN = 'quarxle'; // unique token present ONLY in the doomed band
  const KEEP_TOKEN = 'zorbwick'; // unique token present ONLY in the survivor band
  const doomedBand = { from: NOW - 2 * HOUR, to: NOW - HOUR };
  let doomedEpisodeId = '';
  let keptEpisodeId = '';
  let manualMemoryId = '';
  let doomedCandidateId = '';
  let confirmedWorkflowId = '';

  function seedRaw(observedAt: number, content: string): void {
    const events = new EventsRepository(db);
    const event: ActivityEvent = {
      id: ulid(),
      observedAt,
      source: 'accessibility',
      app: { bundleId: 'com.test.App', name: 'TestApp', pid: 7 },
      window: { title: 'Seed window' },
      action: 'click',
      target: { role: 'AXButton', label: 'Go' },
      contentPolicy: 'allow',
      content,
    };
    const result = events.insertBatch([event], observedAt);
    expect(result.accepted).toBe(1);
    expect(result.accepted, JSON.stringify(result)).toBe(1);
  }

  function seedEpisode(token: string, startMs: number): string {
    const segments = new SegmentsRepository(db);
    const episodes = new EpisodesRepository(db);
    const segment = segments.createOpen(startMs, `first-${token}`, startMs);
    const step: CoalescedStep = {
      action: 'click',
      appBundleId: 'com.test.App',
      appName: 'TestApp',
      target: `${token} button`,
      text: `${token} typed text`,
      startedAtMs: startMs,
      endedAtMs: startMs + 30_000,
      firstEventId: `fe-${token}`,
      lastEventId: `le-${token}`,
      eventCount: 1,
      targetRole: null,
    };
    segments.appendStep(segment.id, step, {
      text: step.text,
      target: step.target,
      appName: step.appName,
    });
    segments.finalize(segment.id, 'finalized', startMs + 60_000, {});
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: startMs,
          endedAtMs: startMs + 60_000,
          title: `${token} episode`,
          summary: `${token} summary`,
          intent: 'seed intent',
          outcome: 'done',
          apps: ['TestApp'],
          entities: [],
          summaryModel: 'seed-model',
          summaryPromptVersion: 'v1',
          steps: [{ id: segments.getSteps(segment.id)[0]!.id }],
        },
      ],
      startMs,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  async function request(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      // Full-matrix runs spawn many daemons; the default 3s can be too tight
      // under load, so wait up to 15s per frame.
      const frame = await readFrame(socket, 15_000);
      if (frame.value.type === 'event') continue; // server broadcast (e.g. queue_update)
      expect(frame.value.type).toBe('response');
      return frame.value;
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-delete-itest-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    dbPath = path.join(home, 'data', 'history.db');
    db = openDatabase(dbPath);
    migrate(db);

    doomedEpisodeId = seedEpisode(DOOM_TOKEN, NOW - 2 * HOUR);
    keptEpisodeId = seedEpisode(KEEP_TOKEN, NOW + HOUR);
    seedRaw(NOW - 2 * HOUR, `${DOOM_TOKEN} raw click`);
    seedRaw(NOW + HOUR, `${KEEP_TOKEN} raw click`);

    const memories = new MemoriesRepository(db);
    // Memory whose ONLY evidence is the doomed episode ⇒ invalidated.
    const invalidated = memories.upsertCandidate(
      { kind: 'fact', canonicalKey: 'k-doom', text: `${DOOM_TOKEN} claim`, confidence: 0.9 },
      { episodeId: doomedEpisodeId, confidence: 0.9, observedAtMs: NOW - 2 * HOUR },
      NOW - 2 * HOUR,
    );
    // Manually confirmed memory with ONLY doomed-episode evidence ⇒ survives.
    const manual = memories.upsertCandidate(
      { kind: 'procedure', canonicalKey: 'k-manual', text: `${DOOM_TOKEN} manual procedure`, confidence: 0.8 },
      { episodeId: doomedEpisodeId, confidence: 0.8, observedAtMs: NOW - 2 * HOUR },
      NOW - 2 * HOUR,
    );
    memories.confirm(manual.memoryId, NOW);
    manualMemoryId = manual.memoryId;
    void invalidated;

    const workflows = new WorkflowsRepository(db);
    const candidateInput: NewWorkflowInput = {
      name: `${DOOM_TOKEN} routine`,
      purpose: null,
      template: { name: 't', stableSteps: ['s'] },
      occurrences: [
        { episodeId: doomedEpisodeId, similarity: 0.9 },
        { episodeId: keptEpisodeId, similarity: 0.91 },
        { episodeId: keptEpisodeId, similarity: 0.91 },
      ],
      firstSeenAtMs: NOW - 2 * HOUR,
      lastSeenAtMs: NOW + HOUR,
    };
    // Candidate loses its doomed occurrence AND sits below thresholds after
    // dedupe of the double-kept pair ⇒ purged by the cascade.
    doomedCandidateId = workflows.insertWorkflow(
      {
        ...candidateInput,
        occurrences: [
          { episodeId: doomedEpisodeId, similarity: 0.9 },
          { episodeId: keptEpisodeId, similarity: 0.91 },
          { episodeId: keptEpisodeId, similarity: 0.91 },
        ],
      },
      NOW,
    );
    confirmedWorkflowId = workflows.insertWorkflow(candidateInput, NOW);
    workflows.updateStatus(confirmedWorkflowId, 'confirmed', NOW);
    db.close();

    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
    socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    if (socket && !socket.destroyed) socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('answers delete.range over the wire with cascade stats', async () => {
    const response = await request('delete.range', { from: doomedBand.from, to: doomedBand.to });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      deleted: { rawEvents: 1, steps: 1, episodes: 1, memories: 1, workflows: 1 },
    });
  });

  it('proves search absence for the doomed band and presence for survivors', async () => {
    const doomed = await request('history.search', { query: DOOM_TOKEN, scope: 'both' });
    // The ONLY surviving doom-token content is the manually confirmed memory,
    // which history.search (episodes/steps scope) must not surface.
    expect((doomed.result as { hits: unknown[] }).hits).toEqual([]);

    const kept = await request('history.search', { query: KEEP_TOKEN, scope: 'both' });
    expect((kept.result as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });

  it('keeps the manually confirmed memory listed and searchable while the invalidated one is gone', async () => {
    const listed = await request('memories.list', {});
    assertFrame(MemoriesListResultSchema, listed.result);
    const memories = listed.result.groups.flatMap((g) => g.memories);
    expect(memories.some((m) => m.id === manualMemoryId)).toBe(true);
    expect(memories.some((m) => m.text.includes('invalidated-marker'))).toBe(false);
    expect(memories.filter((m) => m.text.includes(DOOM_TOKEN))).toHaveLength(1);
  });

  it('purged the below-threshold candidate but kept the confirmed workflow', async () => {
    const listed = await request('workflows.list', {});
    const workflows = (listed.result as { workflows: Array<{ id: string; status: string }> })
      .workflows;
    expect(workflows.some((w) => w.id === doomedCandidateId)).toBe(false);
    const confirmed = workflows.find((w) => w.id === confirmedWorkflowId);
    expect(confirmed?.status).toBe('confirmed');
  });

  it('is idempotent over the wire: a second identical delete answers zeros', async () => {
    const response = await request('delete.range', { from: doomedBand.from, to: doomedBand.to });
    expect(response.result).toEqual({
      deleted: { rawEvents: 0, steps: 0, episodes: 0, memories: 0, workflows: 0 },
    });
  });
});

/**
 * GateM7b regressions over the REAL unix socket: preset:"all" must spare ONLY
 * manually confirmed memories (still FTS-searchable) while zeroing raw
 * events/steps/episodes/evidence/occurrences and purging below-threshold
 * candidates — confirmed/rejected workflows persist frozen. Also pins the
 * exactly-once change-event contract: episodes_changed/memories_changed/
 * workflows_changed arrive EXACTLY once per delete.range, before the response.
 */
describe('daemon delete.range preset:"all" + exactly-once change events', () => {
  let home: string;
  let dbPath: string;
  let db: Db;
  let daemon: DaemonProcess;
  let socket: net.Socket;
  const MANUAL_TOKEN = 'blorvane'; // only in the surviving manual memory
  const NONMANUAL_TOKEN = 'crelthik'; // only in the doomed non-manual memory
  let manualMemoryId = '';
  let confirmedWfId = '';
  let rejectedWfId = '';
  let doomedCandidateId = '';

  function seedAllBand(): string {
    const segments = new SegmentsRepository(db);
    const episodes = new EpisodesRepository(db);
    const startMs = NOW - HOUR;
    const segment = segments.createOpen(startMs, 'all-band-segment', startMs);
    const step: CoalescedStep = {
      action: 'click',
      appBundleId: 'com.test.App',
      appName: 'TestApp',
      target: 'all-band button',
      text: 'all-band typed text',
      startedAtMs: startMs,
      endedAtMs: startMs + 30_000,
      firstEventId: 'fe-all-band',
      lastEventId: 'le-all-band',
      eventCount: 1,
      targetRole: null,
    };
    segments.appendStep(segment.id, step, {
      text: step.text,
      target: step.target,
      appName: step.appName,
    });
    segments.finalize(segment.id, 'finalized', startMs + 60_000, {});
    const [episodeId] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: startMs,
          endedAtMs: startMs + 60_000,
          title: 'all-band episode',
          summary: 'all-band summary',
          intent: 'seed intent',
          outcome: 'done',
          apps: ['TestApp'],
          entities: [],
          summaryModel: 'seed-model',
          summaryPromptVersion: 'v1',
          steps: [{ id: segments.getSteps(segment.id)[0]!.id }],
        },
      ],
      startMs,
    );
    if (episodeId === undefined) throw new Error('seed failed');
    return episodeId;
  }

  function seedRaw(observedAt: number, content: string): void {
    const events = new EventsRepository(db);
    const event: ActivityEvent = {
      id: ulid(),
      observedAt,
      source: 'accessibility',
      app: { bundleId: 'com.test.App', name: 'TestApp', pid: 7 },
      window: { title: 'Seed window' },
      action: 'click',
      target: { role: 'AXButton', label: 'Go' },
      contentPolicy: 'allow',
      content,
    };
    const result = events.insertBatch([event], observedAt);
    expect(result.accepted, JSON.stringify(result)).toBe(1);
  }

  async function requestCollectingEvents(
    op: string,
    params: Record<string, unknown>,
  ): Promise<{ response: Record<string, unknown>; eventKinds: string[] }> {
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
    // The fixed lossless reader hands out coalesced frames FIFO, so every
    // event that reached the wire BEFORE the response is counted here.
    const eventKinds: string[] = [];
    for (;;) {
      const frame = await readFrame(socket, 15_000);
      if (frame.value.type === 'event') {
        eventKinds.push(String(frame.value.kind));
        continue;
      }
      expect(frame.value.type).toBe('response');
      return { response: frame.value, eventKinds };
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-delete-all-'));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    dbPath = path.join(home, 'data', 'history.db');
    db = openDatabase(dbPath);
    migrate(db);

    const episodeId = seedAllBand();
    seedRaw(NOW - HOUR, 'all-band raw click');

    const memories = new MemoriesRepository(db);
    // Manual confirm whose ONLY evidence dies ⇒ survives the 'all' preset.
    const manual = memories.upsertCandidate(
      { kind: 'procedure', canonicalKey: 'k-all-manual', text: `${MANUAL_TOKEN} keep me`, confidence: 0.8 },
      { episodeId, confidence: 0.8, observedAtMs: NOW - HOUR },
      NOW - HOUR,
    );
    memories.confirm(manual.memoryId, NOW);
    manualMemoryId = manual.memoryId;
    // Non-manual candidate whose ONLY evidence dies ⇒ hard-deleted (+FTS).
    const nonManual = memories.upsertCandidate(
      { kind: 'fact', canonicalKey: 'k-all-nonmanual', text: `${NONMANUAL_TOKEN} doomed`, confidence: 0.9 },
      { episodeId, confidence: 0.9, observedAtMs: NOW - HOUR },
      NOW - HOUR,
    );
    void nonManual;

    const workflows = new WorkflowsRepository(db);
    const wfInput = {
      name: 'all-band routine',
      purpose: null,
      template: { name: 't', stableSteps: ['s'] },
      occurrences: [{ episodeId, similarity: 0.9 }],
      firstSeenAtMs: NOW - HOUR,
      lastSeenAtMs: NOW - HOUR,
    };
    confirmedWfId = workflows.insertWorkflow(wfInput, NOW);
    workflows.updateStatus(confirmedWfId, 'confirmed', NOW);
    rejectedWfId = workflows.insertWorkflow({ ...wfInput, name: 'all-band reject' }, NOW);
    workflows.updateStatus(rejectedWfId, 'rejected', NOW);
    // Single occurrence ⇒ already below candidate thresholds ⇒ purged.
    doomedCandidateId = workflows.insertWorkflow({ ...wfInput, name: 'all-band candidate' }, NOW);
    db.close();

    daemon = startDaemon(home);
    await daemon.ready;
    socket = await connect(daemon.socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    if (socket && !socket.destroyed) socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('fires episodes_changed/memories_changed/workflows_changed exactly once each before the response', async () => {
    const { response, eventKinds } = await requestCollectingEvents('delete.range', { preset: 'all' });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      deleted: { rawEvents: 1, steps: 1, episodes: 1, memories: 1, workflows: 1 },
    });
    for (const kind of ['episodes_changed', 'memories_changed', 'workflows_changed']) {
      expect(eventKinds.filter((k) => k === kind), kind).toHaveLength(1);
    }
  });

  it('preset "all" spares only the manual-confirmed memory and zeroes everything else', async () => {
    // Wire-level survival: the manually confirmed memory is still listed.
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'memories.list',
        requestId: ulid(),
        params: {},
      }),
    );
    let listed: Record<string, unknown>;
    for (;;) {
      const frame = await readFrame(socket, 15_000);
      if (frame.value.type === 'event') continue;
      expect(frame.value.type).toBe('response');
      listed = frame.value;
      break;
    }
    assertFrame(MemoriesListResultSchema, listed.result);
    const wireMemories = listed.result.groups.flatMap((g) => g.memories);
    expect(wireMemories.some((m) => m.id === manualMemoryId)).toBe(true);

    // Second WAL reader while the daemon holds the writer: direct table/FTS
    // proofs that would need a memories.search op otherwise.
    const check = openDatabase(dbPath);
    try {
      const count = (table: string): number => {
        const row = check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        return row.n;
      };
      // Manual-confirmed survivor stays FTS-searchable by rowid…
      const ftsHits = check
        .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
        .get(MANUAL_TOKEN) as { n: number };
      expect(ftsHits.n).toBe(1);
      // …while the non-manual memory is gone from rows AND its FTS mirror…
      expect(count('memory_candidates')).toBe(1); // the manual one only
      expect(count('memories_fts')).toBe(1);
      const nonManualFts = check
        .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
        .get(NONMANUAL_TOKEN) as { n: number };
      expect(nonManualFts.n).toBe(0);
      // …and raw/steps/episodes/evidence/occurrences are all zeroed.
      expect(count('raw_events')).toBe(0);
      expect(count('semantic_steps')).toBe(0);
      expect(count('episodes')).toBe(0);
      expect(count('memory_evidence')).toBe(0);
      expect(count('workflow_occurrences')).toBe(0);
      // Confirmed + rejected workflows persist; the below-threshold candidate
      // was purged.
      const wfRows = check.prepare('SELECT id, status FROM workflows').all() as Array<{
        id: string;
        status: string;
      }>;
      expect(wfRows.find((w) => w.id === confirmedWfId)?.status).toBe('confirmed');
      expect(wfRows.find((w) => w.id === rejectedWfId)?.status).toBe('rejected');
      expect(wfRows.some((w) => w.id === doomedCandidateId)).toBe(false);
    } finally {
      check.close();
    }
  });
});
