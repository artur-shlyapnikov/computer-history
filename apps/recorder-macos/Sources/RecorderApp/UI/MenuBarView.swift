import SwiftUI

/// Menu-bar popover reflecting live capture state (spec §3.26 states:
/// recording, paused, permission_missing, daemon_error/degraded). SD-3: a
/// daemon-initiated pause (spec §3.25) reads as paused here too — status
/// line and detail carry the daemon's reason and no user Pause is offered
/// while the disk-pressure pause is in effect.
struct MenuBarView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.openWindow) private var openWindow
    /// Capture controls + diagnostics; wired by the app entry point.
    var onPause: (() async -> Void)?
    var onResume: (() async -> Void)?
    var waitingEventsProvider: (@MainActor () -> Int?)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            statusHeader
            Divider()
            Text(stateDetail).font(.caption).foregroundStyle(.secondary)
            if let badge = appState.queueBadgeText {
                Text(badge)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let waiting = waitingEventsProvider?(), waiting > 0 {
                Text("\(waiting) events waiting for the daemon (spooled locally)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            pauseResumeButton
            Divider()
            Button("Ask Your History") { openWindow(id: "ask") }
            Button("Open Timeline") { openWindow(id: "timeline") }
            Button("Open Memories") { openWindow(id: "memories") }
            Button("Open Workflows") { openWindow(id: "workflows") }
            Divider()
            Button("Open Settings") { openWindow(id: "settings") }
            // Brief S7 item 2: after repeated failed starts the menu offers
            // the supervisor error trail one click away.
            if appState.daemonStatus.isDegraded || !appState.supervisorErrors.isEmpty {
                Button("Open Diagnostics") { openWindow(id: "diagnostics") }
            }
            Button("Quit Computer History") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 260)
    }

    private var statusHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: appState.menuBarSymbolName)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusLine).font(.headline)
                if let version = appState.daemonVersion {
                    Text("Daemon \(version)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var statusLine: String {
        switch appState.daemonStatus {
        case .connecting: "Connecting to daemon…"
        case .connected:
            switch appState.menuBarIconState {
            case .permissionMissing:
                // Pinned copy (brief M7 S7 item 1).
                "Accessibility permission required"
            case .paused: appState.daemonPausedStatusLine ?? "Paused"
            default: "Recording"
            }
        case let .reconnecting(attempt): "Reconnecting (attempt \(attempt))…"
        case .degraded: "Daemon error — degraded"
        }
    }

    private var stateDetail: String {
        switch appState.menuBarIconState {
        case .permissionMissing:
            "Grant Accessibility access in System Settings to record activity."
        case .daemonError:
            "The daemon is unreachable; events are spooling locally."
        case .paused:
            appState.daemonPausedStatusLine
                ?? (appState.recordingState.isPaused ? "Capture is paused." : "Waiting for daemon connection…")
        case .recording:
            "Privacy filter active — sensitive content never leaves this device."
        }
    }

    @ViewBuilder
    private var pauseResumeButton: some View {
        // SD-3 (spec §3.25): a daemon-initiated pause outranks every local
        // capture control — offering Resume while the disk-pressure hysteresis
        // owns capture would fight the daemon, so the reason is surfaced
        // instead. The local Pause/Resume pair is only offered when no daemon
        // pause is active.
        if let daemonPause = appState.daemonPausedStatusLine {
            Label(daemonPause, systemImage: "externaldrive.badge.exclamationmark")
                .font(.callout)
                .foregroundStyle(.orange)
        } else if appState.menuBarIconState == .recording {
            Button("Pause Recording") { Task { await onPause?() } }
        } else if appState.recordingState.isPaused {
            Button("Resume Recording") { Task { await onResume?() } }
        }
    }
}
