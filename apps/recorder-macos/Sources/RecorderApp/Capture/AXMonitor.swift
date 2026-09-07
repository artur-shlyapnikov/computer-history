import AppKit
import ApplicationServices
import Foundation

/// Accessibility observation (spec §3.6): one AXObserver per pid watching the
/// app element and its focused element. Callbacks perform MINIMAL extraction
/// (role/subrole/label/identifier/title/value), build drafts, and hand them to
/// the coordinator — persistence/IPC happens only downstream in the filter and
/// buffer actor.
///
/// Swift 6 isolation: the class is @MainActor; every C callback hops onto the
/// main queue before touching state. The observer context box carries only a
/// pid + weak monitor reference (Sendability justification inline).
@MainActor
final class AXMonitor {
    /// Surfaced as permission_missing in the UI.
    struct PermissionDenied: Error, Equatable {}

    /// Wire-stable AX notification names (kAX…Notification constants as
    /// Strings — these literal spellings are pinned by macOS).
    private enum Notifications {
        static let focusedWindow = "AXFocusedWindowChanged"
        static let mainWindow = "AXMainWindowChanged"
        static let title = "AXTitleChanged"
        static let focusedUIElement = "AXFocusedUIElementChanged"
        static let value = "AXValueChanged"
    }

    private var observers: [pid_t: ObserverSet] = [:]

    /// Per-pid AppInfo cache. NSRunningApplication(processIdentifier:) is a
    /// relatively expensive window-server consult, and processNotification
    /// resolves app info per AX event on the main actor — resolve once per
    /// pid; invalidate on detach/pid-death/stop so a recycled pid (possibly
    /// running a different app) re-resolves fresh.
    private var appInfoCache: [pid_t: AppInfo] = [:]
    /// Injectable lookup seam (tests swap in a counting fake); defaults to
    /// the real NSRunningApplication consult with the documented
    /// unknown/nil fallbacks for dead or unidentified pids.
    var appInfoLookup: @MainActor (_ pid: pid_t) -> AppInfo = { pid in
        if let running = NSRunningApplication(processIdentifier: pid) {
            return AppInfo(
                bundleId: running.bundleIdentifier ?? "unknown",
                name: running.localizedName,
                pid: Int64(pid)
            )
        }
        return AppInfo(bundleId: "unknown", name: nil, pid: Int64(pid))
    }

    /// Drafts extracted from AX notifications; invoked on the main actor.
    var onDrafts: (@MainActor ([EventDraft]) -> Void)?
    /// Set when a pid's observer cannot attach (process died mid-attach etc.);
    /// informational — cleanup goes through detach(pid).
    var onAttachFailed: (@MainActor (pid_t) -> Void)?
    /// Fired when an AX call returns a code proving the Accessibility trust
    /// relationship is GONE at runtime (revocation / tap invalidation). The
    /// coordinator stops capture and starts the 30 s recheck loop.
    var onTrustFailure: (@MainActor () -> Void)?

    init() {}

    // MARK: - Permission

    /// AX codes that prove the trust relationship is gone at runtime. Only
    /// `apiDisabled` qualifies: TCC revocation surfaces as apiDisabled.
    /// `cannotComplete` must NOT be treated as trust loss — it also fires for
    /// any hung/busy/mid-launch app with the grant intact, and firing the
    /// gate on it stops healthy monitors and blacks out capture until the
    /// next 30 s tick. Those failures are skipped; later AX events retry.
    nonisolated static func indicatesTrustLoss(_ code: AXError) -> Bool {
        switch code {
        case .apiDisabled: true
        default: false
        }
    }

    private func reportTrustFailure() {
        onTrustFailure?()
    }

    /// Prompt-once trust check (brief S1 item 7). `prompt` true shows the
    /// system prompt on first call; later calls just read state.
    nonisolated static func checkPermission(prompt: Bool) -> Bool {
        // Literal key avoids referencing the non-Sendable global
        // kAXTrustedCheckOptionPrompt under strict concurrency; the value is
        // pinned by HIToolbox ("AXTrustedCheckOptionPrompt").
        let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Attach / detach

    func attach(pid: pid_t) {
        guard observers[pid] == nil else { return }

        let appElement = AXUIElementCreateApplication(pid)
        var observer: AXObserver?
        let result = AXObserverCreate(pid, axCallback, &observer)
        guard result == .success, let observer else {
            // apiDisabled here means trust was revoked between the launch
            // check and this attach; anything else is a dead/protected pid.
            if Self.indicatesTrustLoss(result) {
                reportTrustFailure()
            }
            onAttachFailed?(pid)
            return
        }
        // The observer must be hosted by a run loop; the main run loop matches
        // the @MainActor isolation of the draft handler.
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)

        let set = ObserverSet(pid: pid, observer: observer, appElement: appElement)
        // Bound app-element attribute stalls (refreshFocusedElement reads
        // kAXFocusedUIElementAttribute directly, bypassing AXExtraction's
        // per-read bound). Callback/focused-element refs are bounded per read
        // inside AXExtraction.stringAttribute.
        AXUIElementSetMessagingTimeout(appElement, AXExtraction.messagingTimeout)
        // App-level notifications: focused/main window changes + title churn.
        observe(set, element: appElement, notification: Notifications.focusedWindow)
        observe(set, element: appElement, notification: Notifications.mainWindow)
        observe(set, element: appElement, notification: Notifications.title)
        observe(set, element: appElement, notification: Notifications.focusedUIElement)

        // Track the focused element so text edits reach the value hook.
        refreshFocusedElement(set)

        observers[pid] = set
    }

    func detach(pid: pid_t) {
        // Clear even when no observer is attached: a recycled pid must
        // re-resolve its AppInfo fresh.
        appInfoCache.removeValue(forKey: pid)
        guard let set = observers.removeValue(forKey: pid) else { return }
        // Dropping the last reference to the observer tears down every
        // registration it carried; ARC releases copied element refs. Only the
        // run-loop source needs explicit removal.
        set.registrations.removeAll()
        set.focusedElement = nil
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(set.observer), .defaultMode)
    }

    /// Called when NSWorkspace reports the app is gone; doubles as the
    /// pid-death cleanup path (dead pids fail their first AX call → detach).
    func handlePidDeath(pid: pid_t) {
        detach(pid: pid)
    }

    /// Tears down every tracked pid's observer (pause/stop lifecycle paths):
    /// run-loop sources removed, registrations and retained element refs
    func stopAll() {
        for pid in Array(observers.keys) {
            detach(pid: pid)
        }
        // detach already drops per-pid entries; this also covers any pids
        // whose observer was never attached but whose info was resolved.
        appInfoCache.removeAll()
    }

    var attachedPids: [pid_t] {
        Array(observers.keys.sorted())
    }

    // MARK: - Observation plumbing

    private final class ObserverSet {
        /// One live AXObserver registration: a notification on an element,
        /// plus its refcon box (kept alive for the registration's lifetime).
        struct Subscription {
            let notification: String
            let box: ContextBox
        }

        typealias Registration = (element: AXUIElement, subscriptions: [Subscription])

        let pid: pid_t
        let observer: AXObserver
        let appElement: AXUIElement
        /// element identity → registered notifications (AXUIElement is not
        /// reliably Hashable across SDKs, so keys are object identities).
        var registrations: [ObjectIdentifier: Registration] = [:]
        var focusedElement: AXUIElement?

        init(pid: pid_t, observer: AXObserver, appElement: AXUIElement) {
            self.pid = pid
            self.observer = observer
            self.appElement = appElement
        }
    }

    private func observe(_ set: ObserverSet, element: AXUIElement, notification: String) {
        let box = ContextBox(pid: set.pid, monitor: self)
        let result = AXObserverAddNotification(
            set.observer,
            element,
            notification as CFString,
            Unmanaged.passUnretained(box).toOpaque()
        )
        guard result == .success else {
            // A live registration failing with apiDisabled is the runtime
            // revocation signal; cannotComplete is a busy/hung app and is
            // skipped (later events retry).
            if Self.indicatesTrustLoss(result) {
                reportTrustFailure()
            }
            return
        }
        set.registrations[ObjectIdentifier(element), default: (element, [])].subscriptions
            .append(ObserverSet.Subscription(notification: notification, box: box))
    }

    /// Unsubscribes every tracked notification from an element and drops its
    /// registration + refcon box. Called when focus moves off the previous
    /// focused element so registrations, retained element refs, and context
    /// boxes don't accumulate in focus-churning apps.
    private func unsubscribe(_ set: ObserverSet, element: AXUIElement) {
        guard let registration = set.registrations.removeValue(forKey: ObjectIdentifier(element)) else { return }
        for subscription in registration.subscriptions {
            AXObserverRemoveNotification(set.observer, element, subscription.notification as CFString)
        }
    }

    /// Re-reads kAXFocusedUIElementAttribute and (re)subscribes its value /
    /// focused-element notifications. The previously focused element is
    /// unsubscribed first; each newly focused element is retained once (the
    /// copied reference) and released when focus moves on or at detach.
    private func refreshFocusedElement(_ set: ObserverSet) {
        var focused: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(
            set.appElement,
            kAXFocusedUIElementAttribute as CFString,
            &focused
        )
        guard code == .success, let focused else {
            if Self.indicatesTrustLoss(code) {
                reportTrustFailure()
            }
            return
        }
        // kAXFocusedUIElementAttribute always yields an AXUIElement on success;
        // anything else violates the AX API contract, so trap exactly like the
        // previous force-cast did.
        let element = unsafeDowncast(focused, to: AXUIElement.self)
        if let previous = set.focusedElement, ObjectIdentifier(previous) != ObjectIdentifier(element) {
            unsubscribe(set, element: previous)
        }
        set.focusedElement = element
        observe(set, element: element, notification: Notifications.value)
        observe(set, element: element, notification: Notifications.focusedUIElement)
    }

    // MARK: - C callback

    /// Refcon payload for AX callbacks. `@unchecked Sendable` justification:
    /// immutable after creation except a weak monitor ref; AX's C ABI cannot
    /// carry Sendable closures, and the callback immediately hops to MainActor.
    private final class ContextBox: @unchecked Sendable {
        let pid: pid_t
        weak var monitor: AXMonitor?

        init(pid: pid_t, monitor: AXMonitor) {
            self.pid = pid
            self.monitor = monitor
        }
    }

    fileprivate nonisolated static func handleCallback(
        _: AXObserver,
        _ element: AXUIElement,
        _ notification: String,
        _ refcon: UnsafeMutableRawPointer?
    ) {
        // nonisolated(unsafe) transfers: the AXUIElement/String arrive from a
        // C callback that has no concurrency domain; the async hop below is
        // the ONLY consumer and runs exclusively on the main actor, so no
        // data race is possible. Swift 6 cannot prove this across the queue
        // boundary, so the locals are explicitly annotated.
        let box = refcon.map { Unmanaged<ContextBox>.fromOpaque($0).takeUnretainedValue() }
        nonisolated(unsafe) let element = element
        let notification = notification
        let pid = box?.pid ?? 0
        let weakMonitor = box?.monitor
        DispatchQueue.main.async {
            guard let monitor = weakMonitor else { return }
            MainActor.assumeIsolated {
                monitor.processNotification(notification, element: element, pid: pid)
            }
        }
    }

    // MARK: - Notification handling (main actor)

    private func processNotification(_ notification: String, element: AXUIElement, pid: pid_t) {
        guard let set = observers[pid] else { return } // detached meanwhile
        let app = appInfo(for: pid)
        let target = AXExtraction.targetInfo(from: element)
        let secure = AXExtraction.isSecureSubrole(target.subrole)

        switch notification {
        case Notifications.title, Notifications.mainWindow, Notifications.focusedWindow:
            // Window context change: title metadata only, never content.
            let title = secure ? nil : AXExtraction.stringAttribute(element, kAXTitleAttribute)
            emit(AXExtraction.makeDraft(
                attributes: .init(role: target.role, subrole: target.subrole, label: target.label, identifier: target.identifier, title: title, value: nil),
                action: .windowChange,
                app: app,
                windowTitle: title
            ))
            if notification == Notifications.focusedWindow || notification == Notifications.mainWindow {
                refreshFocusedElement(set)
            }
        case Notifications.focusedUIElement:
            refreshFocusedElement(set)
            emit(AXExtraction.makeDraft(
                attributes: .init(role: target.role, subrole: target.subrole, label: target.label, identifier: target.identifier, title: nil, value: nil),
                action: .focusChange,
                app: app,
                windowTitle: nil
            ))
        case Notifications.value:
            // THE critical branch: secure fields are flagged WITHOUT copying
            // their value — the value attribute is simply never requested.
            let value: String? = secure ? nil : AXExtraction.stringAttribute(element, kAXValueAttribute)
            emit(AXExtraction.makeDraft(
                attributes: .init(role: target.role, subrole: target.subrole, label: target.label, identifier: target.identifier, title: nil, value: value),
                action: .textChange,
                app: app,
                windowTitle: nil
            ))
        default:
            break
        }
    }

    private func emit(_ draft: EventDraft) {
        onDrafts?([draft])
    }

    /// Cached resolution: one NSRunningApplication consult per pid until the
    /// entry is invalidated (detach/pid-death/stop). Internal for tests.
    func appInfo(for pid: pid_t) -> AppInfo {
        if let cached = appInfoCache[pid] {
            return cached
        }
        let info = appInfoLookup(pid)
        appInfoCache[pid] = info
        return info
    }

    /// Test-only visibility into cache occupancy.
    var cachedAppInfoCount: Int {
        appInfoCache.count
    }
}

/// Top-level C-convention trampoline (AXObserverCreate takes a plain function
/// pointer; captures are not permitted there).
private func axCallback(
    _ observer: AXObserver,
    element: AXUIElement,
    notification: CFString,
    refcon: UnsafeMutableRawPointer?
) {
    AXMonitor.handleCallback(observer, element, notification as String, refcon)
}
