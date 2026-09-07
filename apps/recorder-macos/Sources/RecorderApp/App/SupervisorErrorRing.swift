import Foundation

/// Injectable wall clock (contracts §Testing conventions: injected clock
/// everywhere time matters). Production instance reads the system clock;
/// tests pin timestamps deterministically.
protocol AppClock: AnyObject {
    var nowMs: Int64 { get }
}

final class SystemAppClock: AppClock {
    var nowMs: Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

/// One recorded supervisor/daemon failure shown in the Diagnostics pane
/// (brief M7 S7 item 2: last N supervisor errors).
struct SupervisorErrorEntry: Equatable, Sendable, Identifiable {
    let id: UInt64
    let atMs: Int64
    let scope: String
    let code: String
    let message: String
}

/// Fixed-capacity ring of the most recent failures. Pure value type with an
/// injected clock read at the call site, so the whole lifecycle (append,
/// eviction of the oldest, ordering) is unit-testable without timers.
///
/// Ordering invariant: `entries` is newest-LAST; the Diagnostics pane renders
/// it reversed (newest first) like the daemon's `diagnostics.get.lastErrors`.
struct SupervisorErrorRing: Equatable, Sendable {
    let capacity: Int
    private(set) var entries: [SupervisorErrorEntry] = []
    private(set) var nextId: UInt64 = 1

    init(capacity: Int) {
        precondition(capacity > 0, "ring capacity must be positive")
        self.capacity = capacity
    }

    /// Records one failure; evicts the oldest entry when at capacity.
    mutating func record(atMs: Int64, scope: String, code: String, message: String) {
        let entry = SupervisorErrorEntry(
            id: nextId,
            atMs: atMs,
            scope: scope,
            code: code,
            message: message
        )
        nextId += 1
        entries.append(entry)
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    /// Newest-first projection for display.
    var newestFirst: [SupervisorErrorEntry] {
        entries.reversed()
    }

    var isEmpty: Bool {
        entries.isEmpty
    }
}
