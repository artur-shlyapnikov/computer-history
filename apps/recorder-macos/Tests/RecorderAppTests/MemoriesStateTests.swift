import Foundation
@testable import RecorderApp
import Testing

/// Thread-safe counter: the loader closure is @Sendable, so the test counts
/// invocations through a locked box instead of a captured local.
private final class LoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() {
        lock.lock(); value += 1; lock.unlock()
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }; return value
    }
}

/// Pure view-model tests for M5 memories: grouping map (MemoriesPresentation),
/// optimistic-rollback reducer (MemoriesReducer), and AppState's phase /
/// action machine driven through injected loaders (spec §3.16–3.17).
@MainActor
struct MemoriesStateTests {
    // MARK: Fixtures

    /// Deterministic memory factory; ids/status/confidence/evidence vary.
    private static func memory(
        id: String,
        status: MemoryStatus,
        confidence: Double = 0.9,
        evidence: Int = 2,
        lastSeen: Int64 = 1_787_443_200_000
    ) -> MemoryCandidateDto {
        MemoryCandidateDto(
            id: id,
            kind: .preference,
            canonicalKey: "editor.preference.theme",
            text: "Prefers dark theme",
            confidence: confidence,
            status: status,
            firstSeenAtMs: 1_787_000_000_000,
            lastSeenAtMs: lastSeen,
            evidenceCount: evidence,
            createdAtMs: 1_787_000_010_000,
            updatedAtMs: 1_787_443_200_000
        )
    }

    private static func groups(
        confirmed: [MemoryCandidateDto] = [],
        suggestions: [MemoryCandidateDto] = [],
        rejected: [MemoryCandidateDto] = [],
        superseded: [MemoryCandidateDto] = []
    ) -> [MemoriesListGroup] {
        var result: [MemoriesListGroup] = []
        func add(_ status: MemoriesGroupStatus, _ memories: [MemoryCandidateDto]) {
            if !memories.isEmpty {
                result.append(MemoriesListGroup(status: status, memories: memories))
            }
        }
        add(.confirmed, confirmed)
        add(.suggestions, suggestions)
        add(.rejected, rejected)
        if !superseded.isEmpty {
            result.append(MemoriesListGroup(status: .superseded, memories: superseded))
        }
        return result
    }

    // MARK: Grouping map

    @Test("sections follow fixed Confirmed/Suggestions/Rejected order regardless of input order")
    func groupingFixedOrder() {
        let groups = [
            MemoriesListGroup(status: .rejected, memories: [Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKR", status: .rejected)]),
            MemoriesListGroup(status: .suggestions, memories: [Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKS", status: .candidate)]),
            MemoriesListGroup(status: .confirmed, memories: [Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKT", status: .active)]),
        ]
        let sections = MemoriesPresentation.sections(from: groups)
        #expect(sections.map(\.status) == [.confirmed, .suggestions, .rejected])
        #expect(sections.map(\.title) == ["Confirmed (1)", "Suggestions (1)", "Rejected (1)"])
        // Identity is the stable status, not the counted title: counts move
        // on every optimistic action and must not re-identify the section.
        #expect(sections.map(\.id) == ["confirmed", "suggestions", "rejected"])
    }

    @Test("superseded rows never surface in display sections; empty buckets are omitted")
    func supersededHiddenAndEmptyOmitted() {
        let groups = [
            MemoriesListGroup(status: .confirmed, memories: []),
            MemoriesListGroup(status: .suggestions, memories: [Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKS", status: .candidate)]),
            MemoriesListGroup(status: .superseded, memories: [Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKU", status: .superseded)]),
        ]
        let sections = MemoriesPresentation.sections(from: groups)
        #expect(sections.map(\.status) == [.suggestions])
    }

    @Test("all-empty groups render zero sections (drives the whole-view empty state)")
    func allEmptyRendersNoSections() {
        #expect(MemoriesPresentation.sections(from: []).isEmpty)
        #expect(MemoriesPresentation.sections(
            from: [MemoriesListGroup(status: .confirmed, memories: [])]
        ).isEmpty)
    }

    @Test("row model renders kind, percent confidence, evidence count and lastSeen")
    func rowModelFields() {
        let calendar = varCalendar()
        let row = MemoriesPresentation.rowModel(
            for: Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKT", status: .active, confidence: 0.86, evidence: 3, lastSeen: 1_787_443_200_000),
            groupStatus: .confirmed,
            calendar: calendar
        )
        #expect(row.kindText == "preference")
        #expect(row.confidenceText == "86%")
        #expect(row.evidenceText == "3 evidence items")

        let single = MemoriesPresentation.rowModel(
            for: Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKV", status: .candidate, evidence: 1),
            groupStatus: .suggestions,
            calendar: calendar
        )
        #expect(single.evidenceText == "1 evidence item")

        let empty = MemoriesPresentation.rowModel(
            for: Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEK0", status: .active, evidence: 0),
            groupStatus: .suggestions,
            calendar: calendar
        )
        #expect(empty.evidenceText == "0 evidence items")
    }

    @Test("rows inside a section sort newest-lastSeen first")
    func rowsSortByLastSeenDescending() {
        let older = Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKW", status: .active, lastSeen: 1_787_000_000_000)
        let newer = Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKX", status: .active, lastSeen: 1_787_443_200_000)
        let sections = MemoriesPresentation.sections(from: [
            MemoriesListGroup(status: .confirmed, memories: [older, newer]),
        ])
        #expect(sections.count == 1)
        #expect(sections[0].rows.map(\.id) == ["01M0NP9G4HP0M1M64H8TC0VEKX", "01M0NP9G4HP0M1M64H8TC0VEKW"])
    }

    @Test("equal lastSeenAtMs rows tie-break by id ascending")
    func equalLastSeenTieBreaksByIdAscending() {
        let shared: Int64 = 1_787_443_200_000
        // «S» sorts before «T»; input order is reversed so only the
        // tie-break can yield the pinned order.
        let sections = MemoriesPresentation.sections(from: [
            MemoriesListGroup(status: .confirmed, memories: [
                Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKT", status: .active, lastSeen: shared),
                Self.memory(id: "01M0NP9G4HP0M1M64H8TC0VEKS", status: .active, lastSeen: shared),
            ]),
        ])
        #expect(sections.count == 1)
        #expect(sections[0].rows.map(\.id) == ["01M0NP9G4HP0M1M64H8TC0VEKS", "01M0NP9G4HP0M1M64H8TC0VEKT"])
    }

    // MARK: Optimistic-rollback reducer

    private static let suggestionId = "01M0NP9G4HP0M1M64H8TC0VEKS"
    private static let confirmedId = "01M0NP9G4HP0M1M64H8TC0VEKT"
    private static let rejectedId = "01M0NP9G4HP0M1M64H8TC0VEKR"

    private static var sampleGroups: [MemoriesListGroup] {
        groups(
            confirmed: [memory(id: confirmedId, status: .active)],
            suggestions: [memory(id: suggestionId, status: .candidate)],
            rejected: [memory(id: rejectedId, status: .rejected)]
        )
    }

    @Test("optimistic confirm moves the suggestion into Confirmed with wire status active")
    func optimisticConfirm() throws {
        let next = try #require(MemoriesReducer.optimisticGroups(action: .confirm, id: Self.suggestionId, groups: Self.sampleGroups))
        let confirmed = try #require(next.first { $0.status == .confirmed })
        #expect(confirmed.memories.map(\.id) == [Self.confirmedId, Self.suggestionId])
        #expect(confirmed.memories.last?.status == .active)
        #expect(next.first { $0.status == .suggestions }?.memories.contains { $0.id == Self.suggestionId } != true)
    }

    @Test("optimistic reject moves the suggestion into Rejected with wire status rejected")
    func optimisticReject() throws {
        let next = try #require(MemoriesReducer.optimisticGroups(action: .reject, id: Self.suggestionId, groups: Self.sampleGroups))
        let rejected = try #require(next.first { $0.status == .rejected })
        #expect(rejected.memories.map(\.id).contains(Self.suggestionId))
        #expect(rejected.memories.first { $0.id == Self.suggestionId }?.status == .rejected)
    }

    @Test("optimistic forget drops the row entirely")
    func optimisticForget() throws {
        let next = try #require(MemoriesReducer.optimisticGroups(action: .forget, id: Self.confirmedId, groups: Self.sampleGroups))
        #expect(!next.flatMap(\.memories).contains { $0.id == Self.confirmedId })
    }

    @Test("unknown id returns nil (no local mutation)")
    func unknownIdReturnsNil() {
        #expect(MemoriesReducer.optimisticGroups(action: .confirm, id: "01M0NP9G4HP0M1M64H8TC0VEKZ", groups: Self.sampleGroups) == nil)
    }

    @Test("server result merges authoritatively; forget keeps the removal")
    func serverResultMerge() throws {
        let promoted = Self.memory(id: Self.suggestionId, status: .active)
        let merged = MemoriesReducer.groups(
            applyingServerResult: promoted,
            id: Self.suggestionId,
            to: Self.sampleGroups
        )
        let confirmed = try #require(merged.first { $0.status == .confirmed })
        #expect(confirmed.memories.contains { $0.id == Self.suggestionId })

        // Forget mirrors the real flow: the optimistic pass already removed
        // the row, and updated:nil (hard delete) keeps that removal.
        let optimisticForget = try #require(
            MemoriesReducer.optimisticGroups(action: .forget, id: Self.rejectedId, groups: Self.sampleGroups)
        )
        let forgotten = MemoriesReducer.groups(applyingServerResult: nil, id: Self.rejectedId, to: optimisticForget)
        #expect(!forgotten.flatMap(\.memories).contains { $0.id == Self.rejectedId })
        #expect(forgotten.flatMap(\.memories).count == Self.sampleGroups.flatMap(\.memories).count - 1)
    }

    // MARK: Year-aware last-seen text (SD-7)

    @Test("lastSeenText appends the year only for dates outside the current calendar year")
    func lastSeenTextYearDisambiguation() throws {
        var posix = Calendar(identifier: .gregorian)
        posix.timeZone = try #require(TimeZone(identifier: "UTC"))
        posix.locale = Locale(identifier: "en_US_POSIX")
        // now = 2026-08-23T00:00:00Z.
        let now = Date(timeIntervalSince1970: 1_787_443_200)
        // Current-year date keeps the compact form byte-identical.
        #expect(MemoriesPresentation.lastSeenText(ms: 1_787_443_200_000, calendar: posix, now: now) == "00:00 Aug 23")
        // Same month/day one year earlier still disambiguates with the year.
        #expect(MemoriesPresentation.lastSeenText(ms: 1_755_907_200_000, calendar: posix, now: now) == "00:00 Aug 23 2025")
        // A prior-year January memory renders unambiguously too.
        #expect(MemoriesPresentation.lastSeenText(ms: 1_736_076_000_000, calendar: posix, now: now) == "11:20 Jan 5 2025")
    }

    // MARK: AppState phase + action machine

    private func varCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    @Test("refresh cycles idle → loading → loaded and stores groups")
    func refreshLoaded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = { Self.groups(suggestions: [Self.memory(id: Self.suggestionId, status: .candidate)]) }
        #expect(state.memoriesPhase == .idle)
        await state.refreshMemories()
        #expect(state.memoriesPhase == .loaded)
        #expect(state.memoriesGroups.count == 1)
        #expect(state.memoriesGroups[0].status == .suggestions)
    }

    @Test("refresh failure surfaces failed(message); no loader fails immediately")
    func refreshFailures() async {
        let state = AppState(daemon: FakeDaemonAPI())
        await state.refreshMemories()
        #expect(state.memoriesPhase == .failed("Daemon connection unavailable"))

        let offlineAPI = FakeDaemonAPI()
        let offline = AppState(daemon: offlineAPI)
        offlineAPI.onListMemories = { throw DaemonClientError.notConnected }
        await offline.refreshMemories()
        #expect(offline.memoriesPhase == .failed("Daemon connection unavailable"))
    }

    @Test("successful confirm applies the server answer and clears prior errors")
    func runActionSuccess() async throws {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = { Self.sampleGroups }
        await state.refreshMemories()

        // Seed a prior action error through a failing action (private(set)).
        struct SeedFailure: Error {}
        api.onMemoryAction = { _, _ in throw SeedFailure() }
        await state.runMemoryAction(id: Self.suggestionId, action: .reject)
        #expect(state.memoriesActionError != nil)

        api.onMemoryAction = { id, action in
            #expect(id == Self.suggestionId && action == .confirm)
            return Self.memory(id: Self.suggestionId, status: .active)
        }
        await state.runMemoryAction(id: Self.suggestionId, action: .confirm)

        #expect(state.memoriesActionError == nil)
        let confirmed = try #require(state.memoriesGroups.first { $0.status == .confirmed })
        #expect(confirmed.memories.contains { $0.id == Self.suggestionId && $0.status == .active })
    }

    @Test("failed confirm rolls back to the exact pre-action snapshot and surfaces the error")
    func runActionRollback() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = { Self.sampleGroups }
        await state.refreshMemories()

        struct Boom: Error {}
        api.onMemoryAction = { _, _ in throw Boom() }
        await state.runMemoryAction(id: Self.suggestionId, action: .confirm)

        #expect(state.memoriesGroups == Self.sampleGroups)
        #expect(state.memoriesActionError != nil && !(state.memoriesActionError ?? "").isEmpty)
        // Phase untouched by actions stays loaded.
        #expect(state.memoriesPhase == .loaded)
    }

    @Test("executor-less action surfaces an error without mutating groups")
    func runActionWithoutExecutor() async {
        // onMemoryAction left unset → notConnected → "Daemon connection unavailable".
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onListMemories = { Self.sampleGroups }
        await state.refreshMemories()
        await state.runMemoryAction(id: Self.suggestionId, action: .reject)
        #expect(state.memoriesGroups == Self.sampleGroups)
        #expect(state.memoriesActionError == "Daemon connection unavailable")
    }

    @Test("memories_changed refreshes only when the list is visible; hidden view ignores it")
    func changedEventRefreshGate() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let loads = LoadCounter()
        api.onListMemories = {
            loads.increment()
            return Self.sampleGroups
        }
        await state.handleMemoriesChanged()
        #expect(loads.count == 0) // idle: event ignored

        await state.refreshMemories()
        #expect(loads.count == 1)
        await state.handleMemoriesChanged()
        #expect(loads.count == 2) // loaded: refreshed
        #expect(state.memoriesPhase == .loaded)
    }
}
