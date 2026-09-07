# 7-Day Continuous-Run Soak Checklist (human dogfooding)

> **Automated soak is explicitly OUT OF SCOPE for V1.** The release gate cannot
> fake a week of real Accessibility capture, real model calls and real sleep/
> wake cycles. This checklist is the executable procedure a human runs while
> dogfooding the recorder + daemon on their own Mac for seven consecutive days.
> Every check below is observable with built-in tools; no test harness needed.

## Setup (day 0)

- [ ] `COMPUTER_HISTORY_HOME` at its default (`~/Library/Application Support/ComputerHistory`) — soak must exercise the REAL paths.
- [ ] Recorder launches at login; menu-bar icon reaches `recording` state.
- [ ] `pnpm --filter @computer-history/daemon build` — `dev` runs
      `node dist/main.js`, so a stale `dist/` would soak old code.
- [ ] `pnpm --filter @computer-history/daemon dev` under a supervisor you trust
      (or the packaged app); note the daemon start time in `logs/daemon.jsonl`.
- [ ] Baseline snapshot (save output to a file):
      ```sh
      ls -l "$HOME/Library/Application Support/ComputerHistory/data/"
      lsof -p $(pgrep -f "dist/main.js") | wc -l
      ps -o rss= -p $(pgrep -f "dist/main.js")
      ```

## Daily checks (~5 minutes, days 1–7)

Run from any shell:

1. **WAL size** (checkpoint watch should keep it ≪ 32 MB):
   ```sh
   ls -lh "$HOME/Library/Application Support/ComputerHistory/data/history.db-wal"
   ```
   Alert if it grows monotonically day-over-day or exceeds ~64 MB.

2. **DB growth rate** — record total DB bytes; growth is expected, *accelerating*
   growth is not:
   ```sh
   ls -l "$HOME/Library/Application Support/ComputerHistory/data/history.db"
   ```

3. **File-descriptor leaks** (daemon should stay flat — sockets open/close per
   client connection):
   ```sh
   lsof -p $(pgrep -f "dist/main.js") | wc -l
   ```
   Baseline ±10 is normal; a rising trend across days is a leak.

4. **Memory RSS** (Node steady-state; retention sweeps should not ratchet it):
   ```sh
   ps -o rss=,etime= -p $(pgrep -f "dist/main.js")
   ```
   Compare against the day-0 baseline; investigate sustained growth >2×.

5. **Spool growth** (recorder-side backpressure files; empty when connected):
   ```sh
   find "$HOME/Library/Application Support/ComputerHistory/spool" -type f | wc -l
   ```
   Files persisting >48 h indicate the daemon is refusing batches (disk guard)
   or the recorder cannot reconnect — capture `logs/` tail before restarting.

6. **Retention firing** (6-hour cadence; look for one summary line per sweep):
   ```sh
   grep "retention sweep complete" \
     "$HOME/Library/Application Support/ComputerHistory/logs/daemon.jsonl" | tail -4
   ```
   Expect ≥1 line per 6 h wall-clock window. After 48 h of uptime the raw-events
   count should plateau (`status.get` → `db.rawEvents`).

7. **Error scan**:
   ```sh
   grep -c '"level":"error"' \
     "$HOME/Library/Application Support/ComputerHistory/logs/daemon.jsonl"
   ```
   Any `job failed ... outcome: dead` lines: note them — dead jobs are expected
   only during deliberate outages and are re-drivable via `jobs.retryDead`.

## Deliberate fault drills (run once each, any day)

- **Model outage**: revoke network/model credentials for 30 minutes mid-day.
  Confirm: timeline keeps updating steps, chat answers `chat_error`, jobs walk
  to retry; after restoring, dead jobs stay dead until you call
  `jobs.retryDead` from Diagnostics.
- **Disk pressure** *(only with a throwaway volume)*: shrink free space below
  1 GiB. Confirm menu bar shows paused / `disk_pressure`, events.batch is
  refused, recorder spools locally, and resuming past 1.2 GiB un-pauses.
- **Daemon crash**: `kill -9` the daemon mid-batch. Restart; confirm no history
  loss (acked batches survive WAL) and the recorder reconnects.

## End of soak (day 7)

- [ ] Archive all daily snapshots alongside this checklist.
- [ ] Record: max WAL bytes, fd count trend, RSS trend, spool high-water mark,
      retention sweep count (= ~28), error-line count, dead-job count.
- [ ] File deviations as issues referencing this file; green results close the
      spec's «семидневный continuous-run» acceptance item.
