import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import path from 'node:path';
import net from 'node:net';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventBatchAckSchema, assertFrame, type ActivityEvent, type EventBatch } from '@computer-history/protocol';

import {
  clientHello,
  connect,
  encodeFrame,
  readFrame,
  readFrameUntil,
  startDaemon,
  stopDaemon,
  type DaemonProcess,
} from './helpers/ipc.js';

/**
 * Redaction cross-cutting suite (brief-m7 §D7 item 7): hostile batches pushed
 * end-to-end over the REAL socket must leave ZERO secret substrings in
 * raw_events.content (direct DB dump scan) and in EVERY file under logs/.
 */

// Build credential-shaped inputs at runtime from harmless fragments. This
// keeps the redaction coverage while ensuring scanners do not report a
// hard-coded credential from this intentionally synthetic fixture.
const PEM = [
  ['-----BEGIN', ' RSA PRIVATE KEY-----'].join(''),
  'fixture-pem-body',
  ['-----END', ' RSA PRIVATE KEY-----'].join(''),
].join('\n');
const CARD = ['4111', '1111', '1111', '1111'].join(''); // Luhn-valid test PAN
const API_KEY = ['s', 'k-', 'live-', 'a'.repeat(32)].join('');
const AWS_KEY = ['AKIA', 'A'.repeat(16)].join(''); // canonical AWS access-key shape
const GITHUB_TOKEN = ['ghp_', 'A'.repeat(36)].join(''); // canonical ghp_ PAT shape
const OVERSIZE =
  `pem:${PEM} card:${CARD} key:${API_KEY} aws:${AWS_KEY} gh:${GITHUB_TOKEN} ${'x'.repeat(2100)}`; // >2048 chars

const SECRETS = [PEM.split('\n')[1]!, CARD, API_KEY, AWS_KEY, GITHUB_TOKEN];
function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: ulid(),
    observedAt: Date.now(),
    source: 'accessibility',
    app: { bundleId: 'com.test.App', name: 'TestApp', pid: 11 },
    window: { title: 'Hostile window' },
    action: 'click',
    target: { role: 'AXButton', label: 'Save' },
    contentPolicy: 'allow',
    ...overrides,
  };
}

describe('redaction cross-cutting (real daemon end-to-end)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let socketPath: string;
  let socket: net.Socket;

  async function sendBatch(batch: EventBatch): Promise<{ accepted: number; rejected: number }> {
    socket.write(encodeFrame(batch));
    const frame = await readFrameUntil(socket, (value) => value.type === 'event_batch_ack');
    assertFrame(EventBatchAckSchema, frame.value as never);
    return frame.value as unknown as { accepted: number; rejected: number };
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-redact-'));
    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
    socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
  }, 20_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    if (socket && !socket.destroyed) socket.destroy();
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects every hostile vector and accepts only the benign event', async () => {
    const batch: EventBatch = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'event_batch',
      sentAt: Date.now(),
      batchId: ulid(),
      events: [
        // Benign control: must be ACCEPTED and stored without secrets.
        event({ id: ulid(), action: 'focus_change', target: { role: 'AXButton', label: 'Inbox' } }),
        // (b) typing_activity with PEM content.
        event({ id: ulid(), action: 'typing_activity', contentPolicy: 'allow', content: PEM }),
        // (b) typing_activity with a Luhn-valid PAN.
        event({ id: ulid(), action: 'typing_activity', contentPolicy: 'allow', content: `pay ${CARD}` }),
        // (b) typing_activity smuggling an AWS access-key id.
        event({
          id: ulid(),
          source: 'input',
          action: 'typing_activity',
          contentPolicy: 'allow',
          content: `deploy ${AWS_KEY}`,
        }),
        // (a′) AXSecureTextField target with a GitHub token, whatever policy claims.
        event({
          id: ulid(),
          contentPolicy: 'allow',
          target: { role: 'AXTextField', subrole: 'AXSecureTextField', label: 'Password' },
          content: GITHUB_TOKEN,
        }),
        // (a) redacted_secure_field policy WITH content.
        event({ id: ulid(), contentPolicy: 'redacted_secure_field', content: API_KEY }),
        // (a″) sensitive-target redaction claimed, yet content smuggled anyway.
        event({
          id: ulid(),
          contentPolicy: 'redacted_sensitive_target',
          target: { role: 'AXTextField', label: 'Password' },
          content: AWS_KEY,
        }),
        // (a″) metadata_only claims content was stripped — PEM smuggled regardless.
        event({ id: ulid(), action: 'click', contentPolicy: 'metadata_only', content: PEM }),
        // (a″) excluded_app tombstones must never carry content either.
        event({ id: ulid(), action: 'app_focus', contentPolicy: 'excluded_app', content: GITHUB_TOKEN }),
        // (c) 3KiB string smuggling all five secret shapes.
        event({ id: ulid(), contentPolicy: 'allow', content: OVERSIZE }),
        // §3.11: empty string is NOT null — SecureTextField must still reject.
        event({
          id: ulid(),
          contentPolicy: 'allow',
          target: { role: 'AXTextField', subrole: 'AXSecureTextField' },
          content: '',
        }),
        // (b) typing_activity with EMPTY-string content is still content.
        event({ id: ulid(), source: 'input', action: 'typing_activity', contentPolicy: 'allow', content: '' }),
        // (a″) metadata_only claims content was stripped — even an empty one.
        event({ id: ulid(), action: 'click', contentPolicy: 'metadata_only', content: '' }),
      ],
    };
    const ack = await sendBatch(batch);
    expect(ack.accepted).toBe(1); // only the benign focus event
    expect(ack.rejected).toBe(12);
  }, 15_000);

  it('leaves zero secret substrings in raw_events (DB dump scan)', async () => {
    await stopDaemon(daemon.child);
    const db = new Database(path.join(home, 'data', 'history.db'), { readonly: true });
    try {
      const rows = db
        .prepare('SELECT id, content FROM raw_events')
        .all() as Array<{ id: string; content: string | null }>;
      expect(rows.length).toBeGreaterThanOrEqual(1); // the benign event lives
      for (const row of rows) {
        for (const secret of SECRETS) {
          expect(row.content ?? '').not.toContain(secret);
        }
      }
      // Belt-and-braces: no column anywhere in raw_events carries the PAN.
      const dump = JSON.stringify(db.prepare('SELECT * FROM raw_events').all());
      for (const secret of SECRETS) expect(dump).not.toContain(secret);
    } finally {
      db.close();
    }
  }, 15_000);

  it('leaves zero secret substrings in ANY log file under logs/', () => {
    const logsDir = path.join(home, 'logs');
    const files = readdirSync(logsDir).map((f) => path.join(logsDir, f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
