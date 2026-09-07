-- Round-4 hot-path index fix-up (DB-01..DB-04): four unindexed lookups were
-- full-scanning unbounded tables on every extracted candidate / delete /
-- purge. Additive only — no column or row changes.
--   * memory_candidates(canonical_key, created_at_ms, id): upsertCandidate and
--     listByKey probe by canonical_key per extracted candidate, and their
--     ORDER BY created_at_ms ASC, id ASC is served by the composite tail.
--   * memory_evidence(episode_id): the hasEvidenceForEpisode latch,
--     FK parent-checks, and delete cascade scan the evidence ledger.
--   * workflow_occurrences(episode_id): hasOccurrenceForEpisode, delete
--     cascade, and the retention purge anti-join scan occurrences.
--   * episode_step_links(semantic_step_id): retention purge and deleteSteps
--     scan step links per victim step.
CREATE INDEX IF NOT EXISTS idx_memory_candidates_canonical_key
ON memory_candidates(canonical_key, created_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_episode
ON memory_evidence(episode_id);
CREATE INDEX IF NOT EXISTS idx_workflow_occurrences_episode
ON workflow_occurrences(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_step_links_step
ON episode_step_links(semantic_step_id);
