import Foundation
@testable import RecorderApp
import Testing

/// EventBuffer success-path Stats accounting and wire-batch construction
/// (design P3-7): appendedEvents / liveBatchesSent / timerFlushes /
/// countFlushes beyond the failure paths already pinned by EventBufferTests,
/// plus verbatim append-order preservation and deterministic id injection.
/// Timer ticks are exercised via direct `flush(reason:)` calls — strictly
/// deterministic, no drain sleeps.
struct EventBufferStatsTests {
    // MARK: - Fixtures (cloned from EventBufferTests per repo convention)

    private func makeSpool() -> SpoolStore {
        SpoolStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("eventbuffer-stats-\(UUID().uuidString)"))
    }

    private func makeEvent(id: String, index: Int) -> ActivityEvent {
        ActivityEvent(
            id: id,
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

    /// Records whole batches (ids + events) for wire-shape assertions.
    private actor BatchRecorder {
        var batches: [EventBatch] = []
        func record(_ batch: EventBatch) {
            batches.append(batch)
        }
    }

    @Test("timer flush of three appends counts every success-path stat")
    func timerFlushStats() async {
        let spool = makeSpool()
        let recorder = BatchRecorder()
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool
        )

        for index in 0 ..< 3 {
            await buffer.append(makeEvent(id: "e\(index)", index: index))
        }
        // Well below the 100-event threshold: nothing flushed yet.
        #expect(await buffer.pendingCount == 3)

        await buffer.flush(reason: .timer)

        let stats = await buffer.stats
        #expect(stats.appendedEvents == 3)
        #expect(stats.liveBatchesSent == 1)
        #expect(stats.timerFlushes == 1)
        #expect(stats.countFlushes == 0)
        #expect(stats.spooledBatches == 0)
        #expect(await buffer.pendingCount == 0)
        let sent = await recorder.batches
        #expect(sent.count == 1)
    }

    @Test("reaching maxEvents flushes immediately as a count flush")
    func countFlushStats() async {
        let spool = makeSpool()
        let recorder = BatchRecorder()
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool,
            maxEvents: 2
        )

        await buffer.append(makeEvent(id: "e0", index: 0))
        #expect(await recorder.batches.isEmpty) // below threshold

        await buffer.append(makeEvent(id: "e1", index: 1)) // hits threshold → inline flush
        let sent = await recorder.batches
        #expect(sent.count == 1)

        let stats = await buffer.stats
        #expect(stats.appendedEvents == 2)
        #expect(stats.liveBatchesSent == 1)
        #expect(stats.countFlushes == 1)
        #expect(stats.timerFlushes == 0)
    }

    @Test("the wire batch preserves append order verbatim")
    func batchPreservesAppendOrder() async {
        let spool = makeSpool()
        let recorder = BatchRecorder()
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool
        )

        await buffer.append(makeEvent(id: "e1", index: 0))
        await buffer.append(makeEvent(id: "e2", index: 1))
        await buffer.append(makeEvent(id: "e3", index: 2))
        await buffer.flush(reason: .timer)

        let sent = await recorder.batches
        #expect(sent.first?.events.map(\.id) == ["e1", "e2", "e3"])
    }

    @Test("messageId and batchId draw distinct ids from the injector across batches")
    func injectedIdsStayUnique() async {
        let spool = makeSpool()
        let recorder = BatchRecorder()

        // Draw order inside flush(): messageId first, then batchId.
        final class IdSeq: @unchecked Sendable {
            private let lock = NSLock()
            private var n = -1
            let ids = ["m1", "b1", "m2", "b2"]
            func next() -> String {
                lock.lock(); defer { lock.unlock() }
                n += 1
                return ids[n]
            }
        }
        let seq = IdSeq()
        let buffer = EventBuffer(
            sender: { batch in await recorder.record(batch) },
            spool: spool,
            makeBatchId: { seq.next() }
        )

        await buffer.append(makeEvent(id: "a", index: 0))
        await buffer.flush(reason: .timer)
        await buffer.append(makeEvent(id: "b", index: 1))
        await buffer.flush(reason: .timer)

        let sent = await recorder.batches
        #expect(sent.count == 2)
        for batch in sent {
            #expect(batch.messageId != batch.batchId)
        }
        #expect(sent.map(\.messageId) == ["m1", "m2"]) // unique across batches
        #expect(sent.map(\.batchId) == ["b1", "b2"])
    }
}
