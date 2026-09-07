import Foundation

/// Pure privacy gate between the capture monitors and the EventBuffer
/// (spec §3.7). No I/O and no state: identical input yields identical output.
///
/// Rule order (brief S1 item 3):
///   1. app off         → tombstone event (`excluded_app`): nothing beyond the fact
///   2. secure field    → content dropped, `redacted_secure_field`; value never read
///   3. sensitive label → content dropped, `redacted_sensitive_target`
///   4. content mode    → scrub PEM/API-key/Luhn spans (`redacted_secret_pattern`),
///                        then >2048 chars → drop + `redacted_oversize`, else `allow`
///   5. metadata mode   → strip content (`metadata_only` when content existed)
struct PrivacyFilter: Sendable {
    /// Max content length before forced redaction (spec §3.11d).
    static let maxContentLength = 2048

    /// Working bound applied BEFORE secret-pattern scrubbing. Anything over
    /// `maxContentLength` is dropped after scrubbing anyway, so truncating the
    /// scrub input to this generous bound keeps every outcome identical while
    /// capping regex work on pathological (multi-megabyte) drafts.
    static let scrubWorkingBound = 4096

    /// Case-insensitive word-boundary patterns that mark a target as sensitive.
    static let sensitiveLabelWords = [
        "password", "passwd", "passcode", "pin", "otp", "2fa", "token", "secret",
        "api key", "private key", "cvv", "credit card", "seed phrase", "recovery phrase",
    ]

    /// Replacement token substituted for scrubbed secret spans.
    static let redactionToken = "[REDACTED]"

    private let clock: CaptureClock

    init(clock: CaptureClock = .system) {
        self.clock = clock
    }

    // MARK: - Rule chain

    /// Converts a draft into a wire event under the given capture mode.
    /// Returns nil only when the draft cannot produce any transmittable fact;
    /// excluded apps still yield a tombstone event.
    func apply(_ draft: EventDraft, mode: CaptureMode, captureSessionId: String) -> ActivityEvent? {
        guard mode != .off else {
            return tombstone(for: draft, captureSessionId: captureSessionId)
        }

        var event = shell(for: draft, captureSessionId: captureSessionId)
        // Window titles are user-content surfaces too — terminals and browsers
        // echo arbitrary text (file dumps, URLs, command output) into them —
        // and the daemon stores window_title raw. Scrub secret spans with the
        // same patterns as content, in BOTH modes. Policy stays untouched: it
        // describes the content field. Pathological (>4096-char) titles are
        // truncated to the same working bound that caps content regex work.
        event.window = draft.windowTitle.map { title in
            let bounded = String(title.prefix(Self.scrubWorkingBound))
            return WindowInfo(title: Self.scrubSecrets(bounded).text)
        }
        event.target = draft.target

        // Absolute ban (spec §3.7): secure text fields never contribute text.
        // The monitor must not even read the value; this is the belt over
        // that suspenders — precedence above every other content rule.
        if draft.isSecureField || draft.target?.subrole == AXExtraction.secureFieldSubrole {
            event.content = nil
            event.contentPolicy = .redactedSecureField
            return event
        }

        if Self.sensitiveLabelMatches(draft) {
            event.content = nil
            event.contentPolicy = .redactedSensitiveLabel
            return event
        }

        switch mode {
        case .content:
            guard draft.content != nil else {
                event.content = nil
                event.contentPolicy = .allow
                return event
            }
            var content = draft.content ?? ""
            // Bound the regex work before scrubbing: content beyond the
            // working bound is dropped by the oversize gate below regardless,
            // so early truncation preserves the outcome.
            if content.utf16.count > Self.scrubWorkingBound {
                content = String(content.prefix(Self.scrubWorkingBound))
            }
            var scrubbed = false
            if !content.isEmpty {
                let result = Self.scrubSecrets(content)
                content = result.text
                scrubbed = result.redacted
            }
            // Daemon invariant (d): JS string length == UTF-16 code units, so
            // the recorder must measure the same way to stay in lockstep.
            if content.utf16.count > Self.maxContentLength {
                event.content = nil
                event.contentPolicy = .redactedOversize
                return event
            }
            event.content = content
            event.contentPolicy = scrubbed ? .redactedSecretPattern : .allow
            return event
        case .metadata, .off:
            if draft.content != nil {
                event.content = nil
                event.contentPolicy = .metadataOnly
            } else {
                event.content = nil
                event.contentPolicy = .allow
            }
            return event
        }
    }

    // MARK: - Event shells

    /// Tombstone for excluded apps: ONLY source/app/action/app/captureSessionId.
    private func tombstone(for draft: EventDraft, captureSessionId: String) -> ActivityEvent {
        var event = shell(for: draft, captureSessionId: captureSessionId)
        event.window = nil
        event.target = nil
        event.content = nil
        event.contentPolicy = .excludedApp
        return event
    }

    private func shell(for draft: EventDraft, captureSessionId: String) -> ActivityEvent {
        ActivityEvent(
            id: Ulid.shared.next(),
            observedAt: clock.nowMs(),
            monotonicNs: clock.monotonicNs(),
            source: draft.source,
            app: draft.app,
            window: nil,
            action: draft.action,
            target: nil,
            content: nil,
            contentPolicy: .allow,
            captureSessionId: captureSessionId
        )
    }

    // MARK: - Rule 3: sensitive labels

    static func sensitiveLabelMatches(_ draft: EventDraft) -> Bool {
        // Direct optional checks: no [String?]/compactMap scratch arrays per
        // draft; same evaluation order (label, identifier, windowTitle) and
        // first-match-wins semantics.
        if let label = draft.target?.label,
           sensitiveLabelRegex.firstMatch(in: label, range: fullRange(label)) != nil
        {
            return true
        }
        if let identifier = draft.target?.identifier,
           sensitiveLabelRegex.firstMatch(in: identifier, range: fullRange(identifier)) != nil
        {
            return true
        }
        if let windowTitle = draft.windowTitle,
           sensitiveLabelRegex.firstMatch(in: windowTitle, range: fullRange(windowTitle)) != nil
        {
            return true
        }
        return false
    }

    private static let sensitiveLabelRegex: NSRegularExpression = {
        let alternatives = sensitiveLabelWords
            .map { $0.replacingOccurrences(of: " ", with: "[ -]") }
            .joined(separator: "|")
        // Boundary = neither side continues an alphanumeric run. Lookarounds
        // (not \b) so snake_case identifiers like user_otp_input also match:
        // "_" is not alphanumeric, hence a boundary here.
        return makeRegex(pattern: "(?i)(?<![A-Za-z0-9])(\(alternatives))(?![A-Za-z0-9])")
    }()

    private static func fullRange(_ string: String) -> NSRange {
        NSRange(string.startIndex ..< string.endIndex, in: string)
    }

    // MARK: - Rule 4a: secret-pattern scrubbing (returns rewritten text)

    /// Compiles one of this filter's built-in patterns. Every pattern here is
    /// a compile-time literal, so a compile failure is a programmer error:
    /// back to a state where content could slip through unscrubbed).
    private static func makeRegex(pattern: String) -> NSRegularExpression {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            preconditionFailure("built-in privacy regex failed to compile: \(pattern)")
        }
        return regex
    }

    /// PEM private key blocks (complete or unterminated — crash-safe on privacy).
    private static let pemBlockRegex = makeRegex(
        pattern: #"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----"#
    )
    private static let pemOpenEndedRegex = makeRegex(
        pattern: #"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*$"#
    )

    /// Common API-key shapes (brief S1 item 3).
    private static let apiKeyRegexes: [NSRegularExpression] = [
        makeRegex(pattern: #"AKIA[0-9A-Z]{16}"#),
        makeRegex(pattern: #"sk-[A-Za-z0-9]{20,}"#),
        // Hyphenated OpenAI/Anthropic-style prefixes (sk-proj-, sk-svcacct-,
        // sk-ant-api03-, sk-live-) never match the bare pattern above, so
        // enumerate them explicitly with separator-tolerant tails.
        makeRegex(pattern: #"sk-(proj|svcacct|ant|live|test)-[A-Za-z0-9_-]{20,}"#),
        makeRegex(pattern: #"ghp_[A-Za-z0-9]{36}"#),
        makeRegex(pattern: #"github_pat_[A-Za-z0-9_]{20,}"#),
        makeRegex(pattern: #"xox[baprs]-[0-9A-Za-z-]{10,}"#),
        makeRegex(pattern: #"AIza[0-9A-Za-z_-]{35}"#),
        makeRegex(pattern: #"glpat-[A-Za-z0-9_-]{20,}"#),
    ]

    /// Digit groups optionally separated by spaces/hyphens, 13–19 digits
    /// total — the human-typed card formats ("4111 1111 1111 1111").
    private static let cardRunRegex = makeRegex(pattern: #"[0-9](?:[ -]?[0-9]){12,18}"#)

    static func scrubSecrets(_ input: String) -> (text: String, redacted: Bool) {
        // One mutable buffer: replacements apply in place right-to-left, so
        // earlier match ranges stay valid and no per-match whole-string copy
        // (replacingCharacters on an NSString) is needed.
        let working = NSMutableString(string: input)
        var redacted = false

        func replaceAll(_ regex: NSRegularExpression, token: String) {
            let matches = regex.matches(in: working as String, range: NSRange(location: 0, length: working.length)).reversed()
            guard !matches.isEmpty else { return }
            redacted = true
            for match in matches {
                working.replaceCharacters(in: match.range, with: token)
            }
        }
        replaceAll(pemBlockRegex, token: redactionToken)
        replaceAll(pemOpenEndedRegex, token: redactionToken)
        for regex in apiKeyRegexes {
            replaceAll(regex, token: redactionToken)
        }

        // Card-number-like values passing Luhn: slide a 13–19-digit window
        // over every candidate run (separators included in the run, excluded
        // from the checksum). Replace right-to-left so offsets stay valid.
        let runs = cardRunRegex.matches(in: working as String, range: NSRange(location: 0, length: working.length)).reversed()
        for run in runs {
            let runString = working.substring(with: run.range) as NSString
            let digitOffsets: [Int] = (0 ..< runString.length).filter { offset in
                let scalar = runString.character(at: offset)
                return scalar >= 48 && scalar <= 57 // ASCII 0-9
            }
            guard digitOffsets.count >= 13 else { continue }

            var spans: [NSRange] = []
            // Digit values decoded once per run; each window then runs an
            // allocation-free Luhn pass over an integer slice instead of
            // building up to 19 single-char NSString substrings per attempt.
            let digitValues = digitOffsets.map { Int(runString.character(at: $0)) - 48 }
            var start = 0
            while start < digitValues.count {
                var consumed = 0
                let longest = min(19, digitValues.count - start)
                if longest >= 13 {
                    for length in stride(from: longest, through: 13, by: -1) {
                        var sum = 0
                        var doubleNext = false
                        for value in digitValues[start ..< (start + length)].reversed() {
                            var weighted = value
                            if doubleNext {
                                weighted *= 2
                                if weighted > 9 {
                                    weighted -= 9
                                }
                            }
                            sum += weighted
                            doubleNext.toggle()
                        }
                        if sum % 10 == 0 {
                            let first = digitOffsets[start]
                            let last = digitOffsets[start + length - 1]
                            spans.append(NSRange(location: run.range.location + first, length: last - first + 1))
                            consumed = length
                            break
                        }
                    }
                }
                start += max(consumed, 1)
            }
            for span in mergeSpans(spans.sorted { $0.location > $1.location }) {
                working.replaceCharacters(in: span, with: redactionToken)
            }
            if !spans.isEmpty {
                redacted = true
            }
        }

        return (working as String, redacted)
    }

    private static func mergeSpans(_ sortedDescending: [NSRange]) -> [NSRange] {
        var merged: [NSRange] = []
        for span in sortedDescending {
            if let last = merged.last, span.location <= last.location + last.length {
                let newLocation = min(last.location, span.location)
                let newEnd = max(last.location + last.length, span.location + span.length)
                merged[merged.count - 1] = NSRange(location: newLocation, length: newEnd - newLocation)
            } else {
                merged.append(span)
            }
        }
        return merged
    }

    /// Standard Luhn checksum: double every second digit from the right,
    /// subtract 9 from products ≥ 10, total must be divisible by 10.
    static func passesLuhn(_ digits: String) -> Bool {
        guard digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        var sum = 0
        var doubleNext = false
        for character in digits.reversed() {
            var value = character.wholeNumberValue ?? 0
            if doubleNext {
                value *= 2
                if value > 9 {
                    value -= 9
                }
            }
            sum += value
            doubleNext.toggle()
        }
        return sum % 10 == 0
    }
}
