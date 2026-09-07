import type { ActivityEvent, ContentPolicy } from '@computer-history/protocol';

import { CONSTANTS } from '../config.js';

/**
 * Machine-readable rejection reasons. Only ever used in counters/logs — never
 * carries event content or titles.
 */
export type RejectionReason =
  | 'schema_invalid'
  | 'secure_field_with_content'
  | 'typing_activity_with_content'
  | 'content_oversize'
  | 'redacted_policy_with_content'
  | 'tombstone_with_metadata';

/**
 * Policies that assert the recorder DROPPED the content entirely before IPC.
 * `redacted_secret_pattern` is deliberately absent: its scrubbed `[REDACTED]`
 * text is the documented wire shape.
 */
const POLICY_DROPS_CONTENT: Partial<Record<ContentPolicy, true>> = {
  metadata_only: true,
  redacted_sensitive_target: true,
  redacted_oversize: true,
  excluded_app: true,
};

/**
 * Daemon-side privacy invariants (brief-m1 §D1 item 2, spec §3.11 «Privacy
 * policy enforced дважды»). Pure: event in → reason out, null when acceptable.
 * Assumes the wire schema (incl. the contentPolicy enum, invariant d) already
 * validated structurally; callers that receive untyped input must run the
 * TypeBox check themselves and record `schema_invalid`.
 *
 *  (a) contentPolicy=redacted_secure_field  ⇒ content MUST be null
 *      (a′) AXSecureTextField target with any content is equally rejected,
 *           independent of what the recorder claimed
 *      (a″) every content-dropping policy (see POLICY_DROPS_CONTENT) must
 *           arrive with null content — anything else is a compromised/buggy
 *           recorder smuggling secrets past its PrivacyFilter
 *      (a‴) contentPolicy=excluded_app is a fact-only tombstone (spec §3.7,
 *           PrivacyFilter.tombstone()): window/target must be absent entirely
 *  (b) action=typing_activity               ⇒ content MUST be null
 *  (c) content longer than 2048 chars       ⇒ reject
 */
export function privacyRejection(event: ActivityEvent): RejectionReason | null {
  if (
    event.contentPolicy === 'excluded_app' &&
    (event.window !== undefined || event.target !== undefined)
  ) {
    return 'tombstone_with_metadata';
  }
  const content = event.content;
  if (content === undefined || content === null) return null;
  if (event.contentPolicy === 'redacted_secure_field') return 'secure_field_with_content';
  if (POLICY_DROPS_CONTENT[event.contentPolicy]) return 'redacted_policy_with_content';
  if (event.action === 'typing_activity') return 'typing_activity_with_content';
  if (event.target?.subrole === 'AXSecureTextField') return 'secure_field_with_content';
  if (content.length > CONSTANTS.maxContentChars) return 'content_oversize';
  return null;
}
