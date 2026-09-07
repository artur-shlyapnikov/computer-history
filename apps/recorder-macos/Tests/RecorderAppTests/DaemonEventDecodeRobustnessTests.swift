import Foundation
@testable import RecorderApp
import Testing

/// Decode-robustness coverage restored after 595eb1f moved server-event
/// decoding into `DaemonClient.decodeDaemonEvent` (the DaemonAPI refactor
/// deleted the old black-box tests that drove raw frames through the
/// coordinator). These drive real framed traffic through `route()`'s
/// `event` case over a ScriptedDaemon socket — exactly how production
/// frames arrive (ComputerHistoryApp installs the AppState.apply handler):
/// a malformed payload for a KNOWN kind and an UNKNOWN future kind must
/// both drop at decode without invoking the subscriber or disturbing
/// AppState, and the connection must stay alive afterwards.
@MainActor
struct DaemonEventDecodeRobustnessTests {
    /// Thread-safe collector standing in for the production event handler.
    private final class EventCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [DaemonEvent] = []

        func append(_ event: DaemonEvent) {
            lock.lock()
            defer { lock.unlock() }
            items.append(event)
        }

        var snapshot: [DaemonEvent] {
            lock.lock()
            defer { lock.unlock() }
            return items
        }
    }

    /// Echo handshake; every request gets a canned ok response followed by
    /// one malformed-queue_update frame and one unknown-kind frame.
    private static func makeDaemon(path: String) -> ScriptedDaemon {
        ScriptedDaemon(path: path) { _, client, frame in
            switch frame {
            case let .clientHello(hello):
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: try! JSONEncoder().encode(
                        ServerHello(
                            protocolVersion: 1,
                            messageId: hello.messageId,
                            type: "server_hello",
                            sentAt: 1,
                            daemonVersion: "decode-robustness-0.1.0",
                            databaseSchemaVersion: 2
                        )
                    )
                )
            case let .request(request):
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(
                        #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWJ","type":"response","sentAt":1,"requestId":"\#(request.requestId)","ok":true,"result":{}}"#
                            .utf8
                    )
                )
                func envelope(_ kind: String, _ payload: String) -> String {
                    #"{"protocolVersion":1,"messageId":"01M0NYNJXRTW00B4PKZA7PCSWI","type":"event","sentAt":1,"kind":"\#(kind)","payload":\#(payload)}"#
                }
                // Known kind, valid JSON of the wrong shape; unknown future
                // kind dropped by name — both decode to nil.
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(envelope("queue_update", #"["not","an","object"]"#).utf8)
                )
                ScriptedDaemon.sendFrame(
                    fd: client,
                    payload: Data(envelope("future_thing", "{}").utf8)
                )
            case .other:
                break
            }
        }
    }

    /// Connects through the scripted daemon, seeds AppState, triggers the
    /// malformed/unknown frames via one request, and returns once the poll
    /// window has elapsed (caller asserts nothing was delivered).
    @MainActor
    private static func connectAndTrigger(
        path: String,
        state: AppState,
        collector: EventCollector
    ) async throws -> DaemonClient {
        let daemon = makeDaemon(path: path)
        try daemon.start()
        // ScriptedDaemon.stop only closes the LISTEN fd (see
        // DaemonClientHandshakeTests): stop = stop accepting, while already-
        // accepted sockets keep serving. This defer therefore does NOT tear
        // down the live connection — the follow-up request after connectAndTrigger
        // returns relies on exactly that. Do not "fix" stop to close accepted
        // connections without reworking this test.
        defer { daemon.stop() }

        let client = DaemonClient()
        client.setEventSubscription { [collector] event in
            collector.append(event)
        }
        _ = try await client.connectAndHandshake(socketPath: daemon.path, appVersion: "test")

        state.applyQueueUpdate(pendingJobs: 5)

        // The frames ride behind this response on the same socket.
        let reply = try await client.request(op: "settings.get", params: nil)
        #expect(reply.ok)

        // Give any (wrongful) delivery a bounded window to land.
        for _ in 0 ..< 25 where collector.snapshot.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        return client
    }

    @Test("malformed queue_update payload leaves state untouched")
    func malformedQueueUpdateIgnored() async throws {
        let collector = EventCollector()
        let state = AppState(daemon: FakeDaemonAPI())
        let client = try await Self.connectAndTrigger(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ddq-\(UUID().uuidString).sock").path,
            state: state,
            collector: collector
        )

        #expect(collector.snapshot.isEmpty)
        #expect(state.pendingJobs == 5)
        #expect(state.supervisorErrors.isEmpty)

        // Both drops are silent-but-not-fatal: the same connection still
        // serves requests.
        let followup = try await client.request(op: "status.get", params: nil)
        #expect(followup.ok)
        client.disconnect()
    }

    @Test("unknown future event kinds are tolerated without mutating state")
    func unknownKindTolerated() async throws {
        let collector = EventCollector()
        let state = AppState(daemon: FakeDaemonAPI())
        let client = try await Self.connectAndTrigger(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("ch-ddu-\(UUID().uuidString).sock").path,
            state: state,
            collector: collector
        )

        #expect(collector.snapshot.isEmpty)
        #expect(state.pendingJobs == 5)
        #expect(state.supervisorErrors.isEmpty)

        let followup = try await client.request(op: "status.get", params: nil)
        #expect(followup.ok)
        client.disconnect()
    }
}
