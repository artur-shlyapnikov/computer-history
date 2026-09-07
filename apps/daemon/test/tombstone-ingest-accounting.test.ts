import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { migrate } from '../src/db/migrator.js';
import { EventIngestor } from '../src/ingest/event-ingestor.js';
import type { Logger } from '../src/logging.js';

/**
 * PRIV-03 end-to-end at the INGEST layer: `excluded_app` events carrying
 * window/target metadata are tombstones that must arrive fact-only. The pure
 * classifier (`privacyRejection`) is pinned elsewhere; here we complete the
 * matrix that event-ingestor.test.ts established for reasons (a)–(d):
 * rejected ⇒ not inserted ⇒ counted in the batch ack ⇒ logged by reason.
 */

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(),
    observedAt: 1_000_000,
    monotonicNs: 500,
    source: 'workspace',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    action: 'app_focus',
    contentPolicy: 'metadata_only',
    ...overrides,
  };
}

/** Fact-only excluded_app tombstone as PrivacyFilter.tombstone() emits it. */
function tombstone(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({
    app: { bundleId: 'com.apple.BankApp', name: 'Bank', pid: 7 },
    action: 'app_focus',
    contentPolicy: 'excluded_app',
    ...overrides,
  });
}

function makeBatch(events: ActivityEvent[]): {
  protocolVersion: 1;
  messageId: string;
  type: 'event_batch';
  sentAt: number;
  batchId: string;
  events: ActivityEvent[];
} {
  return {
    protocolVersion: 1,
    messageId: ulid(),
    type: 'event_batch',
    sentAt: 1,
    batchId: ulid(),
    events,
  };
}

interface IngestorHarness {
  ingestor: EventIngestor;
  repo: EventsRepository;
  logLines: Array<{ level: string; scope: string; message: string; fields?: Record<string, unknown> }>;
  db: Db;
  cleanup(): void;
}

/** Real repository on a temp db; fake clock + recording logger for determinism. */
function makeHarness(): IngestorHarness {
  const home = mkdtempSync(path.join(tmpdir(), 'ch-tombstone-ingest-'));
  const db = openDatabase(path.join(home, 'history.db'));
  migrate(db);
  const repo = new EventsRepository(db);
  const logLines: Array<{ level: string; scope: string; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    log(level, scope, message, fields) {
      logLines.push({ level, scope, message, fields });
    },
    pruneOld: () => 0,
  };
  const currentMs = 10_000_000;
  const ingestor = new EventIngestor({ repository: repo, logger, now: () => currentMs });
  return {
    ingestor,
    repo,
    logLines,
    db,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('EventIngestor tombstone_with_metadata accounting', () => {
  let h: IngestorHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('rejects an excluded_app tombstone carrying window metadata and logs the reason', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([tombstone({ window: { title: 'Accounts — Bank' } })]),
    );
    expect(outcome).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.repo.count()).toBe(0);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      received: 1,
      accepted: 0,
      rejected: 1,
      reasons: { tombstone_with_metadata: 1 },
    });
  });

  it('rejects an excluded_app tombstone carrying only target metadata', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([tombstone({ target: { role: 'AXButton', identifier: 'pay' } })]),
    );
    expect(outcome).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.repo.count()).toBe(0);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      reasons: { tombstone_with_metadata: 1 },
    });
  });

  it('accounts a mixed batch: only the clean events are inserted in one ack', () => {
    const outcome = h.ingestor.ingest(
      makeBatch([
        tombstone(), // clean fact-only tombstone
        tombstone({ id: ulid(), window: { title: 'Secret doc' } }), // rejected
        makeEvent({ action: 'click' }), // normal allow-shape event
      ]),
    );
    expect(outcome).toEqual({ accepted: 2, duplicates: 0, rejected: 1 });
    expect(h.repo.count()).toBe(2);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      received: 3,
      accepted: 2,
      rejected: 1,
      reasons: { tombstone_with_metadata: 1 },
    });
  });

  it('keeps rejecting a redelivered window-tombstone instead of converting it to a duplicate', () => {
    const event = tombstone({ window: { title: 'Accounts — Bank' } });
    const first = h.ingestor.ingest(makeBatch([event]));
    expect(first).toMatchObject({ accepted: 0, rejected: 1 });
    const second = h.ingestor.ingest(makeBatch([event]));
    expect(second).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    // The id never entered the table, so there is nothing to dedupe against.
    expect(h.repo.count()).toBe(0);
    expect(h.logLines.at(-1)?.fields).toMatchObject({
      reasons: { tombstone_with_metadata: 1 },
    });
  });
});
