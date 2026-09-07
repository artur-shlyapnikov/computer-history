import ApplicationServices
import Foundation

/// Minimal Accessibility attribute extraction shared by AXMonitor and the
/// InputMonitor click hit-test (spec §3.6: minimal extraction, NO tree dumps,
/// NO caching of values beyond the event).
///
/// Pure mapping helpers here are unit-testable without permissions; the
/// AXUIElement-reading entry points require a live session and are only
/// smoke-tested (documented honestly in the test suite).
enum AXExtraction {
    /// The macOS subrole that marks password/secure text fields. When set,
    /// kAXValueAttribute is NEVER copied — the value is not even read into
    /// memory, let alone sent anywhere.
    static let secureFieldSubrole = "AXSecureTextField"

    /// Upper bound on any single AX attribute value copied into a draft.
    /// Editors and browsers can expose megabyte-sized values; unbounded AX
    /// text must never enter the capture pipeline, so the read is clamped
    /// here, before anything downstream (scrubbing, spooling) sees it.
    static let maxValueLength = 100_000

    /// Upper bound on AX-sourced *metadata* strings (window titles, target
    /// roles/subroles, labels, identifiers). Unlike `content` — which
    /// PrivacyFilter bounds before anything reaches the wire — these fields
    /// flow to the daemon verbatim, so unbounded values would let a single
    /// 100-event flush batch (EventBuffer.flushEventCount) exceed the 1 MiB
    /// frame cap (FrameCodec.maxPayloadSize); the daemon answers
    /// error.bad_frame and destroys the connection, spooling the batch into a
    /// disconnect loop that blocks every spool file behind it. 1000 chars
    /// per field keeps the worst-case flush batch far below the cap while
    /// preserving ample context for classification.
    static let maxMetadataLength = 1000

    static func isSecureSubrole(_ subrole: String?) -> Bool {
        subrole == secureFieldSubrole
    }

    /// Prefix-truncation applied to every string copied into a draft; `nil`
    /// passes through untouched. Same discipline as `value` handling.
    private static func clamped(_ string: String?, to limit: Int) -> String? {
        string.map { String($0.prefix(limit)) }
    }

    // MARK: - Attribute readers (call on MainActor / tap queue only)

    /// Upper bound (seconds) on how long any single attribute copy may stall
    /// the calling thread. Every read here runs on the main actor or the tap
    /// queue; against a hung/busy target app an unbounded
    /// AXUIElementCopyAttributeValue blocks UI (or capture) for the system
    /// default — seconds. 50ms per attribute keeps a full 5-read
    /// targetInfo+value extraction ≈250ms worst case while leaving slow-but-
    /// healthy apps ample headroom (healthy answers are sub-millisecond).
    /// SetMessagingTimeout is a local property of the element ref (no IPC),
    /// so re-arming per read is idempotent and near-free.
    static let messagingTimeout: Float = 0.05

    static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        AXUIElementSetMessagingTimeout(element, messagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        // The AX API always copies the whole attribute; clamp immediately so
        // no multi-megabyte string is ever stored, regex-scanned, or spooled.
        return (value as? String).map { String($0.prefix(maxValueLength)) }
    }

    static func role(_ element: AXUIElement) -> String? {
        stringAttribute(element, kAXRoleAttribute)
    }

    static func subrole(_ element: AXUIElement) -> String? {
        stringAttribute(element, kAXSubroleAttribute)
    }

    static func label(_ element: AXUIElement) -> String? {
        stringAttribute(element, kAXDescriptionAttribute) ?? stringAttribute(element, kAXTitleAttribute)
    }

    static func identifier(_ element: AXUIElement) -> String? {
        stringAttribute(element, kAXIdentifierAttribute)
    }

    /// Target metadata for a draft; never includes any text value.
    static func targetInfo(from element: AXUIElement) -> TargetInfo {
        TargetInfo(
            role: clamped(role(element), to: maxMetadataLength),
            subrole: clamped(subrole(element), to: maxMetadataLength),
            label: clamped(label(element), to: maxMetadataLength),
            identifier: clamped(identifier(element), to: maxMetadataLength)
        )
    }

    // MARK: - Draft construction from extracted attributes

    /// What the monitor observed about one AX notification, already reduced to
    /// plain values so tests can exercise draft construction without live AX.
    struct ObservedAttributes {
        var role: String?
        var subrole: String?
        var label: String?
        var identifier: String?
        var title: String?
        /// Text value; MUST be nil when `subrole` is the secure-field subrole.
        var value: String?
    }

    /// Builds a draft from observed attributes. Secure fields are flagged so
    /// PrivacyFilter redacts with precedence over every other rule.
    static func makeDraft(
        attributes: ObservedAttributes,
        action: EventAction,
        app: AppInfo,
        windowTitle: String?
    ) -> EventDraft {
        let secure = isSecureSubrole(attributes.subrole)
        let value = attributes.value.map { String($0.prefix(maxValueLength)) }
        return EventDraft(
            source: .accessibility,
            action: action,
            app: app,
            windowTitle: clamped(windowTitle, to: maxMetadataLength),
            target: TargetInfo(
                role: clamped(attributes.role, to: maxMetadataLength),
                subrole: clamped(attributes.subrole, to: maxMetadataLength),
                label: clamped(attributes.label, to: maxMetadataLength),
                identifier: clamped(attributes.identifier, to: maxMetadataLength)
            ),
            content: secure ? nil : value,
            isSecureField: secure
        )
    }
}
