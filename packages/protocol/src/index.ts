import { type Static, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';

/**
 * TypeCompiler cache: compiling a schema is expensive; validators are created
 * once per schema and reused across frames.
 */
const compiledValidators = new WeakMap<TSchema, (value: unknown) => boolean>();

function compiledCheck(schema: TSchema): (value: unknown) => boolean {
  const cached = compiledValidators.get(schema);
  if (cached) return cached;
  const compiled = TypeCompiler.Compile(schema);
  const check = (value: unknown) => compiled.Check(value);
  compiledValidators.set(schema, check);
  return check;
}

/** Type guard preserving narrowing to the schema's static type. */
export function isFrame<T extends TSchema>(
  schema: T,
  value: unknown,
): value is Static<T> {
  return compiledCheck(schema)(value);
}

/** Collect validation error paths/messages (empty list when valid). */
export function frameErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema as never, value)].map(
    (e: { path?: string; message?: string }) =>
      `${e.path || '/'} ${e.message ?? 'failed validation'}`,
  );
}

/** Assert helper for daemon internals and tests; throws TypeError with first errors. */
export function assertFrame<T extends TSchema>(
  schema: T,
  value: unknown,
): asserts value is Static<T> {
  if (!compiledCheck(schema)(value)) {
    const errors = frameErrors(schema, value);
    throw new TypeError(`frame validation failed: ${errors.slice(0, 5).join('; ')}`);
  }
}

export * from './events.js';
export * from './ipc.js';
export * from './domain.js';
