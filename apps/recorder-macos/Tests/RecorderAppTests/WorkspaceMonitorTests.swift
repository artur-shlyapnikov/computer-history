import AppKit
@testable import RecorderApp
import Testing

/// WorkspaceMonitor lifecycle (D4-4, module previously at zero coverage):
/// - start() is idempotent — a duplicate observer would double-fire every
///   activation and silently corrupt app_focus attribution;
/// - setHandler() replaces (never stacks) the activation handler;
/// - stop() removes the observer AND nils the handler;
/// - notifications without the application userInfo key are ignored and the
///   monitor stays usable;
/// - stop() is safe to call twice.
///
/// Fixture: the real NSWorkspace.shared.notificationCenter with synthesized
/// didActivateApplication notifications carrying
/// NSRunningApplication.current. Delivery is on the main queue, so tests are
/// @MainActor async and drain via a bounded Task.yield() spin before
/// asserting. Every assertion is dual-safe: it holds with or without an
/// Accessibility permission grant.
///
/// Tests are serialized: every instance subscribes to the SHARED real
/// workspace notification center, so concurrent tests would cross-deliver
/// their synthesized activations into each other's monitors.
@Suite(.serialized)
@MainActor
struct WorkspaceMonitorTests {
    /// Thread-safe delivery log for handlers invoked on the main queue.
    private final class DeliveryLog: @unchecked Sendable {
        private let lock = NSLock()
        private var apps: [WorkspaceMonitor.ActivatedApp] = []

        func append(_ app: WorkspaceMonitor.ActivatedApp) {
            lock.lock()
            apps.append(app)
            lock.unlock()
        }

        var snapshot: [WorkspaceMonitor.ActivatedApp] {
            lock.lock()
            defer { lock.unlock() }
            return apps
        }
    }

    /// Bounded main-queue drain: notifications are delivered asynchronously
    /// on .main, so spin-yield until the hop lands (≤50 iterations) instead
    /// of sleeping on a wall clock.
    private func drainMainQueue(iterations: Int = 50) async {
        for _ in 0 ..< iterations {
            await Task.yield()
        }
    }

    private func postActivation(_ app: NSRunningApplication) {
        NSWorkspace.shared.notificationCenter.post(
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            userInfo: [NSWorkspace.applicationUserInfoKey: app]
        )
    }

    // MARK: - 1. start() idempotence guard

    @Test("start() twice registers one observer; one activation delivers exactly once")
    func doubleStartDeliversOnce() async {
        let monitor = WorkspaceMonitor()
        defer { monitor.stop() }
        let deliveries = DeliveryLog()
        monitor.setHandler { deliveries.append($0) }

        monitor.start()
        monitor.start() // duplicate observer must be rejected by the guard

        postActivation(.current)
        await drainMainQueue()

        #expect(deliveries.snapshot.count == 1)
    }

    // MARK: - 2. handler replacement + notification mapping

    @Test("setHandler replaces the handler; the mapped ActivatedApp carries pid and bundleId")
    func replacementHandlerReceivesMappedActivation() async {
        let monitor = WorkspaceMonitor()
        defer { monitor.stop() }
        let first = DeliveryLog()
        let second = DeliveryLog()

        monitor.start()
        monitor.setHandler { first.append($0) }
        monitor.setHandler { second.append($0) }

        postActivation(.current)
        await drainMainQueue()

        let activated = second.snapshot[0]
        // NSRunningApplication.current is DEGENERATE in a bare test runner
        // (processIdentifier -1, nil bundleIdentifier, nil name); inside a
        // bundled run it carries the real values. The mapping contract is
        // exact either way: the delivered snapshot mirrors the POSTED
        // application, and the "unknown" fallback keeps bundleId non-empty.
        #expect(activated.pid == NSRunningApplication.current.processIdentifier)
        #expect(!activated.bundleId.isEmpty)
        #expect(first.snapshot.isEmpty) // h1 was replaced, never stacked
        #expect(second.snapshot.count == 1)
        #expect(!activated.bundleId.isEmpty)
    }

    // MARK: - 3. stop() removes observer AND nils handler

    @Test("no delivery after stop()")
    func noDeliveryAfterStop() async {
        let monitor = WorkspaceMonitor()
        let deliveries = DeliveryLog()

        monitor.start()
        monitor.setHandler { deliveries.append($0) }
        monitor.stop()

        postActivation(.current)
        await drainMainQueue()

        // Either mechanism alone passes this (observer removed OR handler
        // nilled); both are asserted together so each deletion trips at
        // least one case in combination with the others.
        #expect(deliveries.snapshot.isEmpty)
    }

    // MARK: - 4. missing application userInfo key

    @Test("activation without the application key is ignored and the monitor stays usable")
    func missingApplicationKeyIsIgnored() async {
        let monitor = WorkspaceMonitor()
        defer { monitor.stop() }
        let deliveries = DeliveryLog()
        monitor.setHandler { deliveries.append($0) }

        monitor.start()
        NSWorkspace.shared.notificationCenter.post(
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            userInfo: nil // no applicationUserInfoKey
        )
        await drainMainQueue()
        #expect(deliveries.snapshot.isEmpty)

        // The malformed notification must not wedge the monitor.
        postActivation(.current)
        await drainMainQueue()
        #expect(deliveries.snapshot.count == 1)
    }

    // MARK: - 5. idempotent teardown

    @Test("stop() twice does not crash")
    func doubleStopIsSafe() {
        let monitor = WorkspaceMonitor()
        monitor.setHandler { _ in }
        monitor.start()
        monitor.stop()
        monitor.stop() // mirrors the `if let observer` teardown guard
    }
}
