-- Round-28 performance fix-up: SegmentsRepository's paged listing ordered
-- activity_segments by started_at_ms DESC LIMIT ? with no index available —
-- every listing full-scanned the whole table into a TEMP B-TREE before
-- applying LIMIT (segments are never deleted from, so the scan is unbounded
-- and grows linearly). The plain index below lets SQLite reverse-scan
-- candidates directly in started_at_ms order and stop at LIMIT. Additive
-- only; no column changes.
--
-- Like migration 008 no ANALYZE is needed: an ORDER BY on an indexed column
-- with LIMIT has no competing plan to guess between.
CREATE INDEX IF NOT EXISTS idx_activity_segments_started
ON activity_segments(started_at_ms);
