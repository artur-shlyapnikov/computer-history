import SwiftUI

// MARK: - Pure presentation mapping (unit-tested; no view state)

/// Mapping from `history.search` wire hits onto timeline-search presentation
/// models (spec §3.18). The daemon's ranking order is TRUSTED and never
/// re-sorted here: textual queries arrive BM25-best-first (score order),
/// filter-only listings arrive newest-first.
///
/// Hit snippets carry SQLite `snippet()` markers (`<b>match</b>` around each
/// matched term, `…` ellipses); `attributedSnippet` renders those markers as
/// real emphasis instead of leaking tags into the UI.
enum HistorySearchPresentation {
    /// Page cap; the server clamps to `MAX_SEARCH_LIMIT` (50) anyway.
    static let searchLimit = 50

    /// Section header for the results list. The request pins `limit` at the
    /// server page cap, so a full page is a floor rather than a total —
    /// «50+» admits more may exist instead of stating a count never fetched.
    static func resultsTitle(count: Int, query: String) -> String {
        count >= searchLimit
            ? "\(searchLimit)+ results for “\(query)”"
            : "\(count) result\(count == 1 ? "" : "s") for “\(query)”"
    }

    /// Builds the pinned search request for a submitted query string and
    /// user-chosen scope (episodes / steps / both).
    static func params(query: String, scope: HistorySearchScope) -> HistorySearchParams {
        HistorySearchParams(
            query: query,
            from: nil,
            to: nil,
            apps: nil,
            scope: scope,
            limit: searchLimit
        )
    }

    /// One hit rendered as a result row.
    struct HitRowModel: Identifiable, Equatable {
        /// «ep:<episodeId>» / «step:<stepId>» («ep:unknown:<rank index>» for
        /// the unreachable case of an episode leg missing its id) — stable
        /// across re-renders so identical result sets do not churn List
        /// identity.
        let id: String
        /// Provenance chip («Episode» / «Step»).
        let kindLabel: String
        /// Snippet with match markers rendered as emphasis.
        let snippet: AttributedString
        /// Owning-episode span in the injected calendar, day-aware: compact
        /// «HH:mm–HH:mm» same-day; older hits prefixed «MMM d ·», other
        /// years «MMM d yyyy ·».
        let timeRangeText: String
        let appNamesText: String
        /// Owning episode when one exists; nil for UNLINKED steps (spec
        /// §3.24: steps stay searchable before any episode exists) — such
        /// rows render without an open affordance.
        let episodeId: String?
    }

    /// Wire hits → rows, preserving daemon rank order. A step hit is
    /// distinguished by carrying `stepId`; everything else is an episode hit.
    static func rows(from hits: [HistoryHit], calendar: Calendar, now: Date = Date()) -> [HitRowModel] {
        hits.enumerated().map { index, hit in
            let kind: (label: String, id: String) = if let stepId = hit.source.stepId {
                ("Step", "step:\(stepId)")
            } else if let episodeId = hit.source.episodeId {
                ("Episode", "ep:\(episodeId)")
            } else {
                // Server always sets episodeId today; the enumerated rank
                // index keeps this fallback unique per row (two id-less
                // episode legs would otherwise collide) yet stable across
                // re-renders of the same result set.
                ("Episode", "ep:unknown:\(index)")
            }
            return HitRowModel(
                id: kind.id,
                kindLabel: kind.label,
                snippet: attributedSnippet(hit.source.snippet),
                timeRangeText: TimelinePresentation.dayAwareTimeText(
                    startedAtMs: hit.source.startedAtMs,
                    endedAtMs: hit.source.endedAtMs,
                    calendar: calendar,
                    now: now
                ),
                appNamesText: TimelinePresentation.appNamesText(hit.source.appNames),
                episodeId: hit.source.episodeId
            )
        }
    }

    /// Renders SQLite `snippet()` output as an AttributedString: text between
    /// `<b>`…`</b>` becomes bold, stray unmatched markers are stripped rather
    /// than shown literally. Unmatched `<b>` (no closer) degrades to plain
    /// text with the tag dropped.
    static func attributedSnippet(_ raw: String) -> AttributedString {
        var out = AttributedString()
        var rest = raw[...]
        while let start = rest.range(of: "<b>") {
            out += AttributedString(stripStrayClosers(rest[..<start.lowerBound]))
            rest = rest[start.upperBound...]
            if let end = rest.range(of: "</b>") {
                var emphasized = AttributedString(rest[..<end.lowerBound])
                emphasized.font = .body.bold()
                out += emphasized
                rest = rest[end.upperBound...]
            }
        }
        out += AttributedString(stripStrayClosers(rest))
        return out
    }

    /// Close markers outside any bold run are literal noise; drop them.
    private static func stripStrayClosers(_ text: Substring) -> String {
        text.replacingOccurrences(of: "</b>", with: "")
    }

    /// Maps an `episode.get` payload onto the timeline summary DTO so a hit
    /// can open `EpisodeDetailView` with the REAL title/apps (the detail view
    /// re-fetches full provenance itself; stepCount derives from the served
    /// step list, pendingJobs is irrelevant off the timeline badge).
    static func episodeSummary(from result: EpisodeGetResult) -> EpisodeSummaryDto {
        EpisodeSummaryDto(
            id: result.episode.id,
            startedAtMs: result.episode.startedAtMs,
            endedAtMs: result.episode.endedAtMs,
            title: result.episode.title,
            appNames: result.episode.apps,
            stepCount: result.steps.count,
            pendingJobs: 0
        )
    }

    /// User-facing text for a failed search roundtrip — deliberate parity
    /// with AppState.failureMessage: a disconnect reads as the stable
    /// «Daemon connection unavailable» string everywhere.
    static func failureMessage(_ error: Error) -> String {
        if case DaemonClientError.notConnected = error {
            return "Daemon connection unavailable"
        }
        return error.localizedDescription
    }
}

// MARK: - Search phases + results surface

/// Content phase for the timeline search field: `.idle` shows the regular
/// day-grouped timeline; a submitted query swaps the content for ranked hits.
enum TimelineSearchPhase: Equatable {
    case idle
    case loading
    case results([HistorySearchPresentation.HitRowModel])
    case failed(String)
}

/// Ranked `history.search` results: one row per hit (kind chip · snippet ·
/// time · apps). Rows with a linked episode invoke `onOpen`; unlinked steps
/// render disabled.
struct HistorySearchResultsView: View {
    let phase: TimelineSearchPhase
    let query: String
    let onOpen: (HistorySearchPresentation.HitRowModel) -> Void

    var body: some View {
        switch phase {
        case .idle:
            EmptyView()
        case .loading:
            ProgressView("Searching…")
        case let .results(rows):
            if rows.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    Section(HistorySearchPresentation.resultsTitle(count: rows.count, query: query)) {
                        ForEach(rows) { row in
                            HitRowView(row: row, onOpen: onOpen)
                        }
                    }
                }
            }
        case let .failed(message):
            ContentUnavailableView(
                "Search failed",
                systemImage: "magnifyingglass.badge.xmark",
                description: Text(message)
            )
        }
    }
}

/// One search hit row. The whole row opens the owning episode when one is
/// linked; unlinked steps (no episode yet) render without an affordance.
private struct HitRowView: View {
    let row: HistorySearchPresentation.HitRowModel
    let onOpen: (HistorySearchPresentation.HitRowModel) -> Void

    var body: some View {
        Button {
            onOpen(row)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.kindLabel)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(row.timeRangeText)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(row.snippet)
                    .font(.subheadline)
                    .lineLimit(3)
                Text(row.appNamesText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
        .disabled(row.episodeId == nil)
        .accessibilityHint(row.episodeId == nil ? "" : "Opens the episode")
    }
}
