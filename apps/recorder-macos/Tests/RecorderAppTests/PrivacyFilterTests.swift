import Foundation
@testable import RecorderApp
import Testing

/// Exhaustive PrivacyFilter suite (brief S1 item 12): every rule — off-app
/// tombstone, secure-field precedence, sensitive labels, PEM blocks, API keys,
/// Luhn cards, oversize, metadata stripping — with a pinned clock and pinned
/// event ids so assertions are deterministic.
struct PrivacyFilterTests {
    private let clock = CaptureClock(nowMs: { 1_700_000_000_000 }, monotonicNs: { 42 })
    private let session = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    private func filter() -> PrivacyFilter {
        PrivacyFilter(clock: clock)
    }

    private func draft(
        target: TargetInfo? = nil,
        window: String? = "Untitled",
        content: String? = nil,
        isSecure: Bool = false,
        action: EventAction = .textChange,
        source: EventSource = .accessibility
    ) -> EventDraft {
        EventDraft(
            source: source,
            action: action,
            app: AppInfo(bundleId: "com.example.app", name: "Example", pid: 4242),
            windowTitle: window,
            target: target,
            content: content,
            isSecureField: isSecure
        )
    }

    // MARK: - Rule 1: excluded app tombstone

    @Test("off mode yields a tombstone carrying only the exclusion fact")
    func offModeTombstone() throws {
        let event = filter().apply(
            draft(
                target: TargetInfo(role: "AXButton", subrole: nil, label: "Save", identifier: "save-btn"),
                window: "Secret Document — Q3",
                content: "nothing should survive",
                action: .click
            ),
            mode: .off,
            captureSessionId: session
        )
        let tombstone = try #require(event)
        #expect(tombstone.contentPolicy == .excludedApp)
        #expect(tombstone.content == nil)
        #expect(tombstone.target == nil)
        #expect(tombstone.window?.title == nil)
        #expect(tombstone.action == .click) // action itself is preserved
        #expect(tombstone.app.bundleId == "com.example.app")
        #expect(tombstone.id.count == 26)
        #expect(tombstone.observedAt == 1_700_000_000_000)
        #expect(tombstone.monotonicNs == 42)
    }

    // MARK: - Rule 2: secure field (precedence over everything else)

    @Test("secure-field flag redacts without consulting the value")
    func secureFlagRedacts() throws {
        let event = try #require(filter().apply(
            draft(content: "hunter2", isSecure: true),
            mode: .content,
            captureSessionId: session
        ))
        #expect(event.contentPolicy == .redactedSecureField)
        #expect(event.content == nil)
    }

    @Test("AXSecureTextField subrole redacts even without the monitor flag")
    func secureSubroleRedacts() throws {
        let event = filter().apply(
            draft(
                target: TargetInfo(role: "AXTextField", subrole: "AXSecureTextField", label: nil, identifier: nil),
                content: "s3cret!"
            ),
            mode: .content,
            captureSessionId: session
        )
        let secured = try #require(event)
        #expect(secured.contentPolicy == .redactedSecureField)
        #expect(secured.content == nil)
    }

    @Test("secure field beats sensitive label AND survives metadata mode")
    func secureFieldPrecedence() {
        let secureLabeled = draft(
            target: TargetInfo(role: "AXTextField", subrole: "AXSecureTextField", label: "Password", identifier: nil),
            content: "hunter2",
            isSecure: true
        )
        #expect(filter().apply(secureLabeled, mode: .content, captureSessionId: session)?.contentPolicy == .redactedSecureField)
        // Metadata mode must NOT downgrade the secure-field signal to metadata_only.
        #expect(filter().apply(secureLabeled, mode: .metadata, captureSessionId: session)?.contentPolicy == .redactedSecureField)
    }

    // MARK: - Rule 3: sensitive labels

    @Test("every pinned sensitive label word triggers redaction")
    func sensitiveLabelsTrigger() {
        let words = [
            "password", "passwd", "passcode", "pin", "otp", "2fa", "token",
            "secret", "api key", "private key", "cvv", "credit card",
            "seed phrase", "recovery phrase",
        ]
        for word in words {
            let event = filter().apply(
                draft(
                    target: TargetInfo(role: "AXTextField", subrole: nil, label: "Enter \(word) here", identifier: nil),
                    content: "typed-value"
                ),
                mode: .content,
                captureSessionId: session
            )
            #expect(event?.contentPolicy == .redactedSensitiveLabel, "word '\(word)' must redact")
            #expect(event?.content == nil, "word '\(word)' must drop content")
        }
    }

    @Test("label matching is case-insensitive and word-bounded")
    func sensitiveLabelBoundaries() {
        let labeled = { (label: String) -> EventDraft in
            draft(
                target: TargetInfo(role: "AXTextField", subrole: nil, label: label, identifier: nil),
                content: "x"
            )
        }
        #expect(filter().apply(labeled("PASSWORD"), mode: .content, captureSessionId: session)?.contentPolicy == .redactedSensitiveLabel)
        #expect(filter().apply(labeled("Api-Key"), mode: .content, captureSessionId: session)?.contentPolicy == .redactedSensitiveLabel)
        // Word boundary: substrings must NOT match.
        #expect(filter().apply(labeled("pinned note"), mode: .content, captureSessionId: session)?.contentPolicy == .allow)
        #expect(filter().apply(labeled("tokenize assets"), mode: .content, captureSessionId: session)?.contentPolicy == .allow)
    }

    @Test("sensitive label also matches identifier and window title")
    func sensitiveLabelSurfaces() {
        let byIdentifier = filter().apply(
            draft(
                target: TargetInfo(role: "AXTextField", subrole: nil, label: "Field 7", identifier: "user_otp_input"),
                content: "123456"
            ),
            mode: .content,
            captureSessionId: session
        )
        #expect(byIdentifier?.contentPolicy == .redactedSensitiveLabel)

        let byTitle = filter().apply(
            draft(window: "Recovery phrase setup", content: "some text"),
            mode: .content,
            captureSessionId: session
        )
        #expect(byTitle?.contentPolicy == .redactedSensitiveLabel)
    }

    // MARK: - Rule 4: secret patterns

    @Test("PEM private key blocks are scrubbed")
    func pemBlocks() {
        // Build the marker and body from harmless fragments so repository
        // secret scanners do not mistake this deliberately synthetic fixture
        // for a credential.
        let begin = ["-----BEGIN", " RSA PRIVATE KEY-----"].joined()
        let end = ["-----END", " RSA PRIVATE KEY-----"].joined()
        let body = "fixture-pem-body"
        let complete = ["some preamble", begin, body, end, "trailing text"].joined(separator: "\n")
        let result = PrivacyFilter.scrubSecrets(complete)
        #expect(result.redacted)
        #expect(!result.text.contains(body))
        #expect(result.text.contains(PrivacyFilter.redactionToken))

        // Unterminated block (crash mid-paste) must still be caught.
        let open = ["-----BEGIN", " OPENSSH PRIVATE KEY-----", "fixture-body"].joined(separator: " ")
        #expect(PrivacyFilter.scrubSecrets(open).redacted)
    }

    @Test("common API key shapes are scrubbed")
    func apiKeys() {
        let keys = [
            "AKIA" + String(repeating: "B", count: 16), // AWS access key id
            "sk-" + String(repeating: "a", count: 24), // generic sk- secret
            "sk-proj-" + String(repeating: "b", count: 24), // OpenAI project key
            "sk-ant-api03-" + String(repeating: "c", count: 22), // Anthropic key
            "sk-svcacct-" + String(repeating: "d", count: 20), // OpenAI service acct
            "sk-live-" + String(repeating: "e", count: 20), // hyphenated live key
            "ghp_" + String(repeating: "c", count: 36), // GitHub PAT
            "github_pat_" + String(repeating: "d", count: 22),
            "xoxb-" + String(repeating: "e", count: 12), // Slack bot token
            "AIza" + String(repeating: "f", count: 35), // Google API key
            "glpat-" + String(repeating: "g", count: 20), // GitLab PAT
        ]
        for key in keys {
            let result = PrivacyFilter.scrubSecrets("prefix \(key) suffix")
            #expect(result.redacted, "'\(key.prefix(8))…' must be scrubbed")
            #expect(!result.text.contains(key.suffix(6)))
        }
    }

    @Test("Luhn-valid card numbers are scrubbed; invalid checksums survive")
    func luhnCards() {
        #expect(PrivacyFilter.passesLuhn("4111111111111111")) // Visa 16 test card
        #expect(PrivacyFilter.passesLuhn("378282246310005")) // Amex 15 test card
        #expect(PrivacyFilter.passesLuhn("4222222222222")) // Visa 13 test card
        #expect(!PrivacyFilter.passesLuhn("4111111111111112")) // bad checksum
        #expect(!PrivacyFilter.passesLuhn("1234567890123")) // fails Luhn

        // In content: valid cards redacted (with separators too), invalid kept.
        let valid = PrivacyFilter.scrubSecrets("card: 4111 1111 1111 1111")
        #expect(valid.redacted)
        #expect(!valid.text.contains("1111"))
        // A run with NO valid 13–19-digit window survives untouched
        // ("1234567890123" fails Luhn and offers no shorter window).
        let invalid = PrivacyFilter.scrubSecrets("num 1234567890123 end")
        #expect(!invalid.redacted)
    }

    @Test("oversize content (>2048 chars) is dropped entirely")
    func oversize() {
        let exactly = String(repeating: "a", count: PrivacyFilter.maxContentLength)
        let over = String(repeating: "a", count: PrivacyFilter.maxContentLength + 1)
        let event = filter()
        #expect(event.apply(draft(content: exactly), mode: .content, captureSessionId: session)?.contentPolicy == .allow)
        #expect(event.apply(draft(content: over), mode: .content, captureSessionId: session)?.contentPolicy == .redactedOversize)
        #expect(event.apply(draft(content: over), mode: .content, captureSessionId: session)?.content == nil)
    }

    // MARK: - Mode behavior

    @Test("metadata mode strips content but keeps window/target metadata")
    func metadataModeStripping() {
        let event = filter().apply(
            draft(
                target: TargetInfo(role: "AXTextArea", subrole: nil, label: "Comment", identifier: "comment-box"),
                window: "Pull request #42",
                content: "free text that must not pass"
            ),
            mode: .metadata,
            captureSessionId: session
        )
        #expect(event?.content == nil)
        #expect(event?.contentPolicy == .metadataOnly)
        #expect(event?.window?.title == "Pull request #42")
        #expect(event?.target?.label == "Comment")
    }

    @Test("window titles are secret-scrubbed in both modes (round-25)")
    func windowTitleScrubbing() {
        let secret = ["s", "k-", "live-", String(repeating: "a", count: 32)].joined()
        // Content mode: title scrubbed, content policy still describes content.
        let contentMode = filter().apply(
            draft(window: "deploy log \(secret)", content: "ordinary text"),
            mode: .content,
            captureSessionId: session
        )
        #expect(contentMode?.window?.title == "deploy log [REDACTED]")
        #expect(contentMode?.contentPolicy == .allow)
        // Metadata mode: same scrubbing — the daemon stores titles raw.
        let metadataPEM = [
            ["-----BEGIN", " PRIVATE KEY-----"].joined(),
            "fixture-body",
            ["-----END", " PRIVATE KEY-----"].joined(),
        ].joined(separator: "\n")
        let metadataMode = filter().apply(
            draft(window: metadataPEM),
            mode: .metadata,
            captureSessionId: session
        )
        #expect(metadataMode?.window?.title?.contains("fixture-body") == false)
        #expect(metadataMode?.window?.title?.contains("[REDACTED]") == true)
        // Clean titles pass through byte-identical.
        let clean = filter().apply(
            draft(window: "Pull request #42", content: nil),
            mode: .metadata,
            captureSessionId: session
        )
        #expect(clean?.window?.title == "Pull request #42")
    }

    @Test("content mode passes clean text with allow")
    func contentModeAllows() {
        let event = filter().apply(
            draft(window: "Notes", content: "ordinary text"),
            mode: .content,
            captureSessionId: session
        )
        #expect(event?.content == "ordinary text")
        #expect(event?.contentPolicy == .allow)
    }

    @Test("content mode without any observed value stays allow with nil content")
    func contentModeEmpty() {
        let event = filter().apply(draft(content: nil), mode: .content, captureSessionId: session)
        #expect(event?.content == nil)
        #expect(event?.contentPolicy == .allow)
    }

    @Test("scrubbed content keeps surrounding text with the redaction token")
    func scrubKeepsContext() {
        let awsKey = ["AKIA", String(repeating: "B", count: 16)].joined()
        let event = filter().apply(
            draft(content: "deploy with \(awsKey) now"),
            mode: .content,
            captureSessionId: session
        )
        #expect(event?.contentPolicy == .redactedSecretPattern)
        let content = event?.content ?? ""
        #expect(content.contains("deploy with"))
        #expect(content.contains("now"))
        #expect(content.contains(PrivacyFilter.redactionToken))
        #expect(!content.contains("BBBB"))
    }

    // MARK: - Working-bound clamping (SEC2-03)

    @Test("content far beyond the working bound still lands redacted_oversize")
    func oversizeBeyondWorkingBound() {
        let huge = String(repeating: "a", count: PrivacyFilter.scrubWorkingBound * 25)
        #expect(huge.utf16.count > PrivacyFilter.scrubWorkingBound)
        let event = filter().apply(draft(content: huge), mode: .content, captureSessionId: session)
        #expect(event?.contentPolicy == .redactedOversize)
        #expect(event?.content == nil)
    }

    @Test("scrub still fires within the working bound")
    func scrubWithinWorkingBound() {
        let pem = [
            ["-----BEGIN", " PRIVATE KEY-----"].joined(),
            "fixture-pem-body",
            ["-----END", " PRIVATE KEY-----"].joined(),
        ].joined(separator: "\n")
        let filler = String(repeating: "lorem ipsum ", count: 160) // 1920 chars
        let content = pem + filler
        #expect(content.utf16.count <= PrivacyFilter.maxContentLength)
        let event = filter().apply(draft(content: content), mode: .content, captureSessionId: session)
        #expect(event?.contentPolicy == .redactedSecretPattern)
        #expect(event?.content?.contains(PrivacyFilter.redactionToken) == true)
    }

    @Test("oversize content whose scrubbed form fits the limit is kept with the secret pattern")
    func oversizeScrubbedBelowLimitKeepsSecretPattern() {
        // A large PEM block inside content over maxContentLength but under the
        // working bound: scrubbing shrinks it below the gate, so it must come
        // out redacted_secret_pattern — NOT dropped as oversize.
        let pemBody = String(repeating: "A", count: 1900)
        let pem = [
            ["-----BEGIN", " PRIVATE KEY-----"].joined(),
            pemBody,
            ["-----END", " PRIVATE KEY-----"].joined(),
        ].joined(separator: "\n")
        let filler = String(repeating: "x", count: 300)
        let content = pem + filler
        #expect(content.utf16.count > PrivacyFilter.maxContentLength)
        #expect(content.utf16.count < PrivacyFilter.scrubWorkingBound)
        let event = filter().apply(draft(content: content), mode: .content, captureSessionId: session)
        #expect(event?.contentPolicy == .redactedSecretPattern)
    }

    @Test("makeDraft clamps unbounded AX values at extraction")
    func makeDraftClampsValue() {
        let huge = String(repeating: "v", count: AXExtraction.maxValueLength + 5000)
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextArea", subrole: nil, label: nil, identifier: nil, title: nil, value: huge),
            action: .textChange,
            app: AppInfo(bundleId: "com.example.app", name: "Example", pid: 4242),
            windowTitle: nil
        )
        #expect(draft.content?.count == AXExtraction.maxValueLength)
        #expect(huge.count > AXExtraction.maxValueLength)
    }

    @Test("values within the bound pass through makeDraft untouched")
    func makeDraftPreservesSmallValue() {
        let value = "hello world"
        let draft = AXExtraction.makeDraft(
            attributes: .init(role: "AXTextArea", subrole: nil, label: nil, identifier: nil, title: nil, value: value),
            action: .textChange,
            app: AppInfo(bundleId: "com.example.app", name: "Example", pid: 4242),
            windowTitle: nil
        )
        #expect(draft.content == value)
    }
}
