import Foundation

/// Per-application capture mode (spec §3.7): off | metadata | content.
/// Default for every app is `metadata` (contracts §Swift app conventions).
enum CaptureMode: String, Codable, Equatable, Sendable, CaseIterable {
    case off
    case metadata
    case content
}

/// Capture policy: default mode plus an optional per-app override map.
struct CapturePolicy: Codable, Equatable, Sendable {
    var defaultMode: CaptureMode
    /// bundleId → mode override.
    var perApp: [String: CaptureMode]

    static let standard = CapturePolicy(defaultMode: .metadata, perApp: [:])

    init(defaultMode: CaptureMode = .metadata, perApp: [String: CaptureMode] = [:]) {
        self.defaultMode = defaultMode
        self.perApp = perApp
    }

    /// Effective mode for an application bundle id.
    func mode(forBundleId bundleId: String) -> CaptureMode {
        perApp[bundleId] ?? defaultMode
    }
}
