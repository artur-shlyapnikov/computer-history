import Foundation
@testable import RecorderApp
import Testing

/// Decision-table coverage for the menu-bar icon state machine (spec §3.26):
/// degraded > permission-denied > paused/unhealthy-daemon > recording.
/// Pure and synchronous — published fields are assigned directly, mirroring
/// the TimelineMappingTests fixture convention.
@MainActor
struct MenuBarIconStateTests {
    private func makeAppState(
        daemonStatus: DaemonStatus,
        permissionState: PermissionState,
        recordingState: RecordingState
    ) -> AppState {
        let appState = AppState()
        appState.daemonStatus = daemonStatus
        appState.permissionState = permissionState
        appState.recordingState = recordingState
        return appState
    }

    @Test("connected + granted + active reads as recording")
    func healthyRecording() {
        let appState = makeAppState(
            daemonStatus: .connected,
            permissionState: .granted,
            recordingState: .active
        )
        #expect(appState.menuBarIconState == .recording)
    }

    @Test("degraded outranks every other tier simultaneously")
    func degradedWinsOverAllTiers() {
        let appState = makeAppState(
            daemonStatus: .degraded,
            permissionState: .denied,
            recordingState: .paused(reason: "disk_pressure")
        )
        // First branch wins even with permission loss AND an active pause.
        #expect(appState.menuBarIconState == .daemonError)
    }

    @Test("permission denied outranks paused and unhealthy daemon")
    func deniedOutranksPausedAndUnhealthy() {
        let appState = makeAppState(
            daemonStatus: .connected,
            permissionState: .denied,
            recordingState: .active
        )
        #expect(appState.menuBarIconState == .permissionMissing)
    }

    @Test("paused capture reads as paused and RecordingState.isPaused agrees")
    func pausedCaptureReadsAsPaused() {
        let appState = makeAppState(
            daemonStatus: .connected,
            permissionState: .granted,
            recordingState: .paused(reason: "disk_pressure")
        )
        #expect(appState.menuBarIconState == .paused)
        #expect(appState.recordingState.isPaused)
    }

    @Test("unhealthy daemon pauses the icon even while capture runs")
    func unhealthyDaemonReadsAsPaused() {
        for status in [DaemonStatus.connecting, .reconnecting(attempt: 3)] {
            let appState = makeAppState(
                daemonStatus: status,
                permissionState: .granted,
                recordingState: .active
            )
            #expect(appState.menuBarIconState == .paused)
        }
    }

    @Test("each icon state maps to its pinned SF Symbol")
    func symbolNamesArePinned() {
        let recording = makeAppState(daemonStatus: .connected, permissionState: .granted, recordingState: .active)
        #expect(recording.menuBarSymbolName == "record.circle")

        let paused = makeAppState(
            daemonStatus: .connected,
            permissionState: .granted,
            recordingState: .paused(reason: "disk_pressure")
        )
        #expect(paused.menuBarSymbolName == "pause.circle")

        let permission = makeAppState(daemonStatus: .connected, permissionState: .denied, recordingState: .active)
        #expect(permission.menuBarSymbolName == "exclamationmark.shield")

        let degraded = makeAppState(daemonStatus: .degraded, permissionState: .granted, recordingState: .active)
        #expect(degraded.menuBarSymbolName == "xmark.octagon")
    }

    @Test("isDegraded is true only for .degraded across the status sweep")
    func degradedSweep() {
        #expect(!DaemonStatus.connecting.isDegraded)
        #expect(!DaemonStatus.connected.isDegraded)
        #expect(!DaemonStatus.reconnecting(attempt: 1).isDegraded)
        #expect(DaemonStatus.degraded.isDegraded)
    }
}
