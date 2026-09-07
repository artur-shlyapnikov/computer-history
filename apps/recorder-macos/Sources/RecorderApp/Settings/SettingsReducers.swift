import Foundation

/// Pure per-app capture-policy editing transitions behind the Settings
/// surface (brief M7 S7 item 3: policy editor backed by CapturePolicyStore).
/// No I/O, no clock — the view model applies a transition, the store persists.
enum CapturePolicyReducer {
    /// Sets (or clears) one app's override. `mode == nil` removes the
    /// override so the app falls back to the policy default.
    static func setOverride(
        _ policy: CapturePolicy,
        bundleId: String,
        mode: CaptureMode?
    ) -> CapturePolicy {
        var next = policy
        if let mode {
            next.perApp[bundleId] = mode
        } else {
            next.perApp.removeValue(forKey: bundleId)
        }
        return next
    }

    /// Changes the default every non-overridden app falls back to.
    static func setDefaultMode(
        _ policy: CapturePolicy,
        mode: CaptureMode
    ) -> CapturePolicy {
        var next = policy
        next.defaultMode = mode
        return next
    }

    /// Removes an app row entirely (same as clearing its override).
    static func removeApp(
        _ policy: CapturePolicy,
        bundleId: String
    ) -> CapturePolicy {
        var next = policy
        next.perApp.removeValue(forKey: bundleId)
        return next
    }
}

/// Pure selection logic for the Delete-history controls (spec §3.23).
///
/// The four button presets map 1:1 onto the pinned wire presets
/// (`last_10_minutes` / `last_hour` / `today` / `all`) — the daemon owns
/// their boundary math in ONE transaction. Only the custom DatePicker range
/// needs conversion: the DatePicker shows the user's LOCAL calendar day, so
/// a picked day becomes `[localMidnight, nextLocalMidnight)` epoch-ms bounds
/// computed in the injected calendar (default `.current`). DST-transition
/// days are therefore 23h or 25h long — never a shifted window.
enum DeleteHistoryReducer {
    /// Seconds per UTC day; contracts pin uniform UTC calendar days.
    private static let secondsPerDay = 86400

    /// Epoch-ms bounds of the UTC day containing `nowMs`.
    static func utcDayBounds(containing nowMs: Int64) -> (from: Int64, to: Int64) {
        let startOfDaySeconds = Int(floor(Double(nowMs) / 1000 / Double(secondsPerDay))) * secondsPerDay
        return (
            Int64(startOfDaySeconds) * 1000,
            Int64(startOfDaySeconds + secondsPerDay) * 1000
        )
    }

    /// Epoch-ms bounds `[dayStart, nextDayStart)` of the LOCAL calendar day
    /// containing `date` in `calendar`.
    static func localDayBounds(
        containing date: Date,
        calendar: Calendar = .current
    ) -> (from: Int64, to: Int64) {
        let dayStart = calendar.startOfDay(for: date)
        // +1 calendar day cannot fail for a valid instant; fall back to a
        // uniform 24h step if a non-Gregorian calendar ever refuses.
        let nextDayStart = calendar.date(byAdding: .day, value: 1, to: dayStart)
            ?? dayStart.addingTimeInterval(Double(secondsPerDay))
        return (
            Int64(dayStart.timeIntervalSince1970 * 1000),
            Int64(nextDayStart.timeIntervalSince1970 * 1000)
        )
    }

    /// `{from, to}` covering the whole LOCAL calendar day shown for `date`
    /// (in `calendar`, default `.current`), sent when the user picks
    /// "Delete day…".
    static func dayRangeParams(
        for date: Date,
        calendar: Calendar = .current
    ) -> DeleteRangeParams {
        let bounds = localDayBounds(containing: date, calendar: calendar)
        return .init(from: bounds.from, to: bounds.to)
    }
}
