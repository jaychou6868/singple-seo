-- Migration: v32 thumbnail text layout (split_around_face support)
-- Karen 2026-04-07
--
-- Adds:
--   - seo_thumbnail_patterns.text_layout_hint   ('single' | 'split' | 'top_banner')
--     Set by locked-channel-learner from Gemini analysis. Generator uses this
--     to decide whether the reference's intended layout is a split-around-face
--     pattern (影視颶風 Pattern A) vs a single text block.
--
--   - seo_thumbnail_candidates.text_primary     primary text block (always set)
--   - seo_thumbnail_candidates.text_secondary   secondary block (null when single)
--   - seo_thumbnail_candidates.text_layout_used the actual layout the renderer chose
--
-- The candidate-side fields let select feedback (POST /thumbnail/select) and
-- future CTR analytics correlate which split / single combinations work.
--
-- Run in Supabase SQL Editor BEFORE deploying v32a code. Safe to run twice
-- (all clauses are IF NOT EXISTS).

ALTER TABLE seo_thumbnail_patterns
  ADD COLUMN IF NOT EXISTS text_layout_hint TEXT
    CHECK (text_layout_hint IS NULL OR text_layout_hint IN ('single', 'split', 'top_banner'));

ALTER TABLE seo_thumbnail_candidates
  ADD COLUMN IF NOT EXISTS text_primary    TEXT,
  ADD COLUMN IF NOT EXISTS text_secondary  TEXT,
  ADD COLUMN IF NOT EXISTS text_layout_used TEXT;

-- ─────────────────────────────────────────────────────────────────
-- ROLLBACK (only run manually if v32 has to be reverted)
-- ─────────────────────────────────────────────────────────────────
-- ALTER TABLE seo_thumbnail_patterns   DROP COLUMN IF EXISTS text_layout_hint;
-- ALTER TABLE seo_thumbnail_candidates DROP COLUMN IF EXISTS text_primary;
-- ALTER TABLE seo_thumbnail_candidates DROP COLUMN IF EXISTS text_secondary;
-- ALTER TABLE seo_thumbnail_candidates DROP COLUMN IF EXISTS text_layout_used;
