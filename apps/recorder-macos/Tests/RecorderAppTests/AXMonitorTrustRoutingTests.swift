import AppKit
@testable import RecorderApp
import Testing

/// AXMonitor trust-loss ROUTING (design round-3 §P2-5, SW-01): the blackout
/// bug was a routing bug, not a table bug — `indicatesTrustLoss` is already
/// pinned by AXMonitorTests; here we prove the call SITES fire
/// `onTrustFailure` only for trust-shaped failures and stay SILENT for the
/// cannotComplete/dead-pid class across attach retries and detach cycles.
///
/// Fixtures: bare AXMonitor() per test, @MainActor. Canonical unattachable
/// pid -1 (AXObserverCreate(-1) fails deterministically — precedent
/// AXMonitorBookkeepingTests). All assertions are dual-safe with/without an
/// Accessibility grant.
///
/// Honest limits: the POSITIVE apiDisabled→onTrustFailure routes and the
/// unsubscribe bookkeeping (SW-02) need a TCC toggle or live AX element
/// churn — unverifiable in CI per the repo's documented stance
/// (AXExtractionTests header). Inverting the classifier (treating
/// cannotComplete as loss) WOULD fail cases 1/4 below, which pins the exact
/// shipped regression at the routing layer.
@MainActor
struct AXMonitorTrustRoutingTests {
    /// Deterministically unattachable pid (AXObserverCreate(-1) fails).
    private static let unattachablePid: pid_t = -1

    private final class TrustSpy {
        var trustFailureCount = 0
        var attachedPids: [pid_t] = []
    }

    // MARK: - Cases

    @Test("dead/unattachable pid fires attachFailed but NEVER trips the trust gate")
    func failedAttachStaysSilentOnTrust() {
        let monitor = AXMonitor()
        let spy = TrustSpy()
        monitor.onAttachFailed = { spy.attachedPids.append($0) }
        monitor.onTrustFailure = { spy.trustFailureCount += 1 }

        monitor.attach(pid: Self.unattachablePid)

        #expect(spy.attachedPids == [Self.unattachablePid])
        #expect(spy.trustFailureCount == 0)
        #expect(monitor.attachedPids.isEmpty)
    }

    @Test("attaching our own process never reports trust loss [ENVIRONMENT]")
    func selfAttachNeverTripsTrustGate() {
        let monitor = AXMonitor()
        let spy = TrustSpy()
        monitor.onAttachFailed = { _ in Issue.record("self-attach should not fail") }
        monitor.onTrustFailure = { spy.trustFailureCount += 1 }

        let selfPid = ProcessInfo.processInfo.processIdentifier
        monitor.attach(pid: selfPid)

        #expect(spy.trustFailureCount == 0)
        if AXMonitor.checkPermission(prompt: false) {
            #expect(monitor.attachedPids.contains(selfPid))
        }
        monitor.detach(pid: selfPid)
    }

    @Test("detach + re-attach cycle is routine, never a revocation signal")
    func detachReattachCycleSilent() {
        let monitor = AXMonitor()
        let spy = TrustSpy()
        monitor.onTrustFailure = { spy.trustFailureCount += 1 }

        let selfPid = ProcessInfo.processInfo.processIdentifier
        monitor.attach(pid: selfPid)
        monitor.detach(pid: selfPid)
        monitor.attach(pid: selfPid)

        #expect(spy.trustFailureCount == 0)
        monitor.detach(pid: selfPid)
    }

    @Test("retry storms against an unattachable pid accumulate no false positives")
    func retryStormAccumulatesNoTrustFailures() {
        let monitor = AXMonitor()
        let spy = TrustSpy()
        var attachFailedCount = 0
        monitor.onAttachFailed = { _ in attachFailedCount += 1 }
        monitor.onTrustFailure = { spy.trustFailureCount += 1 }

        for _ in 0 ..< 3 {
            monitor.attach(pid: Self.unattachablePid)
        }

        #expect(attachFailedCount == 3)
        #expect(spy.trustFailureCount == 0)
    }

    @Test("control: only apiDisabled classifies as trust loss at the routing boundary")
    func classifierControl() {
        // Referenced, not duplicated: this file owns ROUTING; AXMonitorTests
        // owns the full table. These two rows are the ones the route sites
        // branch on.
        #expect(AXMonitor.indicatesTrustLoss(.apiDisabled))
        #expect(!AXMonitor.indicatesTrustLoss(.cannotComplete))
    }
}
