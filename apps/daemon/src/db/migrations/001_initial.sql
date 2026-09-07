-- Milestone 0 initial schema.
-- Spec §3.9 tables + documented additive deviations from contracts.md:
--   * raw_events.processed_at_ms (watermark bookkeeping) + partial index
--   * schema_migrations
--   * activity_segments.summarize_job_id (summarize_segment enqueue dedupe)
-- FTS5 tables are maintained by repository methods, never triggers.


CREATE TABLE raw_events (
  id TEXT PRIMARY KEY,
  observed_at_ms INTEGER NOT NULL,
  monotonic_ns INTEGER,
  capture_session_id TEXT,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  app_name TEXT,
  pid INTEGER,
  window_title TEXT,
  target_role TEXT,
  target_subrole TEXT,
  target_label TEXT,
  target_identifier TEXT,
  content TEXT,
  content_policy TEXT NOT NULL,
  inserted_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER
);
CREATE INDEX idx_raw_events_observed_at ON raw_events(observed_at_ms);
CREATE INDEX idx_raw_events_app_time ON raw_events(app_bundle_id, observed_at_ms);
CREATE INDEX idx_raw_events_capture_session ON raw_events(capture_session_id);
CREATE INDEX idx_raw_events_action_time ON raw_events(action, observed_at_ms);
CREATE INDEX idx_raw_events_unprocessed ON raw_events(processed_at_ms) WHERE processed_at_ms IS NULL;

CREATE TABLE activity_segments (
  id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN ('open', 'processing', 'finalized', 'failed')),
  first_event_id TEXT,
  last_event_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  summarize_job_id TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE semantic_steps (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES activity_segments(id),
  ordinal INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  action TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  app_name TEXT,
  target TEXT,
  text TEXT,
  first_event_id TEXT,
  last_event_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_semantic_steps_segment ON semantic_steps(segment_id, ordinal);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  intent TEXT,
  outcome TEXT,
  apps_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  summary_model TEXT,
  summary_prompt_version TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_episodes_started_at ON episodes(started_at_ms);

CREATE TABLE episode_step_links (
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  semantic_step_id TEXT NOT NULL REFERENCES semantic_steps(id),
  ordinal INTEGER NOT NULL,
  UNIQUE (episode_id, semantic_step_id)
);
CREATE INDEX idx_episode_step_links_episode ON episode_step_links(episode_id, ordinal);

CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'procedure')),
  canonical_key TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'rejected', 'superseded')),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_memory_candidates_status ON memory_candidates(status);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memory_candidates(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  confidence REAL NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (memory_id, episode_id)
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  template_json TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  median_similarity REAL NOT NULL DEFAULT 0,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE workflow_occurrences (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  similarity REAL NOT NULL,
  PRIMARY KEY (workflow_id, episode_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'retry', 'succeeded', 'dead')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_jobs_state_run_after ON jobs(state, run_after_ms);

CREATE VIRTUAL TABLE episodes_fts USING fts5(
  title, summary, intent, outcome, entities_flat, apps_flat
);
CREATE VIRTUAL TABLE semantic_steps_fts USING fts5(
  text, target, app_name
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, canonical_key
);
