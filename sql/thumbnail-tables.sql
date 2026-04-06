-- ============================================================
-- Thumbnail Tables for singple-seo
-- Run this in Supabase SQL editor
-- ============================================================

-- ------------------------------------------------------------
-- Table 1: seo_thumbnail_patterns
-- Stores learned design patterns from viral YouTube thumbnails
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_thumbnail_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  layout_type TEXT NOT NULL,
  color_primary TEXT,
  color_accent TEXT,
  text_style TEXT,
  text_word_count INT,
  text_pattern TEXT,
  expression_type TEXT,
  element_types TEXT,
  emotional_hook TEXT,
  weight FLOAT DEFAULT 1.0,
  source TEXT DEFAULT 'seed',
  learned_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Table 2: seo_thumbnail_candidates
-- Stores generated thumbnail candidates for each SEO job
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_thumbnail_candidates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES seo_jobs(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  layout_type TEXT,
  thumbnail_text TEXT,
  pattern_id UUID REFERENCES seo_thumbnail_patterns(id) ON DELETE SET NULL,
  selected BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Indexes for common query patterns
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_thumbnail_patterns_layout
  ON seo_thumbnail_patterns(layout_type);

CREATE INDEX IF NOT EXISTS idx_thumbnail_patterns_weight
  ON seo_thumbnail_patterns(weight DESC);

CREATE INDEX IF NOT EXISTS idx_thumbnail_candidates_job
  ON seo_thumbnail_candidates(job_id);

CREATE INDEX IF NOT EXISTS idx_thumbnail_candidates_selected
  ON seo_thumbnail_candidates(job_id, selected);

-- ------------------------------------------------------------
-- Pre-seed: 20 patterns for singing/education niche
-- ------------------------------------------------------------
INSERT INTO seo_thumbnail_patterns
  (layout_type, color_primary, color_accent, text_style, text_word_count, text_pattern, expression_type, element_types, emotional_hook, weight, source)
VALUES

-- 1. Face left, bold mistake callout — high performer
(
  'face_left_text_right', 'red', 'white',
  'bold_outline', 4,
  '❌ 這樣唱就毀了',
  'serious', 'cross_mark,arrow',
  'loss_aversion', 1.5, 'seed'
),

-- 2. Face right, curiosity gap number list
(
  'face_right_text_left', 'dark_blue', 'yellow',
  'bold_outline', 5,
  '3個秘密讓你馬上進步',
  'excited', 'badge,circle',
  'curiosity_gap', 1.3, 'seed'
),

-- 3. Face center text top, authority claim
(
  'face_center_text_top', 'black', 'red',
  'shadow', 6,
  '90%的人都不知道這件事',
  'surprised', 'glow,border',
  'social_proof', 1.4, 'seed'
),

-- 4. Full frame overlay, transformation promise
(
  'full_frame_overlay', 'purple', 'white',
  'gradient', 5,
  '7天讓你的聲音脫胎換骨',
  'smiling', 'badge,glow',
  'transformation', 1.2, 'seed'
),

-- 5. Split diagonal, before/after contrast
(
  'split_diagonal', 'dark_blue', 'yellow',
  'bold_outline', 3,
  '學前 vs 學後',
  'surprised', 'arrow,border',
  'transformation', 1.3, 'seed'
),

-- 6. Face left, loss aversion stop warning
(
  'face_left_text_right', 'orange', 'black',
  'bold_outline', 4,
  '不要再這樣練習！',
  'serious', 'cross_mark,circle',
  'loss_aversion', 1.4, 'seed'
),

-- 7. Face right, FOMO social proof
(
  'face_right_text_left', 'green', 'white',
  'plain_bold', 5,
  '所有歌手都在學這個',
  'excited', 'badge,arrow',
  'fomo', 1.1, 'seed'
),

-- 8. Face center text top, why question
(
  'face_center_text_top', 'red', 'white',
  'shadow', 5,
  '為什麼你唱歌會跑調？',
  'curious', 'circle,glow',
  'curiosity_gap', 1.2, 'seed'
),

-- 9. Full frame overlay, quick result promise
(
  'full_frame_overlay', 'black', 'red',
  'gradient', 4,
  '30天練出好聲音',
  'smiling', 'badge,border',
  'transformation', 1.0, 'seed'
),

-- 10. Split diagonal, authority contrast
(
  'split_diagonal', 'purple', 'white',
  'bold_outline', 4,
  '原來是這個原因',
  'surprised', 'arrow,emoji',
  'curiosity_gap', 1.1, 'seed'
),

-- 11. Face left, authority identity hook
(
  'face_left_text_right', 'dark_blue', 'yellow',
  'bold_outline', 5,
  '專業歌手都有這個習慣',
  'serious', 'badge,circle',
  'authority', 1.3, 'seed'
),

-- 12. Face right, numbered quick-win
(
  'face_right_text_left', 'green', 'white',
  'shadow', 5,
  '5個技巧讓聲音更有力',
  'excited', 'arrow,glow',
  'curiosity_gap', 1.2, 'seed'
),

-- 13. Face center text top, fear-based stop
(
  'face_center_text_top', 'orange', 'black',
  'bold_outline', 5,
  '這個錯誤會傷害你的聲帶',
  'serious', 'cross_mark,border',
  'loss_aversion', 1.5, 'seed'
),

-- 14. Full frame overlay, hidden knowledge reveal
(
  'full_frame_overlay', 'red', 'white',
  'gradient', 6,
  '沒人告訴你的唱歌秘訣',
  'curious', 'glow,circle',
  'curiosity_gap', 1.4, 'seed'
),

-- 15. Split diagonal, fast timeline FOMO
(
  'split_diagonal', 'black', 'red',
  'bold_outline', 4,
  '14天見效不騙你',
  'smiling', 'badge,emoji',
  'fomo', 1.0, 'seed'
),

-- 16. Face left, social proof popularity signal
(
  'face_left_text_right', 'purple', 'white',
  'plain_bold', 6,
  '百萬人學過的發聲練習',
  'smiling', 'badge,glow',
  'social_proof', 1.3, 'seed'
),

-- 17. Face right, identity-based authority
(
  'face_right_text_left', 'dark_blue', 'yellow',
  'shadow', 5,
  '聲樂老師不想讓你知道',
  'curious', 'cross_mark,arrow',
  'authority', 1.2, 'seed'
),

-- 18. Face center text top, plain-spoken result
(
  'face_center_text_top', 'green', 'white',
  'plain_bold', 4,
  '這樣唱就對了',
  'smiling', 'circle,emoji',
  'transformation', 0.9, 'seed'
),

-- 19. Full frame overlay, relatable failure hook
(
  'full_frame_overlay', 'orange', 'black',
  'bold_outline', 5,
  '唱歌為什麼越練越差？',
  'surprised', 'arrow,glow',
  'curiosity_gap', 1.1, 'seed'
),

-- 20. Split diagonal, short punchy loss-aversion
(
  'split_diagonal', 'red', 'white',
  'shadow', 3,
  '別再浪費時間了',
  'serious', 'cross_mark,border',
  'loss_aversion', 0.8, 'seed'
);
