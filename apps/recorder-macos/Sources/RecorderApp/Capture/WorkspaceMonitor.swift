import AppKit

/// Watches foreground application switches via
/// `NSWorkspace.didActivateApplicationNotification` (spec §3.6) and reports
/// them as `ActivatedApp` values. The CaptureCoordinator owns the app_focus
/// draft, AX attach/detach, and input-monitor attribution decisions.
///
/// Concurrency note (`@unchecked Sendable`): the only mutable state (observer
/// token + handler) is guarded by `lock`; notifications are delivered on the
/// main queue and hop into the caller-provided `@Sendable` handler.
final class WorkspaceMonitor: @unchecked Sendable {
    /// Foreground application snapshot delivered on every workspace activation.
    struct ActivatedApp: Equatable, Sendable {
        let bundleId: String
        let name: String?
        let pid: pid_t
    }

    private let lock = NSLock()
    private var observer: NSObjectProtocol?
    private var handler: (@Sendable (ActivatedApp) -> Void)?

    /// Installs (or replaces) the activation handler. Safe before start().
    func setHandler(_ newHandler: @escaping @Sendable (ActivatedApp) -> Void) {
        lock.withLock { handler = newHandler }
    }

    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard
                let self,
                let running = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            let activated = ActivatedApp(
                bundleId: running.bundleIdentifier ?? "unknown",
                name: running.localizedName,
                pid: running.processIdentifier
            )
            lock.lock()
            let handler = handler
            lock.unlock()
            handler?(activated)
        }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observer = nil
        handler = nil
    }
}
