import Foundation
@testable import RecorderApp
import Testing

/// RecorderCoordinator mapping (design round-3 §P1-2): the composition root is
/// the ONLY place spec §3.25's corrupt-database contract lives on the Swift
/// side — exit code 46 must surface the verbatim recovery string, degrade the
/// status, and record a ring entry, while every other exit stays reconnectable.
/// These tests also pin all six server-event kinds onto AppState and the
/// degraded latch that outranks scheduled restarts.
///
/// Fixtures: a bare `RecorderCoordinator(appState: AppState(daemon:
/// FakeDaemonAPI()))` — construction spawns nothing; `start()` is NEVER
/// called. Everything is a synchronous @MainActor call: no clocks, no
/// sockets, no supervisor. Server events are typed `DaemonEvent` values
/// applied straight to AppState via `apply(_:)`.
@MainActor
struct RecorderCoordinatorMappingTests {
    private func makeCoordinator(
        daemon: FakeDaemonAPI = FakeDaemonAPI()
    ) -> RecorderCoordinator {
        RecorderCoordinator(appState: AppState(daemon: daemon))
    }

    // MARK: - Supervisor event mapping

    @Test("exit code 46 degrades with the verbatim spec §3.25 recovery message")
    func exit46SurfacesRecoveryContract() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(.exited(code: 46))

        #expect(coordinator.appState.daemonStatus == .degraded)
        let newest = coordinator.appState.supervisorErrors.newestFirst.first
        #expect(newest?.code == "daemon_exit")
        // Verbatim per spec §3.25 — changing this literal is a user-facing
        // regression, not a refactor.
        #expect(newest?.message == "History database needs recovery")
        #expect(newest?.scope == "daemon-supervisor")
    }

    @Test("ordinary non-zero exit records a generic message and stays reconnectable")
    func ordinaryExitStaysConnecting() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(.exited(code: 1))

        // NOT degraded: an ordinary crash-restart must stay recoverable.
        #expect(coordinator.appState.daemonStatus == .connecting)
        let newest = coordinator.appState.supervisorErrors.newestFirst.first
        #expect(newest?.code == "daemon_exit")
        #expect(newest?.message == "daemon process exited with code 1")
    }

    @Test("signal-decoded negative exit surfaces the negated signal in the ring")
    func signalExitRecordsNegativeCode() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(.exited(code: -9))

        #expect(coordinator.appState.daemonStatus == .connecting)
        let newest = coordinator.appState.supervisorErrors.newestFirst.first
        #expect(newest?.message.contains("-9") == true)
    }

    @Test("restartScheduled moves a fresh status to reconnecting(attempt:)")
    func restartScheduledMovesToReconnecting() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(
            .restartScheduled(delaySeconds: 5, consecutiveFailures: 2)
        )

        #expect(coordinator.appState.daemonStatus == .reconnecting(attempt: 2))
        let newest = coordinator.appState.supervisorErrors.newestFirst.first
        #expect(newest?.code == "restart_scheduled")
    }

    @Test("degraded latch outranks a later restartScheduled")
    func degradedLatchSurvivesRestartSchedule() {
        let coordinator = makeCoordinator()
        coordinator.handleSupervisorEvent(.exited(code: 46))
        #expect(coordinator.appState.daemonStatus == .degraded)

        coordinator.handleSupervisorEvent(
            .restartScheduled(delaySeconds: 30, consecutiveFailures: 7)
        )

        // The latch (markReconnecting's guard) must outrank scheduled restarts.
        #expect(coordinator.appState.daemonStatus == .degraded)
    }

    @Test("supervisor degraded event degrades with the ten-failures message")
    func supervisorDegradedMapsToDegraded() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(.degraded)

        #expect(coordinator.appState.daemonStatus == .degraded)
        let newest = coordinator.appState.supervisorErrors.newestFirst.first
        #expect(newest?.code == "supervisor_degraded")
        #expect(newest?.message.contains("10 consecutive failed daemon starts") == true)
    }

    @Test("spawned events are silent: no ring entry, status untouched")
    func spawnedIsSilent() {
        let coordinator = makeCoordinator()

        coordinator.handleSupervisorEvent(.spawned(pid: 42))

        #expect(coordinator.appState.supervisorErrors.isEmpty)
        #expect(coordinator.appState.daemonStatus == .connecting)
    }

    // MARK: - Server event mapping

    @Test("queue_update payload drives pendingJobs")
    func queueUpdateDrivesBadge() {
        let coordinator = makeCoordinator()

        coordinator.appState.apply(.queueUpdated(pendingJobs: 3))

        #expect(coordinator.appState.pendingJobs == 3)
    }

    // MARK: chat_* routing through the coordinator hop

    private static let requestR = "01M0NP9G4HP0M1M64H8TC0VEKR"
    private static let requestR2 = "01M0NP9G4HP0M1M64H8TC0VEK2"
    private static let sessionS = "01M0NP9G4HP0M1M64H8TC0VEKS"
    private static let sessionS2 = "01M0NP9G4HP0M1M64H8TC0VEKT"

    /// Drives AppState to mid-turn exactly as sendChatMessage would.
    private func beginStreamingTurn(_ coordinator: RecorderCoordinator, requestId: String, sessionId: String) {
        coordinator.appState.appendUserMessage("what happened?")
        coordinator.appState.applyChatSendResult(requestId: requestId, sessionId: sessionId)
    }

    @Test("chat_chunk appends to the streaming draft via the coordinator hop")
    func chatChunkRoutes() {
        let coordinator = makeCoordinator()
        beginStreamingTurn(coordinator, requestId: Self.requestR, sessionId: Self.sessionS)

        coordinator.appState.apply(
            .chatChunk(requestId: Self.requestR, delta: "Hello ")
        )
        coordinator.appState.apply(
            .chatChunk(requestId: Self.requestR, delta: "world")
        )

        #expect(coordinator.appState.chatStreamingText == "Hello world")
    }

    @Test("chat_done commits the assistant row and pins the session id")
    func chatDoneCommitsAssistantRow() {
        let coordinator = makeCoordinator()
        beginStreamingTurn(coordinator, requestId: Self.requestR, sessionId: Self.sessionS)
        coordinator.appState.apply(
            .chatChunk(requestId: Self.requestR, delta: "answer")
        )

        coordinator.appState.apply(
            .chatDone(requestId: Self.requestR, sessionId: Self.sessionS2)
        )

        #expect(coordinator.appState.chatPhase == .idle)
        #expect(coordinator.appState.chatMessages.count == 2)
        #expect(coordinator.appState.chatMessages[1].role == .assistant)
        #expect(coordinator.appState.chatMessages[1].text == "answer")
        #expect(coordinator.appState.currentChatSessionId == Self.sessionS2)
    }

    @Test("chat_error maps llm_unavailable to failed(code) through the coordinator hop")
    func chatErrorFailsTurn() {
        let coordinator = makeCoordinator()
        beginStreamingTurn(coordinator, requestId: Self.requestR, sessionId: Self.sessionS)

        coordinator.appState.apply(
            .chatError(
                requestId: Self.requestR,
                code: "llm_unavailable",
                message: "no credentials"
            )
        )

        #expect(coordinator.appState.chatPhase == .failed(code: "llm_unavailable"))
        #expect(coordinator.appState.chatErrorMessage == "no credentials")
    }

    @Test("chat_error aborted maps to cancelled through the coordinator hop")
    func chatErrorAbortedCancelsTurn() {
        let coordinator = makeCoordinator()
        beginStreamingTurn(coordinator, requestId: Self.requestR, sessionId: Self.sessionS)

        coordinator.appState.apply(
            .chatError(requestId: Self.requestR, code: "aborted", message: "")
        )

        #expect(coordinator.appState.chatPhase == .cancelled)
    }

    @Test("memories_changed reaches handleMemoriesChanged gating and reloads [async]")
    func memoriesChangedTriggersReload() async {
        let api = FakeDaemonAPI()
        let coordinator = makeCoordinator(daemon: api)
        final class CountingLoader: @unchecked Sendable {
            let lock = NSLock()
            var calls = 0
            func bump() {
                lock.withLock { calls += 1 }
            }

            var value: Int {
                lock.withLock { calls }
            }
        }
        let loader = CountingLoader()
        api.onListMemories = {
            loader.bump()
            return [] as [MemoriesListGroup]
        }
        // Gate: only a list already on screen (.loaded) re-syncs.
        await coordinator.appState.refreshMemories()
        #expect(coordinator.appState.memoriesPhase == .loaded)
        let before = loader.value

        coordinator.appState.apply(.memoriesChanged)

        // The handler hops through Task { @MainActor }: poll bounded instead
        // of sleeping a fixed interval.
        let deadline = Date().addingTimeInterval(2)
        while loader.value == before, Date() < deadline {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(loader.value == before + 1)
    }

    // MARK: - Capture menu-bar controls with no capture stack

    @Test("pause/resume without a capture stack never flips the menu bar (SW5-02)")
    func pauseResumeWithoutCaptureLeavesStateAlone() async {
        let coordinator = makeCoordinator()
        // capture == nil: both calls are guarded no-ops — a no-op pause must
        // not flip the menu bar (SW5-02), so recordingState stays untouched.
        #expect(coordinator.appState.recordingState == .active)
        #expect(coordinator.waitingEventCount == 0)

        await coordinator.pauseCapture()
        #expect(coordinator.appState.recordingState == .active)

        await coordinator.resumeCapture()
        #expect(coordinator.appState.recordingState == .active)
    }
}
