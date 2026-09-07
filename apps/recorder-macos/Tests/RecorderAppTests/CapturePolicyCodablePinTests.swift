import Foundation
@testable import RecorderApp
import Testing

/// CapturePolicy wire-stability pins (design round-3 §P3-9): the policy JSON
/// outlives app upgrades in UserDefaults — renaming a case or coding key
/// silently invalidates every stored blob and decode falls back to
/// `.standard`, which users experience as "my per-app rules vanished".
/// These tests pin the raw-value spellings, the fallback at the Codable
/// boundary, and `mode(forBundleId:)`.
struct CapturePolicyCodablePinTests {
    @Test("encoded JSON pins the raw-value spellings verbatim")
    func encodedSpellingsPinned() throws {
        let policy = CapturePolicy(defaultMode: .content, perApp: ["com.apple.Terminal": .off])

        let data = try JSONEncoder().encode(policy)
        let json = String(bytes: data, encoding: .utf8) ?? ""

        #expect(json.contains(#""defaultMode":"content""#))
        #expect(json.contains(#""off""#))
    }

    @Test("only the exact current shape decodes; malformed falls back to standard")
    func malformedBlobsFallBackToStandard() throws {
        let suiteName = "ch-capture-policy-pin-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = CapturePolicyStore(defaults: defaults)

        // The exact current shape decodes to a non-standard policy.
        let good = Data(#"{"defaultMode":"metadata","perApp":{"com.apple.Terminal":"off"}}"#.utf8)
        defaults.set(good, forKey: "capturePolicy")
        #expect(store.load().perApp["com.apple.Terminal"] == .off)

        // Legacy/foreign variants must NOT decode into something surprising:
        // every one of these yields .standard via the store's catch.
        let legacyShapes: [String] = [
            // Nested enum object instead of raw string (old drafts).
            #"{"defaultMode":"metadata","perApp":{"x":{"off":1}}}"#,
            // Wrong top-level key spelling.
            #"{"DefaultMode":"metadata","perApp":{}}"#,
            // Renamed mode value.
            #"{"defaultMode":"disabled","perApp":{}}"#,
            // Missing required defaultMode.
            #"{"perApp":{}}"#,
            // Truncated blob.
            #"{"defaultMode":"met"#,
        ]
        for shape in legacyShapes {
            defaults.set(Data(shape.utf8), forKey: "capturePolicy")
            #expect(store.load() == .standard, "expected .standard fallback for \(shape)")
        }
    }

    @Test("mode(forBundleId:) honors overrides and falls back to defaultMode")
    func overrideLookupAndFallback() {
        let policy = CapturePolicy(
            defaultMode: .metadata,
            perApp: [
                "com.apple.Terminal": .off,
                "com.google.Chrome": .content,
            ]
        )

        #expect(policy.mode(forBundleId: "com.apple.Terminal") == .off)
        #expect(policy.mode(forBundleId: "com.google.Chrome") == .content)
        #expect(policy.mode(forBundleId: "com.example.Unlisted") == .metadata)
    }

    @Test("CaptureMode case set is exactly off, metadata, content")
    func captureModeCaseSetPinned() {
        #expect(CaptureMode.allCases.map(\.rawValue) == ["off", "metadata", "content"])
    }
}
