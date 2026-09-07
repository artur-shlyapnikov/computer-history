import Foundation

/// Errors surfaced by DaemonClient.
enum DaemonClientError: Error, Equatable {
    case notConnected
    case connectFailed(String)
    case handshakeFailed(String)
    case protocolVersionMismatch(offered: Int, expected: Int)
    case badFrame(String)
    /// A registered waiter (request or event batch) outlived its reply
    /// deadline against a silent-but-open peer; the connection itself may
    /// still be alive (unlike `notConnected`, which implies teardown).
    case replyTimedOut(String)
    /// Transport-level socket write failure from `sendAll` (EAGAIN after
    /// SO_SNDTIMEO, EPIPE, ECONNRESET...): connection-fatal, because a
    /// failed send may have consumed a prefix of the frame and the u32BE
    /// wire framing can never resync. NEVER thrown for a daemon rejection
    /// frame — those arrive as parsed `error` responses.
    case transportWriteFailed(String)
}

/**
 * Framed unix-socket IPC client.
 *
 * Transport note (deviation from the original NWConnection plan): the sandboxed
 * environments this skeleton must build and smoke-test in do not reliably deliver
 * Network.framework state changes for AF_UNIX endpoints (observed ENETDOWN and
 * silently missing .ready callbacks), so the transport uses plain POSIX sockets.
 * Everything above the byte stream — u32BE framing, the version-1 handshake,
 * requestId-matched responses, server-event subscription — follows contracts
 * §Protocol v1 unchanged and is covered by live-socket tests.
 *
 * Concurrency note (`@unchecked Sendable`): all mutable state is guarded by
 * `stateLock`. The blocking receive loop runs on a dedicated serial queue and
 * resumes pending continuations under the same lock; ALL outbound writes
 * (requests and event batches) are serialized on a dedicated writer queue so
 * no cooperative-pool thread ever blocks on socket I/O.
 */
final class DaemonClient: @unchecked Sendable {
    private let stateLock = NSLock()
    private var fd: Int32 = -1
    private var negotiatedHello: ServerHello?
    private var receiveBuffer = Data()
    private var eventHandler: (@Sendable (DaemonEvent) -> Void)?
    private var pendingResponses: [String: CheckedContinuation<ResponseFrame, Error>] = [:]
    /// Awaiting `event_batch` acks, keyed by batchId (spec §3.4).
    private var pendingBatches: [String: PendingBatch] = [:]

    /// Wire deadlines (round 14, missing-IPC-deadlines fix). Budgets align
    /// with the codebase's existing watchdogs: the socket send timeout matches
    /// ComputerHistoryApp.teardownTimeout (SW5-03, 2 s — quit must never wait
    /// longer on a wedged send), and the per-request/batch reply deadline sits
    /// well under AppState's chat turn watchdog (120 s) so a silent-but-open
    /// daemon resolves waiters long before any higher-level watchdog fires.
    static let socketSendTimeout: TimeInterval = 2
    /// Handshake round-trip budget: hello reply is a local daemon read; 5 s
    /// is generous yet bounded. Expiry surfaces as `handshakeFailed` and thus
    /// drives RecorderCoordinator's existing retry loop.
    static let defaultHandshakeTimeout: TimeInterval = 5
    /// Per-request / per-batch pending-reply budget. All pinned ops are
    /// fast local queries/inserts; a live daemon answers in milliseconds.
    static let defaultReplyTimeout: TimeInterval = 10

    /// Serializes ALL outbound frame encode + blocking `send()` work off the
    /// caller's executor — request frames (SW5-04a) and event batches alike —
    /// so a wedged-but-alive daemon (full receive buffer, untimed blocking
    /// send) pins this queue's dedicated thread instead of one cooperative-
    /// pool thread per caller. Serial execution keeps strict per-connection
    /// write ordering intact. Injectable so tests can gate the writer.
    private let writerQueue: DispatchQueue
    private let handshakeTimeout: TimeInterval
    private let replyTimeout: TimeInterval

    init(
        writerQueue: DispatchQueue = DispatchQueue(
            label: "computer-history.daemon-client.write"
        ),
        handshakeTimeout: TimeInterval = DaemonClient.defaultHandshakeTimeout,
        replyTimeout: TimeInterval = DaemonClient.defaultReplyTimeout
    ) {
        self.writerQueue = writerQueue
        self.handshakeTimeout = handshakeTimeout
        self.replyTimeout = replyTimeout
    }

    /// Bumped on every adoptSocket/disconnect. fd numbers are reused by the
    /// OS, so a sender that captured `sock` before a teardown+reconnect cannot
    /// detect ABA by value alone; the generation makes the swap observable.
    private var connectionGeneration = 0

    var onDisconnect: (@Sendable () -> Void)?

    private struct PendingBatch {
        let messageId: String
        let continuation: CheckedContinuation<EventBatchAck, Error>
    }

    func setEventHandler(_ handler: @escaping @Sendable (DaemonEvent) -> Void) {
        stateLock.lock()
        defer { stateLock.unlock() }
        eventHandler = handler
    }

    // MARK: - Connection

    /// Connects to the daemon socket and completes the version-1 handshake.
    /// On success the socket descriptor moves into client state and stays open
    /// until disconnect() or a peer close; on failure it is closed here.
    func connectAndHandshake(socketPath: String, appVersion: String) async throws -> ServerHello {
        disconnect()

        let sock = try Self.openUnixSocket(path: socketPath)
        do {
            let hello = ClientHello.make(appVersion: appVersion)
            try sendAll(sock, payload: FrameCodec.encode(hello))

            let reply: Data
            switch Self.readFramedWithDeadline(fd: sock, timeout: handshakeTimeout) {
            case let .payload(data):
                reply = data
            case .timedOut:
                // A daemon that accepts but never says hello must land in the
                // SAME typed failure path as any other handshake failure, so
                // RecorderCoordinator's retry loop (reconnecting → backoff)
                // engages instead of the call blocking forever.
                throw DaemonClientError.handshakeFailed(
                    "handshake timed out after \(Int(handshakeTimeout))s waiting for server_hello"
                )
            case .closed:
                throw DaemonClientError.handshakeFailed("connection closed during handshake")
            }
            let serverHello = try parseHandshakeReply(reply)

            adoptSocket(sock, hello: serverHello, closeDisplaced: true)
            startReceiveLoop(sock)
            return serverHello
        } catch {
            close(sock)
            throw error
        }
    }

    func disconnect() {
        stateLock.lock()
        let closing = fd
        fd = -1
        negotiatedHello = nil
        connectionGeneration += 1
        let pending = pendingResponses
        let batches = pendingBatches.values
        pendingResponses.removeAll()
        pendingBatches.removeAll()
        stateLock.unlock()

        if closing >= 0 {
            shutdown(closing, SHUT_RDWR)
            close(closing)
        }
        for continuation in pending.values {
            continuation.resume(throwing: DaemonClientError.notConnected)
        }
        for batch in batches {
            batch.continuation.resume(throwing: DaemonClientError.notConnected)
        }
    }

    var isConnectedToDaemon: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return negotiatedHello != nil && fd >= 0
    }

    var activeServerHello: ServerHello? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return negotiatedHello
    }

    func setEventSubscription(_ handler: @escaping @Sendable (DaemonEvent) -> Void) {
        setEventHandler(handler)
    }

    // MARK: - Requests

    /// Sends a request frame and awaits the matching response frame. The
    /// continuation is registered before the frame goes out so a fast reply can
    /// never race past its waiter.
    ///
    /// GateM0 finding 2 fix: the socket handle is captured exactly ONCE under a
    /// single lock acquisition and BOTH the registration and the send target
    /// that same handle. A concurrent reconnect swapping `fd` mid-call can no
    /// longer split register/send across two different sockets (the old code
    /// called `currentSocket()` twice).
    ///
    /// SW5-04a fix: the frame encode and blocking write run on the same
    /// dedicated serial writer queue sendBatch uses, so a wedged-but-alive
    /// daemon blocks that queue's thread — never the calling task's
    /// cooperative-pool thread (previously every timeline tick leaked one
    /// pinned pool thread plus an orphaned pending entry). Write errors and
    /// the reconnect ABA race surface through the same pending-request
    /// failure paths as before.
    func request(op: String, params: JSONValue?) async throws -> ResponseFrame {
        try await withCheckedThrowingContinuation { continuation in
            let frame = RequestFrame.make(op: op, requestId: Ulid.shared.next(), params: params)

            stateLock.lock()
            let sock = fd
            let generation = connectionGeneration
            guard sock >= 0, negotiatedHello != nil else {
                stateLock.unlock()
                continuation.resume(throwing: DaemonClientError.notConnected)
                return
            }
            pendingResponses[frame.requestId] = continuation
            stateLock.unlock()

            // Reply deadline: a silent-but-open daemon (accepted bytes, never
            // responds) must not pin this waiter — nor timelineRefreshInFlight —
            // forever. The timer removes the entry through the same map-mutation
            // path as every other failure; a late response finds nothing to route.
            armReplyTimeout(requestId: frame.requestId, generation: generation)

            writerQueue.async { [weak self] in
                guard let self else { return }
                // Generation check BEFORE the send (round 31): a stale block
                // queued before teardown must not write its frame onto a
                // REUSED descriptor of the new connection — the daemon would
                // see a phantom frame on the fresh stream. On the serial
                // writer queue this check-then-send is atomic against every
                // other send; only the caller-side reconnect can still race
                // it mid-write, which the post-send guard below covers.
                if currentConnectionGeneration() != generation {
                    if let pending = removePending(requestId: frame.requestId) {
                        pending.resume(throwing: DaemonClientError.notConnected)
                    }
                    return
                }
                do {
                    try sendAll(sock, payload: FrameCodec.encode(frame))
                } catch {
                    // Transport write failure (EAGAIN from SO_SNDTIMEO,
                    // EPIPE, ...): the kernel may have consumed a prefix of
                    // the frame before the failure, so the wire framing can
                    // never resync. Connection-fatal: run the same teardown
                    // as the receive-side paths so isConnectedToDaemon goes
                    // false and RecorderCoordinator rebuilds a clean stream.
                    // failAllPending inside the teardown settles THIS waiter
                    // with `transportWriteFailed` (spool fallback's typed
                    // environmental error) plus every concurrent one.
                    teardownConnection(sock, failingWith: error)
                    return
                }
                if currentConnectionGeneration() != generation {
                    // Residual ABA race (round 31): the pre-send guard above
                    // closed the window, but a reconnect can still land
                    // between that check and the send completing. The bytes
                    // are already on the wire, so just abort the waiter —
                    // the response will never arrive on THIS connection.
                    if let pending = removePending(requestId: frame.requestId) {
                        pending.resume(throwing: DaemonClientError.notConnected)
                    }
                }
            }
        }
    }

    // MARK: - Event batch ingest

    /// Sends one batch of filtered events as its own top-level `event_batch`
    /// frame (spec §3.4) and resolves when the daemon's `event_batch_ack`
    /// echoing the batchId arrives. The continuation is registered before the
    /// frame goes out so a fast ack can never race past its waiter. The frame
    /// encode and blocking write run on the dedicated serial writer queue, so
    /// the caller's actor never blocks on socket I/O.
    @discardableResult
    func sendBatch(_ events: [ActivityEvent]) async throws -> EventBatchAck {
        let batch = EventBatch(
            protocolVersion: protocolVersion,
            messageId: Ulid.shared.next(),
            type: "event_batch",
            sentAt: Int64(Date().timeIntervalSince1970 * 1000),
            batchId: Ulid.shared.next(),
            events: events
        )
        return try await withCheckedThrowingContinuation { continuation in
            stateLock.lock()
            let sock = fd
            let generation = connectionGeneration
            guard sock >= 0, negotiatedHello != nil else {
                stateLock.unlock()
                continuation.resume(throwing: DaemonClientError.notConnected)
                return
            }
            pendingBatches[batch.batchId] = PendingBatch(
                messageId: batch.messageId,
                continuation: continuation
            )
            stateLock.unlock()

            // Encode + blocking send hop onto the dedicated serial writer
            // queue: the continuation is already registered, so a fast ack can
            // never race past its waiter, and the caller's (MainActor) thread
            // never blocks on a wedged daemon. Transport write errors are
            // connection-fatal (see the catch below): every waiter settles
            // with `transportWriteFailed`, so spool fallback still triggers.

            // Same reply deadline as request(): an ack-less wedged daemon must
            // fail the batch (spool fallback engages) instead of pinning the
            // EventBuffer flush continuation forever.
            armReplyTimeout(batchId: batch.batchId, generation: generation)

            writerQueue.async { [weak self] in
                guard let self else { return }
                // Same pre-send generation check as request() (round 31): a
                // block queued before teardown aborts WITHOUT writing, so a
                // recycled descriptor never receives the stale frame.
                if currentConnectionGeneration() != generation {
                    if let pending = removePendingBatch(batchId: batch.batchId) {
                        pending.continuation.resume(throwing: DaemonClientError.notConnected)
                    }
                    return
                }
                do {
                    try sendAll(sock, payload: FrameCodec.encode(batch))
                } catch {
                    // Same transport-fatal policy as request(): a failed
                    // send may have consumed a frame prefix (SO_SNDTIMEO
                    // EAGAIN mid-write), so the connection is torn down and
                    // every waiter — this batch included — settles with the
                    // typed `transportWriteFailed` environmental error that
                    // spool fallback routes without strikes.
                    teardownConnection(sock, failingWith: error)
                    return
                }
                if currentConnectionGeneration() != generation {
                    // Residual ABA race, same as request(): the pre-send
                    // guard closed the window; a reconnect landing mid-write
                    // can still strand the ack on the dead connection, so
                    // abort the batch waiter (spool fallback re-delivers).
                    if let pending = removePendingBatch(batchId: batch.batchId) {
                        pending.continuation.resume(throwing: DaemonClientError.notConnected)
                    }
                }
            }
        }
    }

    // MARK: - Timeline (segments.list)

    /// Sends the pinned `segments.list` op and decodes the typed result.
    /// Newest-first segments with ordered steps; server caps limit at 200.
    func listSegments(
        from: Int64? = nil,
        to: Int64? = nil,
        limit: Int = SegmentsListDefaults.defaultLimit
    ) async throws -> SegmentsListResult {
        let params = SegmentsListParams(from: from, to: to, limit: limit)
        let response = try await request(op: "segments.list", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "segments.list rejected")
        }
        guard let result = try response.decodedResult(as: SegmentsListResult.self) else {
            throw DaemonClientError.badFrame("segments.list missing result")
        }
        return result
    }

    // MARK: - Timeline (timeline.list / episode.get; M3 episodes)

    /// Sends the pinned `timeline.list` op and decodes the typed result.
    /// Newest-first episode summaries; server caps limit at 50.
    func listTimeline(
        from: Int64? = nil,
        to: Int64? = nil,
        limit: Int = TimelineListDefaults.defaultLimit
    ) async throws -> TimelineListResult {
        let params = TimelineListParams(from: from, to: to, limit: limit)
        let response = try await request(op: "timeline.list", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "timeline.list rejected")
        }
        guard let result = try response.decodedResult(as: TimelineListResult.self) else {
            throw DaemonClientError.badFrame("timeline.list missing result")
        }
        return result
    }

    /// Sends the pinned `episode.get` op and decodes the episode plus its
    /// ordered semantic steps.
    func getEpisode(id: String) async throws -> EpisodeGetResult {
        let response = try await request(
            op: "episode.get",
            params: JSONValue(encoding: EpisodeGetParams(id: id))
        )
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "episode.get rejected")
        }
        guard let result = try response.decodedResult(as: EpisodeGetResult.self) else {
            throw DaemonClientError.badFrame("episode.get missing result")
        }
        return result
    }

    /// Sends the pinned `history.search` op (spec §3.18) and decodes the
    /// ranked hit list. The server clamps `limit` to 50 and sanitizes the
    /// FTS query; hit snippets carry SQLite `snippet()` `<b>` markers that
    /// presentation code renders as emphasis (see HistorySearchPresentation).
    func searchHistory(_ params: HistorySearchParams) async throws -> HistorySearchResult {
        let response = try await request(
            op: "history.search",
            params: JSONValue(encoding: params)
        )
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "history.search rejected")
        }
        guard let result = try response.decodedResult(as: HistorySearchResult.self) else {
            throw DaemonClientError.badFrame("history.search missing result")
        }
        return result
    }

    // MARK: - Chat (chat.send / chat.cancel; spec §3.19)

    /// Sends the pinned `chat.send` op and decodes `{requestId, sessionId}`.
    /// The assistant stream does NOT come back on this response: deltas,
    /// completion and errors arrive as `chat_chunk`/`chat_done`/`chat_error`
    /// server events correlated by the returned `requestId`, delivered through
    /// the existing event subscription (see AppState's chat state machine).
    @discardableResult
    func sendChat(sessionId: String?, text: String) async throws -> ChatSendResult {
        let params = ChatSendParams(sessionId: sessionId, text: text)
        let response = try await request(op: "chat.send", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "chat.send rejected")
        }
        guard let result = try response.decodedResult(as: ChatSendResult.self) else {
            throw DaemonClientError.badFrame("chat.send missing result")
        }
        return result
    }

    /// Sends the pinned `chat.cancel` op for an active turn. `cancelled:false`
    /// means the run had already finished; the terminal phase resolves via the
    /// `chat_error{code:"aborted"}` / `chat_done` event either way.
    @discardableResult
    func cancelChat(requestId: String) async throws -> ChatCancelResult {
        let response = try await request(
            op: "chat.cancel",
            params: JSONValue(encoding: ChatCancelParams(requestId: requestId))
        )
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "chat.cancel rejected")
        }
        guard let result = try response.decodedResult(as: ChatCancelResult.self) else {
            throw DaemonClientError.badFrame("chat.cancel missing result")
        }
        return result
    }

    // MARK: - Memories (memories.list / memory.action; spec §3.16–3.17)

    /// Sends the pinned `memories.list` op and decodes the grouped result.
    /// No status ⇒ all three display groups (confirmed/suggestions/rejected,
    /// superseded hidden); a status narrows to that single group.
    func listMemories(status: String? = nil) async throws -> MemoriesListResult {
        let params = MemoriesListParams(status: status)
        let response = try await request(op: "memories.list", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "memories.list rejected")
        }
        guard let result = try response.decodedResult(as: MemoriesListResult.self) else {
            throw DaemonClientError.badFrame("memories.list missing result")
        }
        return result
    }

    /// Sends the pinned `memory.action` op. confirm/reject resolve to the
    /// updated row; forget hard-deletes so `updated` comes back nil.
    @discardableResult
    func memoryAction(id: String, action: MemoryActionKind) async throws -> MemoryActionResult {
        let params = MemoryActionParams(id: id, action: action)
        let response = try await request(op: "memory.action", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "memory.action rejected")
        }
        guard let result = try response.decodedResult(as: MemoryActionResult.self) else {
            throw DaemonClientError.badFrame("memory.action missing result")
        }
        return result
    }

    // MARK: - Workflows (workflows.list / workflow.action; spec §3.20)

    /// Sends the pinned `workflows.list` op and decodes the typed result.
    /// No status ⇒ all workflows regardless of status; a status narrows the
    /// result. Each item embeds its occurrences (newest-first by startedAtMs).
    func listWorkflows(status: String? = nil) async throws -> WorkflowsListResult {
        let params = WorkflowsListParams(status: status)
        let response = try await request(op: "workflows.list", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "workflows.list rejected")
        }
        guard let result = try response.decodedResult(as: WorkflowsListResult.self) else {
            throw DaemonClientError.badFrame("workflows.list missing result")
        }
        return result
    }

    /// Sends the pinned `workflow.action` op. confirm/reject resolve to the
    /// updated row; `updated:nil` means the row was deleted concurrently.
    @discardableResult
    func workflowAction(id: String, action: WorkflowActionKind) async throws -> WorkflowActionResult {
        let params = WorkflowActionParams(id: id, action: action)
        let response = try await request(op: "workflow.action", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "workflow.action rejected")
        }
        guard let result = try response.decodedResult(as: WorkflowActionResult.self) else {
            throw DaemonClientError.badFrame("workflow.action missing result")
        }
        return result
    }

    // MARK: - Status / settings / delete (M7 hardening surfaces)

    /// Sends the pinned `status.get` op (empty params) and decodes the typed
    /// snapshot rendered by the Diagnostics pane.
    func fetchStatus() async throws -> StatusResult {
        let response = try await request(op: "status.get", params: nil)
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "status.get rejected")
        }
        guard let result = try response.decodedResult(as: StatusResult.self) else {
            throw DaemonClientError.badFrame("status.get missing result")
        }
        return result
    }

    /// Sends the pinned `settings.get` op and decodes the read-only daemon
    /// settings display block.
    func fetchSettings() async throws -> SettingsGetResult {
        let response = try await request(op: "settings.get", params: nil)
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "settings.get rejected")
        }
        guard let result = try response.decodedResult(as: SettingsGetResult.self) else {
            throw DaemonClientError.badFrame("settings.get missing result")
        }
        return result
    }

    /// Sends the pinned `delete.range` op. The exactly-one-of rule
    /// ({from,to} pair or preset) is validated BEFORE the frame is sent;
    /// the server re-validates and would reject with invalid_params anyway.
    @discardableResult
    func deleteHistory(_ params: DeleteRangeParams) async throws -> DeleteRangeResult {
        try params.validate()
        let response = try await request(op: "delete.range", params: JSONValue(encoding: params))
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "delete.range rejected")
        }
        guard let result = try response.decodedResult(as: DeleteRangeResult.self) else {
            throw DaemonClientError.badFrame("delete.range missing result")
        }
        return result
    }

    /// Sends the pinned `diagnostics.get` op and decodes integrity status
    /// plus the daemon-side last-errors list.
    func fetchDiagnostics() async throws -> DiagnosticsGetResult {
        let response = try await request(op: "diagnostics.get", params: nil)
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "diagnostics.get rejected")
        }
        guard let result = try response.decodedResult(as: DiagnosticsGetResult.self) else {
            throw DaemonClientError.badFrame("diagnostics.get missing result")
        }
        return result
    }

    /// Sends the M7 additive `jobs.retryDead` op (manual re-drive of dead
    /// jobs; brief D7 item 5) and decodes the requeued count.
    @discardableResult
    func retryDeadJobs() async throws -> JobsRetryDeadResult {
        let response = try await request(
            op: "jobs.retryDead",
            params: JSONValue(encoding: JobsRetryDeadParams())
        )
        guard response.ok else {
            throw DaemonClientError.handshakeFailed(response.error?.message ?? "jobs.retryDead rejected")
        }
        guard let result = try response.decodedResult(as: JobsRetryDeadResult.self) else {
            throw DaemonClientError.badFrame("jobs.retryDead missing result")
        }
        return result
    }

    // MARK: - Socket plumbing

    /// Opens a connected AF_UNIX stream socket.
    private static func openUnixSocket(path: String) throws -> Int32 {
        let sock = socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw DaemonClientError.connectFailed(errnoString())
        }
        var noSigPipe: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        // Bound blocked sends (SW5-03 budget): a wedged-but-alive daemon with
        // a full receive buffer would otherwise pin the writer queue's thread
        // forever; after the timeout send() fails and the transport-write
        // path tears the connection down (a timed-out send may have consumed
        // a frame prefix — see teardownConnection), settling every waiter
        // with the typed `transportWriteFailed` environmental error. SO_RCVTIMEO
        // is deliberately NOT set here: the long-lived receive loop must be
        // free to block indefinitely on an idle-but-healthy connection —
        // inbound deadlines are enforced per-operation instead (handshake
        // deadline poll + per-request/batch reply timers).
        var sendTimeout = timeval(
            tv_sec: time_t(DaemonClient.socketSendTimeout),
            tv_usec: 0
        )
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8CString)
        guard pathBytes.count <= MemoryLayout<sockaddr_un>.size - MemoryLayout<sa_family_t>.size else {
            close(sock)
            throw DaemonClientError.connectFailed("socket path too long: \(path)")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            for (index, byte) in pathBytes.prefix(destination.count).enumerated() {
                destination[index] = UInt8(bitPattern: byte)
            }
        }
        let rc = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                connect(sock, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            let message = errnoString()
            close(sock)
            throw DaemonClientError.connectFailed(message)
        }
        return sock
    }

    // MARK: - Receive loop

    private func startReceiveLoop(_ sock: Int32) {
        DispatchQueue(label: "computer-history.daemon-client.receive").async { [weak self] in
            self?.receiveLoop(sock)
        }
    }

    private func receiveLoop(_ sock: Int32) {
        var chunk = Data(count: 64 * 1024)
        while true {
            stateLock.lock()
            let active = fd == sock
            stateLock.unlock()
            if !active {
                return
            }
            let received = chunk.withUnsafeMutableBytes { raw in
                recv(sock, raw.baseAddress, raw.count, 0)
            }
            stateLock.lock()
            let activeAfterRecv = fd == sock
            stateLock.unlock()
            if !activeAfterRecv {
                // Displaced while this recv was in flight: a newer adoption
                // shut our socket down to wake the blocked call and closed
                // the descriptor. Discard the chunk — after the close the fd
                // number may even belong to someone else — and exit without
                // touching shared state; teardownConnection would no-op.
                return
            }
            guard received > 0 else {
                // Peer closed (or recv errored): connection-fatal teardown.
                // Skipping the fd/negotiatedHello reset left
                // isConnectedToDaemon true forever, so RecorderCoordinator
                // never reconnected and sendBatch kept writing to a dead fd.
                teardownConnection(sock, failingWith: DaemonClientError.notConnected)
                return
            }

            var poisoned = false
            var frames: [Data] = []
            stateLock.lock()
            do {
                try FrameCodec.extractFrames(from: &receiveBuffer, chunk: chunk.prefix(received)) { payload in
                    frames.append(payload)
                }
            } catch {
                // Oversized declared length poisons the stream (the daemon
                // drops the connection on oversize too): tear down instead of
                // looping on garbage framing forever.
                poisoned = true
            }
            stateLock.unlock()
            // Frames parsed before a poison signal stay delivered (TS parity:
            // the daemon answers well-formed frames before evaluating a
            // trailing bad one); teardown still runs exactly as before.
            for payload in frames {
                route(payload)
            }
            if poisoned {
                teardownConnection(
                    sock,
                    failingWith: DaemonClientError.badFrame("oversized declared frame length; connection dropped")
                )
                return
            }
        }
    }

    /// Shared inbound decoder. `route()` runs only on the serial receive
    /// queue and the handshake reply parse happens before that loop starts,
    /// so one configured instance serves every inbound frame; allocating a
    /// fresh JSONDecoder per received frame was pure churn.
    private static let sharedDecoder = JSONDecoder()

    /// Responses resolve pending continuations; `event_batch` acks resolve the
    /// batch keyed by batchId; error frames reject a batch awaiting that
    /// messageId; events notify the subscriber; unknown shapes are ignored.
    private func route(_ payload: Data) {
        let decoder = Self.sharedDecoder
        // One shape probe per frame: every inbound frame carries a `type`
        // discriminator, so decoding the envelope first selects exactly one
        // concrete decode. Trial-decoding up to four full payloads per frame
        // made every streamed chat_chunk pay four full parses.
        guard let envelope = try? decoder.decode(EnvelopeWire.self, from: payload) else {
            return
        }
        switch envelope.type {
        case "response":
            if let response = try? decoder.decode(ResponseFrame.self, from: payload) {
                stateLock.lock()
                let continuation = pendingResponses.removeValue(forKey: response.requestId)
                stateLock.unlock()
                continuation?.resume(returning: response)
            }
        case "event_batch_ack":
            if let ack = try? decoder.decode(EventBatchAck.self, from: payload) {
                stateLock.lock()
                let pending = pendingBatches.removeValue(forKey: ack.batchId)
                stateLock.unlock()
                pending?.continuation.resume(returning: ack)
            }
        case "error":
            if let errorFrame = try? decoder.decode(ErrorFrameWire.self, from: payload) {
                if let messageId = errorFrame.messageId {
                    failPendingBatch(messageId: messageId, error: DaemonClientError.handshakeFailed(errorFrame.error?.message ?? "event_batch rejected"))
                }
            }
        case "event":
            if let wire = try? decoder.decode(ServerEventWire.self, from: payload),
               let event = Self.decodeDaemonEvent(kind: wire.kind, payload: payload)
            {
                stateLock.lock()
                let handler = eventHandler
                stateLock.unlock()
                handler?(event)
            }
        default:
            // Unknown shapes are ignored, exactly as before.
            break
        }
    }

    /// One decode per delivered event frame: the kind string selects exactly
    /// one payload schema mirror; anything unknown or malformed is dropped.
    private static func decodeDaemonEvent(kind: String, payload: Data) -> DaemonEvent? {
        let decoder = sharedDecoder
        switch kind {
        case "queue_update":
            return (try? decoder.decode(QueueUpdateEvent.self, from: payload))
                .map { .queueUpdated(pendingJobs: $0.payload.pendingJobs) }
        case "episodes_changed":
            return .episodesChanged // empty pinned payload; nothing to extract
        case "memories_changed":
            return .memoriesChanged
        case "workflows_changed":
            return .workflowsChanged
        case "chat_chunk":
            return (try? decoder.decode(ChatChunkEvent.self, from: payload))
                .map { .chatChunk(requestId: $0.payload.requestId, delta: $0.payload.delta) }
        case "chat_done":
            return (try? decoder.decode(ChatDoneEvent.self, from: payload))
                .map { .chatDone(requestId: $0.payload.requestId, sessionId: $0.payload.sessionId) }
        case "chat_error":
            return (try? decoder.decode(ChatErrorEvent.self, from: payload))
                .map {
                    .chatError(
                        requestId: $0.payload.requestId,
                        code: $0.payload.code,
                        message: $0.payload.message
                    )
                }
        case "recording_state":
            return (try? decoder.decode(RecordingStateEvent.self, from: payload))
                .map {
                    .recordingState(state: $0.payload.state, reason: $0.payload.reason)
                }
        default:
            return nil
        }
    }

    // MARK: - State helpers (synchronous; safe to call from async contexts)

    private static func errnoString() -> String {
        String(cString: strerror(errno))
    }

    private func parseHandshakeReply(_ payload: Data) throws -> ServerHello {
        let decoder = Self.sharedDecoder
        if let rejection = try? decoder.decode(ProtocolErrorFrame.self, from: payload) {
            if rejection.error.code == "error.protocol_version" {
                throw DaemonClientError.protocolVersionMismatch(
                    offered: protocolVersion, expected: protocolVersion
                )
            }
            throw DaemonClientError.handshakeFailed(rejection.error.message)
        }
        guard let hello = try? decoder.decode(ServerHello.self, from: payload) else {
            throw DaemonClientError.badFrame("first reply is not a server_hello")
        }
        guard hello.protocolVersion == protocolVersion else {
            throw DaemonClientError.protocolVersionMismatch(offered: hello.protocolVersion, expected: protocolVersion)
        }
        return hello
    }

    private func adoptSocket(_ sock: Int32, hello: ServerHello, closeDisplaced: Bool = false) {
        stateLock.lock()
        connectionGeneration += 1
        let displaced = fd
        fd = sock
        negotiatedHello = hello
        receiveBuffer.removeAll()
        stateLock.unlock()
        // Two concurrent connectAndHandshake calls both reach adoption; the
        // loser's socket used to leak (fd overwritten, never closed). The
        // displacer owns closure: shutdown first so the displaced receive
        // loop's blocked recv wakes, then close — the loop exits via its
        // fd != sock checks without touching shared state. The testing seam
        // (closeDisplaced: false) keeps caller ownership: the reconnect-ABA
        // pin sends on the displaced sock AFTER adoption and requires the
        // write to succeed.
        if closeDisplaced, displaced >= 0, displaced != sock {
            shutdown(displaced, SHUT_RDWR)
            close(displaced)
        }
    }

    /// Testing-only seam: adopts an already-connected socket WITHOUT starting
    /// the receive loop, so tests can drive deterministic writer-queue write
    /// failures (e.g. EPIPE after a local shutdown) with no teardown path
    /// racing them. The caller keeps ownership of the descriptor.
    func adoptSocketForTesting(_ sock: Int32, hello: ServerHello) {
        adoptSocket(sock, hello: hello)
    }

    /// Testing-only seam: number of event-batch sends currently registered
    /// and awaiting an ack or failure. Lets tests observe registration
    /// directly instead of sleeping a fixed margin before unblocking a
    /// gated writer queue.
    var pendingBatchCountForTesting: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pendingBatches.count
    }

    private func currentConnectionGeneration() -> Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return connectionGeneration
    }

    private func currentSocket() -> Int32 {
        stateLock.lock()
        defer { stateLock.unlock() }
        return fd
    }

    private func registerPending(
        requestId: String,
        sock: Int32,
        continuation: CheckedContinuation<ResponseFrame, Error>
    ) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard fd == sock, fd >= 0 else { return false }
        pendingResponses[requestId] = continuation
        return true
    }

    private func removePendingBatch(batchId: String) -> PendingBatch? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pendingBatches.removeValue(forKey: batchId)
    }

    /// Rejects the batch whose outgoing frame carried `messageId`, if any.
    private func failPendingBatch(messageId: String, error: Error) {
        stateLock.lock()
        guard let batchId = pendingBatches.first(where: { $0.value.messageId == messageId })?.key else {
            stateLock.unlock()
            return
        }
        let pending = pendingBatches.removeValue(forKey: batchId)
        stateLock.unlock()
        pending?.continuation.resume(throwing: error)
    }

    private func removePending(requestId: String) -> CheckedContinuation<ResponseFrame, Error>? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pendingResponses.removeValue(forKey: requestId)
    }

    /// Drains BOTH waiter maps — response continuations and event-batch acks.
    /// Missing `pendingBatches` here stranded EventBuffer.flush continuations
    /// forever on receive-loop teardowns (disconnect() already drained both).
    private func failAllPending(_ error: Error) {
        stateLock.lock()
        let pending = pendingResponses
        pendingResponses.removeAll()
        let batches = pendingBatches.values
        pendingBatches.removeAll()
        stateLock.unlock()
        for continuation in pending.values {
            continuation.resume(throwing: error)
        }
        for batch in batches {
            batch.continuation.resume(throwing: error)
        }
    }

    /// Connection-fatal teardown shared by every transport-failure site —
    /// the receive loop (peer close, poisoned framing) and the writer queue
    /// (send failures after SO_SNDTIMEO/EPIPE/...). Resets the client state
    /// under the lock, closes `sock` only if it is still the active
    /// descriptor (ABA-safe against a racing reconnect), drains every waiter
    /// with `error`, and fires `onDisconnect` so RecorderCoordinator's
    /// reconnect loop rebuilds a clean stream.
    private func teardownConnection(_ sock: Int32, failingWith error: Error) {
        stateLock.lock()
        let wasActive = fd == sock
        if wasActive {
            fd = -1
            negotiatedHello = nil
        }
        stateLock.unlock()
        guard wasActive else { return }
        shutdown(sock, SHUT_RDWR)
        close(sock)
        failAllPending(error)
        onDisconnect?()
    }

    private func sendAll(_ sock: Int32, payload: Data) throws {
        var sent = 0
        while sent < payload.count {
            let n = payload.withUnsafeBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return send(sock, base.advanced(by: sent), payload.count - sent, 0)
            }
            guard n > 0 else {
                throw DaemonClientError.transportWriteFailed(Self.errnoString())
            }
            sent += n
        }
    }

    /// Outcome of a framed read under a wall-clock deadline.
    private enum FramedRead {
        case payload(Data)
        /// Peer closed or recv errored (also: oversized declared length).
        case closed
        /// The deadline elapsed with the peer silent-but-open.
        case timedOut
    }

    /// Reads one complete framed payload, polling for readability so every
    /// recv is bounded by `timeout`. Replaces the unbounded blocking recv of
    /// the original handshake path: connectAndHandshake ran on a cooperative-
    /// pool thread, where a wedged-but-alive daemon would pin that thread
    /// forever with no retry ever firing.
    private static func readFramedWithDeadline(fd sock: Int32, timeout: TimeInterval) -> FramedRead {
        func pollReadable(deadline: Date) -> FramedRead? {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                return .timedOut
            }
            var pollfd = pollfd(fd: sock, events: Int16(POLLIN), revents: 0)
            let rc = poll(&pollfd, 1, Int32(min(Double(Int32.max), (remaining * 1000).rounded(.up))))
            if rc == 0 {
                return .timedOut
            }
            if rc < 0 {
                if errno == EINTR {
                    return nil
                }
                return .closed
            }
            return nil
        }

        func readExactly(_ count: Int, deadline: Date) -> FramedRead {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: count)
            while buffer.count < count {
                if let outcome = pollReadable(deadline: deadline) {
                    return outcome
                }
                let n = chunk.withUnsafeMutableBytes { raw -> Int in
                    guard let base = raw.baseAddress else { return -1 }
                    return recv(sock, base.advanced(by: buffer.count), count - buffer.count, 0)
                }
                guard n > 0 else { return .closed }
                buffer.append(contentsOf: chunk[0 ..< n])
            }
            return .payload(buffer)
        }

        let deadline = Date().addingTimeInterval(timeout)
        switch readExactly(4, deadline: deadline) {
        case let .payload(header):
            let declared = header.reduce(0) { ($0 << 8) | UInt32($1) }
            guard declared <= UInt32(FrameCodec.maxPayloadSize) else { return .closed }
            return readExactly(Int(declared), deadline: deadline)
        case .closed: return .closed
        case .timedOut: return .timedOut
        }
    }
}

/// Arms the reply deadline for one pending request/batch entry. Fires once:
/// it removes the entry only if its connection generation still matches, then
/// resumes the waiter through the same typed-failure channel as write errors
/// and teardowns. A response routed before expiry (or after it — route()
/// simply finds no entry) is unaffected; the timer itself never touches the
/// socket, so an idle-but-healthy connection stays up.
private extension DaemonClient {
    func armReplyTimeout(requestId: String? = nil, batchId: String? = nil, generation: Int) {
        let timeout = replyTimeout
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self else { return }
            stateLock.lock()
            guard connectionGeneration == generation else {
                // Teardown/reconnect already drained this entry; never fire
                // into a newer connection.
                stateLock.unlock()
                return
            }
            let continuation = requestId.flatMap { pendingResponses.removeValue(forKey: $0) }

            let batch = batchId.flatMap { pendingBatches.removeValue(forKey: $0) }
            stateLock.unlock()
            let error = DaemonClientError.replyTimedOut("no reply within \(Int(timeout))s")
            continuation?.resume(throwing: error)
            batch?.continuation.resume(throwing: error)
        }
    }
}

private struct ServerEventWire: Decodable {
    var type: String
    var kind: String
}

private struct ErrorFrameWire: Decodable {
    var type: String
    var messageId: String?
    var error: ServerErrorBody?
}

/// Minimal inbound-frame probe: only the `type` discriminator, decoded once
/// per frame so `route` can select the single concrete decode.
private struct EnvelopeWire: Decodable {
    var type: String
}
