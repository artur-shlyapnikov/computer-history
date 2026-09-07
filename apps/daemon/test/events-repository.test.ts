import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { migrate } from '../src/db/migrator.js';
import { CONSTANTS } from '../src/config.js';
import { privacyRejection } from '../src/ingest/validation.js';

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(),
    observedAt: 1_000_000,
    monotonicNs: 500,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    window: { title: 'Doc — Safari' },
    action: 'text_change',
    target: { role: 'AXTextArea', identifier: 'body' },
    contentPolicy: 'allow',
    captureSessionId: ulid(),
    ...overrides,
  };
}

describe('EventsRepository', () => {
  let db: Db;
  let repo: EventsRepository;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-events-repo-'));
    db = openDatabase(path.join(home, 'history.db'));
    migrate(db);
    repo = new EventsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe('insertBatch', () => {
    it('inserts fresh events and counts them as accepted', () => {
      const result = repo.insertBatch([makeEvent(), makeEvent(), makeEvent()], 5_000);
      expect(result).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
      expect(repo.count()).toBe(3);
    });

    it('counts a repeated id within one batch as a duplicate, inserting it once', () => {
      const same = makeEvent();
      const result = repo.insertBatch([same, { ...same }, makeEvent()], 5_000);
      expect(result).toMatchObject({ accepted: 2, duplicates: 1, rejected: 0 });
      expect(repo.count()).toBe(2);
    });

    it('counts a cross-batch redelivery of the same ids as duplicates', () => {
      const batch = [makeEvent(), makeEvent()];
      repo.insertBatch(batch, 5_000);
      const redelivery = repo.insertBatch([...batch].reverse(), 6_000);
      expect(redelivery).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
      expect(repo.count()).toBe(2);
    });

    it('returns zeros for an empty batch without touching the db', () => {
      expect(repo.insertBatch([], 5_000)).toMatchObject({ accepted: 0, duplicates: 0, rejected: 0 });
    });
  });

  describe('double enforcement inside the repository', () => {
    it('rejects a redacted_secure_field event that still carries content', () => {
      const result = repo.insertBatch(
        [makeEvent({ contentPolicy: 'redacted_secure_field', target: { subrole: 'AXSecureTextField' }, content: 'hunter2' })],
        5_000,
      );
      expect(result.rejected).toBe(1);
      expect(result.reasons).toEqual({ secure_field_with_content: 1 });
      expect(repo.count()).toBe(0);
    });

    it('rejects an unknown contentPolicy as schema_invalid (invariant d)', () => {
      const result = repo.insertBatch([makeEvent({ contentPolicy: 'bogus' as never })], 5_000);
      expect(result.rejected).toBe(1);
      expect(result.reasons).toEqual({ schema_invalid: 1 });
      expect(repo.count()).toBe(0);
    });

    it('rejects typing_activity carrying content (invariant b)', () => {
      const result = repo.insertBatch(
        [makeEvent({ source: 'input', action: 'typing_activity', content: 'secret' })],
        5_000,
      );
      expect(result.rejected).toBe(1);
      expect(result.reasons).toEqual({ typing_activity_with_content: 1 });
      expect(repo.count()).toBe(0);
    });

    it('rejects content beyond the 2048-char bound even when called directly', () => {
      const result = repo.insertBatch(
        [makeEvent({ content: 'x'.repeat(CONSTANTS.maxContentChars + 1) })],
        5_000,
      );
      expect(result.rejected).toBe(1);
      expect(result.reasons).toEqual({ content_oversize: 1 });
    });

    it('keeps accepted siblings in a batch that also contains rejected events', () => {
      const result = repo.insertBatch(
        [
          makeEvent(),
          makeEvent({ contentPolicy: 'bogus' as never }),
          makeEvent({ source: 'input', action: 'typing_activity', content: 'nope' }),
          makeEvent(),
        ],
        5_000,
      );
      expect(result).toMatchObject({ accepted: 2, duplicates: 0, rejected: 2 });
      expect(repo.count()).toBe(2);
    });
  });

  describe('markProcessed / fetchUnprocessed', () => {
    it('marks rows and stops returning them as unprocessed', () => {
      const events = [makeEvent(), makeEvent()];
      repo.insertBatch(events, 5_000);
      expect(repo.markProcessed([events[0]!.id], 9_000)).toBe(1);
      const remaining = repo.fetchUnprocessed(2_000_000, 100);
      expect(remaining.map((e) => e.id)).toEqual([events[1]!.id]);
      // marking again is a no-op
      expect(repo.markProcessed([events[0]!.id], 10_000)).toBe(0);
    });

    it('orders by observed_at_ms ASC regardless of insertion order', () => {
      const late = makeEvent({ id: ulid(), observedAt: 1_000_003, monotonicNs: 10 });
      const early = makeEvent({ id: ulid(), observedAt: 1_000_001, monotonicNs: 10 });
      const middle = makeEvent({ id: ulid(), observedAt: 1_000_002, monotonicNs: 99 });
      // deliberately out-of-order arrival
      repo.insertBatch([late, middle, early], 5_000);
      expect(repo.fetchUnprocessed(2_000_000, 100).map((e) => e.observedAt)).toEqual([
        early.observedAt,
        middle.observedAt,
        late.observedAt,
      ]);
    });

    it('breaks observed_at ties with monotonic_ns ASC, then id ASC', () => {
      const tieA = makeEvent({ id: ulid(), observedAt: 1_000_000, monotonicNs: 7 });
      const tieB = makeEvent({ id: ulid(), observedAt: 1_000_000, monotonicNs: 7 });
      const monoFirst = makeEvent({ id: ulid(), observedAt: 1_000_000, monotonicNs: 2 });
      const noMono = makeEvent({ id: ulid(), observedAt: 1_000_000, monotonicNs: undefined });
      // shuffled insertion order
      repo.insertBatch([tieB, noMono, tieA, monoFirst], 5_000);
      const ordered = repo.fetchUnprocessed(2_000_000, 100);
      expect(ordered.map((e) => e.id)).toEqual([
        noMono.id, // NULL monotonic sorts first (ASC)
        monoFirst.id,
        [tieA.id, tieB.id].sort()[0],
        [tieA.id, tieB.id].sort()[1],
      ]);
    });

    it('honors the watermark cutoff and limit', () => {
      const old1 = makeEvent({ observedAt: 999 });
      const old2 = makeEvent({ observedAt: 1_001 });
      const fresh = makeEvent({ observedAt: 5_000 });
      repo.insertBatch([old1, old2, fresh], 5_000);
      const eligible = repo.fetchUnprocessed(4_000, 1);
      expect(eligible.map((e) => e.id)).toEqual([old1.id]);
    });

    it('chunks markProcessed past the 500-id SQLite parameter limit', () => {
      // 1201 ids force three chunks (500 + 500 + 201) in one call.
      const events = Array.from({ length: 1201 }, () => makeEvent({ id: ulid() }));
      repo.insertBatch(events, 5_000);
      const allIds = events.map((e) => e.id);
      expect(repo.markProcessed(allIds, 9_000)).toBe(1201);
      expect(repo.fetchUnprocessed(2_000_000, events.length)).toEqual([]);
      // re-marking everything is a no-op
      expect(repo.markProcessed(allIds, 10_000)).toBe(0);
    });
  });

  describe('purgeOlderThan', () => {
    it('deletes only processed events older than the cutoff and returns the count', () => {
      const ancient = makeEvent({ observedAt: 100 });
      const recent = makeEvent({ observedAt: 10_000 });
      repo.insertBatch([ancient, recent], 5_000);
      // Round-27: retention never purges the segmenter's pending queue —
      // only processed rows age out, so the ancient row must be marked
      // processed before the purge can collect it.
      expect(repo.markProcessed([ancient.id], 6_000)).toBe(1);
      expect(repo.purgeOlderThan(1_000)).toBe(1);
      expect(repo.count()).toBe(1);
      expect(repo.fetchUnprocessed(2_000_000, 10)[0]!.id).toBe(recent.id);
    });
  });

  describe('row ↔ wire round trip', () => {
    it('preserves optional fields and stores absent optionals as NULL', () => {
      const rich = makeEvent();
      repo.insertBatch([rich], 5_000);
      const back = repo.fetchUnprocessed(2_000_000, 10)[0];
      // absent content round-trips as the canonical explicit null
      expect(back).toEqual({ ...rich, content: null });

      const sparse = makeEvent({
        monotonicNs: undefined,
        window: undefined,
        target: undefined,
        content: undefined,
        app: { bundleId: 'com.apple.finder' },
      });
      repo.insertBatch([sparse], 5_000);
      const sparseBack = repo.fetchUnprocessed(2_000_000, 10).find((e) => e.id === sparse.id);
      // absent content round-trips as the canonical explicit null
      expect(sparseBack).toEqual({ ...sparse, content: null });
    });
  });
});

describe('privacyRejection (pure invariant classifier)', () => {
  it('treats absent/null content as acceptable even for secure fields and typing', () => {
    expect(
      privacyRejection(
        makeEvent({
          contentPolicy: 'redacted_secure_field',
          target: { subrole: 'AXSecureTextField' },
          content: null,
        }),
      ),
    ).toBeNull();
    expect(privacyRejection(makeEvent({ source: 'input', action: 'typing_activity' }))).toBeNull();
  });

  it('flags AXSecureTextField targets with content even under policy allow', () => {
    expect(
      privacyRejection(
        makeEvent({ contentPolicy: 'allow', target: { subrole: 'AXSecureTextField' }, content: 'hunter2' }),
      ),
    ).toBe('secure_field_with_content');
  });

  it('rejects excluded_app tombstones carrying window or target metadata', () => {
    expect(
      privacyRejection(
        makeEvent({
          contentPolicy: 'excluded_app',
          window: { title: 'Secret App — Doc' },
          target: undefined,
          content: null,
        }),
      ),
    ).toBe('tombstone_with_metadata');
    expect(
      privacyRejection(
        makeEvent({
          contentPolicy: 'excluded_app',
          window: undefined,
          target: { role: 'AXButton', identifier: 'quit' },
          content: null,
        }),
      ),
    ).toBe('tombstone_with_metadata');
  });

  it('accepts a fact-only excluded_app tombstone', () => {
    expect(
      privacyRejection(
        makeEvent({ contentPolicy: 'excluded_app', window: undefined, target: undefined, content: null }),
      ),
    ).toBeNull();
  });
});
