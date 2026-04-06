/**
 * Thumbnail Learner — YouTube 爆款縮圖設計模式自動學習
 *
 * 接在 Viral Learner 之後執行：
 * 1. 接收 Viral Learner 找到的超額表現 videoIds
 * 2. 下載縮圖（免費 YouTube 圖片 URL）
 * 3. Gemini 視覺分析設計模式
 * 4. 儲存至 seo_thumbnail_patterns 表
 * 5. 衰減過期模式
 */

import { createClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ───────────────────────────────────────────────────

type LayoutType =
  | 'face_left_text_right'
  | 'face_right_text_left'
  | 'face_center_text_top'
  | 'full_frame_overlay'
  | 'split_diagonal';

type TextStyle = 'bold_outline' | 'shadow' | 'gradient' | 'plain_bold';

type ExpressionType = 'surprised' | 'excited' | 'serious' | 'curious' | 'smiling';

type ElementType = 'arrow' | 'circle' | 'emoji' | 'glow' | 'border' | 'badge';

type EmotionalHook =
  | 'curiosity_gap'
  | 'loss_aversion'
  | 'social_proof'
  | 'fomo'
  | 'authority'
  | 'transformation';

interface ThumbnailPattern {
  layout_type: LayoutType;
  color_primary: string;
  color_accent: string;
  text_style: TextStyle;
  text_word_count: number;
  text_pattern: string;
  expression_type: ExpressionType;
  element_types: ElementType[];
  emotional_hook: EmotionalHook;
}

// ── Thumbnail download ─────────────────────────────────────

async function downloadThumbnail(videoId: string): Promise<{ videoId: string; base64: string } | null> {
  // Try maxresdefault first, fall back to hqdefault
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;

      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');

      // Skip placeholder images (YouTube returns a grey placeholder for missing maxres)
      if (base64.length < 5000) continue;

      console.log(`[Thumbnail Learner] Downloaded: ${videoId} (${Math.round(base64.length / 1024)}KB)`);
      return { videoId, base64 };
    } catch {
      continue;
    }
  }

  console.warn(`[Thumbnail Learner] Failed to download thumbnail for ${videoId}`);
  return null;
}

async function downloadThumbnailsBatch(videoIds: string[]): Promise<{ videoId: string; base64: string }[]> {
  const results: { videoId: string; base64: string }[] = [];

  // Download in batches of 5 (parallel)
  for (let i = 0; i < videoIds.length; i += 5) {
    const batch = videoIds.slice(i, i + 5);
    console.log(`[Thumbnail Learner] Downloading batch ${Math.floor(i / 5) + 1}/${Math.ceil(videoIds.length / 5)}`);

    const batchResults = await Promise.all(batch.map(id => downloadThumbnail(id)));

    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return results;
}

// ── Gemini Vision Analysis ─────────────────────────────────

async function analyzeWithGemini(
  thumbnails: { videoId: string; base64: string }[],
): Promise<(ThumbnailPattern & { source: string })[]> {
  if (thumbnails.length === 0) return [];

  const prompt = `你是一位資深的 YouTube 縮圖設計分析專家。

分析以下 ${thumbnails.length} 張 YouTube 爆款影片縮圖，提取可複用的設計模式。

對每張縮圖，提取以下設計元素：

1. layout_type: 版面佈局類型，只能是以下之一：
   - "face_left_text_right"（人臉左側，文字右側）
   - "face_right_text_left"（人臉右側，文字左側）
   - "face_center_text_top"（人臉居中，文字上方）
   - "full_frame_overlay"（全幅圖片加疊字）
   - "split_diagonal"（對角分割）

2. color_primary: 主要背景色（hex 色碼，如 "#FF0000"）
3. color_accent: 強調色/文字色（hex 色碼）

4. text_style: 文字樣式，只能是以下之一：
   - "bold_outline"（粗體描邊）
   - "shadow"（陰影文字）
   - "gradient"（漸層文字）
   - "plain_bold"（純粗體）

5. text_word_count: 縮圖上的文字數量（字數/詞數）

6. text_pattern: 文字骨架模式，例如：
   - "❌ [錯誤行為]"
   - "[數字] 個秘密"
   - "[疑問詞] [動作]？"
   - "[名人/權威] 推薦"

7. expression_type: 人物表情類型，只能是以下之一：
   - "surprised"（驚訝）
   - "excited"（興奮）
   - "serious"（嚴肅）
   - "curious"（好奇）
   - "smiling"（微笑）
   如果沒有人物，選最接近的情緒氛圍

8. element_types: 使用的設計元素（陣列），從以下選取：
   - "arrow"（箭頭）
   - "circle"（圓圈標記）
   - "emoji"（表情符號）
   - "glow"（發光效果）
   - "border"（邊框）
   - "badge"（徽章/標籤）

9. emotional_hook: 情感鉤子策略，只能是以下之一：
   - "curiosity_gap"（好奇心缺口）
   - "loss_aversion"（損失規避）
   - "social_proof"（社會認同）
   - "fomo"（錯失恐懼）
   - "authority"（權威效應）
   - "transformation"（轉變/對比）

輸出 JSON 陣列，每個元素對應一張縮圖（按輸入順序）。
只輸出 JSON，不要其他文字。`;

  // Build multi-image parts: prompt text + all thumbnails
  const parts: any[] = [{ text: prompt }];
  for (const thumb of thumbnails) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: thumb.base64,
      },
    });
    parts.push({ text: `（以上是影片 ${thumb.videoId} 的縮圖）` });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 16384,
          thinkingConfig: { thinkingLevel: 'medium' },
        },
      }),
      signal: controller.signal,
    });

    const data = await res.json() as any;
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (let i = responseParts.length - 1; i >= 0; i--) {
      if (responseParts[i].text) { text = responseParts[i].text; break; }
    }

    if (!text) {
      console.error('[Thumbnail Learner] Gemini returned no text');
      return [];
    }

    // Parse JSON from response
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed: ThumbnailPattern[] = [];
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }

    if (!Array.isArray(parsed)) {
      console.error('[Thumbnail Learner] Gemini response is not an array');
      return [];
    }

    // Attach source videoId to each pattern
    return parsed.map((pattern, idx) => ({
      ...pattern,
      source: thumbnails[idx]?.videoId || 'unknown',
    }));
  } finally {
    clearTimeout(timeout);
  }
}

// ── Save patterns to Supabase ──────────────────────────────

async function savePatterns(
  patterns: (ThumbnailPattern & { source: string })[],
): Promise<number> {
  let saved = 0;

  for (const pattern of patterns) {
    try {
      // Check for existing similar pattern (same layout + text_style + emotional_hook)
      const { data: existing } = await supabase
        .from('seo_thumbnail_patterns')
        .select('id, weight')
        .eq('layout_type', pattern.layout_type)
        .eq('text_style', pattern.text_style)
        .eq('emotional_hook', pattern.emotional_hook)
        .single();

      if (existing) {
        // Pattern exists — increase weight (market validation)
        const currentWeight = existing.weight ?? 1.0;
        const { error: updateErr } = await supabase
          .from('seo_thumbnail_patterns')
          .update({
            weight: Math.min(currentWeight + 0.2, 3.0),
            // Update fields that may have evolved
            color_primary: pattern.color_primary,
            color_accent: pattern.color_accent,
            text_word_count: pattern.text_word_count,
            text_pattern: pattern.text_pattern,
            expression_type: pattern.expression_type,
            element_types: JSON.stringify(pattern.element_types),
            source: pattern.source,
          })
          .eq('id', existing.id)
          .select();

        if (updateErr) {
          console.error(`[Thumbnail Learner] Error updating pattern ${existing.id}:`, updateErr);
        } else {
          console.log(`[Thumbnail Learner] Updated pattern ${existing.id} (weight → ${Math.min(currentWeight + 0.2, 3.0)})`);
        }
      } else {
        // New pattern — insert
        const { error: insertErr } = await supabase
          .from('seo_thumbnail_patterns')
          .insert({
            layout_type: pattern.layout_type,
            color_primary: pattern.color_primary,
            color_accent: pattern.color_accent,
            text_style: pattern.text_style,
            text_word_count: pattern.text_word_count,
            text_pattern: pattern.text_pattern,
            expression_type: pattern.expression_type,
            element_types: JSON.stringify(pattern.element_types),
            emotional_hook: pattern.emotional_hook,
            weight: 1.0,
            source: pattern.source,
            learned_at: new Date().toISOString(),
          })
          .select();

        if (insertErr) {
          console.error('[Thumbnail Learner] Error inserting pattern:', insertErr);
        } else {
          saved++;
          console.log(`[Thumbnail Learner] ✓ New pattern: ${pattern.layout_type} / ${pattern.text_style} / ${pattern.emotional_hook}`);
        }
      }
    } catch (err) {
      console.error(`[Thumbnail Learner] Error saving pattern for ${pattern.source}:`, err);
    }
  }

  return saved;
}

// ── Decay stale patterns ───────────────────────────────────

async function decayStalePatterns(): Promise<number> {
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const { data: stale, error: fetchErr } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id, weight')
    .lt('learned_at', fourWeeksAgo)
    .gt('weight', 0.1);

  if (fetchErr) {
    console.error('[Thumbnail Learner] Error fetching stale patterns:', fetchErr);
    return 0;
  }

  if (!stale?.length) return 0;

  let count = 0;
  for (const pattern of stale) {
    const newWeight = Math.max((pattern.weight ?? 1.0) - 0.1, 0.1);
    const { error: updateErr } = await supabase
      .from('seo_thumbnail_patterns')
      .update({ weight: Math.round(newWeight * 10) / 10 })
      .eq('id', pattern.id)
      .select();

    if (updateErr) {
      console.error(`[Thumbnail Learner] Error decaying pattern ${pattern.id}:`, updateErr);
    } else {
      count++;
    }
  }

  return count;
}

// ── Main orchestrator ───────────────────────────────────────

export async function runThumbnailLearner(videoIds: string[]): Promise<{
  analyzed: number;
  newPatterns: number;
  decayed: number;
}> {
  console.log(`[Thumbnail Learner] Starting analysis for ${videoIds.length} videos...`);

  if (videoIds.length === 0) {
    console.log('[Thumbnail Learner] No video IDs provided, skipping');
    const decayed = await decayStalePatterns();
    console.log(`[Thumbnail Learner] Decayed patterns: ${decayed}`);
    return { analyzed: 0, newPatterns: 0, decayed };
  }

  // 1. Download thumbnails (parallel, batches of 5)
  console.log('[Thumbnail Learner] Downloading thumbnails...');
  const thumbnails = await downloadThumbnailsBatch(videoIds);
  console.log(`[Thumbnail Learner] Downloaded: ${thumbnails.length}/${videoIds.length}`);

  if (thumbnails.length === 0) {
    console.log('[Thumbnail Learner] No thumbnails downloaded, skipping analysis');
    const decayed = await decayStalePatterns();
    return { analyzed: 0, newPatterns: 0, decayed };
  }

  // 2. Send to Gemini for analysis (single call, batch of up to 10)
  console.log('[Thumbnail Learner] Analyzing with Gemini...');
  const toAnalyze = thumbnails.slice(0, 10);
  const patterns = await analyzeWithGemini(toAnalyze);
  console.log(`[Thumbnail Learner] Patterns extracted: ${patterns.length}`);

  // 3. Save patterns to Supabase
  let newPatterns = 0;
  if (patterns.length > 0) {
    console.log('[Thumbnail Learner] Saving patterns...');
    newPatterns = await savePatterns(patterns);
    console.log(`[Thumbnail Learner] New patterns saved: ${newPatterns}`);
  }

  // 4. Decay stale patterns
  const decayed = await decayStalePatterns();
  console.log(`[Thumbnail Learner] Decayed patterns: ${decayed}`);

  console.log(`[Thumbnail Learner] Done. Analyzed: ${patterns.length}, New: ${newPatterns}, Decayed: ${decayed}`);

  return {
    analyzed: patterns.length,
    newPatterns,
    decayed,
  };
}
