import Foundation
@testable import RecorderApp
import Testing

/// SplitMix64 — seeded deterministic PRNG (test-design-11 §2.2).
/// Fixed seeds make failures bit-reproducible by rerunning the file; no
/// shrinking needed because assertion messages embed the failing trial's
/// structural input (frame sizes + chunk cut points).
private struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// R11-P2 property suite (test-design-11.md §2.4): arbitrary chunk-split
/// round-trip through `FrameCodec.encode`/`extractFrames`.
///
/// `FramingTests` exercises chunk boundaries at exactly three hand-picked
/// splits (prefix(3)/400/whole-stream); these seeded properties split
/// encoded streams at random cut points to kill header-spanning decode
/// errors and `removeFirst(total)` / `dropFirst(4).prefix(length)`
/// off-by-one mutants at lengths those splits never hit.
///
/// Poison semantics are deliberately NOT re-property'd here: zero-length
/// and oversize poisoning, good-frame-before-poison delivery, and
/// buffer-drop-on-poison each have dedicated example cases already.
struct FrameChunkingPropertiesTests {
    /// Spec §2.2 named constant seed — bit-reproducible, CI-safe.
    private static let seed: UInt64 = 0xC0DE_C001

    private func makeRng(salt: UInt64) -> SplitMix64 {
        SplitMix64(seed: Self.seed &+ salt)
    }

    /// Draws `count` frames of seeded-random payloads sized 1…2000 bytes
    /// (always ≤ `maxPayloadSize`; the floor is 1 because a declared-zero-
    /// length frame is framing poison per the pinned `badFrame` contract).
    private func makeFrames(count: Int, rng: inout SplitMix64) throws -> (bytes: [UInt8], payloads: [Data]) {
        var payloads: [Data] = []
        var stream = Data()
        for _ in 0 ..< count {
            var payload = Data(capacity: 2000)
            for _ in 0 ..< rng.next(upperBound: UInt64(2000)) + 1 {
                payload.append(UInt8(rng.next(upperBound: UInt64(256))))
            }
            payloads.append(payload)
            try stream.append(FrameCodec.encode(payload: payload))
        }
        return ([UInt8](stream), payloads)
    }

    /// Partitions the stream at seeded random cut points into chunks of
    /// 1…remaining bytes; returns the chunks and their end offsets.
    private func randomChunks(of bytes: [UInt8], rng: inout SplitMix64) -> (chunks: [Data], cuts: [Int]) {
        var chunks: [Data] = []
        var cuts: [Int] = []
        var start = 0
        while start < bytes.count {
            let end = start + Int(rng.next(upperBound: UInt64(bytes.count - start))) + 1
            cuts.append(end)
            chunks.append(Data(bytes[start ..< end]))
            start = end
        }
        return (chunks, cuts)
    }

    @Test("arbitrary chunk splits round-trip every frame in order")
    func arbitrarySplitRoundTrip() throws {
        var rng = makeRng(salt: 0x0001)
        for trial in 0 ..< 200 {
            let count = Int(rng.next(upperBound: UInt64(12))) + 1
            let (bytes, payloads) = try makeFrames(count: count, rng: &rng)
            let (chunks, cuts) = randomChunks(of: bytes, rng: &rng)

            var buffer = Data()
            var extracted: [Data] = []
            for chunk in chunks {
                try FrameCodec.extractFrames(from: &buffer, chunk: chunk) { extracted.append($0) }
            }
            let sizes = payloads.map(\.count)
            let delivered = extracted.map(\.count)
            #expect(
                extracted == payloads && buffer.isEmpty,
                "trial \(trial): frames=\(sizes) cuts=\(cuts) delivered=\(delivered) residualBuffer=\(buffer.count)"
            )
        }
    }

    @Test("withholding the final chunk delivers the complete-frame prefix and retains the tail")
    func partialTailRetention() throws {
        var rng = makeRng(salt: 0x00A2)
        for trial in 0 ..< 50 {
            let count = Int(rng.next(upperBound: UInt64(12))) + 1
            let (bytes, payloads) = try makeFrames(count: count, rng: &rng)
            var (chunks, cuts) = randomChunks(of: bytes, rng: &rng)
            let withheld = chunks.removeLast()
            cuts.removeLast()

            var buffer = Data()
            var extracted: [Data] = []
            for chunk in chunks {
                try FrameCodec.extractFrames(from: &buffer, chunk: chunk) { extracted.append($0) }
            }

            let delivered = bytes.count - withheld.count
            var consumed = 0
            var expectedComplete = 0
            for payload in payloads {
                let total = 4 + payload.count
                guard consumed + total <= delivered else { break }
                consumed += total
                expectedComplete += 1
            }
            let sizes = payloads.map(\.count)
            #expect(
                extracted == Array(payloads.prefix(expectedComplete)),
                "trial \(trial): frames=\(sizes) cuts=\(cuts) withheld=\(withheld.count)B"
            )
            #expect(
                buffer == Data(bytes[consumed ..< delivered]),
                "trial \(trial): unconsumed-tail mismatch consumed=\(consumed)B of delivered=\(delivered)B cuts=\(cuts)"
            )
        }
    }
}
