import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ulid } from 'ulid';
import { CONSTANTS } from '../../src/config.js';

export const MAX_FRAME = CONSTANTS.maxFrameBytes;

/** Deferred promise; stands in for `Promise.withResolvers` (lib < ES2024). */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Timer-based delay; resolves via the shared deferred helper. */
function sleep(ms: number): Promise<void> {
  const done = deferred<void>();
  setTimeout(done.resolve, ms);
  return done.promise;
}

export function encodeFrame(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface ReadResult {
  value: Record<string, unknown>;
  raw: Buffer;
}

/**
 * Reads exactly one framed message; rejects on close or timeout.
 * Real timeouts are required here: the peer is an external daemon process that
 * cannot be driven by fake timers.
 */
interface FrameWaiter {
  resolve: (result: ReadResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface SocketReadState {
  buffer: Buffer;
  pending: FrameWaiter[];
  /** Hands buffered complete frames to waiting readers FIFO. */
  pump(): void;
}

/**
 * Per-socket receive buffer + pending-frame queue SHARED across readFrame
 * calls. TCP routinely coalesces several framed messages into one chunk
 * (e.g. broadcast events immediately followed by the response); the leftover
 * bytes and queued readers must therefore live outside any single call's
 * closure, or the next readFrame hangs despite data already having arrived.
 */
const socketStates = new WeakMap<net.Socket, SocketReadState>();

function stateFor(socket: net.Socket): SocketReadState {
  const existing = socketStates.get(socket);
  if (existing !== undefined) return existing;
  const state: SocketReadState = {
    buffer: Buffer.alloc(0),
    pending: [],
    pump(): void {
      while (this.pending.length > 0 && this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length < 4 + length) return; // rest of frame not here yet
        const raw = this.buffer.subarray(0, 4 + length);
        const value = JSON.parse(raw.subarray(4).toString('utf8')) as Record<string, unknown>;
        this.buffer = this.buffer.subarray(4 + length);
        const waiter = this.pending.shift();
        if (waiter === undefined) return;
        clearTimeout(waiter.timer);
        waiter.resolve({ value, raw });
      }
    },
  };
  socket.on('data', (chunk: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    state.pump();
  });
  socket.on('close', () => {
    for (const waiter of state.pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('connection closed before a frame arrived'));
    }
  });
  socketStates.set(socket, state);
  return state;
}

export function readFrame(socket: net.Socket, timeoutMs = 3000): Promise<ReadResult> {
  const state = stateFor(socket);
  const { promise, resolve, reject } = deferred<ReadResult>();
  const waiter: FrameWaiter = {
    resolve,
    reject,
    timer: setTimeout(() => {
      const index = state.pending.indexOf(waiter);
      if (index !== -1) state.pending.splice(index, 1);
      reject(new Error('timed out waiting for frame'));
    }, timeoutMs),
  };
  state.pending.push(waiter);
  state.pump(); // a previous chunk may already hold a complete frame for us
  return promise;
}

/**
 * Reads frames until `predicate` matches, transparently skipping daemon
 * broadcast frames (`type === 'event'`: queue_update, recording_state,
 * episodes_changed, memories_changed, chat_*), which the job worker, disk
 * guard, or segmenter may push at any time — including between the server
 * hello and the first awaited response. Skipped frames are logged for
 * visibility.
 *
 * A terminal non-matching frame (`type === 'error'` / `'server_hello'`)
 * rejects with the FULL JSON of the frame so residual failures stay
 * diagnosable.
 */
export async function readFrameUntil(
  socket: net.Socket,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<ReadResult> {
  for (;;) {
    const frame = await readFrame(socket, timeoutMs);
    const { value } = frame;
    if (predicate(value)) return frame;
    if (value.type === 'event') {
      console.log('SKIPPED BROADCAST:', JSON.stringify(value).slice(0, 400));
      continue;
    }
    throw new Error(`expected matching frame, got: ${JSON.stringify(frame.value)}`);
  }
}

/** Resolves when the peer closes the connection (external process → real clock). */
export function waitClose(socket: net.Socket, timeoutMs = 3000): Promise<void> {
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => reject(new Error('connection was not closed')), timeoutMs);
  socket.on('close', () => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}

export function connect(socketPath: string): Promise<net.Socket> {
  const { promise, resolve, reject } = deferred<net.Socket>();
  const socket = net.createConnection(socketPath, () => resolve(socket));
  socket.on('error', reject);
  return promise;
}

export function clientHello(protocolVersion = 1): object {
  return {
    protocolVersion,
    messageId: ulid(),
    type: 'client_hello',
    sentAt: Date.now(),
    appVersion: 'test-runner',
  };
}

export interface DaemonProcess {
  child: ChildProcess;
  socketPath: string;
  /** Resolves once the daemon has bound its socket and is accepting connections. */
  ready: Promise<void>;
  /** Everything the daemon wrote to stderr so far (joined capture buffer). */
  stderrText(): string;
}

/** Spawns the built daemon against an isolated COMPUTER_HISTORY_HOME. */
export function startDaemon(home: string): DaemonProcess {
  const socketPath = path.join(home, 'run', 'history.sock');
  const entry = path.join(import.meta.dirname, '..', '..', 'dist', 'main.js');
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, COMPUTER_HISTORY_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  const ready = (async () => {
    // Readiness = a real TCP-style connect succeeds. A bare socket-file check is
    // not enough: a SIGKILLed predecessor leaves the file behind, and the new
    // daemon must first probe-and-replace it before it accepts connections.
    const accepts = (async () => {
      for (let i = 0; i < 1000; i++) {
        if (existsSync(socketPath)) {
          const probe = deferred<boolean>();
          const conn = net.createConnection(socketPath, () => {
            conn.destroy();
            probe.resolve(true);
          });
          conn.on('error', () => probe.resolve(false));
          if (await probe.promise) return;
        }
        await sleep(10);
      }
      throw new Error(`daemon never started accepting on ${socketPath}; stderr: ${stderr.join('')}`);
    })();
    // A daemon that dies before accepting (e.g. DB_CORRUPT exit 46 within
    // ~300ms) must fail readiness immediately instead of burning the full
    // poll budget; the message keeps the pinned phrase so callers can match
    // either failure mode with one regex.
    const exited = deferred<never>();
    child.once('exit', (code, signal) => {
      exited.reject(
        new Error(
          `daemon never started accepting on ${socketPath} — process exited ` +
            `(code=${code}, signal=${signal}); stderr: ${stderr.join('')}`,
        ),
      );
    });
    await Promise.race([accepts, exited.promise]);
  })();

  return { child, socketPath, ready, stderrText: () => stderr.join('') };
}

/**
 * SIGTERM with SIGKILL escalation at the daemon's shutdown-watchdog budget
 * plus a 10s margin (CONSTANTS.shutdownWatchdogMs + 10s): the daemon's own
 * watchdog force-exits first on a hang, and this timer is only the backstop
 * for a fully wedged process. Graceful shutdown (WAL checkpoint,
 * segment finalize, job persistence) is allowed to be slow under load, so the
 * pre-kill grace budget is generous; a signal-driven exit means something went
 * wrong and we reject loudly instead of resolving a mysterious `null`.
 */
export function stopDaemon(child: ChildProcess): Promise<number> {
  if (child.signalCode !== null) {
    return Promise.reject(new Error(`daemon already dead by signal ${child.signalCode} before graceful shutdown completed`));
  }
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  const { promise, resolve, reject } = deferred<number>();
  const timer = setTimeout(() => child.kill('SIGKILL'), CONSTANTS.shutdownWatchdogMs + 10_000);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    if (signal !== null) {
      reject(new Error(`daemon exited by signal ${signal} before graceful shutdown completed`));
    } else {
      resolve(code ?? -1);
    }
  });
  child.kill('SIGTERM');
  return promise;
}

