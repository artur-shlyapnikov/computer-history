import SwiftUI

// MARK: - Pure presentation mapping (unit-tested; no view state)

/// Deterministic mapping from the grouped `memories.list` wire result onto
/// presentation models (spec §3.16–3.17; contracts §Protocol v1). Mirrors the
/// TimelinePresentation pattern: pure functions, injected calendar/time.
enum MemoriesPresentation {
    /// Fixed display order of the three user-facing sections. `superseded`
    /// rows are hidden unless explicitly requested from the daemon.
    static let displayOrder: [MemoriesGroupStatus] = [.confirmed, .suggestions, .rejected]

    /// Human section titles (spec §3.16: Confirmed / Suggestions / Rejected)
    /// with the row count — the review surface's work queue should announce
    /// its size without scrolling. Rendered sections are never empty.
    static func sectionTitle(for status: MemoriesGroupStatus, count: Int) -> String {
        switch status {
        case .confirmed: "Confirmed (\(count))"
        case .suggestions: "Suggestions (\(count))"
        case .rejected: "Rejected (\(count))"
        case .superseded: "Superseded (\(count))"
        }
    }

    /// One memory rendered as a row: text/kind/confidence/evidence/lastSeen.
    struct MemoryRowModel: Identifiable, Equatable {
        let id: String
        let memory: MemoryCandidateDto
        /// Group the row currently sits in (drives which actions are offered).
        let groupStatus: MemoriesGroupStatus
        /// "preference" / "fact" / "procedure".
        let kindText: String
        /// Confidence rendered as an integer percent, e.g. "86%".
        let confidenceText: String
        /// "3 evidence items"; singular "1 evidence item".
        let evidenceText: String
        /// Last-seen wall-clock text pinned to the injected calendar.
        let lastSeenText: String
    }

    /// One titled section of rows.
    struct SectionModel: Identifiable, Equatable {
        let status: MemoriesGroupStatus
        let title: String
        let rows: [MemoryRowModel]

        /// Stable across count changes: a counted title would re-identify
        /// the section on every optimistic action and churn the List diff.
        var id: String {
            status.rawValue
        }
    }

    /// Groups wire buckets into fixed-order sections. Input order is not
    /// trusted: rows sort by lastSeenAtMs descending inside each section,
    /// sections follow `displayOrder`; unknown-status buckets are dropped and
    /// empty sections are omitted so the view can render its own empty state.
    static func sections(
        from groups: [MemoriesListGroup],
        calendar: Calendar = .current
    ) -> [SectionModel] {
        displayOrder.compactMap { status in
            guard let group = groups.first(where: { $0.status == status }), !group.memories.isEmpty
            else { return nil }
            let rows = group.memories
                .sorted {
                    $0.lastSeenAtMs != $1.lastSeenAtMs
                        ? $0.lastSeenAtMs > $1.lastSeenAtMs : $0.id < $1.id
                }
                .map { rowModel(for: $0, groupStatus: status, calendar: calendar) }
            return SectionModel(status: status, title: sectionTitle(for: status, count: rows.count), rows: rows)
        }
    }

    static func rowModel(
        for memory: MemoryCandidateDto,
        groupStatus: MemoriesGroupStatus,
        calendar: Calendar
    ) -> MemoryRowModel {
        MemoryRowModel(
            id: memory.id,
            memory: memory,
            groupStatus: groupStatus,
            kindText: memory.kind.rawValue,
            confidenceText: "\(Int((memory.confidence * 100).rounded()))%",
            evidenceText: memory.evidenceCount == 1 ? "1 evidence item" : "\(memory.evidenceCount) evidence items",
            lastSeenText: lastSeenText(ms: memory.lastSeenAtMs, calendar: calendar)
        )
    }

    /// "HH:mm MMM d" wall-clock text pinned to the injected calendar/timezone.
    /// Confirmed/active memories persist across years, so entries from any
    /// calendar year other than `now`'s append the year ("HH:mm MMM d yyyy");
    /// current-year output stays byte-identical to the compact form.
    static func lastSeenText(ms: Int64, calendar: Calendar, now: Date = Date()) -> String {
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

/// Pure state transitions for Confirm/Reject/Forget over the grouped list.
/// The view-model applies the optimistic shape immediately, snapshots the
/// prior groups, and either merges the daemon-confirmed result or rolls back
/// to the snapshot on any error.
enum MemoriesReducer {
    /// Wire status → display group (daemon-side mapping mirrored client-side).
    static func group(for status: MemoryStatus) -> MemoriesGroupStatus {
        switch status {
        case .active: .confirmed
        case .candidate: .suggestions
        case .rejected: .rejected
        case .superseded: .superseded
        }
    }

    /// Canonical bucket order maintained across every transition.
    static let canonicalOrder: [MemoriesGroupStatus] =
        MemoriesPresentation.displayOrder + [.superseded]

    /// Optimistically applies a user action to the local groups BEFORE the
    /// daemon confirms: confirm moves the row to Confirmed/active, reject to
    /// Rejected/rejected, forget drops the row entirely. Returns nil when the
    /// id is unknown locally (caller proceeds without local mutation).
    static func optimisticGroups(
        action: MemoryActionKind,
        id: String,
        groups: [MemoriesListGroup]
    ) -> [MemoriesListGroup]? {
        let target = findRow(id: id, in: groups)
        guard var memory = target?.memory else { return nil }
        switch action {
        case .confirm: memory.status = .active
        case .reject: memory.status = .rejected
        case .forget: return removing(id: id, from: groups)
        }
        var next = removing(id: id, from: groups)
        insert(memory, into: &next)
        return next
    }

    /// Merges the daemon's authoritative answer after a successful action:
    /// confirm/reject replace the row (re-homed per its new wire status),
    /// forget (`updated:nil`) leaves the optimistic removal in place.
    static func groups(
        applyingServerResult updated: MemoryCandidateDto?,
        id: String,
        to groups: [MemoriesListGroup]
    ) -> [MemoriesListGroup] {
        guard let updated else { return groups }
        var next = removing(id: id, from: groups)
        insert(updated, into: &next)
        return next
    }

    /// Error path: restores the exact pre-action snapshot and lets the caller
    /// surface the failure message alongside.
    static func rollback(to snapshot: [MemoriesListGroup]) -> [MemoriesListGroup] {
        snapshot
    }

    // MARK: Internals

    private static func findRow(
        id: String,
        in groups: [MemoriesListGroup]
    ) -> (memory: MemoryCandidateDto, group: MemoriesListGroup)? {
        for group in groups {
            if let memory = group.memories.first(where: { $0.id == id }) {
                return (memory, group)
            }
        }
        return nil
    }

    private static func removing(
        id: String,
        from groups: [MemoriesListGroup]
    ) -> [MemoriesListGroup] {
        groups.map { group in
            MemoriesListGroup(
                status: group.status,
                memories: group.memories.filter { $0.id != id }
            )
        }
    }

    /// Inserts a row into its canonical bucket, keeping buckets ordered and
    /// rows newest-lastSeen-first within each bucket.
    private static func insert(
        _ memory: MemoryCandidateDto,
        into groups: inout [MemoriesListGroup]
    ) {
        let status = group(for: memory.status)
        if let index = groups.firstIndex(where: { $0.status == status }) {
            var memories = groups[index].memories.filter { $0.id != memory.id }
            let position = memories.firstIndex(where: { $0.lastSeenAtMs < memory.lastSeenAtMs }) ?? memories.count
            memories.insert(memory, at: position)
            groups[index].memories = memories
        } else {
            let merged = canonicalOrder.firstIndex(of: status) ?? groups.count
            let clamped = min(merged, groups.count)
            groups.insert(MemoriesListGroup(status: status, memories: [memory]), at: clamped)
        }
    }
}

// MARK: - Memories window (spec §3.16–3.17)

/// Three-section memory review surface: Confirmed / Suggestions / Rejected.
/// Rows expose text · kind · confidence · evidence count · last seen, with
/// Confirm/Reject/Forget wired through AppState's optimistic-action machine.
struct MemoriesView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Memories")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await appState.refreshMemories() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(appState.memoriesPhase == .loading)
                        .accessibilityLabel("Refresh memories")
                        .keyboardShortcut("r", modifiers: .command)
                    }
                }
        }
        .frame(minWidth: 480, minHeight: 560)
        .task { await appState.refreshMemories() }
    }

    @ViewBuilder
    private var content: some View {
        switch appState.memoriesPhase {
        case .idle:
            ProgressView("Loading memories…")
        case .loading where appState.memoriesGroups.isEmpty:
            ProgressView("Loading memories…")
        case let .failed(message) where appState.memoriesGroups.isEmpty:
            ContentUnavailableView(
                "Memories unavailable",
                systemImage: "brain.badge.questionmark",
                description: Text(message)
            )
        default:
            list
        }
    }

    private var list: some View {
        // Precomputed at commit in AppState (memoriesSections); body evals
        // fire on every AppState invalidation, not just memories refreshes.
        let sections = appState.memoriesSections
        return List {
            if sections.isEmpty {
                Text("No memories yet — they appear as patterns emerge from your history.")
                    .foregroundStyle(.secondary)
            }
            if case let .failed(message) = appState.memoriesPhase {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            if let error = appState.memoriesActionError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            ForEach(sections) { section in
                Section(section.title) {
                    if section.rows.isEmpty {
                        Text(emptyText(for: section.status))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(section.rows) { row in
                        MemoryRowView(
                            row: row,
                            onConfirm: { Task { await appState.runMemoryAction(id: row.id, action: .confirm) } },
                            onReject: { Task { await appState.runMemoryAction(id: row.id, action: .reject) } },
                            onForget: { Task { await appState.runMemoryAction(id: row.id, action: .forget) } }
                        )
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    private func emptyText(for status: MemoriesGroupStatus) -> String {
        switch status {
        case .confirmed: "Nothing confirmed yet."
        case .suggestions: "No suggestions right now."
        case .rejected: "Nothing rejected."
        case .superseded: "Nothing superseded."
        }
    }
}

/// One memory row: text headline, kind chip, confidence/evidence/last-seen
/// meta line, and the action buttons offered for its current group.
/// Forgetting is irreversible, so the destructive action is armed behind the
/// same pending-confirmation dialog pattern as Delete-history in SettingsView.
private struct MemoryRowView: View {
    let row: MemoriesPresentation.MemoryRowModel
    let onConfirm: () -> Void
    let onReject: () -> Void
    let onForget: () -> Void

    @State private var pendingForget = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.memory.text)
                .font(.body)
            HStack(spacing: 8) {
                Text(row.kindText)
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                Text("\(row.confidenceText) · \(row.evidenceText) · seen \(row.lastSeenText)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                switch row.groupStatus {
                case .suggestions:
                    Button("Confirm") { onConfirm() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    Button("Reject") { onReject() }
                        .controlSize(.small)
                    forgetButton
                case .confirmed, .rejected, .superseded:
                    forgetButton
                }
            }
        }
        .padding(.vertical, 2)
        .confirmationDialog(
            "Forget this memory?",
            isPresented: $pendingForget,
            titleVisibility: .visible
        ) {
            Button("Forget permanently", role: .destructive) { onForget() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("“\(row.memory.text)” is removed permanently and cannot be restored.")
        }
    }

    private var forgetButton: some View {
        Button("Forget", role: .destructive) { pendingForget = true }
            .controlSize(.small)
    }
}
