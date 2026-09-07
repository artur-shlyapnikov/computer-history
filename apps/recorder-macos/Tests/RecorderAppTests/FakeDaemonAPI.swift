import Foundation
@testable import RecorderApp

/// Closure-backed `DaemonAPI` fake. Every operation defaults to throwing
/// `DaemonClientError.notConnected` — the same «no live connection» semantics
/// the old nil-loader slots had — and a test overrides exactly the operations
/// its scenario needs. Overrides return the APP-shaped values the old loaders
/// returned (episode arrays, group arrays, updated rows…) so migrated tests
/// change only the name of the slot they install.
///
/// Closures are `@MainActor`: AppState calls them from its own isolation, so
/// test bodies can touch MainActor helpers without extra hops.
///
/// `@unchecked Sendable`: the override closures are test-authored; the fake
/// carries no mutable state beyond them.
final class FakeDaemonAPI: DaemonAPI, @unchecked Sendable {
    var onListTimeline: (@MainActor () async throws -> [EpisodeSummaryDto])?
    var onListSegments: (@MainActor () async throws -> [SegmentSummaryDto])?
    var onGetEpisode: (@MainActor (_ id: String) async throws -> EpisodeGetResult)?
    var onSearchHistory: (@MainActor (_ params: HistorySearchParams) async throws -> HistorySearchResult)?
    var onListMemories: (@MainActor () async throws -> [MemoriesListGroup])?
    var onMemoryAction: (
        @MainActor (_ id: String, _ action: MemoryActionKind) async throws -> MemoryCandidateDto?
    )?
    var onListWorkflows: (@MainActor () async throws -> [WorkflowListItem])?
    var onWorkflowAction: (
        @MainActor (_ id: String, _ action: WorkflowActionKind) async throws -> WorkflowDto?
    )?
    var onFetchStatus: (@MainActor () async throws -> StatusResult)?
    var onFetchSettings: (@MainActor () async throws -> SettingsGetResult)?
    var onFetchDiagnostics: (@MainActor () async throws -> DiagnosticsGetResult?)?
    var onDeleteHistory: (
        @MainActor (_ params: DeleteRangeParams) async throws -> DeleteRangeDeletedCounts
    )?
    var onSendChat: (
        @MainActor (_ sessionId: String?, _ text: String) async throws -> ChatSendResult
    )?
    var onCancelChat: (@MainActor (_ requestId: String) async throws -> ChatCancelResult)?

    func listTimeline(from _: Int64?, to _: Int64?, limit _: Int) async throws -> TimelineListResult {
        guard let onListTimeline else { throw DaemonClientError.notConnected }
        let episodes = try await onListTimeline()
        return TimelineListResult(episodes: episodes)
    }

    func listSegments(from _: Int64?, to _: Int64?, limit _: Int) async throws -> SegmentsListResult {
        guard let onListSegments else { throw DaemonClientError.notConnected }
        let segments = try await onListSegments()
        return SegmentsListResult(segments: segments)
    }

    func getEpisode(id: String) async throws -> EpisodeGetResult {
        guard let onGetEpisode else { throw DaemonClientError.notConnected }
        return try await onGetEpisode(id)
    }

    func searchHistory(_ params: HistorySearchParams) async throws -> HistorySearchResult {
        guard let onSearchHistory else { throw DaemonClientError.notConnected }
        return try await onSearchHistory(params)
    }

    func listMemories(status _: String?) async throws -> MemoriesListResult {
        guard let onListMemories else { throw DaemonClientError.notConnected }
        let groups = try await onListMemories()
        return MemoriesListResult(groups: groups)
    }

    func memoryAction(id: String, action: MemoryActionKind) async throws -> MemoryActionResult {
        guard let onMemoryAction else { throw DaemonClientError.notConnected }
        let updated = try await onMemoryAction(id, action)
        return MemoryActionResult(updated: updated)
    }

    func listWorkflows(status _: String?) async throws -> WorkflowsListResult {
        guard let onListWorkflows else { throw DaemonClientError.notConnected }
        let workflows = try await onListWorkflows()
        return WorkflowsListResult(workflows: workflows)
    }

    func workflowAction(id: String, action: WorkflowActionKind) async throws -> WorkflowActionResult {
        guard let onWorkflowAction else { throw DaemonClientError.notConnected }
        let updated = try await onWorkflowAction(id, action)
        return WorkflowActionResult(updated: updated)
    }

    func fetchStatus() async throws -> StatusResult {
        guard let onFetchStatus else { throw DaemonClientError.notConnected }
        return try await onFetchStatus()
    }

    func fetchSettings() async throws -> SettingsGetResult {
        guard let onFetchSettings else { throw DaemonClientError.notConnected }
        return try await onFetchSettings()
    }

    func fetchDiagnostics() async throws -> DiagnosticsGetResult {
        guard let onFetchDiagnostics else { throw DaemonClientError.notConnected }
        // The old diagnosticsLoader was optional-chained at the call site
        // (nil ⇒ skipped); a thrown notConnected preserves that best-effort
        // shape for tests that only care about status.
        guard let result = try await onFetchDiagnostics() else {
            throw DaemonClientError.notConnected
        }
        return result
    }

    func deleteHistory(_ params: DeleteRangeParams) async throws -> DeleteRangeResult {
        guard let onDeleteHistory else { throw DaemonClientError.notConnected }
        let deleted = try await onDeleteHistory(params)
        return DeleteRangeResult(deleted: deleted)
    }

    func sendChat(sessionId: String?, text: String) async throws -> ChatSendResult {
        guard let onSendChat else { throw DaemonClientError.notConnected }
        return try await onSendChat(sessionId, text)
    }

    func cancelChat(requestId: String) async throws -> ChatCancelResult {
        guard let onCancelChat else { throw DaemonClientError.notConnected }
        return try await onCancelChat(requestId)
    }
}
