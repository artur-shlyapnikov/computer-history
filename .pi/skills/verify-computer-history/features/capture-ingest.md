# Capture ingest

Capture ingest is the recorder's capture path: macOS activity becomes framed `event_batch` payloads the daemon validates, dedups, and persists, so later Timeline and search windows have something to show.

## Sub-features

- `ingest-accept` acknowledges a well-formed batch with per-event counts.
- `ingest-dedup` counts a resent event id as duplicate, not a new row.
- `ingest-reject` refuses a schema-invalid batch with a typed protocol error.
- `ingest-visible` makes accepted events observable through read-only ops.

## How to get to it (user POV)

- Leave the menu-bar recorder running; it batches permitted activity and sends `event_batch` over the socket automatically.
- After a daemon outage, the recorder replays spool files oldest first (automatic; menu bar shows queued-event count).
- Verification drives the same frames with `ch-ipc batch` (the recorder's exact wire path).

## Driving it with ch-ipc

Preconditions:

- Daemon is healthy at a disposable `$CH_HOME` (`ch-ipc doctor` exits 0).
- No seed data needed; the run owns its empty database.
- A batch file with two `metadata_only` Safari events (ULID ids, epoch-ms `observedAt`).

- **Send batch.** Deliver the batch the way the recorder does. Run `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs batch --home "$CH_HOME" --file /tmp/batch.json`. The printed `event_batch_ack` echoes the `batchId` with `accepted 2`, `duplicates 0`, `rejected 0`.
- **Confirm counts.** Read the stored side effect. Run `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs request --home "$CH_HOME" --op status.get --params '{}'`. The `db.rawEvents` count is at least 2.
- **Resend for dedup.** Replay the identical file (spool-replay shape). Run the same `batch` command again. The ack reads `accepted 0`, `duplicates 2`, and `status.get` `rawEvents` is unchanged.
- **Invalid batch.** Send one event with a missing `id`. Run `ch-ipc batch` with that file. The daemon answers `error.bad_frame` `malformed event_batch` and closes that connection; `doctor` still passes afterwards on a fresh connection.
- **Proof.** Save the ack JSON, both `status.get` outputs, and the error frame under `verification-evidence/<run-id>/capture-ingest/`. The artifacts show the batchId, the count transitions 0 → 2 → 2, and the typed rejection.

## Gotchas

- Max 1000 events per batch; oversize batches are a protocol violation, not a partial accept.
- Event `id`, `batchId`, and `messageId` values must be 26-char Crockford ULIDs
  (no I, L, O, U). A 25-char id fails validation and the whole batch is
  refused as `error.bad_frame malformed event_batch` — generate ids with the
  workspace `ulid` package, don't hand-roll them.
- The daemon never recreates a corrupt database (exit 46, `History database needs recovery`); a dead daemon at launch means `doctor` fails — check stderr, don't retry blindly.
- Broadcast `event` frames (`queue_update`, `recording_state`) can arrive between hello and ack; `ch-ipc` already skips them — raw socket readers must too.
- Disk-pressure refusal (`error.disk_pressure`) only triggers under 1 GiB free; do not fill a disk to test it — assert the gate exists via `status.get recording.paused`, not by manufacturing pressure.
