import Foundation

/// Shared pool of configured `DateFormatter`s keyed by (calendar, locale,
/// timeZone, dateFormat).
///
/// Allocating + configuring a DateFormatter costs ~100µs (locale data
/// resolution); formatting from an already-configured instance costs ~1µs.
/// Timeline row helpers run per rendered row and the timeline re-renders on
/// every 5s poll tick, so per-call allocation there burns ~10ms of main-thread
/// time per 100-row render.
///
/// Concurrency: NSDateFormatter is documented thread-safe for formatting since
/// macOS 10.9 — the pool only guarantees that get-or-create is serialized; the
/// returned instance must be used for formatting only (callers never mutate
/// dateFormat/calendar after creation).
final class DateFormatterPool: @unchecked Sendable {
    private struct Key: Hashable {
        var calendar: Calendar.Identifier
        var locale: String
        var timeZone: String
        // Two calendars can share identifier/locale/timeZone yet format week
        // boundaries differently; keying these keeps distinct configs distinct.
        var firstWeekday: Int
        var minimumDaysInFirstWeek: Int
        var format: String
    }

    private let lock = NSLock()
    private var cache: [Key: DateFormatter] = [:]
    private var observers: [NSObjectProtocol] = []

    init() {
        // Cached identifiers freeze the locale/timeZone at first use; system
        // changes mid-session must invalidate, or rows keep formatting with
        // stale region conventions until relaunch.
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSLocale.currentLocaleDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
                self?.clear()
            },
            center.addObserver(forName: NSNotification.Name.NSSystemTimeZoneDidChange, object: nil, queue: nil) { [weak self] _ in
                self?.clear()
            },
        ]
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    private func clear() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
    }

    /// Returns a formatter configured exactly for the given calendar and
    /// format string, creating it on first use. The instance is shared —
    /// format with it, never reconfigure it.
    func formatter(calendar: Calendar, format: String) -> DateFormatter {
        let locale = calendar.locale ?? Locale.autoupdatingCurrent
        let key = Key(
            calendar: calendar.identifier,
            locale: locale.identifier,
            timeZone: calendar.timeZone.identifier,
            firstWeekday: calendar.firstWeekday,
            minimumDaysInFirstWeek: calendar.minimumDaysInFirstWeek,
            format: format
        )
        lock.lock()
        if let hit = cache[key] {
            lock.unlock()
            return hit
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = format
        cache[key] = formatter
        lock.unlock()
        return formatter
    }
}

/// Process-wide pool for the UI row-mapping helpers.
enum CachedDateFormatters {
    static let shared = DateFormatterPool()
}
