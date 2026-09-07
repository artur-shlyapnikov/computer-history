import Foundation
@testable import RecorderApp
import Testing

/// Pure view-model tests for AppState's chat state machine (spec §3.19):
/// sequences are injected by calling the apply* methods directly — no socket.
@MainActor
struct ChatStateTests {
    private static let requestA = "01M0NP9G4HP0M1M64H8TC0VEKA"
    private static let sessionOne = "01M0NP9G4HP0M1M64H8TC0VEKS"
    private static let sessionTwo = "01M0NP9G4HP0M1M64H8TC0VEKT"

    @Test("happy path: send → chunks → done commits one assistant row and returns to idle")
    func happyPath() {
        let state = AppState()
        #expect(state.chatPhase == .idle)

        state.appendUserMessage("what did I do about webhooks?")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .streaming(sessionId: Self.sessionOne, requestId: Self.requestA))
        #expect(state.isChatStreaming)
        #expect(state.activeChatRequestId == Self.requestA)

        state.applyChatChunk(requestId: Self.requestA, delta: "You ")
        state.applyChatChunk(requestId: Self.requestA, delta: "investigated ")
        state.applyChatChunk(requestId: Self.requestA, delta: "webhook failures.")
        #expect(state.chatStreamingText == "You investigated webhook failures.")

        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .idle)
        #expect(!state.isChatStreaming)
        #expect(state.chatStreamingText == nil)
        #expect(state.chatMessages.count == 2)
        #expect(state.chatMessages[0].role == .user)
        #expect(state.chatMessages[1].role == .assistant)
        #expect(state.chatMessages[1].text == "You investigated webhook failures.")
        #expect(state.currentChatSessionId == Self.sessionOne)
    }

    @Test("second turn reuses the daemon-issued sessionId; reset drops it")
    func sessionIdLifecycle() {
        let state = AppState()
        #expect(state.currentChatSessionId == nil)

        state.appendUserMessage("first")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.currentChatSessionId == Self.sessionOne)

        // New conversation resets the transcript AND the session so the next
        // send allocates a fresh server-side conversation.
        state.resetConversation()
        #expect(state.currentChatSessionId == nil)
        #expect(state.chatMessages.isEmpty)
        #expect(state.chatPhase == .idle)

        state.appendUserMessage("fresh start")
        state.applyChatSendResult(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", sessionId: Self.sessionTwo)
        if case let .streaming(sessionId, _) = state.chatPhase {
            #expect(sessionId == Self.sessionTwo)
        } else {
            Issue.record("expected streaming phase after reset + send")
        }
    }

    @Test("deltas racing ahead of the send response are buffered, then flushed")
    func earlyChunksBuffered() {
        let state = AppState()
        state.appendUserMessage("hello")
        // Chunks arrive BEFORE the chat.send response frame pins the turn.
        state.applyChatChunk(requestId: Self.requestA, delta: "early ")
        state.applyChatChunk(requestId: Self.requestA, delta: "bird")
        #expect(state.chatStreamingText == nil)

        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatStreamingText == "early bird")

        state.applyChatChunk(requestId: Self.requestA, delta: "!")
        #expect(state.chatStreamingText == "early bird!")
    }

    @Test("out-of-order guard: stale and unknown requestIds never touch the draft")
    func outOfOrderGuard() {
        let state = AppState()

        // Unknown requestId while nothing is in flight → dropped entirely.
        state.applyChatChunk(requestId: "01M0NP9G4HP0M1M64H8TC0VEKZ", delta: "ghost")
        #expect(state.chatStreamingText == nil)
        #expect(state.bufferedChatChunkCount == 0)

        state.appendUserMessage("turn")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatChunk(requestId: Self.requestA, delta: "kept ")

        // Mismatched requestId mid-stream → ignored.
        state.applyChatChunk(requestId: "01M0NP9G4HP0M1M64H8TC0VEKZ", delta: "dropped")
        #expect(state.chatStreamingText == "kept ")

        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        // Late chunk / late done for an already-resolved turn → ignored.
        state.applyChatChunk(requestId: Self.requestA, delta: "late")
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatStreamingText == nil)
        #expect(state.chatMessages.count == 2)
        #expect(state.chatMessages[1].text == "kept ")
    }

    @Test("chat_error llm_unavailable enters failed(code) with banner message")
    func errorPhase() {
        let state = AppState()
        state.appendUserMessage("why did it break?")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatChunk(requestId: Self.requestA, delta: "partial")

        state.applyChatError(
            requestId: Self.requestA,
            code: "llm_unavailable",
            message: "model runtime has no credentials"
        )
        #expect(state.chatPhase == .failed(code: "llm_unavailable"))
        #expect(!state.isChatStreaming)
        #expect(state.chatErrorMessage == "model runtime has no credentials")
        // The partial draft is discarded, not committed as an assistant row.
        #expect(state.chatStreamingText == nil)
        #expect(state.chatMessages.count == 1)

        // Retry path: the failed user text is still available and a new turn
        // can pin cleanly over the failure.
        #expect(state.lastUserChatText == "why did it break?")
        state.appendUserMessage("why did it break?")
        state.applyChatSendResult(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", sessionId: Self.sessionOne)
        #expect(state.isChatStreaming)
        #expect(state.chatErrorMessage == nil)
    }

    @Test("transport failure of the chat.send roundtrip itself lands in failed(internal)")
    func transportFailure() {
        let state = AppState()
        state.appendUserMessage("offline question")
        state.applyChatSendFailure("not connected")
        #expect(state.chatPhase == .failed(code: "internal"))
        #expect(state.chatErrorMessage == "not connected")
        #expect(state.lastUserChatText == "offline question")
    }

    /// The last-user-text cache must track the transcript on clear: after a
    /// reset there is no row to retry, so the banner's Retry text is nil.
    @Test("resetConversation clears lastUserChatText")
    func resetClearsLastUserChatText() {
        let state = AppState()
        state.appendUserMessage("offline question")
        state.applyChatSendFailure("not connected")
        #expect(state.lastUserChatText == "offline question")
        state.resetConversation()
        #expect(state.lastUserChatText == nil)
    }

    /// Regression: a local turn failure (watchdog timeout / cancelPendingTurn)
    /// must discard deltas AND terminal events that raced ahead of the send
    /// response, not just the terminals — otherwise failed turns leak buffered
    /// streaming text into every later turn of the session.
    @Test("send failure discards racing chunks and terminals; next turn unaffected")
    func sendFailureDiscardsRacingBuffers() {
        let state = AppState()
        state.appendUserMessage("offline question")
        // Deltas and a chat_done arrive BEFORE the response frame.
        state.applyChatChunk(requestId: Self.requestA, delta: "racing ")
        state.applyChatChunk(requestId: Self.requestA, delta: "deltas")
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.bufferedChatChunkCount == 2)

        state.applyChatSendFailure("watchdog timeout")
        #expect(state.chatPhase == .failed(code: "internal"))
        // Both buffers drained: no cross-turn residue.
        #expect(state.bufferedChatChunkCount == 0)

        // The racing terminal was discarded too: re-pinning the same
        // requestId enters streaming instead of instantly resolving to idle.
        state.appendUserMessage("retry")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.isChatStreaming)
        // In-order success path is untouched by the earlier failure.
        state.applyChatChunk(requestId: Self.requestA, delta: "fresh ")
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .idle)
        #expect(state.bufferedChatChunkCount == 0)
    }

    @Test("chat_error aborted maps to cancelled, not failed")
    func cancelMapsToCancelled() {
        let state = AppState()
        state.appendUserMessage("long question")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatChunk(requestId: Self.requestA, delta: "working…")

        state.applyChatError(requestId: Self.requestA, code: "aborted", message: "cancelled by user")
        #expect(state.chatPhase == .cancelled)
        #expect(!state.isChatStreaming)
        #expect(state.activeChatRequestId == nil)
        // A cancelled turn is not an error: no banner message.
        #expect(state.chatErrorMessage == nil)
    }

    @Test("done after cancel resolves back to idle for the next turn")
    func doneAfterCancelled() {
        let state = AppState()
        state.appendUserMessage("q")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatError(requestId: Self.requestA, code: "aborted", message: "cancelled by user")
        #expect(state.chatPhase == .cancelled)

        state.appendUserMessage("again")
        state.applyChatSendResult(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", sessionId: Self.sessionOne)
        state.applyChatDone(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", sessionId: Self.sessionOne)
        #expect(state.chatPhase == .idle)
        #expect(state.chatMessages.count == 3) // user, user, assistant — the aborted turn committed no row
    }

    @Test("turn-pending window gates a racing second send; first response applies normally")
    func turnPendingGatesSecondSend() {
        let state = AppState()
        #expect(!state.isTurnPending)

        // Send #1: the user row is appended but chat.send has not responded,
        // so the phase is still .idle — the exact window where a second send
        // used to slip through and get silently dropped.
        state.appendUserMessage("first question")
        #expect(state.isTurnPending)
        #expect(state.chatPhase == .idle)
        #expect(!state.isChatStreaming)

        // AskView's guard rejects send #2: the gate is open only when the
        // turn is neither pending nor streaming.
        #expect(state.isTurnPending || state.isChatStreaming)

        // The response pins streaming; pending clears but the gate holds.
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(!state.isTurnPending)
        #expect(state.isChatStreaming)

        // Send #1 completes normally end-to-end…
        state.applyChatChunk(requestId: Self.requestA, delta: "answer ")
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .idle)
        #expect(state.chatMessages.count == 2)
        #expect(state.chatMessages[1].text == "answer ")
        // …and only now does the gate reopen.
        #expect(!state.isTurnPending && !state.isChatStreaming)
    }

    /// AskView's «New Conversation» toolbar button disables on exactly this
    /// expression: a turn owns the session from the appended user row until
    /// chat_done/chat_error, and resetting mid-turn would orphan the live run.
    @Test("new-conversation gate: disabled while pending or streaming, enabled after settle")
    func newConversationGateTracksTurnLifecycle() {
        let state = AppState()
        // Fresh session with nothing in flight: reset is available.
        #expect(!(state.isTurnPending || state.isChatStreaming))

        // The user row lands before streaming pins — the old
        // `chatMessages.isEmpty && !isChatStreaming` predicate went dead here,
        // leaving the button ENABLED mid-turn. The new one must be closed for
        // the whole pending window.
        state.appendUserMessage("what about the spool format?")
        #expect(state.isTurnPending || state.isChatStreaming)

        // Streaming pins; still closed…
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.isTurnPending || state.isChatStreaming)

        // …through every chunk.
        state.applyChatChunk(requestId: Self.requestA, delta: "answer ")
        #expect(state.isTurnPending || state.isChatStreaming)

        // Settled: the transcript has rows but the gate reopens, so a legit
        // new conversation can start (this rejects a naive
        // `!chatMessages.isEmpty` disable).
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(!state.chatMessages.isEmpty)
        #expect(!(state.isTurnPending || state.isChatStreaming))

        // Same after an error settle: retry keeps the rows, gate reopens.
        state.appendUserMessage("again")
        state.applyChatSendResult(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", sessionId: Self.sessionTwo)
        state.applyChatError(requestId: "01M0NP9G4HP0M1M64H8TC0VEKB", code: "aborted", message: "cancelled")
        #expect(!state.chatMessages.isEmpty)
        #expect(!(state.isTurnPending || state.isChatStreaming))
    }

    @Test("local chat.send failure clears the turn-pending gate so retry can fire")
    func transportFailureClearsPending() {
        let state = AppState()
        state.appendUserMessage("offline question")
        #expect(state.isTurnPending)

        state.applyChatSendFailure("not connected")
        #expect(!state.isTurnPending)
        #expect(state.chatPhase == .failed(code: "internal"))
        #expect(state.lastUserChatText == "offline question")
    }

    /// A user-initiated cancel of a still-pending turn resolves as
    /// .cancelled — the same phase a wire chat_error{aborted} produces — not
    /// .failed: the error banner (and its Retry re-send) must render nothing.
    @Test("cancelPendingTurn resolves as cancelled with no failure banner")
    func pendingCancelMapsToCancelled() {
        let state = AppState()
        state.appendUserMessage("never answered")
        #expect(state.isTurnPending)

        state.cancelPendingTurn()
        #expect(!state.isTurnPending)
        #expect(state.chatPhase == .cancelled)
        #expect(state.chatErrorMessage == nil)
        #expect(state.bufferedChatChunkCount == 0)
    }

    @Test("cancelPendingTurn is a no-op once the turn resolved")
    func pendingCancelNoopAfterResolve() {
        let state = AppState()
        state.appendUserMessage("hello")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)

        state.cancelPendingTurn()
        #expect(state.chatPhase == .idle)
    }

    @Test("resetConversation drops a still-pending turn")
    func resetClearsPending() {
        let state = AppState()
        state.appendUserMessage("never answered")
        #expect(state.isTurnPending)

        state.resetConversation()
        #expect(!state.isTurnPending)
        #expect(state.chatMessages.isEmpty)
        #expect(state.bufferedChatChunkCount == 0)
    }

    /// Regression: chat_done racing ahead of the chat.send response frame
    /// must resolve the turn once the response pins it, not leave it wedged
    /// in .streaming with the terminal event consumed (composer disabled,
    /// New Conversation gated, watchdog cancelled against a dead run).
    @Test("done before send response: buffered terminal resolves the turn on pin")
    func earlyDoneResolvesOnPin() {
        let state = AppState()
        state.appendUserMessage("racing question")
        #expect(state.isTurnPending)

        // Daemon emits chunks AND chat_done before the response frame lands.
        state.applyChatChunk(requestId: Self.requestA, delta: "early ")
        state.applyChatChunk(requestId: Self.requestA, delta: "answer")
        state.applyChatDone(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.isTurnPending) // nothing resolved until the response pins

        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .idle)
        #expect(!state.isChatStreaming)
        #expect(!state.isTurnPending)
        #expect(state.chatMessages.count == 2)
        #expect(state.chatMessages[1].role == .assistant)
        #expect(state.chatMessages[1].text == "early answer")
        #expect(state.currentChatSessionId == Self.sessionOne)
    }

    /// Regression: chat_error arriving before the send response must land in
    /// the failed phase with the banner message once pinned — not wedge the
    /// turn in .streaming forever.
    @Test("error before send response: buffered terminal fails the turn on pin")
    func earlyErrorFailsOnPin() {
        let state = AppState()
        state.appendUserMessage("doomed question")

        state.applyChatChunk(requestId: Self.requestA, delta: "partial")
        state.applyChatError(
            requestId: Self.requestA,
            code: "llm_unavailable",
            message: "model backend is offline"
        )
        #expect(state.chatPhase != .failed(code: "llm_unavailable")) // still pending

        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .failed(code: "llm_unavailable"))
        #expect(!state.isChatStreaming)
        #expect(!state.isTurnPending)
        #expect(state.chatErrorMessage == "model backend is offline")
    }

    /// A buffered error with code `aborted` maps to `.cancelled` through the
    /// same replay path as the in-order case.
    @Test("aborted error before send response maps to cancelled on pin")
    func earlyAbortedErrorCancels() {
        let state = AppState()
        state.appendUserMessage("cancel me")

        state.applyChatError(requestId: Self.requestA, code: "aborted", message: "")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        #expect(state.chatPhase == .cancelled)
        #expect(!state.isChatStreaming)
        #expect(!state.isTurnPending)
    }

    /// Round 27 regression: the send window previously had only
    /// awaitingSendResult as its token, so turn A's late response after a
    /// watchdog failure + re-send (turn B) passed the guard and pinned B's
    /// window with A's ids. appendUserMessage must bump the send-window
    /// epoch so the connection layer can discard stale responses.
    @Test("re-send after watchdog failure opens a new send-window epoch")
    func resendBumpsSendWindowEpoch() {
        let state = AppState()
        state.appendUserMessage("A")
        let epochA = state.currentSendWindowEpoch

        // Watchdog fires: A's window closes.
        state.applyChatSendFailure("The request timed out waiting for the daemon.")
        #expect(state.currentSendWindowEpoch == epochA)

        // User re-sends as B: a NEW epoch opens; A's captured epoch is stale.
        state.appendUserMessage("B")
        #expect(state.currentSendWindowEpoch != epochA)
    }

    /// Round 27 regression: .streaming survived a daemon disconnect, leaving
    /// the composer permanently disabled and cancel targeting a stale
    /// requestId on the restarted daemon.
    @Test("handleConnectionLost resolves a pinned streaming turn to failed")
    func connectionLostResolvesStreamingTurn() {
        let state = AppState()
        state.appendUserMessage("hello")
        state.applyChatSendResult(requestId: Self.requestA, sessionId: Self.sessionOne)
        state.applyChatChunk(requestId: Self.requestA, delta: "partial ")
        #expect(state.isChatStreaming)

        state.handleConnectionLost()

        #expect(!state.isChatStreaming)
        guard case let .failed(code) = state.chatPhase else {
            Issue.record("expected .failed after connection loss")
            return
        }
        #expect(code == "internal")
        #expect(state.activeChatRequestId == nil)
        #expect(state.chatStreamingText == nil)
        #expect(state.bufferedChatChunkCount == 0)
        #expect(state.chatErrorMessage == "The connection to the daemon was lost.")
        // Session continuity across a restart is deliberate: the daemon
        // accepts unknown session ids, so reuse preserves conversation.
        #expect(state.currentChatSessionId == Self.sessionOne)
    }

    @Test("handleConnectionLost routes a pending send through the failure path")
    func connectionLostFailsPendingTurn() {
        let state = AppState()
        state.appendUserMessage("hello")
        #expect(state.isTurnPending)

        state.handleConnectionLost()

        #expect(!state.isTurnPending)
        #expect(state.chatPhase == .failed(code: "internal"))
        #expect(state.chatErrorMessage == "The connection to the daemon was lost.")
    }
}
