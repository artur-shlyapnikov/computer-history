import AppKit
@testable import RecorderApp
import Testing

/// AXMonitor attach/detach bookkeeping (spec §3.6): the observers dictionary
/// is the leak surface for AXObservers and retained element refs. Every
/// assertion below is a dual-safe invariant that holds BOTH with and without
/// an Accessibility grant (style of CaptureStackUnitTests.axStopAllClearsTrackedPids),
/// so nothing here flakes on CI.
@MainActor
struct AXMonitorBookkeepingTests {
    /// Canonical UNATTACHABLE pid: AXObserverCreate(-1) fails deterministically
    /// (probed: 99999 actually SUCCEEDS on a granted machine — observer
    /// creation does not contact the target process), so -1 exercises the
    /// attach-failed callback path everywhere.
    private static let unattachablePid: pid_t = -1

    private final class PidSpy {
        var pids: [pid_t] = []
        func record(_ pid: pid_t) {
            pids.append(pid)
        }
    }

    @Test("failed attach reports the pid every retry and never registers it")
    func failedAttachRetriesAndStaysUnregistered() {
        let monitor = AXMonitor()
        let spy = PidSpy()
        monitor.onAttachFailed = { spy.record($0) }

        monitor.attach(pid: Self.unattachablePid)
        monitor.attach(pid: Self.unattachablePid)

        // A failed attach leaves no observers[pid] entry, so the second call
        // re-attempts (and re-reports) instead of being swallowed by the
        // idempotence guard.
        #expect(spy.pids == [Self.unattachablePid, Self.unattachablePid])
        #expect(monitor.attachedPids.isEmpty)
    }

    @Test("second attach of an already-tracked pid is a no-op")
    func doubleAttachIsIdempotent() {
        let monitor = AXMonitor()
        let selfPid = ProcessInfo.processInfo.processIdentifier

        monitor.attach(pid: selfPid)
        let before = monitor.attachedPids
        #expect(before.count <= 1)

        monitor.attach(pid: selfPid)
        // Unchanged by the second call whether the first attach succeeded or
        // failed: the guard prevents duplicate observer registration.
        #expect(monitor.attachedPids == before)
    }

    @Test("detach of a never-attached pid is a safe no-op")
    func detachUnknownPidIsSafe() {
        let monitor = AXMonitor()
        let selfPid = ProcessInfo.processInfo.processIdentifier
        monitor.attach(pid: selfPid)
        let before = monitor.attachedPids

        monitor.detach(pid: 12345)
        #expect(monitor.attachedPids == before)
    }

    @Test("handlePidDeath routes through detach")
    func pidDeathDetaches() {
        let monitor = AXMonitor()
        let selfPid = ProcessInfo.processInfo.processIdentifier
        monitor.attach(pid: selfPid)

        monitor.handlePidDeath(pid: selfPid)
        #expect(!monitor.attachedPids.contains(selfPid))
    }

    @Test("stopAll is safe to call repeatedly and empties tracking")
    func stopAllTwiceIsSafe() {
        let monitor = AXMonitor()
        monitor.attach(pid: ProcessInfo.processInfo.processIdentifier)
        monitor.attach(pid: 99999) // may attach or fail — both safe for stopAll

        monitor.stopAll()
        #expect(monitor.attachedPids.isEmpty)
        monitor.stopAll()
        #expect(monitor.attachedPids.isEmpty)
    }

    @Test("attachedPids is strictly ascending [ENVIRONMENT: vacuous without grant]")
    func attachedPidsAreSortedAscending() {
        let monitor = AXMonitor()
        let selfPid = ProcessInfo.processInfo.processIdentifier
        monitor.attach(pid: selfPid)

        // Attach to another live app so, with a grant, at least two pids can
        // be tracked simultaneously; ordering stays vacuous otherwise.
        let otherPid = NSWorkspace.shared.runningApplications
            .first(where: { $0.processIdentifier != selfPid })?.processIdentifier
        if let otherPid {
            monitor.attach(pid: otherPid)
        }

        let pids = monitor.attachedPids
        #expect(pids == pids.sorted()) // sorted keys, never dictionary order
        #expect(Set(pids).count == pids.count) // one observer set per pid
    }
}
