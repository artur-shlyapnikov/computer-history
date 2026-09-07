import { type TSchema } from '@sinclair/typebox';

import {
  Ops,
  frameErrors,
  type ErrorCode,
  type EventBatch,
  type OpName,
  type OpParams,
  type OpResult,
} from '@computer-history/protocol';

export type OkResult = { ok: true; result: unknown };
export type ErrResult = {
  ok: false;
  error: {
    code:
      | 'error.unknown_op'
      | 'error.invalid_params'
      | 'error.not_implemented'
      | 'error.not_found'
      | 'error.internal'
      | 'error.disk_pressure';
    message: string;
  };
};
export type DispatchOutcome = OkResult | ErrResult;
export type BatchAckCounts = { accepted: number; duplicates: number; rejected: number };
export type BatchDispatchOutcome =
  | { ok: true; counts: BatchAckCounts }
  | {
      ok: false;
      error: { code: 'error.internal' | 'error.disk_pressure'; message: string };
    };

/** Handler for `event_batch` frames (the events.batch path). */
export type BatchHandler = (batch: EventBatch) => BatchAckCounts | Promise<BatchAckCounts>;
/** Handler-thrown error carrying a wire error code (e.g. error.not_found). */
export class OpError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      | 'error.not_found'
      | 'error.invalid_params'
      | 'error.internal'
      | 'error.disk_pressure'
    >,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Typed handler for one pinned op. Registration ties the handler to its op
 * name: the Router validates params against `Ops[op].params` BEFORE invoking
 * it, and validates the returned value against `Ops[op].result` AFTER it —
 * a contract-invalid result never reaches the wire (logged server-side,
 * answered error.internal). Handlers implement application behavior only;
 * they never re-import wire schemas or self-check frames.
 */
export type OpHandler<K extends OpName = OpName> = (
  params: OpParams<K>,
) => OpResult<K> | Promise<OpResult<K>>;

/**
 * Type-erased storage form of `OpHandler<K>`. Any concrete handler is
 * assignable here because the parameter position is contravariant (`never`
 * satisfies every params type); dispatch re-narrows through the same
 * registry entry it validated against.
 */
type ErasedOpHandler = (params: never) => unknown;


/**
 * Typed op dispatch: validates BOTH wire sides centrally against the pinned
 * `Ops` registry entry — params before the handler runs, result before the
 * answer is framed. Ops without handlers answer error.not_implemented
 * (later milestones fill them in); error.not_found stays reserved for
 * genuinely absent resources (unknown episode ids, …).
 */
export class Router {
  private readonly handlers = new Map<OpName, ErasedOpHandler>();
  private readonly logger: { log(level: string, scope: string, message: string, fields?: Record<string, unknown>): void };
  private batchHandler: BatchHandler | null = null;

  constructor(logger: Router['logger']) {
    this.logger = logger;
  }

  /**
   * Duplicate registration is a wiring bug (two ops files claiming one op
   * silently shadow each other, round-25): fail fast instead.
   */
  register<K extends OpName>(op: K, handler: OpHandler<K>): void {
    if (this.handlers.has(op)) {
      throw new Error(`op registered twice: ${op}`);
    }
    this.handlers.set(op, handler);
  }

  /**
   * Wires the events.batch path end-to-end: an `event_batch` frame validated by
   * the IPC server is dispatched here to the registered handler (the ingestor)
   * and its counts become the `event_batch_ack` frame.
   */
  registerBatch(handler: BatchHandler): void {
    this.batchHandler = handler;
  }

  async dispatchBatch(batch: EventBatch): Promise<BatchDispatchOutcome> {
    const handler = this.batchHandler;
    if (!handler) {
      return { ok: false, error: { code: 'error.internal', message: 'no events.batch handler registered' } };
    }
    try {
      return { ok: true, counts: await handler(batch) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OpError && err.code === 'error.disk_pressure') {
        this.logger.log('warn', 'router', 'events.batch refused (disk pressure)', { batchId: batch.batchId });
        return { ok: false, error: { code: 'error.disk_pressure', message } };
      }
      this.logger.log('error', 'router', 'events.batch failed', {
        batchId: batch.batchId,
        errorMessage: message,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      });
      // Same masking contract as dispatch: non-disk-pressure failures carry
      // internal detail (SQL, filesystem paths). Log the full error
      // server-side; peers only get a generic message.
      return { ok: false, error: { code: 'error.internal', message: 'internal error' } };
    }
  }

  async dispatch(op: string, params: unknown): Promise<DispatchOutcome> {
    const opSchema = (Ops as unknown as Record<
      string,
      { params: TSchema; result: TSchema } | undefined
    >)[op];
    if (!opSchema) {
      // Not a pinned op name at all — contracts §Protocol v1 routes this to
      // error.not_found (not_found stays reserved for absent resources, and an
      // unknown op name is exactly that). The echo is bounded: op is
      // client-controlled and unbounded, and the reply must stay under
      // maxFrameBytes so the exactly-one-reply policy holds.
      const label = op.length > 64 ? `${op.slice(0, 64)}…(${op.length} chars)` : op;
      return { ok: false, error: { code: 'error.not_found', message: `unknown op ${label}` } };
    }
    const paramErrors = frameErrors(opSchema.params, params ?? {});
    if (paramErrors.length > 0) {
      return {
        ok: false,
        error: { code: 'error.invalid_params', message: `invalid params for ${op}: ${paramErrors.slice(0, 3).join('; ')}` },
      };
    }
    const handler = this.handlers.get(op as OpName);
    if (!handler) {
      return { ok: false, error: { code: 'error.not_implemented', message: `op ${op} arrives in a later milestone` } };
    }
    try {
      // Params were validated against `Ops[op].params` above, and the
      // stored callable was registered under exactly this op name — the
      // erased signature is safe to invoke with them.
      const result = await (handler as (params: unknown) => unknown)(params ?? {});
      const resultErrors = frameErrors(opSchema.result, result);
      if (resultErrors.length > 0) {
        // The daemon must never emit a success frame that fails its own
        // contract: log the offending paths server-side and mask to the
        // generic internal failure (same contract as a thrown error).
        this.logger.log('error', 'router', 'op handler returned contract-invalid result', {
          op,
          errors: resultErrors.slice(0, 3),
        });
        return { ok: false, error: { code: 'error.internal', message: 'internal error' } };
      }
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An OpError carrying 'error.internal' would forward its raw message
      // (e.g. `new OpError('error.internal', err.message)` at a throw site) —
      // same leak class as a bare Error, so it gets identical masking: full
      // detail logged server-side, generic message on the wire.
      if (err instanceof OpError && err.code !== 'error.internal') {
        this.logger.log('info', 'router', 'op rejected', { op, code: err.code, errorMessage: message });
        return { ok: false, error: { code: err.code, message } };
      }
      this.logger.log('error', 'router', 'op failed', {
        op,
        errorMessage: message,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      });
      // Non-OpError failures carry internal detail (SQL, filesystem paths).
      // Log the full error server-side; peers only get a generic message.
      return {
        ok: false,
        error: {
          code: 'error.internal',
          message: 'internal error',
        },
      };
    }
  }
}
