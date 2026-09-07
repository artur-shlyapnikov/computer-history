-- Round-19 performance fix-up: the watermark sweep's canonical ORDER BY was
-- unservable — idx_raw_events_unprocessed(processed_at_ms) finds unprocessed
-- rowids, but every sweep then sorted the whole remaining backlog in a TEMP
-- B-TREE before applying LIMIT (measured 4.14 ms/sweep on a 50k-event offline
-- catch-up backlog). The covering partial index below lets SQLite walk
-- candidates directly in (observed_at_ms, monotonic_ns, id) order and stop at
-- LIMIT — 0.17 ms/sweep on the same data. Additive only; no column changes.
--
-- ANALYZE is required for the planner to prefer this index over the
-- unprocessed-probe + sort plan (verified via EXPLAIN QUERY PLAN; without
-- stat1 SQLite guesses the old plan). Stats are advisory: both plans return
-- identical rows, this one just stops at LIMIT instead of sorting everything.
CREATE INDEX IF NOT EXISTS idx_raw_events_sweep
ON raw_events(observed_at_ms, monotonic_ns, id) WHERE processed_at_ms IS NULL;
-- analysis_limit bounds the stat1 scan: unbounded ANALYZE on a multi-GB
-- raw_events table would stall the first post-upgrade daemon start. 400
-- rows/table is SQLite's recommended precision/cost point; advisory stats.
PRAGMA analysis_limit = 400;
ANALYZE;
