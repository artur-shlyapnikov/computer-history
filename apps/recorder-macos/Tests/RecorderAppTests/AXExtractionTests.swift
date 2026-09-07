import Foundation
@testable import RecorderApp
import Testing

/// Bounds tests for AX extraction (SW-05): every string an AX notification
/// contributes to a draft must be prefix-clamped at extraction time, so a
/// worst-case 100-event flush batch can never exceed the daemon's 1 MiB
/// framing cap (FrameCodec.maxPayloadSize). Live AXUIElement reads are NOT
/// verifiable here (no interactive permission grant in CI) — the clamp inside
/// `stringAttribute` shares its implementation shape with the pure paths
/// exercised below and is covered by smoke testing only.
struct AXExtractionTests {
    private let app = AppInfo(bundleId: "com.example.app", name: "Example", pid: 4242)

    /// Oversized input of every metadata flavor, all longer than any bound.
    private let oversized = String(repeating: "x", count: AXExtraction.maxValueLength + 5000)

    private func worstCaseDraft(action: EventAction) -> EventDraft {
        AXExtraction.makeDraft(
            attributes: .init(
                role: oversized,
                subrole: "AXTextField",
                label: oversized,
                identifier: oversized,
                title: oversized,
                value: nil
            ),
            action: action,
            app: app,
            windowTitle: oversized
        )
    }

    @Test("oversized window title is prefix-truncated to maxMetadataLength")
    func windowTitleClamped() {
        let draft = worstCaseDraft(action: .windowChange)
        #expect(draft.windowTitle?.count == AXExtraction.maxMetadataLength)
        #expect(oversized.count > AXExtraction.maxMetadataLength)
    }

    @Test("oversized target label and identifier are prefix-truncated")
    func targetMetadataClamped() {
        let draft = worstCaseDraft(action: .textChange)
        guard let target = draft.target else {
            Issue.record("draft must carry a target")
            return
        }
        #expect(target.label?.count == AXExtraction.maxMetadataLength)
        #expect(target.identifier?.count == AXExtraction.maxMetadataLength)
        #expect(target.role?.count == AXExtraction.maxMetadataLength)
        // Secure-field detection must survive subrole clamping (the pinned
        // spelling is far below the bound).
        #expect(target.subrole == "AXTextField")
        #expect(!draft.isSecureField)
    }

    @Test("metadata within the bound passes through untouched")
    func boundedMetadataUntouched() {
        let title = "Settings — General"
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: "AXButton", subrole: nil, label: "Save", identifier: "save-btn", title: nil, value: nil),
            action: .focusChange,
            app: app,
            windowTitle: title
        )
        #expect(draft.windowTitle == title)
        #expect(draft.target?.label == "Save")
        #expect(draft.target?.identifier == "save-btn")
    }

    @Test("nil metadata stays nil (no empty-string artifacts)")
    func nilMetadataStaysNil() {
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: nil, subrole: nil, label: nil, identifier: nil, title: nil, value: "hello"),
            action: .textChange,
            app: app,
            windowTitle: nil
        )
        #expect(draft.windowTitle == nil)
        #expect(draft.target?.label == nil)
        #expect(draft.target?.identifier == nil)
        #expect(draft.content == "hello")
    }

    @Test("worst-case 100-event flush batch encodes under the 1 MiB frame cap")
    func worstCaseBatchUnderFrameCap() throws {
        var events: [ActivityEvent] = []
        events.reserveCapacity(EventBuffer.flushEventCount)
        let filter = PrivacyFilter()
        for index in 0 ..< EventBuffer.flushEventCount {
            var draft = worstCaseDraft(
                action: index.isMultiple(of: 2) ? .windowChange : .textChange
            )
            // Worst-case wire event: metadata fields maxed AND content at the
            // largest length PrivacyFilter lets through (maxContentLength).
            draft.content = String(repeating: "a", count: PrivacyFilter.maxContentLength)
            guard let event = filter.apply(draft, mode: .content, captureSessionId: "test-session") else {
                Issue.record("worst-case draft must not be dropped")
                return
            }
            events.append(event)
        }

        let batch = EventBatch(
            protocolVersion: 1,
            messageId: Ulid.shared.next(),
            type: "event_batch",
            sentAt: 0,
            batchId: Ulid.shared.next(),
            events: events
        )
        let payload = try JSONEncoder().encode(batch)
        // The assertion that matters: this frame fits, so the daemon accepts
        // it instead of answering error.bad_frame and destroying the socket.
        #expect(payload.count <= FrameCodec.maxPayloadSize)
        _ = try FrameCodec.encode(payload: payload)
    }
}
