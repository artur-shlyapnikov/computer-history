import Foundation

/// Injectable time sources (contracts §Testing conventions: injected clock
/// everywhere time matters). The production clock derives wall time from the
/// system date and monotonic time from ProcessInfo.systemUptime so ordering
/// survives wall-clock adjustments.
struct CaptureClock: Sendable {
    var nowMs: @Sendable () -> Int64
    var monotonicNs: @Sendable () -> Int64

    static let system = CaptureClock(
        nowMs: { Int64(Date().timeIntervalSince1970 * 1000) },
        // Spec S1.1: monotonicNs is ProcessInfo systemUptime-derived — seconds
        // since boot scaled to nanoseconds. Not affected by NTP jumps.
        //
        // Wire bound (W5): the TS schema pins integers to 2^53−1 because JSON
        // numbers past that lose integer precision in Foundation's decoder.
        // systemUptime nanoseconds cross that after ~104 days of host uptime;
        // past it every value is degenerate for intra-host ordering anyway, so
        // clamp instead of having the daemon reject the whole batch. The
        // operand is Int64 and 2^53−1 < Int64.max, so the min() cannot overflow.
        monotonicNs: {
            let ns = Int64(ProcessInfo.processInfo.systemUptime * 1_000_000_000)
            return min(ns, 9_007_199_254_740_991)
        }
    )
}

/// An ActivityEvent under construction, before privacy filtering (spec §3.6).
/// Monitors populate only what they observed; PrivacyFilter converts it into
/// a wire ActivityEvent or drops it.
struct EventDraft: Sendable {
    var source: EventSource
    var action: EventAction
    var app: AppInfo
    /// Frontmost window title as observed; never populated for excluded apps.
    var windowTitle: String?
    var target: TargetInfo?
    /// Text value observed via Accessibility. Secure fields NEVER populate
    /// this — AXMonitor refuses to read their value at all (spec §3.7).
    var content: String?
    /// True when the AX subrole was AXSecureTextField; the filter redacts on
    /// this flag alone and must not consult `content`.
    var isSecureField: Bool

    init(
        source: EventSource,
        action: EventAction,
        app: AppInfo,
        windowTitle: String? = nil,
        target: TargetInfo? = nil,
        content: String? = nil,
        isSecureField: Bool = false
    ) {
        self.source = source
        self.action = action
        self.app = app
        self.windowTitle = windowTitle
        self.target = target
        self.content = content
        self.isSecureField = isSecureField
    }
}

/// Per-launch capture identity: `captureSessionId` is regenerated every app
/// launch (brief S1 item 1). Immutable after creation.
struct CaptureSession: Sendable {
    let id: String

    init(ulid: @autoclosure () -> String = Ulid.shared.next()) {
        id = ulid()
    }
}
