-- Round-31 durability fix-up: the summarize_segment dedupe latch
-- (EpisodesRepository.hasEpisodesForSteps) keyed on episode_step_links
-- existence, but retention purgeStepsOlderThan deletes those links after 30d.
-- A daemon crash between persistTx commit and job completion whose re-delivery
-- is deferred past that horizon (extended outage) lost the latch and
-- re-summarized duplicate episodes. Stamping episodes.segment_id gives the
-- latch a purge-proof primary signal: any episode of the segment overlapping
-- the requested step window. Nullable on purpose — legacy rows keep NULL and
-- stay detectable through the existing link-based fallback. Additive column +
-- index only; no ANALYZE needed (single-index probes, no competing plan).
ALTER TABLE episodes ADD COLUMN segment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_episodes_segment
ON episodes(segment_id);
