import Foundation

/// Embedded ULID generator (26-char Crockford base32, monotonic within process).
/// Deliberately dependency-free: the Swift side only needs well-formed IDs,
/// and the `ulid` crate/npm package is TS-only.
final class Ulid: @unchecked Sendable {
    static let shared = Ulid()

    private let lock = NSLock()
    private var lastMilliseconds: Int64
    private var lastRandomness: (UInt64, UInt64)

    private init() {
        lastMilliseconds = 0
        lastRandomness = (0, 0)
    }

    func next(nowMs: Int64? = nil) -> String {
        let milliseconds = nowMs ?? Int64(Date().timeIntervalSince1970 * 1000)
        lock.lock()
        defer { lock.unlock() }

        if milliseconds <= lastMilliseconds {
            // Monotonic: bump the 80-bit randomness within the same millisecond.
            increment(&lastRandomness.1)
            if lastRandomness.1 == 0 {
                increment(&lastRandomness.0)
            }
        } else {
            lastMilliseconds = milliseconds
            lastRandomness = (UInt64.random(in: .min ... .max), UInt64.random(in: .min ... .max))
        }
        return Ulid.encode(timestamp: lastMilliseconds, high: lastRandomness.0, low: lastRandomness.1)
    }

    private func increment(_ value: inout UInt64) {
        value &+= 1
    }

    // MARK: - Encoding

    /// Crockford base32 alphabet (no I, L, O, U).
    private static let encoding: [Character] = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func encode(timestamp: Int64, high: UInt64, low: UInt64) -> String {
        var chars = [Character](repeating: "0", count: 26)
        var time = timestamp
        for index in stride(from: 9, through: 0, by: -1) {
            chars[index] = encoding[Int(time & 0x1F)]
            time >>= 5
        }
        // Remaining 16 characters encode 80 bits of randomness: the lowest
        // 10 bits of `high` (2 chars) followed by all 64 bits of `low` (14 chars).
        var highBits = high & 0x3FF
        for index in stride(from: 11, through: 10, by: -1) {
            chars[index] = encoding[Int(highBits & 0x1F)]
            highBits >>= 5
        }
        var lowBits = low
        for index in stride(from: 25, through: 12, by: -1) {
            chars[index] = encoding[Int(lowBits & 0x1F)]
            lowBits >>= 5
        }
        return String(chars)
    }
}
