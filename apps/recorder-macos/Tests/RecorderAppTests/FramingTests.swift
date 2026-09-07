import Foundation
@testable import RecorderApp
import Testing

struct FramingTests {
    @Test("u32BE frame roundtrip")
    func roundtrip() throws {
        let payload = Data("{\"a\":1}".utf8)
        let frame = try FrameCodec.encode(payload: payload)

        #expect(frame.count == payload.count + 4)
        #expect(Int(frame[frame.startIndex]) == 0) // length fits in low bytes
        let declared = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        #expect(declared == payload.count)

        var buffer = Data()
        var extracted: [Data] = []
        try FrameCodec.extractFrames(from: &buffer, chunk: frame) { extracted.append($0) }
        #expect(extracted == [payload])
        #expect(buffer.isEmpty)
    }

    @Test("partial chunks reassemble into one frame")
    func partialChunks() throws {
        let payload = Data(String(repeating: "x", count: 1000).utf8)
        let frame = try FrameCodec.encode(payload: payload)
        var buffer = Data()
        var extracted: [Data] = []
        try FrameCodec.extractFrames(from: &buffer, chunk: frame.prefix(3)) { extracted.append($0) }
        #expect(extracted.isEmpty)
        try FrameCodec.extractFrames(from: &buffer, chunk: frame.dropFirst(3).prefix(400)) { extracted.append($0) }
        #expect(extracted.isEmpty)
        try FrameCodec.extractFrames(from: &buffer, chunk: frame.dropFirst(403)) { extracted.append($0) }
        #expect(extracted == [payload])
    }

    @Test("two frames in one chunk extract in order")
    func multipleFrames() throws {
        let first = try FrameCodec.encode(payload: Data("one".utf8))
        let second = try FrameCodec.encode(payload: Data("two".utf8))
        var buffer = Data()
        var extracted: [Data] = []
        try FrameCodec.extractFrames(from: &buffer, chunk: Data(first + second)) { extracted.append($0) }
        #expect(extracted.count == 2)
        #expect(extracted[0] == Data("one".utf8))
        #expect(extracted[1] == Data("two".utf8))
    }

    @Test("oversize payload is rejected at encode time")
    func oversizeEncodeThrows() {
        let huge = Data(count: FrameCodec.maxPayloadSize + 1)
        #expect(throws: FrameError.payloadTooLarge(huge.count)) {
            _ = try FrameCodec.encode(payload: huge)
        }
        let exact = Data(count: FrameCodec.maxPayloadSize)
        #expect((try? FrameCodec.encode(payload: exact)) != nil)
    }

    @Test("declared length beyond 1 MiB poisons the stream buffer")
    func oversizeDeclaredLength() {
        var buffer = Data([0x00, 0x10, 0x00, 0x01]) // declared length 1_048_577 > 1 MiB cap
        var extracted: [Data] = []
        #expect(throws: FrameError.payloadTooLarge(1_048_577)) {
            try FrameCodec.extractFrames(from: &buffer, chunk: Data()) { extracted.append($0) }
        }
        #expect(extracted.isEmpty)
        #expect(buffer.isEmpty) // poisoned stream dropped; caller must close
    }

    @Test("declared-zero-length payload poisons the stream like the daemon")
    func zeroLengthFrameThrows() {
        var buffer = Data([0x00, 0x00, 0x00, 0x00]) // declared length 0
        var extracted: [Data] = []
        #expect(throws: FrameError.badFrame) {
            try FrameCodec.extractFrames(from: &buffer, chunk: Data()) { extracted.append($0) }
        }
        #expect(extracted.isEmpty)
        #expect(buffer.isEmpty) // poisoned stream dropped; caller must close
    }

    @Test("chunk [good][oversize header] delivers the good frame before throwing")
    func goodFrameBeforeOversizeHeader() throws {
        let good = try FrameCodec.encode(payload: Data("one".utf8))
        let chunk = Data(good + [0x00, 0x10, 0x00, 0x01]) // trailing declared length > 1 MiB cap
        var buffer = Data()
        var extracted: [Data] = []
        #expect(throws: FrameError.payloadTooLarge(1_048_577)) {
            try FrameCodec.extractFrames(from: &buffer, chunk: chunk) { extracted.append($0) }
        }
        #expect(extracted == [Data("one".utf8)]) // parsed frame survives the poison
        #expect(buffer.isEmpty) // poisoned stream dropped; caller must close
    }

    @Test("chunk [good][zero-length header] delivers the good frame before throwing")
    func goodFrameBeforeZeroLengthHeader() throws {
        let good = try FrameCodec.encode(payload: Data("one".utf8))
        let chunk = Data(good + [0x00, 0x00, 0x00, 0x00]) // trailing declared-zero-length poison
        var buffer = Data()
        var extracted: [Data] = []
        #expect(throws: FrameError.badFrame) {
            try FrameCodec.extractFrames(from: &buffer, chunk: chunk) { extracted.append($0) }
        }
        #expect(extracted == [Data("one".utf8)]) // parsed frame survives the poison
        #expect(buffer.isEmpty) // poisoned stream dropped; caller must close
    }
}

struct UlidTests {
    @Test("ULIDs are 26-char Crockford and unique")
    func shapeAndUniqueness() {
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var seen = Set<String>()
        for _ in 0 ..< 500 {
            let id = Ulid.shared.next()
            #expect(id.count == 26)
            #expect(id.allSatisfy { alphabet.contains($0) })
            seen.insert(id)
        }
        // Monotonic generator must never collide within a burst.
        #expect(seen.count == 500)
    }

    @Test("same millisecond increments randomness (monotonic)")
    func monotonicWithinMillisecond() {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let first = Ulid.shared.next(nowMs: now)
        let second = Ulid.shared.next(nowMs: now)
        #expect(first < second) // lexicographic order matches sort order
        let later = Ulid.shared.next(nowMs: now + 1)
        #expect(second < later)
    }

    @Test("known timestamp encodes to canonical time part")
    func knownTimestamp() {
        // 2026-08-23T00:00:00Z ≈ 1787433600000 ms → base32 Crockford prefix
        // "01M0NNGH00" (verified against the ulid npm package's encodeTime).
        let id = Ulid.encode(timestamp: 1_787_433_600_000, high: 0, low: 0)
        #expect(id.count == 26)
        #expect(id.hasPrefix("01M0NNGH00"))
        #expect(id.hasSuffix("0000000000000000")) // zero randomness → zero tail
    }

    // MARK: R9-S1: randomness layout goldens (Crockford table-derived).

    ///
    /// Layout contract (Ulid.swift:52-63): chars 10-11 carry the LOW 10 bits
    /// of `high` MSB-first; chars 12-25 carry `low` consumed 5 bits at a time
    /// from the bottom. Because 14 chars × 5 = 70 > 64 bits, position 12 is
    /// STRUCTURALLY always '0' — that quirk is part of the pinned contract;
    /// any future move to canonical npm-ulid packing must update these
    /// vectors deliberately.
    @Test("randomness layout: all-ones high/low encode to Z tail with structural zero at 12")
    func goldenAllOnes() {
        let id = Ulid.encode(timestamp: 1_787_433_600_000, high: 0x3FF, low: UInt64.max)
        #expect(id == "01M0NNGH00ZZ0FZZZZZZZZZZZZ")
    }

    @Test("randomness layout: low-10-bits of high land at chars 10-11")
    func goldenHighBits() {
        // Bit 79 of the 80-bit value → char 10 = 'G' (16 << ... top group of
        // the masked 10 bits), char 11 stays '0'.
        let id = Ulid.encode(timestamp: 1_787_433_600_000, high: 0x200, low: 0)
        #expect(id == "01M0NNGH00G000000000000000")
    }

    @Test("randomness layout: single-bit low vectors pin MSB-first grouping")
    func goldenLowBits() {
        #expect(
            Ulid.encode(timestamp: 1_787_433_600_000, high: 0, low: 1)
                == "01M0NNGH000000000000000001"
        )
        // Top 5-bit group of the 64-bit low lands at char index 13.
        #expect(
            Ulid.encode(timestamp: 1_787_433_600_000, high: 0, low: 1 << 63)
                == "01M0NNGH000008000000000000"
        )
    }

    @Test("randomness layout: mixed independently-recomputable vector")
    func goldenMixedVector() {
        #expect(
            Ulid.encode(timestamp: 1_700_000_000_000, high: 0x155, low: 0xDEAD_BEEF_CAFE_BABE)
                == "01HF7YAT00AN0DXBDYXZ5FXENY"
        )
    }

    @Test("fixed timestamp: lexicographic order tracks low, then time dominates")
    func orderingProperty() {
        let t = Int64(1_787_433_600_000)
        // Adjacent lows across a 5-bit group boundary still order correctly,
        // including a wrap into the next character position.
        for boundary in [UInt64(0x1F), 0x20, 0xFF, 0x100, 0x3FF] {
            let before = Ulid.encode(timestamp: t, high: 0x155, low: boundary)
            let after = Ulid.encode(timestamp: t, high: 0x155, low: boundary &+ 1)
            #expect(before < after)
        }
        // A one-millisecond bump outranks ANY randomness (48-bit time is
        // lexicographically dominant).
        let maxRandomness = Ulid.encode(timestamp: t, high: UInt64.max, low: UInt64.max)
        let nextMillisecond = Ulid.encode(timestamp: t + 1, high: 0, low: 0)
        #expect(maxRandomness < nextMillisecond)
    }

    /// R9-S1 honesty note: the `.1`-wrap → `.0`-increment carry branch in
    /// `next()` needs ~2^64 same-ms increments and is NOT deterministically
    /// drivable (private state). This burst pins the non-wrap monotonic
    /// half: strict increase + uniqueness across 100k same-ms draws crosses
    /// the increment path deterministically without ever wrapping.
    @Test("100k same-ms burst is strictly increasing and unique")
    func monotonicBurstWithinMillisecond() {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var previous = Ulid.shared.next(nowMs: now)
        var seen = Set([previous])
        for _ in 0 ..< 100_000 {
            let id = Ulid.shared.next(nowMs: now)
            if !(previous < id) || !seen.insert(id).inserted {
                Issue.record("monotonicity or uniqueness broken at \(id)")
                return
            }
            previous = id
        }
        #expect(seen.count == 100_001)
    }
}
