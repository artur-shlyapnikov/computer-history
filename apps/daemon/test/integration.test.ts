import { execSync, spawn } from 'node:child_process';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ClientHelloSchema,
  ServerHelloSchema,
  StatusResultSchema,
  assertFrame,
} from '@computer-history/protocol';

import {
  MAX_FRAME,
  clientHello,
  connect,
  encodeFrame,
  readFrame,
  startDaemon,
  stopDaemon,
  waitClose,
  type DaemonProcess,
} from './helpers/ipc.js';

describe('daemon IPC integration (real unix socket, temp home)', () => {
  let home: string;
  let daemon: DaemonProcess;
  let socketPath: string;

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'ch-daemon-test-'));
    daemon = startDaemon(home);
    await daemon.ready;
    socketPath = daemon.socketPath;
  }, 20_000);

  afterAll(async () => {
    await stopDaemon(daemon.child);
    rmSync(home, { recursive: true, force: true });
  });

  it('completes a happy-path handshake and answers status.get', async () => {
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');
    assertFrame(ServerHelloSchema, hello.value as never);
    expect(hello.value.protocolVersion).toBe(1);
    expect(typeof hello.value.daemonVersion).toBe('string');
    expect(hello.value.databaseSchemaVersion).toBe(13);

    const request = {
      protocolVersion: 1,
      messageId: ulid(),
      type: 'request',
      sentAt: Date.now(),
      op: 'status.get',
      requestId: ulid(),
      params: {},
    };
    socket.write(encodeFrame(request));
    const response = await readFrame(socket);
    expect(response.value.ok).toBe(true);
    expect(response.value.requestId).toBe(request.requestId);
    assertFrame(StatusResultSchema, response.value.result as never);

    const result = response.value.result as {
      daemon: { schemaVersion: number };
      db: { rawEvents: number };
      diskFreeBytes: number;
    };
    expect(result.daemon.schemaVersion).toBe(13);
    expect(result.db.rawEvents).toBe(0);
    expect(result.diskFreeBytes).toBeGreaterThan(0);

    // Unknown op (not a pinned name) → typed error.not_found response.
    socket.write(
      encodeFrame({ ...request, messageId: ulid(), requestId: ulid(), op: 'nope.unknown' }),
    );
    const unknownOpResponse = await readFrame(socket);
    expect(unknownOpResponse.value.ok).toBe(false);
    expect((unknownOpResponse.value.error as { code: string }).code).toBe('error.not_found');

    // Regression pin (T2): an overlong op name must still answer
    // error.not_found with a BOUNDED echo — the reply message may not carry
    // the whole client-controlled op back onto the wire.
    const longOp = 'x'.repeat(100);
    socket.write(
      encodeFrame({ ...request, messageId: ulid(), requestId: ulid(), op: longOp }),
    );
    const longOpResponse = await readFrame(socket);
    expect(longOpResponse.value.ok).toBe(false);
    expect((longOpResponse.value.error as { code: string }).code).toBe('error.not_found');
    const longOpMessage = (longOpResponse.value.error as { message: string }).message;
    expect(longOpMessage.length).toBeLessThan(100);

    // M5 wired memories.list: empty DB → ok with the three fixed groups.
    // memory.action is live too: an unknown id answers error.not_found.
    socket.write(
      encodeFrame({
        ...request,
        messageId: ulid(),
        requestId: ulid(),
        op: 'memories.list',
        params: {},
      }),
    );
    const memoriesResponse = await readFrame(socket);
    expect(memoriesResponse.value.ok).toBe(true);
    expect(memoriesResponse.value.result).toEqual({
      groups: [
        { status: 'confirmed', memories: [] },
        { status: 'suggestions', memories: [] },
        { status: 'rejected', memories: [] },
      ],
    });

    socket.write(
      encodeFrame({
        ...request,
        messageId: ulid(),
        requestId: ulid(),
        op: 'memory.action',
        params: { id: ulid(), action: 'confirm' },
      }),
    );
    const actionResponse = await readFrame(socket);
    expect(actionResponse.value.ok).toBe(false);
    expect((actionResponse.value.error as { code: string }).code).toBe('error.not_found');
    socket.destroy();
  });

  it('rejects an incompatible major protocol version and closes', async () => {
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello(2)));
    const rejection = await readFrame(socket);
    expect(rejection.value.type).toBe('error');
    expect((rejection.value.error as { code: string }).code).toBe('error.protocol_version');
    await waitClose(socket);
  });

  it('rejects a post-handshake frame with an incompatible protocol version and closes', async () => {
    const socket = await connect(socketPath);
    socket.write(encodeFrame(clientHello()));
    const hello = await readFrame(socket);
    expect(hello.value.type).toBe('server_hello');

    socket.write(
      encodeFrame({
        protocolVersion: 99,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'status.get',
        requestId: ulid(),
        params: {},
      }),
    );
    const rejection = await readFrame(socket);
    expect(rejection.value.type).toBe('error');
    expect((rejection.value.error as { code: string }).code).toBe('error.protocol_version');
    await waitClose(socket);
  });

  it('rejects garbage payload with error.bad_frame and closes', async () => {
    const socket = await connect(socketPath);
    const body = Buffer.from('this is not json', 'utf8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    socket.write(frame);
    const err = await readFrame(socket);
    expect((err.value.error as { code: string }).code).toBe('error.bad_frame');
    await waitClose(socket);
  });

  it('closes the connection on an oversized declared frame before any handshake', async () => {
    const socket = await connect(socketPath);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME + 1, 0);
    socket.write(header);
    // The server must terminate us; it may emit error.bad_frame first.
    try {
      const err = await readFrame(socket, 2000);
      expect((err.value.error as { code: string }).code).toBe('error.bad_frame');
    } catch {
      // closing without a frame also satisfies the contract
    }
    await waitClose(socket);
  });

  it('rejects a non-hello first frame with error.bad_frame', async () => {
    const socket = await connect(socketPath);
    socket.write(
      encodeFrame({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'request',
        sentAt: Date.now(),
        op: 'status.get',
        requestId: ulid(),
        params: {},
      }),
    );
    const err = await readFrame(socket);
    expect((err.value.error as { code: string }).code).toBe('error.bad_frame');
    await waitClose(socket);
  });

  // Corrupted-IPC-frame drills (brief-m7 §D7 item 5): every case ⇒
  // error.bad_frame + close, AND the server stays alive for the NEXT
  // connection. One row per hostile framing shape.
  const badFrameCases: Array<{ name: string; wire: () => Buffer | object }> = [
    {
      name: 'truncated declared length mis-parses the payload',
      wire: () => {
        const body = Buffer.from(JSON.stringify({ ping: true }), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(Math.floor(body.length / 2), 0); // lies short
        return Buffer.concat([header, body]);
      },
    },
    {
      name: 'invalid UTF-8 payload',
      wire: () => {
        const body = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        return Buffer.concat([header, body]);
      },
    },
    {
      name: 'valid JSON with an unknown envelope type',
      wire: () => ({
        protocolVersion: 1,
        messageId: ulid(),
        type: 'mystery_frame',
        sentAt: Date.now(),
      }),
    },
    {
      name: 'missing messageId in the envelope',
      wire: () => ({
        protocolVersion: 1,
        type: 'request',
        sentAt: Date.now(),
        op: 'status.get',
        requestId: ulid(),
        params: {},
      }),
    },
  ];

  for (const [index, testCase] of badFrameCases.entries()) {
    it(`drill ${index + 1}/${badFrameCases.length}: ${testCase.name} ⇒ bad_frame + close, server survives`, async () => {
      const socket = await connect(socketPath);
      socket.write(encodeFrame(clientHello()));
      const hello = await readFrame(socket);
      expect(hello.value.type).toBe('server_hello');
      // Post-handshake hostile frames land on the envelope/schema checks…
      const wire = testCase.wire();
      socket.write(typeof wire === 'object' && !Buffer.isBuffer(wire) ? encodeFrame(wire) : wire);
      const err = await readFrame(socket);
      expect((err.value.error as { code: string }).code).toBe('error.bad_frame');
      await waitClose(socket);

      // …and the daemon accepts a healthy next connection.
      const next = await connect(socketPath);
      next.write(encodeFrame(clientHello()));
      const nextHello = await readFrame(next);
      expect(nextHello.value.type).toBe('server_hello');
      next.destroy();
    });
  }

  it('handles a duplicate bind attempt by exiting nonzero with a diagnostic', async () => {
    const entry = path.join(import.meta.dirname, '..', 'dist', 'main.js');
    const second = spawn(process.execPath, [entry], {
      env: { ...process.env, COMPUTER_HISTORY_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      second.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      second.on('exit', (code) => resolve({ code, stderr }));
    });
    expect(exit.code).not.toBe(0);
    expect(exit.stderr.toLowerCase()).toContain('already owns the socket');
  }, 10_000);

  // Regression pin (T3a): a REGULAR FILE at the socket path is a
  // misconfiguration, not a stale socket — the daemon must fail startup with
  // ENOTSOCK and leave the unrelated user file untouched.
  it('refuses to start when a regular file occupies the socket path (ENOTSOCK), file intact', async () => {
    const fileHome = mkdtempSync(path.join(tmpdir(), 'ch-daemon-notsock-'));
    const runDir = path.join(fileHome, 'run');
    mkdirSync(runDir);
    const socketPath = path.join(runDir, 'history.sock');
    writeFileSync(socketPath, 'precious user data');

    let daemon: DaemonProcess | undefined;
    try {
      daemon = startDaemon(fileHome);
      await expect(daemon.ready).rejects.toThrow(/never started accepting|process exited/);
      expect(daemon.stderrText()).toContain('ENOTSOCK');
      // The regular file survived: the reclaim path never unlinked it.
      expect(readFileSync(socketPath, 'utf8')).toBe('precious user data');
    } finally {
      if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
        daemon.child.kill('SIGKILL');
      }
      rmSync(fileHome, { recursive: true, force: true });
    }
  }, 10_000);

  // Regression: signal handlers MUST be registered before buildRuntime
  // resolves. Startup can stall after the socket is bound — historically
  // inside PiRuntime.get when the SDK model-runtime creation hangs under
  // load — and a serving-but-not-ready daemon must still shut down gracefully
  // instead of dying to the default SIGTERM disposition (no finalize, no WAL
  // checkpoint). The stall is reproduced deterministically by pointing the
  // LLM agent dir at a FIFO: ModelRuntime.create blocks opening auth.json,
  // which parks the eager startup path exactly where the incident happened.
  it('exits gracefully when SIGTERM lands during startup, before ready', async () => {
    const bootHome = mkdtempSync(path.join(tmpdir(), 'ch-daemon-boot-'));
    const agentDir = path.join(bootHome, 'agent');
    mkdirSync(agentDir);
    const fifo = path.join(agentDir, 'auth.json');
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    // startDaemon spreads process.env, so scoping the override around the
    // spawn call is enough to redirect only this daemon's credential lookup.
    process.env['COMPUTER_HISTORY_LLM_AGENT_DIR'] = agentDir;
    let booting: DaemonProcess;
    try {
      booting = startDaemon(bootHome);
    } finally {
      delete process.env['COMPUTER_HISTORY_LLM_AGENT_DIR'];
    }
    // Deliberately never awaited; silence its rejection so an early exit
    // does not surface as an unhandled error.
    booting.ready.catch(() => {});
    try {
      // Socket accepting = server.listen() resolved, i.e. the daemon is
      // serving frames while still inside buildRuntime.
      await booting.ready;
      // Real timer required: the peer is an external daemon process, so fake
      // timers cannot drive it (same rationale as helpers/ipc.ts).
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          booting.child.once('exit', (code, signal) => resolve({ code, signal }));
          booting.child.kill('SIGTERM');
        }),
        // A daemon whose startup never installed handlers may ignore SIGTERM
        // outright; report that as failure instead of burning the test budget.
        new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 5_000)),
      ]);
      expect(exit).not.toBe('stalled');
      if (exit === 'stalled') return;
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
    } finally {
      // A pre-fix daemon can ignore SIGTERM entirely (blocked in a retried
      // open() inside ModelRuntime.create); make sure it never outlives the
      // test before removing its temp home.
      if (booting.child.exitCode === null && booting.child.signalCode === null) {
        booting.child.kill('SIGKILL');
      }
      rmSync(bootHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('shuts down cleanly on SIGTERM (exit code 0)', async () => {
    expect(await stopDaemon(daemon.child)).toBe(0);
  }, 10_000);

  it('keeps its own ClientHello fixture schema-valid', () => {
    assertFrame(ClientHelloSchema, clientHello() as never);
  });
});
