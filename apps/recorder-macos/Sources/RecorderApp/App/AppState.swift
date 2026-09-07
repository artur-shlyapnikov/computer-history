import Foundation

/// Menu-bar icon states (spec §3.26).
enum MenuBarIconState: Equatable, Sendable {
    case recording
    case paused
    case permissionMissing
    case daemonError
}

enum DaemonStatus: Equatable, Sendable {
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case degraded
}

extension DaemonStatus {
    var isDegraded: Bool {
        if case .degraded = self {
            return true
        }
        return false
    }
}

enum PermissionState: Equatable, Sendable {
    case unknown
    case granted
    case denied
}

enum RecordingState: Equatable, Sendable {
    case active
    case paused(reason: String?)
}

// MARK: - Timeline state (M3 episode timeline)

/// Load lifecycle for the `timeline.list` episode timeline.
enum TimelinePhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// Drives periodic timeline refresh ticks; abstracted so tests can fire
/// ticks deterministically without real timers.
protocol TimelineTickScheduler: AnyObject {
    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void)
    func stop()
}

/// Production scheduler: a serial-queue `DispatchSourceTimer`.
/// `@unchecked Sendable`: the only mutable state (`timer`) is created,
/// replaced and cancelled exclusively from the actor caller (start/stop are
/// serialized by @MainActor AppState); the timer itself lives on its own
/// private serial queue.
final class DispatchTimelineTickScheduler: TimelineTickScheduler, @unchecked Sendable {
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "computer-history.timeline-tick")

    func start(interval: TimeInterval, tick: @escaping @Sendable () async -> Void) {
        stop()
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { Task { await tick() } }
        source.resume()
        timer = source
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }
}

@MainActor
final class AppState: ObservableObject {
    /// The daemon data surface, injected ONCE at construction. Calling it
    /// while disconnected throws `DaemonClientError.notConnected`, which
    /// every load maps to the stable «Daemon connection unavailable» user
    /// string — no per-handshake installation/removal of operation closures,
    /// and partial wiring is unrepresentable.
    let daemon: any DaemonAPI

    init(daemon: any DaemonAPI = DaemonClient()) {
        self.daemon = daemon
    }

    @Published var daemonStatus: DaemonStatus = .connecting
    @Published var permissionState: PermissionState = .unknown
    @Published var recordingState: RecordingState = .active
    @Published var daemonVersion: String?
    /// Daemon-initiated recording pause (spec §3.25: disk pressure +
    /// hysteresis resume), fed by `recording_state` server events. DISTINCT
    /// concern from `recordingState` (the user's local pause/resume machine):
    /// daemon events land here and NEVER overwrite user-pause state. The
    /// reason stays optional so a paused-without-reason frame is still
    /// distinguishable from active.
    @Published private(set) var isDaemonRecordingPaused = false
    @Published private(set) var daemonPausedReason: String?

    // MARK: Timeline (timeline.list episodes; segments.list = detail fallback)

    @Published private(set) var timelinePhase: TimelinePhase = .idle
    @Published private(set) var timelineEpisodes: [EpisodeSummaryDto] = []
    /// Sections precomputed at refresh-commit (see commitTimeline). View
    /// bodies re-evaluate on every AppState invalidation — the 5s status
    /// tick, chat chunks, unrelated surfaces — and re-running the
    /// sort+day-bucket+per-row-string build each time was pure waste: the
    /// episodes only change at this commit. Plain stored property (no extra
    /// objectWillChange); every writer keeps it in lockstep.
    private(set) var timelineSections: [TimelinePresentation.SectionModel] = []
    /// Day-bucketing reference time pinned at the same commit so the cache is
    /// reproducible; «Today/Yesterday» headers self-correct at the first
    /// commit after midnight (the poll cadence is 5s).
    private(set) var timelineSectionsNow = Date()

    private var timelineTickScheduler: (any TimelineTickScheduler)?
    /// Monotonic token guarding against stale-refresh last-writer-wins
    /// (SW5-08): each refresh cycle bumps the counter and captures its value;
    /// a completion that has been superseded by a newer cycle is discarded
    /// instead of overwriting fresher data (e.g. deleted rows reappearing).
    private var timelineGeneration = 0
    /// True while a `refreshTimeline` cycle is outstanding (SW5-04b): the
    /// periodic tick skips instead of stacking parallel loads behind a hung
    /// response. Event-triggered refreshes still supersede via the generation.
    private var timelineRefreshInFlight = false

    /// Episode detail (`episode.get`) for the Timeline drill-in.
    func loadEpisodeDetail(_ id: String) async throws -> EpisodeGetResult {
        try await daemon.getEpisode(id: id)
    }

    /// `segments.list` source used ONLY as the detail fallback when an
    /// episode's record can no longer be served by the daemon.
    func loadSegmentFallback() async throws -> [SegmentSummaryDto] {
        try await daemon.listSegments(from: nil, to: nil, limit: SegmentsListDefaults.defaultLimit).segments
    }

    /// One explicit load cycle of the episode timeline. Concurrent cycles
    /// coalesce by generation: only the newest-started cycle may commit.
    func refreshTimeline() async {
        timelineGeneration += 1
        let generation = timelineGeneration
        timelineRefreshInFlight = true
        timelinePhase = .loading
        do {
            let episodes = try await daemon.listTimeline(
                from: nil,
                to: nil,
                limit: TimelineListDefaults.defaultLimit
            ).episodes
            guard generation == timelineGeneration else { return }
            commitTimeline(episodes)
            timelinePhase = .loaded
        } catch {
            guard generation == timelineGeneration else { return }
            timelinePhase = .failed(failureMessage(error))
        }
        timelineRefreshInFlight = false
    }

    /// Single writer for the timeline episodes: keeps the precomputed
    /// sections cache in lockstep with the published data.
    private func commitTimeline(_ episodes: [EpisodeSummaryDto]) {
        timelineEpisodes = episodes
        timelineSectionsNow = Date()
        timelineSections = TimelinePresentation.sections(
            from: episodes,
            now: timelineSectionsNow,
            calendar: .current
        )
    }

    /// Jobs waiting for processing (pending + retrying, folded server-side
    /// into one `pendingJobs` count by the daemon's queue_update event).
    @Published private(set) var pendingJobs = 0

    /// State-machine transition driven by each decoded `queue_update` event;
    /// tests inject sequences of these instead of live sockets.
    func applyQueueUpdate(pendingJobs count: Int) {
        pendingJobs = max(0, count)
    }

    /// «N activities waiting for processing» or nil when the queue is empty.
    var queueBadgeText: String? {
        QueueBadge.badgeText(forPendingJobs: pendingJobs)
    }

    /// Applies a decoded `recording_state` payload (spec §3.25): `paused`
    /// records the daemon's reason (when present), `active` clears both.
    /// Unknown states are ignored so a future wire value cannot wedge the
    /// flag either way.
    func applyDaemonRecordingState(state: String, reason: String?) {
        switch state {
        case "paused":
            isDaemonRecordingPaused = true
            daemonPausedReason = reason
        case "active":
            isDaemonRecordingPaused = false
            daemonPausedReason = nil
        default:
            break
        }
    }

    /// Diagnostics/menu surfacing for a daemon-initiated pause, e.g.
    /// "Paused by daemon (disk pressure)" or the bare line when no reason
    /// was given; nil while not daemon-paused.
    var daemonPausedStatusLine: String? {
        guard isDaemonRecordingPaused else { return nil }
        guard let reason = daemonPausedReason, !reason.isEmpty else { return "Paused by daemon" }
        return "Paused by daemon (\(reason))"
    }

    /// Begins periodic refresh ticks. Polling pauses while capture is paused:
    /// ticks are dropped, not queued, and resume on the next active tick.
    func startTimelinePolling(
        scheduler: any TimelineTickScheduler = DispatchTimelineTickScheduler(),
        interval: TimeInterval = 5
    ) {
        stopTimelinePolling()
        timelineTickScheduler = scheduler
        scheduler.start(interval: interval) { [weak self] in
            await self?.timelineTick()
        }
    }

    func stopTimelinePolling() {
        timelineTickScheduler?.stop()
        timelineTickScheduler = nil
    }

    private func timelineTick() async {
        // SW5-04b: a hung in-flight refresh must not have 5s ticks stacking
        // parallel loads behind it; the tick is dropped, not queued.
        guard !recordingState.isPaused, !timelineRefreshInFlight else { return }
        await refreshTimeline()
    }

    /// `episodes_changed` writers): re-sync only while the timeline is
    /// already on screen; a hidden view refreshes on `.task` anyway.
    func handleEpisodesChanged() async {
        switch timelinePhase {
        case .loaded, .loading:
            await refreshTimeline()
        case .idle, .failed:
            break
        }
    }

    // MARK: - Supervisor error ring + hardening surfaces (brief M7 S7 items 2–3)

    /// Lifecycle shared by the read-only daemon-facing loads below.
    enum DiagnosticsPhase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// Injected clock for ring-buffer timestamps; tests pin time
    /// deterministically instead of sleeping.
    var clock: AppClock = SystemAppClock()

    /// Last N supervisor failures (brief S7 item 2). The coordinator feeds
    /// supervisor events in; the Diagnostics pane renders newest-first.
    @Published private(set) var supervisorErrors = SupervisorErrorRing(capacity: 20)

    func recordSupervisorError(scope: String, code: String, message: String) {
        supervisorErrors.record(
            atMs: clock.nowMs,
            scope: scope,
            code: code,
            message: message
        )
    }

    /// `status.get` snapshot (db counts, queue, diskFreeBytes, paused reason)
    /// rendered read-only by the Diagnostics pane.
    @Published private(set) var lastStatus: StatusResult?
    @Published private(set) var diagnosticsPhase: DiagnosticsPhase = .idle

    /// Round 27: stale-refresh guard for the diagnostics cycle (see
    /// `memoriesGeneration`): only the newest-started cycle may commit.
    private var diagnosticsGeneration = 0
    @Published private(set) var daemonDiagnostics: DiagnosticsGetResult?

    /// One explicit load cycle of the diagnostics sources. Settings are
    /// best-effort (a settings failure never masks a good status snapshot)
    /// but must surface as `.failed` instead of silently keeping a stale
    /// `.loaded`/`.idle` phase; the display block keeps the last good mirror.
    /// While disconnected (`notConnected` status load) the cycle stops at the
    /// failed diagnostics phase and leaves `settingsPhase` untouched — no
    /// doomed settings.get roundtrip, no `.loading`→`.failed` flap.
    func refreshDiagnostics() async {
        diagnosticsGeneration += 1
        let generation = diagnosticsGeneration
        diagnosticsPhase = .loading
        do {
            // Round 27: load into locals — unlike the list loads, the
            // snapshot itself must not be touched by a superseded cycle.
            let status = try await daemon.fetchStatus()
            let diagnostics = try? await daemon.fetchDiagnostics()
            guard generation == diagnosticsGeneration else { return }
            lastStatus = status
            daemonDiagnostics = diagnostics
            diagnosticsPhase = .loaded
        } catch {
            guard generation == diagnosticsGeneration else { return }
            // Deliberate improvement over the pre-refactor code (595eb1f^),
            // not a restore of it: that version only early-returned when the
            // status LOADER was nil, so a THROWING (disconnected) status load
            // fell through to the settings fetch and flapped settingsPhase
            // .loading→.failed. A disconnected cycle stops here instead —
            // failed diagnostics phase; the settings pane keeps whatever
            // phase it already shows.
            if case DaemonClientError.notConnected = error {
                diagnosticsPhase = .failed(failureMessage(error))
                return
            }
            diagnosticsPhase = .failed(failureMessage(error))
        }
        // Settings stay best-effort (a settings failure never masks a good
        // status snapshot); DiagnosticsView's Retry engages via
        // refreshDaemonSettings().
        settingsPhase = .loading
        do {
            daemonSettingsDisplay = try await daemon.fetchSettings().settings
            settingsPhase = .loaded
        } catch {
            settingsPhase = .failed(failureMessage(error))
        }
    }

    @Published private(set) var daemonSettingsDisplay: DaemonSettingsDto?
    @Published private(set) var settingsPhase: DiagnosticsPhase = .idle

    func refreshDaemonSettings() async {
        settingsPhase = .loading
        do {
            daemonSettingsDisplay = try await daemon.fetchSettings().settings
            settingsPhase = .loaded
        } catch {
            settingsPhase = .failed(failureMessage(error))
        }
    }

    @Published private(set) var deleteInFlight = false
    @Published private(set) var lastDeleteCounts: DeleteRangeDeletedCounts?
    /// Human-readable failure of the last delete attempt; cleared on the
    /// next attempt and surfaced above the Delete-history controls.
    @Published private(set) var deleteError: String?

    func runDeleteHistory(params: DeleteRangeParams) async {
        deleteInFlight = true
        deleteError = nil
        defer { deleteInFlight = false }
        do {
            lastDeleteCounts = try await daemon.deleteHistory(params).deleted
        } catch {
            deleteError = failureMessage(error)
        }
    }

    // MARK: Memories state (memories.list / memory.action; spec §3.16–3.17)

    /// Load lifecycle for the grouped memories list.
    enum MemoriesPhase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var memoriesPhase: MemoriesPhase = .idle
    @Published private(set) var memoriesGroups: [MemoriesListGroup] = []
    /// Sections precomputed at every memoriesGroups commit (see
    /// commitMemoriesGroups) — same rationale as timelineSections.
    private(set) var memoriesSections: [MemoriesPresentation.SectionModel] = []
    /// SW5-08 stale-refresh guard, same pattern as the timeline generation:
    /// only the newest-started refresh cycle may commit its result.
    private var memoriesGeneration = 0
    /// Human-readable failure of the last memory.action; shown as an error
    /// banner above the sections until the next successful action or refresh.
    @Published private(set) var memoriesActionError: String?

    /// One explicit load cycle of the memories list. Concurrent cycles
    /// coalesce by generation: only the newest-started cycle may commit.
    func refreshMemories() async {
        memoriesGeneration += 1
        let generation = memoriesGeneration
        memoriesPhase = .loading
        do {
            let groups = try await daemon.listMemories(status: nil).groups
            guard generation == memoriesGeneration else { return }
            commitMemoriesGroups(groups)
            memoriesPhase = .loaded
        } catch {
            guard generation == memoriesGeneration else { return }
            memoriesPhase = .failed(failureMessage(error))
        }
    }

    /// Single writer for the memories list: keeps the precomputed sections
    /// cache in lockstep with the published data (refresh, optimistic
    /// action, server-result, and rollback paths all funnel through here).
    private func commitMemoriesGroups(_ groups: [MemoriesListGroup]) {
        memoriesGroups = groups
        memoriesSections = MemoriesPresentation.sections(from: groups, calendar: .current)
    }

    /// `memories_changed` server event: re-sync only when the list is already
    /// on screen (loaded/loading); a hidden view refreshes on `.task` anyway.
    func handleMemoriesChanged() async {
        switch memoriesPhase {
        case .loaded, .loading:
            await refreshMemories()
        case .idle, .failed:
            break
        }
    }

    /// Confirm/Reject/Forget with optimistic update + rollback on error.
    /// The reducer supplies the pure transitions; this wires them to the
    /// injected executor and surfaces failures on `memoriesActionError`.
    /// SD-4: the rollback is scoped to THIS record's id — a whole-snapshot
    /// restore would silently discard an interleaved authoritative merge of
    /// another record (confirm A, then reject B fails ⇒ A must survive).
    func runMemoryAction(id: String, action: MemoryActionKind) async {
        let snapshot = memoriesGroups
        if let optimistic = MemoriesReducer.optimisticGroups(action: action, id: id, groups: memoriesGroups) {
            commitMemoriesGroups(optimistic)
        }
        memoriesActionError = nil
        do {
            let updated = try await daemon.memoryAction(id: id, action: action).updated
            commitMemoriesGroups(MemoriesReducer.groups(
                applyingServerResult: updated,
                id: id,
                to: memoriesGroups
            ))
        } catch {
            commitMemoriesGroups(ActionRollback.memoriesRow(
                id: id,
                from: snapshot,
                to: memoriesGroups
            ))
            memoriesActionError = failureMessage(error)
        }
    }

    // MARK: Workflows state (workflows.list / workflow.action; spec §3.20)

    /// Load lifecycle for the workflows list.
    enum WorkflowsPhase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var workflowsPhase: WorkflowsPhase = .idle
    @Published private(set) var workflows: [WorkflowListItem] = []
    /// Cards precomputed at every workflows commit (see commitWorkflows) —
    /// same rationale as timelineSections.
    private(set) var workflowCards: [WorkflowsPresentation.CardModel] = []
    /// SW5-08 stale-refresh guard for the workflows list (see
    /// `memoriesGeneration`).
    private var workflowsGeneration = 0
    /// Human-readable failure of the last workflow.action; shown as an error
    /// banner above the cards until the next successful action or refresh.
    @Published private(set) var workflowsActionError: String?

    func refreshWorkflows() async {
        workflowsGeneration += 1
        let generation = workflowsGeneration
        workflowsPhase = .loading
        do {
            let items = try await daemon.listWorkflows(status: nil).workflows
            guard generation == workflowsGeneration else { return }
            commitWorkflows(items)
            workflowsPhase = .loaded
        } catch {
            guard generation == workflowsGeneration else { return }
            workflowsPhase = .failed(failureMessage(error))
        }
    }

    /// Single writer for the workflows list: keeps the precomputed cards
    /// cache in lockstep with the published data (refresh, optimistic
    /// action, server-result, and rollback paths all funnel through here).
    private func commitWorkflows(_ items: [WorkflowListItem]) {
        workflows = items
        workflowCards = WorkflowsPresentation.cards(from: items, calendar: .current)
    }

    /// `workflows_changed` server event: re-sync only when the list is already
    /// on screen (loaded/loading); a hidden view refreshes on `.task` anyway.
    func handleWorkflowsChanged() async {
        switch workflowsPhase {
        case .loaded, .loading:
            await refreshWorkflows()
        case .idle, .failed:
            break
        }
    }

    /// Confirm/Reject with optimistic update + rollback on error. The
    /// reducer supplies the pure transitions; this wires them to the injected
    /// executor and surfaces failures on `workflowsActionError`.
    /// SD-4: id-scoped rollback — see `runMemoryAction`.
    func runWorkflowAction(id: String, action: WorkflowActionKind) async {
        let snapshot = workflows
        if let optimistic = WorkflowsReducer.optimisticList(action: action, id: id, workflows: workflows) {
            commitWorkflows(optimistic)
        }
        workflowsActionError = nil
        do {
            let updated = try await daemon.workflowAction(id: id, action: action).updated
            commitWorkflows(WorkflowsReducer.list(
                applyingServerResult: updated,
                id: id,
                to: workflows
            ))
        } catch {
            commitWorkflows(ActionRollback.workflowRow(
                id: id,
                from: snapshot,
                to: workflows
            ))
            workflowsActionError = failureMessage(error)
        }
    }

    // MARK: - Daemon event routing + chat turn orchestration

    /// Single entry point for decoded `DaemonEvent`s (the coordinator only
    /// forwards; each feature's state machine lives with its feature).
    func apply(_ event: DaemonEvent) {
        switch event {
        case let .queueUpdated(pendingJobs):
            applyQueueUpdate(pendingJobs: pendingJobs)
        case .episodesChanged:
            Task { await handleEpisodesChanged() }
        case .memoriesChanged:
            Task { await handleMemoriesChanged() }
        case .workflowsChanged:
            Task { await handleWorkflowsChanged() }
        case let .chatChunk(requestId, delta):
            applyChatChunk(requestId: requestId, delta: delta)
        case let .chatDone(requestId, sessionId):
            applyChatDone(requestId: requestId, sessionId: sessionId)
        case let .chatError(requestId, code, message):
            applyChatError(requestId: requestId, code: code, message: message)
        case let .recordingState(state, reason):
            applyDaemonRecordingState(state: state, reason: reason)
        }
    }

    /// One full chat turn: append the user row, await the chat.send response,
    /// then let the chat_* server events (correlated by requestId) drive the
    /// phase machine. OWNS the whole send-window sequencing — including the
    /// stale-epoch guard — because it already owns that window's state.
    func sendChatMessage(_ text: String) async {
        appendUserMessage(text)
        // Round 27 stale-response race guard: capture the send-window epoch
        // before awaiting. If the window was superseded while the request
        // was in flight (watchdog fired, user re-sent), this response is for
        // a dead turn and must not pin the newer one.
        let epoch = currentSendWindowEpoch
        do {
            let result = try await daemon.sendChat(sessionId: currentChatSessionId, text: text)
            guard epoch == currentSendWindowEpoch else { return }
            applyChatSendResult(requestId: result.requestId, sessionId: result.sessionId)
        } catch {
            guard epoch == currentSendWindowEpoch else { return }
            applyChatSendFailure(failureMessage(error))
        }
    }

    /// Cancels the active turn. The daemon settles the phase via
    /// chat_error{code:"aborted"} — or chat_done if the run had already
    /// finished before the cancel landed.
    func cancelChat() async {
        guard let requestId = activeChatRequestId else { return }
        _ = try? await daemon.cancelChat(requestId: requestId)
    }

    /// User-facing text for a failed daemon roundtrip: a disconnect reads as
    /// the stable «Daemon connection unavailable» string everywhere (it used
    /// to come from nil-loader fast paths); everything else surfaces verbatim.
    private func failureMessage(_ error: Error) -> String {
        if case DaemonClientError.notConnected = error {
            return "Daemon connection unavailable"
        }
        return error.localizedDescription
    }

    // MARK: Chat state machine («Ask your history»; spec §3.19)

    /// Lifecycle of one conversation turn. `streaming` carries the ids pinned
    /// by the chat.send response; `failed(code)` mirrors the daemon's
    /// chat_error codes (`llm_unavailable` | `internal` | transport);
    /// `cancelled` is entered via chat_error{code:"aborted"} after a cancel.
    enum ChatPhase: Equatable, Sendable {
        case idle
        case streaming(sessionId: String, requestId: String)
        case failed(code: String)
        case cancelled
    }

    /// One transcript row.
    struct ChatMessage: Identifiable, Equatable, Sendable {
        let id = UUID()
        var role: ChatRole
        var text: String

        enum ChatRole: Equatable, Sendable {
            case user
            case assistant
        }
    }

    @Published private(set) var chatPhase: ChatPhase = .idle
    @Published private(set) var chatMessages: [ChatMessage] = []
    /// Cached text of the most recent user row, maintained at the three
    /// chatMessages mutation sites (user append, assistant append, clear) so
    /// the error-banner body evaluation stays O(1) instead of re-scanning the
    /// transcript on every render.
    private var cachedLastUserChatText: String?
    /// Assistant text accumulated from chat_chunk deltas; committed as one
    /// assistant row on chat_done.
    @Published private(set) var chatStreamingText: String?
    /// Human-readable reason behind `.failed`, shown in the error banner.
    @Published private(set) var chatErrorMessage: String?
    /// True from the user row being appended until the chat.send response
    /// (or its local failure) lands; gates a second send during the window
    /// where the phase machine has not yet pinned `.streaming`.
    @Published private(set) var isTurnPending = false
    /// SD-5: how long a turn may sit pending (user row appended, no
    /// chat.send response) before it fails locally. Injectable so tests fire
    /// the watchdog deterministically instead of sleeping 130 s.
    ///
    /// Nesting invariant: the daemon aborts a stalled chat.run at
    /// promptTimeoutMs = 120 s (CONSTANTS.promptTimeoutMs, apps/daemon/src/
    /// config.ts:64; pinned cross-language by swift-parity.test.ts) and
    /// delivers chat_error, so this local watchdog MUST be strictly greater
    /// (120 + 10 s margin). It only fires when the daemon's abort never
    /// arrives (dead transport), never racing the daemon's own timeout —
    /// same nesting as the round-37 daemon-watchdog/test-helper fix.
    var turnPendingWatchdogInterval: TimeInterval = 130

    private var turnPendingWatchdogTask: Task<Void, Never>?

    private var chatSessionId: String?
    /// The turn the daemon is currently streaming for; nil while idle.
    private var activeRequestId: String?
    /// True between "user row appended" and "send result pinned": deltas that
    /// raced ahead of the response frame are buffered instead of dropped.
    private var awaitingSendResult = false
    /// Round 27: monotonically increasing token for the send window. A late
    /// response from a superseded turn (watchdog already failed turn A, user
    /// re-sent as B) must not pin B's window — awaitingSendResult alone
    /// cannot tell whose response arrived.
    private var sendWindowEpoch = 0
    private var bufferedChunks: [String: [String]] = [:]
    /// Terminal events (chat_done/chat_error) that raced ahead of the send
    /// response; keyed by requestId with the same discipline as
    /// `bufferedChunks`, resolved once applyChatSendResult pins the turn.
    private enum BufferedTerminal {
        case done(sessionId: String)
        case error(code: String, message: String)
    }

    private var bufferedTerminals: [String: BufferedTerminal] = [:]

    /// Test seam: deltas currently buffered ahead of a send result.
    var bufferedChatChunkCount: Int {
        bufferedChunks.values.map(\.count).reduce(0, +)
    }

    /// Session id to reuse for the next turn; nil starts a new conversation.
    var currentChatSessionId: String? {
        chatSessionId
    }

    /// Epoch of the most recently opened send window; the connection layer
    /// captures it before awaiting chat.send and discards stale results.
    var currentSendWindowEpoch: Int {
        sendWindowEpoch
    }

    var isChatStreaming: Bool {
        if case .streaming = chatPhase {
            return true
        }
        return false
    }

    /// The requestId an in-flight cancel must target; nil while not streaming.
    var activeChatRequestId: String? {
        guard case let .streaming(_, requestId) = chatPhase else { return nil }
        return requestId
    }

    /// Text of the most recent user row; powers the error-banner Retry.
    var lastUserChatText: String? {
        cachedLastUserChatText
    }

    /// Appends the user's message row. The phase only moves to `.streaming`
    /// once applyChatSendResult pins the turn's ids. SD-5: arms the
    /// pending-turn watchdog so a daemon that accepts bytes but never
    /// replies cannot pin the composer forever.
    func appendUserMessage(_ text: String) {
        chatMessages.append(ChatMessage(role: .user, text: text))
        cachedLastUserChatText = text
        chatStreamingText = nil
        chatErrorMessage = nil
        sendWindowEpoch += 1
        awaitingSendResult = true
        isTurnPending = true
        startTurnPendingWatchdog()
    }

    /// SD-5 watchdog: fails a still-pending turn locally via the existing
    /// applyChatSendFailure path once `turnPendingWatchdogInterval` elapses,
    /// engaging the banner + retry machinery. Cancelled by every transition
    /// that resolves the pending window.
    private func startTurnPendingWatchdog() {
        turnPendingWatchdogTask?.cancel()
        let interval = turnPendingWatchdogInterval
        turnPendingWatchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.applyChatSendFailure("The request timed out waiting for the daemon.")
        }
    }

    private func cancelTurnPendingWatchdog() {
        turnPendingWatchdogTask?.cancel()
        turnPendingWatchdogTask = nil
    }

    /// SD-5 user-facing escape hatch: cancels a still-pending turn locally.
    /// The wire `chat.cancel` has no requestId to target yet (the send
    /// response never pinned one), so the turn is resolved here; it enters
    /// `.cancelled` — the same phase a wire `chat_error{aborted}` produces
    /// for a pinned turn — so no failure banner or Retry invites the user to
    /// re-send what they just cancelled. No-op once the turn resolved or
    /// moved on to streaming.
    func cancelPendingTurn() {
        guard awaitingSendResult else { return }
        awaitingSendResult = false
        isTurnPending = false
        cancelTurnPendingWatchdog()
        bufferedChunks.removeAll()
        bufferedTerminals.removeAll()
        chatStreamingText = nil
        chatErrorMessage = nil
        chatPhase = .cancelled
    }

    /// Local transport failure of the chat.send roundtrip itself (no response
    /// frame arrived); typed `.failed` so the banner + retry path engage.
    func applyChatSendFailure(_ message: String) {
        guard awaitingSendResult else { return }
        awaitingSendResult = false
        isTurnPending = false
        cancelTurnPendingWatchdog()
        bufferedChunks.removeAll()
        bufferedTerminals.removeAll()
        chatStreamingText = nil
        chatErrorMessage = message
        chatPhase = .failed(code: "internal")
    }

    /// chat.send response: pins the active turn and flushes early deltas.
    func applyChatSendResult(requestId: String, sessionId: String) {
        guard awaitingSendResult else { return }
        awaitingSendResult = false
        isTurnPending = false
        cancelTurnPendingWatchdog()
        chatSessionId = sessionId
        activeRequestId = requestId
        chatPhase = .streaming(sessionId: sessionId, requestId: requestId)
        if let early = bufferedChunks.removeValue(forKey: requestId), !early.isEmpty {
            chatStreamingText = early.joined()
        }
        // A terminal event that raced ahead of this response frame resolves
        // the freshly pinned turn immediately instead of leaving it wedged
        // in .streaming with the terminal consumed.
        switch bufferedTerminals.removeValue(forKey: requestId) {
        case let .done(sessionId)?:
            applyChatDone(requestId: requestId, sessionId: sessionId)
        case let .error(code, message)?:
            applyChatError(requestId: requestId, code: code, message: message)
        case nil:
            break
        }
    }

    /// SD-6: stable identity for the in-flight assistant draft row — keyed
    /// on the pinned requestId so per-chunk body evaluations never change
    /// the SwiftUI `.id` and tear the streaming bubble down on every delta;
    /// a constant marker covers deltas racing ahead of the send response.
    var streamingDraftId: String {
        activeChatRequestId ?? "chat-streaming-draft"
    }

    /// chat_chunk delta. Out-of-order guard: deltas are applied only for the
    /// currently pinned turn; unknown/stale requestIds never touch the draft.
    func applyChatChunk(requestId: String, delta: String) {
        if case .streaming = chatPhase, requestId == activeRequestId {
            chatStreamingText = (chatStreamingText ?? "") + delta
            return
        }
        // Deltas racing ahead of the send response wait under their own key;
        // anything unclaimed is stale and stays ignored forever.
        if awaitingSendResult {
            bufferedChunks[requestId, default: []].append(delta)
        }
    }

    /// chat_done commits the streamed draft as an assistant row. Late dones
    /// for turns that already resolved are ignored; a done racing ahead of
    /// the send response is buffered under its requestId and applied once
    /// applyChatSendResult pins the turn.
    func applyChatDone(requestId: String, sessionId: String) {
        guard requestId == activeRequestId else {
            if awaitingSendResult {
                bufferedTerminals[requestId] = .done(sessionId: sessionId)
            }
            return
        }
        activeRequestId = nil
        chatSessionId = sessionId
        chatMessages.append(ChatMessage(role: .assistant, text: chatStreamingText ?? ""))
        chatStreamingText = nil
        chatPhase = .idle
    }

    /// chat_error resolves the pinned turn: `aborted` maps to `.cancelled`
    /// (the user asked for it), everything else to `.failed(code)`. An error
    /// racing ahead of the send response is buffered the same way as done.
    func applyChatError(requestId: String, code: String, message: String) {
        guard requestId == activeRequestId else {
            if awaitingSendResult {
                bufferedTerminals[requestId] = .error(code: code, message: message)
            }
            return
        }
        activeRequestId = nil
        chatStreamingText = nil
        if code == "aborted" {
            chatPhase = .cancelled
        } else {
            chatErrorMessage = message.isEmpty ? code : message
            chatPhase = .failed(code: code)
        }
    }

    /// Connection lost while a chat turn was outstanding: fail whatever the
    /// phase machine still holds so the composer never stays disabled across
    /// a daemon restart. A pending send routes through the standard failure
    /// path (banner + retry); an already-pinned .streaming turn resolves to
    /// `.failed` with a transport message. chatSessionId is deliberately
    /// kept: the daemon allocates unknown session ids on demand, so reuse
    /// across a restart preserves continuity across sub-second blips.
    func handleConnectionLost() {
        if awaitingSendResult {
            applyChatSendFailure("The connection to the daemon was lost.")
            return
        }
        guard case .streaming = chatPhase else { return }
        activeRequestId = nil
        chatStreamingText = nil
        bufferedChunks.removeAll()
        bufferedTerminals.removeAll()
        isTurnPending = false
        chatErrorMessage = "The connection to the daemon was lost."
        chatPhase = .failed(code: "internal")
    }

    /// New conversation: clears transcript and drops the server session so
    /// the next send allocates a fresh one.
    func resetConversation() {
        chatMessages.removeAll()
        cachedLastUserChatText = nil
        chatStreamingText = nil
        chatErrorMessage = nil
        chatSessionId = nil
        activeRequestId = nil
        awaitingSendResult = false
        isTurnPending = false
        cancelTurnPendingWatchdog()
        bufferedChunks.removeAll()
        bufferedTerminals.removeAll()
        chatPhase = .idle
    }

    /// SF Symbol shown in the menu bar; maps the state machine onto the four
    /// pinned icon states from spec §3.26. SD-3: a daemon-initiated pause
    /// (`recording_state` events, spec §3.25 disk pressure) reads as `.paused`
    /// too — previously it surfaced only in Diagnostics while the popover
    /// kept claiming «Recording» and offering Pause.
    var menuBarIconState: MenuBarIconState {
        if case .degraded = daemonStatus {
            return .daemonError
        }
        if permissionState == .denied {
            return .permissionMissing
        }
        if recordingState.isPaused || isDaemonRecordingPaused || !isDaemonHealthy {
            return .paused
        }
        return .recording
    }

    private var isDaemonHealthy: Bool {
        switch daemonStatus {
        case .connected: true
        default: false
        }
    }

    var menuBarSymbolName: String {
        switch menuBarIconState {
        case .recording: "record.circle"
        case .paused: "pause.circle"
        case .permissionMissing: "exclamationmark.shield"
        case .daemonError: "xmark.octagon"
        }
    }
}

extension RecordingState {
    var isPaused: Bool {
        if case .paused = self {
            return true
        }
        return false
    }
}

// MARK: - SD-4 id-scoped action rollback

/// Pure rollback transitions scoped to ONE acted-on record id. The previous
/// whole-snapshot restore silently discarded an interleaved authoritative
/// merge of another record: confirm(A) → reject(B) failing reverted the list
/// to B's pre-action snapshot, erasing A's server-confirmed row.
///
/// These mirror `MemoriesReducer`/`WorkflowsReducer` semantics but live here
/// because those reducer homes are sibling-owned view files. Kept pure and
/// deterministic for direct unit testing.
private enum ActionRollback {
    /// Restores only `id`'s pre-action memory row from the snapshot into the
    /// current groups: the acted-on row is re-homed into its canonical bucket
    /// (newest-lastSeen-first, matching `MemoriesReducer.insert`) while every
    /// other row keeps whatever authoritative state it reached. Unknown id in
    /// the snapshot (nothing was optimistically applied) leaves groups as-is.
    static func memoriesRow(
        id: String,
        from snapshot: [MemoriesListGroup],
        to current: [MemoriesListGroup]
    ) -> [MemoriesListGroup] {
        guard let original = snapshot.lazy.compactMap({ group in
            group.memories.first { $0.id == id }
        }).first else {
            return current
        }
        var next = current.map { group in
            MemoriesListGroup(status: group.status, memories: group.memories.filter { $0.id != id })
        }
        let status = MemoriesReducer.group(for: original.status)
        if let index = next.firstIndex(where: { $0.status == status }) {
            var memories = next[index].memories.filter { $0.id != id }
            let position =
                memories.firstIndex(where: { $0.lastSeenAtMs < original.lastSeenAtMs })
                    ?? memories.count
            memories.insert(original, at: position)
            next[index].memories = memories
        } else {
            let merged = MemoriesReducer.canonicalOrder.firstIndex(of: status) ?? next.count
            next.insert(MemoriesListGroup(status: status, memories: [original]), at: min(merged, next.count))
        }
        return next
    }

    /// Restores only `id`'s pre-action workflow item: replaced in place when
    /// still present; otherwise (optimistic/concurrent removal dropped it)
    /// re-inserted at its snapshot position clamped to current bounds —
    /// order is best-effort once an interleaved action reshuffled neighbors.
    static func workflowRow(
        id: String,
        from snapshot: [WorkflowListItem],
        to current: [WorkflowListItem]
    ) -> [WorkflowListItem] {
        guard let original = snapshot.first(where: { $0.id == id }) else {
            return current
        }
        var next = current
        if let index = next.firstIndex(where: { $0.id == id }) {
            next[index] = original
            return next
        }
        let snapshotIndex = snapshot.firstIndex { $0.id == id } ?? 0
        next.insert(original, at: min(snapshotIndex, next.count))
        return next
    }
}
