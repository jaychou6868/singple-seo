/**
 * Locked-Channel Learner — 鎖定學習 MrBeast + 影視颶風 兩個固定頻道
 *
 * 取代舊的 thumbnail-learner.ts（自動跨類目爬爆款）。
 *
 * Why locked: Karen 要的是「對標 MrBeast / 影視颶風 等級」的視覺品質，
 * 隨機爬爆款學到的是「平均水準」，不是「頂尖水準」。鎖定兩個世界級
 * 頻道直接學底層語法（對峙感、零裝飾、大字粗描邊、真實場景）。
 *
 * 流程：
 * 1. 從兩個頻道的 channel page HTML 抓最新 N 部影片 ID（不用 YouTube API key）
 * 2. 下載每部的 maxresdefault.jpg
 * 3. Gemini 分析每張縮圖：style_description (自然語言) + suggested_layout
 * 4. UPSERT 到 seo_thumbnail_patterns（用 video_id 去重）
 *
 * 一個頻道一次學 ~15 部，兩個頻道 ~30 張 reference。
 * 不依賴 YouTube Data API，零 quota。
 */

import { createClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Locked channels — confirmed by Karen 2026-04-07
const LOCKED_CHANNELS = [
  { id: 'UC2cRwTuSWxxEtrRnT4lrlQA', source: 'lks',     name: 'Mediastorm影视飓风' },
  { id: 'UCX6OQ3DkcsbYNE6H8uQQuVA', source: 'mrbeast', name: 'MrBeast' },
] as const;

const PER_CHANNEL_LIMIT = 15;

// ── Types ───────────────────────────────────────────────────

interface VideoMeta {
  videoId: string;
  channelId: string;
  source: 'mrbeast' | 'lks';
}

interface ThumbnailRow {
  videoId: string;
  base64: string;
  source: 'mrbeast' | 'lks';
}

interface StyleAnalysis {
  style_description: string;
  suggested_layout: 'face_left_text_right' | 'face_right_text_left' | 'face_center_text_top' | 'full_frame_overlay';
  has_person: boolean;
  view_count_estimate: number | null;
}

// ── Step 1: Fetch latest video IDs from channel HTML ───────

async function fetchVideoIdsFromChannel(channelId: string): Promise<string[]> {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  if (!res.ok) {
    console.warn(`[Locked Learner] Failed to fetch channel ${channelId}: HTTP ${res.status}`);
    return [];
  }
  const html = await res.text();

  // YouTube embeds video IDs as "videoId":"XXXXXXXXXXX" (11 chars)
  const matches = html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of matches) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
      if (ids.length >= PER_CHANNEL_LIMIT) break;
    }
  }
  return ids;
}

// ── Step 2: Download thumbnails ────────────────────────────

async function downloadThumbnail(videoId: string): Promise<string | null> {
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      // YouTube returns a 120x90 grey placeholder for missing maxres
      if (buf.byteLength < 5000) continue;
      return Buffer.from(buf).toString('base64');
    } catch {
      continue;
    }
  }
  return null;
}

async function downloadBatch(videos: VideoMeta[]): Promise<ThumbnailRow[]> {
  const results: ThumbnailRow[] = [];
  // Parallel batches of 5
  for (let i = 0; i < videos.length; i += 5) {
    const batch = videos.slice(i, i + 5);
    const downloaded = await Promise.all(
      batch.map(async (v) => {
        const b64 = await downloadThumbnail(v.videoId);
        return b64 ? { videoId: v.videoId, base64: b64, source: v.source } : null;
      }),
    );
    for (const r of downloaded) if (r) results.push(r);
  }
  return results;
}

// ── Step 3: Gemini analysis ────────────────────────────────

async function analyzeThumbnail(thumb: ThumbnailRow): Promise<{ ok: true; analysis: StyleAnalysis } | { ok: false; error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `你是 YouTube 縮圖視覺策略分析師。分析這張縮圖的視覺語法，輸出 JSON。

要分析的維度：

1. style_description (繁體中文，3-5 句話)：描述這張縮圖的「視覺策略」，包含：
   - 主體是什麼（人物表情/物件/場景）
   - 文字位置與風格（字色、描邊、字數）
   - 配色傾向（暖色/冷色、對比強度）
   - 情緒/張力的營造方式
   - 什麼讓它「不像廣告而像紀錄片」（如果適用）

   示例好的描述：
   「主體為驚恐表情的男主角佔右側 60%，左側為極粗白邊黃字『100 萬』。
    背景是現場光線下的真實賭場場景，無任何裝飾元素。
    配色以暖色（金/紅）對深色（黑/藍）製造強對比。
    張力來自人物表情與賭注數字的反差，紀錄片質感來自真實場景照而非合成圖。」

2. suggested_layout：以下四選一
   - "face_left_text_right" — 人臉在左、文字在右
   - "face_right_text_left" — 人臉在右、文字在左
   - "face_center_text_top" — 人臉居中、文字在上
   - "full_frame_overlay" — 文字疊在全景上方

3. has_person：縮圖是否包含明顯的人臉/人物（boolean）
   風景或純物件圖回 false。學習用樣本只要 has_person = true 的。

只輸出 JSON，不要其他文字：
{"style_description":"...","suggested_layout":"...","has_person":true}`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/jpeg', data: thumb.base64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.3,
      // 1024 was getting truncated by thinking budget — Chinese descriptions
      // take ~2 tokens per char and we need 4 fields. Bump to 4096 and skip
      // thinking (analysis doesn't need deep reasoning).
      maxOutputTokens: 4096,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (data?.error) {
      const msg = `${data.error.code || 'unknown'}: ${data.error.message || JSON.stringify(data.error).substring(0, 200)}`;
      console.warn(`[Locked Learner] Gemini error for ${thumb.videoId}: ${msg}`);
      return { ok: false, error: `gemini_error: ${msg}` };
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text) { text = parts[i].text; break; }
    }
    if (!text) {
      const finishReason = data?.candidates?.[0]?.finishReason || 'unknown';
      console.warn(`[Locked Learner] Empty Gemini response for ${thumb.videoId} (finishReason=${finishReason})`);
      return { ok: false, error: `empty_response: finishReason=${finishReason}` };
    }
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {
          return { ok: false, error: `parse_failed: ${cleaned.substring(0, 100)}` };
        }
      } else {
        return { ok: false, error: `no_json_found: ${cleaned.substring(0, 100)}` };
      }
    }
    if (!parsed?.style_description || !parsed?.suggested_layout) {
      return { ok: false, error: `missing_fields: ${JSON.stringify(parsed).substring(0, 100)}` };
    }
    return {
      ok: true,
      analysis: {
        style_description: parsed.style_description,
        suggested_layout: parsed.suggested_layout,
        has_person: parsed.has_person !== false,
        view_count_estimate: null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Locked Learner] Analysis exception for ${thumb.videoId}: ${msg}`);
    return { ok: false, error: `exception: ${msg}` };
  }
}

// ── Step 4: UPSERT to Supabase ─────────────────────────────

async function upsertReference(
  thumb: ThumbnailRow,
  analysis: StyleAnalysis,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Manual upsert: SELECT existing by video_id, then INSERT or UPDATE.
  // We avoid Supabase's .upsert(onConflict) because that requires a
  // non-partial unique index, and we want to keep the index partial
  // (so old enum rows with NULL video_id don't conflict).
  //
  // Legacy enum columns (layout_type / color_primary / etc.) were
  // dropped in sql/drop-legacy-enum-columns.sql 2026-04-07.
  const row = {
    video_id: thumb.videoId,
    channel_source: thumb.source,
    reference_image_b64: thumb.base64,
    style_description: analysis.style_description,
    suggested_layout: analysis.suggested_layout,
    view_count: analysis.view_count_estimate,
    learned_at: new Date().toISOString(),
    weight: 1.0,
  };

  const { data: existing, error: selErr } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id')
    .eq('video_id', thumb.videoId)
    .maybeSingle();

  if (selErr) {
    return { ok: false, error: `select: ${selErr.message}` };
  }

  if (existing) {
    const { error: updErr } = await supabase
      .from('seo_thumbnail_patterns')
      .update(row)
      .eq('id', existing.id);
    if (updErr) return { ok: false, error: `update: ${updErr.message}` };
  } else {
    const { error: insErr } = await supabase
      .from('seo_thumbnail_patterns')
      .insert(row);
    if (insErr) return { ok: false, error: `insert: ${insErr.message}` };
  }
  return { ok: true };
}

// ── Main ────────────────────────────────────────────────────

export async function runLockedChannelLearner(): Promise<{
  channelsScanned: number;
  videosFetched: number;
  thumbnailsDownloaded: number;
  analyzed: number;
  filteredNoPerson: number;
  stored: number;
  errors: { videoId: string; stage: string; error: string }[];
}> {
  console.log('[Locked Learner] Start — locked channels:',
    LOCKED_CHANNELS.map(c => `${c.source}:${c.id}`).join(', '));

  // 1. Fetch video IDs from each channel
  const allVideos: VideoMeta[] = [];
  for (const ch of LOCKED_CHANNELS) {
    const ids = await fetchVideoIdsFromChannel(ch.id);
    console.log(`[Locked Learner] ${ch.source}: ${ids.length} videos`);
    for (const id of ids) {
      allVideos.push({ videoId: id, channelId: ch.id, source: ch.source });
    }
  }

  // 2. Download all thumbnails (parallel batches of 5)
  console.log(`[Locked Learner] Downloading ${allVideos.length} thumbnails...`);
  const thumbs = await downloadBatch(allVideos);
  console.log(`[Locked Learner] Downloaded: ${thumbs.length}/${allVideos.length}`);

  // 3. Analyze each (sequential to avoid Gemini rate limit; per-thumb is fast).
  // Collect errors so the endpoint can return them in the response — we have
  // no other way to see Zeabur logs from outside.
  const errors: { videoId: string; stage: string; error: string }[] = [];
  let analyzedCount = 0;
  let filteredNoPerson = 0;
  let stored = 0;
  for (const thumb of thumbs) {
    const result = await analyzeThumbnail(thumb);
    if (!result.ok) {
      errors.push({ videoId: thumb.videoId, stage: 'analyze', error: result.error });
      continue;
    }
    analyzedCount++;
    if (!result.analysis.has_person) {
      filteredNoPerson++;
      console.log(`[Locked Learner] Skipped ${thumb.videoId} (no person)`);
      continue;
    }
    const upsertResult = await upsertReference(thumb, result.analysis);
    if (upsertResult.ok) {
      stored++;
    } else {
      errors.push({ videoId: thumb.videoId, stage: 'upsert', error: upsertResult.error });
    }
  }

  // 4. Weight decay — references not used in 4 weeks lose 0.2 weight
  //    (floored at 0.1 so they're never fully starved). This complements
  //    the bump-on-select in /thumbnail/select.
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id, weight')
    .lt('learned_at', fourWeeksAgo)
    .not('channel_source', 'is', null);

  let decayed = 0;
  for (const row of (stale ?? []) as { id: string; weight: number | null }[]) {
    const newWeight = Math.max((row.weight ?? 1.0) - 0.2, 0.1);
    const { error: decayErr } = await supabase
      .from('seo_thumbnail_patterns')
      .update({ weight: newWeight })
      .eq('id', row.id);
    if (!decayErr) decayed++;
  }

  // 5. Update learner_meta so self-waking cron knows when we last ran
  await supabase.from('learner_meta').update({
    last_run_at: new Date().toISOString(),
    last_run_summary: { channelsScanned: LOCKED_CHANNELS.length, stored, errors: errors.length, decayed },
  }).eq('id', 'locked_channel_learner');

  const result = {
    channelsScanned: LOCKED_CHANNELS.length,
    videosFetched: allVideos.length,
    thumbnailsDownloaded: thumbs.length,
    analyzed: analyzedCount,
    filteredNoPerson,
    stored,
    decayed,
    errors,
  };
  console.log('[Locked Learner] Done:', { ...result, errors: `${errors.length} errors` });
  return result;
}
