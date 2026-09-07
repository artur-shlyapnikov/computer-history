import Foundation
@testable import RecorderApp
import Testing

/// AppState.handleEpisodesChanged() gating (design P2-5): after delete.range
/// the timeline re-syncs ONLY while already visible (.loaded/.loading);
/// refreshing while .idle would fight the view lifecycle and while .failed
/// would mask the error banner. Sibling of the memories/workflows
/// changedEventRefreshGate tests; LoadCounter cloned per repo convention.
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

/// Latch for deterministic async sequencing without sleeps: `signal()` hands
/// out previously stored signals or parks the waiter.
private actor Latch {
    private var stored = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func signal() {
        if !waiters.isEmpty {
            waiters.removeFirst().resume()
        } else {
            stored += 1
        }
    }

    func wait() async {
        if stored > 0 {
            stored -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }
}

@MainActor
struct TimelineEpisodesChangedTests {
    /// Loader that parks until released, so a refresh can be observed in its
    /// `.loading` phase deterministically: entering the loader proves the
    /// phase was already flipped to .loading (refreshTimeline does that
    /// before awaiting).
    @Test("episodes_changed during an in-flight load triggers a second refresh")
    func refreshDuringLoadingIsAllowed() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let loads = LoadCounter()
        let entered = Latch() // loader signals entry; test waits on it
        let release = Latch() // test releases parked loaders
        api.onListTimeline = {
            loads.increment()
            await entered.signal()
            await release.wait()
            return []
        }

        let first = Task { await appState.refreshTimeline() }
        await entered.wait() // now inside the loader ⇒ timelinePhase == .loading

        // handleEpisodesChanged awaits its inner refresh, and that loader
        // parks until released — so drive it from a task, not inline.
        let second = Task { await appState.handleEpisodesChanged() }
        await entered.wait() // second refresh entered the loader too
        #expect(loads.count == 2)

        await release.signal()
        await release.signal()
        await first.value
        await second.value
        #expect(appState.timelinePhase == .loaded)
    }

    @Test("episodes_changed while loaded re-syncs and stays loaded")
    func loadedRefreshes() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let loads = LoadCounter()
        api.onListTimeline = {
            loads.increment()
            return []
        }

        await appState.refreshTimeline()
        #expect(loads.count == 1)
        #expect(appState.timelinePhase == .loaded)

        await appState.handleEpisodesChanged()
        #expect(loads.count == 2)
        #expect(appState.timelinePhase == .loaded)
    }

    @Test("episodes_changed while failed is ignored so the banner survives")
    func failedDoesNotRefresh() async {
        struct Boom: LocalizedError {
            var errorDescription: String? {
                "boom"
            }
        }
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        api.onListTimeline = { throw Boom() }
        await appState.refreshTimeline()
        #expect(appState.timelinePhase == .failed("boom"))

        // Swap to a counting loader: the gate must break BEFORE calling it.
        let loads = LoadCounter()
        api.onListTimeline = {
            loads.increment()
            return []
        }

        await appState.handleEpisodesChanged()
        #expect(loads.count == 0)
        #expect(appState.timelinePhase == .failed("boom"))
    }

    @Test("episodes_changed while idle is ignored")
    func idleDoesNotRefresh() async {
        let api = FakeDaemonAPI()
        let appState = AppState(daemon: api)
        let loads = LoadCounter()
        api.onListTimeline = {
            loads.increment()
            return []
        }

        await appState.handleEpisodesChanged()
        #expect(loads.count == 0)
        #expect(appState.timelinePhase == .idle)
    }

    @Test("no loader: handleEpisodesChanged returns without touching phase")
    func nilLoaderIsGuarded() async {
        let appState = AppState(daemon: FakeDaemonAPI())
        await appState.handleEpisodesChanged()
        #expect(appState.timelinePhase == .idle)
    }
}
