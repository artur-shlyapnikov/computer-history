# Timeline and search

Timeline and search is how a user recalls the day: the Timeline window lists the 50 newest episodes (auto-refreshing every 5s), clicking one opens its semantic steps, and the Search history field queries episode/step full-text with All/Episodes/Steps scope.

## Sub-features

- `timeline-list` returns the newest episode summaries (empty on a fresh home).
- `segments-list` returns live activity segments with ordered steps before episodes exist.
- `episode-get` opens one episode with its ordered steps.
- `search-match` returns title/body matches without changing stored data.
- `search-empty` distinguishes no matches (empty hits) from an error.
- `search-scope` limits results to episodes or steps.

## How to get to it (user POV)

- Click the menu-bar icon, open Timeline; the list loads via `timeline.list`.
- Click an episode; details load via `episode.get`.
- Type in the `Search history` field and press Enter (scope `All`, `Episodes`, or `Steps`); the UI sends `history.search` (max 50 results).
- Verification drives the same ops with `ch-ipc request`.

## Driving it with ch-ipc

Preconditions:

- Daemon is healthy at a disposable `$CH_HOME` (`ch-ipc doctor` exits 0).
- Seed: one `event_batch` with two Safari `metadata_only` events (one `app_focus` on window `Webhook failures — GitHub`, one `scroll`), acked `accepted 2`.
- Background summarization needs LLM credentials and is absent: episodes may be empty; segments and search index behavior is what this recipe proves.

- **Empty timeline.** List before processing completes. Run `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs request --home "$CH_HOME" --op timeline.list --params '{"limit":50}'`. `result.episodes` is an array (possibly empty); the call itself is `ok:true`.
- **Live segments.** Read what capture produced. Run `ch-ipc request --home "$CH_HOME" --op segments.list --params '{"limit":50}'`. After the seed batch and the ~2s watermark lag, at least one segment appears with the seeded step text.
- **Search match.** Query the seeded content. Run `ch-ipc request --home "$CH_HOME" --op history.search --params '{"query":"webhook","scope":"both","limit":50}'`. At least one hit references the seeded window title; stored counts in `status.get` are unchanged (search is read-only).
- **Search miss.** Query an absent value. Run `ch-ipc request --home "$CH_HOME" --op history.search --params '{"query":"volcano-quasar-zz","scope":"both","limit":50}'`. `result.hits` is `[]` with `ok:true`.
- **Open episode.** Only when `timeline.list` returned an episode: run `ch-ipc request --home "$CH_HOME" --op episode.get --params '{"id":"<episode-id>"}'`. The episode plus ordered `steps` return; an unknown ULID answers `error.not_found` (prove the miss too when no episode exists).
- **Proof.** Save the seed ack, `segments.list`, both searches, and `status.get` under `verification-evidence/<run-id>/timeline-search/`. The artifacts show the query, the matching hit, the empty miss, and unchanged DB counts.

## Gotchas

- The watermark lag (~2s) means events observed in the last 2 seconds are not yet eligible for segments/search; backdate `observedAt` or wait before asserting.
- `history.search` `limit` is 1–50 and `query` caps at 512 chars; out-of-range values answer `error.invalid_params`, not empty hits.
- A step not yet linked to an episode can appear in search but cannot open an episode — that is expected, not a failure.
- Search ranking order is daemon-defined; assert membership and snippet content, never an exact order across runs.
