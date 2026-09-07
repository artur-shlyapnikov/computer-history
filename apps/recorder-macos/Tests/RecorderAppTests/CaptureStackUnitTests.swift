import ApplicationServices
import CoreGraphics
import Foundation
@testable import RecorderApp
import Testing

/// Unit tests for the small pure building blocks of the capture stack:
/// ULID generation, capture session identity, policy store persistence,
/// keycode shortcut normalization, and AX draft construction. Live
/// Accessibility/CGEvent behavior is NOT verifiable here (no interactive
/// permission grant in CI) — see the honest-limits notes at the bottom.
struct CaptureStackUnitTests {
    // MARK: - ULID

    @Test("ULIDs are 26-char Crockford base32 with 48-bit timestamp prefix")
    func ulidFormat() {
        // Pure-encoder path: shared generator is monotonic across the whole
        // process, so a pinned past timestamp would be silently clamped —
        // decode the canonical encoding instead.
        let id = Ulid.encode(timestamp: 1_700_000_000_000, high: 0, low: 0)
        #expect(id.count == 26)
        let crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        #expect(id.allSatisfy { crockford.contains($0) })
        // Timestamp occupies the first 10 chars; decode and compare.
        let decoded = id.prefix(10).reduce(0) { acc, char in
            let value = crockford.distance(from: crockford.startIndex, to: crockford.firstIndex(of: char)!)
            return acc * 32 + value
        }
        #expect(decoded == 1_700_000_000_000)
    }

    @Test("ULIDs are strictly monotonic within the same millisecond")
    func ulidMonotonic() {
        var previous = ""
        for _ in 0 ..< 1000 {
            let id = Ulid.shared.next(nowMs: 1_700_000_000_000)
            #expect(id > previous, "same-ms generation must strictly increase")
            previous = id
        }
    }

    @Test("capture session ids are unique per instance")
    func captureSessionUnique() {
        let first = CaptureSession(ulid: Ulid.shared.next(nowMs: 5))
        let second = CaptureSession(ulid: Ulid.shared.next(nowMs: 5))
        #expect(first.id != second.id)
    }

    // MARK: - CapturePolicy + store

    @Test("default policy is metadata everywhere; per-app overrides win")
    func policyResolution() throws {
        let defaults = try #require(UserDefaults(suiteName: "policy-tests-\(UUID().uuidString)"))
        let store = CapturePolicyStore(defaults: defaults)

        let loaded = store.load()
        #expect(loaded.defaultMode == .metadata)
        #expect(loaded.mode(forBundleId: "com.any.app") == .metadata)

        var policy = loaded
        policy.perApp["com.private.app"] = .off
        policy.perApp["com.open.app"] = .content
        try store.save(policy)

        let reloaded = store.load()
        #expect(reloaded.mode(forBundleId: "com.private.app") == .off)
        #expect(reloaded.mode(forBundleId: "com.open.app") == .content)
        #expect(reloaded.mode(forBundleId: "com.other.app") == .metadata)
    }

    @Test("corrupted persisted policy falls back to the safe default")
    func corruptedPolicyFallsBack() throws {
        let suiteName = "policy-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(Data("not json".utf8), forKey: "capturePolicy")

        let policy = CapturePolicyStore(defaults: defaults).load()
        #expect(policy == .standard)
    }

    // MARK: - InputMonitor pure helpers

    @Test("shortcut descriptions normalize modifier order from keycodes only")
    func shortcutDescriptions() {
        // Virtual keycode 8 == 'C' on ANSI; NO character APIs involved —
        // the name comes straight from KeyCodeNames.
        let c: UInt32 = 8
        #expect(InputMonitor.shortcutDescription(keyCode: c, flags: .maskCommand) == "cmd+c")
        #expect(InputMonitor.shortcutDescription(keyCode: c, flags: [.maskCommand, .maskShift]) == "shift+cmd+c")
        #expect(
            InputMonitor.shortcutDescription(keyCode: c, flags: [.maskCommand, .maskControl, .maskAlternate])
                == "ctrl+opt+cmd+c"
        )
        #expect(InputMonitor.shortcutDescription(keyCode: 36, flags: []) == "return")
        // Unknown keycode still yields a stable identity without any text payload.
        #expect(InputMonitor.shortcutDescription(keyCode: 999, flags: .maskCommand) == "cmd+key999")
    }

    @Test("only cmd/control/option count as shortcut modifiers")
    func shortcutModifierClassification() {
        #expect(!InputMonitor.hasShortcutModifiers([]))
        #expect(!InputMonitor.hasShortcutModifiers(.maskShift)) // plain capital letter → typing
        #expect(!InputMonitor.hasShortcutModifiers(.maskNonCoalesced))
        #expect(InputMonitor.hasShortcutModifiers(.maskCommand))
        #expect(InputMonitor.hasShortcutModifiers(.maskControl))
        #expect(InputMonitor.hasShortcutModifiers(.maskAlternate))
    }

    @Test("keycode table is lowercase, unique, and covers common keys")
    func keycodeTableSanity() {
        let names = Array(KeyCodeNames.names.values)
        #expect(Set(names).count == names.count, "names must be unique")
        #expect(names.allSatisfy { !$0.isEmpty && $0 == $0.lowercased() })
        for expected in ["a", "c", "v", "space", "return", "tab", "escape", "delete", "f1", "uparrow", "cmd"] {
            #expect(names.contains(expected), "table must contain \(expected)")
        }
        // Every declared entry maps back through the lookup.
        #expect(KeyCodeNames.name(for: 8) == "c")
        #expect(KeyCodeNames.name(for: 49) == "space")
    }

    // MARK: - AXExtraction pure mapping

    @Test("secure subrole detection matches the pinned macOS spelling")
    func secureSubroleDetection() {
        #expect(AXExtraction.isSecureSubrole("AXSecureTextField"))
        #expect(!AXExtraction.isSecureSubrole("AXTextField"))
        #expect(!AXExtraction.isSecureSubrole(nil))
    }

    @Test("drafts from observed attributes flag secure fields and drop their value")
    func draftConstructionSecurePrecedence() {
        let app = AppInfo(bundleId: "com.example.app", name: nil, pid: 7)
        let secure = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextField", subrole: "AXSecureTextField", label: "Password", identifier: "pw", title: nil, value: "SHOULD-NOT-EXIST"),
            action: .textChange,
            app: app,
            windowTitle: "Login"
        )
        #expect(secure.isSecureField)
        #expect(secure.content == nil) // value never propagated
        #expect(secure.target?.subrole == "AXSecureTextField")
        #expect(secure.source == .accessibility)

        let normal = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextArea", subrole: nil, label: "Comment", identifier: nil, title: nil, value: "hello"),
            action: .textChange,
            app: app,
            windowTitle: nil
        )
        #expect(!normal.isSecureField)
        #expect(normal.content == "hello")
        #expect(normal.action == .textChange)
    }

    // MARK: - AXMonitor lifecycle bookkeeping

    @Test("AXMonitor.stopAll leaves no tracked pids behind")
    @MainActor
    func axStopAllClearsTrackedPids() {
        let monitor = AXMonitor()
        // Attach may legitimately fail without an Accessibility grant (CI) —
        // either way the lifecycle invariant under test is: after stopAll no
        // pid stays tracked and the call is safe to make from pause/stop.
        monitor.attach(pid: ProcessInfo.processInfo.processIdentifier)
        monitor.attach(pid: 99999) // dead pid → exercises the attach-failed path
        #expect(monitor.attachedPids.count <= 2)
        monitor.stopAll()
        #expect(monitor.attachedPids.isEmpty)
    }
}

/*
  Honest limits (contracts §Verification honesty):
  - AXObserver attachment, notification delivery, kAXValueAttribute reads and
    pid-death cleanup require an interactive Accessibility permission grant;
    they are implemented per spec but only verifiable by code review here.
 - AXObserver DETACHMENT on stop/pause (AXMonitor.stopAll → detach per pid)
    has the same constraint: with a grant, attach succeeds and stopAll's
    run-loop-source removal + observer teardown can be observed; without one,
    only the empty-bookkeeping invariant above is verifiable in unit tests.
  - CGEventTap creation (.listenOnly) requires the Input Monitoring /
    Accessibility prompt; tapCallback classification runs on a live event
    stream and cannot be driven from unit tests. The pure classification
    logic above IS covered.
  */
