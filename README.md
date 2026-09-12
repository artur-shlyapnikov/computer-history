# Computer History

Computer History records activity on macOS, stores it locally, and lets you
search the resulting history. A Swift menu bar app collects activity events. A
Node.js daemon writes them to SQLite, groups them into semantic steps and
episodes, and runs optional background processing for memories and workflows.

> Status: experimental pre-release software (`0.1.0`). This repository contains
> source-tree development builds, not a packaged app. The capture, storage,
> search, and optional LLM pipeline work, but the project has not had an
> independent security review.

## What it does

- Records the foreground app, window metadata, clicks, scrolling, shortcuts,
  and typing activity. It never records raw keystrokes.
- Applies a per-app capture policy before events leave the recorder. The default
  policy keeps metadata and drops content.
- Sends events to a local daemon over a versioned Unix-socket protocol. The
  recorder writes unacknowledged batches to a local spool and replays them after
  the daemon reconnects.
- Builds a day-grouped timeline of episodes. The timeline can open an episode's
  semantic steps and search episode or step text.
- Provides optional Ask, Memories, and Workflows windows. These use the Pi
  runtime and need provider credentials.
- Provides Settings and a read-only Diagnostics window. Settings can pause
  recording, change capture policies, and delete history ranges.

## Repository layout

- `apps/recorder-macos` contains the Swift and SwiftUI menu bar recorder.
- `apps/daemon` contains the Node.js daemon, SQLite repositories, IPC server,
  and background processing.
- `packages/protocol` contains the TypeBox schemas and shared JSON fixtures for
  the recorder-daemon protocol.
- `scripts` contains the Swift gate, fixture sync script, and manual soak
  checklist. `justfile` wraps the main package scripts.

## Requirements

- macOS 14 or newer.
- Xcode 16 or newer with the macOS SDK and a Swift 6 toolchain. The package
  declares Swift tools version 6.0. Use Xcode for the full recorder test suite.
- Node.js 24 or newer.
- pnpm 11.20.0. The root `package.json` pins this package-manager version.
- SwiftFormat and SwiftLint for `pnpm lint:swift` and `pnpm verify`.
- `just` is optional. It provides wrappers for the commands in `justfile`.

## Install

From a checkout of the repository:

```sh
git clone https://github.com/artur-shlyapnikov/computer-history.git
cd computer-history
pnpm install --frozen-lockfile
pnpm fixtures:sync
```

`pnpm fixtures:sync` creates or checks the
`apps/recorder-macos/Fixtures` symlink to the canonical fixtures in
`packages/protocol/fixtures`. It refuses to overwrite a non-symlink at that
path.

If you use `just`, `just setup` runs dependency installation and fixture sync.

## Run in development

Build the TypeScript packages and daemon first:

```sh
pnpm build
```

Start the menu bar recorder from the repository root:

```sh
(cd apps/recorder-macos && \
  COMPUTER_HISTORY_DAEMON_CMD='node ../../apps/daemon/dist/main.js' \
  swift run RecorderApp)
```

`swift run RecorderApp` keeps the recorder in the foreground. Quit it from the
menu bar or with `Ctrl-C`.

The recorder supervisor normally looks for a packaged daemon at
`Resources/daemon/main.js`. That resource is not present in this source
checkout, so the `COMPUTER_HISTORY_DAEMON_CMD` override is required for this
development launch. The command runs through `/bin/sh -c` and inherits the
recorder's environment.

`pnpm app` runs `swift build` in `apps/recorder-macos`. It compiles the recorder
but does not launch it. `pnpm daemon` runs `node dist/main.js` and expects a
previous `pnpm build`. `just daemon` builds first and then runs the daemon in
the foreground.

## First launch and macOS permissions

The recorder checks Accessibility at startup and starts a listen-only
`CGEvent` tap for keyboard and pointer activity. Grant both permissions before
expecting the status to become `Recording`:

1. Open System Settings and go to Privacy & Security > Accessibility. Enable
   the recorder process shown by macOS.
2. Go to Privacy & Security > Input Monitoring and enable the same process if
   macOS lists it there.
3. Restart `swift run RecorderApp` after changing either permission.

If the menu bar shows `Accessibility permission required` or
`permission_missing`, check both lists. A denied event tap is also reported as
`permission_missing`, even though the menu text mentions Accessibility. After
runtime revocation, the recorder rechecks trust every 30 seconds and tries to
restart capture when access returns.

When the daemon is unavailable, the recorder keeps collecting permitted events
and stores them in the spool. The menu bar shows the connection state and the
number of queued events.

## Use the app

The recorder starts capture when it launches. Click its menu bar icon to open
the following windows.

### Timeline and search

Timeline loads the 50 newest episodes through `timeline.list` and refreshes
every five seconds while the daemon is connected. Click an episode to load its
details through `episode.get`.

Use the `Search history` field and press Enter to search. Choose `All`,
`Episodes`, or `Steps` as the search scope. The UI sends `history.search` with a
maximum of 50 results. The daemon searches SQLite full-text indexes and keeps
its ranking order in the result list. Older episodes that do not fit in the
timeline list remain searchable. A step that has not been linked to an episode
yet can appear in results but cannot open an episode.

### Ask, memories, and workflows

Ask sends a question about the recorded history and streams the answer. It
needs a working provider credential. Without one, the daemon reports
`llm_unavailable`; local capture, the SQLite history, and full-text search still
work.

Memories shows suggested, confirmed, and rejected memory rows. Confirm or reject
a suggestion. `Forget` permanently removes one memory and its evidence.

Workflows shows mined workflow candidates, their steps, and observed
occurrences. Confirm or reject a candidate. The occurrence list may contain
only the newest part of a large ledger.

### Settings and diagnostics

Settings provides these controls:

- Pause or resume recording.
- Set the default capture mode and overrides for macOS bundle identifiers such
  as `com.apple.Safari`.
- Delete the last 10 minutes, the last hour, today, all history, or a selected
  day after a confirmation.
- View the configured chat and background model IDs. Model and retention
  settings are read-only in the current UI.

Diagnostics shows daemon status, database counts, queue counts, free disk
space, the integrity result, and recent errors. `Copy Report` puts the visible
diagnostic snapshot on the pasteboard.

## Configuration

Set these variables before starting the recorder or daemon. The recorder passes
its environment to the daemon it starts.

| Variable                            | Default                                          | Use                                                                                                 |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `COMPUTER_HISTORY_HOME`             | `~/Library/Application Support/ComputerHistory`  | Root for the database, Unix socket, spool, and daemon logs.                                         |
| `COMPUTER_HISTORY_DAEMON_CMD`       | Packaged `Resources/daemon/main.js` when present | Shell command that the recorder supervisor starts. Set this for a source-tree run.                  |
| `COMPUTER_HISTORY_CHAT_MODEL`       | `openai/gpt-5.6-luna`                            | Model ID for Ask.                                                                                   |
| `COMPUTER_HISTORY_BACKGROUND_MODEL` | `openai/gpt-5.6-luna`                            | Model ID for episode, memory, and workflow jobs.                                                    |
| `COMPUTER_HISTORY_LLM_AGENT_DIR`    | Pi SDK default, normally `~/.pi/agent`           | Pi agent directory. When set, the daemon looks for provider credentials in `<directory>/auth.json`. |

The recorder stores capture policies in macOS UserDefaults under the suite
`com.computer-history.recorder`. It does not store those policies in SQLite.

## How capture and search work

The two processes have separate responsibilities:

1. The recorder observes app activation through `NSWorkspace`, UI changes through
   Accessibility, and keyboard or pointer activity through a listen-only
   `CGEvent` tap. It reads text only from Accessibility value changes, never from
   keyboard events.
2. The recorder applies the per-app policy, removes or scrubs sensitive content,
   and buffers events into batches.
3. The recorder sends a batch over the Unix socket. A missing connection, a
   failed send, or a refused batch moves the batch to the spool. The recorder
   replays spool files oldest first and removes a file only after the daemon
   acknowledges every event in it.
4. The daemon validates the event schema and privacy rules again, writes raw
   events to SQLite, and derives semantic steps and episodes. Background jobs
   can extract memories and workflows.
5. `timeline.list` reads episode summaries. `episode.get` reads an episode and
   its ordered steps. `history.search` queries the episode and semantic-step
   full-text indexes. The search UI calls these operations through the same
   versioned socket protocol.

The daemon is the only SQLite writer. The recorder never opens the database.

## Privacy, storage, and retention

### Capture modes

| Mode       | Stored event data                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`      | A fact-only event with the app and action. The recorder omits window, target, and content fields.                                                                                        |
| `metadata` | App, window, and target metadata. The recorder drops content. This is the default.                                                                                                       |
| `content`  | Accessibility text after filtering. Secure fields and sensitive labels have no content. Known secret patterns become `[REDACTED]`; content that remains over 2048 characters is dropped. |

Secure text fields are never read. The recorder also scrubs secret patterns in
window titles. Built-in checks cover PEM private-key blocks, common API-key
shapes, and Luhn-valid card-number-like values. The daemon applies a second
privacy check at ingest.

The project never stores raw keystrokes, screenshots, clipboard contents, or
secure-field text. The filter reduces accidental capture; it cannot recognize
every sensitive value. Use `off` for applications that handle especially
sensitive material.

Ask and background processing can send captured semantic text to the configured
LLM provider. Provider retention and training terms are outside this
repository's local delete and retention rules.

### Storage layout

With the default home directory, the daemon uses:

| Path                | Contents                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `data/history.db`   | SQLite database. `history.db-wal` and `history.db-shm` are SQLite sidecars when present. |
| `run/history.sock`  | Versioned length-prefixed JSON IPC socket.                                               |
| `spool/`            | Recorder-side JSONL batches waiting for acknowledgement.                                 |
| `logs/daemon.jsonl` | Daemon JSONL log and retention summaries.                                                |

The daemon creates its directories with mode `0700` and its database, SQLite
sidecars, logs, and spool files with mode `0600`. The SQLite database is not
encrypted. Protect the macOS account, backups, and the directory named by
`COMPUTER_HISTORY_HOME`.

### Retention and deletion

The daemon runs a retention sweep at startup and every six hours:

- Raw events older than 48 hours are removed.
- Semantic steps older than 30 days are removed.
- Rejected and superseded memory candidates older than 30 days are removed.
- Non-manual memories with no evidence are removed during the sweep.
- Succeeded and dead terminal job rows older than 30 days are removed.
- Daemon log lines and other log files older than seven days are pruned.

Episodes, confirmed memories, and confirmed or rejected workflow rows do not
expire on a timer. A range delete removes matching events, steps, episodes,
evidence, and workflow occurrences in one transaction. It can also remove
candidate workflows that fall below their occurrence thresholds. A manually
confirmed memory survives range deletes and retention; only `Forget` removes it.

The recorder rotates spool files at about 512 KiB, keeps at most 25 MiB of spool
data, and purges files older than 48 hours. It drops the oldest files when the
size cap is exceeded, so a long daemon outage can cause data loss.

## Development and checks

Run commands from the repository root.

| Command                      | Result                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm build`                 | Builds the protocol package and daemon, including migrations and the chat system prompt in `dist`.         |
| `pnpm app`                   | Runs `swift build` for the macOS recorder.                                                                 |
| `pnpm typecheck`             | Builds TypeScript packages and runs TypeScript checks.                                                     |
| `pnpm test`                  | Runs the package test scripts, including Vitest for the protocol and daemon. It does not run `swift test`. |
| `pnpm lint`                  | Runs package ESLint checks and the root ESLint config.                                                     |
| `pnpm lint:swift`            | Runs a warnings-as-errors Swift build, SwiftFormat, SwiftLint, and `swift test`.                           |
| `pnpm verify`                | Runs typecheck, lint, the Swift gate, and package tests.                                                   |
| `pnpm fixtures:sync`         | Checks or repairs the Swift-to-TypeScript fixture symlink.                                                 |
| `just verify` / `just check` | Runs `pnpm verify`.                                                                                        |
| `just ci`                    | Installs from the lockfile and runs `pnpm verify`.                                                         |
| `just doctor`                | Prints the versions expected by the local checks.                                                          |

The recorder tests use injected monitors for most capture behavior. Live
Accessibility and `CGEvent` behavior needs an interactive macOS session and
permissions. The manual seven-day procedure is in
[scripts/soak-checklist.md](scripts/soak-checklist.md).

## Known limitations

- The source checkout has no app bundle or packaged daemon resource. Use the
  development launch command above.
- The privacy filter is not a guarantee that a secret will never be recorded.
  Window titles, app names, labels, and ordinary text can contain sensitive
  data that does not match a built-in rule.
- The local database is unencrypted. A local administrator, malware running as
  the user, or a copied backup can read it. File deletion does not guarantee
  removal from filesystem snapshots or free-space remnants.
- When free space on the daemon home volume drops below 1 GiB, the daemon runs
  retention and can pause recording. Recording resumes after free space reaches
  about 1.2 GiB. The recorder spools events while the daemon refuses batches.
- If SQLite `integrity_check` fails at startup, the daemon exits with code 46
  and does not recreate the database. Recovery is manual; the recorder reports
  a degraded daemon state.
- Missing LLM credentials do not stop local capture or search, but background
  jobs retry and Ask returns `llm_unavailable`.

## License

The project is released under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
