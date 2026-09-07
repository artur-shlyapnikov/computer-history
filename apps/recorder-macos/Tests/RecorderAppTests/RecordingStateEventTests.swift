import Foundation
@testable import RecorderApp
import Testing

/// `recording_state` server-event dispatch (spec §3.25): the daemon may
/// pause/resume recording itself (disk pressure + hysteresis resume), and the
/// app must reflect that as a DISTINCT AppState concern — never overwriting
/// the user's local pause/resume machine (`recordingState`). Events arrive
/// already typed as `DaemonEvent.recordingState` (decode robustness lives in
/// DaemonClient.decodeDaemonEvent).
///
/// Fixtures mirror RecorderCoordinatorMappingTests: a bare
/// `RecorderCoordinator(appState: AppState(daemon: FakeDaemonAPI()))` —
/// construction spawns nothing; `start()` is NEVER called; every dispatch is
/// a synchronous @MainActor call.
@MainActor
struct RecordingStateEventTests {
    private func makeCoordinator() -> RecorderCoordinator {
        RecorderCoordinator(appState: AppState(daemon: FakeDaemonAPI()))
    }

    @Test("paused frame records the daemon reason and leaves user state alone")
    func pausedFrameRecordsReason() {
        let coordinator = makeCoordinator()

        coordinator.appState.apply(
            .recordingState(state: "paused", reason: "disk pressure")
        )

        #expect(coordinator.appState.daemonPausedReason == "disk pressure")
        #expect(coordinator.appState.daemonPausedStatusLine == "Paused by daemon (disk pressure)")
        // The user's pause/resume machine is untouched by daemon events.
        #expect(coordinator.appState.recordingState == .active)
    }

    @Test("paused frame without reason surfaces the bare status line")
    func pausedFrameWithoutReason() {
        let coordinator = makeCoordinator()

        coordinator.appState.apply(.recordingState(state: "paused", reason: nil))

        #expect(coordinator.appState.isDaemonRecordingPaused)
        #expect(coordinator.appState.daemonPausedReason == nil)
        #expect(coordinator.appState.daemonPausedStatusLine == "Paused by daemon")
    }

    @Test("active frame clears a prior daemon pause")
    func activeFrameClearsPause() {
        let coordinator = makeCoordinator()
        coordinator.appState.applyDaemonRecordingState(state: "paused", reason: "disk pressure")

        coordinator.appState.apply(.recordingState(state: "active", reason: nil))

        #expect(coordinator.appState.daemonPausedReason == nil)
        #expect(coordinator.appState.daemonPausedStatusLine == nil)
    }

    @Test("unknown state value neither sets nor clears the daemon flag")
    func unknownStateIsIgnored() {
        let coordinator = makeCoordinator()
        coordinator.appState.applyDaemonRecordingState(state: "paused", reason: "disk pressure")

        coordinator.appState.apply(
            .recordingState(state: "hibernating", reason: nil)
        )

        #expect(coordinator.appState.daemonPausedReason == "disk pressure")
    }

    @Test("daemon events never overwrite the user-pause machine")
    func userPauseStaysIndependent() {
        let coordinator = makeCoordinator()
        // User pauses locally via the menu bar (the coordinator reflects the
        // capture coordinator's resulting state onto recordingState).
        coordinator.appState.recordingState = .paused(reason: nil)

        coordinator.appState.apply(.recordingState(state: "active", reason: nil))
        #expect(coordinator.appState.recordingState == .paused(reason: nil))

        coordinator.appState.apply(
            .recordingState(state: "paused", reason: "disk pressure")
        )
        // Daemon pause lands on its own concern; user state is preserved…
        #expect(coordinator.appState.recordingState == .paused(reason: nil))
        #expect(coordinator.appState.daemonPausedStatusLine == "Paused by daemon (disk pressure)")

        // …and a user resume does not clear the daemon-side flag either.
        coordinator.appState.recordingState = .active
        #expect(coordinator.appState.daemonPausedStatusLine == "Paused by daemon (disk pressure)")
    }
}
