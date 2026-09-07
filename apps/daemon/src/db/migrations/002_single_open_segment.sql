CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_segments_single_open
ON activity_segments(state) WHERE state='open';
