import type { ActivityEvent } from '@computer-history/protocol';

/**
 * Semantic step actions emitted by the coalescer, pinned by brief-m2 §D2 item 3
 * to exactly these semantic_steps.action values.
 */
export const STEP_ACTIONS = [
  'switch_app',
  'edit_text',
  'type',
  'scroll',
  'click',
  'focus',
  'shortcut',
  'window_change',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** One coalesced semantic step (spec §3.12); ids are assigned later at insert time. */
export interface CoalescedStep {
  action: StepAction;
  appBundleId: string;
  appName: string | null;
  /** Human-facing target: label, else identifier, else role. */
  target: string | null;
  text: string | null;
  startedAtMs: number;
  endedAtMs: number;
  firstEventId: string;
  lastEventId: string;
  /** How many source events were folded into this step (≥ 1). */
  eventCount: number;
  /** UI control role (ActivityEvent.target.role); feeds workflow fingerprints. */
  targetRole: string | null;
}

// Gap constants pinned by contracts.md §Numeric constants (spec §3.12).
const TEXT_EDIT_GAP_MS = 10_000;
/** Typing bursts merge only across gaps ≤ the text-edit bound (spec §3.12). */
const TYPING_GAP_MS = 10_000;
const SCROLL_GAP_MS = 3_000;
const FOCUS_NOISE_MS = 1_000;
const CLICK_FOCUS_COLLAPSE_MS = 500;

/** Canonical processing order (contracts §Concurrency): observed_at, monotonic_ns, id. */
export function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  const am = a.monotonicNs ?? 0;
  const bm = b.monotonicNs ?? 0;
  if (am !== bm) return am - bm;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface MutableStep extends CoalescedStep {
  windowTitle: string | null;
  targetIdentifier: string | null;
  /** Full target identity used for click/focus control matching. */
  targetKey: string;
  lastObservedAtMs: number;
  /** Wire action of the most recently absorbed source event. */
  lastEventAction: ActivityEvent['action'];
}

function targetKey(event: ActivityEvent): string {
  const t = event.target;
  return [t?.role ?? '', t?.subrole ?? '', t?.label ?? '', t?.identifier ?? ''].join('|');
}

function targetString(event: ActivityEvent): string | null {
  const t = event.target;
  return t?.label ?? t?.identifier ?? t?.role ?? null;
}

function newStep(event: ActivityEvent, action: StepAction): MutableStep {
  return {
    action,
    appBundleId: event.app.bundleId,
    appName: event.app.name ?? null,
    target: targetString(event),
    targetRole: event.target?.role ?? null,
    text: action === 'edit_text' ? (event.content ?? null) : null,
    startedAtMs: event.observedAt,
    endedAtMs: event.observedAt,
    firstEventId: event.id,
    lastEventId: event.id,
    eventCount: 1,
    windowTitle: event.window?.title ?? null,
    targetIdentifier: event.target?.identifier ?? null,
    targetKey: targetKey(event),
    lastObservedAtMs: event.observedAt,
    lastEventAction: event.action,
  };
}

/**
 * Pure deterministic coalescer (contracts §Coalescer determinism): sorted events
 * in → steps out, zero clock reads, all gap comparisons on event timestamps
 * only. App boundaries never merge; typing merges require strict adjacency so
 * a merged step can never silently span an idle-segment boundary.
 */
export function coalesceEvents(events: readonly ActivityEvent[]): CoalescedStep[] {
  const sorted = [...events].sort(compareEvents);
  const steps: MutableStep[] = [];

  for (const event of sorted) {
    const prev = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const bundle = event.app.bundleId;
    const observed = event.observedAt;
    const sameApp = prev !== undefined && prev.appBundleId === bundle;
    // Non-forward time (backward NTP correction) must read as an unbounded
    // gap: a negative gap would slip under every merge bound and persist an
    // inverted step interval (endedAtMs < startedAtMs). A backward event
    // opens a fresh step with startedAt == endedAt, which is valid.
    const gap =
      sameApp && observed >= prev.lastObservedAtMs
        ? observed - prev.lastObservedAtMs
        : Number.POSITIVE_INFINITY;

    switch (event.action) {
      case 'app_focus': {
        // App switches are never coalesced across (or within) app boundaries.
        steps.push(newStep(event, 'switch_app'));
        break;
      }
      case 'text_change': {
        if (
          prev !== undefined &&
          prev.action === 'edit_text' &&
          sameApp &&
          prev.windowTitle === (event.window?.title ?? null) &&
          prev.targetIdentifier === (event.target?.identifier ?? null) &&
          gap <= TEXT_EDIT_GAP_MS
        ) {
          // Last non-null content wins as the final text.
          if (event.content !== undefined && event.content !== null) prev.text = event.content;
          prev.endedAtMs = observed;
          prev.lastEventId = event.id;
          prev.lastObservedAtMs = observed;
          prev.eventCount += 1;
        } else {
          steps.push(newStep(event, 'edit_text'));
        }
        break;
      }
      case 'typing_activity': {
        // Consecutive keyboard events merge into one typing burst with duration;
        // text is never attached. The gap bound keeps bursts from spanning idle
        // periods (spec §3.12: every merge rule is gap-bounded).
        if (
          prev !== undefined &&
          prev.action === 'type' &&
          sameApp &&
          prev.lastEventAction === 'typing_activity' &&
          gap <= TYPING_GAP_MS
        ) {
          prev.endedAtMs = observed;
          prev.lastEventId = event.id;
          prev.lastObservedAtMs = observed;
          prev.eventCount += 1;
        } else {
          steps.push(newStep(event, 'type'));
        }
        break;
      }
      case 'scroll': {
        if (
          prev !== undefined &&
          prev.action === 'scroll' &&
          sameApp &&
          prev.windowTitle === (event.window?.title ?? null) &&
          gap <= SCROLL_GAP_MS
        ) {
          prev.endedAtMs = observed;
          prev.lastEventId = event.id;
          prev.lastObservedAtMs = observed;
          prev.eventCount += 1;
        } else {
          steps.push(newStep(event, 'scroll'));
        }
        break;
      }
      case 'focus_change': {
        // Click + focus on the same control within 500ms collapses into the click.
        if (
          prev !== undefined &&
          prev.action === 'click' &&
          sameApp &&
          prev.targetKey === targetKey(event) &&
          gap <= CLICK_FOCUS_COLLAPSE_MS
        ) {
          prev.endedAtMs = observed;
          prev.lastEventId = event.id;
          prev.lastObservedAtMs = observed;
          prev.eventCount += 1;
          break;
        }
        // Repeated focus events on the same target within 1s are dropped entirely.
        if (
          prev !== undefined &&
          prev.action === 'focus' &&
          sameApp &&
          prev.targetKey === targetKey(event) &&
          gap <= FOCUS_NOISE_MS
        ) {
          break;
        }
        steps.push(newStep(event, 'focus'));
        break;
      }
      case 'click': {
        steps.push(newStep(event, 'click'));
        break;
      }
      case 'shortcut': {
        steps.push(newStep(event, 'shortcut'));
        break;
      }
      case 'window_change': {
        steps.push(newStep(event, 'window_change'));
        break;
      }
    }
  }

  return steps.map(({ action, appBundleId, appName, targetRole, target, text, startedAtMs, endedAtMs, firstEventId, lastEventId, eventCount }) => ({
    action,
    appBundleId,
    appName,
    targetRole,
    target,
    text,
    startedAtMs,
    endedAtMs,
    firstEventId,
    lastEventId,
    eventCount,
  }));
}
