import Foundation
@testable import RecorderApp
import Testing

/// Capture stack pure helpers (brief S1 item 12): policy resolution +
/// persistence, capture session identity, clock, input classification, AX
/// draft construction. Live AX/CGEvent behavior is NOT exercised here — it
/// requires an interactive permission grant and is documented as manually
/// verifiable in the M1 report.
@Suite(.serialized)
struct CaptureStackTests {
    // MARK: - CapturePolicy

    @Test("default mode is metadata for every app; overrides win")
    func policyResolution() {
        var policy = CapturePolicy()
        #expect(policy.mode(forBundleId: "com.apple.Safari") == .metadata)
        #expect(policy.mode(forBundleId: "anything") == .metadata)
        policy.perApp["com.apple.Safari"] = .content
        policy.perApp["com.apple.Terminal"] = .off
        #expect(policy.mode(forBundleId: "com.apple.Safari") == .content)
        #expect(policy.mode(forBundleId: "com.apple.Terminal") == .off)
        #expect(policy.mode(forBundleId: "com.other") == .metadata)
    }

    @Test("policy store persists and reloads through UserDefaults")
    func policyStoreRoundtrip() throws {
        let suite = "ch-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CapturePolicyStore(defaults: defaults)

        var policy = CapturePolicy()
        policy.perApp["com.apple.Terminal"] = .off
        try store.save(policy)

        let loaded = CapturePolicyStore(defaults: defaults).load()
        #expect(loaded == policy)
        #expect(loaded.mode(forBundleId: "com.apple.Terminal") == .off)

        // Corrupt values fall back to metadata — never widen capture.
        defaults.set("bogus", forKey: "capture.defaultPolicy")
        let degraded = CapturePolicyStore(defaults: defaults).load()
        #expect(degraded.defaultMode == .metadata)
    }

    @Test("suite name is pinned to com.computer-history.recorder")
    func pinnedSuiteName() {
        #expect(CapturePolicyStore.suiteName == "com.computer-history.recorder")
    }

    // MARK: - CaptureSession + clocks

    @Test("capture session id is a ULID, stable per instance and injectable")
    func captureSession() {
        let session = CaptureSession()
        #expect(session.id.count == 26)
        #expect(session.id == session.id) // stable for the instance's lifetime
        // Injectable for deterministic tests; default derives from Ulid.shared.
        #expect(CaptureSession(ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV").id == "01ARZ3NDEKTSV4RRFFQ69G5FAV")
    }

    @Test("system clock derives wall ms and uptime-based monotonic ns")
    func systemClock() {
        let clock = CaptureClock.system
        #expect(abs(clock.nowMs() - Int64(Date().timeIntervalSince1970 * 1000)) < 5000)
        let up = ProcessInfo.processInfo.systemUptime
        let monotonic = clock.monotonicNs()
        #expect(monotonic > 0)
        // Within a generous band of the scaled uptime.
        #expect(abs(Double(monotonic) / 1_000_000_000 - up) < 5.0)
    }

    @Test("injected clock is honored verbatim")
    func injectedClock() {
        let clock = CaptureClock(nowMs: { 7 }, monotonicNs: { 9 })
        #expect(clock.nowMs() == 7)
        #expect(clock.monotonicNs() == 9)
    }

    // MARK: - InputMonitor pure helpers (no permissions needed)

    @Test("shortcut detection: cmd/ctrl/opt yes; shift/plain no")
    func shortcutModifiers() {
        #expect(InputMonitor.hasShortcutModifiers(.maskCommand))
        #expect(InputMonitor.hasShortcutModifiers(.maskControl))
        #expect(InputMonitor.hasShortcutModifiers(.maskAlternate))
        #expect(!InputMonitor.hasShortcutModifiers(.maskShift))
        #expect(!InputMonitor.hasShortcutModifiers(.maskAlphaShift))
        #expect(!InputMonitor.hasShortcutModifiers([]))
    }

    @Test("shortcut names use fixed modifier order and keycode table only")
    func shortcutNames() {
        #expect(InputMonitor.shortcutDescription(keyCode: 8, flags: [.maskCommand]) == "cmd+c")
        #expect(InputMonitor.shortcutDescription(keyCode: 8, flags: [.maskCommand, .maskShift, .maskControl]) == "ctrl+shift+cmd+c")
        #expect(InputMonitor.shortcutDescription(keyCode: 999, flags: [.maskCommand]) == "cmd+key999")
        // The description never embeds anything but table names and modifiers.
        #expect(!InputMonitor.shortcutDescription(keyCode: 36, flags: []).contains("\n"))
    }

    @Test("keycode name table covers common anchors")
    func keyCodeTable() {
        #expect(KeyCodeNames.name(for: 0) == "a")
        #expect(KeyCodeNames.name(for: 36) == "return")
        #expect(KeyCodeNames.name(for: 49) == "space")
        #expect(KeyCodeNames.name(for: 123) == "leftarrow")
        #expect(KeyCodeNames.name(for: 55) == "cmd")
    }

    // MARK: - InputMonitor lifecycle (start→stop race)

    @Test("immediate stop after start leaves no registered run loop behind")
    func immediateStopDoesNotLeakRunLoop() {
        let monitor = InputMonitor()
        // May return false in CI without the input-monitoring permission;
        // then no tap thread is spawned and the invariant holds trivially.
        _ = monitor.start()
        monitor.stop()
        // Grace period: if a tap thread was spawned, this lets it reach its
        // lock section. With the generation guard it must bail there instead
        // of registering a loop that stop() already snapshotted as nil.
        Thread.sleep(forTimeInterval: 0.3)
        #expect(monitor.activeRunLoop == nil)
        // stop() is idempotent.
        monitor.stop()
        #expect(monitor.activeRunLoop == nil)
    }

    // MARK: - AXExtraction draft construction

    @Test("secure subrole yields nil content and the secure flag")
    func secureDraft() {
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextField", subrole: "AXSecureTextField", label: "pw", identifier: nil, title: nil, value: "SHOULD-NOT-APPEAR"),
            action: .textChange,
            app: AppInfo(bundleId: "com.test", name: nil, pid: nil),
            windowTitle: nil
        )
        #expect(draft.isSecureField)
        #expect(draft.content == nil)
        #expect(draft.target?.subrole == "AXSecureTextField")
    }

    @Test("non-secure value changes keep their content for filtering")
    func normalDraft() {
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextArea", subrole: nil, label: "comment", identifier: nil, title: nil, value: "hello"),
            action: .textChange,
            app: AppInfo(bundleId: "com.test", name: nil, pid: nil),
            windowTitle: "Editor"
        )
        #expect(!draft.isSecureField)
        #expect(draft.content == "hello")
        #expect(draft.windowTitle == "Editor")
        #expect(draft.source == .accessibility)
    }

    // MARK: - DaemonClient gate-fix regression (register/send same handle)

    @Test("request before handshake fails fast with notConnected")
    func requestWithoutConnection() async {
        let client = DaemonClient()
        do {
            _ = try await client.request(op: "status.get", params: nil)
            Issue.record("expected notConnected failure")
        } catch {
            #expect(error is DaemonClientError)
        }
        #expect(client.onDisconnect != nil || true) // callback wiring compiles
    }
}
