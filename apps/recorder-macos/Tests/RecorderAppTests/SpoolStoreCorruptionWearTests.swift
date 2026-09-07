import Foundation
@testable import RecorderApp
import Testing

/// SpoolStore corruption/wear partitions (design round-3 §P2-6): the
/// FINAL-line tear and the fused replay snapshot are covered by
/// SpoolStoreTests; here the remaining resilience partitions are pinned —
/// mid-file garbage lines, unreadable files, foreign filenames, junk
/// filename timestamps, the strict rotation boundary, and equal-timestamp
/// tie-breaking.
///
/// Fixtures: cloned tempDir/Seq/makeBatch helpers; JSONL files are
/// hand-written into the spool directory for corruption shapes (precedent:
/// SpoolStoreTests.tornLineSkipped). Clocks and file ids are injected.
struct SpoolStoreCorruptionWearTests {
    /// Deterministic file ids so filename-sorted order equals creation order.
    private final class Seq: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func next() -> String {
            lock.withLock {
                n += 1
                return String(n)
            }
        }
    }

    private static let baseTimeMs: Int64 = 1_700_000_000_000

    private func makeBatch(_ marker: Int) -> EventBatch {
        EventBatch(
            protocolVersion: 1,
            messageId: "msg-\(marker)",
            type: "event_batch",
            sentAt: Self.baseTimeMs,
            batchId: "batch-\(marker)",
            events: [ActivityEvent(
                id: "01ARZ3NDEKTSV4RRFFQ69G5F\(marker)",
                observedAt: Self.baseTimeMs,
                monotonicNs: Int64(marker),
                source: .input,
                app: AppInfo(bundleId: "com.example.app", name: nil, pid: 1),
                window: nil,
                action: .typingActivity,
                target: nil,
                content: nil,
                contentPolicy: .metadataOnly,
                captureSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV"
            )]
        )
    }

    /// One JSONL line exactly as appendBatch writes it: JSON + newline.
    private static func encodedLine(_ batch: EventBatch) throws -> String {
        var data = try JSONEncoder().encode(batch)
        data.append(0x0A)
        return String(bytes: data, encoding: .utf8) ?? ""
    }

    /// Sendable collector for markers recorded inside @Sendable senders.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func record(_ value: String) {
            lock.withLock { values.append(value) }
        }

        var snapshot: [String] {
            lock.withLock { values }
        }
    }

    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("spool-wear-tests-\(UUID().uuidString)")
    }

    private func makeStore(dir: URL, now: Int64 = Self.baseTimeMs) -> SpoolStore {
        let seq = Seq()
        var config = SpoolStore.Config()
        config.rotateBytes = 512 * 1024
        config.totalCapBytes = .max
        return SpoolStore(directory: dir, config: config, nowMs: { now }, makeFileId: { seq.next() })
    }

    private func spoolFiles(in dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
    }

    @Test("a garbage line in the MIDDLE of a file loses only itself")
    func midFileGarbageSkipsOnlyThatLine() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = makeStore(dir: dir)

        try store.appendBatch(makeBatch(1))
        try store.appendBatch(makeBatch(2))
        try store.appendBatch(makeBatch(3))
        store.purgeExpired()

        // Splice a garbage line between batch 2's line and batch 3's line.
        let files = spoolFiles(in: dir)
        #expect(files.count == 1)
        let path = dir.appendingPathComponent(files[0])
        let raw = try String(contentsOf: path, encoding: .utf8)
        var lines = raw.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        lines.insert("{not json", at: 1)
        try lines.joined(separator: "\n").write(to: path, atomically: true, encoding: .utf8)

        let sent = Recorder()
        let report = await store.replayOldestFirst { batch in
            sent.record(batch.batchId)
            return EventBatchAck(
                protocolVersion: 1,
                messageId: "ack",
                type: "event_batch_ack",
                sentAt: 0,
                batchId: batch.batchId,
                accepted: batch.events.count,
                duplicates: 0,
                rejected: 0
            )
        }

        // BOTH valid batches survive, in order — a mid-file `break` would
        // drop everything after the garbage line.
        #expect(sent.snapshot == ["batch-1", "batch-2", "batch-3"])
        #expect(report.batchesSent == 3)
        #expect(report.tornLinesSkipped == 1)
        #expect(report.filesRemaining == 0) // fully acked → deleted
    }

    @Test("an unreadable oldest file neither blocks later files nor aborts the pass")
    func unreadableFileDoesNotBlockReplay() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let healthy = makeStore(dir: dir)
        try healthy.appendBatch(makeBatch(9))
        healthy.purgeExpired()

        // Hand-place an OLDER, unreadable file.
        let oldURL = dir.appendingPathComponent("spool-\(Self.baseTimeMs - 1000)-aaa.jsonl")
        FileManager.default.createFile(atPath: oldURL.path, contents: Data("junk".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: oldURL.path)

        let report = await healthy.replayOldestFirst { batch in
            EventBatchAck(
                protocolVersion: 1, messageId: "ack", type: "event_batch_ack", sentAt: 0,
                batchId: batch.batchId, accepted: batch.events.count, duplicates: 0, rejected: 0
            )
        }

        #expect(report.batchesSent == 1)
        #expect(report.filesRemaining == 1) // only the unreadable file remains
        #expect(report.tornLinesSkipped == 0) // unreadable ≠ torn lines

        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: oldURL.path)
    }

    @Test("foreign filenames and directories are ignored by prefix+suffix filter")
    func foreignEntriesAreIgnored() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        try Data("not a spool".utf8).write(to: dir.appendingPathComponent("notes.txt"))
        try Data("not a spool".utf8).write(to: dir.appendingPathComponent("spool-123.jsonl.bak"))

        let store = makeStore(dir: dir)

        let sent = Recorder()
        _ = await store.replayOldestFirst { batch in
            sent.record(batch.batchId)
            return EventBatchAck(
                protocolVersion: 1, messageId: "ack", type: "event_batch_ack", sentAt: 0,
                batchId: "x", accepted: 0, duplicates: 0, rejected: 0
            )
        }

        #expect(sent.snapshot.isEmpty)
        #expect(spoolFiles(in: dir) == ["notes.txt", "spool-123.jsonl.bak"])
    }

    @Test("a junk filename parses as timestamp 0 and purges on an aged clock")
    func junkTimestampPurgesWhenAged() {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: dir.appendingPathComponent("spool-notanumber.jsonl").path,
            contents: Data("{}\n".utf8)
        )

        // nowMs far beyond maxAgeMs: parsed-as-0 ⇒ older than cutoff ⇒ gone.
        // The round-30 purge belt also requires an old mtime (clock-step
        // guard), so backdate the freshly created file to the epoch.
        try? FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 0)],
            ofItemAtPath: dir.appendingPathComponent("spool-notanumber.jsonl").path
        )
        _ = makeStore(dir: dir, now: Self.baseTimeMs)

        #expect(spoolFiles(in: dir).isEmpty)
    }

    @Test("on a fresh clock a junk-named file still replays if decodable")
    func junkNamedFileStillReplaysOnFreshClock() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Timestamp 0 sorts FIRST (ascending), not last — either way it is
        // listed and its decodable lines still replay: the filename stamp
        // orders/purges but never blacklists.
        let url = dir.appendingPathComponent("spool-notanumber.jsonl")
        try (JSONEncoder().encode(makeBatch(5)) + Data("\n".utf8)).write(to: url)

        let store = makeStore(dir: dir, now: 10000) // cutoff negative → no purge

        let sent = Recorder()
        let report = await store.replayOldestFirst { batch in
            sent.record(batch.batchId)
            return EventBatchAck(
                protocolVersion: 1, messageId: "ack", type: "event_batch_ack", sentAt: 0,
                batchId: batch.batchId, accepted: batch.events.count, duplicates: 0, rejected: 0
            )
        }

        #expect(sent.snapshot == ["batch-5"])
        #expect(report.batchesSent == 1)
        #expect(report.filesRemaining == 0)
    }

    @Test("rotation fires only when currentSize + lineBytes STRICTLY exceeds rotateBytes")
    func rotationBoundaryIsStrict() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let batchA = makeBatch(1)
        let batchB = makeBatch(2)
        let batchC = makeBatch(3)
        let lineA = try Self.encodedLine(batchA)
        let lineB = try Self.encodedLine(batchB)
        let lineC = try Self.encodedLine(batchC)

        let seq = Seq()
        var config = SpoolStore.Config()
        config.rotateBytes = lineA.count + lineB.count // EXACT boundary
        config.totalCapBytes = .max
        let store = SpoolStore(
            directory: dir,
            config: config,
            nowMs: { Self.baseTimeMs },
            makeFileId: { seq.next() }
        )

        try store.appendBatch(batchA)
        try store.appendBatch(batchB)
        // Equality does NOT rotate: needsRotation is a strict `>` (:138).
        #expect(spoolFiles(in: dir).count == 1)

        try store.appendBatch(batchC)
        // lenA+lenB+lenC > rotateBytes → B... C lands in a second file.
        #expect(spoolFiles(in: dir).count == 2)
        _ = lineC
    }

    @Test("equal parsed timestamps tie-break by lastPathComponent ascending")
    func equalTimestampsTieBreakByName() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let stamp: Int64 = 7000
        let first = dir.appendingPathComponent("spool-\(stamp)-aaa.jsonl")
        let second = dir.appendingPathComponent("spool-\(stamp)-bbb.jsonl")
        try (JSONEncoder().encode(makeBatch(1)) + Data("\n".utf8)).write(to: first)
        try (JSONEncoder().encode(makeBatch(2)) + Data("\n".utf8)).write(to: second)

        // Clock must be near the stamped time or init's age purge eats the
        // files before replay sees them.
        let store = makeStore(dir: dir, now: 8000)
        let orderList = Recorder()
        _ = await store.replayOldestFirst { batch in
            orderList.record(batch.batchId)
            return EventBatchAck(
                protocolVersion: 1, messageId: "ack", type: "event_batch_ack", sentAt: 0,
                batchId: batch.batchId, accepted: batch.events.count, duplicates: 0, rejected: 0
            )
        }
        #expect(orderList.snapshot == ["batch-1", "batch-2"]) // aaa before bbb (:381–384)
    }
}
