import { describe, expect, it } from 'vitest';

import {
  coalesceEvents,
  type CoalescedStep,
} from '../src/processing/event-coalescer.js';
import {
  clickEvent,
  focusEvent,
  makeActivityEvent,
  SAFARI,
  scrollEvent,
  SLACK,
  T0,
  typeEvent,
} from './helpers/events.js';

/**
 * Decision-table + boundary-value pins over the five gap-bounded merge rules
 * of coalesceEvents (contracts §Numeric constants): TEXT_EDIT/TYPING 10 s,
 * SCROLL 3 s, FOCUS_NOISE 1 s, CLICK_FOCUS_COLLAPSE 500 ms. Pure function —
 * no clocks, no mocks.
 */

function single(overrides: Parameters<typeof makeActivityEvent>[0]) {
  const steps: CoalescedStep[] = coalesceEvents([makeActivityEvent(overrides)]);
  return steps;
}

describe('edit_text merges (TEXT_EDIT_GAP_MS = 10_000)', () => {
  it('merges at exactly the bound', () => {
    const second = typeEvent({ observedAt: T0 + 10_000, content: 'beta' });
    const first = typeEvent({ content: 'alpha' });
    const steps = coalesceEvents([first, second]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'edit_text',
      eventCount: 2,
      startedAtMs: T0,
      endedAtMs: T0 + 10_000,
      lastEventId: second.id,
      firstEventId: first.id,
      text: 'beta',
    });
  });

  it('splits one millisecond past the bound', () => {
    const steps = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ observedAt: T0 + 10_001, content: 'beta' }),
    ]);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.action).toBe('edit_text');
  });

  it('null content never overwrites merged text; last non-null wins', () => {
    const burst = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ observedAt: T0 + 100, content: null }),
      typeEvent({ observedAt: T0 + 200, content: 'gamma' }),
    ]);
    expect(burst).toHaveLength(1);
    expect(burst[0]!.text).toBe('gamma');

    // Control: a burst ENDING on null keeps the previous non-null text.
    const control = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ observedAt: T0 + 100, content: null }),
    ]);
    expect(control).toHaveLength(1);
    expect(control[0]!.text).toBe('alpha');
  });

  it('a window-title change blocks an edit merge', () => {
    const steps = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ observedAt: T0 + 100, content: 'beta', window: { title: 'Other' } }),
    ]);
    expect(steps).toHaveLength(2);
  });

  it('an app boundary blocks every merge', () => {
    const edits = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ observedAt: T0 + 100, content: 'beta', app: { bundleId: SLACK } }),
    ]);
    expect(edits).toHaveLength(2);

    const scrolls = coalesceEvents([
      scrollEvent(),
      scrollEvent({ observedAt: T0 + 100, app: { bundleId: SLACK } }),
    ]);
    expect(scrolls).toHaveLength(2);
  });

  it('a fresh event alone yields one edit step with identity fields', () => {
    expect(single({})).toHaveLength(1);
  });
});

describe('typing bursts (TYPING_GAP_MS = 10_000)', () => {
  it('merge at the bound and carry duration', () => {
    const steps = coalesceEvents([
      typeEvent({ action: 'typing_activity' }),
      typeEvent({ action: 'typing_activity', observedAt: T0 + 10_000 }),
      typeEvent({ action: 'typing_activity', observedAt: T0 + 20_000 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'type',
      eventCount: 3,
      startedAtMs: T0,
      endedAtMs: T0 + 20_000,
      text: null,
    });
  });

  it('split one millisecond past the bound', () => {
    const steps = coalesceEvents([
      typeEvent({ action: 'typing_activity' }),
      typeEvent({ action: 'typing_activity', observedAt: T0 + 10_001 }),
    ]);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.action).toBe('type');
  });

  it('never glue onto an edit_text step (strict adjacency)', () => {
    const steps = coalesceEvents([
      typeEvent({ content: 'alpha' }),
      typeEvent({ action: 'typing_activity', observedAt: T0 + 100 }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.action)).toEqual(['edit_text', 'type']);
  });
});

describe('scroll merges (SCROLL_GAP_MS = 3_000)', () => {
  it('merge at exactly the bound', () => {
    const steps = coalesceEvents([scrollEvent(), scrollEvent({ observedAt: T0 + 3_000 })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'scroll',
      eventCount: 2,
      endedAtMs: T0 + 3_000,
    });
  });

  it('split at 3_001 ms', () => {
    const steps = coalesceEvents([scrollEvent(), scrollEvent({ observedAt: T0 + 3_001 })]);
    expect(steps).toHaveLength(2);
  });

  it('split on a window-title change even inside the gap', () => {
    const steps = coalesceEvents([
      scrollEvent(),
      scrollEvent({ observedAt: T0 + 100, window: { title: 'Other' } }),
    ]);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.action).toBe('scroll');
  });
});

describe('click+focus collapse (CLICK_FOCUS_COLLAPSE_MS = 500)', () => {
  it('collapses inside 500 ms into one click step carrying both events', () => {
    const focus = focusEvent('t1', { observedAt: T0 + 499 });
    const steps = coalesceEvents([clickEvent('t1'), focus]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'click',
      eventCount: 2,
      startedAtMs: T0,
      endedAtMs: T0 + 499,
      lastEventId: focus.id,
    });
  });

  it('keeps two steps (click, focus) at 501 ms', () => {
    const steps = coalesceEvents([clickEvent('t1'), focusEvent('t1', { observedAt: T0 + 501 })]);
    expect(steps.map((s) => s.action)).toEqual(['click', 'focus']);
  });
});

describe('focus noise drop (FOCUS_NOISE_MS = 1_000)', () => {
  it('drops a repeat at exactly 1_000 ms keeping the FIRST event bounds', () => {
    const first = focusEvent('t1');
    const steps = coalesceEvents([first, focusEvent('t1', { observedAt: T0 + 1_000 })]);
    expect(steps).toHaveLength(1);
    // The drop path emits nothing: survivor keeps the first event's identity/bounds.
    expect(steps[0]).toMatchObject({
      action: 'focus',
      startedAtMs: T0,
      endedAtMs: T0,
      firstEventId: first.id,
      lastEventId: first.id,
      eventCount: 1,
    });
  });

  it('keeps a repeat at 1_001 ms as its own step', () => {
    const steps = coalesceEvents([focusEvent('t1'), focusEvent('t1', { observedAt: T0 + 1_001 })]);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.action === 'focus')).toBe(true);
  });
});

describe('app_focus', () => {
  it('never merges, not even with itself in the same app', () => {
    const steps = coalesceEvents([
      makeActivityEvent({ action: 'app_focus', app: { bundleId: SAFARI } }),
      makeActivityEvent({ action: 'app_focus', app: { bundleId: SAFARI }, observedAt: T0 + 1 }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.action === 'switch_app')).toBe(true);
  });
});
