-- Round-28 performance fix-up: memory_candidates' listByStatus filtered on
-- status and sorted by last_seen_at_ms DESC, id ASC per call with only
-- idx on (status) available — every call scanned all rows of the requested
-- status into a TEMP B-TREE sort (candidates accumulate unboundedly). The
-- composite index below serves filter and order together, letting SQLite
-- walk matches directly in sorted order. Additive only; no column changes;
-- no ANALYZE needed (single-index probes, no competing plan).
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status_last_seen
ON memory_candidates(status, last_seen_at_ms DESC, id);
