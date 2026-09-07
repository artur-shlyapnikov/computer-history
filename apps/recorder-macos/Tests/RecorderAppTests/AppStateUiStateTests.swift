import Foundation
@testable import RecorderApp
import Testing

/// Round-7 app-state/UI-state regression coverage:
///
/// - SD-3: a daemon-initiated pause (`recording_state`, spec §3.25) folds
///   into `menuBarIconState` so the popover stops claiming «Recording».
/// - SD-4: action rollbacks are scoped to the acted-on record id — an
///   interleaved authoritative merge of ANOTHER record survives a sibling
///   action's failure (confirm A → reject B fails must keep A).
/// - SD-5: a turn pending past the injectable watchdog interval fails
///   locally with a timeout message and clears the composer gates;
///   `cancelPendingTurn` offers the same escape on demand.
/// - SD-6: the streaming draft's identity (`streamingDraftId`, consumed by
///   AskView's `.id`) is stable across chunks because it derives from the
///   pinned requestId instead of a fresh UUID().
///
/// Pure view-model tests: sequences are injected by calling apply* methods
/// and executor closures directly — no socket, mirroring ChatStateTests /
/// MemoriesStateTests conventions.
@MainActor
struct AppStateUiStateTests {
    // MARK: Fixtures

    private static let requestA = "01M0NP9G4HP0M1M64H8TC0VEKA"
    private static let sessionOne = "01M0NP9G4HP0M1M64H8TC0VEKS"

    private static func memory(
        id: String,
        status: MemoryStatus,
        lastSeen: Int64 = 1_787_443_200_000
    ) -> MemoryCandidateDto {
        MemoryCandidateDto(
            id: id,
            kind: .preference,
            canonicalKey: "editor.preference.theme",
            text: "Prefers dark theme",
            confidence: 0.9,
            status: status,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: lastSeen,
            evidenceCount: 2,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_200_000
        )
    }

    private static func memoryGroups(
        suggestions a: MemoryCandidateDto,
        suggestions b: MemoryCandidateDto
    ) -> [MemoriesListGroup] {
        [MemoriesListGroup(status: .suggestions, memories: [a, b])]
    }

    private static func workflow(
        id: String,
        status: WorkflowStatusMirror
    ) -> WorkflowListItem {
        WorkflowListItem(
            id: id,
            name: "Deploy \(id.suffix(4))",
            purpose: "Ship the thing",
            status: status,
            template: WorkflowTemplate(
                name: nil,
                purpose: nil,
                preconditions: nil,
                stableSteps: nil,
                variableInputs: nil,
                expectedOutcome: nil
            ),
            occurrenceCount: 3,
            medianSimilarity: 0.92,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: 1_787_443_200_000,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_200_000,
            occurrences: []
        )
    }

    /// Healthy baseline: connected daemon, granted permission, active capture.
    private func makeHealthyAppState() -> AppState {
        let appState = AppState(daemon: FakeDaemonAPI())
        appState.daemonStatus = .connected
        appState.permissionState = .granted
        appState.recordingState = .active
        return appState
    }

    // MARK: SD-3 — daemon pause folds into the menu-bar icon state

    @Test("daemon-initiated pause reads as the paused icon while capture itself runs")
    func daemonPauseMapsToPausedIcon() {
        let appState = makeHealthyAppState()
        #expect(appState.menuBarIconState == .recording)

        appState.applyDaemonRecordingState(state: "paused", reason: "disk pressure")
        #expect(appState.menuBarIconState == .paused)
        #expect(appState.menuBarSymbolName == "pause.circle")
        // The popover detail carries the daemon's reason, not the generic copy.
        #expect(appState.daemonPausedStatusLine == "Paused by daemon (disk pressure)")

        appState.applyDaemonRecordingState(state: "active", reason: nil)
        #expect(appState.menuBarIconState == .recording)
        #expect(appState.daemonPausedStatusLine == nil)
    }

    @Test("daemon pause without a reason still reads as paused")
    func daemonPauseWithoutReasonMapsToPausedIcon() {
        let appState = makeHealthyAppState()
        appState.applyDaemonRecordingState(state: "paused", reason: nil)
        #expect(appState.menuBarIconState == .paused)
        #expect(appState.menuBarSymbolName == "pause.circle")
        #expect(appState.daemonPausedStatusLine == "Paused by daemon")
    }

    @Test("daemon pause never overwrites the user pause machine and vice versa")
    func daemonPauseIndependentOfUserPause() {
        let appState = makeHealthyAppState()

        appState.applyDaemonRecordingState(state: "paused", reason: "disk pressure")
        appState.recordingState = .paused(reason: nil)
        #expect(appState.menuBarIconState == .paused)
        // User resume does not clear the daemon-side flag…
        appState.recordingState = .active
        #expect(appState.isDaemonRecordingPaused)
        #expect(appState.menuBarIconState == .paused)

        // …and the daemon resuming does not clear a user pause.
        appState.applyDaemonRecordingState(state: "active", reason: nil)
        #expect(!appState.isDaemonRecordingPaused)
        appState.recordingState = .paused(reason: nil)
        #expect(appState.menuBarIconState == .paused)
    }

    @Test("degraded still outranks a daemon pause in the icon decision table")
    func degradedStillWinsOverDaemonPause() {
        let appState = makeHealthyAppState()
        appState.applyDaemonRecordingState(state: "paused", reason: "disk pressure")
        appState.daemonStatus = .degraded
        #expect(appState.menuBarIconState == .daemonError)
    }

    // MARK: SD-4 — id-scoped action rollback under interleaving

    struct ActionFailure: Error {}

    @Test("memories: reject(B) failing mid-confirm(A) keeps A's authoritative merge and restores only B")
    func memoriesRollbackScopedToActedOnId() async throws {
        let aId = "01M0NP9G4HP0M1M64H8TC0VEKU"
        let bId = "01M0NP9G4HP0M1M64H8TC0VEKV"
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = {
            Self.memoryGroups(
                suggestions: Self.memory(id: aId, status: .candidate),
                suggestions: Self.memory(id: bId, status: .candidate, lastSeen: 1_787_443_100_000)
            )
        }
        await state.refreshMemories()
        #expect(state.memoriesGroups.flatMap(\.memories).count == 2)

        // Gate A's executor so its optimistic update is applied and the
        // authoritative merge is still outstanding when B runs and fails.
        let gate = InterleaveGate()
        let authoritativeA = Self.memory(id: aId, status: .active)
        api.onMemoryAction = { id, _ in
            if id == aId {
                await gate.parkUntilReleased()
                return authoritativeA
            }
            throw ActionFailure()
        }

        let taskA = Task { await state.runMemoryAction(id: aId, action: .confirm) }
        await gate.waitUntilArmedByCaller()
        #expect(state.memoriesGroups.first { $0.status == .confirmed }?.memories.map(\.id) == [aId])

        await state.runMemoryAction(id: bId, action: .reject)
        #expect(state.memoriesActionError != nil)
        // B rolled back to its pre-action shape…
        let suggestions = try #require(state.memoriesGroups.first { $0.status == .suggestions })
        #expect(suggestions.memories.first { $0.id == bId }?.status == .candidate)
        // …while A's optimistic confirmation survived B's failure.
        #expect(state.memoriesGroups.first { $0.status == .confirmed }?.memories.map(\.id) == [aId])

        gate.release()
        await taskA.value
        // A's server-authoritative merge lands on top.
        let confirmed = try #require(state.memoriesGroups.first { $0.status == .confirmed })
        #expect(confirmed.memories.first { $0.id == aId }?.status == .active)
        let finalSuggestions = try #require(state.memoriesGroups.first { $0.status == .suggestions })
        #expect(finalSuggestions.memories.map(\.id) == [bId])
        #expect(finalSuggestions.memories.first?.status == .candidate)
    }

    @Test("workflows: reject(B) failing mid-confirm(A) keeps A's authoritative row and restores only B")
    func workflowsRollbackScopedToActedOnId() async throws {
        let aId = "01M0NP9G4HP0M1M64H8TC0VEKW"
        let bId = "01M0NP9G4HP0M1M64H8TC0VEKX"
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListWorkflows = {
            [
                Self.workflow(id: aId, status: .candidate),
                Self.workflow(id: bId, status: .candidate),
            ]
        }
        await state.refreshWorkflows()

        let gate = InterleaveGate()
        let authoritativeA = WorkflowDto(
            id: aId,
            name: "Deploy A",
            purpose: "Ship the thing",
            status: .confirmed,
            template: WorkflowTemplate(
                name: nil,
                purpose: nil,
                preconditions: nil,
                stableSteps: nil,
                variableInputs: nil,
                expectedOutcome: nil
            ),
            occurrenceCount: 3,
            medianSimilarity: 0.92,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: 1_787_443_200_000,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_300_000
        )
        api.onWorkflowAction = { id, _ in
            if id == aId {
                await gate.parkUntilReleased()
                return authoritativeA
            }
            throw ActionFailure()
        }

        let taskA = Task { await state.runWorkflowAction(id: aId, action: .confirm) }
        await gate.waitUntilArmedByCaller()
        #expect(state.workflows.first { $0.id == aId }?.status == .confirmed)

        await state.runWorkflowAction(id: bId, action: .reject)
        #expect(state.workflowsActionError != nil)
        #expect(state.workflows.first { $0.id == bId }?.status == .candidate) // restored
        #expect(state.workflows.first { $0.id == aId }?.status == .confirmed) // survived

        gate.release()
        await taskA.value
        let mergedA = try #require(state.workflows.first { $0.id == aId })
        #expect(mergedA.status == .confirmed)
        #expect(mergedA.name == "Deploy A") // server-authoritative fields won
        #expect(state.workflows.first { $0.id == bId }?.status == .candidate)
    }

    // MARK: SD-4 edge branches — ActionRollback unknown-id guard + clamped reinsertion

    @Test("memories: rollback for an id absent from the snapshot leaves refreshed groups untouched")
    func memoriesUnknownIdRollbackKeepsCurrent() async throws {
        let aId = "01M0NP9G4HP0M1M64H8TC0VEKY"
        let bId = "01M0NP9G4HP0M1M64H8TC0VEKV"
        let ghostId = "01M0NP9G4HP0M1M64H8TC0VEKZ"
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = {
            Self.memoryGroups(
                suggestions: Self.memory(id: aId, status: .candidate),
                suggestions: Self.memory(id: bId, status: .candidate, lastSeen: 1_787_443_100_000)
            )
        }
        await state.refreshMemories()

        // The executor parks, then fails — reproducing a daemon rejection that
        // lands AFTER an interleaved authoritative refresh.
        let gate = InterleaveGate()
        api.onMemoryAction = { _, _ in
            await gate.parkUntilReleased()
            throw ActionFailure()
        }

        // Unknown-id action: no optimistic apply (the reducer returns nil for
        // ids it cannot find), so nothing was optimistically observable.
        let action = Task { await state.runMemoryAction(id: ghostId, action: .confirm) }
        await gate.waitUntilArmedByCaller()
        #expect(state.memoriesActionError == nil)

        // Interleaved authoritative refresh replaces the groups while the
        // action is parked; the ghost id stays absent from every snapshot.
        let refreshed = MemoriesListGroup(status: .suggestions, memories: [
            Self.memory(id: bId, status: .active, lastSeen: 1_787_443_900_000),
        ])
        api.onListMemories = { [refreshed] }
        await state.refreshMemories()

        gate.release()
        await action.value

        #expect(state.memoriesActionError != nil)
        // The `return current` guard fired: exactly the refreshed rows survive
        // with their REFRESHED values. Whole-snapshot restore semantics would
        // clobber them back to the pre-action list and fail these checks.
        #expect(state.memoriesGroups.count == 1)
        let suggestions = try #require(state.memoriesGroups.first { $0.status == .suggestions })
        #expect(suggestions.memories.map(\.id) == [bId])
        #expect(suggestions.memories.first?.status == .active)
        #expect(suggestions.memories.first?.lastSeenAtMs == 1_787_443_900_000)
    }

    @Test("workflows: rollback re-inserts an authoritatively removed row at a clamped position")
    func workflowsRollbackClampedReinsertion() async throws {
        let aId = "01M0NP9G4HP0M1M64H8TC0VEKW"
        let bId = "01M0NP9G4HP0M1M64H8TC0VEKX"
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListWorkflows = {
            [
                Self.workflow(id: aId, status: .candidate),
                Self.workflow(id: bId, status: .candidate),
            ]
        }
        await state.refreshWorkflows()

        let gate = InterleaveGate()
        api.onWorkflowAction = { id, _ in
            if id == aId {
                await gate.parkUntilReleased()
            }
            throw ActionFailure()
        }

        let action = Task { await state.runWorkflowAction(id: aId, action: .confirm) }
        await gate.waitUntilArmedByCaller()
        #expect(state.workflows.first { $0.id == aId }?.status == .confirmed) // optimistic applied

        // A concurrent authoritative refresh REMOVES A entirely while the
        // action is parked.
        api.onListWorkflows = { [Self.workflow(id: bId, status: .confirmed)] }
        await state.refreshWorkflows()
        #expect(state.workflows.map(\.id) == [bId])

        gate.release()
        await action.value

        #expect(state.workflowsActionError != nil)
        // A's PRE-ACTION row was re-inserted into the current list: length
        // restored and position within bounds — exact order is best-effort per
        // the source contract once an interleaved refresh reshuffled neighbors.
        #expect(state.workflows.count == 2)
        let restored = try #require(state.workflows.first { $0.id == aId })
        #expect(restored.status == .candidate)
        let restoredIndex = try #require(state.workflows.firstIndex { $0.id == aId })
        #expect(restoredIndex >= 0 && restoredIndex < state.workflows.count)
        #expect(state.workflows.contains { $0.id == bId })
    }

    // MARK: SD-5 — pending-turn watchdog + cancel affordance

    @Test("watchdog fails a never-answered pending turn with a timeout message")
    func watchdogFailsPendingTurn() async throws {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        state.turnPendingWatchdogInterval = 0.05

        state.appendUserMessage("hello")
        #expect(state.isTurnPending)

        let deadline = Date().addingTimeInterval(5)
        var watchdogFired = false
        while Date() < deadline {
            if !state.isTurnPending {
                watchdogFired = true; break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(watchdogFired)

        #expect(!state.isTurnPending) // composer unlocked
        #expect(state.chatPhase == .failed(code: "internal"))
        #expect(state.chatErrorMessage == "The request timed out waiting for the daemon.")
        // The appended user row survives so the banner's Retry can re-send it.
        #expect(state.lastUserChatText == "hello")
    }

    @Test("watchdog is disarmed once the send response pins the turn")
    func watchdogDisarmedBySendResult() async throws {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        state.turnPendingWatchdogInterval = 0.05
        state.appendUserMessage("hello")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.isChatStreaming)

        try await Task.sleep(for: .seconds(0.15))
        #expect(state.chatErrorMessage == nil)
        #expect(state.isChatStreaming) // still streaming, never failed
    }

    @Test("cancelPendingTurn resolves a still-pending turn as cancelled and clears the composer gates")
    func cancelPendingTurnUnlocksComposer() {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        state.turnPendingWatchdogInterval = 120 // would fire far beyond the test
        state.appendUserMessage("hello")
        #expect(state.isTurnPending)

        state.cancelPendingTurn()

        #expect(!state.isTurnPending)
        #expect(!state.isChatStreaming)
        // User-initiated cancel: .cancelled, not .failed — the error banner
        // (and its Retry re-send) renders nothing for a cancelled phase.
        #expect(state.chatPhase == .cancelled)
        #expect(state.chatErrorMessage == nil)

        // No-op once the turn resolved: a second cancel must not clobber the
        // resolved phase.
        state.cancelPendingTurn()
        #expect(state.chatPhase == .cancelled)
    }

    // MARK: SD-6 — stable streaming draft identity

    @Test("streamingDraftId derives from the pinned requestId and is stable across deltas")
    func streamingDraftIdStableAcrossChunks() {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        #expect(state.streamingDraftId == "chat-streaming-draft") // constant marker

        state.appendUserMessage("hi")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        let pinned = state.streamingDraftId
        #expect(pinned == Self.requestA)

        // Body evaluations per delta must not change the identity.
        state.applyChatChunk(requestId: Self.requestA, delta: "he")
        state.applyChatChunk(requestId: Self.requestA, delta: "llo")
        #expect(state.streamingDraftId == pinned)

        // The next turn pins a fresh id (old row committed, new draft begins).
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.appendUserMessage("again")
        #expect(state.streamingDraftId != pinned)
    }
}

/// Deterministic suspension point for interleaving two MainActor actions:
/// action A parks inside its executor until the caller releases it,
/// reproducing the confirm(A)/reject(B) race without sleeps.
private final class InterleaveGate: @unchecked Sendable {
    private let lock = NSLock()
    private var parked: [CheckedContinuation<Void, Never>] = []
    private var armedWaiters: [CheckedContinuation<Void, Never>] = []
    private var hasParked = false
    private var released = false

    /// Called from inside action A's executor: parks until `release()`.
    func parkUntilReleased() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if released {
                lock.unlock()
                cont.resume()
                return
            }
            parked.append(cont)
            hasParked = true
            let waiters = armedWaiters
            armedWaiters.removeAll()
            lock.unlock()
            waiters.forEach { $0.resume() }
        }
    }

    /// Called from the test: resumes once A has actually parked.
    func waitUntilArmedByCaller() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if hasParked {
                lock.unlock()
                cont.resume()
                return
            }
            armedWaiters.append(cont)
            lock.unlock()
        }
    }

    func release() {
        lock.lock()
        released = true
        let waiters = parked
        parked.removeAll()
        lock.unlock()
        waiters.forEach { $0.resume() }
    }
}
