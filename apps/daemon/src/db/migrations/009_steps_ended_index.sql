-- Round-24 performance fix-up: semantic_steps retention purge
-- (SegmentsRepository.purgeStepsOlderThan, boot + 6h cadence) selected victims
-- with COALESCE(ended_at_ms, started_at_ms) < ?, an expression no index can
-- serve — every purge full-scanned semantic_steps, linear in retained history
-- (steps persist until explicit delete, so the scan is unbounded). The
-- repository now uses the sargable OR-form; this index serves the
-- ended_at_ms branch while migration 008's idx_semantic_steps_started serves
-- the NULL branch via SQLite's multi-index OR. Additive only; no column
-- changes; no ANALYZE needed (single-index probes, no competing plan).
CREATE INDEX IF NOT EXISTS idx_semantic_steps_ended
ON semantic_steps(ended_at_ms);
