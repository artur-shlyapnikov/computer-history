import Foundation
@testable import RecorderApp
import Testing

/// EventBuffer batching semantics (spec §3.4): flush at 500 ms OR 100 events,
/// whichever first; spool the whole batch when the daemon send fails.
struct EventBufferTests {
    /// Deterministic timer: injected `sleep` awaits manual ticks.
    private actor TimerGate {
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var ticks = 0

        func tick() {
            if !waiters.isEmpty {
                waiters.removeFirst().resume()
            } else {
                ticks += 1
            }
        }

        func sleepInterval() async {
            if ticks > 0 {
                ticks -= 1
                return
            }
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    private func makeEvent(_ index: Int) -> ActivityEvent {
        ActivityEvent(
            id: Ulid.shared.next(nowMs: 1_700_000_000_000),
            observedAt: Int64(1_700_000_000_000 + index),
            monotonicNs: Int64(index),
            source: .input,
            app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
            window: nil,
            action: .typingActivity,
            target: nil,
            content: nil,
            contentPolicy: .metadataOnly,
            captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        )
    }

    /// Monotonic file-id sequence (filename order == creation order).
    private final class Seq: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func next() -> String {
            lock.lock()
            defer { lock.unlock() }
            n += 1
            return String(n)
        }
    }

    /// Spool whose first `failingIds` file ids collide with pre-created
    /// DIRECTORIES, so `appendBatch` throws while the id sequence points at
    /// them and succeeds afterwards. Tiny rotateBytes forces every attempt to
    /// open a fresh file, so attempt N consumes exactly file id N.
    private func makeFailingThenWorkingSpool(failingIds: Int) -> SpoolStore {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("eventbuffer-tests-\(UUID().uuidString)")
        let t0: Int64 = 1_700_000_000_000
        for i in 1 ... max(failingIds, 0) {
            // Collision dirs mirror the production name shape
            // spool-<epochMs>-<seq %06d>-<fileId>.jsonl; attempt N consumes
            // creation sequence N and file id N.
            try? FileManager.default.createDirectory(
                at: dir.appendingPathComponent("spool-\(t0)-\(String(format: "%06d", i))-\(i).jsonl"),
                withIntermediateDirectories: true
            )
        }
        var config = SpoolStore.Config()
        config.rotateBytes = 100 // smaller than any line → every open rotates
        return SpoolStore(directory: dir, config: config, nowMs: { t0 }, makeFileId: Seq().next)
    }

    private func makeSpool() -> SpoolStore {
        SpoolStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("eventbuffer-tests-\(UUID().uuidString)"))
    }

    @Test("flush triggers at exactly 100 appended events")
    func countTrigger() async {
        let spool = makeSpool()
        actor Recorder {
            var batches: [[ActivityEvent]] = []
            func record(_ b: EventBatch) {
                batches.append(b.events)
            }
        }
        let recorder = Recorder()
        let buffer = EventBuffer(sender: { batch in await recorder.record(batch) }, spool: spool)
        await buffer.start()

        for index in 0 ..< 100 {
            await buffer.append(makeEvent(index))
        }
        let sent = await recorder.batches
        #expect(sent.count == 1)
        #expect(sent.first?.count == 100)

        let stats = await buffer.stats
        #expect(stats.countFlushes == 1)
        #expect(stats.appendedEvents == 100)
        await buffer.shutdown()

        // Nothing extra flushed on shutdown since pending was drained at 100.
        let sentAfterShutdown = await recorder.batches
        #expect(sentAfterShutdown.count == 1)
    }

    @Test("flush triggers on an injected timer tick before reaching 100")
    func timerTrigger() async {
        let gate = TimerGate()
        let spool = makeSpool()
        actor Recorder {
            var batches: [[ActivityEvent]] = []
            func record(_ b: EventBatch) {
                batches.append(b.events)
            }
        }
        let recorder = Recorder()
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool,
            flushIntervalMs: 500,
            sleep: { _ in await gate.sleepInterval() },
            makeBatchId: { "batch-\(Ulid.shared.next(nowMs: 5))" }
        )
        await buffer.start()
        for index in 0 ..< 3 {
            await buffer.append(makeEvent(index))
        }
        // No flush yet — well below 100 events and no tick delivered.
        #expect(await recorder.batches.isEmpty)

        await gate.tick() // release one 500 ms interval
        try? await Task.sleep(nanoseconds: 50_000_000) // let the loop drain

        let sent = await recorder.batches
        #expect(sent.count == 1)
        #expect(sent.first?.count == 3)
        let stats = await buffer.stats
        #expect(stats.timerFlushes == 1)
        await buffer.shutdown()
    }

    @Test("send failure persists the whole batch to the spool")
    func failureSpoolsBatch() async {
        let spool = makeSpool()
        let buffer = EventBuffer(
            sender: { _ in throw DaemonClientError.notConnected },
            spool: spool,
            maxEvents: 2 // tiny threshold keeps the test small but same code path
        )
        await buffer.start()
        await buffer.append(makeEvent(1))
        await buffer.append(makeEvent(2))
        let stats = await buffer.stats
        #expect(stats.spooledBatches == 1)
        #expect(stats.liveBatchesSent == 0)
        #expect(spool.spooledEventCount == 2)
        #expect(stats.spoolFailures == 0) // first attempt succeeded; no failure counted
        await buffer.shutdown()
    }

    @Test("first spool attempt fails, retry succeeds → batch still counts as spooled")
    func spoolRetryRecovers() async {
        let spool = makeFailingThenWorkingSpool(failingIds: 1)
        let buffer = EventBuffer(
            sender: { _ in throw DaemonClientError.notConnected },
            spool: spool,
            maxEvents: 2
        )
        await buffer.start()
        await buffer.append(makeEvent(1))
        await buffer.append(makeEvent(2)) // triggers flush → spool attempt 1 throws, attempt 2 lands

        let stats = await buffer.stats
        #expect(stats.spooledBatches == 1) // the RETRY is what got counted
        #expect(stats.spoolFailures == 0)
        #expect(spool.spooledEventCount == 2)
        await buffer.shutdown()
    }

    @Test("both spool attempts fail → spoolFailures counted, batch never spooled")
    func doubleSpoolFailureSurfaced() async {
        // Ids 1 and 2 collide with directories; a THIRD attempt would succeed
        // (id 3 is free), so the assertions below also prove exactly one
        // retry happened — no third write.
        let spool = makeFailingThenWorkingSpool(failingIds: 2)
        let buffer = EventBuffer(
            sender: { _ in throw DaemonClientError.notConnected },
            spool: spool,
            maxEvents: 2
        )
        await buffer.start()
        await buffer.append(makeEvent(1))
        await buffer.append(makeEvent(2))

        let stats = await buffer.stats
        #expect(stats.spooledBatches == 0) // NOT counted as spooled
        #expect(stats.spoolFailures == 1)
        #expect(spool.spooledEventCount == 0) // no file was ever written
        await buffer.shutdown()
    }

    @Test("shutdown flushes whatever is still pending")
    func shutdownFlushesPending() async {
        let spool = makeSpool()
        actor Recorder {
            var batches: [[ActivityEvent]] = []
            func record(_ b: EventBatch) {
                batches.append(b.events)
            }
        }
        let recorder = Recorder()
        // Timer never fires during this test (gate never ticked, sleep blocks);
        // only shutdown may flush. Use a sleep that pends forever until cancel:
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool,
            sleep: { _ in try await Task.sleep(nanoseconds: 60_000_000_000) }
        )
        await buffer.start()
        await buffer.append(makeEvent(7))
        await buffer.shutdown() // cancels the timer task, then drains pending

        let sent = await recorder.batches
        #expect(sent.count == 1)
        #expect(sent.first?.count == 1)
        #expect(await buffer.pendingCount == 0)
    }
}
