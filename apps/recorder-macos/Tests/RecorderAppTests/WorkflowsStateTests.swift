import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe counter: the loader closure is @Sendable, so the test counts
/// invocations through a locked box instead of a captured local.
private final class WorkflowLoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() {
        lock.lock(); value += 1; lock.unlock()
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }; return value
    }
}

/// Pure view-model tests for M6 workflows: presentation mapping
/// (WorkflowsPresentation), optimistic-rollback reducer (WorkflowsReducer),
/// and AppState's phase / action machine driven through injected loaders
/// (spec §3.20).
@MainActor
struct WorkflowsStateTests {
    // MARK: Fixtures

    /// Deterministic workflow factory; ids/status/median/occurrences vary.
    private static func workflow(
        id: String,
        status: WorkflowStatusMirror,
        median: Double = 0.82,
        lastSeen: Int64 = 1_787_443_200_000,
        occurrences: [WorkflowOccurrenceDto] = []
    ) -> WorkflowListItem {
        WorkflowListItem(
            id: id,
            name: "File a Jira issue from Slack",
            purpose: "Turn Slack problem reports into tracked issues",
            status: status,
            template: WorkflowTemplate(
                name: "File a Jira issue from Slack",
                purpose: "Turn Slack problem reports into tracked issues",
                preconditions: ["Jira open in browser"],
                stableSteps: ["Focus Slack", "Click button Create", "Edit textarea"],
                variableInputs: ["issue summary text"],
                expectedOutcome: "New Jira issue created"
            ),
            occurrenceCount: occurrences.count,
            medianSimilarity: median,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: lastSeen,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_200_000,
            occurrences: occurrences
        )
    }

    private static func occurrence(
        episode: String,
        startedAt: Int64,
        similarity: Double
    ) -> WorkflowOccurrenceDto {
        WorkflowOccurrenceDto(episodeId: episode, startedAtMs: startedAt, similarity: similarity)
    }

    private static let candidateId = "01M6WORKFLOWCANDIDATE000001"
    private static let confirmedId = "01M6WORKFLOWCONFIRMED0000002"
    private static let rejectedId = "01M6WORKFLOWREJECTED00000003"

    private static var sampleWorkflows: [WorkflowListItem] {
        [
            workflow(
                id: candidateId,
                status: .candidate,
                occurrences: [
                    occurrence(episode: "01M6OCCURRENCEEPISODE00001", startedAt: 1_787_443_200_000, similarity: 0.86),
                    occurrence(episode: "01M6OCCURRENCEEPISODE00002", startedAt: 1_787_356_800_000, similarity: 0.81),
                    occurrence(episode: "01M6OCCURRENCEEPISODE00003", startedAt: 1_787_270_400_000, similarity: 0.79),
                ]
            ),
            workflow(id: confirmedId, status: .confirmed),
            workflow(id: rejectedId, status: .rejected),
        ]
    }

    private func varCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    // MARK: Presentation mapping

    @Test("candidate headline is the pinned spec wording")
    func candidateHeadlinePinned() {
        #expect(WorkflowsPresentation.candidateHeadline == "You seem to repeat this workflow.")
    }

    @Test("occurrence count copy is singular-aware")
    func occurrenceCountCopy() {
        #expect(WorkflowsPresentation.occurrenceCountText(1) == "1 occurrence")
        #expect(WorkflowsPresentation.occurrenceCountText(4) == "4 occurrences")
        #expect(WorkflowsPresentation.occurrenceCountText(0) == "0 occurrences")
    }

    @Test("card model renders template fields, median percent and occurrence rows")
    func cardModelFields() throws {
        let card = WorkflowsPresentation.card(for: Self.sampleWorkflows[0], calendar: varCalendar())
        #expect(card.headline == "You seem to repeat this workflow.")
        #expect(card.name == "File a Jira issue from Slack")
        #expect(card.purposeText == "Turn Slack problem reports into tracked issues")
        #expect(card.preconditions == ["Jira open in browser"])
        #expect(card.stableSteps == ["Focus Slack", "Click button Create", "Edit textarea"])
        #expect(card.variableInputs == ["issue summary text"])
        #expect(card.expectedOutcomeText == "New Jira issue created")
        #expect(card.medianSimilarityText == "82%")
        #expect(card.offersActions)
        // Occurrence rows: integer-percent similarity + pinned-calendar date.
        #expect(card.occurrences.map(\.similarityText) == ["86%", "81%", "79%"])
        #expect(card.occurrences.map(\.episodeId) == [
            "01M6OCCURRENCEEPISODE00001", "01M6OCCURRENCEEPISODE00002", "01M6OCCURRENCEEPISODE00003",
        ])
        // Date text is fully determined by the injected calendar. With an
        // explicitly pinned POSIX locale the expectation is exact.
        var posixCalendar = Calendar(identifier: .gregorian)
        posixCalendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        posixCalendar.locale = Locale(identifier: "en_US_POSIX")
        let posixCard = WorkflowsPresentation.card(for: Self.sampleWorkflows[0], calendar: posixCalendar)
        // 1787443200000 = 2026-08-23T00:00:00Z.
        #expect(posixCard.occurrences[0].startedAtText == "00:00 Aug 23")
        #expect(posixCard.occurrences[2].startedAtText == "00:00 Aug 21")
        // Without a calendar locale the row reuses the shared formatter output.
        #expect(card.occurrences[0].startedAtText == WorkflowsPresentation.startedAtText(
            ms: 1_787_443_200_000,
            calendar: varCalendar()
        ))
    }

    @Test("startedAtText appends the year only for occurrences outside the current calendar year")
    func startedAtTextYearDisambiguation() throws {
        var posix = Calendar(identifier: .gregorian)
        posix.timeZone = try #require(TimeZone(identifier: "UTC"))
        posix.locale = Locale(identifier: "en_US_POSIX")
        // now = 2026-08-23T00:00:00Z.
        let now = Date(timeIntervalSince1970: 1_787_443_200)
        // Current-year occurrence keeps the compact form byte-identical.
        #expect(WorkflowsPresentation.startedAtText(ms: 1_787_443_200_000, calendar: posix, now: now) == "00:00 Aug 23")
        // Same month/day one year earlier still disambiguates with the year.
        #expect(WorkflowsPresentation.startedAtText(ms: 1_755_907_200_000, calendar: posix, now: now) == "00:00 Aug 23 2025")
        // A prior-year January occurrence renders unambiguously too.
        #expect(WorkflowsPresentation.startedAtText(ms: 1_736_076_000_000, calendar: posix, now: now) == "11:20 Jan 5 2025")
    }

    @Test("only candidate cards offer Confirm/Reject actions")
    func actionsOnlyForCandidates() {
        #expect(WorkflowsPresentation.card(for: Self.sampleWorkflows[0]).offersActions)
        #expect(!WorkflowsPresentation.card(for: Self.sampleWorkflows[1]).offersActions)
        #expect(!WorkflowsPresentation.card(for: Self.sampleWorkflows[2]).offersActions)
    }

    @Test("cards sort newest-lastSeen first regardless of wire order")
    func cardsSortByLastSeenDescending() {
        let older = Self.workflow(id: Self.candidateId, status: .candidate, lastSeen: 1_787_000_000_000)
        let newer = Self.workflow(id: Self.confirmedId, status: .confirmed, lastSeen: 1_787_443_200_000)
        let cards = WorkflowsPresentation.cards(from: [older, newer])
        #expect(cards.map(\.id) == [Self.confirmedId, Self.candidateId])
    }

    @Test("equal lastSeenAtMs cards tie-break by id ascending")
    func equalLastSeenCardsTieBreakByIdAscending() {
        let shared: Int64 = 1_787_443_200_000
        // candidateId sorts before confirmedId; input order reversed
        // so only the id tie-break can produce this order.
        let workflows = [
            Self.workflow(id: Self.candidateId, status: .candidate, lastSeen: shared),
            Self.workflow(id: Self.confirmedId, status: .confirmed, lastSeen: shared),
        ]
        #expect(WorkflowsPresentation.cards(from: workflows).map(\.id) == [Self.candidateId, Self.confirmedId])
    }

    @Test("occurrence row ids stay unique when one episodeId appears twice")
    func duplicateEpisodeIdsGetUniqueRowIds() {
        let duplicated = Self.workflow(
            id: Self.candidateId,
            status: .candidate,
            occurrences: [
                Self.occurrence(episode: "01M6OCCURRENCEEPISODE00001", startedAt: 1_787_443_200_000, similarity: 0.86),
                Self.occurrence(episode: "01M6OCCURRENCEEPISODE00001", startedAt: 1_787_356_800_000, similarity: 0.81),
            ]
        )
        let card = WorkflowsPresentation.card(for: duplicated, calendar: varCalendar())
        #expect(card.occurrences.map(\.episodeId) == [
            "01M6OCCURRENCEEPISODE00001", "01M6OCCURRENCEEPISODE00001",
        ])
        // ForEach identity: offset suffix keeps repeated episodeIds distinct.
        #expect(card.occurrences[0].id != card.occurrences[1].id)
        #expect(card.occurrences.map(\.id) == [
            "01M6OCCURRENCEEPISODE00001#0", "01M6OCCURRENCEEPISODE00001#1",
        ])
    }

    @Test("partially synthesized template renders honestly with empty sections")
    func sparseTemplateRendersEmpty() {
        let sparse = WorkflowListItem(
            id: Self.candidateId,
            name: "Bare candidate",
            purpose: nil,
            status: .candidate,
            template: WorkflowTemplate(),
            occurrenceCount: 0,
            medianSimilarity: 0.78,
            firstSeenAtMs: 0,
            lastSeenAtMs: 0,
            createdAtMs: 0,
            updatedAtMs: 0,
            occurrences: []
        )
        let card = WorkflowsPresentation.card(for: sparse)
        #expect(card.preconditions.isEmpty && card.stableSteps.isEmpty)
        #expect(card.variableInputs.isEmpty && card.expectedOutcomeText == nil)
        #expect(card.occurrences.isEmpty)
        #expect(card.medianSimilarityText == "78%")
    }

    // MARK: Optimistic-rollback reducer

    @Test("optimistic confirm flips status in place without reordering")
    func optimisticConfirm() throws {
        let next = try #require(WorkflowsReducer.optimisticList(action: .confirm, id: Self.candidateId, workflows: Self.sampleWorkflows))
        #expect(next.map(\.id) == Self.sampleWorkflows.map(\.id))
        #expect(next.first { $0.id == Self.candidateId }?.status == .confirmed)
    }

    @Test("optimistic reject flips status to rejected")
    func optimisticReject() throws {
        let next = try #require(WorkflowsReducer.optimisticList(action: .reject, id: Self.candidateId, workflows: Self.sampleWorkflows))
        #expect(next.first { $0.id == Self.candidateId }?.status == .rejected)
    }

    @Test("unknown id returns nil (no local mutation)")
    func unknownIdReturnsNil() {
        #expect(WorkflowsReducer.optimisticList(action: .confirm, id: "01M6UNKNOWNWORKFLOW000001", workflows: Self.sampleWorkflows) == nil)
    }

    @Test("server result merges authoritatively and keeps local occurrences")
    func serverResultMerge() throws {
        let updated = WorkflowDto(
            id: Self.candidateId,
            name: "File a Jira issue from Slack",
            purpose: nil,
            status: .confirmed,
            template: WorkflowTemplate(),
            occurrenceCount: 3,
            medianSimilarity: 0.82,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: 1_787_443_200_000,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_200_100
        )
        let merged = WorkflowsReducer.list(applyingServerResult: updated, id: Self.candidateId, to: Self.sampleWorkflows)
        let row = try #require(merged.first { $0.id == Self.candidateId })
        #expect(row.status == .confirmed)
        #expect(row.occurrences.count == 3) // list projection keeps occurrences
        #expect(row.updatedAtMs == 1_787_443_200_100)
        // Other rows untouched.
        #expect(merged.first { $0.id == Self.confirmedId }?.status == .confirmed)
    }

    @Test("server result nil (row vanished) drops the row")
    func serverResultNilDropsRow() {
        let merged = WorkflowsReducer.list(applyingServerResult: nil, id: Self.candidateId, to: Self.sampleWorkflows)
        #expect(!merged.contains { $0.id == Self.candidateId })
        #expect(merged.count == Self.sampleWorkflows.count - 1)
    }

    @Test("rollback restores the exact pre-action snapshot")
    func rollbackRestoresSnapshot() throws {
        let snapshot = Self.sampleWorkflows
        let optimistic = try #require(WorkflowsReducer.optimisticList(action: .reject, id: Self.candidateId, workflows: Self.sampleWorkflows))
        #expect(WorkflowsReducer.rollback(to: snapshot) == snapshot)
        #expect(optimistic != snapshot)
    }

    // MARK: AppState phase + action machine

    @Test("refresh cycles idle → loading → loaded and stores workflows")
    func refreshLoaded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        #expect(state.workflowsPhase == .idle)
        api.onListWorkflows = { [Self.workflow(id: Self.candidateId, status: .candidate)] }
        await state.refreshWorkflows()
        #expect(state.workflowsPhase == .loaded)
        #expect(state.workflows.count == 1)
        #expect(state.workflows[0].status == .candidate)
    }

    @Test("refresh failure surfaces failed(message); unset backend fails immediately")
    func refreshFailures() async {
        let state = AppState(daemon: FakeDaemonAPI())
        await state.refreshWorkflows()
        #expect(state.workflowsPhase == .failed("Daemon connection unavailable"))

        let offlineApi = FakeDaemonAPI()
        let offline = AppState(daemon: offlineApi)
        offlineApi.onListWorkflows = { throw DaemonClientError.notConnected }
        await offline.refreshWorkflows()
        #expect(offline.workflowsPhase == .failed("Daemon connection unavailable"))
    }

    @Test("successful confirm applies the server answer and clears prior errors")
    func runActionSuccess() async throws {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListWorkflows = { Self.sampleWorkflows }
        await state.refreshWorkflows()

        // Seed a prior action error through a failing action (private(set)).
        struct SeedFailure: Error {}
        api.onWorkflowAction = { _, _ in throw SeedFailure() }
        await state.runWorkflowAction(id: Self.candidateId, action: .reject)
        #expect(state.workflowsActionError != nil)

        api.onWorkflowAction = { id, action in
            #expect(id == Self.candidateId && action == .confirm)
            return WorkflowDto(
                id: id,
                name: "File a Jira issue from Slack",
                purpose: nil,
                status: .confirmed,
                template: WorkflowTemplate(),
                occurrenceCount: 3,
                medianSimilarity: 0.82,
                firstSeenAtMs: 1_787_000_000_000,
                lastSeenAtMs: 1_787_443_200_000,
                createdAtMs: 1_787_000_010_000,
                updatedAtMs: 1_787_443_200_100
            )
        }
        await state.runWorkflowAction(id: Self.candidateId, action: .confirm)

        #expect(state.workflowsActionError == nil)
        let row = try #require(state.workflows.first { $0.id == Self.candidateId })
        #expect(row.status == .confirmed)
        #expect(row.occurrences.count == 3)
    }

    @Test("failed confirm rolls back to the exact pre-action snapshot and surfaces the error")
    func runActionRollback() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListWorkflows = { Self.sampleWorkflows }
        await state.refreshWorkflows()

        struct Boom: Error {}
        api.onWorkflowAction = { _, _ in throw Boom() }
        await state.runWorkflowAction(id: Self.candidateId, action: .confirm)

        #expect(state.workflows == Self.sampleWorkflows)
        #expect(state.workflowsActionError != nil && !(state.workflowsActionError ?? "").isEmpty)
        // Phase untouched by actions stays loaded.
        #expect(state.workflowsPhase == .loaded)
    }

    @Test("action without an installed backend closure surfaces an error without mutating workflows")
    func runActionWithoutExecutor() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListWorkflows = { Self.sampleWorkflows }
        await state.refreshWorkflows()
        await state.runWorkflowAction(id: Self.candidateId, action: .reject)
        #expect(state.workflows == Self.sampleWorkflows)
        #expect(state.workflowsActionError == "Daemon connection unavailable")
    }

    @Test("workflows_changed refreshes only when the list is visible; hidden view ignores it")
    func changedEventRefreshGate() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let loads = WorkflowLoadCounter()
        api.onListWorkflows = {
            loads.increment()
            return Self.sampleWorkflows
        }
        await state.handleWorkflowsChanged()
        #expect(loads.count == 0) // idle: event ignored

        await state.refreshWorkflows()
        #expect(loads.count == 1)
        await state.handleWorkflowsChanged()
        #expect(loads.count == 2) // loaded: refreshed
        #expect(state.workflowsPhase == .loaded)
    }
}
