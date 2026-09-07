import Foundation

/// Spawned-daemon lifecycle events surfaced to observers.
enum SupervisorEvent: Equatable, Sendable {
    case spawned(pid: Int32)
    case exited(code: Int32)
    /// Restart scheduled after `delaySeconds`; `consecutiveFailures` is 1-based.
    case restartScheduled(delaySeconds: Int, consecutiveFailures: Int)
    /// Ten consecutive failed starts — the recorder degrades, keeps spooling,
    /// and automatic restarting stops until an explicit user start.
    case degraded
}

/// Pure backoff policy per contracts: 1, 2, 5, 15, 30 s (capped at 30);
/// degraded state after 10 consecutive failures.
enum SupervisorPolicy {
    static let maxConsecutiveFailures = 10
    static let delays = [1, 2, 5, 15, 30]

    /// Delay before the restart that follows the Nth consecutive failure (1-based).
    static func delay(afterFailureAt attempt: Int) -> Int {
        let index = max(0, min(attempt - 1, delays.count - 1))
        return delays[index]
    }

    static func isDegraded(consecutiveFailures: Int) -> Bool {
        consecutiveFailures >= maxConsecutiveFailures
    }
}

/// Owns the daemon child process.
///
/// Concurrency note (`@unchecked Sendable`): every mutable field is guarded by
/// `stateLock`, and Process/termination callbacks hop through the serial
/// `eventQueue` before touching state or notifying observers. The daemon command
/// comes from `COMPUTER_HISTORY_DAEMON_CMD` (dev override) or falls back to the
/// comes from `COMPUTER_HISTORY_DAEMON_CMD` (dev override); packaged builds
/// will point it at the bundled daemon entry point when app packaging lands.
final class DaemonSupervisor: @unchecked Sendable {
    private let environmentKey = "COMPUTER_HISTORY_DAEMON_CMD"

    private let stateLock = NSLock()
    private var process: Process?
    private var stopped = false
    private var consecutiveFailures = 0

    private let eventQueue = DispatchQueue(label: "computer-history.supervisor")
    private let eventHandler: @Sendable (SupervisorEvent) -> Void
    private let scheduleRestart: @Sendable (_ delaySeconds: Int, @Sendable @escaping () -> Void) -> Void

    init(
        eventHandler: @escaping @Sendable (SupervisorEvent) -> Void,
        scheduleRestart: @escaping @Sendable (_ delaySeconds: Int, @Sendable @escaping () -> Void) -> Void =
            { delay, work in DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(delay), execute: work) }
    ) {
        self.eventHandler = eventHandler
        self.scheduleRestart = scheduleRestart
    }

    private func daemonArguments() -> [String]? {
        if let override = ProcessInfo.processInfo.environment[environmentKey], !override.isEmpty {
            return ["/bin/sh", "-c", override]
        }
        // Packaged builds will ship the daemon under Resources/daemon; until app
        // packaging exists this path simply does not exist and the supervisor
        // treats the missing command as a failed start (driving its backoff).
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let entry = resourceURL.appendingPathComponent("daemon/main.js")
        guard FileManager.default.fileExists(atPath: entry.path), let node = which("node") else { return nil }
        return [node, entry.path]
    }

    private func which(_ name: String) -> String? {
        let searchPaths = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin"
        for dir in searchPaths.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate.path
            }
        }
        return nil
    }

    func start() {
        eventQueue.async { [weak self] in
            guard let self else { return }
            stateLock.lock()
            // Explicit user start always recovers from a degraded failure streak.
            consecutiveFailures = 0
            stateLock.unlock()
            spawnIfNeeded()
        }
    }

    /// Synchronous teardown: terminates the daemon child before returning so a
    /// quitting app can never orphan it (applicationShouldTerminate awaits this).
    /// Grace period of 2s, then escalates to SIGKILL.
    func stop() {
        eventQueue.sync { [weak self] in
            guard let self else { return }
            stateLock.lock()
            stopped = true
            let running = process
            process = nil
            stateLock.unlock()
            guard let running else { return }
            if running.isRunning {
                running.terminate()
            }
            let deadline = Date().addingTimeInterval(2)
            while running.isRunning, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if running.isRunning {
                kill(running.processIdentifier, SIGKILL)
            }
        }
    }

    // MARK: - Internals (all called on eventQueue)

    private func spawnIfNeeded() {
        stateLock.lock()
        if stopped || process != nil {
            stateLock.unlock()
            return
        }
        stateLock.unlock()

        guard let arguments = daemonArguments() else {
            handleExit(code: nil)
            return
        }

        let spawned = Process()
        spawned.executableURL = URL(fileURLWithPath: arguments[0])
        spawned.arguments = Array(arguments.dropFirst())
        spawned.standardOutput = FileHandle.nullDevice
        spawned.standardError = FileHandle.nullDevice
        spawned.terminationHandler = { [weak self] terminated in
            guard let self else { return }
            eventQueue.async {
                // GateM0 finding 1 fix: decode the REAL termination status
                // instead of a hardcoded stub. Uncaught signals surface as a
                // negative code (-signal) so the UI can distinguish crashes
                // from clean non-zero exits.
                let status: Int32 = switch terminated.terminationReason {
                case .uncaughtSignal: -terminated.terminationStatus
                case .exit: terminated.terminationStatus
                @unknown default: terminated.terminationStatus
                }
                self.handleExit(code: status)
            }
        }
        do {
            try spawned.run()
        } catch {
            handleExit(code: nil)
            return
        }
        stateLock.lock()
        process = spawned
        // A successful launch ends the streak: only *consecutive* failures
        // drive backoff rungs and the degraded threshold.
        consecutiveFailures = 0
        stateLock.unlock()
        eventHandler(.spawned(pid: spawned.processIdentifier))
    }

    private func handleExit(code: Int32?) {
        stateLock.lock()
        process = nil
        if stopped {
            stateLock.unlock()
            return
        }
        consecutiveFailures += 1
        let failures = consecutiveFailures
        stateLock.unlock()

        eventHandler(.exited(code: code ?? -1))
        if SupervisorPolicy.isDegraded(consecutiveFailures: failures) {
            eventHandler(.degraded)
            // Spec §3.3: after ten consecutive failures the supervisor stops
            // restarting automatically; only an explicit user start resumes.
            return
        }
        let delay = SupervisorPolicy.delay(afterFailureAt: failures)
        eventHandler(.restartScheduled(delaySeconds: delay, consecutiveFailures: failures))
        scheduleRestart(delay) { [weak self] in
            guard let self else { return }
            eventQueue.async {
                self.spawnIfNeeded()
            }
        }
    }

    var currentConsecutiveFailures: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return consecutiveFailures
    }
}
