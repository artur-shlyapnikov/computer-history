import SwiftUI

// MARK: - Pure presentation mapping (unit-tested; no view state)

/// Deterministic mapping from the `workflows.list` wire result onto
/// presentation models (spec §3.20; contracts §Protocol v1). Mirrors the
/// MemoriesPresentation pattern: pure functions, injected calendar/time.
enum WorkflowsPresentation {
    /// Spec §3.20 headline shown on every candidate card.
    static let candidateHeadline = "You seem to repeat this workflow."

    /// "1 occurrence" / "N occurrences" — singular-aware card meta copy.
    static func occurrenceCountText(_ count: Int) -> String {
        count == 1 ? "1 occurrence" : "\(count) occurrences"
    }

    /// One occurrence rendered as a row: similarity % + wall-clock date.
    struct OccurrenceRowModel: Identifiable, Equatable {
        let id: String
        let episodeId: String
        /// Similarity rendered as an integer percent, e.g. "84%".
        let similarityText: String
        /// "HH:mm MMM d" wall-clock text pinned to the injected calendar.
        let startedAtText: String
    }

    /// One workflow card.
    struct CardModel: Identifiable, Equatable {
        let id: String
        let workflow: WorkflowListItem
        /// Spec §3.20 headline («You seem to repeat this workflow.»).
        let headline: String
        let name: String
        let purposeText: String?
        let preconditions: [String]
        let stableSteps: [String]
        let variableInputs: [String]
        let expectedOutcomeText: String?
        /// Median within-cluster similarity as an integer percent.
        let medianSimilarityText: String
        /// Occurrences newest-first (wire order preserved), % + date each.
        let occurrences: [OccurrenceRowModel]
        /// True total from the wire; the ledger array may be a newest-N
        /// window (daemon PERF-06 cap) rather than every occurrence.
        let occurrenceCount: Int
        /// Candidate cards offer Confirm/Reject; confirmed/rejected are final.
        let offersActions: Bool
    }

    /// Maps one wire item onto its card model. Occurrence order is trusted
    /// from the wire (newest-first per the M6 contract); template fields fall
    /// back to nothing so partially synthesized templates render honestly.
    static func card(
        for workflow: WorkflowListItem,
        calendar: Calendar = .current
    ) -> CardModel {
        CardModel(
            id: workflow.id,
            workflow: workflow,
            headline: candidateHeadline,
            name: workflow.name,
            purposeText: workflow.template.purpose ?? workflow.purpose,
            preconditions: workflow.template.preconditions ?? [],
            stableSteps: workflow.template.stableSteps ?? [],
            variableInputs: workflow.template.variableInputs ?? [],
            expectedOutcomeText: workflow.template.expectedOutcome,
            medianSimilarityText: percentText(workflow.medianSimilarity),
            occurrences: workflow.occurrences.enumerated().map { offset, occurrence in
                OccurrenceRowModel(
                    // ForEach identity must be unique even if the daemon ever
                    // repeats an episodeId within one workflow's ledger.
                    id: "\(occurrence.episodeId)#\(offset)",
                    episodeId: occurrence.episodeId,
                    similarityText: percentText(occurrence.similarity),
                    startedAtText: startedAtText(ms: occurrence.startedAtMs, calendar: calendar)
                )
            },
            occurrenceCount: workflow.occurrenceCount,
            offersActions: workflow.status == .candidate
        )
    }

    /// Cards sorted newest-lastSeen first regardless of wire order.
    static func cards(from workflows: [WorkflowListItem], calendar: Calendar = .current) -> [CardModel] {
        // Tie-break on id: Swift's sort is not stable and equal lastSeenAtMs
        // would reshuffle card order between refreshes.
        workflows
            .sorted {
                $0.lastSeenAtMs != $1.lastSeenAtMs
                    ? $0.lastSeenAtMs > $1.lastSeenAtMs : $0.id < $1.id
            }
            .map { card(for: $0, calendar: calendar) }
    }

    static func percentText(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    /// "HH:mm MMM d" wall-clock text pinned to the injected calendar/timezone.
    /// Confirmed workflows persist across years, so occurrences from any
    /// calendar year other than `now`'s append the year ("HH:mm MMM d yyyy");
    /// current-year output stays byte-identical to the compact form.
    static func startedAtText(ms: Int64, calendar: Calendar, now: Date = Date()) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let format =
            calendar.component(.year, from: date) == calendar.component(.year, from: now)
                ? "HH:mm MMM d"
                : "HH:mm MMM d yyyy"
        return CachedDateFormatters.shared.formatter(calendar: calendar, format: format)
            .string(from: date)
    }
}

// MARK: - Optimistic-update reducer (pure; unit-tested)

/// Pure state transitions for Confirm/Reject over the flat workflow list.
/// The view-model applies the optimistic shape immediately, snapshots the
/// prior list, and either merges the daemon-confirmed result or rolls back
/// to the snapshot on any error.
enum WorkflowsReducer {
    /// Optimistically applies a user action BEFORE the daemon confirms:
    /// confirm flips status to confirmed, reject to rejected, in place
    /// (list order untouched). Returns nil when the id is unknown locally
    /// (caller proceeds without local mutation).
    static func optimisticList(
        action: WorkflowActionKind,
        id: String,
        workflows: [WorkflowListItem]
    ) -> [WorkflowListItem]? {
        guard let index = workflows.firstIndex(where: { $0.id == id }) else { return nil }
        var next = workflows
        next[index].status = action == .confirm ? .confirmed : .rejected
        return next
    }

    /// Rebuilds a list item from an authoritative (occurrence-less) WorkflowDto
    /// answer plus the occurrences already held locally.
    static func item(
        from updated: WorkflowDto,
        occurrences: [WorkflowOccurrenceDto]
    ) -> WorkflowListItem {
        WorkflowListItem(
            id: updated.id,
            name: updated.name,
            purpose: updated.purpose,
            status: updated.status,
            template: updated.template,
            occurrenceCount: updated.occurrenceCount,
            medianSimilarity: updated.medianSimilarity,
            firstSeenAtMs: updated.firstSeenAtMs,
            lastSeenAtMs: updated.lastSeenAtMs,
            createdAtMs: updated.createdAtMs,
            updatedAtMs: updated.updatedAtMs,
            occurrences: occurrences
        )
    }

    /// Merges the daemon's authoritative answer after a successful action:
    /// confirm/reject replace the row's DTO fields (local occurrences kept),
    /// `updated:nil` (row vanished concurrently, e.g. delete cascade) drops it.
    static func list(
        applyingServerResult updated: WorkflowDto?,
        id: String,
        to workflows: [WorkflowListItem]
    ) -> [WorkflowListItem] {
        guard let updated else { return workflows.filter { $0.id != id } }
        guard let index = workflows.firstIndex(where: { $0.id == id }) else {
            return workflows
        }
        var next = workflows
        next[index] = item(from: updated, occurrences: next[index].occurrences)
        return next
    }

    /// Error path: restores the exact pre-action snapshot and lets the caller
    /// surface the failure message alongside.
    static func rollback(to snapshot: [WorkflowListItem]) -> [WorkflowListItem] {
        snapshot
    }
}

// MARK: - Workflows window (spec §3.20; spec §3.26 Workflows surface)

/// Candidate-workflow review surface: «You seem to repeat this workflow.»
/// cards with name/purpose/preconditions/stableSteps/variableInputs/
/// expectedOutcome, the occurrence list (similarity % + dates), and wired
/// Confirm/Reject through AppState's optimistic-action machine.
struct WorkflowsView: View {
    /// Collapsed occurrence-toggle title: honest about the window size
    /// when the ledger is truncated, plain "Show all N" when it is
    /// complete. Pure so the label pins can hold it exactly.
    nonisolated static func collapsedToggleTitle(shipped: Int, total: Int) -> String {
        total > shipped
            ? "Show newest \(shipped) of \(total)"
            : "Show all \(shipped)"
    }

    /// Caption for the not-loaded tail of a truncated ledger.
    nonisolated static func truncatedLedgerCaption(shipped: Int, total: Int) -> String {
        "Older occurrences not loaded (\(total - shipped) not shown)"
    }

    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Workflows")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await appState.refreshWorkflows() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(appState.workflowsPhase == .loading)
                        .accessibilityLabel("Refresh workflows")
                        .keyboardShortcut("r", modifiers: .command)
                    }
                }
        }
        .frame(minWidth: 480, minHeight: 560)
        .task { await appState.refreshWorkflows() }
    }

    @ViewBuilder
    private var content: some View {
        switch appState.workflowsPhase {
        case let .failed(message) where appState.workflows.isEmpty:
            ContentUnavailableView(
                "Workflows unavailable",
                systemImage: "arrow.triangle.branch",
                description: Text(message)
            )
        case .idle, .loading:
            if appState.workflows.isEmpty {
                ProgressView("Loading workflows…")
            } else {
                list
            }
        default:
            list
        }
    }

    private var list: some View {
        // Precomputed at commit in AppState (workflowCards); body evals fire
        // on every AppState invalidation, not just workflows refreshes.
        let cards = appState.workflowCards
        return List {
            if cards.isEmpty {
                Text("No workflows discovered yet — repeating patterns surface here as candidates.")
                    .foregroundStyle(.secondary)
            }
            if let error = appState.workflowsActionError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            if case let .failed(message) = appState.workflowsPhase {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            ForEach(cards) { card in
                WorkflowCardView(
                    card: card,
                    onConfirm: { Task { await appState.runWorkflowAction(id: card.id, action: .confirm) } },
                    onReject: { Task { await appState.runWorkflowAction(id: card.id, action: .reject) } }
                )
            }
        }
        .textSelection(.enabled)
    }
}

/// One workflow card: candidate headline, name, purpose, preconditions,
/// stable steps vs variable inputs, expected outcome, occurrence history,
/// and Confirm/Reject for candidates only.
private struct WorkflowCardView: View {
    /// Occurrence rows render eagerly inside one List row; a years-old
    /// confirmed workflow can carry thousands, so only the newest N render
    /// until "Show all" expands.
    static let visibleOccurrenceLimit = 10

    let card: WorkflowsPresentation.CardModel
    let onConfirm: () -> Void
    let onReject: () -> Void

    @State private var showAllOccurrences = false

    private var displayedOccurrences: [WorkflowsPresentation.OccurrenceRowModel] {
        showAllOccurrences
            ? card.occurrences
            : Array(card.occurrences.prefix(Self.visibleOccurrenceLimit))
    }

    /// True when `occurrenceCount` exceeds the shipped ledger window.
    private var isLedgerTruncated: Bool {
        card.occurrenceCount > card.occurrences.count
    }

    private var collapsedToggleTitle: String {
        WorkflowsView.collapsedToggleTitle(
            shipped: card.occurrences.count,
            total: card.occurrenceCount
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if card.offersActions {
                Text(card.headline)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Text(card.name)
                .font(.headline)
            if let purpose = card.purposeText {
                Text(purpose)
                    .font(.body)
            }
            metaLine

            if !card.preconditions.isEmpty {
                labeledList("Preconditions", items: card.preconditions)
            }
            if !card.stableSteps.isEmpty {
                labeledList("Stable steps", items: card.stableSteps)
            }
            if !card.variableInputs.isEmpty {
                labeledList("Variable inputs", items: card.variableInputs)
            }
            if let outcome = card.expectedOutcomeText {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Expected outcome").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(outcome).font(.callout)
                }
            }
            if !card.occurrences.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Occurrences (\(card.occurrenceCount))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(displayedOccurrences) { occurrence in
                        HStack {
                            Text(occurrence.startedAtText)
                            Spacer()
                            Text(occurrence.similarityText)
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
                    if isLedgerTruncated || card.occurrences.count > Self.visibleOccurrenceLimit {
                        Button(showAllOccurrences ? "Show fewer" : collapsedToggleTitle) {
                            showAllOccurrences.toggle()
                        }
                        .font(.caption)
                        .buttonStyle(.borderless)
                    }
                    // The daemon's occurrence ledger is a newest-N window
                    // (PERF-06 cap); when the wire total exceeds what shipped,
                    // say so instead of implying the list is complete.
                    if isLedgerTruncated, showAllOccurrences {
                        Text(
                            WorkflowsView.truncatedLedgerCaption(
                                shipped: card.occurrences.count,
                                total: card.occurrenceCount
                            )
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }

            if card.offersActions {
                HStack {
                    Button("Confirm") { onConfirm() }
                        .buttonStyle(.borderedProminent)
                    Button("Reject") { onReject() }
                        .buttonStyle(.bordered)
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }

    private var metaLine: some View {
        HStack(spacing: 8) {
            Text(card.workflow.status.rawValue)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("median \(card.medianSimilarityText)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(WorkflowsPresentation.occurrenceCountText(card.workflow.occurrenceCount))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func labeledList(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(items, id: \.self) { item in
                Text("• \(item)").font(.callout)
            }
        }
    }
}
