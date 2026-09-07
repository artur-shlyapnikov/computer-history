import SwiftUI

// MARK: - Pure presentation mapping (unit-tested; no view state)

/// Deterministic mapping from wire DTOs onto timeline presentation models.
/// All time math flows through an injected `Calendar` so tests pin the
/// timezone; nothing here reads the clock except through the `now` argument.
///
/// M3 data source: rows come from `timeline.list` episode summaries
/// (contracts §Protocol v1). `segments.list` survives only as the DETAIL
/// fallback when an episode's record can no longer be served by `episode.get`.
enum TimelinePresentation {
    /// Fallback app label when an item carries no app names at all.
    static let unknownApp = "Unknown"

    /// One episode rendered as a timeline row.
    struct EpisodeRowModel: Identifiable, Equatable {
        let id: String
        let episode: EpisodeSummaryDto
        /// "HH:mm–HH:mm" in the injected calendar.
        let timeRangeText: String
        /// App names joined with "·"; «Unknown» when empty.
        let appNamesText: String
        let stepCount: Int
    }

    /// One day bucket («Today» / «Yesterday» / formatted date) newest first.
    struct SectionModel: Identifiable, Equatable {
        let dayTitle: String
        let rows: [EpisodeRowModel]

        var id: String {
            dayTitle
        }
    }

    /// One provenance step rendered inside the detail view.
    struct StepRowModel: Equatable {
        let id: String
        /// Human action label («Typed», «Scrolled», …; raw wire value if unpinned).
        let actionLabel: String
        /// "HH:mm–HH:mm" source range.
        let timeRangeText: String
        /// appName (bundle id fallback) · target.
        let provenanceText: String
        /// Non-empty text preview, nil otherwise.
        let textPreview: String?
    }

    // MARK: Row mapping

    /// App display line: names joined with "·"; «Unknown» when none survive.
    static func appNamesText(_ appNames: [String]) -> String {
        let nonEmpty = appNames.filter { !$0.isEmpty }
        return nonEmpty.isEmpty ? unknownApp : nonEmpty.joined(separator: "·")
    }

    /// "1 step" / "3 steps" — singular-aware row count copy.
    static func stepCountText(_ count: Int) -> String {
        count == 1 ? "1 step" : "\(count) steps"
    }

    /// "HH:mm" wall-clock text pinned to the injected calendar/timezone.
    static func clockText(ms: Int64, calendar: Calendar) -> String {
        CachedDateFormatters.shared
            .formatter(calendar: calendar, format: "HH:mm")
            .string(from: date(ms: ms))
    }

    /// Row/detail time range over a closed [startedAtMs, endedAtMs] window.
    static func timeRange(startedAtMs: Int64, endedAtMs: Int64, calendar: Calendar) -> String {
        "\(clockText(ms: startedAtMs, calendar: calendar))–\(clockText(ms: endedAtMs, calendar: calendar))"
    }

    /// Convenience for episode summaries (episodes are always closed windows).
    static func timeRange(for episode: EpisodeSummaryDto, calendar: Calendar) -> String {
        timeRange(startedAtMs: episode.startedAtMs, endedAtMs: episode.endedAtMs, calendar: calendar)
    }

    /// Time range with day context for date-less surfaces — search hits and
    /// the episode detail header (deep-linked from search) otherwise show a
    /// bare «HH:mm–HH:mm» that is ambiguous across days. Same-day ranges stay
    /// compact; older ranges prepend «MMM d ·», other years «MMM d yyyy ·».
    /// Classification is by the START day, matching timeline day-grouping:
    /// an episode ending after midnight keeps its start-day prefix.
    /// `now` is injectable so tests pin the reference day.
    static func dayAwareTimeText(
        startedAtMs: Int64,
        endedAtMs: Int64,
        calendar: Calendar,
        now: Date = Date()
    ) -> String {
        dayAwarePrefix(for: date(ms: startedAtMs), calendar: calendar, now: now)
            + timeRange(startedAtMs: startedAtMs, endedAtMs: endedAtMs, calendar: calendar)
    }

    /// Day-context prefix for a start timestamp: "" for today,
    /// «MMM d · » this year, «MMM d yyyy · » otherwise.
    static func dayAwarePrefix(for start: Date, calendar: Calendar, now: Date) -> String {
        guard !calendar.isDate(start, inSameDayAs: now) else { return "" }
        let sameYear = calendar.component(.year, from: start) == calendar.component(.year, from: now)
        let day = CachedDateFormatters.shared
            .formatter(calendar: calendar, format: sameYear ? "MMM d" : "MMM d yyyy")
            .string(from: start)
        return "\(day) · "
    }

    /// Footer for the timeline list. The request pins `limit` at the
    /// server's hard cap (`defaultLimit == maxLimit == 50` — no pagination),
    /// so a full page is a floor: older episodes exist but are never listed
    /// here. «nil» below the cap, when the window is plausibly complete.
    static func truncationFooter(count: Int) -> String? {
        guard count >= TimelineListDefaults.defaultLimit else { return nil }
        return "Showing the \(TimelineListDefaults.defaultLimit) most recent episodes — older history isn't listed here, but stays searchable."
    }

    // MARK: Day grouping

    /// «Today» / «Yesterday» / abbreviated date. An episode spanning midnight
    /// groups under its START day (its identity anchor), never split.
    static func dayTitle(for date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return "Today"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday)
        {
            return "Yesterday"
        }
        return date.formatted(
            Date.FormatStyle(
                date: .abbreviated,
                time: .omitted,
                locale: calendar.locale ?? Locale.autoupdatingCurrent,
                calendar: calendar
            )
        )
    }

    /// «Today»/«Yesterday»/date convenience over an epoch-ms timestamp.
    static func dayTitle(startedAtMs: Int64, now: Date, calendar: Calendar) -> String {
        dayTitle(for: date(ms: startedAtMs), now: now, calendar: calendar)
    }

    /// Groups newest-first episodes into day sections. Input order is not
    /// trusted: rows sort by startedAtMs descending inside each section and
    /// sections by start-of-day descending.
    static func sections(
        from episodes: [EpisodeSummaryDto],
        now: Date,
        calendar: Calendar = .current
    ) -> [SectionModel] {
        // Swift's sort is not stable: episodes sharing a startedAtMs (bulk
        // import/backfill) would reshuffle between polls and churn List
        // diffs. Tie-break on id for a total order.
        let sorted = episodes.sorted {
            $0.startedAtMs != $1.startedAtMs ? $0.startedAtMs > $1.startedAtMs : $0.id < $1.id
        }
        var buckets: [Date: [EpisodeRowModel]] = [:]
        var dayOrder: [Date] = []
        for episode in sorted {
            let startDay = calendar.startOfDay(for: date(ms: episode.startedAtMs))
            if buckets[startDay] == nil {
                dayOrder.append(startDay)
            }
            buckets[startDay, default: []].append(
                EpisodeRowModel(
                    id: episode.id,
                    episode: episode,
                    timeRangeText: timeRange(for: episode, calendar: calendar),
                    appNamesText: appNamesText(episode.appNames),
                    stepCount: episode.stepCount
                )
            )
        }
        return dayOrder.sorted(by: >).map { day in
            SectionModel(
                dayTitle: dayTitle(for: day, now: now, calendar: calendar),
                rows: buckets[day] ?? []
            )
        }
    }

    // MARK: Detail mapping

    /// Steps ordered by ordinal ascending (daemon contract; input not trusted).
    static func orderedSteps(_ steps: [SemanticStepDto]) -> [SemanticStepDto] {
        steps.sorted { $0.ordinal < $1.ordinal }
    }

    /// Provenance rows for the detail step list: human action labels, source
    /// time ranges, app/target line and a trimmed text preview when present.
    static func stepRowModels(from steps: [SemanticStepDto], calendar: Calendar) -> [StepRowModel] {
        orderedSteps(steps).map { step in
            StepRowModel(
                id: step.id,
                actionLabel: humanActionLabel(for: step.action),
                timeRangeText: timeRange(startedAtMs: step.startedAtMs, endedAtMs: step.endedAtMs, calendar: calendar),
                provenanceText: provenanceLine(step),
                textPreview: step.text.flatMap { $0.isEmpty ? nil : $0 }
            )
        }
    }

    /// Detail fallback: when `episode.get` cannot serve the episode (purged
    /// steps / deleted record), render the raw segment covering its window.
    /// Picks the segment whose [start, end] window contains the episode's
    /// start; ties resolve to the closest start timestamp; open-ended
    /// segments match while started on or before the episode start.
    static func fallbackSegment(
        for episode: EpisodeSummaryDto,
        in segments: [SegmentSummaryDto]
    ) -> SegmentSummaryDto? {
        let candidates = segments.filter { segment in
            segment.startedAtMs <= episode.startedAtMs
                && (segment.endedAtMs.map { $0 >= episode.startedAtMs } ?? true)
        }
        return candidates.min { abs($0.startedAtMs - episode.startedAtMs) < abs($1.startedAtMs - episode.startedAtMs) }
    }

    // MARK: Step labels (pinned coalescer kinds → human strings)

    static func humanActionLabel(for action: String) -> String {
        switch action {
        case "focus": "Focused"
        case "edit_text": "Edited text"
        case "text_edit": "Edited text"
        case "switch_app": "Switched to"
        case "scroll": "Scrolled"
        case "click": "Clicked"
        case "type": "Typed"
        case "shortcut": "Shortcut"
        case "window_change": "Window changed"
        default: action
        }
    }

    // MARK: Helpers

    private static func provenanceLine(_ step: SemanticStepDto) -> String {
        var parts: [String] = []
        parts.append(step.appName ?? step.appBundleId)
        if let target = step.target, !target.isEmpty {
            parts.append(target)
        }
        return parts.joined(separator: " · ")
    }

    static func date(ms: Int64) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1000)
    }
}

// MARK: - Queue badge state machine (spec §3.24)

/// Pure badge mapping for the daemon job queue: any waiting work (pending +
/// retrying, folded server-side into one `pendingJobs` count) shows
/// «N activities waiting for processing»; zero hides the indicator.
enum QueueBadge {
    static func badgeText(forPendingJobs count: Int) -> String? {
        guard count > 0 else { return nil }
        let noun = count == 1 ? "activity" : "activities"
        return "\(count) \(noun) waiting for processing"
    }
}

// MARK: - Timeline view

/// Episode timeline over `timeline.list`: day-grouped List with 5s
/// auto-refresh (owned by AppState polling), a manual refresh button, and a
/// server-backed search field (`history.search`, spec §3.18) whose ranked
/// hits replace the timeline while a query is active.
struct TimelineView: View {
    @EnvironmentObject private var appState: AppState
    /// Runs one `history.search` roundtrip (wired by the app entry point);
    /// nil in tests/previews → submit degrades to an honest failure state.
    var search: (@MainActor (_ query: String, _ scope: HistorySearchScope) async throws -> HistorySearchResult)?
    /// Loads the summary for opening a hit's episode (`episode.get` mapped
    /// onto the timeline DTO); nil leaves hit rows render-only.
    var loadEpisodeSummary: (@MainActor (_ id: String) async throws -> EpisodeSummaryDto)?

    @State private var searchText = ""
    @State private var searchPhase: TimelineSearchPhase = .idle
    @State private var lastQuery = ""
    /// Scope for the server-backed search; changing it re-runs an active
    /// query so the picker feels live.
    @State private var searchScope: HistorySearchScope = .both
    /// Stale-response guard: only the newest submitted generation commits.
    @State private var searchGeneration = 0
    /// Episode pushed from a search hit (fetched summary; see openHit).
    @State private var openedEpisode: OpenedEpisode?
    @State private var openError: String?
    /// Stale-open guard for openHit: rapid taps must not interleave
    /// last-write-wins episode summaries/errors (same pattern as
    /// `searchGeneration`).
    @State private var openGeneration = 0

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Timeline")
                .searchable(text: $searchText, placement: .toolbar, prompt: "Search history")
                .onSubmit(of: .search) { runSearch() }
                // Clearing the field returns to the plain timeline and
                // invalidates any in-flight search roundtrip.
                .onChange(of: searchText) { _, newValue in
                    if newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        clearSearch()
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await appState.refreshTimeline() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(appState.timelinePhase == .loading)
                        .accessibilityLabel("Refresh timeline")
                        .keyboardShortcut("r", modifiers: .command)
                    }
                    ToolbarItem(placement: .secondaryAction) {
                        Picker("Search scope", selection: $searchScope) {
                            Text("All").tag(HistorySearchScope.both)
                            Text("Episodes").tag(HistorySearchScope.episodes)
                            Text("Steps").tag(HistorySearchScope.steps)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityLabel("Search scope")
                    }
                }
                // A scope change on an active query re-runs the search;
                // the generation guard retires the previous roundtrip.
                .onChange(of: searchScope) { _, _ in
                    if !lastQuery.isEmpty {
                        runSearch()
                    }
                }
                .navigationDestination(item: $openedEpisode) { item in
                    EpisodeDetailView(episode: item.summary)
                }
        }
        .frame(minWidth: 480, minHeight: 560)
        .task { await appState.refreshTimeline() }
    }

    @ViewBuilder
    private var content: some View {
        // An active search replaces EVERY timeline phase: searching must not
        // wait for (or be blocked by) the 5s timeline poll cycle.
        if searchPhase == .idle {
            VStack(spacing: 0) {
                pausedBanner
                timelineContent
            }
        } else {
            searchContent
        }
    }

    /// In-window capture-pause awareness. The menu-bar popover carries the
    /// pause reason, but a Timeline window that has stopped growing gives no
    /// hint why — a daemon-initiated pause (disk pressure) surfaces the
    /// daemon's own line, a local pause gets neutral copy. Search results are
    /// historical, so the banner only fronts the live timeline.
    @ViewBuilder
    private var pausedBanner: some View {
        if let daemonLine = appState.daemonPausedStatusLine {
            Label(daemonLine, systemImage: "externaldrive.badge.exclamationmark")
                .font(.callout)
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.orange.opacity(0.12))
                .accessibilityElement(children: .combine)
            Divider()
        } else if appState.recordingState.isPaused {
            Label("Recording paused", systemImage: "pause.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.08))
                .accessibilityElement(children: .combine)
            Divider()
        }
    }

    @ViewBuilder
    private var timelineContent: some View {
        switch appState.timelinePhase {
        case .idle:
            ProgressView("Loading timeline…")
        case .loading where appState.timelineEpisodes.isEmpty:
            ProgressView("Loading timeline…")
        case let .failed(message) where appState.timelineEpisodes.isEmpty:
            ContentUnavailableView(
                "Timeline unavailable",
                systemImage: "clock.badge.xmark",
                description: Text(message)
            )
        case .loaded where appState.timelineEpisodes.isEmpty:
            // First run: capture is working but nothing has distilled yet.
            // A bare List would render as a silent blank window.
            ContentUnavailableView(
                "No history yet",
                systemImage: "clock.badge.questionmark",
                description: Text(
                    "Events appear here as you use your Mac. If nothing shows up, check that the Accessibility permission is granted in System Settings."
                )
            )
        default:
            list
        }
    }

    private var searchContent: some View {
        VStack(spacing: 0) {
            // Opening a hit fetches its episode first; that roundtrip can
            // fail (purged episode / offline daemon) and must stay visible.
            if let openError {
                Text(openError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                Divider()
            }
            HistorySearchResultsView(
                phase: searchPhase,
                query: lastQuery,
                onOpen: openHit
            )
        }
    }

    // MARK: Search actions

    private func runSearch() {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lastQuery = trimmed
        searchGeneration += 1
        let generation = searchGeneration
        guard let search else {
            searchPhase = .failed("Search is unavailable in this build.")
            return
        }
        searchPhase = .loading
        Task {
            do {
                let result = try await search(trimmed, searchScope)
                guard generation == searchGeneration else { return }
                searchPhase = .results(HistorySearchPresentation.rows(from: result.hits, calendar: .current))
            } catch {
                guard generation == searchGeneration else { return }
                searchPhase = .failed(HistorySearchPresentation.failureMessage(error))
            }
        }
    }

    /// Field cleared → back to the plain timeline; bumps both generations so
    /// a late response can neither repopulate stale results nor commit an
    /// in-flight hit-open.
    private func clearSearch() {
        searchGeneration += 1
        openGeneration += 1
        lastQuery = ""
        searchPhase = .idle
        openError = nil
    }

    /// Opens a hit's owning episode: fetches the real title/apps FIRST (the
    /// detail view's nav title comes from the passed summary and would
    /// otherwise stay stuck on snippet text), THEN pushes.
    private func openHit(_ row: HistorySearchPresentation.HitRowModel) {
        guard let episodeId = row.episodeId, let loadEpisodeSummary else { return }
        openGeneration += 1
        let generation = openGeneration
        openError = nil
        Task {
            do {
                let summary = try await loadEpisodeSummary(episodeId)
                guard generation == openGeneration else { return }
                openedEpisode = OpenedEpisode(summary: summary)
            } catch {
                guard generation == openGeneration else { return }
                openError = HistorySearchPresentation.failureMessage(error)
            }
        }
    }

    private var list: some View {
        // Sections are precomputed at refresh-commit in AppState; rebuilding
        // them here on every body evaluation (any AppState invalidation —
        // the 5s tick, chat chunks) was pure repeated sort/bucket/string work.
        let sections = appState.timelineSections
        return List {
            // Phase failures must stay visible even when stale rows are on
            // screen (the 5s poll can fail silently while data lingers).
            if case let .failed(message) = appState.timelinePhase {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            ForEach(sections) { section in
                Section(section.dayTitle) {
                    ForEach(section.rows) { row in
                        NavigationLink {
                            EpisodeDetailView(episode: row.episode)
                        } label: {
                            TimelineRowView(row: row)
                        }
                    }
                }
            }
            if let truncationNotice = TimelinePresentation.truncationFooter(count: appState.timelineEpisodes.count) {
                Text(truncationNotice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// navigationDestination(item:) payload for a hit-opened episode. Hashable
/// by episode identity: the pushed screen is keyed on WHICH episode is open,
/// not on summary field churn.
private struct OpenedEpisode: Identifiable, Hashable {
    let summary: EpisodeSummaryDto

    var id: String {
        summary.id
    }

    static func == (lhs: OpenedEpisode, rhs: OpenedEpisode) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

/// One timeline row: title · HH:mm–HH:mm · apps joined "·" · stepCount.
private struct TimelineRowView: View {
    let row: TimelinePresentation.EpisodeRowModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.episode.title)
                    .font(.body)
                    .lineLimit(1)
                Spacer()
                Text(row.timeRangeText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text(row.appNamesText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Text(TimelinePresentation.stepCountText(row.stepCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Episode detail: title/summary/intent/outcome/entities/apps plus the
/// provenance step list with source timestamps. When the daemon can no longer
/// serve the episode (`episode.get` fails — e.g. purged steps), falls back to
/// the raw `segments.list` segment covering the episode's window.
struct EpisodeDetailView: View {
    enum DetailContent: Equatable {
        case episode(EpisodeGetResult)
        /// Segment fallback carries its header labels precomputed: the app
        /// line groups every segment step, and body re-evaluation (any
        /// AppState invalidation while the detail is open) must not regroup
        /// per tick.
        case segment(SegmentSummaryDto, SegmentMeta)
    }

    struct SegmentMeta: Equatable {
        let timeRange: String
        let appLine: String
    }

    @EnvironmentObject private var appState: AppState
    let episode: EpisodeSummaryDto

    @State private var content: DetailContent?
    @State private var loadFailed = false
    /// Provenance rows precomputed in load(); the detail content is static
    /// after load, so re-sorting/re-mapping it on every body evaluation (any
    /// AppState invalidation while the detail is open) was pure waste.
    @State private var stepRows: [TimelinePresentation.StepRowModel] = []

    var body: some View {
        Group {
            if let content {
                detailList(content)
            } else if loadFailed {
                ContentUnavailableView {
                    Label("Episode unavailable", systemImage: "questionmark.circle")
                } description: {
                    Text("The daemon could not serve this episode.")
                } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView("Loading episode…")
            }
        }
        .navigationTitle(episode.title)
        // Re-runs when the daemon status changes: a detail opened while
        // disconnected (or after a transient failure) retries itself once the
        // connection is re-established instead of staying "unavailable".
        .task(id: appState.daemonStatus) { await load() }
    }

    private func load() async {
        // Already showing content (or a load is unnecessary): daemon-status
        // churn during reconnects must not re-fetch a successfully loaded
        // episode. A failed or never-loaded detail keeps retrying.
        guard content == nil || loadFailed else { return }
        loadFailed = false
        if let result = try? await appState.loadEpisodeDetail(episode.id) {
            content = .episode(result)
            stepRows = TimelinePresentation.stepRowModels(from: result.steps, calendar: .current)
            return
        }
        // Fallback: episode deleted or its steps purged — show the raw source
        // segment covering this window so provenance never silently vanishes.
        if let segments = try? await appState.loadSegmentFallback(),
           let match = TimelinePresentation.fallbackSegment(for: episode, in: segments)
        {
            content = .segment(
                match,
                SegmentMeta(timeRange: segmentTimeRange(match), appLine: segmentAppLine(match))
            )
            stepRows = TimelinePresentation.stepRowModels(from: match.steps, calendar: .current)
            return
        }
        content = nil
        stepRows = []
        loadFailed = true
    }

    private func detailList(_ content: DetailContent) -> some View {
        List {
            switch content {
            case let .episode(result):
                episodeHeader(result.episode)
                Section("Provenance") {
                    ForEach(stepRows, id: \.id) {
                        stepRow($0)
                    }
                }
            case let .segment(_, meta):
                Section {
                    LabeledContent("Time", value: meta.timeRange)
                    LabeledContent("Apps", value: meta.appLine)
                    Text("Episode summary unavailable — showing the raw source segment for this window.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Provenance") {
                    ForEach(stepRows, id: \.id) {
                        stepRow($0)
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    // MARK: Episode header

    private func episodeHeader(_ detail: EpisodeDto) -> some View {
        Section {
            LabeledContent(
                "Time",
                value: TimelinePresentation.dayAwareTimeText(
                    startedAtMs: detail.startedAtMs,
                    endedAtMs: detail.endedAtMs,
                    calendar: .current
                )
            )
            LabeledContent("Apps", value: TimelinePresentation.appNamesText(detail.apps))
            Text(detail.summary)
                .font(.body)
            LabeledContent("Intent", value: detail.intent ?? "—")
            LabeledContent("Outcome", value: detail.outcome ?? "—")
            if !detail.entities.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Entities").font(.caption).foregroundStyle(.secondary)
                    entityChips(detail.entities)
                }
            }
            if let model = detail.summaryModel, !model.isEmpty {
                LabeledContent("Summarized by", value: model)
            }
        }
    }

    private func entityChips(_ entities: [String]) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 72), spacing: 6)],
            alignment: .leading,
            spacing: 6
        ) {
            ForEach(entities, id: \.self) { entity in
                Text(entity)
                    .font(.caption)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
            }
        }
    }

    // MARK: Provenance steps

    private func stepRow(_ step: TimelinePresentation.StepRowModel) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(step.actionLabel)
                    .font(.headline)
                Spacer()
                Text(step.timeRangeText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(step.provenanceText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let text = step.textPreview {
                Text(text)
                    .font(.footnote)
                    .lineLimit(2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func segmentTimeRange(_ segment: SegmentSummaryDto) -> String {
        guard let endedAtMs = segment.endedAtMs else {
            return TimelinePresentation.dayAwarePrefix(
                for: TimelinePresentation.date(ms: segment.startedAtMs),
                calendar: .current,
                now: Date()
            ) + TimelinePresentation.clockText(ms: segment.startedAtMs, calendar: .current) + "–…"
        }
        return TimelinePresentation.dayAwareTimeText(
            startedAtMs: segment.startedAtMs,
            endedAtMs: endedAtMs,
            calendar: .current
        )
    }

    // MARK: Segment fallback helpers

    private func segmentAppLine(_ segment: SegmentSummaryDto) -> String {
        let names = Dictionary(grouping: segment.steps, by: \.appName)
            .keys.compactMap(\.self)
        return names.isEmpty ? TimelinePresentation.unknownApp : names.sorted().joined(separator: ", ")
    }
}
