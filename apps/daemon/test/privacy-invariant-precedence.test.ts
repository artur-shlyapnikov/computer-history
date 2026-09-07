import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';

import { makeActivityEvent } from './helpers/events.js';
import { CONSTANTS } from '../src/config.js';
import { privacyRejection } from '../src/ingest/validation.js';

/**
 * Branch PRECEDENCE of privacyRejection (validation.ts): every branch is
 * individually pinned elsewhere; this file pins which SINGLE reason wins when
 * several invariants fire simultaneously — diagnostics/log dashboards group
 * by reason, so silently reordering guards would change reported causes.
 * Each case isolates one adjacent guard pair.
 */

function eventWith(overrides: Partial<ActivityEvent>): ActivityEvent {
  return makeActivityEvent(overrides);
}

describe('privacyRejection branch precedence', () => {
  it("reports tombstone_with_metadata when metadata and smuggled content both violate — metadata check precedes content checks", () => {
    const reason = privacyRejection(
      eventWith({
        contentPolicy: 'excluded_app',
        window: { title: 'Accounts — Bank' },
        content: 'smuggled',
      }),
    );
    expect(reason).toBe('tombstone_with_metadata');
  });

  it('reports typing_activity_with_content before the oversize check can win', () => {
    const reason = privacyRejection(
      eventWith({
        source: 'input',
        action: 'typing_activity',
        contentPolicy: 'allow',
        content: 'x'.repeat(3000),
      }),
    );
    expect(reason).toBe('typing_activity_with_content');
  });

  it('reports secure_field_with_content for a claimed redacted_secure_field even with an innocent plain target and oversize content', () => {
    const reason = privacyRejection(
      eventWith({
        contentPolicy: 'redacted_secure_field',
        target: { role: 'AXTextArea', identifier: 'body' },
        content: 'x'.repeat(CONSTANTS.maxContentChars + 100),
      }),
    );
    expect(reason).toBe('secure_field_with_content');
  });

  it('reports secure_field_with_content for an AXSecureTextField target under an allow policy before the oversize check', () => {
    const reason = privacyRejection(
      eventWith({
        contentPolicy: 'allow',
        target: { role: 'AXTextField', subrole: 'AXSecureTextField' },
        content: 'x'.repeat(3000),
      }),
    );
    expect(reason).toBe('secure_field_with_content');
  });

  it('accepts exactly CONSTANTS.maxContentChars of plain content and rejects only one char more', () => {
    const boundary = eventWith({
      contentPolicy: 'allow',
      target: { role: 'AXTextArea', identifier: 'body' },
      content: 'x'.repeat(CONSTANTS.maxContentChars),
    });
    expect(privacyRejection(boundary)).toBeNull();

    const oversize = eventWith({
      ...boundary,
      content: 'x'.repeat(CONSTANTS.maxContentChars + 1),
    });
    expect(privacyRejection(oversize)).toBe('content_oversize');
  });
});
