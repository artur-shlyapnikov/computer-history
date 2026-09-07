import Foundation

/// Persists the CapturePolicy in UserDefaults under the pinned suite
/// "com.computer-history.recorder" (brief S1 item 2).
///
/// Concurrency note (`@unchecked Sendable`): UserDefaults is thread-safe; the
/// lock only serializes read-modify-write updates of the whole policy blob.
///
/// Performance note: `route()` calls `load()` per captured draft (100+/s), so
/// the decoded policy is memoized against the raw defaults blob: re-decoding
/// happens only when the stored bytes change (external writers like
/// `defaults write` stay correct at trivial byte-compare cost). Every write
/// path refreshes the cache write-through, so edits apply immediately.
final class CapturePolicyStore: @unchecked Sendable {
    static let suiteName = "com.computer-history.recorder"
    private static let policyKey = "capturePolicy"

    private let defaults: UserDefaults
    private let lock = NSLock()

    /// Raw blob the cached policy was decoded from (`nil` = absent in defaults).
    private var cachedBlob: Data?
    /// Policy decoded from `cachedBlob`; nil until the first load/save.
    private var cachedPolicy: CapturePolicy?

    /// Production initializer backed by the pinned persistence suite.
    convenience init() {
        // UserDefaults(suiteName:) returns nil only on pathological sandbox
        // misconfiguration; fall back to standard defaults rather than crash.
        self.init(defaults: UserDefaults(suiteName: Self.suiteName) ?? .standard)
    }

    /// Testable initializer with injected defaults.
    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    func load() -> CapturePolicy {
        lock.lock()
        defer { lock.unlock() }
        let data = defaults.data(forKey: Self.policyKey)
        if let cachedPolicy, cachedBlob == data {
            return cachedPolicy
        }
        let policy: CapturePolicy
        if let data {
            do {
                policy = try JSONDecoder().decode(CapturePolicy.self, from: data)
            } catch {
                // A corrupted blob must never take recording down; fall back to
                // the safe default (metadata everywhere).
                policy = .standard
            }
        } else {
            policy = .standard
        }
        cachedBlob = data
        cachedPolicy = policy
        return policy
    }

    func save(_ policy: CapturePolicy) throws {
        let data = try JSONEncoder().encode(policy)
        lock.lock()
        defer { lock.unlock() }
        defaults.set(data, forKey: Self.policyKey)
        cachedBlob = data
        cachedPolicy = policy
    }
}
