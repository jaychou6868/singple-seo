-- Migration: Continuous learning loop
-- Adds learner_meta (for self-waking cron) and reference_video_ids
-- (so the select endpoint can bump weights of all 3 references used
-- by the chosen candidate, not just the single primary pattern_id).
--
-- Run after locked-channel-schema.sql.

-- 1. learner_meta — track when the locked-channel learner last ran.
--    The app boot routine reads this and auto-triggers a fresh run if
--    it's been > 30 days.
CREATE TABLE IF NOT EXISTS learner_meta (
  id TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_run_summary JSONB
);

INSERT INTO learner_meta (id) VALUES ('locked_channel_learner')
  ON CONFLICT (id) DO NOTHING;

-- 2. seo_thumbnail_candidates — add reference_video_ids so the select
--    endpoint can bump all references used by the chosen candidate.
--    Stored as JSONB array of strings (e.g. ["m2GSfOviBFo", "abc123"]).
ALTER TABLE seo_thumbnail_candidates
  ADD COLUMN IF NOT EXISTS reference_video_ids JSONB;
