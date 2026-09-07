import { Type } from '@sinclair/typebox';

/** Unix epoch milliseconds, pinned to exactly-decodable integers (W5). */
export const EpochMs = Type.Integer({ minimum: 0, maximum: 9007199254740991 });

/**
 * Upper bound for Integer count/timestamp fields flowing daemon→app: 2^53−1,
 * the largest integer Foundation's JSONDecoder provably decodes exactly. TS
 * rejects anything larger so the wire can never carry a value Swift would
 * silently corrupt (W5). Sign is deliberately unclamped (schema does not
 * clamp signs); only magnitude is pinned.
 */
export const DaemonSafeInt = Type.Integer({ maximum: 9007199254740991 });
