import ApplicationServices
@testable import RecorderApp
import Testing

/// Unit tests for AXMonitor's pure trust-loss classification. Live
/// Accessibility observer behavior is NOT verifiable here (no interactive
/// permission grant in CI) — see the honest-limits notes at the bottom of
/// CaptureStackUnitTests.
struct AXMonitorTests {
    @Test("only apiDisabled proves runtime trust loss")
    func trustLossClassification() {
        #expect(AXMonitor.indicatesTrustLoss(.apiDisabled))
        // cannotComplete also fires for hung/busy/mid-launch apps with the
        // grant intact — it must NOT stop healthy monitors (SW-01).
        #expect(!AXMonitor.indicatesTrustLoss(.cannotComplete))
        #expect(!AXMonitor.indicatesTrustLoss(.success))
        #expect(!AXMonitor.indicatesTrustLoss(.failure))
        #expect(!AXMonitor.indicatesTrustLoss(.attributeUnsupported))
        #expect(!AXMonitor.indicatesTrustLoss(.notificationUnsupported))
        #expect(!AXMonitor.indicatesTrustLoss(.invalidUIElement))
    }

    // MARK: - AppInfo caching (PERF-03)

    @Test("appInfo resolves each pid once and serves repeats from cache")
    @MainActor
    func appInfoCacheHit() {
        let monitor = AXMonitor()
        var lookups = 0
        monitor.appInfoLookup = { pid in
            lookups += 1
            return AppInfo(bundleId: "com.example.a", name: "A", pid: Int64(pid))
        }

        _ = monitor.appInfo(for: -1)
        _ = monitor.appInfo(for: -1)
        _ = monitor.appInfo(for: -1)

        // Pre-fix behavior: three fresh NSRunningApplication consults.
        #expect(lookups == 1)
    }

    @Test("detach clears the cached entry so a recycled pid re-resolves")
    @MainActor
    func appInfoInvalidatedOnDetach() {
        let monitor = AXMonitor()
        var lookups = 0
        monitor.appInfoLookup = { pid in
            lookups += 1
            // Simulate pid recycling: same pid, different app after death.
            let bundleId = lookups == 1 ? "com.old.app" : "com.new.app"
            return AppInfo(bundleId: bundleId, name: nil, pid: Int64(pid))
        }

        let original = monitor.appInfo(for: -1)
        #expect(original.bundleId == "com.old.app")
        #expect(monitor.cachedAppInfoCount == 1)

        monitor.detach(pid: -1) // handlePidDeath routes through here too
        #expect(monitor.cachedAppInfoCount == 0)

        let recycled = monitor.appInfo(for: -1)
        // Pre-fix behavior would pass this too, but WITH detach keeping no
        // cache there is nothing to invalidate; post-regression (cache kept
        // across detach) the stale "com.old.app" would be served instead.
        #expect(lookups == 2)
        #expect(recycled.bundleId == "com.new.app")
    }

    @Test("stopAll empties the cache")
    @MainActor
    func appInfoClearedByStopAll() {
        let monitor = AXMonitor()
        var lookups = 0
        monitor.appInfoLookup = { pid in
            lookups += 1
            return AppInfo(bundleId: "unknown", name: nil, pid: Int64(pid))
        }

        _ = monitor.appInfo(for: -1)
        _ = monitor.appInfo(for: -2)
        #expect(monitor.cachedAppInfoCount == 2)

        monitor.stopAll()
        #expect(monitor.cachedAppInfoCount == 0)

        _ = monitor.appInfo(for: -1)
        // Pre-fix behavior: every call re-queries, so this passes trivially;
        // with a stop()-surviving cache the third lookup never happens.
        #expect(lookups == 3)
    }

    // MARK: - Default lookup fallbacks (PERF-03 residual)

    @Test("default lookup falls back to unknown/nil for a dead pid and caches it")
    @MainActor
    func defaultLookupDeadPidFallsBackAndCaches() {
        let monitor = AXMonitor() // DEFAULT lookup — deliberately not injected

        let first = monitor.appInfo(for: -1) // deterministically dead pid
        #expect(first.bundleId == "unknown")
        #expect(first.name == nil)

        // The fallback entry is cached like any other: the second consult
        // returns an equal AppInfo without re-hitting NSRunningApplication.
        let second = monitor.appInfo(for: -1)
        #expect(second == first)
        #expect(monitor.cachedAppInfoCount == 1)
    }

    @Test("default lookup resolves the current process to a non-empty bundle id")
    @MainActor
    func defaultLookupResolvesSelf() {
        let monitor = AXMonitor()
        let selfPid = ProcessInfo.processInfo.processIdentifier
        let info = monitor.appInfo(for: selfPid)
        // Dual-safe on whether the runner has a real bundle id or the
        // "unknown" fallback — either way the field is never empty and the
        // pid round-trips.
        #expect(!info.bundleId.isEmpty)
        #expect(info.pid == Int64(selfPid))
    }
}
