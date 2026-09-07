-- Round-22 performance fix-up: history.search's filter-only listing leg
-- (chat agent's history_search with query omitted, and history.search with no
-- query) ordered semantic_steps by started_at_ms with only
-- idx_semantic_steps_segment(segment_id, ordinal) available — every call
-- full-scanned the whole steps table into a TEMP B-TREE before applying
-- LIMIT (measured 20.5 ms on a 50k-step DB, growing linearly; steps persist
-- until explicit delete, so the scan is unbounded). The plain index below
-- lets SQLite reverse-scan candidates directly in started_at_ms order and
-- stop at LIMIT. Additive only; no column changes.
--
-- Unlike migration 007 no ANALYZE is needed: an ORDER BY on an indexed
-- column with LIMIT has no competing plan to guess between.
CREATE INDEX IF NOT EXISTS idx_semantic_steps_started
ON semantic_steps(started_at_ms);
