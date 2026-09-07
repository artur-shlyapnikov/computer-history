import Foundation
@testable import RecorderApp
import Testing

/// PERF-06 regression suite: `CapturePolicyStore.load()` runs per captured
/// draft (100+/s), so it must memoize the decoded policy against the raw
/// defaults blob while staying correct for every writer:
/// - repeated loads with unchanged bytes return the same policy without
///   re-decoding,
/// - saves are visible immediately (write-through),
/// - external mutation of the underlying defaults Data is picked up on the
///   next load (byte-compare guard),
/// - absent/corrupt data falls back to `.standard` exactly as before.
struct CapturePolicyStoreTests {
    /// Pinned key from CapturePolicyStore; tests write raw bytes directly to
    /// simulate external writers (`defaults write`, other processes).
    private static let policyKey = "capturePolicy"

    private func makeStore() -> (CapturePolicyStore, UserDefaults) {
        let suite = "test.capturepolicystore.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = CapturePolicyStore(defaults: defaults)
        return (store, defaults)
    }

    @Test func repeatedLoadWithUnchangedBytesReturnsSamePolicy() throws {
        let (store, _) = makeStore()
        var policy = CapturePolicy.standard
        policy.perApp = ["com.example.editor": .content]
        try store.save(policy)

        #expect(store.load() == policy)
        #expect(store.load() == policy)
        #expect(store.load() == CapturePolicy(
            defaultMode: .metadata,
            perApp: ["com.example.editor": .content]
        ))
    }

    @Test func saveIsVisibleImmediatelyOnNextLoad() throws {
        let (store, _) = makeStore()
        // Prime the cache with the default first (route() traffic before any edit).
        #expect(store.load() == .standard)

        var updated = CapturePolicy.standard
        updated.defaultMode = .off
        updated.perApp = ["com.example.chat": .content]
        try store.save(updated)

        #expect(store.load() == updated)
        #expect(store.load().mode(forBundleId: "com.example.chat") == .content)
        #expect(store.load().mode(forBundleId: "com.example.other") == .off)
    }

    @Test func externalDefaultsMutationIsPickedUpOnNextLoad() throws {
        let (store, defaults) = makeStore()
        var original = CapturePolicy.standard
        original.defaultMode = .metadata
        try store.save(original)
        #expect(store.load() == original)

        // External writer bypasses the store entirely: raw different bytes.
        var external = CapturePolicy.standard
        external.defaultMode = .content
        external.perApp = ["com.example.term": .off]
        let blob = try JSONEncoder().encode(external)
        defaults.set(blob, forKey: Self.policyKey)

        #expect(store.load() == external)
    }

    @Test func absentDataFallsBackToStandard() {
        let (store, _) = makeStore()
        #expect(store.load() == .standard)
    }

    @Test func corruptDataFallsBackToStandardAndRecoversAfterSave() throws {
        let (store, defaults) = makeStore()
        defaults.set(Data([0x00, 0x01, 0xFF]), forKey: Self.policyKey)
        #expect(store.load() == .standard)
        // Corrupt bytes unchanged → still the safe default.
        #expect(store.load() == .standard)

        var recovered = CapturePolicy.standard
        recovered.defaultMode = .content
        try store.save(recovered)
        #expect(store.load() == recovered)
    }
}
