# Computer History

Local-first personal computer history for macOS: a Swift menu-bar recorder captures
privacy-filtered activity events, and a Node daemon persists them to SQLite, distills
them into episodes, memories, and workflows, and answers questions about your history
through an embedded Pi agent.

> **Status:** experimental, pre-release software (`0.1.0`). The core capture →
> distill → ask pipeline works, but the project still has rough edges and has not
> undergone an independent security review. The implementation and its
> privacy boundaries are documented throughout this README and the source.

## Features

- **Activity capture** — foreground app, window titles, typing activity (never keystrokes) via NSWorkspace + Accessibility + CGEvent.
- **Privacy-first** — per-app policy (`off | metadata | content`), secure-field skip, secret-pattern redaction; enforced twice (recorder pre-IPC + daemon re-validation at ingest).
- **Offline spool** — recorder buffers events locally, replays when the daemon is back.
- **Timeline + search** — episodes and semantic steps with full-text search (`history.search`, `timeline.list`, `episode.get`).
- **Ask your history** — chat over your data (`chat.send` / `chat.cancel`) via embedded Pi runtime.
- **Memories & workflows** — LLM-extracted memories (`memories.list`, `memory.action`) and mined workflows (`workflows.list`, `workflow.action`).
- **Delete & retention** — range delete (`delete.range`), automatic sweeps (raw events 48h, steps 30d), manually confirmed memories survive deletes.
- **Diagnostics** — `status.get`, `diagnostics.get`, `settings.get`, `jobs.retryDead`.

## Quick start

Prerequisites: macOS 14+, Xcode 16 or newer (including the iOS/macOS SDK and
Swift 6 toolchain), Node.js ≥ 24, pnpm, SwiftFormat, and SwiftLint. The Command
Line Tools alone can compile some targets but do not provide the Swift Testing
module used by the recorder test suite.

```sh
pnpm install
pnpm build            # compile TS packages (protocol + daemon)
pnpm build && pnpm daemon   # run the daemon (node dist/main.js)
pnpm app              # build the menu-bar recorder (swift build)

# or via just (mirrors package.json, daemon builds first):
just setup            # install + fixture symlink
just daemon           # build + run daemon
just app
```

LLM features (episode summaries, memory extraction, chat) need provider credentials
for the embedded Pi runtime (default agent dir `~/.pi/agent`). Without them, jobs retry
on schedule and Ask returns `llm_unavailable`.

When credentials are present, semantic activity text supplied to an LLM can leave the
Mac and be processed by the configured provider. Review that provider's retention and
training terms before enabling these features. The local recorder, SQLite history, and
full-text search continue to work without an LLM.

Environment overrides:

- `COMPUTER_HISTORY_HOME` — all daemon state (DB, socket, spool, logs); default
  `~/Library/Application Support/ComputerHistory`. Tests always use a scratch dir.
- `COMPUTER_HISTORY_CHAT_MODEL` / `COMPUTER_HISTORY_BACKGROUND_MODEL` — model ids
  (default `openai/gpt-5.6-luna`); `COMPUTER_HISTORY_LLM_AGENT_DIR` — Pi agent dir.
- `COMPUTER_HISTORY_DAEMON_CMD` — command the recorder's `DaemonSupervisor` spawns
  instead of the packaged daemon entry point.

First launch prompts for Accessibility permission
(System Settings → Privacy & Security → Accessibility). Without it the recorder runs in
`permission_missing` state and spools nothing.

## Commands

| Command                       | What it does                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm build`                  | Compile all TS packages                                                              |
| `pnpm test`                   | Run all package tests (vitest + swift parity)                                        |
| `pnpm typecheck`              | Build + `tsc --noEmit` per package                                                   |
| `pnpm lint`                   | ESLint over TS + repo root                                                           |
| `pnpm lint:swift`             | Strict Swift gate: warnings-as-errors build + swiftformat + swiftlint + `swift test` |
| `pnpm verify`                 | Full gate: typecheck + lint + lint:swift + test (mirrors CI)                         |
| `pnpm fixtures:sync`          | Verify/repair the Swift↔TS fixture symlink                                           |
| `pnpm daemon`                 | Run daemon from compiled `dist` (build first)                                        |
| `pnpm app`                    | `swift build` the recorder                                                           |
| `just fmt-check` / `just fmt` | swiftformat check / write (TS style is eslint-governed)                              |
| `just verify` / `just check`  | Run the complete local verification gate.                                         |
| `just ci`                     | Frozen install + `verify` (exact CI reproduction)                                    |
| `just doctor` / `just clean`  | Toolchain versions / remove build outputs                                            |

Soak validation is manual: [scripts/soak-checklist.md](scripts/soak-checklist.md).

## Project structure

```
apps/daemon/            Node sidecar: SQLite, migrations, IPC server, distillation jobs, Pi chat
apps/recorder-macos/    Swift/SwiftUI menu-bar app (Capture/IPC/Storage/UI/Settings)
packages/protocol/      TypeBox wire schemas + golden fixtures (single IPC contract)
scripts/                lint-swift.sh, sync-fixtures.sh, soak-checklist.md
justfile                Thin wrappers over package.json scripts (+ fmt, clean, ci, doctor)
```

Two processes, strict boundary:

```
recorder (Swift) ── Unix socket, versioned IPC ──▶ daemon (TS) ── SQLite/WAL
NSWorkspace/AX/CGEvent │ privacy filter + spool    ingest → coalesce → episodes → memories/workflows
Timeline/Ask/Memories/Workflows UI                 socket: ~/Library/Application Support/ComputerHistory/run/history.sock
```

The daemon is the single SQLite writer; the recorder never opens the DB.
IPC is length-prefixed UTF-8 JSON, versioned handshake; `packages/protocol` is the contract.

## Recorder Settings (V1)

Settings window wires for real: recording on/off, per-app capture policies (persisted,
effective immediately), delete-history presets + date range (`delete.range` behind a
confirmation dialog), read-only Diagnostics from `status.get` / `diagnostics.get`.

Deferred post-V1: editing chat/background models and retention overrides in UI —
read-only via `settings.get` for now, edit through daemon env config.

## Reliability

- Corrupt DB (`PRAGMA integrity_check` fails at startup): daemon exits with code **46**
  (`History database needs recovery`), never recreates/repairs the file; recovery is
  manual. Recorder shows `daemon_error`, keeps spooling for later replay.
- Disk pressure pauses recording; queue state visible via `status.get`.

## Privacy contract

**Pre-IPC filtering** (recorder): default `metadata` policy, `kAXSecureTextFieldSubrole`
never read, password/token/OTP labels, PEM blocks, API-key shapes, Luhn-valid card
numbers → `[REDACTED]`; strings over 2048 chars dropped.

**Double enforcement** (daemon ingest): content under a content-dropping policy, content
on `typing_activity`, secure-field targeting, or oversized content is rejected, counted,
never stored. Exemption: `redacted_secret_pattern` (already-scrubbed text is the valid
wire shape).

**Retention** (sweeps every 6h): raw events 48h; semantic steps 30d; rejected/zero-evidence
memory candidates 30d / next sweep (non-manual rows only); episodes, active/confirmed
memories, workflows until explicit delete.

**Delete:** `delete.range` cascades events/steps/episodes/derived rows (presets up to
"all"). Manually confirmed memories survive every delete, retention purge, and
consolidation; only `memory.action forget` removes them.

**Never stored:** raw keystrokes, screenshots, clipboard, secure-field text, anything
rejected by either enforcement layer. Batch logs carry counters only.

### Security limitations

The privacy filter is a defense against accidental capture, not a guarantee that a
secret can never be recorded. Window titles, application names, labels, and ordinary
text may contain sensitive information that does not match a known pattern. Use the
`off` policy for applications that handle especially sensitive material, and review
the policy before enabling `content` mode.

The local database, SQLite WAL sidecars, spool, and logs are owner-only (`0600` files
inside `0700` directories), but the application does not encrypt the SQLite database.
Protect the macOS account and its backups with FileVault and appropriate device
controls. A local administrator, malware running as the user, or a copied backup can
read local history. Logical deletion and retention do not guarantee removal from
filesystem snapshots or free-space remnants.

The Accessibility permission grants the recorder broad visibility into accessible UI
elements. Keep it limited to a trusted user account and stop the recorder before
sharing diagnostics or local data. Provider-side requests and operating-system
backups are outside the local retention and delete contract.

## License

The project is released under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the project license and direct
dependency notices.
