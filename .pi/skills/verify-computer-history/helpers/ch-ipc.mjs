#!/usr/bin/env node
/**
 * ch-ipc — minimal verification client for the Computer History daemon.
 *
 * Talks the versioned length-prefixed JSON IPC protocol over the daemon's
 * Unix socket (u32 big-endian length + UTF-8 JSON). stdlib only, no deps.
 *
 * Usage:
 *   node helpers/ch-ipc.mjs doctor --home <dir>
 *   node helpers/ch-ipc.mjs request --home <dir> --op <op> [--params '{...}']
 *   node helpers/ch-ipc.mjs batch --home <dir> --file <batch.json>
 *
 * All commands exit 0 on success. `request` exits 3 when the daemon answers
 * ok:false (op-level error, response still printed). Protocol failures exit 1.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now()) {
  let time = now;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return out;
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseArgs(argv) {
  const out = { _: [] };
  let key = null;
  for (const tok of argv) {
    if (tok.startsWith('--')) {
      key = tok.slice(2);
      out[key] = true;
    } else if (key) {
      out[key] = tok;
      key = null;
    } else {
      out._.push(tok);
    }
  }
  return out;
}

/** Buffered single-frame reader shared across reads on one socket. */
function attachReader(socket) {
  const state = { buffer: Buffer.alloc(0), pending: [], closed: false };
  socket.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    pump();
  });
  socket.on('close', () => {
    state.closed = true;
    for (const w of state.pending.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('connection closed before a frame arrived'));
    }
  });
  function pump() {
    while (state.pending.length > 0 && state.buffer.length >= 4) {
      const len = state.buffer.readUInt32BE(0);
      if (len > 1024 * 1024) {
        const w = state.pending.shift();
        clearTimeout(w.timer);
        w.reject(new Error(`frame exceeds 1048576 bytes (${len})`));
        return;
      }
      if (state.buffer.length < 4 + len) return;
      const raw = state.buffer.subarray(4, 4 + len);
      state.buffer = state.buffer.subarray(4 + len);
      const w = state.pending.shift();
      clearTimeout(w.timer);
      try {
        w.resolve(JSON.parse(raw.toString('utf8')));
      } catch (e) {
        w.reject(new Error(`frame payload is not valid JSON: ${e.message}`));
      }
    }
  }
  function read(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = state.pending.indexOf(waiter);
          if (i !== -1) state.pending.splice(i, 1);
          reject(new Error('timed out waiting for frame'));
        }, timeoutMs),
      };
      state.pending.push(waiter);
      pump();
    });
  }
  return { read, state };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.on('error', reject);
  });
}

async function handshake(socket, read) {
  socket.write(encodeFrame({
    protocolVersion: 1,
    messageId: ulid(),
    type: 'client_hello',
    sentAt: Date.now(),
    appVersion: 'ch-ipc-verify',
  }));
  const hello = await read();
  if (hello.type === 'error') {
    throw new Error(`handshake rejected: ${JSON.stringify(hello.error)}`);
  }
  if (hello.type !== 'server_hello' || hello.protocolVersion !== 1) {
    throw new Error(`bad server_hello: ${JSON.stringify(hello).slice(0, 300)}`);
  }
  return hello;
}

/** Read until predicate matches; skip server-pushed `event` broadcasts. */
async function readUntil(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timed out waiting for matching frame');
    const frame = await read(remaining);
    if (predicate(frame)) return frame;
    if (frame.type === 'event') continue;
    throw new Error(`expected matching frame, got: ${JSON.stringify(frame).slice(0, 500)}`);
  }
}

async function cmdDoctor(home) {
  const socketPath = path.join(home, 'run', 'history.sock');
  let st;
  try {
    st = fs.lstatSync(socketPath);
  } catch {
    console.error(`doctor: no socket at ${socketPath} — is the daemon running with COMPUTER_HISTORY_HOME=${home}?`);
    process.exit(1);
  }
  if (!st.isSocket()) {
    console.error(`doctor: ${socketPath} exists but is not a socket; refusing to drive it`);
    process.exit(1);
  }
  const socket = await connect(socketPath).catch((e) => {
    console.error(`doctor: connect failed: ${e.message}`);
    process.exit(1);
  });
  const { read } = attachReader(socket);
  try {
    const hello = await handshake(socket, read);
    const requestId = ulid();
    socket.write(encodeFrame({
      protocolVersion: 1, messageId: ulid(), type: 'request',
      sentAt: Date.now(), op: 'status.get', requestId, params: {},
    }));
    const resp = await readUntil(read, (f) => f.type === 'response' && f.requestId === requestId);
    socket.destroy();
    if (!resp.ok) {
      console.error(`doctor: status.get failed: ${JSON.stringify(resp.error)}`);
      process.exit(1);
    }
    const r = resp.result;
    const report = {
      socketPath,
      daemonVersion: r.daemon.version,
      schemaVersion: r.daemon.schemaVersion,
      uptimeMs: r.daemon.uptimeMs,
      recording: r.recording,
      queue: r.queue,
      db: r.db,
      serverHello: { daemonVersion: hello.daemonVersion, databaseSchemaVersion: hello.databaseSchemaVersion },
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.error(`doctor: ${e.message}`);
    socket.destroy();
    process.exit(1);
  }
}

async function cmdRequest(home, op, paramsText) {
  if (!op) { console.error('request: --op <op> is required'); process.exit(1); }
  let params = {};
  if (paramsText !== undefined && paramsText !== true) {
    try { params = JSON.parse(paramsText); }
    catch (e) { console.error(`request: --params is not valid JSON: ${e.message}`); process.exit(1); }
  }
  const socketPath = path.join(home, 'run', 'history.sock');
  const socket = await connect(socketPath).catch((e) => {
    console.error(`request: connect failed: ${e.message}`); process.exit(1);
  });
  const { read } = attachReader(socket);
  try {
    await handshake(socket, read);
    const requestId = ulid();
    socket.write(encodeFrame({
      protocolVersion: 1, messageId: ulid(), type: 'request',
      sentAt: Date.now(), op, requestId, params,
    }));
    const resp = await readUntil(read, (f) => f.type === 'response' && f.requestId === requestId);
    socket.destroy();
    console.log(JSON.stringify(resp, null, 2));
    process.exit(resp.ok ? 0 : 3);
  } catch (e) {
    console.error(`request: ${e.message}`);
    socket.destroy();
    process.exit(1);
  }
}

async function cmdBatch(home, file) {
  if (!file || file === true) { console.error('batch: --file <batch.json> is required'); process.exit(1); }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`batch: cannot read ${file}: ${e.message}`); process.exit(1); }
  payload = {
    protocolVersion: 1,
    messageId: payload.messageId ?? ulid(),
    type: 'event_batch',
    sentAt: payload.sentAt ?? Date.now(),
    batchId: payload.batchId ?? ulid(),
    events: payload.events ?? [],
  };
  const socketPath = path.join(home, 'run', 'history.sock');
  const socket = await connect(socketPath).catch((e) => {
    console.error(`batch: connect failed: ${e.message}`); process.exit(1);
  });
  const { read } = attachReader(socket);
  try {
    await handshake(socket, read);
    socket.write(encodeFrame(payload));
    const ack = await readUntil(read,
      (f) => (f.type === 'event_batch_ack' && f.batchId === payload.batchId) || f.type === 'error');
    socket.destroy();
    console.log(JSON.stringify(ack, null, 2));
    process.exit(ack.type === 'event_batch_ack' ? 0 : 1);
  } catch (e) {
    console.error(`batch: ${e.message}`);
    socket.destroy();
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const home = args.home;
if (!home || home === true) {
  console.error('ch-ipc: --home <COMPUTER_HISTORY_HOME> is required (never drive the default home)');
  process.exit(1);
}
if (cmd === 'doctor') await cmdDoctor(home);
else if (cmd === 'request') await cmdRequest(home, args.op, args.params);
else if (cmd === 'batch') await cmdBatch(home, args.file);
else { console.error(`ch-ipc: unknown command ${cmd ?? '(none)'}; want doctor|request|batch`); process.exit(1); }
