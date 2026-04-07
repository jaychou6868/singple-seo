-- Migration: Locked-channel learner schema
-- Adds new columns to seo_thumbnail_patterns to store concrete reference
-- thumbnails (base64) + natural-language style description + channel source.
-- Old enum-style columns (layout_type, color_primary, etc.) remain but are
-- no longer read by the generator.
--
-- Run this manually in Supabase SQL Editor before deploying the new
-- locked-channel-learner.ts and the rewritten thumbnail-generator.ts.

ALTER TABLE seo_thumbnail_patterns
  ADD COLUMN IF NOT EXISTS reference_image_b64 TEXT,
  ADD COLUMN IF NOT EXISTS style_description  TEXT,
  ADD COLUMN IF NOT EXISTS channel_source     TEXT
    CHECK (channel_source IS NULL OR channel_source IN ('mrbeast', 'lks', 'manual')),
  ADD COLUMN IF NOT EXISTS suggested_layout   TEXT,
  ADD COLUMN IF NOT EXISTS video_id           TEXT,
  ADD COLUMN IF NOT EXISTS view_count         BIGINT;

-- learned_at already exists from the original thumbnail-tables.sql migration

-- Index for the generator's selectReferences() query
CREATE INDEX IF NOT EXISTS idx_thumbnail_patterns_channel_source
  ON seo_thumbnail_patterns(channel_source)
  WHERE channel_source IS NOT NULL;

-- Unique constraint so re-running the learner UPSERTs by video_id
CREATE UNIQUE INDEX IF NOT EXISTS uniq_thumbnail_patterns_video_id
  ON seo_thumbnail_patterns(video_id)
  WHERE video_id IS NOT NULL;
