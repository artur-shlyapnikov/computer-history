import Foundation
@testable import RecorderApp
import Testing

/// Pure view-model tests for the M7 hardening surfaces (brief S7 item 5):
/// supervisor error ring, capture-policy editing reducer, delete-history
/// selection reducer.
struct HardeningReducerTests {
    // MARK: - SupervisorErrorRing

    @Test("ring keeps the newest N entries and evicts the oldest")
    func ringEviction() {
        var ring = SupervisorErrorRing(capacity: 3)
        for (index, nowMs) in [100, 200, 300, 400, 500].enumerated() {
            ring.record(atMs: Int64(nowMs), scope: "supervisor", code: "e\(index)", message: "m\(index)")
        }
        #expect(ring.entries.count == 3)
        // Oldest two evicted; newest-last ordering preserved.
        #expect(ring.entries.map(\.code) == ["e2", "e3", "e4"])
        #expect(ring.entries.map(\.atMs) == [300, 400, 500])
        // Newest-first projection for display.
        #expect(ring.newestFirst.map(\.code) == ["e4", "e3", "e2"])
        #expect(!ring.isEmpty)
    }

    @Test("ring ids are unique and monotonic across records")
    func ringIds() {
        var ring = SupervisorErrorRing(capacity: 2)
        ring.record(atMs: 1, scope: "s", code: "a", message: "")
        ring.record(atMs: 2, scope: "s", code: "b", message: "")
        ring.record(atMs: 3, scope: "s", code: "c", message: "")
        #expect(Set(ring.entries.map(\.id)).count == ring.entries.count)
        let maxId = ring.entries.map(\.id).max() ?? 0
        #expect(ring.nextId > maxId)
    }

    @Test("empty ring reports empty and renders nothing")
    func emptyRing() {
        let ring = SupervisorErrorRing(capacity: 5)
        #expect(ring.isEmpty)
        #expect(ring.entries.isEmpty)
        #expect(ring.newestFirst.isEmpty)
    }

    // MARK: - CapturePolicyReducer

    @Test("override set and clear transitions keep the default untouched")
    func policyOverrides() {
        let base = CapturePolicy(defaultMode: .metadata, perApp: [:])

        let withOverride = CapturePolicyReducer.setOverride(base, bundleId: "com.example.app", mode: .off)
        #expect(withOverride.mode(forBundleId: "com.example.app") == .off)
        #expect(withOverride.defaultMode == .metadata)

        let cleared = CapturePolicyReducer.setOverride(withOverride, bundleId: "com.example.app", mode: nil)
        #expect(cleared.perApp.isEmpty)
        #expect(cleared.mode(forBundleId: "com.example.app") == .metadata)

        // removeApp behaves like clearing the override.
        let removed = CapturePolicyReducer.removeApp(withOverride, bundleId: "com.example.app")
        #expect(removed.perApp.isEmpty)
    }

    @Test("default-mode transition applies to non-overridden apps only")
    func policyDefaultMode() {
        let base = CapturePolicy(
            defaultMode: .metadata,
            perApp: ["com.example.pinned": .content]
        )
        let next = CapturePolicyReducer.setDefaultMode(base, mode: .off)
        #expect(next.defaultMode == .off)
        #expect(next.mode(forBundleId: "com.example.other") == .off)
        // Explicit override still wins.
        #expect(next.mode(forBundleId: "com.example.pinned") == .content)
    }

    // MARK: - DeleteHistoryReducer

    @Test("UTC day bounds align to midnight and cover exactly one day")
    func utcDayBounds() {
        // 2026-08-23T12:34:56.789Z (epoch ms).
        let nowMs: Int64 = 1_787_470_096_789
        let bounds = DeleteHistoryReducer.utcDayBounds(containing: nowMs)
        // floor(1787470096.789 s / 86400 s) = 20688 days → day start in ms.
        #expect(bounds.from == 1_787_443_200_000)
        #expect(bounds.to == bounds.from + 86_400_000)
        // The instant itself lies inside its own UTC day window.
        #expect(nowMs >= bounds.from && nowMs < bounds.to)
    }

    @Test("picked local day maps to [local midnight, next local midnight) — Los Angeles")
    func dayRangeLosAngeles() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        // Picked 2026-08-24 20:00 PDT == 2026-08-25T03:00:00Z.
        let date = Date(timeIntervalSince1970: 1_787_626_800)
        let bounds = DeleteHistoryReducer.localDayBounds(containing: date, calendar: calendar)
        // Local midnights: Aug 24 00:00 PDT == 07:00Z; Aug 25 00:00 PDT == 07:00Z.
        #expect(bounds.from == 1_787_554_800_000)
        #expect(bounds.to == 1_787_641_200_000)
        // The picked instant lies inside its own local-day window.
        let pickedMs = Int64(date.timeIntervalSince1970 * 1000)
        #expect(pickedMs >= bounds.from && pickedMs < bounds.to)
        // The window covers the full local evening of the shown day.
        #expect(bounds.from < pickedMs - 3_600_000)
    }

    @Test("picked local day maps to [local midnight, next local midnight) — Tokyo")
    func dayRangeTokyo() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Asia/Tokyo"))
        // Picked 2026-08-24 12:00 JST == 2026-08-24T03:00:00Z.
        let date = Date(timeIntervalSince1970: 1_787_540_400)
        let params = DeleteHistoryReducer.dayRangeParams(for: date, calendar: calendar)
        #expect(params.preset == nil)
        let from = try #require(params.from)
        let to = try #require(params.to)
        // Local midnights: Aug 24 00:00 JST == Aug 23 15:00Z;
        // Aug 25 00:00 JST == Aug 24 15:00Z.
        #expect(from == 1_787_497_200_000)
        #expect(to == 1_787_583_600_000)
        #expect(to - from == 86_400_000)
        let pickedMs = Int64(date.timeIntervalSince1970 * 1000)
        #expect(pickedMs >= from && pickedMs < to)
        #expect(throws: Never.self) { try params.validate() }
    }

    @Test("DST spring-forward day in Los Angeles yields a 23h local-midnight-aligned window")
    func dayRangeDstSpringForward() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        // Picked 2026-03-08 14:00 PDT (after the 02:00 jump) == 21:00Z.
        let date = Date(timeIntervalSince1970: 1_773_003_600)
        let params = DeleteHistoryReducer.dayRangeParams(for: date, calendar: calendar)
        let from = try #require(params.from)
        let to = try #require(params.to)
        // Mar 8 00:00 PST (UTC-8) == 08:00Z; Mar 9 00:00 PDT (UTC-7) == 07:00Z.
        #expect(from == 1_772_956_800_000)
        #expect(to == 1_773_039_600_000)
        // Exactly 23h — never a uniform-but-shifted 24h window.
        #expect(to - from == 82_800_000)
        #expect(throws: Never.self) { try params.validate() }
    }
}
