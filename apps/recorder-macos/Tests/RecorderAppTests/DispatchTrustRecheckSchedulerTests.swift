import Foundation
@testable import RecorderApp
import Testing

/// The production trust-recheck timer (PermissionGate.swift#DispatchTrustRecheckScheduler)
/// must cancel any prior timer on start() (no stacked timers across repeated
/// trust-loss cycles) and cancel a live timer on stop(). Ticks hop to a Task, so
/// assertions use NSLock-guarded counters: G2 pins stream-ceases semantics with
/// load-tolerant quiescence (test-design-6 §G); G3 bounds [expected−1, expected+2].
struct DispatchTrustRecheckSchedulerTests {
    /// Lock-guarded tick counter (ticks arrive on an arbitrary queue via Task).
    private final class TickCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func increment() {
            lock.lock()
            defer { lock.unlock() }
            count += 1
        }

        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }
    }

    /// Poll until `condition` holds or the deadline passes; returns the last observed value.
    private func waitUntil(
        timeout: TimeInterval,
        pollInterval: UInt32 = 5000,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: UInt64(pollInterval) * 1000)
        }
    }

    /// G1 — a started timer delivers ticks repeatedly at roughly the requested cadence.
    @Test
    func startDeliversTicksRepeatedly() async {
        let counter = TickCounter()
        let s = DispatchTrustRecheckScheduler()
        // Interval 0.05 s ⇒ ≥2 ticks well within 1 s (20× interval observation window).
        s.start(interval: 0.05) { counter.increment() }
        await waitUntil(timeout: 1.0) { counter.value >= 2 }
        #expect(counter.value >= 2)
        s.stop()
    }

    /// G2 — stop() cancels a live timer so the tick STREAM ceases: after stop(),
    /// quiescence is reached, i.e. a full quiet window (≥3 intervals) passes with
    /// no new tick. A fixed "≤ countAtStop + 1" pin was structurally too tight on
    /// loaded runners: heavyweight parallel suites delay DispatchSourceTimer
    /// invalidation, letting several already-queued tick blocks land after stop().
    /// The quiescence window tolerates that in-flight burst while a no-cancel
    /// mutant keeps ticking every interval and never quiets down.
    @Test
    func stopCancelsLiveTimer() async {
        let counter = TickCounter()
        let s = DispatchTrustRecheckScheduler()
        let interval: TimeInterval = 0.05
        s.start(interval: interval) { counter.increment() }
        await waitUntil(timeout: 1.0) { counter.value >= 1 }
        #expect(counter.value >= 1)

        s.stop()

        // Sleep one quiet window (3 intervals), then require the count unchanged;
        // retry until the deadline. A live timer fires every interval and cannot
        // cross a full window tick-free.
        let quietWindow = interval * 3
        let deadline = Date().addingTimeInterval(2.0)
        var quiesced = false
        repeat {
            let before = counter.value
            try? await Task.sleep(nanoseconds: UInt64(quietWindow * 1_000_000_000))
            quiesced = counter.value == before
        } while !quiesced && Date() < deadline
        #expect(quiesced)
    }

    /// G3 — restart does not stack timers: after start→stop→start at the same
    /// interval the tick rate stays near window/interval. A stacked-timer mutation
    /// roughly doubles the rate and trips the upper bound.
    @Test
    func restartDoesNotStackTimers() async {
        let counter = TickCounter()
        let s = DispatchTrustRecheckScheduler()

        let interval: TimeInterval = 0.05
        s.start(interval: interval) { counter.increment() }
        s.stop()
        s.start(interval: interval) { counter.increment() }

        // Observation window ≥ 20× interval.
        let window: TimeInterval = 0.5
        try? await Task.sleep(nanoseconds: UInt64(window * 1_000_000_000))

        let expected = Int(window / interval) // 10
        // Documented slack: [expected−1, expected+2]; doubling ⇒ ~20 fails.
        #expect(counter.value >= expected - 1)
        #expect(counter.value <= expected + 2)
        s.stop()
    }
}
