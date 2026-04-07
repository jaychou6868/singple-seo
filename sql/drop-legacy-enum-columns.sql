-- Migration: Drop legacy enum columns from seo_thumbnail_patterns
--
-- These were used by the original (now-deleted) thumbnail-learner.ts
-- which encoded thumbnail style as abstract enums. The new
-- locked-channel-learner uses concrete reference images + natural-
-- language style descriptions, so the enum columns are dead.
--
-- Run this AFTER deploying the matching code change that removes
-- the placeholder values from locked-channel-learner.ts upsertReference.
-- Otherwise an in-flight learner run will fail with "column does not exist".

ALTER TABLE seo_thumbnail_patterns
  DROP COLUMN IF EXISTS layout_type,
  DROP COLUMN IF EXISTS color_primary,
  DROP COLUMN IF EXISTS color_accent,
  DROP COLUMN IF EXISTS text_style,
  DROP COLUMN IF EXISTS text_word_count,
  DROP COLUMN IF EXISTS text_pattern,
  DROP COLUMN IF EXISTS expression_type,
  DROP COLUMN IF EXISTS element_types,
  DROP COLUMN IF EXISTS emotional_hook;

-- The legacy idx_thumbnail_patterns_layout index is dropped automatically
-- when its layout_type column is dropped.
