import Foundation

/// Server-pushed event, decoded ONCE at the IPC boundary. The wire frame's
/// `kind` string + raw payload never leak past DaemonClient: consumers switch
/// over typed cases with their payload fields already extracted. Unrecognized
/// kinds (or payloads failing their schema mirror) are dropped at decode —
/// exactly the old «ignore until the feature lands» behavior, now in one place.
enum DaemonEvent: Sendable, Equatable {
    case queueUpdated(pendingJobs: Int)
    case episodesChanged
    case memoriesChanged
    case workflowsChanged
    case chatChunk(requestId: String, delta: String)
    case chatDone(requestId: String, sessionId: String)
    case chatError(requestId: String, code: String, message: String)
    case recordingState(state: String, reason: String?)
}

/// The daemon's data surface as the app consumes it: typed request/response
/// operations only — no connection lifecycle. Implemented by DaemonClient
/// (whose socket/framing/request machinery stays internal) and by test fakes.
///
/// Connection state is NOT modeled here on purpose: calling any method while
/// disconnected throws `DaemonClientError.notConnected`, which AppState maps
/// to its stable «Daemon connection unavailable» user string. Nothing needs
/// to be installed or removed per handshake; wiring is atomic at construction.
protocol DaemonAPI: Sendable {
    func listTimeline(
        from: Int64?,
        to: Int64?,
        limit: Int
    ) async throws -> TimelineListResult

    func listSegments(
        from: Int64?,
        to: Int64?,
        limit: Int
    ) async throws -> SegmentsListResult

    func getEpisode(id: String) async throws -> EpisodeGetResult

    func searchHistory(_ params: HistorySearchParams) async throws -> HistorySearchResult

    func listMemories(status: String?) async throws -> MemoriesListResult

    func memoryAction(id: String, action: MemoryActionKind) async throws -> MemoryActionResult

    func listWorkflows(status: String?) async throws -> WorkflowsListResult

    func workflowAction(id: String, action: WorkflowActionKind) async throws -> WorkflowActionResult

    func fetchStatus() async throws -> StatusResult

    func fetchSettings() async throws -> SettingsGetResult

    func fetchDiagnostics() async throws -> DiagnosticsGetResult

    func deleteHistory(_ params: DeleteRangeParams) async throws -> DeleteRangeResult

    @discardableResult
    func sendChat(sessionId: String?, text: String) async throws -> ChatSendResult

    @discardableResult
    func cancelChat(requestId: String) async throws -> ChatCancelResult
}

extension DaemonClient: DaemonAPI {}
