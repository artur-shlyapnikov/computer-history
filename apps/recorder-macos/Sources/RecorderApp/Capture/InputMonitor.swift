import ApplicationServices
import CoreGraphics
import Foundation

/// Listen-only CGEvent tap (spec §3.6): classifies keyboard/pointer activity
/// into semantic drafts WITHOUT ever reading any text payload from events.
///
/// Hard privacy rules enforced here:
/// - Keyboard events contribute keycode identity ONLY (via the virtual-keycode
///   table) — never what was typed. Final typed text comes exclusively from AX
///   value changes, filtered by PrivacyFilter.
/// - Modifier-only presses (flagsChanged) and key releases emit nothing.
/// - Mouse coordinates exist just long enough for one AX position hit-test,
///   then are discarded; they are never attached to drafts.
///
/// Concurrency note (`@unchecked Sendable`): the tap state is guarded by
/// `lock`; the C tap callback carries an `Unmanaged` context box (justified:
/// CoreFoundation C callbacks cannot capture Sendable closures) and hops work
/// onto a private serial queue before touching shared state.
final class InputMonitor: @unchecked Sendable {
    /// Surfaced as permission_missing in the UI (spec §3.26).
    enum MonitorError: Error, Equatable {
        case tapCreateFailed(String)
    }

    private let queue = DispatchQueue(label: "computer-history.input-monitor")
    private let lock = NSLock()
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var runLoop: RunLoop?
    /// Bumped under `lock` on every arm (start) and disarm (stop). The
    /// run-loop thread captures the value at spawn and re-checks it after
    /// acquiring the lock, so a stop() racing ahead of the body makes the
    /// body bail instead of registering/running an orphaned loop.
    private var generation = 0
    /// Context box referenced by the C callback; owned by the monitor so it
    /// always outlives the tap.
    private var tapContext: TapContext?
    /// Signaled exactly once by the tap run-loop thread when it has fully
    /// exited — either after `runLoop.run()` returns or on the
    /// generation-stale bail path. stop() waits on it before releasing the
    /// last strong reference to `tapContext`, so an in-flight C callback can
    /// never outlive the box it dereferences unretained.
    private var tapThreadDone: DispatchSemaphore?
    /// Generation handed to the most recently spawned tap run-loop thread;
    /// nil when no thread has been spawned yet. Guarded by `lock`.
    private var tapThreadSpawnGeneration: Int?
    /// True once the thread spawned for `tapThreadSpawnGeneration` has fully
    /// exited, tagged with the generation it belonged to. Both guarded by
    /// `lock`. Tagging prevents a descheduled thread from a PREVIOUS lifecycle
    /// (which can resume after a quick stop()+start()) from marking the
    /// CURRENT lifecycle's thread quiesced.
    private var tapThreadExited = false
    private var tapThreadExitedGeneration: Int?
    /// Testing-only seam (`WaveAudit17`): when armed, an exiting tap thread
    /// parks here before its final bookkeeping — standing in for a
    /// predecessor stalled past stop()'s bounded wait. Guarded by `lock`.
    fileprivate var exitGate: ExitGate?
    /// Foreground app kept fresh by CaptureCoordinator.
    private var currentApp = AppInfo(bundleId: "unknown", name: nil, pid: nil)

    /// Emits classified drafts; invoked on the private serial queue.
    var onDraft: (@Sendable (EventDraft) -> Void)?
    /// Called once when the tap cannot be created (missing permission).
    var onPermissionFailure: (@Sendable (MonitorError) -> Void)?

    // MARK: - Lifecycle

    /// Creates the tap and schedules it on a dedicated run-loop thread.
    /// Returns false when macOS denies tap creation (permission missing).
    @discardableResult
    func start() -> Bool {
        lock.lock()
        guard eventTap == nil else {
            lock.unlock()
            return true
        }

        let context = TapContext()
        context.monitor = self
        let callback: CGEventTapCallBack = { proxy, type, cgEvent, refcon in
            InputMonitor.tapCallback(proxy: proxy, type: type, event: cgEvent, refcon: refcon)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: Self.interestedMask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(context).toOpaque()
        ) else {
            lock.unlock()
            onPermissionFailure?(.tapCreateFailed("CGEvent.tapCreate returned nil"))
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CGEvent.tapEnable(tap: tap, enable: true)
        eventTap = tap
        runLoopSource = source
        tapContext = context
        // Invalidate any thread from a previous lifecycle and stamp this one.
        generation += 1
        let generation = generation
        let done = DispatchSemaphore(value: 0)
        tapThreadDone = done
        tapThreadSpawnGeneration = generation
        tapThreadExited = false
        tapThreadExitedGeneration = nil
        let thread = Thread { [weak self] in
            guard let self else {
                done.signal()
                return
            }
            tapThreadBody(generation: generation, done: done)
        }
        thread.name = "computer-history.input-tap"
        thread.start()
        lock.unlock()
        return true
    }

    /// Body of the tap run-loop thread spawned by start(). Split out of the
    /// start() closure so the testing seam can spawn an identical lifecycle
    /// without touching CGEventTap. `done` is signaled UNCONDITIONALLY on
    /// every path — the UAF guarantee in stop() rests on it.
    private func tapThreadBody(generation: Int, done: DispatchSemaphore) {
        let runLoop = RunLoop.current
        lock.lock()
        // A stop() landed between start() and here: bail WITHOUT
        // registering the loop or running it — otherwise stop() already
        // snapshotted nil and nothing would ever CFRunLoopStop this
        // thread's loop, leaking a blocked thread forever.
        guard self.generation == generation, let source = runLoopSource else {
            lock.unlock()
            recordExit(generation: generation)
            done.signal()
            return
        }
        self.runLoop = runLoop
        lock.unlock()
        CFRunLoopAddSource(runLoop.getCFRunLoop(), source, .defaultMode)
        runLoop.run()
        // The loop only exits via stop()'s CFRunLoopStop: no tap callback
        // can be running or scheduled on this thread past this point.
        recordExit(generation: generation)
        done.signal()
    }

    /// Final exit bookkeeping for a tap run-loop thread. The flag writes are
    /// GATED on slot ownership: a predecessor stalled past stop()'s bounded
    /// wait can resume after a newer lifecycle claimed the slot (newer
    /// `tapThreadSpawnGeneration`), and its stale write would otherwise tag
    /// the exit with a dead generation — wedging isTapThreadQuiesced at
    /// false for the now-current lifecycle (WaveAudit17 S-1). The caller
    /// still signals its own `done` unconditionally afterwards.
    private func recordExit(generation: Int) {
        lock.lock()
        let gate = exitGate
        lock.unlock()
        gate?.park()
        lock.lock()
        if tapThreadSpawnGeneration == generation {
            tapThreadExited = true
            tapThreadExitedGeneration = generation
        }
        lock.unlock()
    }

    // MARK: - Testing seams (quiesce-probe races; no CGEventTap involved)

    /// Spawns a lifecycle tap-run-loop thread exactly like start() does
    /// (same generation stamping, same body) WITHOUT creating a CGEventTap,
    /// so quiesce-probe tests run on machines denied input monitoring.
    /// Returns the new lifecycle's generation.
    @discardableResult
    func spawnLifecycleThreadForTesting() -> Int {
        lock.lock()
        generation += 1
        let generation = generation
        let done = DispatchSemaphore(value: 0)
        tapThreadDone = done
        tapThreadSpawnGeneration = generation
        tapThreadExited = false
        tapThreadExitedGeneration = nil
        let thread = Thread { [weak self] in
            guard let self else {
                done.signal()
                return
            }
            tapThreadBody(generation: generation, done: done)
        }
        thread.name = "computer-history.input-tap"
        thread.start()
        lock.unlock()
        return generation
    }

    /// Arms the exit gate: the NEXT exiting tap thread parks before its
    /// final bookkeeping until the gate is released, simulating a
    /// predecessor stalled past stop()'s bounded wait.
    func armExitGateForTesting() -> ExitGate {
        let gate = ExitGate()
        lock.lock()
        exitGate = gate
        lock.unlock()
        return gate
    }

    /// Disarms the exit gate for future exits; a thread already parked
    /// inside it stays parked until released.
    func disarmExitGateForTesting() {
        lock.lock()
        exitGate = nil
        lock.unlock()
    }

    /// Testing-only exit gate. `park()` announces itself on `entered`
    /// BEFORE blocking, letting tests order operations around the stall
    /// deterministically; `release()` lets the parked exit land.
    final class ExitGate: @unchecked Sendable {
        private let open = DispatchSemaphore(value: 0)
        let entered = DispatchSemaphore(value: 0)

        func park() {
            entered.signal()
            open.wait()
        }

        func release() {
            open.signal()
        }
    }

    func stop() {
        lock.lock()
        let tap = eventTap
        let source = runLoopSource
        let loop = runLoop
        // Strong local: the C callback dereferences this box UNRETAINED on
        // the tap run-loop thread. The last strong reference must outlive
        // every in-flight callback — it is released only after the quiesce
        // wait below confirms the tap thread has exited (scope exit).
        let context = tapContext
        defer { _ = context } // hold the last strong ref until after the wait
        eventTap = nil
        runLoopSource = nil
        runLoop = nil
        tapContext = nil
        let done = tapThreadDone
        tapThreadDone = nil
        // Any tap thread not yet past its lock section now sees a stale
        // generation and exits without registering or running its loop.
        generation += 1
        lock.unlock()

        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source, let loop {
            CFRunLoopRemoveSource(loop.getCFRunLoop(), source, .defaultMode)
        }
        if let loop {
            CFRunLoopStop(loop.getCFRunLoop())
        }
        // Quiesce: CFMachPortInvalidate only prevents NEW callbacks and
        // CFRunLoopStop is asynchronous, so a callback already dispatched on
        // the tap thread may still sit between Unmanaged.fromOpaque(...) and
        // the unretained dereference of `context`. Block until that thread
        // signals exit so the strong local above cannot drop under it.
        // Bounded so a pathologically wedged thread cannot hang stop().
        _ = done?.wait(timeout: .now() + 10)
    }

    func updateCurrentApp(_ app: AppInfo) {
        queue.async { [weak self] in
            self?.currentApp = app
        }
    }

    /// Observability/test hook: the run loop registered by the tap thread,
    /// if one is currently live. Nil whenever the monitor is stopped —
    /// including when a start→stop race lands before the thread body.
    var activeRunLoop: RunLoop? {
        lock.lock()
        defer { lock.unlock() }
        return runLoop
    }

    /// True once the current lifecycle's tap run-loop thread has fully
    /// exited, or when no tap thread was ever spawned for the current state
    /// (fresh monitor, or start() failed because tap creation was denied —
    /// the no-permission path spawns nothing, so quiescence holds trivially).
    /// Non-consuming probe used by teardown tests to assert stop() quiesced
    /// the tap thread. Generation-tagged: an exit recorded by a thread from
    /// a previous lifecycle never marks this one quiesced.
    var isTapThreadQuiesced: Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let spawned = tapThreadSpawnGeneration else { return true }
        return tapThreadExited && tapThreadExitedGeneration == spawned
    }

    private static var interestedMask: CGEventMask {
        (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
    }

    // MARK: - Tap callback (C convention; no captures allowed)

    /// Returns the event untouched (`.listenOnly` observes, never modifies).
    private static func tapCallback(
        proxy _: CGEventTapProxy,
        type: CGEventType,
        event: CGEvent,
        refcon: UnsafeMutableRawPointer?
    ) -> Unmanaged<CGEvent>? {
        let monitor = refcon.map {
            Unmanaged<TapContext>.fromOpaque($0).takeUnretainedValue().monitor
        } ?? nil

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            monitor?.reenableTap()
        }

        // Classify off the callback thread: the click path performs a
        // synchronous AX position hit-test that must not stall input delivery.
        let keyCode = UInt32(bitPattern: Int32(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode)))
        let flags = event.flags
        let point = event.location

        monitor?.queue.async { [weak monitor] in
            monitor?.classify(type: type, keyCode: keyCode, flags: flags, at: point)
        }
        return Unmanaged.passUnretained(event)
    }

    private func reenableTap() {
        lock.lock()
        let tap = eventTap
        lock.unlock()
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    // MARK: - Classification (runs on the private serial queue)

    private func classify(type: CGEventType, keyCode: UInt32, flags: CGEventFlags, at point: CGPoint) {
        switch type {
        case .keyDown:
            if Self.hasShortcutModifiers(flags) {
                onDraft?(EventDraft(
                    source: .input,
                    action: .shortcut,
                    app: currentApp,
                    target: TargetInfo(
                        role: "key",
                        subrole: nil,
                        label: Self.shortcutDescription(keyCode: keyCode, flags: flags),
                        identifier: nil
                    )
                ))
            } else {
                // Plain keystroke: an activity signal only. No text passes.
                onDraft?(EventDraft(source: .input, action: .typingActivity, app: currentApp))
            }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            // One best-effort AX hit-test at the pointer position; the
            // coordinates themselves are discarded inside hitTest(by design).
            let target = Self.hitTest(at: point)
            onDraft?(EventDraft(source: .input, action: .click, app: currentApp, target: target))
        case .scrollWheel:
            onDraft?(EventDraft(source: .input, action: .scroll, app: currentApp))
        default:
            break // keyUp, flagsChanged, anything else: deliberately silent
        }
    }

    // MARK: - Pure helpers (unit-tested)

    /// Cmd/Ctrl/Option held → shortcut; plain keys stay typing_activity.
    static func hasShortcutModifiers(_ flags: CGEventFlags) -> Bool {
        !flags.isDisjoint(with: [.maskCommand, .maskControl, .maskAlternate])
    }

    /// Normalized "cmd+shift+c"-style description in fixed modifier order
    /// (ctrl, opt, shift, cmd), built purely from the keycode table.
    static func shortcutDescription(keyCode: UInt32, flags: CGEventFlags) -> String {
        var parts: [String] = []
        if flags.contains(.maskControl) {
            parts.append("ctrl")
        }
        if flags.contains(.maskAlternate) {
            parts.append("opt")
        }
        if flags.contains(.maskShift) {
            parts.append("shift")
        }
        if flags.contains(.maskCommand) {
            parts.append("cmd")
        }
        parts.append(KeyCodeNames.name(for: keyCode) ?? "key\(keyCode)")
        return parts.joined(separator: "+")
    }

    /// AX element under the pointer: role/subrole/label/identifier only.
    /// Coordinates die inside this function by construction.
    static func hitTest(at point: CGPoint) -> TargetInfo? {
        let systemWide = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
        guard result == .success, let element else { return nil }
        // ARC manages the copied AXUIElement; nothing to release manually.
        return AXExtraction.targetInfo(from: element)
    }
}

/// Refcon box for the C tap callback. `@unchecked Sendable` justification:
/// the box is immutable after arming (a weak reference); the C callback ABI
/// cannot express Sendable closures.
private final class TapContext: @unchecked Sendable {
    fileprivate weak var monitor: InputMonitor?

    init() {}
}

extension OptionSet where RawValue: FixedWidthInteger {
    /// Set-style disjointness test for option sets (rawValue AND is zero).
    func isDisjoint(with other: Self) -> Bool {
        rawValue & other.rawValue == 0
    }
}
