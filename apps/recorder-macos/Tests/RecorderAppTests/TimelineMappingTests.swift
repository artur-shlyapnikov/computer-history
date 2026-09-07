import Foundation
@testable import RecorderApp
import Testing

// MARK: - Test doubles

/// Deterministic tick scheduler: tests fire ticks explicitly; no real timers.
/// `@unchecked Sendable`: confined to the @MainActor test struct that owns it.
final class ManualTickScheduler: TimelineTickScheduler, @unchecked Sendable {
    private var tick: (@Sendable () async -> Void)?
    private(set) var interval: TimeInterval?
    private(set) var stopCount = 0

    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void) {
        self.interval = interval
        self.tick = tick
    }

    func stop() {
        stopCount += 1
    }

    func fire() async {
        await tick?()
    }
}

/// Thread-safe load counter for injected timeline loaders.
private final class LoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

// MARK: - Mapping tests

/// Pure TimelinePresentation mapping: day grouping, app lines, time ranges,
/// human action labels, provenance step rows, segment fallback selection.
/// All calendars pinned to UTC for determinism.
struct TimelineMappingTests {
    let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    /// 2026-08-21T12:00:00Z — «now» anchor for the grouping tests.
    var now: Date {
        date(2026, 8, 21, 12, 0)
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        return calendar.date(from: components)!
    }

    private func ms(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Int64 {
        Int64(date(year, month, day, hour, minute).timeIntervalSince1970 * 1000)
    }

    private func step(
        ordinal: Int,
        startedAtMs: Int64,
        endedAtMs: Int64,
        action: String,
        appName: String? = nil,
        target: String? = nil,
        text: String? = nil
    ) -> SemanticStepDto {
        SemanticStepDto(
            id: "01STEP\(ordinal)",
            segmentId: "01SEG",
            ordinal: ordinal,
            startedAtMs: startedAtMs,
            endedAtMs: endedAtMs,
            action: action,
            appBundleId: "com.example.app",
            appName: appName,
            target: target,
            text: text
        )
    }

    private func episode(
        id: String = "01EP",
        startedAtMs: Int64,
        endedAtMs: Int64,
        title: String = "Investigated webhook failures",
        appNames: [String] = ["Safari", "Terminal"],
        stepCount: Int = 2
    ) -> EpisodeSummaryDto {
        EpisodeSummaryDto(
            id: id,
            startedAtMs: startedAtMs,
            endedAtMs: endedAtMs,
            title: title,
            appNames: appNames,
            stepCount: stepCount,
            pendingJobs: 0
        )
    }

    @Test("app line joins names with · and falls back to Unknown")
    func appLines() {
        #expect(TimelinePresentation.appNamesText(["Safari", "Terminal", "Slack"]) == "Safari·Terminal·Slack")
        #expect(TimelinePresentation.appNamesText(["Safari"]) == "Safari")
        // Empty or whitespace-only names degrade honestly to «Unknown».
        #expect(TimelinePresentation.appNamesText([]) == TimelinePresentation.unknownApp)
        #expect(TimelinePresentation.appNamesText(["", ""]) == TimelinePresentation.unknownApp)
    }

    @Test("step count copy is singular-aware")
    func stepCountCopy() {
        #expect(TimelinePresentation.stepCountText(1) == "1 step")
        #expect(TimelinePresentation.stepCountText(3) == "3 steps")
        #expect(TimelinePresentation.stepCountText(0) == "0 steps")
    }

    @Test("day-aware time text stays compact same-day and prefixes older ranges")
    func dayAwareTimeText() {
        let started = ms(2026, 8, 21, 9, 5)
        let ended = ms(2026, 8, 21, 10, 30)
        let sameDay = date(2026, 8, 21, 23, 0)
        let sameYear = date(2026, 8, 26, 12, 0)
        let otherYear = date(2027, 3, 2, 12, 0)
        #expect(
            TimelinePresentation.dayAwareTimeText(startedAtMs: started, endedAtMs: ended, calendar: calendar, now: sameDay)
                == "09:05–10:30"
        )
        #expect(
            TimelinePresentation.dayAwareTimeText(startedAtMs: started, endedAtMs: ended, calendar: calendar, now: sameYear)
                == "Aug 21 · 09:05–10:30"
        )
        #expect(
            TimelinePresentation.dayAwareTimeText(startedAtMs: started, endedAtMs: ended, calendar: calendar, now: otherYear)
                == "Aug 21 2026 · 09:05–10:30"
        )
    }

    @Test("day-aware time text anchors an episode spanning midnight to its start day")
    func dayAwareTimeTextMidnightSpan() {
        let started = ms(2026, 8, 21, 23, 40)
        let ended = ms(2026, 8, 22, 0, 20)
        let nextDay = date(2026, 8, 22, 12, 0)
        #expect(
            TimelinePresentation.dayAwareTimeText(startedAtMs: started, endedAtMs: ended, calendar: calendar, now: nextDay)
                == "Aug 21 · 23:40–00:20"
        )
    }

    @Test("timeline footer stays silent below the page cap")
    func truncationFooterHiddenBelowCap() {
        #expect(TimelinePresentation.truncationFooter(count: 0) == nil)
        #expect(TimelinePresentation.truncationFooter(count: TimelineListDefaults.defaultLimit - 1) == nil)
    }

    @Test("a full page admits the window is a floor, not the whole history")
    func truncationFooterAtCap() {
        let footer = TimelinePresentation.truncationFooter(count: TimelineListDefaults.defaultLimit)
        #expect(footer?.contains("\(TimelineListDefaults.defaultLimit) most recent") == true)
        #expect(TimelinePresentation.truncationFooter(count: TimelineListDefaults.defaultLimit + 10) == footer)
    }

    @Test("row models carry title, range, app line and step count")
    func rowModelFields() throws {
        let start = ms(2026, 8, 21, 10, 15)
        let summary = episode(
            startedAtMs: start,
            endedAtMs: start + 900_000,
            appNames: ["Safari", "Terminal"],
            stepCount: 12
        )

        let sections = TimelinePresentation.sections(from: [summary], now: now, calendar: calendar)
        let row = try #require(sections.first?.rows.first)
        #expect(row.id == summary.id)
        #expect(row.episode.title == "Investigated webhook failures")
        #expect(row.timeRangeText == "10:15–10:30")
        #expect(row.appNamesText == "Safari·Terminal")
        #expect(row.stepCount == 12)
    }

    @Test("day titles: Today, Yesterday, formatted older date")
    func dayTitles() {
        #expect(TimelinePresentation.dayTitle(for: date(2026, 8, 21, 8, 0), now: now, calendar: calendar) == "Today")
        #expect(TimelinePresentation.dayTitle(for: date(2026, 8, 20, 23, 59), now: now, calendar: calendar) == "Yesterday")
        #expect(TimelinePresentation.dayTitle(for: date(2026, 8, 19, 10, 0), now: now, calendar: calendar) == "Aug 19, 2026")
    }

    @Test("midnight-spanning episode groups under its START day, never split")
    func midnightSpanningGroupsUnderStartDay() {
        let todayStart = ms(2026, 8, 21, 9, 0)
        let midnightStart = ms(2026, 8, 20, 23, 40)
        let episodes = [
            episode(id: "A", startedAtMs: todayStart, endedAtMs: todayStart + 1_800_000),
            episode(id: "B", startedAtMs: midnightStart, endedAtMs: midnightStart + 40 * 60000),
        ]

        let sections = TimelinePresentation.sections(from: episodes, now: now, calendar: calendar)

        // Newest day first; B stays whole in its Aug-20 bucket («Yesterday»).
        #expect(sections.map(\.dayTitle) == ["Today", "Yesterday"])
        #expect(sections[0].rows.map(\.id) == ["A"])
        #expect(sections[1].rows.map(\.id) == ["B"])
        #expect(sections[1].rows[0].timeRangeText == "23:40–00:20")
    }

    @Test("sections sort newest-first regardless of input order and within-day rows descend")
    func sectionAndRowOrdering() {
        let morning = ms(2026, 8, 21, 8, 0)
        let afternoon = ms(2026, 8, 21, 17, 30)
        let older = ms(2026, 8, 18, 10, 0)
        // Deliberately shuffled input.
        let episodes = [
            episode(id: "morning", startedAtMs: morning, endedAtMs: morning),
            episode(id: "older", startedAtMs: older, endedAtMs: older),
            episode(id: "afternoon", startedAtMs: afternoon, endedAtMs: afternoon),
        ]

        let sections = TimelinePresentation.sections(from: episodes, now: now, calendar: calendar)
        #expect(sections.count == 2)
        #expect(sections[0].dayTitle == "Today")
        #expect(sections[0].rows.map(\.id) == ["afternoon", "morning"])
        #expect(sections[1].dayTitle == "Aug 18, 2026")
    }

    @Test("equal startedAtMs rows within a day tie-break by id ascending, deterministically")
    func equalStartTimesTieBreakByIdAscending() {
        let shared = ms(2026, 8, 21, 12, 0)
        // Input deliberately lists «b» before «a» so only the id tie-break
        // can produce the pinned order.
        let episodes = [
            episode(id: "b", startedAtMs: shared, endedAtMs: shared),
            episode(id: "a", startedAtMs: shared, endedAtMs: shared),
        ]

        let first = TimelinePresentation.sections(from: episodes, now: now, calendar: calendar)
        let second = TimelinePresentation.sections(from: episodes, now: now, calendar: calendar)
        #expect(first.count == 1)
        #expect(first[0].rows.map(\.id) == ["a", "b"])
        // Swift's sort is not stable; the id tie-break must make repeat
        // mappings byte-identical instead of reshuffling between refreshes.
        #expect(second[0].rows.map(\.id) == first[0].rows.map(\.id))
    }

    @Test("human action labels cover all pinned coalescer kinds plus unknown fallback")
    func humanActionLabels() {
        #expect(TimelinePresentation.humanActionLabel(for: "focus") == "Focused")
        #expect(TimelinePresentation.humanActionLabel(for: "text_edit") == "Edited text")
        #expect(TimelinePresentation.humanActionLabel(for: "switch_app") == "Switched to")
        #expect(TimelinePresentation.humanActionLabel(for: "scroll") == "Scrolled")
        #expect(TimelinePresentation.humanActionLabel(for: "click") == "Clicked")
        #expect(TimelinePresentation.humanActionLabel(for: "type") == "Typed")
        #expect(TimelinePresentation.humanActionLabel(for: "shortcut") == "Shortcut")
        #expect(TimelinePresentation.humanActionLabel(for: "window_change") == "Window changed")
        // Unknown future kind degrades honestly to the raw wire value.
        #expect(TimelinePresentation.humanActionLabel(for: "quantum_leap") == "quantum_leap")
    }

    @Test("provenance step rows order by ordinal and carry label/range/provenance/preview")
    func stepRowModels() {
        let t0 = ms(2026, 8, 21, 9, 0)
        let steps = [
            step(ordinal: 1, startedAtMs: t0 + 60000, endedAtMs: t0 + 120_000, action: "scroll",
                 appName: "Safari"),
            step(ordinal: 0, startedAtMs: t0, endedAtMs: t0 + 60000, action: "type",
                 appName: "Safari", target: "textarea#issue-comment", text: "Reproduced the failure."),
        ]

        let rows = TimelinePresentation.stepRowModels(from: steps, calendar: calendar)
        #expect(rows.map(\.id) == ["01STEP0", "01STEP1"])
        #expect(rows[0].actionLabel == "Typed")
        #expect(rows[0].timeRangeText == "09:00–09:01")
        #expect(rows[0].provenanceText == "Safari · textarea#issue-comment")
        #expect(rows[0].textPreview == "Reproduced the failure.")
        // No target → bare app; no text → nil preview.
        #expect(rows[1].provenanceText == "Safari")
        #expect(rows[1].textPreview == nil)
        // appName missing → bundle-id fallback keeps provenance honest.
        let anonymous = TimelinePresentation.stepRowModels(
            from: [step(ordinal: 0, startedAtMs: t0, endedAtMs: t0, action: "click")],
            calendar: calendar
        )
        #expect(anonymous[0].provenanceText == "com.example.app")
    }

    @Test("fallback segment is the one covering the episode start window")
    func fallbackSegmentSelection() {
        let episodeStart = ms(2026, 8, 21, 10, 0)
        let summary = episode(startedAtMs: episodeStart, endedAtMs: episodeStart + 600_000)

        let covering = SegmentSummaryDto(
            id: "COVER",
            startedAtMs: ms(2026, 8, 21, 9, 55),
            endedAtMs: ms(2026, 8, 21, 11, 5),
            state: .finalized,
            stepCount: 0,
            steps: []
        )
        let before = SegmentSummaryDto(
            id: "BEFORE",
            startedAtMs: ms(2026, 8, 21, 8, 0),
            endedAtMs: ms(2026, 8, 21, 9, 0),
            state: .finalized,
            stepCount: 0,
            steps: []
        )
        let after = SegmentSummaryDto(
            id: "AFTER",
            startedAtMs: ms(2026, 8, 21, 12, 0),
            endedAtMs: ms(2026, 8, 21, 13, 0),
            state: .finalized,
            stepCount: 0,
            steps: []
        )

        #expect(TimelinePresentation.fallbackSegment(for: summary, in: [before, after]) == nil)
        #expect(TimelinePresentation.fallbackSegment(for: summary, in: [before, after, covering])?.id == "COVER")

        // Open-ended segment still matches while it started before the episode.
        let open = SegmentSummaryDto(
            id: "OPEN",
            startedAtMs: ms(2026, 8, 21, 9, 30),
            endedAtMs: nil,
            state: .open,
            stepCount: 0,
            steps: []
        )
        #expect(TimelinePresentation.fallbackSegment(for: summary, in: [open])?.id == "OPEN")

        // Two covering candidates → closest start wins.
        let tighter = SegmentSummaryDto(
            id: "TIGHTER",
            startedAtMs: ms(2026, 8, 21, 9, 59),
            endedAtMs: ms(2026, 8, 21, 11, 5),
            state: .finalized,
            stepCount: 0,
            steps: []
        )
        #expect(TimelinePresentation.fallbackSegment(for: summary, in: [covering, tighter])?.id == "TIGHTER")
    }
}

// MARK: - Polling / phase tests

@MainActor
struct TimelinePollingTests {
    private func makeEpisode(id: String) -> EpisodeSummaryDto {
        EpisodeSummaryDto(
            id: id,
            startedAtMs: 1_787_443_200_100,
            endedAtMs: 1_787_443_215_000,
            title: "Investigated webhook failures",
            appNames: ["Safari"],
            stepCount: 2,
            pendingJobs: 0
        )
    }

    @Test("refresh success transitions idle → loaded with episodes")
    func refreshLoads() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        api.onListTimeline = { [makeEpisode(id: "E1")] }
        await appState.refreshTimeline()
        #expect(appState.timelinePhase == .loaded)
        #expect(appState.timelineEpisodes.map(\.id) == ["E1"])
    }

    @Test("refresh failure surfaces a failed phase with message")
    func refreshFailureSurfacesError() async {
        struct Boom: LocalizedError {
            var errorDescription: String? {
                "boom"
            }
        }
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        api.onListTimeline = { throw Boom() }
        await appState.refreshTimeline()
        #expect(appState.timelinePhase == .failed("boom"))
    }

    @Test("missing loader reports failure instead of crashing")
    func missingLoaderReportsFailure() async {
        let appState = AppState(daemon: FakeDaemonAPI())
        await appState.refreshTimeline()
        #expect(appState.timelinePhase == .failed("Daemon connection unavailable"))
    }

    @Test("polling ticks drop while recording paused and resume when active")
    func pollingPausesWhilePaused() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let scheduler = ManualTickScheduler()
        let counter = LoadCounter()
        api.onListTimeline = {
            counter.increment()
            return []
        }

        appState.recordingState = .paused(reason: nil)
        appState.startTimelinePolling(scheduler: scheduler, interval: 5)
        #expect(scheduler.interval == 5)

        await scheduler.fire()
        #expect(counter.value == 0) // paused ⇒ tick dropped, not queued

        appState.recordingState = .active
        await scheduler.fire()
        #expect(counter.value == 1)

        appState.stopTimelinePolling()
        #expect(scheduler.stopCount == 1) // the explicit stopTimelinePolling()
    }

    @Test("restart replaces the previous scheduler instead of stacking timers")
    func restartReplacesScheduler() {
        let appState = AppState()
        let first = ManualTickScheduler()
        let second = ManualTickScheduler()

        appState.startTimelinePolling(scheduler: first, interval: 5)
        appState.startTimelinePolling(scheduler: second, interval: 5)

        #expect(first.stopCount >= 1)
        #expect(second.stopCount == 0)
        appState.stopTimelinePolling()
        #expect(second.stopCount == 1)
    }
}

// MARK: - Queue badge state machine tests (spec §3.24)

@MainActor
struct QueueBadgeTests {
    @Test("badge text appears above zero and hides at zero")
    func badgeTextMapping() {
        #expect(QueueBadge.badgeText(forPendingJobs: 0) == nil)
        #expect(QueueBadge.badgeText(forPendingJobs: 3) == "3 activities waiting for processing")
        #expect(QueueBadge.badgeText(forPendingJobs: 1) == "1 activity waiting for processing")
        // Negative counts are clamped, never rendered.
        #expect(QueueBadge.badgeText(forPendingJobs: -2) == nil)
    }

    @Test("injected queue_update event sequence drives the badge transitions")
    func eventSequenceDrivesBadge() {
        let appState = AppState()
        #expect(appState.queueBadgeText == nil)

        appState.applyQueueUpdate(pendingJobs: 4)
        #expect(appState.pendingJobs == 4)
        #expect(appState.queueBadgeText == "4 activities waiting for processing")

        // Daemon drains the queue → indicator hides.
        appState.applyQueueUpdate(pendingJobs: 0)
        #expect(appState.queueBadgeText == nil)

        // Retry wave re-shows it; a later drain hides it again.
        appState.applyQueueUpdate(pendingJobs: 2)
        #expect(appState.queueBadgeText == "2 activities waiting for processing")
        appState.applyQueueUpdate(pendingJobs: 0)
        #expect(appState.queueBadgeText == nil)
    }

    @Test("queue_update wire frames decode onto the badge state machine")
    func wireFrameDecodesOntoStateMachine() throws {
        let appState = AppState()
        let frame = #"{"protocolVersion":1,"messageId":"01M0NP9G4HP0M1M64H8TC0VEKF","type":"event","kind":"queue_update","sentAt":1787443204500,"payload":{"pendingJobs":7}}"#
        let decoded = try JSONDecoder().decode(QueueUpdateEvent.self, from: Data(frame.utf8))
        #expect(decoded.kind == "queue_update")
        appState.applyQueueUpdate(pendingJobs: decoded.payload.pendingJobs)
        #expect(appState.queueBadgeText == "7 activities waiting for processing")
    }
}
