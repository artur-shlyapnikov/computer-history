import Foundation
@testable import RecorderApp
import Testing

/// Round-34 pins for the occurrence-ledger truncation labels on
/// `WorkflowsView`:
///
/// - The collapsed toggle must say "Show newest X of Y" exactly when the
///   wire total exceeds the shipped window, and plain "Show all N" when
///   the ledger is complete (including the degenerate 0/0 and single-row
///   cases).
/// - The not-loaded caption arithmetic is `total - shipped`, which must be
///   0 — not negative — for a complete ledger.
///
/// Pure-function tests: no view construction, mirroring the
/// TimelineMappingTests / DiagnosticsTimestampTests conventions.
struct WorkflowsViewLabelTests {
    // MARK: Collapsed toggle title

    @Test
    func toggleTitleEqualCountsSaysShowAll() {
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 25, total: 25)
                == "Show all 25"
        )
    }

    @Test
    func toggleTitleTruncatedLedgerNamesTheWindow() {
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 10, total: 500)
                == "Show newest 10 of 500"
        )
    }

    @Test
    func toggleTitleZeroRowsIsCompleteNotTruncated() {
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 0, total: 0)
                == "Show all 0"
        )
    }

    @Test
    func toggleTitleSingleShippedRowOfManyNamesTheWindow() {
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 1, total: 2)
                == "Show newest 1 of 2"
        )
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 1, total: 1)
                == "Show all 1"
        )
    }

    @Test
    func toggleTitleAtCapBoundaryDistinguishesCompleteFromPartialFetch() {
        // Complete ledger at exactly the render cap.
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 10, total: 10)
                == "Show all 10"
        )
        // Same shipped count, but the wire says more exists upstream.
        #expect(
            WorkflowsView.collapsedToggleTitle(shipped: 10, total: 500)
                == "Show newest 10 of 500"
        )
    }

    // MARK: Not-loaded caption arithmetic

    @Test
    func captionCountsOnlyTheUnshippedTail() {
        #expect(
            WorkflowsView.truncatedLedgerCaption(shipped: 10, total: 500)
                == "Older occurrences not loaded (490 not shown)"
        )
    }

    @Test
    func captionForCompleteLedgerIsZeroNotNegative() {
        #expect(
            WorkflowsView.truncatedLedgerCaption(shipped: 12, total: 12)
                == "Older occurrences not loaded (0 not shown)"
        )
    }
}
