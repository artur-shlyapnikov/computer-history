# Computer History verification map

This directory is the maintained source for verifying the user-facing behavior
of Computer History. Read the index before driving the daemon, then use the
matching feature file as the recipe.

## Baseline preconditions

- Build once: `pnpm build` from the repo root.
- Launch one daemon per run with a disposable home:
  `CH_HOME=/tmp/ch-verify-$RUN_ID`, `COMPUTER_HISTORY_HOME="$CH_HOME"
  node apps/daemon/dist/main.js`, PID in `$CH_HOME/daemon.pid`.
- Ready means `ch-ipc doctor --home "$CH_HOME"` exits 0 (socket accepts IPC).
- Never drive the default home (`~/Library/Application Support/ComputerHistory`).
- Put `helpers/ch-ipc.mjs` on the command line via
  `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs`.
- LLM credentials are absent: chat paths prove typed degradation only.
- Proof artifacts live under `verification-evidence/<run-id>/` and survive cleanup.

## Driving conventions

- Start every recipe from a fresh daemon unless its preconditions say otherwise.
- `event_batch` frames carry at most 1000 events; every ActivityEvent needs a
  ULID `id`, epoch-ms `observedAt`, `source`, `app.bundleId`, `action`, and
  `contentPolicy` (`metadata_only` unless the recipe says otherwise).
- Treat every command as literal. Keep op names, quoted params, and flags unchanged.
- Run health checks through `ch-ipc doctor`.
- Run reads through `ch-ipc request --op <op> --params '{...}'`.
- Run capture through `ch-ipc batch --file <batch.json>`.
- Restore nothing: each run owns its `$CH_HOME`; `rm -rf "$CH_HOME"` ends it.
  Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action (command + request/ack frame) and the resulting
  state (follow-up read + `status.get` counts), not only the final response.
- IPC proof includes the exact command, the full response JSON, and exit code.
- Mutation proof includes a read-only second view of the stored value
  (`segments.list` after ingest, `episode.get` after `timeline.list`,
  re-search after `delete.range`).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- The recorder GUI (menu-bar windows) is out of scope for scripted runs: it
  needs an interactive macOS session with Accessibility + Input Monitoring
  grants. The IPC ops below are the exact frames those windows send.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Capture ingest](./capture-ingest.md) covers the recorder-to-daemon capture path: batch ack, dedup, validation, disk-pressure refusal.
- [Timeline and search](./timeline-search.md) covers the Timeline window and Search history field: segments, episodes, full-text search.
- [Memories and workflows](./memories-workflows.md) covers the Memories and Workflows windows: lists and confirm/reject/forget actions.
- [Settings, delete, and diagnostics](./settings-delete-diagnostics.md) covers Settings, history deletion, Diagnostics, and daemon status.
