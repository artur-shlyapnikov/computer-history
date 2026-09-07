import Foundation
import os

/// Offline spool (spec §3.8): rotating JSONL files under a directory, bounded
/// by total size (drop oldest) and age (48h purge). Files are deleted ONLY
/// after every event id they contain was acknowledged by the daemon.
///
/// File format: one JSON-encoded `EventBatch` per line. A crash mid-append can
/// tear the last line; replay skips unparseable lines instead of failing.
///
/// Provenance note: initial draft by an external Codex/ChatGPT session,
/// reconciled into the M1 brief semantics by S1 (2026-08-23): replay deletes a
/// file only after an ACK covering ALL of its event ids (accepted + duplicates
/// + rejected), not merely after "send succeeded". Pre-reconcile snapshot:
/// /tmp/m1-swift-evidence/SpoolStore.foreign.1787441915.swift
///
/// Concurrency note (`@unchecked Sendable`): all mutable writer state and the
/// file index are guarded by `lock`. Replay runs under an in-flight flag so
/// two replays cannot interleave; appends during replay go to new files and
/// remain untouched until the next replay pass.
final class SpoolStore: @unchecked Sendable {
    struct Config: Sendable {
        /// Rotate when the current file reaches this size (~512 KiB).
        var rotateBytes: Int = 512 * 1024
        /// Hard total cap; oldest files are dropped beyond this (25 MiB).
        var totalCapBytes: Int64 = 25 * 1024 * 1024
        /// Files older than this are purged at startup/replay (48 h). The
        /// horizon mirrors the daemon's raw_events retention
        /// (rawRetentionHours = 48 in apps/daemon/src/config.ts): replaying
        /// an event older than the daemon's retention would insert it only
        /// for the next retention sweep to purge it.
        var maxAgeMs: Int64 = 48 * 60 * 60 * 1000
        /// Consecutive failed replay passes tolerated for one spool file
        /// before it is treated as deterministically poisoned (oversize
        /// frame, daemon error-frame rejection) and quarantined past the
        /// replay cursor instead of wedging every newer file until the
        /// 48 h purge.
        var maxSendFailuresPerFile: Int = 3
        /// Upper bound on quarantined ("poison-") files kept on disk;
        /// beyond it the oldest poison file is deleted.
        var maxQuarantinedFiles: Int = 32
        static let standard = Config()
    }

    struct ReplayReport: Equatable, Sendable {
        var filesReplayed = 0
        var batchesSent = 0
        var eventsAcked = 0
        var tornLinesSkipped = 0
        var filesRemaining = 0
        /// Files moved aside as deterministically undeliverable during
        /// this pass (see `Config.maxSendFailuresPerFile`).
        var filesQuarantined = 0
    }

    let directory: URL
    private let config: Config
    private let nowMs: @Sendable () -> Int64
    private let makeFileId: @Sendable () -> String
    /// Raw line-append strategy, injectable so tests can simulate a torn
    /// write (kernel copies a partial prefix, then ENOSPC-style failure).
    /// Everything around it — offset capture, truncate-on-failure — stays
    /// in production code, so tests exercise the shipped recovery path.
    private let performRawWrite: @Sendable (FileHandle, Data) throws -> Void
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()
    private let logger = Logger(subsystem: "com.computer-history.recorder", category: "capture")

    private let lock = NSLock()
    private var currentHandle: FileHandle?
    private var currentURL: URL?
    private var currentSize: Int64 = 0
    private var replaying = false
    /// Consecutive failed delivery attempts per spool file (see
    /// `Config.maxSendFailuresPerFile`); cleared on success or quarantine.
    private var sendFailuresLocked: [URL: Int] = [:]
    /// Incremental diagnostics counters (O(1) `spooledEventCount`): per-file
    /// parsed-event counts plus their running total, all under `lock`. Files
    /// found on disk at init are scanned once and seeded; afterwards every
    /// mutator (append / cap-drop / age-purge / replay-delete) adjusts the
    /// total in place instead of re-decoding the whole directory per query.
    private var fileEventCountsLocked: [URL: Int] = [:]
    private var spooledEventTotalLocked = 0
    /// Per-file byte sizes mirroring the event-count index. Seeded once at
    /// init and maintained by the same mutators, so the per-append cap check
    /// sums an in-memory dictionary instead of re-listing the directory and
    /// stat'ing every spool file while holding the lock.
    private var fileSizeIndexLocked: [URL: Int64] = [:]
    /// Process-lifetime creation sequence, stamped into every new spool
    /// filename (`spool-<epochMs>-<seq>-<id>.jsonl`, zero-padded). Wall-clock
    /// stamps alone reorder replay and mis-target eviction/purge after a
    /// backwards clock step; within one run the monotonic sequence keeps
    /// same-stamp files (and files written across a step inside a single
    /// stamp) strictly ordered by actual creation order.
    private var creationSequenceLocked = 0

    init(
        directory: URL,
        config: Config = .standard,
        nowMs: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        makeFileId: @escaping @Sendable () -> String = { Ulid.shared.next() },
        performRawWrite: @escaping @Sendable (FileHandle, Data) throws -> Void = { try $0.write(contentsOf: $1) }
    ) {
        self.directory = directory
        self.performRawWrite = performRawWrite
        self.config = config
        self.nowMs = nowMs
        self.makeFileId = makeFileId
        encoder = JSONEncoder()
        // SEC: spool files hold raw activity metadata — keep them private to
        // the user (dir 0700, files 0600). Intermediates get default perms;
        // only the spool dir itself is created with restricted attributes.
        try? FileManager.default.createDirectory(
            at: directory.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        // Startup purge (spec §3.8): expired files never replay.
        purgeExpiredLocked()
        // One-time scan of files left by a previous session so the
        // incremental counters start accurate; queries stay O(1) after this.
        for file in spooledFilesLocked {
            _ = trackedEventCountLocked(for: file)
            fileSizeIndexLocked[file] = fileSize(file)
        }
    }

    // MARK: - Append

    /// Crash-safe append: write the batch as one JSONL line and fsync it.
    func appendBatch(_ batch: EventBatch) throws {
        var line = try encoder.encode(batch)
        line.append(0x0A)

        lock.lock()
        defer { lock.unlock() }
        openWriterLockedIfNeeded(forLineOf: line.count)
        guard let handle = currentHandle else {
            throw CocoaError(.fileWriteUnknown)
        }
        // Torn-tail guard: capture the end-of-file offset BEFORE writing. If
        // the write fails mid-line (e.g. ENOSPC), the kernel may already have
        // copied a partial prefix; truncating back to the pre-write offset
        // guarantees a torn tail can never fuse with the NEXT appended line
        // into one undecodable JSONL entry (which replay would drop both of).
        let safeOffset = Int64(handle.seekToEndOfFile())
        do {
            try performRawWrite(handle, line)
            handle.synchronizeFile()
        } catch {
            try? handle.truncate(atOffset: UInt64(safeOffset))
            handle.synchronizeFile()
            currentSize = safeOffset
            if let url = currentURL {
                fileSizeIndexLocked[url] = safeOffset
            }
            throw error
        }
        currentSize += Int64(line.count)
        if let url = currentURL {
            let added = batch.events.count
            fileEventCountsLocked[url, default: 0] += added
            spooledEventTotalLocked += added
            fileSizeIndexLocked[url, default: 0] += Int64(line.count)
        }
        enforceCapLocked()
    }

    private func openWriterLockedIfNeeded(forLineOf lineBytes: Int) {
        let needsRotation = currentURL != nil && currentSize + Int64(lineBytes) > config.rotateBytes
        if currentURL == nil || needsRotation {
            closeWriterLocked()
            let url = directory.appendingPathComponent("spool-\(nowMs())-\(nextCreationSequence())-\(makeFileId()).jsonl")
            // SEC: raw activity metadata — user-private file mode.
            FileManager.default.createFile(
                atPath: url.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
            // Only adopt the URL once a real handle exists. A failed open
            // leaves currentURL nil so the next append retries creation
            // instead of throwing forever against a phantom writer.
            guard let handle = FileHandle(forWritingAtPath: url.path) else { return }
            currentHandle = handle
            currentURL = url
            currentSize = 0
            fileSizeIndexLocked[url] = 0
        }
    }

    private func closeWriterLocked() {
        try? currentHandle?.close()
        currentHandle = nil
        currentURL = nil
        currentSize = 0
    }

    /// Next zero-padded creation-sequence segment for a spool filename.
    /// Lock must be held.
    private func nextCreationSequence() -> String {
        creationSequenceLocked += 1
        return String(format: "%06d", creationSequenceLocked)
    }

    // MARK: - Caps and purges

    private var spooledFilesLocked: [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names
            .filter { $0.hasPrefix("spool-") && $0.hasSuffix(".jsonl") }
            .compactMap { directory.appendingPathComponent($0) }
    }

    /// Cap check over the in-memory size index: no directory listing or stat
    /// calls on the per-append path. Eviction order matches the on-disk
    /// listing semantics (filename timestamp, then name). Untracked files can
    /// only be zero-byte open-failure orphans, so they cannot change the
    /// total; age purge still lists the directory and removes them.
    private func enforceCapLocked() {
        while true {
            var total: Int64 = 0
            var oldest: (url: URL, key: SpoolSortKey)?
            for (file, bytes) in fileSizeIndexLocked {
                total += bytes
                let key = spoolSortKey(file)
                if let current = oldest, current.key < key {
                    continue
                }
                oldest = (file, key)
            }
            guard total > config.totalCapBytes, let victim = oldest?.url else { return }
            // Drop-oldest enforcement (spec §3.8). If the overflow is a single
            // freshly written file larger than the cap on its own, dropping it
            // still honors the cap — history loss beats unbounded disk growth.
            do {
                try FileManager.default.removeItem(at: victim)
            } catch {
                // A file deleted out-of-band (external cleanup) left a phantom
                // index entry: total never shrinks, so every later append would
                // evict a real pending file. ENOENT is self-healing — forget the
                // phantom and keep looping. Any other failure must NOT be
                // retried: the loop would spin forever holding the lock and
                // freeze capture. Stop, surface once; a later append re-runs
                // the check in case the transient cause cleared.
                if (error as NSError).code == NSFileNoSuchFileError {
                    dropTrackedFileLocked(victim)
                    continue
                }
                logger.error(
                    "spool cap: could not delete \(victim.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)"
                )
                return
            }
            dropTrackedFileLocked(victim)
            if currentURL == victim {
                closeWriterLocked()
            }
        }
    }

    /// Parsed event count of `file` (torn lines excluded), counting from disk
    /// at most once per file. Lock must be held.
    private func trackedEventCountLocked(for file: URL) -> Int {
        if let known = fileEventCountsLocked[file] {
            return known
        }
        let counted = countEventsOnDiskLocked(file)
        fileEventCountsLocked[file] = counted
        spooledEventTotalLocked += counted
        return counted
    }

    private func countEventsOnDiskLocked(_ file: URL) -> Int {
        guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return 0 }
        return raw.split(separator: "\n", omittingEmptySubsequences: true).reduce(0) {
            $0 + ((try? decoder.decode(EventBatch.self, from: Data($1.utf8)))?.events.count ?? 0)
        }
    }

    /// Forgets `file` and subtracts its tracked events from the total.
    /// Call AFTER a successful deletion. Lock must be held.
    @discardableResult
    private func dropTrackedFileLocked(_ file: URL) -> Int {
        let count = trackedEventCountLocked(for: file)
        fileEventCountsLocked[file] = nil
        fileSizeIndexLocked[file] = nil
        spooledEventTotalLocked -= count
        return count
    }

    /// Age purge keyed on BOTH the filename timestamp and the file
    /// modification time (clock-step belt); see `purgeExpiredLocked`.
    @discardableResult
    func purgeExpired() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return purgeExpiredLocked()
    }

    /// NSLock is unavailable from async contexts, so the replay in-flight
    /// flag is toggled through these synchronous helpers.
    private func beginReplay() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if replaying {
            return false
        }
        replaying = true
        return true
    }

    private func endReplay() {
        lock.lock()
        defer { lock.unlock() }
        replaying = false
    }

    /// Seals the open writer, purges expired files, and returns the sorted
    /// spool snapshot — all inside one critical section (see the call site
    /// in `replayOldestFirst` for why these must not be separate locks).
    private func beginReplaySnapshot() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        closeWriterLocked()
        _ = purgeExpiredLocked()
        return sortedSpoolFiles()
    }

    @discardableResult
    private func purgeExpiredLocked() -> Int {
        let cutoff = nowMs() - config.maxAgeMs
        var purged = 0
        for file in spooledFilesLocked {
            // Belt against clock steps: the embedded stamp alone is
            // attacker-of-last-resort (a backwards step stamps old-looking
            // names onto fresh files). Require the on-disk modification time
            // to agree before deleting; an unreadable mtime conservatively
            // keeps the file.
            guard fileTimestamp(file) < cutoff,
                  let modifiedMs = modificationTimeMs(file), modifiedMs < cutoff
            else { continue }
            do {
                try FileManager.default.removeItem(at: file)
            } catch {
                continue
            }
            if currentURL == file {
                closeWriterLocked()
            }
            dropTrackedFileLocked(file)
            purged += 1
        }
        return purged
    }

    /// File modification time in epoch milliseconds; nil when stat fails.
    private func modificationTimeMs(_ url: URL) -> Int64? {
        guard let date = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date else {
            return nil
        }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    private func fileTimestamp(_ url: URL) -> Int64 {
        let name = url.lastPathComponent
        let start = name.index(name.startIndex, offsetBy: "spool-".count)
        let stem = name[..<name.endIndex].dropLast(".jsonl".count)
        let stamp = stem[start...].prefix(while: \.isNumber)
        return Int64(stamp) ?? 0
    }

    private func fileSize(_ url: URL) -> Int64 {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64 ?? 0
    }

    // MARK: - Replay

    /// Replays spooled batches oldest-first through `batchSender`. A file is
    /// deleted only after an ACK covers ALL event ids it contains: the daemon
    /// reports accepted + duplicates + rejected, and only that sum reaching the
    /// file's event count proves every id reached a terminal state (spec §3.8
    /// / brief S1 item 5). An unambiguously transient failure (daemon down,
    /// protocol mismatch) or an under-covering ACK stops the replay; remaining
    /// files stay strictly ordered for the next reconnect. Any other failure
    /// counts against the file: after `Config.maxSendFailuresPerFile`
    /// consecutive failed passes the file is deterministically undeliverable
    /// (oversize frame, daemon error-frame rejection), so it is quarantined
    /// past the replay cursor and the queue advances instead of wedging until
    /// age purge. Redelivery is safe: raw_events.id is the primary key.
    ///
    /// The currently-open writer is sealed first: replaying (and deleting) a
    /// file that a live FileHandle is still appending to would send subsequent
    /// writes to an unlinked inode, silently losing them on crash.
    func replayOldestFirst(
        batchSender: @Sendable (EventBatch) async throws -> EventBatchAck
    ) async -> ReplayReport {
        guard beginReplay() else { return ReplayReport() }
        defer { endReplay() }

        // Atomic snapshot: sealing, purging, and listing happen in ONE
        // critical section. The old three-lock sequence had a window where a
        // concurrent appendBatch could create file Y between purgeExpired()
        // and the listing — Y entered the snapshot while its FileHandle was
        // still open, replay then acked+deleted it, and every later write
        // went to the unlinked inode (events silently lost, counters stuck).
        // After this fused section any concurrent append can only create a
        // brand-new file (closeWriterLocked resets the writer), so a listed
        // file is never the currently-open writer.
        let files = beginReplaySnapshot()
        var report = ReplayReport()
        outer: for file in files {
            var fileBatches: [EventBatch] = []
            do {
                // Per-LINE failable UTF-8 decode over raw bytes:
                // String(contentsOf:) THREW on a single torn multi-byte
                // sequence, and the catch below skipped the WHOLE file —
                // intact batches before the tear were never delivered
                // (permanent event loss masked as an unreadable file). A
                // newline byte can never sit inside a multi-byte UTF-8
                // sequence, so splitting on 0x0A stays correct in torn
                // bytes: only the torn LINE fails its decode (counted as
                // torn), intact lines still deliver.
                let data = try Data(contentsOf: file)
                func decodeLine(_ bytes: some Sequence<UInt8>) {
                    if let line = String(bytes: bytes, encoding: .utf8),
                       let batch = try? decoder.decode(EventBatch.self, from: Data(line.utf8))
                    {
                        fileBatches.append(batch)
                    } else {
                        report.tornLinesSkipped += 1
                    }
                }
                var start = data.startIndex
                while let newline = data[start...].firstIndex(of: 0x0A) {
                    decodeLine(data[start ..< newline])
                    start = data.index(after: newline)
                }
                // A trailing newline leaves an empty tail — not a torn line
                // (the old split(omittingEmptySubsequences: true) dropped it).
                if start < data.endIndex {
                    decodeLine(data[start...])
                }
            } catch {
                // Unreadable file (permissions, vanished mid-snapshot) counts
                // as fully torn; skip it.
                continue
            }

            switch await deliverFile(
                file,
                batches: fileBatches,
                batchSender: batchSender,
                report: &report
            ) {
            case let .fullyAcked(ackedEvents):
                let removed = (try? FileManager.default.removeItem(at: file)) != nil
                lock.withLock {
                    if removed {
                        _ = dropTrackedFileLocked(file)
                        sendFailuresLocked[file] = nil
                    }
                }
                report.filesReplayed += 1
                report.eventsAcked += ackedEvents
            case .blocked:
                // Stop at the first blocked file; everything after it stays
                // strictly ordered behind it.
                break outer
            case .quarantined:
                report.filesQuarantined += 1
            }
        }
        report.filesRemaining = sortedSpoolFiles().count
        return report
    }

    /// Outcome of attempting to deliver one spool file.
    private enum FileReplayOutcome {
        /// Every event id reached a terminal ACK state; delete the file.
        case fullyAcked(ackedEvents: Int)
        /// Keep the file and stop the replay; later files stay strictly
        /// ordered behind it for the next reconnect.
        case blocked
        /// The file is deterministically undeliverable; it was moved past
        /// the replay cursor and the queue advances.
        case quarantined
    }

    /// Delivers every decoded batch of `file` oldest-first. A batch whose
    /// encoded frame fits the 1 MiB wire cap (`FrameCodec.maxPayloadSize`)
    /// goes whole; an oversize batch is split per event so one poisoned batch
    /// can never wedge every newer spooled file behind its own.
    ///
    /// Strike counting is per PASS: successes from earlier batches in this
    /// file do NOT reset the counter — only a fully-acked delivery (which
    /// deletes the file) or quarantine clears it. Resetting per batch lets a
    /// deterministically failing non-first batch re-deliver its leading
    /// batches forever, a permanent head-of-line block.
    private func deliverFile(
        _ file: URL,
        batches: [EventBatch],
        batchSender: @Sendable (EventBatch) async throws -> EventBatchAck,
        report: inout ReplayReport
    ) async -> FileReplayOutcome {
        var ackedEvents = 0
        var fullyAcked = true

        for batch in batches {
            if encodedWireSize(batch) <= FrameCodec.maxPayloadSize {
                do {
                    let ack = try await batchSender(batch)
                    let accounted = ack.accepted + ack.duplicates + ack.rejected
                    ackedEvents += accounted
                    if accounted < batch.events.count {
                        fullyAcked = false
                    }
                    report.batchesSent += 1
                    continue
                } catch {
                    return classifySendFailure(error, file: file)
                }
            }

            // Oversize: resend event-by-event. Each single-event batch gets
            // fresh ids; redelivery stays safe (raw_events.id primary key).
            for event in batch.events {
                let single = EventBatch(
                    protocolVersion: batch.protocolVersion,
                    messageId: Ulid.shared.next(),
                    type: batch.type,
                    sentAt: batch.sentAt,
                    batchId: Ulid.shared.next(),
                    events: [event]
                )
                guard encodedWireSize(single) <= FrameCodec.maxPayloadSize else {
                    // One event alone exceeds any frame: permanently poisoned.
                    return classifySendFailure(
                        FrameError.payloadTooLarge(encodedWireSize(single)),
                        file: file
                    )
                }
                do {
                    let ack = try await batchSender(single)
                    let accounted = ack.accepted + ack.duplicates + ack.rejected
                    ackedEvents += accounted
                    if accounted < 1 {
                        fullyAcked = false
                    }
                    report.batchesSent += 1
                } catch {
                    return classifySendFailure(error, file: file)
                }
            }
        }
        return fullyAcked ? .fullyAcked(ackedEvents: ackedEvents) : .blocked
    }

    /// Encoded size of the JSON payload a whole-batch frame would carry.
    /// Decode already succeeded, so encode cannot fail in practice; Int.max
    /// on the impossible path conservatively forces the split branch.
    private func encodedWireSize(_ batch: EventBatch) -> Int {
        (try? encoder.encode(batch))?.count ?? Int.max
    }

    /// Decides what a failed delivery means. Unambiguously environmental
    /// errors (daemon down, protocol version mismatch, transport-level write
    /// failure) block WITHOUT penalty:
    /// the data is healthy and must simply wait for the next reconnect.
    /// Anything else may be a deterministically poisoned batch; after
    /// `Config.maxSendFailuresPerFile` consecutive failed passes the file is
    /// quarantined so the queue advances.
    private func classifySendFailure(_ error: Error, file: URL) -> FileReplayOutcome {
        if let clientError = error as? DaemonClientError {
            switch clientError {
            case .notConnected, .connectFailed, .protocolVersionMismatch, .replyTimedOut,
                 .transportWriteFailed:
                // Environmental: teardown, version mismatch, or a transport-
                // level socket-write failure (EAGAIN from SO_SNDTIMEO, EPIPE,
                // ETIMEDOUT...) — the data is healthy and waits for the next
                // delivery window. Never poison evidence: a wedged-but-alive
                // daemon must not quarantine the healthy spool behind it.
                return .blocked
            case .handshakeFailed, .badFrame:
                break
            }
        }
        let failures = recordSendFailure(file)
        let threshold = config.maxSendFailuresPerFile
        let detail: String
        let message: String
        if failures < threshold {
            detail = "delivery failed (\(failures)/\(threshold)) for \(file.lastPathComponent): \(error.localizedDescription)"
            message = "blocked"
        } else {
            guard quarantine(file) else { return .blocked }
            detail = "quarantined \(file.lastPathComponent) after \(failures) failed deliveries: \(error.localizedDescription)"
            message = "quarantined"
        }
        logger.error("spool replay: \(message, privacy: .public) - \(detail, privacy: .public)")
        return failures < threshold ? .blocked : .quarantined
    }

    private func recordSendFailure(_ file: URL) -> Int {
        lock.withLock {
            let failures = (sendFailuresLocked[file] ?? 0) + 1
            sendFailuresLocked[file] = failures
            return failures
        }
    }

    private func clearSendFailures(_ file: URL) {
        lock.withLock { sendFailuresLocked[file] = nil }
    }

    /// Renames `file` past the replay cursor: the `poison-` prefix is excluded
    /// from every spool listing, so quarantined bytes never replay and never
    /// count toward the size cap. At most `Config.maxQuarantinedFiles` poison
    /// files are kept (oldest dropped first). Returns false when the rename
    /// failed; the caller then treats the file as merely blocked.
    private func quarantine(_ file: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let fm = FileManager.default
        var poisonNames = ((try? fm.contentsOfDirectory(atPath: directory.path)) ?? [])
            .filter { $0.hasPrefix("poison-") && $0.hasSuffix(".jsonl") }
            .sorted()
        while poisonNames.count >= config.maxQuarantinedFiles, let oldest = poisonNames.first {
            try? fm.removeItem(at: directory.appendingPathComponent(oldest))
            poisonNames.removeFirst()
        }
        let destination = directory.appendingPathComponent("poison-\(file.lastPathComponent)")
        try? fm.removeItem(at: destination)
        guard (try? fm.moveItem(at: file, to: destination)) != nil else { return false }
        _ = dropTrackedFileLocked(file)
        sendFailuresLocked[file] = nil
        return true
    }

    /// Numeric creation-sequence segment of a current-format spool filename
    /// (`spool-<epochMs>-<seq>-<id>.jsonl`); nil for anything else — legacy
    /// two-segment names (`spool-<ms>-<id>.jsonl`) written before sequences
    /// existed, and junk names (timestamp 0, see `fileTimestamp`). Legacy
    /// files predate the upgrade, so at an equal stamp they sort FIRST.
    private func creationSequence(_ url: URL) -> Int? {
        let name = url.lastPathComponent
        guard name.hasPrefix("spool-"), name.hasSuffix(".jsonl") else { return nil }
        let parts = name.dropFirst("spool-".count).dropLast(".jsonl".count)
            .split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[1].allSatisfy(\.isNumber),
              let seq = Int(parts[1])
        else { return nil }
        return seq
    }

    /// Ordering key shared by replay sort and cap eviction: embedded stamp,
    /// then creation sequence, then name. Legacy seq-less names encode as
    /// Int.min so they sort first at an equal stamp (they predate the
    /// upgrade). PERF-08: keys are computed once per file and compared as
    /// values — the previous isOlder comparator re-parsed both filenames
    /// (stamp + sequence) on every comparison, O(n log n) parses per replay
    /// sort and O(n) reparses per candidate in every cap-eviction pass.
    /// A struct, not a tuple: swiftlint forbids >2-member tuples.
    private struct SpoolSortKey: Comparable {
        let stamp: Int64
        let sequence: Int
        let name: String

        static func < (lhs: Self, rhs: Self) -> Bool {
            if lhs.stamp != rhs.stamp {
                return lhs.stamp < rhs.stamp
            }
            if lhs.sequence != rhs.sequence {
                return lhs.sequence < rhs.sequence
            }
            return lhs.name < rhs.name
        }
    }

    private func spoolSortKey(_ url: URL) -> SpoolSortKey {
        SpoolSortKey(
            stamp: fileTimestamp(url),
            sequence: creationSequence(url) ?? Int.min,
            name: url.lastPathComponent
        )
    }

    private func sortedSpoolFiles() -> [URL] {
        spooledFilesLocked
            .map { (url: $0, key: spoolSortKey($0)) }
            .sorted { $0.key < $1.key }
            .map(\.url)
    }

    /// Number of distinct spooled event ids across all files (diagnostics/UI).
    /// O(1): maintained incrementally by the append/cap/purge/replay mutators.
    var spooledEventCount: Int {
        lock.withLock { spooledEventTotalLocked }
    }
}
