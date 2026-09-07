import Foundation
@testable import RecorderApp
import Testing

/// Pins DiagnosticsView.reportText: the copy-report mirrors the pane's
/// rendered snapshot line-for-line, degrades honestly per missing leg
/// (no status snapshot / no diagnostics), surfaces the paused reason and
/// integrity failure verbatim, and lists supervisor errors newest-first
/// like the pane. Calendar pinned UTC like DiagnosticsTimestampTests.
@MainActor
struct DiagnosticsReportTests {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        c.locale = Locale(identifier: "en_US_POSIX")
        return c
    }

    private var now: Date {
        calendar.date(from: DateComponents(timeZone: calendar.timeZone, year: 2026, month: 3, day: 10, hour: 16))!
    }

    private func ms(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0) -> Int64 {
        Int64(
            calendar.date(
                from: DateComponents(timeZone: calendar.timeZone, year: year, month: month, day: day, hour: hour, minute: minute, second: second)
            )!.timeIntervalSince1970 * 1000
        )
    }

    private func status(paused: Bool = false, reason: String? = nil) -> StatusResult {
        StatusResult(
            daemon: .init(version: "1.4.2", schemaVersion: 7, uptimeMs: 3_723_000),
            recording: .init(paused: paused, reason: reason),
            accessibilityRequired: true,
            queue: .init(pending: 2, retrying: 1, dead: 0),
            db: .init(
                rawEvents: 120_000,
                segments: 900,
                steps: 8100,
                episodes: 310,
                memories: 42,
                workflows: 5,
                pageCountBytes: 9_437_184
            ),
            diskFreeBytes: 2_254_899_122
        )
    }

    @Test("full report mirrors the rendered snapshot")
    func fullReport() {
        var ring = SupervisorErrorRing(capacity: 20)
        ring.record(atMs: ms(2026, 3, 10, 9, 0, 0), scope: "capture", code: "AX_LOST", message: "accessibility connection dropped")
        ring.record(atMs: ms(2026, 3, 10, 9, 5, 0), scope: "ipc", code: "SOCKET", message: "socket write failed")

        let text = DiagnosticsView.reportText(
            status: status(),
            diagnostics: DiagnosticsGetResult(
                integrityOk: true,
                lastErrors: [DiagnosticsErrorEntry(at: ms(2026, 3, 9, 22, 0, 0), scope: "summarize", code: "LLM", message: "model timeout")]
            ),
            supervisor: ring,
            calendar: calendar,
            now: now
        )

        #expect(
            text == """
            Computer History diagnostics — 2026-03-10 16:00:00
            Daemon: v1.4.2 · schema v7
            Uptime: 1h 2m 3s
            Recording: active
            Queue: pending 2 · retrying 1 · dead 0
            Disk free: 2.1 GiB
            Raw events: 120000
            Segments / steps: 900 / 8100
            Episodes: 310
            Memories / workflows: 42 / 5
            DB size: 9.0 MiB
            Integrity check: OK
            Daemon errors:
              LLM · summarize @ 22:00:00 Mar 9 — model timeout
            Supervisor errors:
              SOCKET · ipc @ 09:05:00 — socket write failed
              AX_LOST · capture @ 09:00:00 — accessibility connection dropped
            """
        )
    }

    @Test("missing legs degrade to the pane's honest not-loaded lines")
    func missingLegs() {
        let text = DiagnosticsView.reportText(
            status: nil,
            diagnostics: nil,
            supervisor: SupervisorErrorRing(capacity: 5),
            calendar: calendar,
            now: now
        )
        #expect(text.contains("No status snapshot loaded."))
        #expect(text.contains("No diagnostics loaded."))
        #expect(text.contains("Supervisor errors: none"))
    }

    @Test("paused reason and integrity failure surface verbatim")
    func pausedAndFailed() {
        let text = DiagnosticsView.reportText(
            status: status(paused: true, reason: nil),
            diagnostics: DiagnosticsGetResult(integrityOk: false, lastErrors: []),
            supervisor: SupervisorErrorRing(capacity: 5),
            calendar: calendar,
            now: now
        )
        #expect(text.contains("Recording: paused (unknown)"))
        #expect(text.contains("Integrity check: FAILED"))
        #expect(text.contains("Daemon errors: none"))
    }

    // MARK: - Copy gate predicate

    @Test("copy disabled when every leg is absent")
    func copyGateAllLegsAbsent() {
        #expect(!DiagnosticsView.copyReportEnabled(lastStatus: nil, daemonDiagnostics: nil, supervisorErrorCount: 0))
    }

    @Test("copy stays enabled on a stale status snapshot after a failed refresh")
    func copyGateStaleStatusOnly() {
        #expect(DiagnosticsView.copyReportEnabled(lastStatus: status(), daemonDiagnostics: nil, supervisorErrorCount: 0))
    }

    @Test("copy enabled when only diagnostics are present")
    func copyGateDiagnosticsOnly() {
        #expect(DiagnosticsView.copyReportEnabled(lastStatus: nil, daemonDiagnostics: DiagnosticsGetResult(integrityOk: true, lastErrors: []), supervisorErrorCount: 0))
    }

    @Test("copy enabled when only supervisor errors are present")
    func copyGateSupervisorErrorsOnly() {
        #expect(DiagnosticsView.copyReportEnabled(lastStatus: nil, daemonDiagnostics: nil, supervisorErrorCount: 2))
    }
}
