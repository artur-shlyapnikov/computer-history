import Foundation
import os

/// Batches filtered events and hands them to the daemon (spec §3.4):
/// flush every 500 ms or at 100 events, whichever comes first. On a send
/// failure the whole batch is persisted to the SpoolStore so nothing is lost.
///
/// The flush timer is injectable (`sleep`) for deterministic tests: the real
/// clock sleeps via `Task.sleep`, tests release ticks manually.
actor EventBuffer {
    struct Stats: Equatable, Sendable {
        var appendedEvents = 0
        var liveBatchesSent = 0
        var spooledBatches = 0
        /// Batches lost because BOTH spool attempts failed (never counted as
        /// spooled). Surfaced via os.Logger at error level.
        var spoolFailures = 0
        var timerFlushes = 0
        var countFlushes = 0
    }

    /// Sends one batch to the daemon. Throws on any failure (transport,
    /// handshake loss, error response) → caller spools the batch.
    typealias BatchSender = @Sendable (EventBatch) async throws -> Void

    static let flushIntervalMs: Int64 = 500
    static let flushEventCount = 100

    private let sender: BatchSender
    private let spool: SpoolStore
    private let maxEvents: Int
    private let logger = Logger(subsystem: "com.computer-history.recorder", category: "capture")
    private let flushIntervalMs: Int64
    private let sleep: @Sendable (Int64) async throws -> Void
    private let makeBatchId: @Sendable () -> String

    private var pending: [ActivityEvent] = []
    private var loopTask: Task<Void, Never>?
    private(set) var stats = Stats()

    init(
        sender: @escaping BatchSender,
        spool: SpoolStore,
        maxEvents: Int = EventBuffer.flushEventCount,
        flushIntervalMs: Int64 = EventBuffer.flushIntervalMs,
        sleep: @escaping @Sendable (Int64) async throws -> Void = { ms in
            try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        },
        makeBatchId: @escaping @Sendable () -> String = { Ulid.shared.next() }
    ) {
        self.sender = sender
        self.spool = spool
        self.maxEvents = maxEvents
        self.flushIntervalMs = flushIntervalMs
        self.sleep = sleep
        self.makeBatchId = makeBatchId
    }

    // MARK: - Lifecycle

    /// Starts the timer-driven flush loop.
    func start() {
        guard loopTask == nil else { return }
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await sleep(flushIntervalMs)
                } catch {
                    return // cancelled
                }
                await flush(reason: .timer)
            }
        }
    }

    /// Cancels the timer loop and flushes whatever remains (suspend/shutdown).
    func shutdown() async {
        loopTask?.cancel()
        loopTask = nil
        await flush(reason: .shutdown)
    }

    // MARK: - Ingest

    /// Appends a filtered event; flushes immediately at the count threshold.
    func append(_ event: ActivityEvent) async {
        stats.appendedEvents += 1
        pending.append(event)
        if pending.count >= maxEvents {
            await flush(reason: .count)
        }
    }

    var pendingCount: Int {
        pending.count
    }

    enum FlushReason {
        case timer, count, shutdown
    }

    /// Drains the pending queue: live-send through the daemon, or spool the
    /// whole batch on failure. Events are never dropped silently.
    func flush(reason: FlushReason) async {
        guard !pending.isEmpty else { return }
        let batchEvents = pending
        pending.removeAll(keepingCapacity: false)

        let batch = EventBatch(
            protocolVersion: protocolVersion,
            messageId: makeBatchId(),
            type: "event_batch",
            sentAt: Int64(Date().timeIntervalSince1970 * 1000),
            batchId: makeBatchId(),
            events: batchEvents
        )

        do {
            try await sender(batch)
            stats.liveBatchesSent += 1
        } catch {
            // Spool with ONE retry for transient write errors. Only a batch
            // that lands in the spool counts as spooled; if the second
            // attempt also fails the batch is genuinely undeliverable —
            // count it and log (metadata only, never content).
            do {
                try spool.appendBatch(batch)
                stats.spooledBatches += 1
            } catch {
                do {
                    try spool.appendBatch(batch)
                    stats.spooledBatches += 1
                } catch {
                    stats.spoolFailures += 1
                    logger.error(
                        "spool write failed after retry; dropping \(batch.events.count, privacy: .public) events"
                    )
                }
            }
        }
        switch reason {
        case .timer: stats.timerFlushes += 1
        case .count: stats.countFlushes += 1
        case .shutdown: break
        }
    }
}
