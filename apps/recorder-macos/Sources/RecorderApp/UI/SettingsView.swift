import SwiftUI

/// Settings surface (spec §3.26; brief M7 S7 item 3):
/// - recording on/off toggle → coordinator pause/resume,
/// - per-app capture policy editor backed by CapturePolicyStore,
/// - Delete-history controls wired to `delete.range` (confirmation dialog),
/// - Diagnostics summary + link, model settings DISPLAY-ONLY from
///   `settings.get` (editing is deferred to post-V1 — README notes this).
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    var onPause: (() async -> Void)?
    var onResume: (() async -> Void)?
    /// Loads the persisted policy (CapturePolicyStore) for rendering.
    var policyProvider: (() -> CapturePolicy)?
    /// Persists a policy transition and applies it to the live capture stack.
    var policyApplier: ((_ policy: CapturePolicy) throws -> Void)?

    @State private var policy = CapturePolicy.standard
    @State private var newAppBundleId = ""
    @State private var newAppMode: CaptureMode = .metadata
    @State private var policyError: String?
    // Date-range deletion state.
    @State private var rangeDate = Date()
    @State private var pendingDeleteConfirmation: PendingDelete?

    /// One armed (not yet confirmed) delete request driving the dialog.
    struct PendingDelete: Identifiable {
        let id = UUID()
        let label: String
        let params: DeleteRangeParams
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings").font(.headline)
            recordingSection
            Divider()
            capturePolicySection
            Divider()
            deleteHistorySection
            Divider()
            modelsSection
        }
        .padding(16)
        .frame(width: 420, alignment: .leading)
        .onAppear(perform: reloadPolicy)
    }

    // MARK: - Recording toggle

    private var recordingSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Recording", isOn: Binding(
                get: { !appState.recordingState.isPaused },
                set: { enabled in
                    Task {
                        if enabled {
                            await onResume?()
                        } else {
                            await onPause?()
                        }
                    }
                }
            ))
            switch appState.recordingState {
            case let .paused(reason):
                Text(reason.map { "Paused — \($0)." } ?? "Paused.")
                    .font(.caption).foregroundStyle(.secondary)
            case .active:
                EmptyView()
            }
        }
    }

    // MARK: - Per-app capture policies

    private var capturePolicySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("App capture policies").font(.subheadline).bold()
            Picker("Default for all apps", selection: defaultModeBinding) {
                ForEach(CaptureMode.allCases, id: \.self) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .pickerStyle(.menu)

            ForEach(policy.perApp.keys.sorted(), id: \.self) { bundleId in
                HStack {
                    Text(bundleId).font(.caption).lineLimit(1)
                    Spacer()
                    Picker("", selection: overrideBinding(for: bundleId)) {
                        ForEach(CaptureMode.allCases, id: \.self) { mode in
                            Text(mode.displayName).tag(Optional(mode))
                        }
                        Text("inherit").tag(nil as CaptureMode?)
                    }
                    .labelsHidden()
                    .frame(width: 130)
                }
            }

            HStack {
                TextField("com.example.app", text: $newAppBundleId)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                Picker("", selection: $newAppMode) {
                    ForEach(CaptureMode.allCases, id: \.self) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .frame(width: 110)
                Button("Add") { addOverride() }
                    .disabled(newAppBundleId.isEmpty)
            }
            if let policyError {
                Text(policyError).font(.caption2).foregroundStyle(.red)
            }
        }
        .onAppear(perform: reloadPolicy)
    }

    private var defaultModeBinding: Binding<CaptureMode> {
        Binding(
            get: { policy.defaultMode },
            set: { applyPolicy(CapturePolicyReducer.setDefaultMode(policy, mode: $0)) }
        )
    }

    /// Re-reads the persisted policy so a policy loaded after first render refreshes the @State.
    private func reloadPolicy() {
        if let loaded = policyProvider?() {
            policy = loaded
        }
    }

    private func overrideBinding(for bundleId: String) -> Binding<CaptureMode?> {
        Binding(
            get: { policy.perApp[bundleId] },
            set: { applyPolicy(CapturePolicyReducer.setOverride(policy, bundleId: bundleId, mode: $0)) }
        )
    }

    private func addOverride() {
        let bundleId = newAppBundleId.trimmingCharacters(in: .whitespaces)
        guard !bundleId.isEmpty else { return }
        // Input-boundary sanity: a bundle ID is reverse-DNS (contains a
        // dot) with no whitespace. Catches the common "Safari" typo before
        // it lands in the persisted policy, where it would silently never
        // match an app.
        guard bundleId.contains("."), !bundleId.contains(where: \.isWhitespace) else {
            policyError = "Enter a bundle ID like com.example.app."
            return
        }
        applyPolicy(CapturePolicyReducer.setOverride(policy, bundleId: bundleId, mode: newAppMode))
        newAppBundleId = ""
    }

    private func applyPolicy(_ next: CapturePolicy) {
        do {
            try policyApplier?(next)
            policy = next
            policyError = nil
        } catch {
            policyError = error.localizedDescription
        }
    }

    // MARK: - Delete history

    private var deleteHistorySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Delete history").font(.subheadline).bold()
            HStack(spacing: 8) {
                Button("Last 10 min") {
                    pendingDeleteConfirmation = PendingDelete(
                        label: "the last 10 minutes",
                        params: .init(preset: .last10Minutes)
                    )
                }
                Button("Last hour") {
                    pendingDeleteConfirmation = PendingDelete(
                        label: "the last hour",
                        params: .init(preset: .lastHour)
                    )
                }
            }
            .disabled(appState.deleteInFlight)
            HStack(spacing: 8) {
                Button("Today") {
                    pendingDeleteConfirmation = PendingDelete(
                        label: "today",
                        params: .init(preset: .today)
                    )
                }
                Button("All history…") {
                    pendingDeleteConfirmation = PendingDelete(
                        label: "ALL history",
                        params: .init(preset: .all)
                    )
                }
            }
            .disabled(appState.deleteInFlight)
            HStack(spacing: 8) {
                DatePicker("Day range", selection: $rangeDate, displayedComponents: .date)
                    .labelsHidden()
                Button("Delete day…") {
                    pendingDeleteConfirmation = PendingDelete(
                        label: "everything from that day",
                        params: DeleteHistoryReducer.dayRangeParams(for: rangeDate)
                    )
                }
            }
            .disabled(appState.deleteInFlight)
            .confirmationDialog(
                "Delete \(pendingDeleteConfirmation?.label ?? "")?",
                isPresented: Binding(
                    get: { pendingDeleteConfirmation != nil },
                    set: {
                        if !$0 {
                            pendingDeleteConfirmation = nil
                        }
                    }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete permanently", role: .destructive) {
                    if let armed = pendingDeleteConfirmation {
                        let params = armed.params
                        pendingDeleteConfirmation = nil
                        Task { await appState.runDeleteHistory(params: params) }
                    }
                }
                Button("Cancel", role: .cancel) { pendingDeleteConfirmation = nil }
            } message: {
                Text("This permanently removes raw events, steps, episodes, memories and workflow occurrences in range. Manually confirmed memories survive.")
            }
            if appState.deleteInFlight {
                ProgressView().controlSize(.small)
            }
            if let counts = appState.lastDeleteCounts {
                Text("Last delete removed \(counts.rawEvents) events, \(counts.steps) steps, \(counts.episodes) episodes.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let deleteError = appState.deleteError {
                Text(deleteError).font(.caption2).foregroundStyle(.red)
            }
        }
    }

    // MARK: - Model settings (display-only this wave)

    private var modelsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Models & retention (daemon-managed)").font(.subheadline).bold()
            switch appState.settingsPhase {
            case .idle:
                Text("Loading daemon settings…").font(.caption).foregroundStyle(.secondary)
            case .loading:
                ProgressView().controlSize(.small)
            case let .failed(message):
                VStack(alignment: .leading, spacing: 4) {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                    Button("Retry") {
                        Task { await appState.refreshDaemonSettings() }
                    }
                    .controlSize(.small)
                }
            case .loaded:
                if let settings = appState.daemonSettingsDisplay {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 2) {
                        GridRow {
                            Text("Chat model").font(.caption)
                            Text(settings.chatModel).font(.caption)
                        }
                        GridRow {
                            Text("Background model").font(.caption)
                            Text(settings.backgroundModel).font(.caption)
                        }
                        GridRow {
                            Text("Raw retention").font(.caption)
                            Text("\(settings.rawRetentionHours) h").font(.caption)
                        }
                        GridRow {
                            Text("Semantic retention").font(.caption)
                            Text("\(settings.semanticRetentionDays) d").font(.caption)
                        }
                    }
                    Text("Editing is managed by the daemon configuration (post-V1 UI).")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .task { await appState.refreshDaemonSettings() }
    }
}

extension CaptureMode {
    var displayName: String {
        switch self {
        case .off: "Off"
        case .metadata: "Metadata only"
        case .content: "Full content"
        }
    }
}
