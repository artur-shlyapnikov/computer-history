import AppKit
import SwiftUI

/// Read-only Diagnostics pane (brief M7 S7 items 2–3): supervisor error ring,
/// daemon `diagnostics.get` integrity/last-errors, and the `status.get`
/// snapshot (db counts, queue, disk free, paused reason). Nothing here is
/// editable — it renders what the daemon reports.
struct DiagnosticsView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Diagnostics").font(.headline)
                Spacer()
                Button("Copy Report") {
                    // Support affordance: the pane's whole snapshot as
                    // paste-ready text for bug reports.
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(
                        Self.reportText(
                            status: appState.lastStatus,
                            diagnostics: appState.daemonDiagnostics,
                            supervisor: appState.supervisorErrors
                        ),
                        forType: .string
                    )
                }
                .disabled(
                    !Self.copyReportEnabled(
                        lastStatus: appState.lastStatus,
                        daemonDiagnostics: appState.daemonDiagnostics,
                        supervisorErrorCount: appState.supervisorErrors.entries.count
                    )
                )
                Button("Refresh") { Task { await appState.refreshDiagnostics() } }
                    .disabled(appState.diagnosticsPhase == .loading)
            }

            switch appState.diagnosticsPhase {
            case .idle:
                Text("Open while connected to load the daemon snapshot.")
                    .font(.caption).foregroundStyle(.secondary)
            case .loading:
                ProgressView().controlSize(.small)
            case let .failed(message):
                Text(message).font(.caption).foregroundStyle(Color.red)
            case .loaded:
                EmptyView()
            }

            supervisorSection
            statusSection
            daemonSection
        }
        .padding(16)
        .frame(width: 420, alignment: .leading)
        .task { await appState.refreshDiagnostics() }
    }

    // MARK: - Supervisor error ring (recorder-side)

    @ViewBuilder
    private var supervisorSection: some View {
        Divider()
        // Spec §3.25: daemon-initiated pause (e.g. disk pressure) is
        // surfaced even when no supervisor error was recorded.
        if let line = appState.daemonPausedStatusLine {
            Text(line).font(.caption).foregroundStyle(.orange)
        }
        Text("Supervisor errors").font(.subheadline).bold()
        if appState.supervisorErrors.isEmpty {
            Text("None recorded.").font(.caption).foregroundStyle(.secondary)
        } else {
            ForEach(Array(appState.supervisorErrors.newestFirst.enumerated()), id: \.element.id) { _, entry in
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(entry.code) · \(entry.scope)").font(.caption2).bold()
                    Text(Self.timestamp(entry.atMs)).font(.caption2).foregroundStyle(.secondary)
                    Text(entry.message).font(.caption2)
                }
                .padding(.vertical, 1)
            }
        }
    }

    // MARK: - status.get snapshot

    @ViewBuilder
    private var statusSection: some View {
        Divider()
        Text("Daemon status").font(.subheadline).bold()
        if let status = appState.lastStatus {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 2) {
                GridRow {
                    Text("Daemon").font(.caption)
                    Text("v\(status.daemon.version) · schema v\(status.daemon.schemaVersion)").font(.caption)
                }
                GridRow {
                    Text("Uptime").font(.caption)
                    Text(Self.uptime(status.daemon.uptimeMs)).font(.caption)
                }
                GridRow {
                    Text("Recording").font(.caption)
                    Text(recordingCell(status)).font(.caption)
                }
                GridRow {
                    Text("Queue").font(.caption)
                    Text(queueCell(status.queue)).font(.caption)
                }
                GridRow {
                    Text("Disk free").font(.caption)
                    Text(Self.gigabytes(status.diskFreeBytes)).font(.caption)
                }
                GridRow {
                    Text("Raw events").font(.caption)
                    Text("\(status.db.rawEvents)").font(.caption)
                }
                GridRow {
                    Text("Segments / steps").font(.caption)
                    Text("\(status.db.segments) / \(status.db.steps)").font(.caption)
                }
                GridRow {
                    Text("Episodes").font(.caption)
                    Text("\(status.db.episodes)").font(.caption)
                }
                GridRow {
                    Text("Memories / workflows").font(.caption)
                    Text("\(status.db.memories) / \(status.db.workflows)").font(.caption)
                }
                GridRow {
                    Text("DB size").font(.caption)
                    Text(Self.megabytes(status.db.pageCountBytes)).font(.caption)
                }
            }
        } else {
            Text("No snapshot loaded.").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Recording row including the paused reason (spec §3.25: no silent
    /// dropping — the reason is always surfaced).
    private func recordingCell(_ status: StatusResult) -> String {
        if status.recording.paused {
            let reason = status.recording.reason ?? "unknown"
            return "paused (\(reason))"
        }
        return "active"
    }

    private func queueCell(_ queue: StatusResult.Queue) -> String {
        "pending \(queue.pending) · retrying \(queue.retrying) · dead \(queue.dead)"
    }

    // MARK: - diagnostics.get

    @ViewBuilder
    private var daemonSection: some View {
        Divider()
        Text("Daemon integrity & last errors").font(.subheadline).bold()
        if let diagnostics = appState.daemonDiagnostics {
            Text(diagnostics.integrityOk ? "Integrity check: OK" : "Integrity check: FAILED")
                .font(.caption)
                .foregroundStyle(diagnostics.integrityOk ? Color.secondary : Color.red)
            if diagnostics.lastErrors.isEmpty {
                Text("No daemon-side errors recorded.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(Array(diagnostics.lastErrors.enumerated()), id: \.offset) { _, error in
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(error.code) · \(error.scope)").font(.caption2).bold()
                        Text("\(Self.timestamp(error.at)) — \(error.message)").font(.caption2)
                    }
                }
            }
        } else {
            Text("No diagnostics loaded.").font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: - Formatting

    /// Error-ring/last-errors wall-clock text. Today's entries stay compact
    /// ("HH:mm:ss"); anything older appends the date ("HH:mm:ss MMM d", plus
    /// the year outside the current one) so errors from different days are
    /// distinguishable. Mirrors the MemoriesPresentation non-current-year
    /// pattern; formatters come from the shared pool, never per row.
    static func timestamp(_ atMs: Int64, calendar: Calendar = .current, now: Date = Date()) -> String {
        let date = Date(timeIntervalSince1970: Double(atMs) / 1000)
        let format = if calendar.isDate(date, inSameDayAs: now) {
            "HH:mm:ss"
        } else if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            "HH:mm:ss MMM d"
        } else {
            "HH:mm:ss MMM d yyyy"
        }
        return CachedDateFormatters.shared.formatter(calendar: calendar, format: format)
            .string(from: date)
    }

    /// Human-readable uptime (ms → "1h 2m 3s" granularity).
    static func uptime(_ ms: Int64) -> String {
        let total = Int(ms / 1000)
        let (days, rem) = total.quotientAndRemainder(dividingBy: 86400)
        let (hours, rem2) = rem.quotientAndRemainder(dividingBy: 3600)
        let (minutes, seconds) = rem2.quotientAndRemainder(dividingBy: 60)
        if days > 0 {
            return "\(days)d \(hours)h \(minutes)m"
        }
        if hours > 0 {
            return "\(hours)h \(minutes)m \(seconds)s"
        }
        return "\(minutes)m \(seconds)s"
    }

    static func gigabytes(_ bytes: Int) -> String {
        String(format: "%.1f GiB", Double(bytes) / 1_073_741_824)
    }

    static func megabytes(_ bytes: Int) -> String {
        String(format: "%.1f MiB", Double(bytes) / 1_048_576)
    }

    // MARK: - Copy report

    /// Absolute "yyyy-MM-dd HH:mm:ss" wall-clock header for the report; the
    /// pane's compact timestamps drop the date, which a filed bug report
    /// needs. Component formatting — no per-call DateFormatter.
    static func reportHeader(now: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: now)
        return String(
            format: "%04d-%02d-%02d %02d:%02d:%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0
        )
    }

    /// Plain-text snapshot of everything the pane renders, for bug reports.
    /// Pure so the copy pins in tests hold exactly; the Copy Report button
    /// writes the result to the pasteboard verbatim. Missing legs degrade
    /// to the same honest "not loaded" lines the pane shows.
    static func reportText(
        status: StatusResult?,
        diagnostics: DiagnosticsGetResult?,
        supervisor: SupervisorErrorRing,
        calendar: Calendar = .current,
        now: Date = Date()
    ) -> String {
        var lines: [String] = []
        lines.append("Computer History diagnostics — \(reportHeader(now: now, calendar: calendar))")
        if let status {
            lines.append("Daemon: v\(status.daemon.version) · schema v\(status.daemon.schemaVersion)")
            lines.append("Uptime: \(uptime(status.daemon.uptimeMs))")
            if status.recording.paused {
                lines.append("Recording: paused (\(status.recording.reason ?? "unknown"))")
            } else {
                lines.append("Recording: active")
            }
            lines.append("Queue: pending \(status.queue.pending) · retrying \(status.queue.retrying) · dead \(status.queue.dead)")
            lines.append("Disk free: \(gigabytes(status.diskFreeBytes))")
            lines.append("Raw events: \(status.db.rawEvents)")
            lines.append("Segments / steps: \(status.db.segments) / \(status.db.steps)")
            lines.append("Episodes: \(status.db.episodes)")
            lines.append("Memories / workflows: \(status.db.memories) / \(status.db.workflows)")
            lines.append("DB size: \(megabytes(status.db.pageCountBytes))")
        } else {
            lines.append("No status snapshot loaded.")
        }
        if let diagnostics {
            lines.append("Integrity check: \(diagnostics.integrityOk ? "OK" : "FAILED")")
            if diagnostics.lastErrors.isEmpty {
                lines.append("Daemon errors: none")
            } else {
                lines.append("Daemon errors:")
                for error in diagnostics.lastErrors {
                    lines.append(
                        "  \(error.code) · \(error.scope) @ \(timestamp(error.at, calendar: calendar, now: now)) — \(error.message)"
                    )
                }
            }
        } else {
            lines.append("No diagnostics loaded.")
        }
        if supervisor.isEmpty {
            lines.append("Supervisor errors: none")
        } else {
            lines.append("Supervisor errors:")
            for entry in supervisor.newestFirst {
                lines.append(
                    "  \(entry.code) · \(entry.scope) @ \(timestamp(entry.atMs, calendar: calendar, now: now)) — \(entry.message)"
                )
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Copy is available whenever any leg of the report has content. The
    /// phase alone must not gate it: a failed refresh keeps the previously
    /// loaded status/diagnostics intact, and a stale snapshot is exactly
    /// what the user needs to copy after a failure.
    static func copyReportEnabled(
        lastStatus: StatusResult?,
        daemonDiagnostics: DiagnosticsGetResult?,
        supervisorErrorCount: Int
    ) -> Bool {
        lastStatus != nil || daemonDiagnostics != nil || supervisorErrorCount > 0
    }
}
