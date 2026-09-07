import SwiftUI

/// «Ask your history» window (spec §3.18–3.19): transcript of user/assistant
/// bubbles, streaming assistant draft fed by `chat_chunk`, progress until
/// `chat_done`, error banner + retry on `chat_error`, input disabled while a
/// turn is streaming or pending, cancel button → `chat.cancel` (or, while
/// the send response is still outstanding, AppState's local pending-turn
/// cancel — SD-5), New-conversation resets the session.
///
/// The view is intentionally dumb: all transitions live in AppState's chat
/// state machine (pure, socket-free tests inject sequences directly). Send and
/// cancel closures are wired by the app entry point to the DaemonClient.
struct AskView: View {
    @EnvironmentObject private var appState: AppState
    /// Sends one user turn end-to-end (append row → chat.send → stream).
    var onSend: (@MainActor (_ text: String) async -> Void)?
    /// Cancels the active turn via `chat.cancel`.
    var onCancel: (() async -> Void)?

    @State private var draft: String = ""
    /// Tracks whether the transcript tail is on screen (bottom sentinel):
    /// per-chunk auto-scroll must never yank a reader who scrolled up.
    @State private var nearBottom = true

    /// Stable identity for the bottom sentinel so both autoscroll handlers
    /// can land it inside the viewport, keeping the nearBottom gate
    /// self-consistent after every landed scroll.
    private static let bottomSentinelId = "ask-bottom-sentinel"

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider()
            errorBanner
            inputBar
        }
        .frame(minWidth: 420, minHeight: 520)
        .navigationTitle("Ask Your History")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Conversation") {
                    appState.resetConversation()
                }
                // A turn occupies the session from appendUserMessage until
                // chat_done/chat_error; resetting mid-turn would orphan the
                // live run (its chat_chunk/chat_done would be dropped by the
                // requestId guards and could no longer be cancelled).
                .disabled(appState.isTurnPending || appState.isChatStreaming)
                .keyboardShortcut("n", modifiers: .command)
            }
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if appState.chatMessages.isEmpty, appState.chatStreamingText == nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Ask anything about your recorded history.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            // Starters: tap prefills the composer, never
                            // auto-sends; locked while a turn occupies the
                            // session like the composer itself.
                            ForEach(Self.examplePrompts, id: \.self) { prompt in
                                Button(prompt) { draft = prompt }
                                    .font(.subheadline)
                                    .disabled(appState.isTurnPending || appState.isChatStreaming)
                            }
                        }
                        .padding(.top, 24)
                    }
                    ForEach(appState.chatMessages) { message in
                        bubble(role: message.role, text: message.text, id: message.id.uuidString)
                    }
                    if let streaming = appState.chatStreamingText {
                        // SD-6: keyed on the stable draft id — a fresh UUID()
                        // per body evaluation changed `.id` on every chunk and
                        // tore the row down for each delta.
                        bubble(role: .assistant, text: streaming, id: appState.streamingDraftId)
                    } else if appState.isChatStreaming {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Thinking…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12)
                    }
                    // Bottom sentinel: the lazy stack materializes it only
                    // while the tail is visible, so appear/disappear track
                    // "reading the latest" without scroll-offset machinery.
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomSentinelId)
                        .onAppear { nearBottom = true }
                        .onDisappear { nearBottom = false }
                }
                .padding(12)
            }
            .onChange(of: appState.chatMessages.count) { _, _ in
                // A just-sent user message always scrolls into view; an
                // assistant append (answer completion) must respect the
                // gate like streaming chunks do. Scrolling the sentinel —
                // not the last bubble, whose .bottom anchor leaves the 1pt
                // row below the fold — keeps it inside the viewport so a
                // landed scroll can't immediately close the gate.
                guard let last = appState.chatMessages.last,
                      last.role == .user || nearBottom else { return }
                proxy.scrollTo(Self.bottomSentinelId, anchor: .bottom)
            }
            .onChange(of: appState.chatStreamingText ?? "") { _, _ in
                // The draft bubble grows per chunk; keep its tail visible —
                // but only while the user is already reading the tail. After
                // they scroll up to re-read, chunks no longer yank; returning
                // to the bottom (sentinel reappears) resumes auto-scroll.
                // Anchor at the sentinel so every landed scroll ends with it
                // inside the viewport and the gate stays self-consistent.
                guard nearBottom else { return }
                proxy.scrollTo(Self.bottomSentinelId, anchor: .bottom)
            }
        }
    }

    private func bubble(role: AppState.ChatMessage.ChatRole, text: String, id: String) -> some View {
        HStack {
            if role == .user {
                Spacer(minLength: 40)
            }
            Text(text.isEmpty ? "…" : text)
                .textSelection(.enabled)
                .padding(10)
                .background(role == .user ? Color.accentColor.opacity(0.18) : Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            if role == .assistant {
                Spacer(minLength: 40)
            }
        }
        .id(id)
    }

    // MARK: - Error banner

    @ViewBuilder
    private var errorBanner: some View {
        if case let .failed(code) = appState.chatPhase {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(chatErrorTitle(code)).font(.footnote).fontWeight(.medium)
                    if let detail = appState.chatErrorMessage {
                        Text(detail).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let retryText = appState.lastUserChatText {
                    Button("Retry") {
                        Task { await onSend?(retryText) }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.orange.opacity(0.12))
        }
    }

    private func chatErrorTitle(_ code: String) -> String {
        switch code {
        case "llm_unavailable": "The model is unavailable right now."
        case "internal": "The request failed."
        default: "The request failed (\(code))."
        }
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Ask about your history…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1 ... 4)
                .disabled(appState.isTurnPending || appState.isChatStreaming)
                .onSubmit(sendDraft)
            if appState.isChatStreaming || appState.isTurnPending {
                Button("Cancel") {
                    // While the send response is still outstanding the wire
                    // chat.cancel has no requestId to target; the local
                    // pending-turn cancel resolves the turn as .cancelled and
                    // unlocks the composer (no-op once streaming). The error
                    // banner renders nothing for .cancelled, so a
                    // user-initiated cancel never offers a Retry.
                    appState.cancelPendingTurn()
                    Task { await onCancel?() }
                }
                .keyboardShortcut(.cancelAction)
            } else {
                Button("Send", action: sendDraft)
                    .disabled(
                        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || appState.isTurnPending
                    )
            }
        }
        .padding(12)
    }

    /// Tap-to-prefill starters for the empty transcript.
    static let examplePrompts: [String] = [
        "What was I working on yesterday?",
        "When did I last work on this project?",
        "Summarize what I did this week",
    ]

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !appState.isTurnPending, !appState.isChatStreaming else { return }
        draft = ""
        Task { await onSend?(text) }
    }
}
