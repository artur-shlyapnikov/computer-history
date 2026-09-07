import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from '@computer-history/protocol';

import { coalesceEvents, compareEvents, STEP_ACTIONS } from '../src/processing/event-coalescer.js';

let seq = 0;
function ev(overrides: Partial<ActivityEvent> & { observedAt: number }): ActivityEvent {
  seq += 1;
  return {
    id: `event-${String(seq).padStart(6, '0')}`,
    source: 'accessibility',
    app: { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 },
    window: { title: 'Doc — Safari' },
    action: 'text_change',
    target: { role: 'AXTextArea', identifier: 'body' },
    contentPolicy: 'allow',
    ...overrides,
  };
}

const SAFARI = 'com.apple.Safari';
const SLACK = 'rebel.slack';

interface ExpectedStep {
  action: string;
  appBundleId: string;
  appName: string | null;
  targetRole: string | null;
  target: string | null;
  text: string | null;
  startedAtMs: number;
  endedAtMs: number;
  eventCount: number;
}

function stepOf(over: Partial<ExpectedStep> & { action: string; startedAtMs: number; endedAtMs: number }): ExpectedStep {
  return {
    appBundleId: SAFARI,
    appName: 'Safari',
    targetRole: 'AXTextArea',
    target: null,
    text: null,
    eventCount: 1,
    ...over,
  };
}

/** Table-driven golden scenarios: one row per spec §3.12 rule or boundary. */
const goldenScenarios: { name: string; events: ActivityEvent[]; expected: ExpectedStep[] }[] = [
  {
    name: 'text_edit: same app+window+identifier with gap ≤10s merges to one step, last non-null text wins',
    events: [
      ev({ observedAt: 0, content: 'first draft' }),
      ev({ observedAt: 5_000, content: null }),
      ev({ observedAt: 9_999, content: 'second draft' }),
      ev({ observedAt: 10_000, content: 'final text' }),
    ],
    expected: [
      stepOf({
        action: 'edit_text',
        target: 'body',
        text: 'final text',
        startedAtMs: 0,
        endedAtMs: 10_000,
        eventCount: 4,
      }),
    ],
  },
  {
    name: 'text_edit: gap of 10_001ms violates the 10s boundary → two steps',
    events: [ev({ observedAt: 0, content: 'a' }), ev({ observedAt: 10_001, content: 'b' })],
    expected: [
      stepOf({ action: 'edit_text', target: 'body', text: 'a', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'edit_text', target: 'body', text: 'b', startedAtMs: 10_001, endedAtMs: 10_001 }),
    ],
  },
  {
    name: 'text_edit: different window title breaks the merge key',
    events: [
      ev({ observedAt: 0, content: 'a', window: { title: 'One' } }),
      ev({ observedAt: 1_000, content: 'b', window: { title: 'Two' } }),
    ],
    expected: [
      stepOf({ action: 'edit_text', target: 'body', text: 'a', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'edit_text', target: 'body', text: 'b', startedAtMs: 1_000, endedAtMs: 1_000 }),
    ],
  },
  {
    name: 'typing: consecutive typing_activity merges into one type step with duration, never text',
    events: Array.from({ length: 10 }, (_, i) => ev({ observedAt: i * 1_000, action: 'typing_activity', content: undefined })),
    expected: [
      stepOf({ action: 'type', target: 'body', text: null, startedAtMs: 0, endedAtMs: 9_000, eventCount: 10 }),
    ],
  },
  {
    name: 'typing: an intervening scroll breaks the sequence → two type steps',
    events: [
      ev({ observedAt: 0, action: 'typing_activity' }),
      ev({ observedAt: 1_000, action: 'typing_activity' }),
      ev({ observedAt: 2_000, action: 'scroll', target: { role: 'AXScrollArea' } }),
      ev({ observedAt: 3_000, action: 'typing_activity' }),
    ],
    expected: [
      stepOf({ action: 'type', target: 'body', startedAtMs: 0, endedAtMs: 1_000, eventCount: 2 }),
      stepOf({ action: 'scroll', targetRole: 'AXScrollArea', target: 'AXScrollArea', startedAtMs: 2_000, endedAtMs: 2_000 }),
      stepOf({ action: 'type', target: 'body', startedAtMs: 3_000, endedAtMs: 3_000 }),
    ],
  },
  {
    name: 'typing: gap of exactly 10_000ms is inside the merge boundary',
    events: [
      ev({ observedAt: 0, action: 'typing_activity' }),
      ev({ observedAt: 10_000, action: 'typing_activity' }),
    ],
    expected: [
      stepOf({ action: 'type', target: 'body', startedAtMs: 0, endedAtMs: 10_000, eventCount: 2 }),
    ],
  },
  {
    name: 'typing: two typing events 10s+ apart stay separate steps',
    events: [
      ev({ observedAt: 0, action: 'typing_activity' }),
      ev({ observedAt: 10_001, action: 'typing_activity' }),
      ev({ observedAt: 20_002, action: 'typing_activity' }),
    ],
    expected: [
      stepOf({ action: 'type', target: 'body', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'type', target: 'body', startedAtMs: 10_001, endedAtMs: 10_001 }),
      stepOf({ action: 'type', target: 'body', startedAtMs: 20_002, endedAtMs: 20_002 }),
    ],
  },
  {
    name: 'scroll: same app/window with gap ≤3s merges; exactly 3000ms is inside the boundary',
    events: [
      ev({ observedAt: 0, action: 'scroll', target: { role: 'AXScrollArea' } }),
      ev({ observedAt: 3_000, action: 'scroll', target: { role: 'AXScrollArea' } }),
    ],
    expected: [
      stepOf({ action: 'scroll', targetRole: 'AXScrollArea', target: 'AXScrollArea', startedAtMs: 0, endedAtMs: 3_000, eventCount: 2 }),
    ],
  },
  {
    name: 'scroll: gap of 3001ms violates the 3s boundary → two steps',
    events: [
      ev({ observedAt: 0, action: 'scroll', target: { role: 'AXScrollArea' } }),
      ev({ observedAt: 3_001, action: 'scroll', target: { role: 'AXScrollArea' } }),
    ],
    expected: [
      stepOf({ action: 'scroll', targetRole: 'AXScrollArea', target: 'AXScrollArea', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'scroll', targetRole: 'AXScrollArea', target: 'AXScrollArea', startedAtMs: 3_001, endedAtMs: 3_001 }),
    ],
  },
  {
    name: 'focus noise: repeated focus_change on same target within exactly 1000ms is dropped',
    events: [
      ev({ observedAt: 0, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
      ev({ observedAt: 1_000, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
    ],
    expected: [
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Send', startedAtMs: 0, endedAtMs: 0 }),
    ],
  },
  {
    name: 'focus noise: gap of 1001ms violates the 1s boundary → two focus steps',
    events: [
      ev({ observedAt: 0, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
      ev({ observedAt: 1_001, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
    ],
    expected: [
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Send', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Send', startedAtMs: 1_001, endedAtMs: 1_001 }),
    ],
  },
  {
    name: 'focus noise: a different target within 1000ms is kept',
    events: [
      ev({ observedAt: 0, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
      ev({ observedAt: 500, action: 'focus_change', target: { role: 'AXButton', label: 'Cancel' } }),
    ],
    expected: [
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Send', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Cancel', startedAtMs: 500, endedAtMs: 500 }),
    ],
  },
  {
    name: 'click+focus: focus_change on same control within exactly 500ms collapses into the click step',
    events: [
      ev({ observedAt: 0, action: 'click', target: { role: 'AXButton', label: 'Send' } }),
      ev({ observedAt: 500, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
    ],
    expected: [
      stepOf({ action: 'click', targetRole: 'AXButton', target: 'Send', startedAtMs: 0, endedAtMs: 500, eventCount: 2 }),
    ],
  },
  {
    name: 'click+focus: gap of 501ms violates the 500ms boundary → click and focus steps',
    events: [
      ev({ observedAt: 0, action: 'click', target: { role: 'AXButton', label: 'Send' } }),
      ev({ observedAt: 501, action: 'focus_change', target: { role: 'AXButton', label: 'Send' } }),
    ],
    expected: [
      stepOf({ action: 'click', targetRole: 'AXButton', target: 'Send', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'focus', targetRole: 'AXButton', target: 'Send', startedAtMs: 501, endedAtMs: 501 }),
    ],
  },
  {
    name: 'app switches: never coalesce across app boundaries even with identical window/target keys',
    events: [
      ev({ observedAt: 0, app: { bundleId: SAFARI, name: 'Safari' }, content: 'a' }),
      ev({ observedAt: 1_000, app: { bundleId: SLACK, name: 'Slack' }, content: 'b' }),
      ev({ observedAt: 2_000, app: { bundleId: SAFARI, name: 'Safari' }, content: 'c' }),
    ],
    expected: [
      stepOf({ action: 'edit_text', target: 'body', text: 'a', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({
        action: 'edit_text',
        appBundleId: SLACK,
        appName: 'Slack',
        target: 'body',
        text: 'b',
        startedAtMs: 1_000,
        endedAtMs: 1_000,
      }),
      stepOf({ action: 'edit_text', target: 'body', text: 'c', startedAtMs: 2_000, endedAtMs: 2_000 }),
    ],
  },
  {
    name: 'app switches: app_focus maps to switch_app and never merges with itself',
    events: [
      ev({ observedAt: 0, action: 'app_focus', app: { bundleId: SAFARI, name: 'Safari' }, target: { role: 'AXApplication', label: 'Safari' } }),
      ev({ observedAt: 200, action: 'app_focus', app: { bundleId: SAFARI, name: 'Safari' }, target: { role: 'AXApplication', label: 'Safari' } }),
    ],
    expected: [
      stepOf({ action: 'switch_app', targetRole: 'AXApplication', target: 'Safari', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'switch_app', targetRole: 'AXApplication', target: 'Safari', startedAtMs: 200, endedAtMs: 200 }),
    ],
  },
  {
    name: 'shortcut and window_change pass through as their own steps',
    events: [
      ev({ observedAt: 0, action: 'shortcut', target: { label: '⌘S' } }),
      ev({ observedAt: 100, action: 'window_change', window: { title: 'Renamed' }, target: undefined }),
    ],
    expected: [
      stepOf({ action: 'shortcut', targetRole: null, target: '⌘S', startedAtMs: 0, endedAtMs: 0 }),
      stepOf({ action: 'window_change', targetRole: null, target: null, startedAtMs: 100, endedAtMs: 100 }),
    ],
  },
];

describe('EventCoalescer golden scenarios (spec §3.12, contracts numbers)', () => {
  for (const scenario of goldenScenarios) {
    it(scenario.name, () => {
      const steps = coalesceEvents(scenario.events).map((step) => {
        const rest: Record<string, unknown> = { ...step };
        delete rest.firstEventId;
        delete rest.lastEventId;
        return rest;
      });
      expect(steps).toEqual(scenario.expected);
    });
  }

  it('emits only the pinned step action vocabulary', () => {
    expect(STEP_ACTIONS).toEqual([
      'switch_app',
      'edit_text',
      'type',
      'scroll',
      'click',
      'focus',
      'shortcut',
      'window_change',
    ]);
    const all = coalesceEvents(goldenScenarios.flatMap((s) => s.events));
    for (const step of all) {
      expect(STEP_ACTIONS).toContain(step.action);
    }
  });

  it('sorts out-of-order input into the canonical (observedAt, monotonicNs, id) order', () => {
    const a = ev({ id: 'event-000001', observedAt: 1_000, monotonicNs: 5 });
    const b = ev({ id: 'event-000002', observedAt: 500, monotonicNs: 9 });
    const c = ev({ id: 'event-000003', observedAt: 1_000, monotonicNs: 2 });
    const steps = coalesceEvents([a, b, c]);
    // Sorted: b (500), c (1000/mono2), a (1000/mono5) — three text edits at
    // distinct keys? All share keys, gaps: c−b=500 ≤10s merges, a−c=0 merges.
    expect(steps).toHaveLength(1);
    expect(steps[0]!.startedAtMs).toBe(500);
    expect(steps[0]!.eventCount).toBe(3);
  });

  it('is pure: same input always produces the identical output', () => {
    const events = goldenScenarios[0]!.events;
    const first = coalesceEvents(events);
    const second = coalesceEvents(events);
    expect(second).toEqual(first);
    // And the input is never mutated.
    expect(events[0]!.observedAt).toBe(0);
  });

  it('handles an empty stream', () => {
    expect(coalesceEvents([])).toEqual([]);
  });
});

describe('compareEvents', () => {
  it('orders by observedAt, then monotonicNs, then id', () => {
    const low = ev({ id: 'event-000001', observedAt: 1, monotonicNs: 1 });
    const high = ev({ id: 'event-000002', observedAt: 2, monotonicNs: 0 });
    expect(compareEvents(low, high)).toBeLessThan(0);

    const monoLow = ev({ id: 'event-000003', observedAt: 1, monotonicNs: 1 });
    const monoHigh = ev({ id: 'event-000004', observedAt: 1, monotonicNs: 2 });
    expect(compareEvents(monoLow, monoHigh)).toBeLessThan(0);

    const idA = ev({ id: 'event-000005', observedAt: 1, monotonicNs: 1 });
    const idB = ev({ id: 'event-000006', observedAt: 1, monotonicNs: 1 });
    expect(compareEvents(idA, idB)).toBeLessThan(0);
    expect(compareEvents(idA, idA)).toBe(0);
  });
});
