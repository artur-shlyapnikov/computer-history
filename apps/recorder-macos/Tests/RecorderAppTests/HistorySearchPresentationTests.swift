import Foundation
@testable import RecorderApp
import Testing

/// Pure HistorySearchPresentation mapping: hit rows (kind/id/provenance),
/// snippet marker rendering, episode.get → summary mapping, request shape,
/// failure copy. Calendar pinned to UTC like TimelineMappingTests.
struct HistorySearchPresentationTests {
    let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    private func ms(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Int64 {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.timeZone = TimeZone(identifier: "UTC")
        return Int64(
            calendar.date(from: components)!.timeIntervalSince1970 * 1000
        )
    }

    private func episodeHit(
        id: String = "01M0NP9G4HP0M1M64H8TC0VEKF",
        snippet: String = "summary"
    ) -> HistoryHit {
        HistoryHit(
            source: HistoryHitSource(
                episodeId: id,
                stepId: nil,
                startedAtMs: ms(2026, 8, 21, 9, 5),
                endedAtMs: ms(2026, 8, 21, 10, 30),
                appNames: ["Safari", ""],
                snippet: snippet
            ),
            score: 0.8
        )
    }

    private func stepHit(
        stepId: String = "01M0NP9G4HP0M1M64H8TC0VEK2",
        episodeId: String? = "01M0NP9G4HP0M1M64H8TC0VEKF"
    ) -> HistoryHit {
        HistoryHit(
            source: HistoryHitSource(
                episodeId: episodeId,
                stepId: stepId,
                startedAtMs: ms(2026, 8, 21, 11, 0),
                endedAtMs: ms(2026, 8, 21, 12, 0),
                appNames: [],
                snippet: "typed text"
            ),
            score: 0.5
        )
    }

    // MARK: - Hit rows

    @Test("rows preserve daemon rank order and label kinds by stepId presence")
    func rowOrderAndKinds() {
        let rows = HistorySearchPresentation.rows(
            from: [episodeHit(), stepHit(), stepHit(episodeId: nil)],
            calendar: calendar
        )
        // Daemon ranking order must NOT be re-sorted client-side.
        #expect(rows.map(\.kindLabel) == ["Episode", "Step", "Step"])
        #expect(rows[0].id == "ep:01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(rows[1].id == "step:01M0NP9G4HP0M1M64H8TC0VEK2")
        #expect(rows[2].id.hasPrefix("step:"))
    }

    @Test("linked hits carry their episode; unlinked steps are not openable")
    func openability() {
        let rows = HistorySearchPresentation.rows(
            from: [episodeHit(), stepHit(), stepHit(episodeId: nil)],
            calendar: calendar
        )
        #expect(rows[0].episodeId == "01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(rows[1].episodeId == "01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(rows[2].episodeId == nil)
    }

    @Test("provenance line reuses timeline formatting (time range, app fallback)")
    func provenanceFormatting() {
        let rows = HistorySearchPresentation.rows(
            from: [episodeHit(), stepHit()],
            calendar: calendar,
            now: Date(timeIntervalSince1970: Double(ms(2026, 8, 21, 23, 0)) / 1000)
        )
        // Same-day hits keep the compact range…
        #expect(rows[0].timeRangeText == "09:05–10:30")
        // Empty app names collapse to TimelinePresentation.unknownApp…
        #expect(rows[1].appNamesText == "Unknown")
        // …and blank names inside a non-empty list are filtered.
        #expect(rows[0].appNamesText == "Safari")
    }

    @Test("older hits gain a day prefix; other-year hits also carry the year")
    func dayContextPrefixes() {
        let sameYear = HistorySearchPresentation.rows(
            from: [episodeHit()],
            calendar: calendar,
            now: Date(timeIntervalSince1970: Double(ms(2026, 8, 26, 12, 0)) / 1000)
        )
        #expect(sameYear[0].timeRangeText == "Aug 21 · 09:05–10:30")

        let otherYear = HistorySearchPresentation.rows(
            from: [episodeHit(
                id: "01M0NP9G4HP0M1M64H8TC0VEK5",
                snippet: "older"
            )],
            calendar: calendar,
            now: Date(timeIntervalSince1970: Double(ms(2027, 3, 2, 12, 0)) / 1000)
        )
        #expect(otherYear[0].timeRangeText == "Aug 21 2026 · 09:05–10:30")
    }

    // MARK: - Results header

    @Test("header states an exact count below the page cap")
    func resultsTitleExact() {
        #expect(HistorySearchPresentation.resultsTitle(count: 1, query: "x") == "1 result for “x”")
        #expect(HistorySearchPresentation.resultsTitle(count: 3, query: "deploy") == "3 results for “deploy”")
    }

    @Test("a full page reads as a floor, never a fetched total")
    func resultsTitleClamped() {
        let limit = HistorySearchPresentation.searchLimit
        #expect(HistorySearchPresentation.resultsTitle(count: limit, query: "q") == "\(limit)+ results for “q”")
        #expect(HistorySearchPresentation.resultsTitle(count: limit + 5, query: "q") == "\(limit)+ results for “q”")
    }

    // MARK: - Snippet markers

    @Test("snippet <b> markers render as bold emphasis without leaking tags")
    func snippetEmphasis() {
        let attributed = HistorySearchPresentation.attributedSnippet("Deployed the <b>webhook</b> fix")
        #expect(String(attributed.characters) == "Deployed the webhook fix")

        let boldTexts = attributed.runs.compactMap { run -> String? in
            guard run.font != nil else { return nil }
            return String(attributed[run.range].characters)
        }
        #expect(boldTexts == ["webhook"])
    }

    @Test("multiple matches each get their own bold run")
    func multipleMatches() {
        let attributed = HistorySearchPresentation.attributedSnippet("<b>kubernetes</b> rollout on <b>kubernetes</b> prod")
        #expect(String(attributed.characters) == "kubernetes rollout on kubernetes prod")
        let boldCount = attributed.runs.filter { $0.font != nil }.count
        #expect(boldCount == 2)
    }

    @Test("stray or unmatched markers are stripped, never shown literally")
    func strayMarkers() {
        // Opener without closer: degrade to plain text, tag dropped.
        #expect(
            String(HistorySearchPresentation.attributedSnippet("broken <b>marker").characters)
                == "broken marker"
        )
        // Closer outside any bold run is noise.
        #expect(
            String(HistorySearchPresentation.attributedSnippet("</b>plain").characters)
                == "plain"
        )
        // No markers at all: verbatim passthrough.
        #expect(
            String(HistorySearchPresentation.attributedSnippet("nothing special").characters)
                == "nothing special"
        )
    }

    // MARK: - Request shape

    @Test("search requests pin both legs at the server page cap")
    func requestShape() {
        let params = HistorySearchPresentation.params(query: "deploy", scope: .both)
        #expect(params.query == "deploy")
        #expect(params.scope == .both)
        #expect(params.limit == HistorySearchPresentation.searchLimit)
        #expect(params.from == nil && params.to == nil && params.apps == nil)

        // Scope is a straight passthrough — the UI picker offers all three
        // wire values and the server owns filtering semantics.
        for scope in HistorySearchScope.allCases {
            #expect(HistorySearchPresentation.params(query: "x", scope: scope).scope == scope)
        }
    }

    // MARK: - Episode opening

    @Test("episodeSummary maps episode.get onto the timeline DTO with real title/apps")
    func episodeSummaryMapping() {
        let result = EpisodeGetResult(
            episode: EpisodeDto(
                id: "01M0NP9G4HP0M1M64H8TC0VEKF",
                startedAtMs: ms(2026, 8, 21, 9, 5),
                endedAtMs: ms(2026, 8, 21, 10, 30),
                title: "Shipped deploy pipeline",
                summary: "…",
                intent: nil,
                outcome: nil,
                apps: ["Terminal"],
                entities: [],
                summaryModel: nil,
                summaryPromptVersion: nil,
                createdAtMs: 0,
                updatedAtMs: 0
            ),
            steps: []
        )
        let summary = HistorySearchPresentation.episodeSummary(from: result)
        #expect(summary.id == "01M0NP9G4HP0M1M64H8TC0VEKF")
        #expect(summary.title == "Shipped deploy pipeline")
        #expect(summary.appNames == ["Terminal"])
        #expect(summary.stepCount == 0)
        #expect(summary.startedAtMs == result.episode.startedAtMs)
        #expect(summary.endedAtMs == result.episode.endedAtMs)
    }

    // MARK: - Failure copy

    @Test("disconnect reads as the stable connection-unavailable string")
    func failureCopy() {
        #expect(
            HistorySearchPresentation.failureMessage(DaemonClientError.notConnected)
                == "Daemon connection unavailable"
        )
        #expect(
            HistorySearchPresentation.failureMessage(DaemonClientError.badFrame("boom"))
                == DaemonClientError.badFrame("boom").localizedDescription
        )
    }
}
