import { TypeCompiler } from '@sinclair/typebox/compiler';

import { mkdirSync, chmodSync, existsSync, lstatSync, unlinkSync, type Stats } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ulid } from 'ulid';

import {
  PROTOCOL_VERSION,
  ClientHelloSchema,
  EventBatchAckSchema,
  EventBatchSchema,
  InboundFrameSchema,
  ServerEventFrameSchema,
  ServerEventPayloads,
  ServerHelloSchema,
  type ClientHello,
  type EventBatch,
  type ServerEventKind,
} from '@computer-history/protocol';
import { CONSTANTS } from '../config.js';
import type { Logger } from '../logging.js';
import type { Router } from './router.js';


/**
 * Outbound protocol-level error frames (handshake/bad frame rejections).
 *
 * The client's messageId is echoed only when it is itself a well-formed ULID;
 * attacker-controlled junk (arbitrary strings, oversized ids) is replaced by a
 * server-generated id so every outbound frame still satisfies the protocol's
 * Ulid-typed EnvelopeFields.messageId.
 */
function errorFrame(messageId: string, code: string, message: string) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: ULID_PATTERN.test(messageId) ? messageId : ulid(),
    type: 'error' as const,
    sentAt: Date.now(),
    error: { code, message },
  };
}

function encodeFrame(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Resolves when every task has settled, or after `ms`, whichever comes first. */
function settleWithin(tasks: ReadonlySet<Promise<unknown>>, ms: number): Promise<void> {
  if (tasks.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never pin the event loop on a drain timeout that may not fire.
    timer.unref();
    void Promise.allSettled(tasks).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Canonical ULID shape (Crockford base32, 26 chars) — mirrors the protocol schema. */
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
/** Default cap on simultaneously connected sockets; overridable per instance (tests). */
const DEFAULT_MAX_CONNECTIONS = 16;
/**
 * Per-connection budget for an incomplete frame: one length prefix plus one
 * max-size payload. A connection whose buffered prefix grows beyond this
 * (dribbled bytes that never complete a frame) is rejected.
 */
const MAX_INCOMPLETE_FRAME_BYTES = CONSTANTS.maxFrameBytes + 4;

/** Max time a reject waits for coalesced in-flight frame handlers to settle. */
const REJECT_DRAIN_TIMEOUT_MS = 1_000;
/** Default linger before a rejected connection is force-closed (hostile-peer bound). */
const REJECT_LINGER_TIMEOUT_MS = 2_000;

export interface IpcServerOptions {
  socketPath: string;
  router: Router;
  logger: Logger;
  daemonVersion: string;
  databaseSchemaVersion: number;
  /** Max simultaneously connected sockets; excess connections are destroyed on accept. */
  maxConnections?: number;
  /** Max bytes a single connection may buffer for an incomplete frame. */
  maxIncompleteFrameBytes?: number;
  /** Linger window after a rejection before force-close; overridable per instance (tests). */
  rejectLingerTimeoutMs?: number;
  /** Max time a reject waits for coalesced in-flight handlers to settle; overridable per instance (tests). */
  rejectDrainTimeoutMs?: number;
}

// Compiled-once schema checks shared by every connection.
const compiledChecks = new Map<object, (v: unknown) => boolean>();
function schemaCheck(schema: object, value: unknown): boolean {
  let check = compiledChecks.get(schema);
  if (!check) {
    const compiled = TypeCompiler.Compile(schema as never);
    check = (v: unknown) => compiled.Check(v);
    compiledChecks.set(schema, check);
  }
  return check(value);
}

interface ConnectionState {
  /** Incomplete-frame chunks; flattened exactly once, when a complete frame is buffered. */
  chunks: Buffer[];
  /** Total bytes across `chunks`; drives the per-connection byte-budget check. */
  buffered: number;
  handshaken: boolean;
  alive: boolean;
  /** In-flight frame-handler promises, drained (bounded) before reject teardown. */
  pending: Set<Promise<void>>;
  /** The registered 'data' listener, detached during graceful reject teardown. */
  onData?: (chunk: Buffer) => void;
}

/**
 * Unix-socket IPC server.
 *
 * Framing: u32 big-endian length + UTF-8 JSON payload; payloads above
 * CONSTANTS.maxFrameBytes are rejected with error.bad_frame and the connection
 * is closed (contracts §Protocol v1). The close itself is graceful: replies
 * of well-formed frames dispatched before the violation go out first, then
 * the error frame is flushed via half-close so the client reads it instead of
 * eating an RST. The first inbound frame MUST be a
 * ClientHello with protocolVersion === 1; anything else before handshake is
 * error.bad_frame and an incompatible version is error.protocol_version — both
 * followed by close.
 * Socket directory is created 0700 before bind. The chmod of the socket to
 * 0600 happens after listen() resolves, so a window exists in which a client
 * could connect before the mode is tightened; that window is mitigated by the
 * parent directory being 0700 (only the same user can reach the socket path).
 *
 * Hardening: connections are capped (maxConnections); a connection may pin at
 * most maxIncompleteFrameBytes of buffered incomplete frame; outbound frames
 * larger than CONSTANTS.maxFrameBytes are never written; broadcast payloads are
 * validated against their per-kind schema before any bytes hit the wire.
 *
 * Reply policy (exactly one reply per well-formed frame, any size up to
 * maxFrameBytes): a valid event_batch is answered with exactly one
 * event_batch_ack; a value-invalid batch with error.bad_frame
 * 'malformed event_batch' followed by close; an unparsable or unshapeable
 * frame with error.bad_frame followed by close. Frame shape is decided by the
 * envelope + type discriminator only; payload content is judged by each
 * frame's dedicated schema — so identical bytes always produce an identical
 * verdict. A handler failure after validation is answered with error.internal
 * and never leaves a dispatched frame unanswered.
 */
export class IpcServer {
  /** Per-connection outbound buffer bound before the peer is destroyed. */
  private static readonly maxWriteBufferBytes = 4 * 1024 * 1024;
  private readonly options: IpcServerOptions;
  private server: net.Server | null = null;
  private readonly connections = new Map<net.Socket, ConnectionState>();

  private readonly maxConnections: number;
  private readonly maxIncompleteFrameBytes: number;
  private readonly rejectLingerTimeoutMs: number;
  private readonly rejectDrainTimeoutMs: number;

  constructor(options: IpcServerOptions) {
    this.options = options;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxIncompleteFrameBytes = options.maxIncompleteFrameBytes ?? MAX_INCOMPLETE_FRAME_BYTES;
    this.rejectLingerTimeoutMs = options.rejectLingerTimeoutMs ?? REJECT_LINGER_TIMEOUT_MS;
    this.rejectDrainTimeoutMs = options.rejectDrainTimeoutMs ?? REJECT_DRAIN_TIMEOUT_MS;
  }

  async listen(): Promise<void> {
    if (this.server) {
      throw new Error('IpcServer.listen called on an already-listening instance');
    }
    const { socketPath } = this.options;
    mkdirSync(path.dirname(socketPath), { recursive: true });
    chmodSync(path.dirname(socketPath), 0o700);
    await this.claimSocketPath(socketPath);

    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;
    // Persistent guard installed before listen: a late async 'error' (e.g.
    // from a failed or abandoned bind) must never surface as an unhandled
    // 'error' event and crash the process.
    server.on('error', (err) => {
      this.options.logger.log('error', 'ipc', 'server socket error', { errorMessage: err.message });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.removeListener('error', onError);
        resolve();
      });
    })
      .then(() => {
        // Tighten the freshly bound socket INSIDE the same rejection flow: a
        // chmod failure must trigger the same abandonment path as a failed
        // bind instead of stranding a live listening server.
        chmodSync(socketPath, 0o600);
      })
      .catch((err: unknown) => {
        // Abandon the half-bound server and reset connection state so a retry
        // starts clean instead of overwriting a live-but-broken instance.
        for (const socket of this.connections.keys()) socket.destroy();
        this.connections.clear();
        this.server = null;
        server.close();
        throw err;
      });
    this.options.logger.log('info', 'ipc', 'listening', { socketPath });
  }

  /**
   * A pre-existing socket file may belong to a live daemon or be stale.
   * Probe first: if a peer answers, refuse to start (EADDRINUSE semantics);
   * only a provably dead socket is replaced.
   */
  private async claimSocketPath(socketPath: string): Promise<void> {
    if (!existsSync(socketPath)) return;
    const answered = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath, () => {
        probe.destroy();
        resolve(true);
      });
      probe.on('error', () => resolve(false));
    });
    if (answered) {
      throw Object.assign(new Error('history.sock is already owned by another daemon'), {
        code: 'EADDRINUSE',
      });
    }
    // Reclaim only a stale SOCKET. A regular file at socketPath is a
    // misconfiguration (probe fails with ECONNREFUSED/ENOTSOCK); deleting it
    // would destroy an unrelated user file. Leave it and let bind() fail.
    let stats: Stats;
    try {
      stats = lstatSync(socketPath);
    } catch {
      return; // vanished between the probe and here — nothing to reclaim
    }
    if (stats.isSocket()) unlinkSync(socketPath);
    else {
      throw Object.assign(new Error(`refusing to reclaim non-socket path ${socketPath}`), {
        code: 'ENOTSOCK',
      });
    }
  }

  async close(): Promise<void> {
    for (const socket of this.connections.keys()) socket.destroy();
    this.connections.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
    } catch {
      // best effort cleanup
    }
    this.options.logger.log('info', 'ipc', 'closed');
  }

  private onConnection(socket: net.Socket): void {
    if (this.connections.size >= this.maxConnections) {
      this.options.logger.log('warn', 'ipc', 'connection refused: max connections', {
        maxConnections: this.maxConnections,
      });
      socket.destroy();
      return;
    }
    const state: ConnectionState = {
      chunks: [],
      buffered: 0,
      handshaken: false,
      alive: true,
      pending: new Set(),
    };
    this.connections.set(socket, state);
    const onData = (chunk: Buffer): void => this.onData(socket, state, chunk);
    state.onData = onData;
    socket.on('data', onData);
    const drop = () => {
      state.alive = false;
      this.connections.delete(socket);
    };
    socket.on('close', drop);
    socket.on('error', (err) => {
      this.options.logger.log('warn', 'ipc', 'connection error', { errorMessage: err.message });
      drop();
    });
  }

  private onData(socket: net.Socket, state: ConnectionState, chunk: Buffer): void {
    // Accumulate chunks without copying; flatten exactly once, when a complete
    // frame is buffered. Concat per chunk would be quadratic in chunks per
    // frame: a 1MiB frame arriving in 8KiB socket reads measured 10.7ms/frame
    // reassembly vs 0.21ms flattened once (round-28 framing microbench).
    if (state.buffered === 0 || state.chunks.length === 0) {
      state.chunks = [chunk];
    } else {
      state.chunks.push(chunk);
    }
    state.buffered += chunk.length;
    while (state.alive && !socket.destroyed && state.buffered >= 4) {
      const first = state.chunks.at(0);
      // Unreachable in practice: buffered >= 4 implies at least one chunk.
      if (first === undefined) break;
      const length = first.length >= 4 ? first.readUInt32BE(0) : Buffer.concat(state.chunks, 4).readUInt32BE(0);
      if (length > CONSTANTS.maxFrameBytes) {
        this.reject(socket, state, 'error.bad_frame', `frame exceeds ${CONSTANTS.maxFrameBytes} bytes`);
        return;
      }
      if (state.buffered < 4 + length) {
        // Incomplete frame: leave it buffered, but fall through to the
        // per-connection byte-budget check below.
        break;
      }
      // Single-chunk fast path: Buffer.concat([b]) copies in Node 26, which
      // would tax the common whole-frame-per-chunk recorder write.
      const single = state.chunks.at(0);
      const flat =
        state.chunks.length === 1 && single !== undefined ? single : Buffer.concat(state.chunks);
      const body = flat.subarray(4, 4 + length);
      state.buffered -= 4 + length;
      state.chunks = [flat.subarray(4 + length)];
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        this.reject(socket, state, 'error.bad_frame', 'frame payload is not valid JSON');
        return;
      }
      this.onFrame(socket, state, parsed);
    }

    // Whatever remains past the loop is an incomplete-frame prefix; bound how
    // much memory a single slow or dribbling connection may pin.
    if (state.alive && !socket.destroyed && state.buffered > this.maxIncompleteFrameBytes) {
      this.reject(socket, state, 'error.bad_frame', 'incomplete frame exceeded byte budget');
    }
  }

  private onFrame(socket: net.Socket, state: ConnectionState, parsed: unknown): void {
    if (!state.handshaken) {
      this.onHandshakeFrame(socket, state, parsed);
      return;
    }
    if (!isEnvelopeLike(parsed)) {
      this.reject(socket, state, 'error.bad_frame', 'missing envelope fields');
      return;
    }
    // §3.4: version compatibility applies to every message; a frame with an
    // incompatible major version is rejected exactly like a bad hello.
    if (parsed.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectProtocolVersion(
        socket,
        state,
        parsed.messageId,
        parsed.protocolVersion as number,
      );
      return;
    }
    const frame = parsed as {
      messageId: string;
      type: string;
      requestId?: string;
      op?: string;
      params?: unknown;
    };
    // event_batch is discriminated by envelope + type alone and validated by
    // its DEDICATED schema in onEventBatch — never by the InboundFrameSchema
    // union below. The union embeds the full EventBatchSchema, so routing
    // value-invalid batches through it reports payload problems (bad batchId,
    // edge-case event ids, >1000 events) as a generic 'unknown frame shape':
    // the verdict would depend on which deep field tripped rather than on the
    // frame's shape. Layering rule: shape = envelope + type discriminator;
    // content = dedicated per-type schema. Same bytes → same verdict, always.
    if (frame.type === 'event_batch') {
      this.track(
        state,
        this.onEventBatch(socket, state, parsed as EventBatch).catch((err: unknown) =>
          this.onHandlerFailure(socket, err),
        ),
      );
      return;
    }
    if (!schemaCheck(InboundFrameSchema, parsed)) {
      this.reject(socket, state, 'error.bad_frame', 'unknown frame shape', frame.messageId);
      return;
    }
    if (frame.type !== 'request') {
      this.reject(
        socket,
        state,
        'error.bad_frame',
        `unexpected post-handshake frame ${frame.type}`,
        frame.messageId,
      );
      return;
    }
    this.track(
      state,
      this.dispatch(socket, frame.requestId ?? '', frame.op ?? '', frame.params).catch(
        (err: unknown) => this.onHandlerFailure(socket, err),
      ),
    );
  }

  /**
   * events.batch path (brief D1 §3): the batch is validated against its
   * dedicated EventBatchSchema here — value-invalid batches are a protocol
   * violation answered with error.bad_frame 'malformed event_batch' followed
   * by close (deterministic: identical bytes always yield this identical
   * verdict). A valid batch goes through the router's registered ingest
   * handler; its counts are acked as an `event_batch_ack` frame echoing the
   * client's batchId. A handler refusal (disk-pressure backpressure,
   * unregistered handler, masked internal failure) is answered with an error
   * frame ECHOING THE BATCH'S messageId on the open connection: the
   * recorder correlates batch waiters by outgoing messageId, so a fresh id
   * would leave the waiter hanging until its reply timeout (10s stall per
   * refused batch under disk pressure, serializing the whole capture
   * pipeline behind it). A handler failure is answered with error.internal
   * and the connection stays open.
   */
  private async onEventBatch(
    socket: net.Socket,
    state: ConnectionState,
    parsed: EventBatch,
  ): Promise<void> {
    if (!schemaCheck(EventBatchSchema, parsed)) {
      this.reject(
        socket,
        state,
        'error.bad_frame',
        'malformed event_batch',
        isEnvelopeLike(parsed) ? parsed.messageId : undefined,
      );
      return;
    }
    const outcome = await this.options.router.dispatchBatch(parsed);
    if (socket.destroyed || !this.server) return;
    if (!outcome.ok) {
      this.send(
        socket,
        encodeFrame(errorFrame(parsed.messageId, outcome.error.code, outcome.error.message)),
      );
      return;
    }
    const ack = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: ulid(),
      type: 'event_batch_ack' as const,
      sentAt: Date.now(),
      batchId: parsed.batchId,
      ...outcome.counts,
    };
    if (!schemaCheck(EventBatchAckSchema, ack)) {
      throw new TypeError('constructed EventBatchAck failed its own schema');
    }
    this.send(socket, encodeFrame(ack));
  }

  /**
   * Exactly-one-reply guard: an unexpected rejection while producing an ack or
   * response must never leave a well-formed frame unanswered (the void'd
   * promise would otherwise swallow it as an unhandled rejection — no ack, no
   * error, silent loss). Replies error.internal while the connection can
   * still carry frames; never closes the connection.
   */
  private onHandlerFailure(socket: net.Socket, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.options.logger.log('error', 'ipc', 'frame handler failed', { errorMessage: message });
    if (!socket.destroyed && this.server) {
      this.send(socket, encodeFrame(errorFrame(ulid(), 'error.internal', message)));
    }
  }

  private onHandshakeFrame(socket: net.Socket, state: ConnectionState, parsed: unknown): void {
    if (!isEnvelopeLike(parsed) || !schemaCheck(ClientHelloSchema, parsed)) {
      this.reject(
        socket,
        state,
        'error.bad_frame',
        'first frame must be client_hello',
        isEnvelopeLike(parsed) ? parsed.messageId : undefined,
      );
      return;
    }
    const hello = parsed as unknown as ClientHello;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectProtocolVersion(socket, state, hello.messageId, hello.protocolVersion);
      return;
    }
    const serverHello = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: hello.messageId,
      type: 'server_hello' as const,
      sentAt: Date.now(),
      daemonVersion: this.options.daemonVersion,
      databaseSchemaVersion: this.options.databaseSchemaVersion,
    };
    if (!schemaCheck(ServerHelloSchema, serverHello)) {
      throw new TypeError('constructed ServerHello failed its own schema');
    }
    state.handshaken = true;
    this.send(socket, encodeFrame(serverHello));
    this.options.logger.log('info', 'ipc', 'handshake complete', { appVersion: hello.appVersion });
  }

  /**
   * §3.4: an incompatible major version rejects the connection — for EVERY
   * frame, not only the hello. Mirror of the handshake rejection path.
   */
  private rejectProtocolVersion(
    socket: net.Socket,
    state: ConnectionState,
    messageId: string,
    offered: number,
  ): void {
    this.options.logger.log('warn', 'ipc', 'protocol version rejected', {
      offered: String(offered),
    });
    // Same graceful teardown as reject(): the error frame must reach the wire
    // before close, even when more inbound bytes are in flight.
    void this.teardownAfterReject(
      socket,
      state,
      encodeFrame(
        errorFrame(messageId, 'error.protocol_version', `daemon speaks protocol ${PROTOCOL_VERSION}`),
      ),
    );
  }

  private async dispatch(
    socket: net.Socket,
    requestId: string,
    op: string,
    params: unknown,
  ): Promise<void> {
    const outcome = await this.options.router.dispatch(op, params);
    if (socket.destroyed || !this.server) return;
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: ulid(),
      sentAt: Date.now(),
      requestId,
    };
    const response =
      outcome.ok
        ? { ...base, type: 'response' as const, ok: true as const, result: outcome.result }
        : { ...base, type: 'response' as const, ok: false as const, error: outcome.error };
    const encoded = encodeFrame(response);
    if (encoded.length - 4 > CONSTANTS.maxFrameBytes) {
      this.send(
        socket,
        encodeFrame({
          ...base,
          type: 'response',
          ok: false,
          error: { code: 'error.internal', message: 'result exceeded max frame size' },
        }),
      );
      return;
    }
    this.send(socket, encoded);
  }

  /**
   * Rejects a protocol violation: error frame (echoing the client's messageId
   * when one was available and ULID-safe — see errorFrame) followed by close.
   *
   * The close is graceful: well-formed frames dispatched ahead of the
   * violation (coalesced into the same segment) get their replies written
   * first, then the error frame is flushed with a half-close so the client
   * actually reads it — destroying with unread inbound data would emit RST
   * and swallow the reply. A peer that never reads cannot wedge the server:
   * the linger timer tears the socket down regardless.
   */
  private reject(
    socket: net.Socket,
    state: ConnectionState,
    code: string,
    message: string,
    messageId?: string,
  ): void {
    void this.teardownAfterReject(
      socket,
      state,
      encodeFrame(errorFrame(messageId ?? ulid(), code, message)),
    );
  }

  /**
   * Registers an in-flight frame-handler promise on its connection so a
   * concurrent reject can drain it (bounded) before tearing the socket down.
   */
  private track(state: ConnectionState, task: Promise<void>): void {
    state.pending.add(task);
    void task.finally(() => {
      state.pending.delete(task);
    });
  }

  /**
   * Graceful post-reject teardown: stop consuming inbound immediately (the
   * connection is dead past the violation), give pre-violation dispatches a
   * bounded window to write their replies, then flush the error frame with
   * socket.end — FIN is ordered after the written data, unlike destroy which
   * discards unread inbound and triggers RST — and enforce the linger
   * deadline so a peer that neither reads nor closes cannot leak the socket.
   */
  private async teardownAfterReject(
    socket: net.Socket,
    state: ConnectionState,
    frame: Buffer,
  ): Promise<void> {
    state.alive = false;
    if (state.onData) {
      socket.removeListener('data', state.onData);
      state.onData = undefined;
    }
    state.chunks = [];
    state.buffered = 0;

    await settleWithin(state.pending, this.rejectDrainTimeoutMs);
    if (socket.destroyed) return;

    const linger = setTimeout(() => socket.destroy(), this.rejectLingerTimeoutMs);
    linger.unref();
    socket.once('close', () => clearTimeout(linger));
    socket.end(frame);
  }

  /**
   * Outbound size guard: no frame larger than CONSTANTS.maxFrameBytes ever
   * reaches the wire, whatever the caller. Callers that can degrade gracefully
   * (dispatch substitutes a compact error.internal) do so before getting here;
   * anything else oversized is dropped whole and logged.
   */
  private send(socket: net.Socket, data: Buffer): void {
    if (socket.destroyed || socket.writableEnded) return;
    if (data.length - 4 > CONSTANTS.maxFrameBytes) {
      this.options.logger.log('warn', 'ipc', 'outbound frame exceeded max frame size; dropped', {
        bytes: data.length - 4,
      });
      return;
    }
    socket.write(data);
    // Backpressure bound: a handshaken peer that never reads (hung app) must
    // not grow daemon memory without limit via buffered broadcasts/responses.
    // 4 MiB ≫ any legitimate burst (frame cap is 1 MiB); past it the peer is
    // misbehaving and the connection is torn down (close handler cleans up).
    if (socket.writableLength > IpcServer.maxWriteBufferBytes) {
      this.options.logger.log('warn', 'ipc', 'outbound buffer bound exceeded; destroying connection', {
        buffered: socket.writableLength,
      });
      socket.destroy();
    }
  }

  /**
   * Pushes a server-pushed event frame to every handshaken connection
   * (contracts §Protocol v1: queue_update, episodes_changed, …). The payload is
   * validated against its per-kind schema (ServerEventPayloads) before any
   * bytes are written; a mismatch is a programming error and throws.
   */
  broadcastEvent(kind: ServerEventKind, payload: Record<string, unknown>): void {
    if (!schemaCheck(ServerEventPayloads[kind], payload)) {
      throw new TypeError(`broadcast payload for ${kind} failed its payload schema`);
    }
    const frame = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: ulid(),
      type: 'event' as const,
      sentAt: Date.now(),
      kind,
      payload,
    };
    if (!schemaCheck(ServerEventFrameSchema, frame)) {
      throw new TypeError(`constructed ${kind} event failed its own schema`);
    }
    const data = encodeFrame(frame);
    for (const [socket, state] of this.connections) {
      if (state.handshaken) this.send(socket, data);
    }
  }
}

function isEnvelopeLike(value: unknown): value is { messageId: string; [key: string]: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.protocolVersion === 'number' &&
    typeof v.messageId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.sentAt === 'number'
  );
}
