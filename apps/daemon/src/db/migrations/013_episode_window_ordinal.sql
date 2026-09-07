-- Round-32 durability fix-up: the migration-012 dedupe latch
-- (EpisodesRepository.hasEpisodesForSteps) keyed on TIMESTAMP intervals — any
-- episode of the segment whose [started_at_ms, ended_at_ms] intersects the
-- requested window's range counted as "already summarized". With regressed
-- event timestamps inside one segment (clock skew), a never-summarized
-- chained window whose FIRST step starts before the prior window's end
-- false-positived: the summarizer skipped, persistTx never ran, and the tail
-- was never summarized nor given its extract_memory/mine_workflows jobs —
-- permanent silent loss. Append-order step ordinals are monotonic per
-- segment regardless of clock regression, so episodes.last_step_ordinal
-- (`>= window max ordinal`) replaces the intersection probe. Nullable on
-- purpose — rows whose links were already purged keep NULL: those carrying
-- segment_id still latch through the repository's legacy interval probe
-- (last_step_ordinal IS NULL tier), but rows whose segment_id is NULL too
-- are invisible to every probe and DO re-summarize — accepted round-31
-- semantics, shrinking population since episodes themselves are never
-- purged. The same UPDATE recovers segment_id for rows that predate
-- migration 012.
-- Additive column + backfill + index only; no ANALYZE needed (single-index
-- probes, no competing plan).
ALTER TABLE episodes ADD COLUMN last_step_ordinal INTEGER;
UPDATE episodes SET
  segment_id = COALESCE(segment_id, (
    SELECT s.segment_id FROM episode_step_links l
    JOIN semantic_steps s ON s.id = l.semantic_step_id
    WHERE l.episode_id = episodes.id LIMIT 1)),
  last_step_ordinal = (
    SELECT MAX(s.ordinal) FROM episode_step_links l
    JOIN semantic_steps s ON s.id = l.semantic_step_id
    WHERE l.episode_id = episodes.id)
WHERE segment_id IS NULL OR last_step_ordinal IS NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_segment_last_ordinal
ON episodes(segment_id, last_step_ordinal);
