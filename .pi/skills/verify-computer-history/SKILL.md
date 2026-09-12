---
name: verify-computer-history
description: Drive the Computer History daemon over its Unix-socket IPC the way the recorder does — ingest activity, timeline/search, memories/workflows, settings/delete/diagnostics. Reach for it whenever behavior must be proven against a real daemon instead of unit tests.
---

# Verify Computer History

Computer History records macOS activity (Swift menu-bar recorder) and stores /
searches it in a Node.js daemon over a versioned Unix-socket protocol. The
recorder UI needs an interactive macOS session with Accessibility + Input
Monitoring permissions, so scripted verification drives the **daemon IPC
service** directly with the same frames the recorder sends. That is the real
user path at the protocol layer: `event_batch` for capture, `timeline.list` /
`history.search` / `episode.get` for the Timeline + Search windows,
`memories.*` / `workflow.*` / `chat.*` for Memories/Workflows/Ask, and
`settings.get` / `delete.range` / `diagnostics.get` / `status.get` for
Settings/Diagnostics.

## Launch

Build once from the repo root, then start one daemon per verification run
against a disposable home. Never use the user's real home
(`~/Library/Application Support/ComputerHistory`).

```sh
RUN_ID="v$$-$(date +%s)"
export CH_HOME="/tmp/ch-verify-$RUN_ID"
mkdir -p "$CH_HOME"
pnpm build
COMPUTER_HISTORY_HOME="$CH_HOME" node apps/daemon/dist/main.js \
  >"$CH_HOME/daemon.stdout.log" 2>"$CH_HOME/daemon.stderr.log" &
echo $! >"$CH_HOME/daemon.pid"
```

Ready means the socket accepts framed IPC, not just that the file exists (a
crashed predecessor can leave a stale file behind). Poll for at most ~30s:

```sh
for i in $(seq 1 150); do
  node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs doctor \
    --home "$CH_HOME" >/dev/null 2>&1 && break
  sleep 0.2
done
node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs doctor --home "$CH_HOME"
```

Teardown is `kill -TERM` on the recorded PID with `SIGKILL` escalation (see
Cleanup). For a short-lived check there is no server to keep alive: build once,
then start each drive in its own `CH_HOME`.

Isolation: two instances run side by side when each has its own
`COMPUTER_HISTORY_HOME` (socket, DB, spool, logs all live under it). A second
daemon on the same home refuses to start (`EADDRINUSE` semantics) — that is
the guard, not a bug. Refuse to double-drive a shared instance: if
`CH_HOME` is unset or points at the default home, stop and ask.

## Doctor

One read-only check, run first whenever anything looks off:

```sh
node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs doctor --home "$CH_HOME"
```

It answers "is this instance worth driving?": socket exists and is a socket,
handshake returns `server_hello` with `protocolVersion 1`, and `status.get`
returns the daemon version / schema version / recording / queue / db counts.
`daemonVersion` is `0.0.0` in a source-tree run (pinned fallback: the manifest
only exists in the packaged layout) and the real version only when packaged —
assert `0.0.0` here, not `apps/daemon/package.json`. Check `schemaVersion`
against the migrated schema (13 at the time of writing; confirm via
`ls apps/daemon/src/db/migrations/`). If doctor fails, do not
drive — fix launch first (stale socket, wrong home, crashed daemon; check
`$CH_HOME/daemon.stderr.log`).

## Drive

The harness is `ch-ipc` (stdlib-only Node, no deps). Three commands:

```sh
# read-only op (Timeline, search, memories, workflows, settings, diagnostics)
node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs request \
  --home "$CH_HOME" --op history.search --params '{"query":"safari","scope":"both","limit":10}'

# capture path (exactly what the recorder sends)
node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs batch \
  --home "$CH_HOME" --file /tmp/batch.json

# health gate
node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs doctor --home "$CH_HOME"
```

`request` prints the full response frame (`ok:true` + `result`, or `ok:false`
+ `error.code`) and exits 0 on ok, 3 on op error. It transparently skips
server-pushed `event` broadcasts (`queue_update`, `episodes_changed`, …) while
waiting for the matching `requestId`. `batch` fills missing envelope fields
(`protocolVersion`, `messageId`, `sentAt`, `batchId`) and prints the
`event_batch_ack` (`accepted`/`duplicates`/`rejected`).

Pinned op names (from `packages/protocol/src/ipc.ts`; unknown ops answer
`error.not_found`, unimplemented ones `error.not_implemented`):

- capture: `event_batch` frame (max 1000 events; ActivityEvent needs ULID
  `id`, epoch-ms `observedAt`, `source`, `app.bundleId`, `action`,
  `contentPolicy`)
- timeline: `timeline.list` (`limit` 1–50), `segments.list` (`limit` 1–200),
  `episode.get` (`id` ULID)
- search: `history.search` (`query` ≤512 chars, `scope` episodes|steps|both,
  `limit` 1–50, `apps` ≤32)
- memories: `memories.list` (`status` confirmed|suggestions|rejected|
  superseded), `memory.action` (`confirm`|`reject`|`forget`)
- workflows: `workflows.list`, `workflow.action` (`confirm`|`reject`)
- settings/delete/diag: `settings.get`, `delete.range` (preset
  last_10_minutes|last_hour|today|all, or both `from`+`to`, never mixed),
  `diagnostics.get`, `status.get`, `jobs.retryDead`
- chat (`chat.send`/`chat.cancel`) needs provider credentials; without them the
  daemon answers `chat_error llm_unavailable`. Local capture, SQLite history,
  and full-text search still work — verify chat only to prove that typed
  degradation, not answers.

Prefer stable handles: op names, ULID ids returned by previous calls, exact
`--params` JSON. Never coordinate-drive the user's default home.

## Evidence

Proof artifacts survive teardown under `verification-evidence/<run-id>/`
(repo root, gitignored). Per drive capture:

- the action: exact `ch-ipc` command line + full request/ack frame JSON
- the resulting state: the follow-up read (e.g. `segments.list` after a batch,
  `episode.get` after `timeline.list`, second `history.search` after ingest)
  plus `status.get` db counts showing the side effect (rows inserted, rows
  deleted by `delete.range`)
- daemon log tail (`$CH_HOME/logs/daemon.jsonl`) and exit code where relevant

Proof standards: exercise the real user path (framed IPC the recorder sends,
not in-process setters or test-only endpoints); capture the action and the
resulting state, not just the final screen; verify side effects (DB counts,
`daemon.jsonl`, ack counts) alongside what's visible; mocks only where a
production boundary already isolates the external system (chat LLM calls —
assert the `llm_unavailable` degradation, never fake an answer). `delete.range`
is the destructive path: verify what it actually removed via `status.get`
counts and a follow-up search returning no hits, not via its `deleted` tallies
alone.

## Cleanup

Kill what you started, by PID — never by process name (`pkill -f main.js`
would murder the user's own daemon):

```sh
kill -TERM "$(cat "$CH_HOME/daemon.pid")"
for i in $(seq 1 100); do kill -0 "$(cat "$CH_HOME/daemon.pid")" 2>/dev/null || break; sleep 0.15; done
kill -KILL "$(cat "$CH_HOME/daemon.pid")" 2>/dev/null || true
rm -rf "$CH_HOME"
```

Cleanup removes the daemon instance and scratch state (`$CH_HOME`: socket, DB,
spool, logs), never the evidence: `verification-evidence/<run-id>/` stays.
Run cleanup after every failed iteration too, so broken attempts don't strand
processes and ports (there are no TCP ports — the stranded resource is the
socket file + DB lock inside `$CH_HOME`).

## Helpers

- `helpers/ch-ipc.mjs` (executable, stdlib only) — the whole harness.
  Invocations are shown under Drive; `doctor` doubles as readiness probe and
  health gate. No other helper ships: DB inspection uses the daemon's own
  `status.get` / `diagnostics.get` ops plus the log file, so the proof never
  depends on a second SQLite reader.
