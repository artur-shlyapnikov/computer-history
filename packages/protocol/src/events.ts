import { Type, type Static } from '@sinclair/typebox';

// Shared W5 wire bound (2^53−1): monotonicNs is host-uptime nanoseconds and a
// host up past ~104 days would otherwise carry a value Foundation's decoder
// silently corrupts — which the event coalescer then orders on.
import { DaemonSafeInt } from './bounds.js';

/** Where an ActivityEvent was observed. Spec §3.5. */
export const EventSource = Type.Union(
  [Type.Literal('workspace'), Type.Literal('accessibility'), Type.Literal('input')],
  { $id: 'EventSource' },
);
export type EventSource = Static<typeof EventSource>;

/** Semantic action of an ActivityEvent. Spec §3.5. */
export const EventAction = Type.Union(
  [
    Type.Literal('app_focus'),
    Type.Literal('window_change'),
    Type.Literal('focus_change'),
    Type.Literal('click'),
    Type.Literal('text_change'),
    Type.Literal('typing_activity'),
    Type.Literal('shortcut'),
    Type.Literal('scroll'),
  ],
  { $id: 'EventAction' },
);
export type EventAction = Static<typeof EventAction>;

/**
 * How event content was treated by the recorder's PrivacyFilter.
 * Contracts §Protocol v1 (contentPolicy enum).
 */
export const ContentPolicy = Type.Union(
  [
    Type.Literal('allow'),
    Type.Literal('metadata_only'),
    Type.Literal('redacted_secure_field'),
    Type.Literal('redacted_sensitive_target'),
    Type.Literal('redacted_secret_pattern'),
    Type.Literal('redacted_oversize'),
    Type.Literal('excluded_app'),
  ],
  { $id: 'ContentPolicy' },
);
export type ContentPolicy = Static<typeof ContentPolicy>;

export const AppInfo = Type.Object({
  bundleId: Type.String({ description: 'macOS bundle identifier, e.g. com.apple.Safari' }),
  name: Type.Optional(Type.String()),
  pid: Type.Optional(Type.Integer()),
});
export type AppInfo = Static<typeof AppInfo>;

export const WindowInfo = Type.Object({
  title: Type.Optional(Type.String()),
});
export type WindowInfo = Static<typeof WindowInfo>;

export const TargetInfo = Type.Object({
  role: Type.Optional(Type.String()),
  subrole: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  identifier: Type.Optional(Type.String()),
});
export type TargetInfo = Static<typeof TargetInfo>;

const ulidPattern = '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$';

/** Canonical capture event crossing the IPC boundary. Wire fields camelCase per spec §3.5. */
export const ActivityEventSchema = Type.Object(
  {
    id: Type.String({ pattern: ulidPattern, description: 'Global ULID; raw_events primary key' }),
    /** Unix epoch milliseconds at observation time. */
    observedAt: Type.Integer(),
    /** Monotonic clock nanoseconds for intra-host ordering; may be absent on replay. */
    monotonicNs: Type.Optional(DaemonSafeInt),
    source: EventSource,
    app: AppInfo,
    window: Type.Optional(WindowInfo),
    action: EventAction,
    target: Type.Optional(TargetInfo),
    content: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    contentPolicy: ContentPolicy,
    captureSessionId: Type.Optional(Type.String()),
  },
  { $id: 'ActivityEvent' },
);
export type ActivityEvent = Static<typeof ActivityEventSchema>;
