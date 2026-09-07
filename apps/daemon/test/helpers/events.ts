import { ulid } from 'ulid';

import type { ActivityEvent } from '@computer-history/protocol';

/** Shared base instant for coalescer/gap tests: 2026-01-01T10:00:00Z. */
export const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

export const SAFARI = 'com.apple.Safari';
export const SLACK = 'rebel.slack';

/** Valid ActivityEvent with a fresh ULID id and workspace defaults. */
export function makeActivityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ulid(),
    observedAt: T0,
    source: 'workspace',
    app: { bundleId: SAFARI },
    action: 'text_change',
    contentPolicy: 'allow',
    ...overrides,
  };
}

/** Text edit in a titled window on a body textarea (the canonical edit target). */
export function typeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeActivityEvent({
    window: { title: 'Doc — Safari' },
    target: { role: 'AXTextArea', identifier: 'body' },
    ...overrides,
  });
}

/** Scroll in a document window. */
export function scrollEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeActivityEvent({
    action: 'scroll',
    window: { title: 'Doc — Safari' },
    ...overrides,
  });
}

/** Focus change on a named control; `identifier` feeds click/focus matching. */
export function focusEvent(identifier = 't1', overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeActivityEvent({
    action: 'focus_change',
    target: { role: 'AXButton', identifier },
    ...overrides,
  });
}

/** Click on a named control; pairs with focusEvent for the collapse rule. */
export function clickEvent(identifier = 't1', overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeActivityEvent({
    action: 'click',
    target: { role: 'AXButton', identifier },
    ...overrides,
  });
}

/** Convenience pair builder for the click+focus collapse rule. */
export function focusPair(gapMs: number, identifier = 't1'): [ActivityEvent, ActivityEvent] {
  return [clickEvent(identifier), focusEvent(identifier, { observedAt: T0 + gapMs })];
}
