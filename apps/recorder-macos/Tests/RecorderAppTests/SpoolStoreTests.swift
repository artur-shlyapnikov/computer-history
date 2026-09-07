import Foundation
@testable import RecorderApp
import Testing

/// SpoolStore semantics (spec §3.8): rotating JSONL, 25 MiB cap dropping the
/// oldest file, 48 h age purge, replay oldest-first with delete-after-full-ACK,
/// and crash-safe tolerance for torn final lines. All thresholds are injected
/// so tests stay tiny and deterministic.
struct SpoolStoreTests {
    struct SendFailed: Error {}

    /// Deterministic, monotonically increasing file ids so filename-sorted
    /// order equals creation order.
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

    /// Locked clock advancing a fixed step per read, so each rotated file gets
    /// a distinct, known filename timestamp.
    private final class SteppingClock: @unchecked Sendable {
        private let lock = NSLock()
        private var now: Int64
        private let stepMs: Int64
        init(start: Int64, stepMs: Int64) {
            now = start
            self.stepMs = stepMs
        }

        func tick() -> Int64 {
            lock.lock()
            defer { lock.unlock() }
            defer { now += stepMs }
            return now
        }
    }

    /// Freely settable clock for driving mid-life age purges.
    private final class SettableClock: @unchecked Sendable {
        private let lock = NSLock()
        private var now: Int64
        init(_ start: Int64) {
            now = start
        }

        func get() -> Int64 {
            lock.withLock { now }
        }

        func set(_ value: Int64) {
            lock.withLock { now = value }
        }
    }

    /// Filler that makes every JSONL line comfortably exceed 400 bytes so
    /// rotation/cap assertions never depend on exact envelope sizes.
    private static let filler = String(repeating: "x", count: 60)

    private func makeBatch(_ marker: Int, nowMs: Int64 = 1_700_000_000_000) -> EventBatch {
        let event = ActivityEvent(
            id: Ulid.shared.next(nowMs: nowMs),
            observedAt: nowMs,
            monotonicNs: Int64(marker),
            source: .input,
            app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
            window: nil,
            action: .typingActivity,
            target: nil,
            content: Self.filler,
            contentPolicy: .metadataOnly,
            captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        )
        return EventBatch(
            protocolVersion: 1,
            messageId: Ulid.shared.next(nowMs: nowMs),
            type: "event_batch",
            sentAt: nowMs,
            batchId: Ulid.shared.next(nowMs: nowMs),
            events: [event]
        )
    }

    private func ackAll(_ batch: EventBatch) -> EventBatchAck {
        EventBatchAck(
            protocolVersion: 1,
            messageId: "ack-\(batch.batchId)",
            type: "event_batch_ack",
            sentAt: 0,
            batchId: batch.batchId,
            accepted: batch.events.count,
            duplicates: 0,
            rejected: 0
        )
    }

    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("spool-tests-\(UUID().uuidString)")
    }

    private func config(cap: Int64 = .max, maxSendFailuresPerFile: Int = 3) -> SpoolStore.Config {
        var config = SpoolStore.Config()
        config.rotateBytes = 300 // one padded batch per file (~350 B lines)
        config.totalCapBytes = cap
        config.maxAgeMs = 48 * 60 * 60 * 1000
        config.maxSendFailuresPerFile = maxSendFailuresPerFile
        return config
    }

    /// Store whose filenames are strictly ordered by creation time.
    private func orderedStore(
        dir: URL,
        cap: Int64 = .max,
        now: Int64 = 1_700_000_000_000,
        maxSendFailuresPerFile: Int = 3
    ) -> SpoolStore {
        let seq = Seq()
        return SpoolStore(
            directory: dir,
            config: config(cap: cap, maxSendFailuresPerFile: maxSendFailuresPerFile),
            nowMs: { now },
            makeFileId: { seq.next() }
        )
    }

    /// NOTE (S7 honesty): crash-mid-batch durability is covered ONLY at unit
    /// level — torn final lines, delete-after-full-ACK, and stop-at-first-
    /// failure below. There is deliberately NO kill-the-process-mid-replay
    /// integration test; these unit semantics stand in for it by design.
    @Test("append + full ACK deletes the file")
    func replayAckDeletesFile() async {
        let store = orderedStore(dir: tempDir())
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))

        let report = await store.replayOldestFirst { batch in ackAll(batch) }

        #expect(report.filesReplayed == 2) // one batch per rotated file
        #expect(report.batchesSent == 2)
        #expect(report.eventsAcked == 2)
        #expect(report.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
    }

    @Test("under-covering ACK keeps the file for redelivery")
    func underCoveringAckKeepsFile() async {
        let store = orderedStore(dir: tempDir())
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))

        // Daemon claims one fewer event than the file contains → not all ids
        // reached a terminal state; the file MUST survive untouched.
        let report = await store.replayOldestFirst { batch in
            EventBatchAck(
                protocolVersion: 1,
                messageId: "m",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: max(batch.events.count - 1, 0),
                duplicates: 0,
                rejected: 0
            )
        }
        #expect(report.filesReplayed == 0)
        #expect(report.filesRemaining == 2) // stopped before the first file
        #expect(store.spooledEventCount == 2)
    }

    @Test("sender failure mid-file preserves everything for next reconnect")
    func failedSendStopsReplay() async {
        let store = orderedStore(dir: tempDir())
        try? store.appendBatch(makeBatch(1))

        let report = await store.replayOldestFirst { _ in throw SendFailed() }
        #expect(report.batchesSent == 0)
        #expect(report.filesRemaining == 1)
        #expect(store.spooledEventCount == 1)
    }

    @Test("replay visits files oldest-first and stops at the first failure")
    func replayOrderAndStop() async {
        // Each append rotates (line > rotateBytes), producing file 1 then file 2.
        let batchA = makeBatch(1)
        let batchB = makeBatch(2)

        // Pass 1: both succeed → both files gone, strict order enforced.
        let store1 = orderedStore(dir: tempDir())
        try? store1.appendBatch(batchA)
        try? store1.appendBatch(batchB)

        actor OrderRecorder {
            var seen: [String] = []
            func record(_ b: EventBatch) {
                seen.append(b.batchId)
            }
        }
        let recorder = OrderRecorder()
        _ = await store1.replayOldestFirst { batch in
            await recorder.record(batch)
            return ackAll(batch)
        }
        let seen = await recorder.seen
        #expect(seen == [batchA.batchId, batchB.batchId])
        #expect(store1.spooledEventCount == 0)

        // Pass 2: second file fails → first deleted, second kept for redelivery.
        let store2 = orderedStore(dir: tempDir())
        try? store2.appendBatch(batchA)
        try? store2.appendBatch(batchB)

        let report2 = await store2.replayOldestFirst { batch in
            if batch.batchId == batchB.batchId {
                throw SendFailed()
            }
            return ackAll(batch)
        }
        #expect(report2.filesReplayed == 1)
        #expect(report2.batchesSent == 1)
        #expect(report2.filesRemaining == 1)
        #expect(store2.spooledEventCount == 1)
    }

    /// Round 31: a backwards clock step can land a legacy two-segment name
    /// (`spool-<ms>-<ulid>.jsonl`, pre-upgrade) and a current three-segment
    /// name (`spool-<ms>-<seq>-<ulid>.jsonl`) on the SAME millisecond stamp.
    /// The raw-filename tie-break orders them wrongly there — '0' < 'a' puts
    /// the CURRENT-format file first even though the legacy file was written
    /// before the upgrade, i.e. earlier. The tie-break must compare the
    /// parsed sequence segment and sort the seq-less legacy file FIRST.
    @Test("same-stamp mixed filename formats replay the pre-upgrade file first")
    func mixedFormatSameStampReplaysLegacyFirst() async throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp: Int64 = 1_700_000_000_000
        let encoder = JSONEncoder()
        // Names chosen so the OLD comparator (lastPathComponent) puts the
        // current-format file first; the fixed comparator must invert that.
        try (encoder.encode(makeBatch(1)) + Data("\n".utf8)).write(
            to: dir.appendingPathComponent("spool-\(stamp)-legacyulid.jsonl")
        )
        try (encoder.encode(makeBatch(2)) + Data("\n".utf8)).write(
            to: dir.appendingPathComponent("spool-\(stamp)-000042-newulid.jsonl")
        )

        actor Markers {
            var seen: [Int] = []
            func record(_ batch: EventBatch) {
                seen.append(Int(batch.events[0].monotonicNs ?? -1))
            }
        }
        let markers = Markers()
        let store = SpoolStore(directory: dir, config: config(), nowMs: { stamp }, makeFileId: { "x" })

        let report = await store.replayOldestFirst { batch in
            await markers.record(batch)
            return ackAll(batch)
        }

        let order = await markers.seen
        #expect(order == [1, 2], "legacy file must precede the current-format file at the same stamp")
        #expect(report.filesReplayed == 2)
    }

    /// Round 32: cap eviction shares `isOlder` with the replay sort, so at an
    /// identical embedded stamp the LEGACY seq-less file must be dropped
    /// first (it predates the upgrade). The raw-filename tie-break would pick
    /// the current-format file as OLDEST and evict the wrong one.
    @Test("cap eviction with same-stamp mixed formats drops the legacy-format file first")
    func capEvictsLegacyFormatFirstAtSameStamp() throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp: Int64 = 1_700_000_000_000
        let encoder = JSONEncoder()
        let lineBytes = try JSONEncoder().encode(makeBatch(1)).count + 1
        // Identical embedded stamp; one legacy two-segment name, one current
        // three-segment name. Names chosen so the OLD comparator
        // (lastPathComponent) orders the new-format file oldest and would
        // evict IT; the fixed ordering must protect it instead.
        try (encoder.encode(makeBatch(1)) + Data("\n".utf8)).write(
            to: dir.appendingPathComponent("spool-\(stamp)-legacyulid.jsonl")
        )
        try (encoder.encode(makeBatch(2)) + Data("\n".utf8)).write(
            to: dir.appendingPathComponent("spool-\(stamp)-000042-newulid.jsonl")
        )

        let seq = Seq()
        // Cap fits exactly one line, so ANY second tracked file forces the
        // eviction pass on the next append.
        let store = SpoolStore(
            directory: dir,
            config: config(cap: Int64(lineBytes) + 10),
            nowMs: { stamp },
            makeFileId: { seq.next() }
        )

        // This append's own file (same stamp, seq 000001) pushes the total
        // over the cap: eviction must drop legacy → appended(seq 1) in order,
        // sparing the seq-42 current-format file.
        try? store.appendBatch(makeBatch(3))

        #expect(store.spooledEventCount == 1)
        let survivors = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .sorted()
        #expect(
            survivors == ["spool-\(stamp)-000042-newulid.jsonl"],
            "the legacy same-stamp file must be evicted before the current-format file"
        )
    }

    @Test("total-cap overflow drops the oldest file")
    func capDropsOldest() async throws {
        // Three files with distinct, known timestamps; a cap sized between one
        // and two lines forces every append to drop the previous oldest file,
        // so exactly the NEWEST batch must survive.
        let lineBytes = try JSONEncoder().encode(makeBatch(1)).count + 1
        let dir = tempDir()
        let clock = SteppingClock(start: 1_700_000_000_000, stepMs: 1000)
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: config(cap: Int64(lineBytes) + 10),
            nowMs: { clock.tick() },
            makeFileId: { seq.next() }
        )
        let batch1 = makeBatch(1)
        let batch2 = makeBatch(2)
        let batch3 = makeBatch(3)
        try? store.appendBatch(batch1) // oldest stamp
        try? store.appendBatch(batch2) // middle stamp → total > cap → drop batch1's file
        try? store.appendBatch(batch3) // newest stamp → total > cap → drop batch2's file

        #expect(store.spooledEventCount == 1)
        // Assert WHICH event survived: the newest file's batch, not an
        // arbitrary one from the unsorted directory listing.
        actor SeenRecorder {
            var ids: [String] = []
            func record(_ b: EventBatch) {
                ids.append(b.batchId)
            }
        }
        let seen = SeenRecorder()
        _ = await store.replayOldestFirst { batch in
            await seen.record(batch)
            return ackAll(batch)
        }
        let survivingIds = await seen.ids
        #expect(survivingIds == [batch3.batchId])
    }

    @Test("files older than the age limit are purged at startup/replay")
    func agePurge() {
        let dir = tempDir()
        let t0: Int64 = 1_700_000_000_000
        let old = SpoolStore(directory: dir, config: config(), nowMs: { t0 }, makeFileId: { "old" })
        try? old.appendBatch(makeBatch(1, nowMs: t0))
        // Round-30 belt: purge now requires BOTH the embedded stamp and the
        // on-disk mtime to be older than the cutoff — backdate the mtime so
        // the simulated 49 h jump purges the file exactly as real aging would.
        for file in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
            try? FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: Double(t0) / 1000)],
                ofItemAtPath: dir.appendingPathComponent(file).path
            )
        }
        #expect(old.spooledEventCount == 1)

        // Reopen 49 hours later: the expired file is purged before any replay.
        let fresh = SpoolStore(
            directory: dir,
            config: config(),
            nowMs: { t0 + 49 * 60 * 60 * 1000 },
            makeFileId: { "new" }
        )
        #expect(fresh.spooledEventCount == 0)
        #expect(fresh.purgeExpired() == 0) // nothing left to purge
    }

    @Test("a torn final line does not lose the intact batches (crash safety)")
    func tornLineSkipped() async throws {
        let dir = tempDir()
        let store = orderedStore(dir: dir)
        try store.appendBatch(makeBatch(1))

        // Simulate a crash mid-append: garbage half-written JSONL tail.
        let fileName = try #require(FileManager.default.contentsOfDirectory(atPath: dir.path).first)
        let handle = try FileHandle(forWritingTo: dir.appendingPathComponent(fileName))
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"batchId\":\"torn".utf8))
        try handle.close()
        #expect(store.spooledEventCount == 1) // external garbage never counts

        let report = await store.replayOldestFirst { batch in ackAll(batch) }
        #expect(report.tornLinesSkipped == 1)
        #expect(report.batchesSent == 1) // the intact batch survived
        #expect(report.filesRemaining == 0) // and the file was fully acked away
    }

    @Test("replay seals the open writer so fully-acked deletion never orphans it")
    func replaySealsCurrentFile() async throws {
        let dir = tempDir()
        // Large rotateBytes keeps the post-replay append in the SAME writer,
        // so the test fails if that writer was left pointing at an unlinked
        // inode instead of being sealed.
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 10_000_000
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )
        try store.appendBatch(makeBatch(1))

        _ = await store.replayOldestFirst { [self] batch in ackAll(batch) }

        try store.appendBatch(makeBatch(2))
        #expect(store.spooledEventCount == 1)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 1)
    }

    @Test("a failing cap deletion breaks the loop instead of freezing capture")
    func failedDeletionBreaksCapLoop() throws {
        let dir = tempDir()
        // Tiny cap: one padded line fits (~350 B < 500) but two do not.
        // Large rotateBytes keeps both batches in one file so the writer
        // stays open across appends.
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 10_000_000
        cfg.totalCapBytes = 500
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )
        try store.appendBatch(makeBatch(1))

        // An unwritable directory makes removeItem fail (unlink needs write
        // permission there). Pre-fix this spun forever holding the lock.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500],
            ofItemAtPath: dir.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: dir.path
            )
        }

        // Must return (not hang): the failed deletion stops the loop once.
        try store.appendBatch(makeBatch(2))
        #expect(store.spooledEventCount >= 2) // both batches still readable
    }

    @Test("nil writer handle leaves currentURL unset so the next append retries")
    func nilHandleRetriesNextAppend() throws {
        let dir = tempDir()
        let store = orderedStore(dir: dir)

        // Writer creation fails while the directory is unwritable…
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o500],
            ofItemAtPath: dir.path
        )
        #expect(throws: (any Error).self) {
            try store.appendBatch(makeBatch(1))
        }

        // …and the very next append must recover instead of throwing forever.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: dir.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: dir.path
            )
        }
        try store.appendBatch(makeBatch(2))
        #expect(store.spooledEventCount == 1)
    }

    @Test("spooledEventCount stays accurate across append, cap-drop and full-ACK replay")
    func countAccuracyAcrossAppendCapDropAndReplay() async throws {
        // Same shape as capDropsOldest: every append overflows the tiny cap,
        // so exactly one event survives at any time.
        let lineBytes = try JSONEncoder().encode(makeBatch(1)).count + 1
        let dir = tempDir()
        let clock = SteppingClock(start: 1_700_000_000_000, stepMs: 1000)
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: config(cap: Int64(lineBytes) + 10),
            nowMs: { clock.tick() },
            makeFileId: { seq.next() }
        )
        try store.appendBatch(makeBatch(1))
        #expect(store.spooledEventCount == 1)
        try store.appendBatch(makeBatch(2)) // overflow → batch 1's file dropped
        #expect(store.spooledEventCount == 1)
        try store.appendBatch(makeBatch(3)) // overflow → batch 2's file dropped
        #expect(store.spooledEventCount == 1)

        // Full-ACK replay of the survivor drains the incremental counter.
        let report = await store.replayOldestFirst { batch in ackAll(batch) }
        #expect(report.filesReplayed == 1)
        #expect(store.spooledEventCount == 0)
    }

    @Test("mid-life age purge subtracts purged events from the counter")
    func countTracksMidLifeAgePurge() throws {
        let dir = tempDir()
        let t0: Int64 = 1_700_000_000_000
        let clock = SettableClock(t0)
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 10_000_000 // one file holding both batches
        cfg.totalCapBytes = .max
        cfg.maxAgeMs = 1000
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { clock.get() },
            makeFileId: { seq.next() }
        )
        try store.appendBatch(makeBatch(1))
        try store.appendBatch(makeBatch(2))
        #expect(store.spooledEventCount == 2)

        // Round-30 belt: both keys must agree before a file is aged out.
        // Backdate the mtime so the clock jump (not just the embedded stamp)
        // reads as expired, matching how a genuinely old file looks on disk.
        for file in try FileManager.default.contentsOfDirectory(atPath: dir.path) {
            try? FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: Double(t0) / 1000)],
                ofItemAtPath: dir.appendingPathComponent(file).path
            )
        }

        clock.set(t0 + 2000) // both events now older than maxAgeMs
        #expect(store.purgeExpired() == 1)
        #expect(store.spooledEventCount == 0)
    }

    @Test("a reopened store seeds its counter from leftover spool files")
    func reopenSeedsCounterFromLeftoverFiles() async {
        let dir = tempDir()
        let first = orderedStore(dir: dir)
        try? first.appendBatch(makeBatch(1))
        try? first.appendBatch(makeBatch(2))

        // A fresh store instance over the same directory must see the two
        // leftover files' events without any appends of its own…
        let reopened = orderedStore(dir: dir)
        #expect(reopened.spooledEventCount == 2)

        // …and its counter must drain as they are fully ACKed away.
        let report = await reopened.replayOldestFirst { batch in ackAll(batch) }
        #expect(report.filesReplayed == 2)
        #expect(reopened.spooledEventCount == 0)
    }

    @Test("spool files and directory are user-private (0600 / 0700)")
    func spoolPermissionsAreRestricted() throws {
        let dir = tempDir()
        let store = orderedStore(dir: dir)
        try store.appendBatch(makeBatch(1))

        let dirPerms = try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? NSNumber
        #expect(dirPerms?.uint16Value == 0o700)
        let fileName = try #require(FileManager.default.contentsOfDirectory(atPath: dir.path).first)
        let filePerms = try FileManager.default.attributesOfItem(
            atPath: dir.appendingPathComponent(fileName).path
        )[.posixPermissions] as? NSNumber
        #expect(filePerms?.uint16Value == 0o600)
    }

    /// Simulated ENOSPC for the torn-write test.
    private struct DiskFull: Error {}

    /// Single-shot failure flag for simulating a torn write (ENOSPC-style):
    /// the kernel copies a partial prefix of the line, then the write errors.
    private final class FailFirstWrite: @unchecked Sendable {
        private let lock = NSLock()
        private var writes = 0
        private let failOnWrite: Int
        init(failOnWrite: Int = 2) {
            self.failOnWrite = failOnWrite
        }

        /// Returns true for the one write that must fail.
        func shouldFail() -> Bool {
            lock.withLock {
                writes += 1
                return writes == failOnWrite
            }
        }
    }

    @Test("a thrown mid-line write truncates the torn tail so replay stays decodable")
    func failedWriteTruncatesTornTail() async throws {
        let dir = tempDir()
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 10_000_000 // one file, one open writer across appends
        cfg.totalCapBytes = .max
        let seq = Seq()
        let failOnce = FailFirstWrite()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() },
            performRawWrite: { handle, line in
                if failOnce.shouldFail() {
                    // Partial prefix lands (no trailing newline), then ENOSPC.
                    try handle.write(contentsOf: line.prefix(line.count / 2))
                    throw DiskFull()
                }
                try handle.write(contentsOf: line)
            }
        )
        try store.appendBatch(makeBatch(1))

        let fileName = try #require(FileManager.default.contentsOfDirectory(atPath: dir.path).first)
        let url = dir.appendingPathComponent(fileName)
        func fileSizeOnDisk() throws -> Int64 {
            try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64 ?? -1
        }
        let sizeBeforeFailure = try fileSizeOnDisk()

        // The failing append propagates AND leaves no torn fragment behind.
        #expect(throws: (any Error).self) { try store.appendBatch(makeBatch(2)) }
        #expect(try fileSizeOnDisk() == sizeBeforeFailure) // truncated to last complete line
        #expect(store.spooledEventCount == 1) // the failed batch never counts

        // A subsequent successful append must decode cleanly at replay.
        // Without the truncate guard it would fuse with the fragment into one
        // undecodable line and BOTH batches would be dropped at replay.
        try store.appendBatch(makeBatch(3))
        let report = await store.replayOldestFirst { batch in ackAll(batch) }
        #expect(report.tornLinesSkipped == 0)
        #expect(report.batchesSent == 2)
        #expect(report.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
    }

    @Test("concurrent appends during replay never list the open writer file")
    func concurrentAppendDuringReplayKeepsWriterConsistent() async throws {
        let dir = tempDir()
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 10_000_000 // a single open writer for the whole test
        cfg.totalCapBytes = .max
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )

        let taskCount = 6
        let batchesPerTask = 40
        let allBatches = (0 ..< taskCount).map { task in
            (0 ..< batchesPerTask).map { makeBatch(task * 100 + $0) }
        }
        let expectedIds = Set(allBatches.flatMap { $0.map(\.batchId) })

        actor Seen {
            var ids: [String] = []
            func record(_ batch: EventBatch) {
                ids.append(batch.batchId)
            }
        }
        let seen = Seen()

        await withTaskGroup(of: Void.self) { group in
            // Replay passes race the appenders. Pre-fix, a file created
            // between purgeExpired() and the snapshot listing could be deleted
            // while its FileHandle was still open; every later append went to
            // the unlinked inode and was silently lost.
            group.addTask { [self] in
                for _ in 0 ..< 20 {
                    _ = await store.replayOldestFirst { batch in
                        await seen.record(batch)
                        return ackAll(batch)
                    }
                }
            }
            for taskBatches in allBatches {
                for batch in taskBatches {
                    group.addTask { try? store.appendBatch(batch) }
                }
            }
        }

        // Drain whatever the racing passes left over (bounded, never hangs).
        for _ in 0 ..< 50 where store.spooledEventCount > 0 {
            _ = await store.replayOldestFirst { batch in
                await seen.record(batch)
                return ackAll(batch)
            }
        }

        let seenIds = await Set(seen.ids)
        #expect(seenIds == expectedIds) // every event reached the sender: none silently lost
        #expect(store.spooledEventCount == 0) // incremental counter matches disk truth
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }

    // MARK: - Poison isolation (round-14: spool head-of-line block)

    /// Regression: a deterministically undeliverable file must not wedge the
    /// queue. One poisoned file between two good ones: the good ones still
    /// deliver, the poisoned one is quarantined past the replay cursor.
    @Test("a poisoned file between two good ones is quarantined and the queue advances")
    func poisonedFileIsolatedAndQueueAdvances() async {
        let dir = tempDir()
        let store = orderedStore(dir: dir, maxSendFailuresPerFile: 2)
        // Each append rotates: files A(1), B(2), C(3), oldest-first.
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))
        try? store.appendBatch(makeBatch(3))

        let failing: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            if batch.events.first?.monotonicNs == 2 {
                throw SendFailed()
            }
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // Pass 1: A delivers, B fails once → blocked, C waits behind it.
        let first = await store.replayOldestFirst(batchSender: failing)
        #expect(first.filesReplayed == 1)
        #expect(first.filesQuarantined == 0)
        #expect(first.filesRemaining == 2)
        #expect(store.spooledEventCount == 2)

        // Pass 2: B fails again → quarantined, so C finally delivers.
        let second = await store.replayOldestFirst(batchSender: failing)
        #expect(second.filesQuarantined == 1)
        #expect(second.filesReplayed == 1)
        #expect(second.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)

        // The poisoned file survives outside the replay cursor; nothing
        // spooled remains.
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.count == 1)
        #expect(entries.filter { $0.hasPrefix("spool-") }.isEmpty)
    }

    // MARK: - Environmental carve-out (round-15: daemon-down must not quarantine)

    /// Regression: DaemonClientErrors that mean "the daemon is briefly gone
    /// but the data is healthy" (.replyTimedOut from a silent-but-open peer,
    /// .notConnected from teardown) MUST block WITHOUT accumulating strikes.
    /// A mutant deleting the environmental special-case in classifySendFailure
    /// keeps every SendFailed/wire-cap test green while healthy spooled data
    /// silently quarantines after maxSendFailuresPerFile silent-peer timeouts.
    @Test("replyTimedOut blocks forever without strikes until the error clears")
    func replyTimeoutNeverAccumulatesStrikes() async {
        let dir = tempDir()
        let store = orderedStore(dir: dir, maxSendFailuresPerFile: 3)
        // Each append rotates: files A(1), B(2), C(3), oldest-first.
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))
        try? store.appendBatch(makeBatch(3))

        let gate = DaemonDownGate()
        actor DaemonDownGate {
            var down = true
            func recover() {
                down = false
            }
        }
        let flaky: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            if await gate.down, batch.events.first?.monotonicNs == 2 {
                throw DaemonClientError.replyTimedOut("no ack for \(batch.batchId) before the deadline")
            }
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // Three full passes against a threshold of 3: B hits the silent-peer
        // timeout EVERY pass, yet must never gain a strike. A delivers on the
        // first pass; C stays strictly ordered behind B.
        for pass in 1 ... 3 {
            let report = await store.replayOldestFirst(batchSender: flaky)
            #expect(report.filesQuarantined == 0, "pass \(pass): environmental failure quarantined healthy data")
            #expect(report.filesRemaining == 2) // B + C always survive
            #expect(pass == 1 ? report.filesReplayed == 1 : report.filesReplayed == 0)
        }

        // The error clears (daemon comes back): B and C deliver, no quarantine.
        await gate.recover()
        let recovered = await store.replayOldestFirst(batchSender: flaky)
        #expect(recovered.filesQuarantined == 0)
        #expect(recovered.filesReplayed == 2)
        #expect(recovered.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.isEmpty) // nothing was ever moved
    }

    @Test("notConnected blocks without strikes so teardown windows never quarantine")
    func notConnectedNeverAccumulatesStrikes() async {
        let dir = tempDir()
        let store = orderedStore(dir: dir, maxSendFailuresPerFile: 3)
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))

        let offline: @Sendable (EventBatch) async throws -> EventBatchAck = { _ in
            throw DaemonClientError.notConnected
        }

        // One more failing pass than the quarantine threshold: a strike-
        // counting mutant quarantines here and fails these assertions.
        for pass in 1 ... 4 {
            let report = await store.replayOldestFirst(batchSender: offline)
            #expect(report.filesQuarantined == 0, "pass \(pass): notConnected quarantined healthy data")
            #expect(store.spooledEventCount == 2, "pass \(pass): strike leaked into the counter")
            #expect(report.filesRemaining == 2)
            #expect(report.batchesSent == 0)
        }

        // Reconnect: the very same files deliver untouched.
        let reconnected = await store.replayOldestFirst { batch in
            EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }
        #expect(reconnected.filesReplayed == 2)
        #expect(reconnected.filesQuarantined == 0)
        #expect(store.spooledEventCount == 0)
    }

    /// Regression (round-15 P1): `transportWriteFailed` means the socket
    /// write itself failed (EAGAIN from SO_SNDTIMEO, EPIPE, ...) while the
    /// data is healthy — the same environmental carve-out as daemon-down.
    /// A mutant routing it through the poison branch quarantines the healthy
    /// spool within `maxSendFailuresPerFile` passes and fails these checks.
    @Test("transportWriteFailed blocks without strikes across passes and delivers once cleared")
    func transportWriteFailureNeverAccumulatesStrikes() async {
        let dir = tempDir()
        let store = orderedStore(dir: dir, maxSendFailuresPerFile: 3)
        // Each append rotates: files A(1), B(2), C(3), oldest-first; the
        // transport error hits B, wedged between two good files.
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))
        try? store.appendBatch(makeBatch(3))

        final class Wedge: @unchecked Sendable {
            private let lock = NSLock()
            private var active = true
            var isActive: Bool {
                lock.withLock { active }
            }

            func recover() {
                lock.withLock { active = false }
            }
        }

        let wedge = Wedge()
        let flaky: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            if wedge.isActive, batch.events.first?.monotonicNs == 2 {
                // EAGAIN-style socket-write failure against a wedged-but-
                // alive daemon, as thrown by sendAll under SO_SNDTIMEO.
                throw DaemonClientError.transportWriteFailed("send: Resource temporarily unavailable")
            }
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // More failing passes than the threshold of 3: B hits the transport
        // write failure EVERY pass yet must never gain a strike. A delivers
        // on pass 1; C stays strictly ordered behind B.
        for pass in 1 ... 4 {
            let report = await store.replayOldestFirst(batchSender: flaky)
            #expect(report.filesQuarantined == 0, "pass \(pass): transport write failure quarantined healthy data")
            #expect(report.filesRemaining == 2, "pass \(pass): B + C must survive every pass")
            #expect(pass == 1 ? report.filesReplayed == 1 : report.filesReplayed == 0)
            #expect(store.spooledEventCount == 2, "pass \(pass): strike leaked into the counter")
        }

        // The wedge clears: B and C deliver untouched, nothing was ever moved.
        wedge.recover()
        let recovered = await store.replayOldestFirst(batchSender: flaky)
        #expect(recovered.filesQuarantined == 0)
        #expect(recovered.filesReplayed == 2)
        #expect(recovered.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.isEmpty)
    }

    /// Regression (round-16 T-4): pins the INTRA-file semantics of a
    /// `transportWriteFailed` crossing the client→spool boundary MID-file:
    /// with batch 2 of one file failing every pass, the healthy LEADING
    /// batch re-delivers alone (`batchesSent == 1`), the file accumulates
    /// ZERO strikes against `maxSendFailuresPerFile == 3`, and after the
    /// error clears both batches of the same file flush untouched in
    /// order. The whole-file case — the same real error thrown for every
    /// batch so an entire single-batch file survives repeated passes — is
    /// already pinned by `transportWriteFailureNeverAccumulatesStrikes`.
    @Test("transportWriteFailed mid-file blocks without strikes and preserves ordering")
    func transportWriteFailedMidFileNeverAccumulatesStrikes() async {
        let dir = tempDir()
        // A large rotate window keeps BOTH appended batches in one file A.
        let seq = Seq()
        var cfg = config(maxSendFailuresPerFile: 3)
        cfg.rotateBytes = 10000
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))

        let flaky: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            if batch.events.first?.monotonicNs == 2 {
                // The REAL client error type, as thrown by sendAll when the
                // socket write fails with EAGAIN under SO_SNDTIMEO.
                throw DaemonClientError.transportWriteFailed("send: Resource temporarily unavailable (EAGAIN)")
            }
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // More failing passes than the threshold of 3: batch 1 re-delivers
        // every pass (batchesSent == 1) while batch 2 hits the transport
        // failure; the file must never gain a strike. Ordering holds: batch 2
        // stays strictly ahead of any later delivery until the error clears.
        for pass in 1 ... 4 {
            let report = await store.replayOldestFirst(batchSender: flaky)
            #expect(report.filesQuarantined == 0, "pass \(pass): transport write failure quarantined healthy data")
            #expect(report.filesRemaining == 1, "pass \(pass): the two-batch file must survive every pass")
            #expect(report.batchesSent == 1, "pass \(pass): only the leading batch re-delivers while the tail is blocked")
            #expect(store.spooledEventCount == 2, "pass \(pass): strike leaked into the counter")
        }

        // The error clears (healthy sender again): both batches of the same
        // file deliver untouched, nothing was ever moved aside.
        let recovered = await store.replayOldestFirst { batch in
            EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }
        #expect(recovered.filesQuarantined == 0)
        #expect(recovered.filesReplayed == 1)
        #expect(recovered.filesRemaining == 0)
        #expect(recovered.batchesSent == 2)
        #expect(store.spooledEventCount == 0)
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.isEmpty)
    }

    /// Regression (round-15 P2): strikes count FAILED PASSES, not batches.
    /// Clearing the counter after every successful batch let a
    /// deterministically failing NON-first batch reset it each pass, so its
    /// leading batches were re-delivered forever and the file could never
    /// reach the quarantine threshold — a permanent head-of-line block.
    @Test("multi-batch file whose second batch always fails is quarantined exactly on the third pass")
    func strikesCountPerPassNotPerBatch() async {
        let dir = tempDir()
        // A large rotate window keeps BOTH appended batches in one file A.
        let seq = Seq()
        var cfg = config(maxSendFailuresPerFile: 3)
        cfg.rotateBytes = 10000
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )
        try? store.appendBatch(makeBatch(1))
        try? store.appendBatch(makeBatch(2))

        let poisoned: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            if batch.events.first?.monotonicNs == 2 {
                throw SendFailed()
            }
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // Passes 1-2: the leading batch re-delivers each pass (batchesSent
        // == 1) while the trailing deterministic failure accrues ONE strike
        // per pass. A per-batch reset mutant stays stuck at 1 strike forever.
        for pass in 1 ... 2 {
            let report = await store.replayOldestFirst(batchSender: poisoned)
            #expect(report.filesQuarantined == 0, "pass \(pass)")
            #expect(report.batchesSent == 1, "pass \(pass): leading batch should have been attempted")
            #expect(report.filesRemaining == 1)
            #expect(store.spooledEventCount == 2)
        }

        // Pass 3 reaches the threshold DESPITE the leading batch succeeding
        // every pass: successes never reset the mid-file counter.
        let third = await store.replayOldestFirst(batchSender: poisoned)
        #expect(third.filesQuarantined == 1)
        #expect(third.filesReplayed == 0)
        #expect(third.batchesSent == 1) // leading batch still attempted once this pass
        #expect(store.spooledEventCount == 0)

        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.count == 1)
        #expect(entries.filter { $0.hasPrefix("spool-") }.isEmpty)
    }

    @Test("an oversize batch is split per event instead of poisoning its file")
    func oversizeBatchSplitPerEvent() async throws {
        let dir = tempDir()
        // A huge rotate window keeps the multi-hundred-KiB line in one file.
        var cfg = SpoolStore.Config()
        cfg.rotateBytes = 16 * 1024 * 1024
        cfg.totalCapBytes = .max
        let seq = Seq()
        let store = SpoolStore(
            directory: dir,
            config: cfg,
            nowMs: { 1_700_000_000_000 },
            makeFileId: { seq.next() }
        )

        let filler = String(repeating: "x", count: 600_000)
        func fatEvent(_ marker: Int) -> ActivityEvent {
            ActivityEvent(
                id: Ulid.shared.next(),
                observedAt: 1_700_000_000_000,
                monotonicNs: Int64(marker),
                source: .input,
                app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
                window: nil,
                action: .typingActivity,
                target: nil,
                content: filler,
                contentPolicy: .metadataOnly,
                captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
            )
        }
        let oversized = EventBatch(
            protocolVersion: 1,
            messageId: Ulid.shared.next(),
            type: "event_batch",
            sentAt: 1_700_000_000_000,
            batchId: Ulid.shared.next(),
            events: [fatEvent(1), fatEvent(2)]
        )
        try store.appendBatch(oversized)
        let oversizedBytes = try JSONEncoder().encode(oversized).count
        #expect(oversizedBytes > FrameCodec.maxPayloadSize)
        actor Shapes {
            var shapes: [[Int64]] = []
            func record(_ batch: EventBatch) {
                shapes.append(batch.events.map { $0.monotonicNs ?? 0 })
            }
        }
        let sent = Shapes()
        let report = await store.replayOldestFirst { batch in
            await sent.record(batch)
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        let shapes = await sent.shapes
        #expect(shapes == [[1], [2]]) // split event-by-event, order kept
        #expect(report.batchesSent == 2)
        #expect(report.filesReplayed == 1)
        #expect(report.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
    }

    @Test("a single event too large for any frame is quarantined without daemon round-trips")
    func monsterSingleEventQuarantinedLocally() async throws {
        let dir = tempDir()
        let store = orderedStore(dir: dir, maxSendFailuresPerFile: 2)

        let monster = EventBatch(
            protocolVersion: 1,
            messageId: Ulid.shared.next(),
            type: "event_batch",
            sentAt: 1_700_000_000_000,
            batchId: Ulid.shared.next(),
            events: [
                ActivityEvent(
                    id: Ulid.shared.next(),
                    observedAt: 1_700_000_000_000,
                    monotonicNs: 1,
                    source: .input,
                    app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
                    window: nil,
                    action: .typingActivity,
                    target: nil,
                    content: String(repeating: "x", count: 1_200_000),
                    contentPolicy: .metadataOnly,
                    captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
                ),
            ]
        )
        try? store.appendBatch(monster)
        let monsterBytes = try JSONEncoder().encode(monster).count
        #expect(monsterBytes > FrameCodec.maxPayloadSize)
        actor Sends {
            var count = 0
            func bump() {
                count += 1
            }
        }
        let sends = Sends()
        let acking: @Sendable (EventBatch) async throws -> EventBatchAck = { batch in
            await sends.bump()
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack-\(batch.batchId)",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // The local wire-cap check poisons the file before anything is sent;
        // pass 1 blocks (below threshold), pass 2 quarantines.
        let first = await store.replayOldestFirst(batchSender: acking)
        #expect(await sends.count == 0)
        #expect(first.filesRemaining == 1)

        let second = await store.replayOldestFirst(batchSender: acking)
        #expect(await sends.count == 0) // never wasted a daemon round-trip
        #expect(second.filesQuarantined == 1)
        #expect(second.filesRemaining == 0)
        #expect(store.spooledEventCount == 0)
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(entries.filter { $0.hasPrefix("poison-") }.count == 1)
    }
}
