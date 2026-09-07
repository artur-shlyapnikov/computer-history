import Foundation

/// Errors raised while framing IPC payloads (u32 big-endian length prefix).
enum FrameError: Error, Equatable {
    case payloadTooLarge(Int)
    case lengthHeaderTruncated
    /// Declared-zero-length payload: unambiguous framing poison
    /// (mirrors the daemon's `bad_frame` close).
    case badFrame
}

/// Pure u32BE framing codec shared by client and tests.
/// Frame layout: 4-byte unsigned big-endian payload length + UTF-8 JSON payload.
enum FrameCodec {
    /// Contracts §Protocol v1: maximum payload of 1 MiB in both directions.
    static let maxPayloadSize = 1_048_576

    static func encode(payload: Data) throws -> Data {
        guard payload.count <= maxPayloadSize else {
            throw FrameError.payloadTooLarge(payload.count)
        }
        var frame = Data(capacity: payload.count + 4)
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(payload)
        return frame
    }

    /// Shared encoder: every production call site encodes on the DaemonClient
    /// writer queue (serialized), so one configured instance serves all
    /// outbound frames instead of allocating a fresh encoder per frame.
    static let sharedEncoder = JSONEncoder()

    static func encode(_ value: some Encodable, encoder: JSONEncoder = FrameCodec.sharedEncoder) throws -> Data {
        try encode(payload: encoder.encode(value))
    }

    /// Append newly received bytes and extract every complete frame available,
    /// handing each payload to `sink` in order as soon as it is fully received.
    /// `buffer` retains trailing partial data.
    /// Throws `payloadTooLarge` when a declared length exceeds `maxPayloadSize`
    /// and `badFrame` on a declared-zero-length payload: either poisons the
    /// stream (the daemon tears down identically), so the buffer is dropped
    /// and the caller MUST close the connection. Frames already handed to
    /// `sink` stay delivered — mirroring the daemon, which answers well-formed
    /// frames before evaluating a trailing bad one instead of discarding them.
    static func extractFrames(from buffer: inout Data, chunk: Data, into sink: (Data) throws -> Void) throws {
        buffer.append(chunk)
        while buffer.count >= 4 {
            // Byte-wise decode: the buffer is not guaranteed 4-byte aligned.
            let header = buffer.prefix(4)
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard length > 0 else {
                // Zero-length frame is unambiguous framing poison; surface it
                // so the caller tears down like the daemon's bad_frame close.
                buffer.removeAll()
                throw FrameError.badFrame
            }
            guard length <= UInt32(maxPayloadSize) else {
                buffer.removeAll()
                throw FrameError.payloadTooLarge(Int(length))
            }
            let total = 4 + Int(length)
            guard buffer.count >= total else { break }
            try sink(Data(buffer.dropFirst(4).prefix(Int(length))))
            buffer.removeFirst(total)
        }
    }
}
