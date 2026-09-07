import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityEvent, SemanticStepDto } from '@computer-history/protocol';

import { openDatabase, type Db } from '../src/db/database.js';
import { EventsRepository } from '../src/db/events-repository.js';
import { migrate } from '../src/db/migrator.js';
import { EventIngestor } from '../src/ingest/event-ingestor.js';
import type { Logger } from '../src/logging.js';
import { validateMemoryCandidates } from '../src/processing/memory-extractor.js';
import { validateTemplate, type WorkflowTemplateLlm } from '../src/processing/workflow-miner.js';
import { toNewEpisode } from '../src/processing/episode-summarizer.js';
import {
  WorkflowsRepository,
  type NewWorkflowInput,
} from '../src/db/workflows-repository.js';
import { registerChatOps } from '../src/ipc/chat-ops.js';
import type { ChatSessionManager } from '../src/agent/agent-session.js';
import type { Router } from '../src/ipc/router.js';
import { replaceWellFormedTarget } from '../src/util/text.js';

/**
 * Issue W2: lone UTF-16 surrogates pass Node-side JSON parsing + TypeBox and
 * round-trip through SQLite, but Swift's JSONDecoder rejects the WHOLE frame
 * at parse time (NSCocoaErrorDomain 3840) — one poisoned string silently
 * drops chat deltas / history payloads on Apple clients. These tests pin the
 * boundary sanitization at all four daemon text entry/emission points.
 */

/** Pair-aware scan: true iff every surrogate is half of a well-formed pair. */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * TextEncoder replaces unpaired surrogates with U+FFFD when encoding — so a
 * strict encode→decode round-trip only reproduces its input exactly when the
 * input was well-formed. Independent second witness besides the code-unit scan.
 */
function survivesTextEncoderRoundTrip(s: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(s)) === s;
}

describe('replaceWellFormedTarget', () => {
  it('leaves paired astral emoji untouched', () => {
    expect(replaceWellFormedTarget('\u{1F600} rocket \u{1F680}')).toBe('\u{1F600} rocket \u{1F680}');
    expect(isWellFormedUtf16('\ud83d\ude00')).toBe(true);
  });

  it('replaces a lone high surrogate', () => {
    expect(replaceWellFormedTarget('text \ud800 here')).toBe('text \uFFFD here');
  });

  it('replaces a lone low surrogate', () => {
    expect(replaceWellFormedTarget('text \ude00 here')).toBe('text \uFFFD here');
  });

  it('replaces adjacent unpaired surrogates without pairing them', () => {
    // Two consecutive HIGH units are NOT a pair; both become U+FFFD.
    expect(replaceWellFormedTarget('\ud800\ud800')).toBe('\uFFFD\uFFFD');
    expect(replaceWellFormedTarget('\ude00\ud800')).toBe('\uFFFD\uFFFD');
  });

  it('sanitizes mixed content while keeping valid pairs intact', () => {
    const mixed = 'a\ud800b\ud83d\ude00c\ude00d\ud83d\ude00e\ud83d';
    expect(replaceWellFormedTarget(mixed)).toBe('a\uFFFDb\ud83d\ude00c\uFFFDd\ud83d\ude00e\uFFFD');
  });

  it('trailing high surrogate at end-of-string becomes U+FFFD', () => {
    expect(replaceWellFormedTarget('end\ud83d')).toBe('end\uFFFD');
  });

  it('returns clean strings unchanged', () => {
    expect(replaceWellFormedTarget('plain ascii + déjà vu + 中文')).toBe('plain ascii + déjà vu + 中文');
  });
});

interface Harness {
  ingestor: EventIngestor;
  repo: EventsRepository;
  db: Db;
  cleanup(): void;
}

/** Real repository on a temp db (same shape as event-ingestor.test.ts). */
function makeHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), 'ch-text-sanitize-'));
  const db = openDatabase(path.join(home, 'history.db'));
  migrate(db);
  const logger: Logger = { log() {}, pruneOld: () => 0 };
  const ingestor = new EventIngestor({
    repository: new EventsRepository(db),
    logger,
  });
  return {
    ingestor,
    repo: new EventsRepository(db),
    db,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('ingest sanitization (issue W2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
      id: ulid(),
      observedAt: 1_000_000,
      monotonicNs: 500,
      source: 'workspace',
      app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
      action: 'app_focus',
      contentPolicy: 'allow',
      ...overrides,
    };
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

  it('an event with lone-surrogate text persists well-formed and re-reads clean through the wire schema', () => {
    const poisoned = makeEvent({
      window: { title: 'Doc \ud800 title' },
      target: { role: 'AXTextArea', label: 'note \ude00 body' },
      content: 'captured \ud83d\ude00 text with a stray \ud800 inside',
    });
    const outcome = h.ingestor.ingest(makeBatch([poisoned]));
    expect(outcome.accepted).toBe(1);

    // Read back through the repository's wire mapping (what history/timeline
    // frames serialize): every text field must be well-formed UTF-16.
    const events = h.repo.fetchUnprocessed(Number.MAX_SAFE_INTEGER, 10);
    expect(events).toHaveLength(1);
    const stored = events[0]!;
    expect(stored.id).toBe(poisoned.id);
    for (const value of [
      stored.app.bundleId,
      stored.app.name ?? '',
      stored.window?.title ?? '',
      stored.target?.role ?? '',
      stored.target?.label ?? '',
      stored.content ?? '',
    ]) {
      expect(isWellFormedUtf16(value)).toBe(true);
      expect(survivesTextEncoderRoundTrip(value)).toBe(true);
    }
    expect(stored.window?.title).toContain('\uFFFD');
    expect(stored.content).toBe('captured \ud83d\ude00 text with a stray \uFFFD inside');

    // The serialized frame, re-parsed, must survive the TextEncoder check too:
    // this is what Swift's JSONDecoder consumes (it rejects \udXXX escapes of
    // unpaired surrogates outright).
    const wire = JSON.parse(JSON.stringify({ type: 'history_events', events })) as { events: ActivityEvent[] };
    for (const event of wire.events) {
      expect(survivesTextEncoderRoundTrip(JSON.stringify(event))).toBe(true);
    }
  });

  it('clean events are persisted byte-for-byte — sanitization changes nothing', () => {
    const clean = makeEvent({
      window: { title: 'Emoji 🎉 title' },
      content: 'naïve 中文 \u{1F600} ok',
    });
    const outcome = h.ingestor.ingest(makeBatch([clean]));
    expect(outcome.accepted).toBe(1);
    const [stored] = h.repo.fetchUnprocessed(Number.MAX_SAFE_INTEGER, 10);
    expect(stored?.window?.title).toBe('Emoji 🎉 title');
    expect(stored?.content).toBe('naïve 中文 \u{1F600} ok');
  });
});

describe('LLM output sanitization (issue W2)', () => {
  const steps: SemanticStepDto[] = [
    {
      id: ulid(),
      segmentId: ulid(),
      ordinal: 0,
      startedAtMs: 1000,
      endedAtMs: 2000,
      action: 'edit_text',
      appBundleId: 'com.apple.TextEdit',
      appName: 'TextEdit',
    },
  ];

  it('toNewEpisode sanitizes poisoned LLM title/summary/entities', () => {
    const episode = toNewEpisode(
      {
        firstStepOrdinal: 0,
        lastStepOrdinal: 0,
        title: 'Summary \ud800 gone',
        summary: 'Body \ude00 text',
        intent: 'unknown',
        outcome: 'unknown',
        entities: ['ok', 'bad \ud83d key'],
      },
      steps,
      'test-model',
    );
    expect(isWellFormedUtf16(JSON.stringify(episode))).toBe(true);
    expect(episode.title).toBe('Summary \uFFFD gone');
    expect(episode.summary).toBe('Body \uFFFD text');
    expect(episode.entities[1]).toBe('bad \uFFFD key');
  });

  it('validateMemoryCandidates sanitizes claim text and evidence', () => {
    const { candidates } = validateMemoryCandidates({
      candidates: [
        {
          kind: 'preference',
          canonicalKey: 'editor_preference',
          text: 'User prefers \ud800 dark mode.',
          confidence: 0.9,
          evidenceDescription: 'Saw \ude00 settings toggle',
        },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('User prefers \uFFFD dark mode.');
    expect(candidates[0]?.evidenceDescription).toBe('Saw \uFFFD settings toggle');
  });
});

// ---------------------------------------------------------------------------
// RA-1: workflow template surface (miner validation + template_json column)
// ---------------------------------------------------------------------------

describe('workflow template sanitization (issue W2)', () => {
  let h: Harness;
  let workflows: WorkflowsRepository;
  const NOW = 1_700_000_000_000;
  const EP_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
  const EP_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';

  beforeEach(() => {
    h = makeHarness();
    workflows = new WorkflowsRepository(h.db);
    // Occurrences reference episodes (FK) — same seeding shape as
    // workflows-repository.test.ts.
    for (const [index, id] of [EP_A, EP_B].entries()) {
      h.db
        .prepare(
          `INSERT INTO episodes (
             id, started_at_ms, ended_at_ms, title, summary, intent, outcome,
             apps_json, entities_json, summary_model, summary_prompt_version,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 't', 's', NULL, NULL, '[]', '[]', 'm', 'v1', ?, ?)`,
        )
        .run(id, 1_000 + index, 1_001 + index, NOW, NOW);
    }
  });
  afterEach(() => {
    h.cleanup();
  });

  function poisonedTemplate(): WorkflowTemplateLlm {
    return {
      name: 'Deploy \ud800 checklist',
      purpose: 'Ship \ude00 safely',
      preconditions: ['CI \ud800 green'],
      stableSteps: ['build \ud800 app', 'deploy \ud83d\ude00 bundle'],
      variableInputs: ['ticket \ude00 id'],
      expectedOutcome: 'Release \ud83d shipped',
    };
  }

  function candidateInput(template: WorkflowTemplateLlm): NewWorkflowInput {
    return {
      name: template.name,
      purpose: null,
      template,
      occurrences: [
        { episodeId: EP_A, similarity: 0.8 },
        { episodeId: EP_B, similarity: 0.9 },
      ],
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 2_000,
    };
  }

  it('validateTemplate sanitizes every LLM field; valid astral pairs survive byte-for-byte', () => {
    const { name, purpose, template } = validateTemplate(poisonedTemplate());
    expect(name).toBe('Deploy \uFFFD checklist');
    expect(purpose).toBe('Ship \uFFFD safely');
    expect(template.preconditions).toEqual(['CI \uFFFD green']);
    // Each unpaired unit becomes U+FFFD; the well-formed emoji pair is kept.
    expect(template.stableSteps).toEqual(['build \uFFFD app', 'deploy \ud83d\ude00 bundle']);
    expect(template.variableInputs).toEqual(['ticket \uFFFD id']);
    expect(template.expectedOutcome).toBe('Release \uFFFD shipped');
  });

  it('clean templates pass through by reference — no behavior change', () => {
    const raw: WorkflowTemplateLlm = {
      name: 'Routine',
      purpose: 'Keep the loop running',
      preconditions: ['tooling installed'],
      stableSteps: ['run checks'],
      variableInputs: ['branch name'],
      expectedOutcome: 'green build',
    };
    const out = validateTemplate(raw);
    expect(out.name).toBe(raw.name);
    expect(out.purpose).toBe(raw.purpose);
    expect(out.template.stableSteps[0]).toBe(raw.stableSteps[0]);
    expect(out.template.expectedOutcome).toBe(raw.expectedOutcome);
  });

  it('insertWorkflow + listByStatus emit a wire DTO with NO unpaired-surrogate escape', () => {
    workflows.insertWorkflow(candidateInput(poisonedTemplate()), NOW);
    const [row] = workflows.listByStatus({ status: 'candidate' });
    expect(row).toBeDefined();
    const wire = JSON.stringify(row);
    // Both witnesses on exactly what Swift's JSONDecoder consumes.
    expect(isWellFormedUtf16(wire)).toBe(true);
    expect(survivesTextEncoderRoundTrip(wire)).toBe(true);
    const steps = (row!.template as WorkflowTemplateLlm).stableSteps;
    // Control: the valid astral emoji survives byte-for-byte through SQLite.
    expect(steps).toContain('deploy \ud83d\ude00 bundle');
    // The lone surrogate became U+FFFD instead of a \udXXX escape.
    expect(steps.some((s) => s.includes('\uFFFD'))).toBe(true);
    expect(JSON.stringify(steps)).not.toContain('\\ud800');
    expect(JSON.stringify(steps)).not.toContain('\\ude00');
  });
});


// ---------------------------------------------------------------------------
// RA8-W2-READ: legacy rows persisted BEFORE the round-7 write-path fix store
// literal \uDXXX escape sequences in template_json; toDto must remediate them
// at read time or Swift's JSONDecoder rejects the whole list/search frame.
// ---------------------------------------------------------------------------

describe('legacy workflow row read-side remediation (issue RA8-W2-READ)', () => {
  let h: Harness;
  let workflows: WorkflowsRepository;
  const NOW = 1_700_000_000_000;
  const LEGACY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';

  beforeEach(() => {
    h = makeHarness();
    workflows = new WorkflowsRepository(h.db);
  });
  afterEach(() => {
    h.cleanup();
  });

  /** Pre-fix write path: JSON.stringify of lone-surrogate strings persists
   * literal ASCII \uDXXX escape sequences into the TEXT columns via raw SQL,
   * bypassing the sanitized repository writer entirely. */
  function seedLegacyRow(): void {
    const legacyTemplate = {
      name: 'Deploy \ud800 checklist',
      purpose: 'Ship \ude00 safely',
      preconditions: ['CI \ud800 green'],
      stableSteps: ['build \ud800 app', 'deploy \ud83d\ude00 bundle'],
      variableInputs: ['ticket \ude00 id'],
      expectedOutcome: 'Release \ud83d shipped',
    };
    const json = JSON.stringify(legacyTemplate);
    // Control: the column really holds the literal backslash-u escape.
    expect(json).toContain('\\ud800');
    h.db
      .prepare(
        `INSERT INTO workflows (
           id, name, purpose, status, template_json, occurrence_count,
           median_similarity, first_seen_at_ms, last_seen_at_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        LEGACY_ID,
        'Legacy \ud800 name',
        'Purpose \ude00 here',
        json,
        1,
        0.9,
        NOW,
        NOW,
        NOW,
        NOW,
      );
  }

  it('getById/listByStatus return DTOs whose strings are lone-surrogate-free', () => {
    seedLegacyRow();

    const dto = workflows.getById(LEGACY_ID)!;
    expect(dto).not.toBeNull();
    expect(isWellFormedUtf16(dto.name)).toBe(true);
    expect(dto.name).toBe('Legacy \uFFFD name');
    expect(isWellFormedUtf16(dto.purpose!)).toBe(true);
    expect(dto.purpose).toBe('Purpose \uFFFD here');

    const t = dto.template;
    if (t.name !== undefined) expect(isWellFormedUtf16(t.name)).toBe(true);
    if (t.purpose !== undefined) expect(isWellFormedUtf16(t.purpose)).toBe(true);
    if (t.expectedOutcome !== undefined) expect(isWellFormedUtf16(t.expectedOutcome)).toBe(true);
    for (const field of [t.preconditions, t.stableSteps, t.variableInputs]) {
      for (const s of field ?? []) expect(isWellFormedUtf16(s)).toBe(true);
    }
    expect(t.stableSteps).toContain('deploy \ud83d\ude00 bundle'); // pair intact
    expect(t.stableSteps).toContain('build \uFFFD app');
    expect(t.expectedOutcome).toBe('Release \uFFFD shipped');

    // Same guarantees through the list path, on exactly what Swift decodes.
    const [item] = workflows.listByStatus();
    expect(item!.id).toBe(LEGACY_ID);
    const wire = JSON.stringify(item);
    expect(isWellFormedUtf16(wire)).toBe(true);
    expect(survivesTextEncoderRoundTrip(wire)).toBe(true);
    expect(wire).not.toContain('\\ud800');
    expect(wire).not.toContain('\\ude00');

    // And through search.
    const found = workflows.searchWorkflows({ query: 'legacy' });
    expect(found.some((w) => w.id === LEGACY_ID)).toBe(true);

    // The commit claims search-frame protection too: the exact bytes Swift's
    // JSONDecoder sees from searchWorkflows must be as clean as listByStatus.
    const foundWire = JSON.stringify(found.find((w) => w.id === LEGACY_ID)!);
    expect(isWellFormedUtf16(foundWire)).toBe(true);
    expect(survivesTextEncoderRoundTrip(foundWire)).toBe(true);
    expect(foundWire).not.toContain('\\ud800');
    expect(foundWire).not.toContain('\\ude00');
  });

  it('a clean row containing only valid astral emoji round-trips unchanged', () => {
    const cleanTemplate = {
      name: 'Deploy 🚀 checklist',
      stableSteps: ['deploy \ud83d\ude00 bundle'],
    };
    const json = JSON.stringify(cleanTemplate);
    expect(json).not.toContain('\\ud800');
    h.db
      .prepare(
        `INSERT INTO workflows (
           id, name, purpose, status, template_json, occurrence_count,
           median_similarity, first_seen_at_ms, last_seen_at_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(LEGACY_ID, 'Clean 🚀 name', null, json, 1, 0.9, NOW, NOW, NOW, NOW);

    const dto = workflows.getById(LEGACY_ID)!;
    expect(dto.name).toBe('Clean 🚀 name');
    expect(dto.purpose).toBeNull();
    // Template survives byte-for-byte; no U+FFFD introduced.
    expect(JSON.stringify(dto.template)).toBe(json);
    const steps = dto.template.stableSteps ?? [];
    expect(steps[0]).toBe('deploy \ud83d\ude00 bundle');
  });

  it('toDto survives corrupt and scalar template_json (try/catch degrade + scope)', () => {
    // Row A exercises the catch branch (workflows-repository.ts:106-111):
    // unparseable template_json must degrade to {} instead of a SyntaxError
    // killing the whole list/search frame. Rows B/C parse fine as scalars —
    // they document that sanitizeDeep passes non-strings through verbatim.
    const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
    const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FBB';
    const ID_C = '01ARZ3NDEKTSV4RRFFQ69G5FBC';
    const seedRawRow = (id: string, name: string, templateJson: string): void => {
      h.db
        .prepare(
          `INSERT INTO workflows (
             id, name, purpose, status, template_json, occurrence_count,
             median_similarity, first_seen_at_ms, last_seen_at_ms,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, null, templateJson, 1, 0.9, NOW, NOW, NOW, NOW);
    };
    seedRawRow(ID_A, 'Corrupt json alpha', 'not json at all {');
    seedRawRow(ID_B, 'Scalar null beta', JSON.stringify(null));
    seedRawRow(ID_C, 'Scalar string gamma', JSON.stringify('just a string'));

    const dtoA = workflows.getById(ID_A)!;
    expect(dtoA).not.toBeNull();
    expect(dtoA.template).toEqual({}); // catch branch degrades to {}

    // Neither list nor search may throw on the corrupt row.
    const listed = workflows.listByStatus();
    expect(listed.some((w) => w.id === ID_A)).toBe(true);
    const found = workflows.searchWorkflows({ query: 'corrupt' });
    expect(found.some((w) => w.id === ID_A)).toBe(true);

    // Every returned DTO still serializes to well-formed UTF-16.
    for (const dto of [dtoA, ...listed]) {
      expect(isWellFormedUtf16(JSON.stringify(dto))).toBe(true);
    }

    // Scalar payloads are NOT caught by the try/catch (they parse) — they
    // pass through sanitizeDeep untouched; no throw, no coercion to {}.
    expect(workflows.getById(ID_B)!.template).toEqual(null);
    expect(workflows.getById(ID_C)!.template).toBe('just a string');
  });
});
// ---------------------------------------------------------------------------
// RA-2: chat_error emission points in chat-ops (failure path + busy path)
// ---------------------------------------------------------------------------

describe('chat_error emission sanitization (issue W2)', () => {

  interface CapturedEvent {
    kind: string;
    payload: Record<string, unknown>;
  }

  /** Minimal stand-in for `Promise.withResolvers` (lib target predates ES2024). */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  /** Stub router that only records op registrations. */
  function captureChatOps(chat: Pick<ChatSessionManager, 'send'>, maxActiveRuns?: number): {
    /** Resolves with the FIRST emitted chat_error payload — await the real signal. */
    firstChatError: Promise<CapturedEvent>;
    send: (params?: unknown) => { requestId: string };
  } {
    const handlers = new Map<string, (params: unknown) => unknown>();
    const router = {
      register: (op: string, handler: (params: unknown) => unknown) => {
        handlers.set(op, handler);
      },
    } as unknown as Router;
    const logger: Logger = { log() {}, pruneOld: () => 0 };
    const errorWaiter = deferred<CapturedEvent>();
    registerChatOps(router, {
      chat: chat as ChatSessionManager,
      broadcastEvent: (kind, payload) => {
        if (kind === 'chat_error') errorWaiter.resolve({ kind, payload });
      },
      logger,
      ...(maxActiveRuns === undefined ? {} : { maxActiveRuns }),
    });
    return {
      firstChatError: errorWaiter.promise,
      send: (params: unknown = { text: 'go' }) =>
        handlers.get('chat.send')!(params) as { requestId: string },
    };
  }

  it('a classified internal error with a lone surrogate emits a well-formed message', async () => {
    const { firstChatError, send } = captureChatOps({
      send: async () => {
        throw new Error('upstream blew up \ud800 mid-stream');
      },
    });
    const { requestId } = send();

    const error = await firstChatError;
    const payload = error.payload as { requestId: string; code: string; message: string };
    expect(payload.requestId).toBe(requestId);
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('upstream blew up \uFFFD mid-stream');
    expect(isWellFormedUtf16(payload.message)).toBe(true);
    expect(survivesTextEncoderRoundTrip(JSON.stringify(error.payload))).toBe(true);
  });

  it('clean error messages pass through unchanged — no behavior change', async () => {
    const { firstChatError, send } = captureChatOps({
      send: async () => {
        throw new Error('plain transport failure');
      },
    });
    send();

    const payload = (await firstChatError).payload as { message: string };
    expect(payload.message).toBe('plain transport failure');
  });

  it('the busy path also emits a well-formed chat_error message', async () => {
    // First run parks forever and holds the single active slot; the second
    // send must be ACKed then failed with 'busy'.
    const parked = deferred<string>().promise;
    const { firstChatError, send } = captureChatOps({ send: () => parked }, 1);
    send(); // admitted, parks
    const second = send(); // over cap → busy chat_error

    const error = await firstChatError;
    const payload = error.payload as { requestId: string; code: string; message: string };
    expect(payload.requestId).toBe(second.requestId);
    expect(payload.code).toBe('busy');
    expect(payload.message).toBe('chat run limit reached (1 active)');
    expect(isWellFormedUtf16(payload.message)).toBe(true);
  });
});
