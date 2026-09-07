import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { escapeMatchQuery, EpisodesRepository } from '../src/db/episodes-repository.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { SegmentsRepository } from '../src/db/segments-repository.js';
import type { CoalescedStep } from '../src/processing/event-coalescer.js';

describe('EpisodesRepository (spec §3.9/§3.10, brief-m3 §D3 item 1)', () => {
  let db: Db;
  let episodes: EpisodesRepository;
  let segments: SegmentsRepository;
  let home: string;
  const NOW = 1_000_000;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-episodes-'));
    db = openDatabase(path.join(home, 'history.db'));
    db.pragma('journal_mode = MEMORY');
    migrate(db);
    episodes = new EpisodesRepository(db);
    segments = new SegmentsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function appendSteps(segmentId: string, count: number, appName = 'Safari'): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const step: CoalescedStep = {
        action: 'type',
        appBundleId: 'com.apple.Safari',
        appName,
        target: `textarea#${i}`,
        text: `step ${i} body`,
        startedAtMs: NOW + i * 1000,
        endedAtMs: NOW + i * 1000 + 500,
        firstEventId: `e${i}a`,
        lastEventId: `e${i}b`,
        eventCount: 1,
        targetRole: null,
      };
      ids.push(segments.appendStep(segmentId, step, { text: step.text, target: step.target, appName }));
    }
    return ids;
  }

  it('persists episodes + links + FTS rows in one transaction and serves getEpisode ordered', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 4);
    const [id] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 3500,
          title: 'Wrote release notes',
          summary: 'Edited the changelog.',
          intent: 'creation',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: ['changelog'],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );

    const found = episodes.getEpisode(id!);
    expect(found).not.toBeNull();
    expect(found!.episode.title).toBe('Wrote release notes');
    expect(found!.episode.summaryPromptVersion).toBe('v1');
    expect(found!.steps.map((s) => s.id)).toEqual(stepIds); // link order preserved

    // Every linked step belongs to exactly one episode of this segment.
    const links = db
      .prepare('SELECT semantic_step_id FROM episode_step_links WHERE episode_id = ? ORDER BY ordinal')
      .all(id) as Array<{ semantic_step_id: string }>;
    expect(links.map((l) => l.semantic_step_id)).toEqual(stepIds);
  });

  it('lists episodes newest first with denormalized appNames and stepCount', () => {
    const older = segments.createOpen(NOW, 'ea', NOW);
    segments.finalize(older.id, 'finalized', NOW + 1500, {});
    const newer = segments.createOpen(NOW + 100_000, 'eb', NOW);
    const olderSteps = appendSteps(older.id, 2, 'Safari');
    appendSteps(newer.id, 3, 'Terminal');
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1500,
          title: 'older',
          summary: '',
          intent: null,
          outcome: null,
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: null,
          steps: olderSteps.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    // Newer episode reuses the helper's steps implicitly via its own links.
    const newerSteps = db
      .prepare('SELECT id FROM semantic_steps WHERE segment_id = ? ORDER BY ordinal')
      .all(newer.id) as Array<{ id: string }>;
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW + 100_000,
          endedAtMs: NOW + 102_500,
          title: 'newer',
          summary: '',
          intent: null,
          outcome: null,
          apps: ['Terminal'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: null,
          steps: newerSteps.map((r) => ({ id: r.id })),
        },
      ],
      NOW,
    );

    const list = episodes.listEpisodes({}, 10);
    expect(list.map((e) => e.title)).toEqual(['newer', 'older']);
    expect(list[0]!.appNames).toEqual(['Terminal']);
    expect(list[0]!.stepCount).toBe(3);
    expect(list[1]!.stepCount).toBe(2);

    const windowed = episodes.listEpisodes({ from: NOW + 50_000 }, 10);
    expect(windowed.map((e) => e.title)).toEqual(['newer']);
  });

  it('keeps app names containing commas intact (JS-side distinct aggregation)', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 3, 'Acme, Inc.');
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 2500,
          title: 'comma app episode',
          summary: '',
          intent: null,
          outcome: null,
          apps: ['Acme, Inc.'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: null,
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );

    const listed = episodes.listEpisodes({}, 10);
    expect(listed).toHaveLength(1);
    // Three steps share the comma-bearing name → exactly ONE distinct entry,
    // never split on the comma.
    expect(listed[0]!.appNames).toEqual(['Acme, Inc.']);
    expect(listed[0]!.stepCount).toBe(3);

    const hits = episodes.searchEpisodes(escapeMatchQuery('comma'), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.appNames).toEqual(['Acme, Inc.']);
    expect(hits[0]!.stepCount).toBe(3);
  });

  it('searches FTS titles/summaries with BM25 ranking after escapeMatchQuery sanitization', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 1);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW,
          title: 'Investigated webhook failures',
          summary: 'Traced stripe webhook deliveries',
          intent: 'research',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: ['stripe'],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );

    expect(escapeMatchQuery('"webhook" failures\u0007')).toBe('webhook failures');
    const hits = episodes.searchEpisodes(escapeMatchQuery('webhook'), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toContain('webhook');
    expect(episodes.searchEpisodes(escapeMatchQuery('stripe deliveries'), 10)).toHaveLength(1);
    // AND semantics: both tokens must match.
    expect(episodes.searchEpisodes(escapeMatchQuery('stripe unrelatedtoken'), 10)).toHaveLength(0);
    expect(episodes.searchEpisodes('', 10)).toHaveLength(0);
  });
  it('rowToEpisode survives corrupt apps_json/entities_json (try/catch degrade)', () => {
    // Mirrors the workflow template_json drill: the repository always writes a
    // JSON array, so hostile payloads are injected with raw SQL — exactly what
    // a legacy/corrupt row looks like at read time. The unparseable payload
    // must degrade to [] instead of a SyntaxError killing getEpisode/list/search.
    const segment = segments.createOpen(NOW, 'ec', NOW);
    const stepIds = appendSteps(segment.id, 1);
    const [id] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1000,
          title: 'corrupt json episode',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: ['changelog'],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    db.prepare('UPDATE episodes SET apps_json = ?, entities_json = ? WHERE id = ?').run(
      'not json{',
      '{broken',
      id,
    );

    const found = episodes.getEpisode(id!)!;
    expect(found.episode.apps).toEqual([]); // catch branch degrades to []
    expect(found.episode.entities).toEqual([]);
    // List path must not throw on the corrupt row either.
    expect(episodes.listEpisodes({}, 10).some((e) => e.id === id)).toBe(true);
    // Search path must not throw on the corrupt row either (FTS mirror still
    // holds the original title/summary text).
    expect(episodes.searchEpisodes(escapeMatchQuery('corrupt'), 10).some((e) => e.id === id)).toBe(
      true,
    );

    // Valid-JSON wrong shapes must degrade identically — a bare scalar or
    // object parses cleanly but is not a string array.
    db.prepare('UPDATE episodes SET apps_json = ?, entities_json = ? WHERE id = ?').run(
      '5',
      '{"a":1}',
      id,
    );
    const wrongShape = episodes.getEpisode(id!)!;
    expect(wrongShape.episode.apps).toEqual([]);
    expect(wrongShape.episode.entities).toEqual([]);
    expect(episodes.listEpisodes({}, 10).some((e) => e.id === id)).toBe(true);
    expect(episodes.searchEpisodes(escapeMatchQuery('corrupt'), 10).some((e) => e.id === id)).toBe(
      true,
    );
  });

  /** Steps as the latch consumes them (id + segment + window bounds). */
  function stepWindow(segmentId: string) {
    return segments.getSteps(segmentId);
  }

  it('stamps segment_id on new episode rows (migration 012)', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 2);
    const [id] = episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1500,
          title: 'stamped',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          segmentId: segment.id,
          lastStepOrdinal: 2,
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    const row = db.prepare('SELECT segment_id FROM episodes WHERE id = ?').get(id) as {
      segment_id: string | null;
    };
    expect(row.segment_id).toBe(segment.id);
  });

  it('latches via segment_id even after episode_step_links are purged', () => {
    // Round-31 fix pin: crash between persistTx and job-complete whose
    // re-delivery outlives the 30d link horizon must NOT re-summarize.
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 3);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 2500,
          title: 'purge-proof',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          segmentId: segment.id,
          lastStepOrdinal: 3,
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );

    // Simulate purgeStepsOlderThan: links deleted out from under the episode.
    db.prepare('DELETE FROM episode_step_links').run();
    expect(episodes.hasEpisodesForSteps(stepWindow(segment.id))).toBe(true);
  });

  it('regressed-timestamp chained window does NOT latch — ordinals decide (round-32)', () => {
    // Audit MEDIUM pin: the old interval-intersection probe matched any
    // episode of the segment touching the window's timestamp range, so with
    // clock-skewed event timestamps a never-summarized chained window was
    // skipped forever (persistTx never ran → permanent tail loss).
    // Append-order ordinals are monotonic per segment and cannot regress.
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 4);
    // Window 0 covered the first two appended steps (ordinals 1..2); its
    // stored episode carries a skewed end timestamp reaching past the whole
    // segment — exactly what regressed event timestamps produce.
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 10_000_000,
          title: 'w0',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          segmentId: segment.id,
          lastStepOrdinal: 2,
          steps: stepIds.slice(0, 2).map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    const steps = segments.getSteps(segment.id);
    // Same-window redelivery (steps 1..2 by ordinal): still skips.
    expect(episodes.hasEpisodesForSteps(steps.slice(0, 2))).toBe(true);
    // Chained next window (steps 3..4 by ordinal) proceeds even though BOTH
    // its step timestamps sit inside the stored episode's interval.
    expect(episodes.hasEpisodesForSteps(steps.slice(2))).toBe(false);
  });

  it('migration 013 backfills segment_id + last_step_ordinal onto legacy rows from links', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 3);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 2500,
          title: 'pre-013',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    // Roll the schema back to its post-012 shape and replay the migrator:
    // the 013 UPDATE must recover BOTH latch columns from episode_step_links.
    db.exec('DROP INDEX IF EXISTS idx_episodes_segment_last_ordinal');
    db.exec('ALTER TABLE episodes DROP COLUMN last_step_ordinal');
    db.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
    migrate(db);
    const row = db
      .prepare('SELECT segment_id, last_step_ordinal FROM episodes')
      .get() as { segment_id: string | null; last_step_ordinal: number | null };
    expect(row.segment_id).toBe(segment.id);
    expect(row.last_step_ordinal).toBe(3); // MAX(ordinal) over linked steps
  });

  it('legacy stamped row (segment_id set, last_step_ordinal NULL) latches via interval probe', () => {
    // Round-33 regression pin: migration-012-era runtime code already
    // stamped segment_id, then retention purged episode_step_links so 013's
    // backfill left last_step_ordinal NULL. The ordinal probe can never
    // match NULL and the link fallback finds nothing — only the frozen
    // interval probe keeps these rows from re-summarizing.
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 5);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 2500,
          title: 'stamped-no-ordinal',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          segmentId: segment.id,
          lastStepOrdinal: 3,
          steps: stepIds.slice(0, 3).map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    const row = db.prepare("SELECT id FROM episodes WHERE title = 'stamped-no-ordinal'").get() as {
      id: string;
    };
    // Freeze into the legacy class: no ordinal stamp, links purged.
    db.prepare('UPDATE episodes SET last_step_ordinal = NULL WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM episode_step_links').run();

    const steps = segments.getSteps(segment.id);
    // Overlapping window → interval probe latches despite NULL ordinal.
    expect(episodes.hasEpisodesForSteps(steps.slice(0, 3))).toBe(true);
    // Chained non-overlapping window (steps 4..5 start after the stored
    // episode's end) must still proceed — the IS NULL guard does NOT
    // resurrect the clock-skew hazard for windows beyond the bounds.
    expect(episodes.hasEpisodesForSteps(steps.slice(3))).toBe(false);
  });

  it('legacy rows (segment_id NULL) still latch through their links only', () => {
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 2);
    // No segmentId — a pre-migration-012 row shape.
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1500,
          title: 'legacy',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          steps: stepIds.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );
    const row = db
      .prepare("SELECT id FROM episodes WHERE segment_id IS NULL AND title = 'legacy'")
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();

    // Links present → the legacy fallback latches; links gone → nothing does
    // (proves the hit came from the link check, not the segment probe).
    expect(episodes.hasEpisodesForSteps(stepWindow(segment.id))).toBe(true);
    db.prepare('DELETE FROM episode_step_links').run();
    expect(episodes.hasEpisodesForSteps(stepWindow(segment.id))).toBe(false);
  });

  it('does not latch an unrelated segment window', () => {
    const segmentA = segments.createOpen(NOW, 'ea', NOW);
    const idsA = appendSteps(segmentA.id, 2);
    // Only one OPEN segment may exist at a time (migration 002), so close A
    // before opening B.
    segments.finalize(segmentA.id, 'finalized', NOW + 2000, {});
    const segmentB = segments.createOpen(NOW, 'eb', NOW);
    appendSteps(segmentB.id, 2);
    episodes.insertEpisodesWithLinks(
      [
        {
          startedAtMs: NOW,
          endedAtMs: NOW + 1500,
          title: 'segment A only',
          summary: 'seeded',
          intent: 'unknown',
          outcome: 'unknown',
          apps: ['Safari'],
          entities: [],
          summaryModel: null,
          summaryPromptVersion: 'v1',
          segmentId: segmentA.id,
          lastStepOrdinal: 2,
          steps: idsA.map((sid) => ({ id: sid })),
        },
      ],
      NOW,
    );

    expect(episodes.hasEpisodesForSteps(stepWindow(segmentB.id))).toBe(false);
  });

  it('throws when segmentId is provided without lastStepOrdinal (stamped ⇒ ordinal)', () => {
    // Round-34 hardening pin: the post-013 stamp invariant was by-convention
    // only; a caller passing segmentId without lastStepOrdinal would silently
    // land its rows in the clock-skew-prone legacy interval-probe tier.
    const segment = segments.createOpen(NOW, 'e0', NOW);
    const stepIds = appendSteps(segment.id, 2);
    expect(() =>
      episodes.insertEpisodesWithLinks(
        [
          {
            startedAtMs: NOW,
            endedAtMs: NOW + 1500,
            title: 'stamped-no-ordinal',
            summary: 'seeded',
            intent: 'unknown',
            outcome: 'unknown',
            apps: ['Safari'],
            entities: [],
            summaryModel: null,
            summaryPromptVersion: 'v1',
            segmentId: segment.id,
            steps: stepIds.map((sid) => ({ id: sid })),
          },
        ],
        NOW,
      ),
    ).toThrowError(/segmentId requires lastStepOrdinal/);
    // The guard fires before any write: nothing persisted.
    const count = db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
