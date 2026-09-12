# Settings, delete, and diagnostics

Settings, delete, and diagnostics is the control plane: Settings shows pause/resume, per-app capture modes, and read-only model/retention values; deletion removes a time range after confirmation; Diagnostics shows daemon status, DB counts, disk space, integrity, and recent errors with Copy Report.

## Sub-features

- `settings-read` reports effective chat/background models and retention horizons.
- `status-read` reports version, uptime, queue, DB counts, and free disk.
- `diagnostics-read` reports integrity flag plus newest-first error tail.
- `delete-range` removes a time range in one transaction and broadcasts changes.
- `delete-guards` rejects mixed or inverted range params with typed errors.

## How to get to it (user POV)

- Menu-bar icon → Settings (pause/resume, per-app overrides, delete last 10 min / hour / today / all / one day, read-only model + retention rows).
- Menu-bar icon → Diagnostics (status, counts, disk, integrity, recent errors, Copy Report).
- Verification drives the same ops with `ch-ipc request`.

## Driving it with ch-ipc

Preconditions:

- Daemon is healthy at a disposable `$CH_HOME` (`ch-ipc doctor` exits 0).
- Seed: one `event_batch` with two `metadata_only` events, acked `accepted 2`, so deletion has something to remove.

- **Settings.** Read effective config. Run `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs request --home "$CH_HOME" --op settings.get --params '{}'`. `result.settings` carries `chatModel`, `backgroundModel`, `rawRetentionHours 48`, `semanticRetentionDays 30`.
- **Status.** Run `ch-ipc request --home "$CH_HOME" --op status.get --params '{}'`. `daemon.version` is `0.0.0` in source-tree runs (pinned fallback, not a failure), `db.rawEvents` is at least 2, `diskFreeBytes` is positive.
- **Diagnostics.** Run `ch-ipc request --home "$CH_HOME" --op diagnostics.get --params '{}'`. `integrityOk` is `true` and `lastErrors` is an array.
- **Guard: mixed params.** Run `ch-ipc request --home "$CH_HOME" --op delete.range --params '{"preset":"all","from":0}'`. The daemon answers `error.invalid_params` (exit 3) and `status.get` counts are unchanged.
- **Guard: inverted range.** Run with `from` greater than `to`. Same typed `invalid_params`, counts unchanged.
- **Delete all.** Run `ch-ipc request --home "$CH_HOME" --op delete.range --params '{"preset":"all"}'`. `result.deleted` tallies the removal; follow with `status.get` (`rawEvents 0`) and `history.search` for the seeded text (empty hits) — the second view is the proof, not the tallies alone.
- **Proof.** Save settings, status (before/after delete), diagnostics, both guard rejections, the delete result, and the post-delete search under `verification-evidence/<run-id>/settings-delete-diagnostics/`.

## Gotchas

- `delete.range` accepts preset OR both `from`+`to`, never mixed, never half a range — the guards above are the contract, not edge trivia.
- `settings.set` is intentionally unregistered and answers `error.not_implemented`; model/retention rows are read-only in this UI — do not "verify" a settings write.
- `diagnostics.get` runs `quick_check`, not the full startup `integrity_check`; a corrupt DB still kills the daemon at boot with exit 46 and never reaches this op.
- A range delete also removes candidate workflows below occurrence thresholds, but a manually confirmed memory survives — assert seeded-event removal, not memory removal, after `preset: all`.
