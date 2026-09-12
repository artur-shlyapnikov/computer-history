import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ulid } from 'ulid';

import {
  PROTOCOL_VERSION,
  ClientHelloSchema,
  ServerHelloSchema,
  type ClientHello,
  type ServerHello,
} from '@computer-history/protocol';

/** Canonical ULID shape (Crockford base32, 26 chars) — mirrors the protocol schema. */
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

// Compiled-once schema checks shared by every connection.
const compiledChecks = new Map<object, (v: unknown) => boolean>();
export function schemaCheck(schema: object, value: unknown): boolean {
  let check = compiledChecks.get(schema);
  if (!check) {
    const compiled = TypeCompiler.Compile(schema as never);
    check = (v: unknown) => compiled.Check(v);
    compiledChecks.set(schema, check);
  }
  return check(value);
}

export function isEnvelopeLike(
  value: unknown,
): value is { messageId: string; [key: string]: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.protocolVersion === 'number' &&
    typeof v.messageId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.sentAt === 'number'
  );
}

/**
 * Outbound protocol-level error frames (handshake/bad frame rejections).
 *
 * The client's messageId is echoed only when it is itself a well-formed ULID;
 * attacker-controlled junk (arbitrary strings, oversized ids) is replaced by a
 * server-generated id so every outbound frame still satisfies the protocol's
 * Ulid-typed EnvelopeFields.messageId.
 */
export function errorFrame(messageId: string, code: string, message: string) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: ULID_PATTERN.test(messageId) ? messageId : ulid(),
    type: 'error' as const,
    sentAt: Date.now(),
    error: { code, message },
  };
}

export type HandshakeVerdict =
  | { readonly kind: 'accept'; readonly hello: ClientHello }
  | {
      readonly kind: 'reject';
      readonly code: 'error.bad_frame';
      readonly message: string;
      readonly messageId: string | undefined;
    }
  | {
      readonly kind: 'reject';
      readonly code: 'error.protocol_version';
      readonly message: string;
      readonly messageId: string;
      readonly offered: number;
    };

/**
 * Judges a pre-handshake frame without touching sockets: anything that is not
 * a well-formed ClientHello rejects, and an incompatible version rejects with
 * error.protocol_version instead of error.bad_frame.
 */
export function judgeHandshake(parsed: unknown): HandshakeVerdict {
  if (!isEnvelopeLike(parsed) || !schemaCheck(ClientHelloSchema, parsed)) {
    return {
      kind: 'reject',
      code: 'error.bad_frame',
      message: 'first frame must be client_hello',
      messageId: isEnvelopeLike(parsed) ? parsed.messageId : undefined,
    };
  }
  const hello = parsed as unknown as ClientHello;
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    return {
      kind: 'reject',
      code: 'error.protocol_version',
      message: `daemon speaks protocol ${PROTOCOL_VERSION}`,
      messageId: hello.messageId,
      offered: hello.protocolVersion,
    };
  }
  return { kind: 'accept', hello };
}

export function buildServerHello(
  hello: ClientHello,
  daemonVersion: string,
  databaseSchemaVersion: number,
): ServerHello {
  const serverHello = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: hello.messageId,
    type: 'server_hello' as const,
    sentAt: Date.now(),
    daemonVersion,
    databaseSchemaVersion,
  };
  if (!schemaCheck(ServerHelloSchema, serverHello)) {
    throw new TypeError('constructed ServerHello failed its own schema');
  }
  return serverHello;
}
