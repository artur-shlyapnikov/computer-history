import Foundation
@testable import RecorderApp
import Testing

/// AppState refresh correctness (SW5-04b / SW5-07 / SW5-08):
/// - periodic ticks coalesce behind an in-flight timeline refresh instead of
///   stacking parallel loads;
/// - a stale (superseded) refresh result is discarded instead of winning
///   last-writer-wins over fresher data;
/// - a failing best-effort settings load inside refreshDiagnostics surfaces a
///   typed `.failed` settingsPhase instead of leaving stale/idle phases.
/// Deterministic sequencing via latches, per repo convention. Tick scheduling
/// reuses the target-internal `ManualTickScheduler` from
/// TimelineMappingTests.swift.
private final class LoadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

/// Latch for deterministic async sequencing without sleeps.
private actor Latch {
    private var stored = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func signal() {
        if waiters.isEmpty {
            stored += 1
        } else {
            waiters.removeFirst().resume()
        }
    }

    func wait() async {
        if stored > 0 {
            stored -= 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }
}

/// Error with a pinned message so `.failed(message)` assertions are stable.
private struct Boom: LocalizedError {
    var errorDescription: String? {
        "boom"
    }
}

@MainActor
struct AppStateRefreshTests {
    private static func makeEpisode(id: String) -> EpisodeSummaryDto {
        EpisodeSummaryDto(
            id: id,
            startedAtMs: 1_787_443_200_100,
            endedAtMs: 1_787_443_215_000,
            title: "Investigated webhook failures",
            appNames: ["Safari"],
            stepCount: 2,
            pendingJobs: 0
        )
    }

    private static func statusResult() -> StatusResult {
        StatusResult(
            daemon: .init(version: "0.1.0", schemaVersion: 4, uptimeMs: 72000),
            recording: .init(paused: false, reason: nil),
            accessibilityRequired: false,
            queue: .init(pending: 3, retrying: 1, dead: 2),
            db: .init(
                rawEvents: 1200, segments: 40, steps: 300, episodes: 12,
                memories: 8, workflows: 2, pageCountBytes: 1_048_576
            ),
            diskFreeBytes: 2_147_483_648
        )
    }

    // MARK: - SW5-04b: tick skips while a refresh is in flight

    @Test("tick while a refresh is in flight does not stack a second load")
    func tickSkipsWhileRefreshInFlight() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let loads = LoadCounter()
        let entered = Latch()
        let release = Latch()
        api.onListTimeline = {
            loads.increment()
            await entered.signal()
            await release.wait()
            return []
        }

        let scheduler = ManualTickScheduler()
        appState.startTimelinePolling(scheduler: scheduler, interval: 5)

        // First tick starts a refresh whose loader parks on `release`.
        let first = Task { await scheduler.fire() }
        await entered.wait() // loader entered ⇒ refresh is in flight
        guard case .loading = appState.timelinePhase else {
            Issue.record("expected .loading while the first refresh is outstanding")
            return
        }

        // SW5-04b pre-fix: this tick stacked a second load behind the parked
        // one. Post-fix the in-flight guard drops it before the loader runs.
        let second = Task { await scheduler.fire() }
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        #expect(loads.value == 1)

        await release.signal()
        await release.signal()
        await first.value
        await second.value
        #expect(loads.value == 1)
        #expect(appState.timelinePhase == .loaded)
    }

    // MARK: - SW5-08: stale-generation results are discarded

    @Test("episodes_changed supersedes an older in-flight timeline refresh")
    func staleTimelineResultDiscarded() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let entered = Latch()
        let release = Latch()

        api.onListTimeline = {
            await entered.signal()
            await release.wait()
            return [Self.makeEpisode(id: "OLD")]
        }

        // Refresh A starts and hangs on the slow loader.
        let stale = Task { await appState.refreshTimeline() }
        await entered.wait()

        // episodes_changed triggers refresh B with fresh data; B supersedes A.
        api.onListTimeline = { [Self.makeEpisode(id: "NEW")] }
        await appState.handleEpisodesChanged()
        #expect(appState.timelineEpisodes.map(\.id) == ["NEW"])

        // A finally resolves with old data — must not overwrite B's result.
        await release.signal()
        await stale.value
        #expect(appState.timelineEpisodes.map(\.id) == ["NEW"])
        #expect(appState.timelinePhase == .loaded)
    }

    @Test("memories_changed supersedes an older in-flight memories refresh")
    func staleMemoriesResultDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let entered = Latch()
        let release = Latch()
        let oldGroups = [MemoriesListGroup(status: .suggestions, memories: [])]
        let newGroups = [MemoriesListGroup(status: .suggestions, memories: [
            MemoryCandidateDto(
                id: "M1", kind: .fact, canonicalKey: "k", text: "fresh",
                confidence: 0.9, status: .candidate,
                firstSeenAtMs: 1, lastSeenAtMs: 1, evidenceCount: 1,
                createdAtMs: 1, updatedAtMs: 1
            ),
        ])]

        api.onListMemories = {
            await entered.signal()
            await release.wait()
            return oldGroups
        }

        let stale = Task { await state.refreshMemories() }
        await entered.wait()

        api.onListMemories = { newGroups }
        await state.handleMemoriesChanged()
        #expect(state.memoriesGroups == newGroups)

        await release.signal()
        await stale.value
        #expect(state.memoriesGroups == newGroups)
        #expect(state.memoriesPhase == .loaded)
    }

    @Test("workflows_changed supersedes an older in-flight workflows refresh")
    func staleWorkflowsResultDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let entered = Latch()
        let release = Latch()
        let newWorkflows = [
            WorkflowListItem(
                id: "W1", name: "Deploy", purpose: nil, status: .candidate,
                template: WorkflowTemplate(), occurrenceCount: 1,
                medianSimilarity: 0.9, firstSeenAtMs: 1, lastSeenAtMs: 1,
                createdAtMs: 1, updatedAtMs: 1, occurrences: []
            ),
        ]

        api.onListWorkflows = {
            await entered.signal()
            await release.wait()
            return []
        }

        let stale = Task { await state.refreshWorkflows() }
        await entered.wait()

        api.onListWorkflows = { newWorkflows }
        await state.handleWorkflowsChanged()
        #expect(state.workflows == newWorkflows)

        await release.signal()
        await stale.value
        #expect(state.workflows == newWorkflows)
        #expect(state.workflowsPhase == .loaded)
    }

    /// Round 27 regression: refreshDiagnostics previously had no generation
    /// guard, so a slow cycle could commit stale status over a fresher one.
    @Test("a superseded diagnostics refresh does not overwrite the newer snapshot")
    func staleDiagnosticsResultDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let entered = Latch()
        api.onFetchDiagnostics = { nil }
        let release = Latch()

        api.onFetchStatus = {
            await entered.signal()
            await release.wait()
            return Self.statusResult()
        }

        // Refresh A starts and hangs on the slow loader.
        let stale = Task { await state.refreshDiagnostics() }
        await entered.wait()

        // Refresh B supersedes A with fresh data.
        var fresh = Self.statusResult()
        fresh = StatusResult(
            daemon: fresh.daemon,
            recording: fresh.recording,
            accessibilityRequired: fresh.accessibilityRequired,
            queue: .init(pending: 0, retrying: 0, dead: 0),
            db: fresh.db,
            diskFreeBytes: fresh.diskFreeBytes
        )
        api.onFetchStatus = { fresh }
        await state.refreshDiagnostics()
        #expect(state.lastStatus?.queue.pending == 0)

        // A finally resolves — must not overwrite B's snapshot or phase.
        await release.signal()
        await stale.value
        #expect(state.lastStatus?.queue.pending == 0)
        #expect(state.diagnosticsPhase == .loaded)
    }

    // MARK: - SW5-07: settings failure inside refreshDiagnostics

    @Test("settings failure flips settingsPhase to failed without touching diagnostics or display")
    func settingsFailureAfterSuccessIsTyped() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onFetchStatus = { Self.statusResult() }
        api.onFetchDiagnostics = { nil }
        let goodSettings = DaemonSettingsDto(
            chatModel: "openai/gpt-5.6-luna", backgroundModel: "haiku",
            rawRetentionHours: 48, semanticRetentionDays: 30
        )
        api.onFetchSettings = { SettingsGetResult(settings: goodSettings) }

        await state.refreshDiagnostics()
        #expect(state.diagnosticsPhase == .loaded)
        #expect(state.settingsPhase == .loaded)
        #expect(state.daemonSettingsDisplay?.chatModel == "openai/gpt-5.6-luna")

        // Settings start failing while status keeps succeeding.
        api.onFetchSettings = { throw Boom() }
        await state.refreshDiagnostics()

        // Typed failure instead of the pre-fix silent no-op that kept the
        // stale `.loaded` phase rendering old values as current.
        guard case let .failed(message) = state.settingsPhase else {
            Issue.record("expected .failed settingsPhase after loader error")
            return
        }
        #expect(message == "boom")
        // diagnosticsPhase belongs to the status/diagnostics cycle alone.
        #expect(state.diagnosticsPhase == .loaded)
        // Chosen semantic: keep the last good display mirror; the phase flags
        // staleness and DiagnosticsView's Retry engages via
        // refreshDaemonSettings().
        #expect(state.daemonSettingsDisplay?.chatModel == "openai/gpt-5.6-luna")
    }

    @Test("first-ever settings failure leaves a typed failed phase, not stuck idle")
    func firstEverSettingsFailureIsTyped() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        api.onFetchDiagnostics = { nil }
        api.onFetchStatus = { Self.statusResult() }
        api.onFetchSettings = { throw Boom() }

        await state.refreshDiagnostics()
        #expect(state.diagnosticsPhase == .loaded)
        #expect(state.settingsPhase == .failed("boom"))
        #expect(state.daemonSettingsDisplay == nil)
    }

    /// Pins the offline branch's scope: a disconnected refreshDiagnostics
    /// stops at the failed diagnostics phase and never touches settingsPhase
    /// (the pre-refactor code fell through to the settings fetch on a
    /// throwing status load, flapping it .loading→.failed).
    @Test("offline diagnostics cycle stops before the settings fetch")
    func offlineDiagnosticsLeavesSettingsPhaseUntouched() async {
        // No hooks: every FakeDaemonAPI op defaults to throwing
        // DaemonClientError.notConnected, so fetchStatus fails disconnected.
        let state = AppState(daemon: FakeDaemonAPI())
        #expect(state.settingsPhase == .idle)

        await state.refreshDiagnostics()

        #expect(state.diagnosticsPhase == .failed("Daemon connection unavailable"))
        // The cycle stopped before the settings fetch: the seeded .idle
        // phase is untouched (no .loading flap, no typed failure).
        #expect(state.settingsPhase == .idle)
    }

    // MARK: - SW5-08 residual: stale FAILURES are discarded too

    @Test("a stale timeline FAILURE is discarded and leaves B's in-flight flag alone")
    func staleTimelineFailureDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let loads = LoadCounter()
        let enteredA = Latch()
        let releaseA = Latch()
        let enteredB = Latch()
        let releaseB = Latch()

        // Refresh A parks on a loader that will eventually THROW.
        api.onListTimeline = {
            loads.increment()
            await enteredA.signal()
            await releaseA.wait()
            throw Boom()
        }

        let scheduler = ManualTickScheduler()
        state.startTimelinePolling(scheduler: scheduler, interval: 5)

        let stale = Task { await state.refreshTimeline() }
        await enteredA.wait()

        // B supersedes A and parks on its own latch so every later step is
        // order-exact: B stays in flight while A's throw resolves.
        api.onListTimeline = {
            loads.increment()
            await enteredB.signal()
            await releaseB.wait()
            return [Self.makeEpisode(id: "NEW")]
        }
        let fresh = Task { await state.handleEpisodesChanged() }
        await enteredB.wait()

        // A's late throw must hit the catch-side generation guard and be
        // dropped entirely. B is still parked in its loader here, so the
        // phase is legitimately B's `.loading`; a deleted guard would have
        // surfaced the stale throw as `.failed("boom")` right now.
        await releaseA.signal()
        await stale.value
        #expect(state.timelinePhase == .loading)

        // The in-flight flag belongs to B: a tick must STILL be skipped.
        // If the stale cycle fell through to `timelineRefreshInFlight =
        // false`, this tick would stack a third load and the counter moves.
        await scheduler.fire()
        #expect(loads.value == 2)

        await releaseB.signal()
        await fresh.value
        #expect(state.timelineEpisodes.map(\.id) == ["NEW"])
        #expect(state.timelinePhase == .loaded)
    }

    @Test("memories_changed supersedes an older in-flight memories refresh that fails")
    func staleMemoriesFailureDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let entered = Latch()
        let release = Latch()
        let newGroups = [MemoriesListGroup(status: .suggestions, memories: [
            MemoryCandidateDto(
                id: "M1", kind: .fact, canonicalKey: "k", text: "fresh",
                confidence: 0.9, status: .candidate,
                firstSeenAtMs: 1, lastSeenAtMs: 1, evidenceCount: 1,
                createdAtMs: 1, updatedAtMs: 1
            ),
        ])]

        api.onListMemories = {
            await entered.signal()
            await release.wait()
            throw Boom()
        }

        let stale = Task { await state.refreshMemories() }
        await entered.wait()

        api.onListMemories = { newGroups }
        await state.handleMemoriesChanged()
        #expect(state.memoriesGroups == newGroups)

        await release.signal()
        await stale.value
        // Pre-fix behavior: the stale throw overwrote `.loaded` with
        // `.failed("boom")` even though newer data already committed.
        #expect(state.memoriesGroups == newGroups)
        #expect(state.memoriesPhase == .loaded)
    }

    @Test("workflows_changed supersedes an older in-flight workflows refresh that fails")
    func staleWorkflowsFailureDiscarded() async {
        let api = FakeDaemonAPI()
        let state = AppState(daemon: api)
        let entered = Latch()
        let release = Latch()
        let newWorkflows = [
            WorkflowListItem(
                id: "W1", name: "Deploy", purpose: nil, status: .candidate,
                template: WorkflowTemplate(), occurrenceCount: 1,
                medianSimilarity: 0.9, firstSeenAtMs: 1, lastSeenAtMs: 1,
                createdAtMs: 1, updatedAtMs: 1, occurrences: []
            ),
        ]

        api.onListWorkflows = {
            await entered.signal()
            await release.wait()
            throw Boom()
        }

        let stale = Task { await state.refreshWorkflows() }
        await entered.wait()

        api.onListWorkflows = { newWorkflows }
        await state.handleWorkflowsChanged()
        #expect(state.workflows == newWorkflows)

        await release.signal()
        await stale.value
        #expect(state.workflows == newWorkflows)
        #expect(state.workflowsPhase == .loaded)
    }
}
