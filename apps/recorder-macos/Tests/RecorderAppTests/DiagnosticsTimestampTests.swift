import Foundation
@testable import RecorderApp
import Testing

/// Pins DiagnosticsView's day-aware error timestamps (supervisor error ring +
/// daemon last-errors): today's entries stay compact "HH:mm:ss"; entries from
/// any other day append the date, and outside the current year the year too —
/// otherwise errors from different days are indistinguishable.
@MainActor
struct DiagnosticsTimestampTests {
    /// 2026-03-10 14:30:05 local time, in ms since epoch.
    private func ms(
        _ year: Int, _ month: Int, _ day: Int,
        _ hour: Int, _ minute: Int, _ second: Int = 0,
        calendar: Calendar
    ) -> Int64 {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        return Int64(calendar.date(from: components)!.timeIntervalSince1970 * 1000)
    }

    @Test("today renders day-less HH:mm:ss")
    func todayStaysCompact() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        // Fully pinned locale so month names are exact (matches the
        // MemoriesStateTests lastSeenText pinning pattern).
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let now = try #require(calendar.date(from: DateComponents(timeZone: calendar.timeZone, year: 2026, month: 3, day: 10, hour: 16)))

        let text = DiagnosticsView.timestamp(
            ms(2026, 3, 10, 14, 30, 5, calendar: calendar),
            calendar: calendar,
            now: now
        )
        #expect(text == "14:30:05")
    }

    @Test("same-year earlier day appends the date")
    func otherDaySameYearIncludesDate() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let now = try #require(calendar.date(from: DateComponents(timeZone: calendar.timeZone, year: 2026, month: 3, day: 10, hour: 9)))

        let text = DiagnosticsView.timestamp(
            ms(2026, 3, 8, 23, 59, 1, calendar: calendar),
            calendar: calendar,
            now: now
        )
        #expect(text == "23:59:01 Mar 8")
    }

    @Test("previous-year entry appends date and year")
    func otherYearIncludesYear() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let now = try #require(calendar.date(from: DateComponents(timeZone: calendar.timeZone, year: 2026, month: 1, day: 2, hour: 8)))

        let text = DiagnosticsView.timestamp(
            ms(2025, 12, 31, 7, 15, calendar: calendar),
            calendar: calendar,
            now: now
        )
        #expect(text == "07:15:00 Dec 31 2025")
    }
}
