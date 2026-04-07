/**
 * Thumbnail Generator — YouTube 縮圖候選生成
 *
 * 流程：
 * 1. 從 seo_thumbnail_patterns 知識庫選設計模式
 * 2. Gemini 生成縮圖文字（2-4 中文字短語）
 * 3. Nano Banana Pro 生成設計背景（含文字）
 * 4. Sharp 合成人物框到背景上（漸層遮罩融合）
 * 5. 上傳 3 個候選到 Supabase Storage
 *
 * 生成: Gemini 3 Pro Image Preview (Nano Banana Pro)
 * 文字: Gemini 3.1 Pro Preview
 */

import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { removeBackground as imglyRemoveBackground } from '@imgly/background-removal-node';
import { beautifyFace } from './face-beautify.js';

// ── Config ──────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const GEMINI_MODEL_PRO = 'gemini-3-pro-image-preview';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;
const CANDIDATE_COUNT = 3;

// ── Clients ─────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ───────────────────────────────────────────────────

// ── Reference (learned from MrBeast + 影視颶風) ─────────────

interface ReferencePattern {
  id: string;
  channel_source: 'mrbeast' | 'lks' | 'manual' | null;
  reference_image_b64: string | null;       // base64 JPEG of the YouTube thumbnail
  style_description: string;                 // Gemini's natural-language analysis
  suggested_layout: string;                  // face_left_text_right, etc.
  video_id: string | null;
}

interface ThumbnailCandidate {
  id: string | undefined;        // seo_thumbnail_candidates.id (for select feedback)
  imageUrl: string;
  thumbnailText: string;
  patternId: string | null;
  referenceVideoIds: string[];
}

interface ProgressCallback {
  (progress: number, stage: string, detail: string): void;
}

// ── Cold Start Defaults ────────────────────────────────────
//
// Used when seo_thumbnail_patterns has fewer than 3 references with
// non-null channel_source — i.e. the locked-channel learner hasn't
// run yet. These describe the new "real-scene confrontation" style
// in text only (no image), so the generator falls back to text-only
// prompts. After the learner runs, references override these.

const DEFAULT_PATTERNS: ReferencePattern[] = [
  {
    id: 'default_1',
    channel_source: null,
    reference_image_b64: null,
    style_description:
      '主體為人物特寫加大字標題（左字右人或反之），背景是真實場景照片（不是合成插畫）。' +
      '配色暖色對冷色強對比，字體粗黑無襯線加白邊。情緒張力來自表情與標題的反差。' +
      '零裝飾元素 — 沒有箭頭、emoji、音符、光暈、漸層裝飾。',
    suggested_layout: 'face_right_text_left',
    video_id: null,
  },
  {
    id: 'default_2',
    channel_source: null,
    reference_image_b64: null,
    style_description:
      '人物在右、文字在左的對峙構圖。文字 2-3 個中文字加超粗白邊。' +
      '背景是與主題相關的真實物件或場景近拍。整體像紀錄片截圖而非廣告版面。',
    suggested_layout: 'face_right_text_left',
    video_id: null,
  },
  {
    id: 'default_3',
    channel_source: null,
    reference_image_b64: null,
    style_description:
      '人物居中、大字疊在頂部的衝擊構圖。配色深底亮字（深藍/暖白 或 深紅/亮黃）。' +
      '張力靠人物表情與賭注式短語（如「3 秒救嗓」「鎖喉真相」）製造。',
    suggested_layout: 'face_center_text_top',
    video_id: null,
  },
];

// ── Gemini API Helpers ─────────────────────────────────────

/**
 * Call Gemini text model (same pattern as seo-video.ts callGemini)
 */
async function callGeminiText(prompt: string, systemPrompt?: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 4096,
    },
  };

  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json() as Record<string, any>;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text) return parts[i].text;
    }
    throw new Error(`Gemini text returned no text: ${JSON.stringify(data).substring(0, 200)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Gemini image generation model (Nano Banana Pro)
 * Returns base64-encoded image data.
 * Optional `inputImageBase64` enables image-to-image editing (e.g. background removal).
 */
async function callGeminiImage(
  prompt: string,
  inputImageBase64?: string,
  temperature = 0.9,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_PRO}:generateContent?key=${GEMINI_API_KEY}`;

  const parts: any[] = [{ text: prompt }];
  if (inputImageBase64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: inputImageBase64 } });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json() as Record<string, any>;
    const parts = data?.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        return part.inlineData.data;
      }
    }

    throw new Error(`Gemini image returned no image: ${JSON.stringify(data).substring(0, 300)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonResponse(text: string): any {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
  }
  return null;
}

// ── Step 1: Select Patterns ────────────────────────────────

/**
 * Weighted random pick. Higher weight = higher probability. weight=0
 * is treated as 0.1 to prevent total starvation of decayed references.
 */
function pickWeighted<T extends { weight?: number | null }>(items: T[]): T {
  const weights = items.map(i => Math.max(i.weight ?? 1.0, 0.1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickWeightedNoDup<T extends { id: string; weight?: number | null }>(
  items: T[],
  excludeIds: Set<string>,
): T | null {
  const remaining = items.filter(i => !excludeIds.has(i.id));
  if (remaining.length === 0) return null;
  return pickWeighted(remaining);
}

/**
 * Pick 3 references for a generation run.
 *
 * Strategy: prefer rows from the locked-channel learner (channel_source IN
 * ('mrbeast', 'lks')). When the learner has run, we mix 1 LKs + 1 MrBeast +
 * 1 random — using WEIGHTED random so references that Karen previously
 * selected (via POST /thumbnail/select) get bumped weight and appear more
 * often. References not used in 4 weeks have their weight decayed.
 *
 * Cold start (learner hasn't run): fall back to DEFAULT_PATTERNS which are
 * text-only style descriptors.
 */
async function selectReferences(): Promise<ReferencePattern[]> {
  const { data: lks } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id, channel_source, reference_image_b64, style_description, suggested_layout, video_id, weight')
    .eq('channel_source', 'lks')
    .not('reference_image_b64', 'is', null)
    .order('learned_at', { ascending: false })
    .limit(15);

  const { data: mrbeast } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id, channel_source, reference_image_b64, style_description, suggested_layout, video_id, weight')
    .eq('channel_source', 'mrbeast')
    .not('reference_image_b64', 'is', null)
    .order('learned_at', { ascending: false })
    .limit(15);

  const lksPool = (lks ?? []) as unknown as (ReferencePattern & { weight?: number })[];
  const mrbeastPool = (mrbeast ?? []) as unknown as (ReferencePattern & { weight?: number })[];
  const combined = [...lksPool, ...mrbeastPool];

  // Cold-start: not enough learned references — fall back
  if (combined.length < CANDIDATE_COUNT) {
    console.log(`[Thumbnail Generator] Cold start: only ${combined.length} learned references, using DEFAULT_PATTERNS`);
    return DEFAULT_PATTERNS;
  }

  // Mix: 1 LKs + 1 MrBeast + 1 random from either, all weighted by `weight`
  const used = new Set<string>();
  const selected: ReferencePattern[] = [];
  if (lksPool.length > 0) {
    const pick = pickWeightedNoDup(lksPool, used);
    if (pick) { selected.push(pick); used.add(pick.id); }
  }
  if (mrbeastPool.length > 0) {
    const pick = pickWeightedNoDup(mrbeastPool, used);
    if (pick) { selected.push(pick); used.add(pick.id); }
  }
  while (selected.length < CANDIDATE_COUNT) {
    const pick = pickWeightedNoDup(combined, used);
    if (!pick) break;
    selected.push(pick);
    used.add(pick.id);
  }

  console.log(`[Thumbnail Generator] Selected references (weighted): ${selected.map(r => `${r.channel_source}:${r.video_id ?? r.id}(w=${(r as any).weight ?? 1})`).join(', ')}`);
  return selected.slice(0, CANDIDATE_COUNT);
}

// ── Step 2: Generate Thumbnail Text ────────────────────────

async function generateThumbnailTexts(
  title: string,
  videoSummary: string,
  videoType: string,
): Promise<string[]> {
  const systemPrompt = `你是 YouTube 縮圖文字大師，專為「簡單歌唱 Singple.」這個歌唱教學頻道寫縮圖上的對峙式大字。風格參考影視颶風與 MrBeast — 短、有力、製造對峙感，但保留歌唱教學頻道該有的溫度（不要威脅式罵人）。`;

  const prompt = `## 任務
為這支歌唱教學影片生成 3 個縮圖大字短語，分屬三種句型。

## 鐵律
1. **2-4 個中文字**（4 字是極限，多 1 字就 reject）
2. 不能含贅字「的」「了」「之」「在」「是」
3. 不能跟 SEO 標題重複用字
4. **手機縮圖 168×94 px** 下要一秒讀懂

## 三個句型（必須各出一個）

### 句型 A：揭密型（暗示這影片揭露某個真相）
範例：「鎖喉真相」「偷偷練的」「老師沒講」「真相曝光」

### 句型 B：反差數字型（具體小數字 + 大效果）
範例：「3 秒開嗓」「1 動作」「30 天」「秒變鐵肺」

### 句型 C：痛點點名型（直接點出觀眾的具體痛點，不威脅）
範例：「怕高音?」「鎖喉的人」「氣不夠?」「破音救星」

## 影片資訊
- SEO 標題：${title}
- 影片摘要：${videoSummary.substring(0, 500)}
- 影片類型：${videoType}

## 輸出 JSON
{"phrases": ["A 句型短語", "B 句型短語", "C 句型短語"]}

只輸出 JSON。`;

  const raw = await callGeminiText(prompt, systemPrompt);
  const parsed = parseJsonResponse(raw);

  if (parsed?.phrases && Array.isArray(parsed.phrases) && parsed.phrases.length >= CANDIDATE_COUNT) {
    // Hard-enforce the 2-4 char limit (Sally's mobile readability rule).
    // Strip whitespace and reject overlong items.
    const cleaned: string[] = parsed.phrases
      .slice(0, CANDIDATE_COUNT)
      .map((p: string) => p.trim())
      .filter((p: string) => {
        const len = [...p.replace(/\s/g, '')].length;
        return len >= 2 && len <= 4;
      });
    if (cleaned.length === CANDIDATE_COUNT) return cleaned;
    console.warn(`[Thumbnail Generator] Text length filter dropped to ${cleaned.length}/${CANDIDATE_COUNT}`);
    const FALLBACK = ['鎖喉真相', '3 秒救嗓', '怕高音?'];
    while (cleaned.length < CANDIDATE_COUNT) {
      cleaned.push(FALLBACK[cleaned.length]);
    }
    return cleaned;
  }

  console.warn('[Thumbnail Generator] Text generation returned unexpected format, using fallbacks');
  return ['鎖喉真相', '3 秒救嗓', '怕高音?'];
}

// ── Step 3: Generate Design Backgrounds (few-shot from references) ──
//
// New approach (verified by POC-C 2026-04-07):
// - Pass 3 reference thumbnails (mixed MrBeast + LKs) as inline image parts
//   to Gemini Nano Banana Pro, plus a text prompt that names the layout
//   slot, the Chinese text overlay, and zero-decoration constraints.
// - Gemini outputs a real-photographic-scene background, not stock-art.
// - The reference's `style_description` gives Gemini extra context to mimic.

function buildDesignPrompt(
  reference: ReferencePattern,
  thumbnailText: string,
  title: string,
  layoutType: string,
): string {
  const layoutInstruction: Record<string, string> = {
    face_left_text_right:
      'Place the Chinese text on the RIGHT 55% of the canvas. Leave the LEFT 45% as a clean simple region (gradient or muted scene element) — a person will be composited there later.',
    face_right_text_left:
      'Place the Chinese text on the LEFT 55% of the canvas. Leave the RIGHT 45% as a clean simple region (gradient or muted scene element) — a person will be composited there later.',
    face_center_text_top:
      'Place the Chinese text at the TOP 30% of the canvas. Leave the CENTER and BOTTOM area as a clean simple region — a person will be composited there later.',
    full_frame_overlay:
      'Cover the canvas with a real-scene background. Place the Chinese text in the upper third with a strong dark gradient under the text for legibility.',
  };
  const layoutLine = layoutInstruction[layoutType] || layoutInstruction.face_right_text_left;

  // Karen 2026-04-07 v14 follow-up: person is now bottom-anchored at
  // 65% height. Text MUST go in the top area (above the person) so it
  // doesn't get covered. Person sits in the bottom-left, bottom-right,
  // or bottom-center depending on layout.
  const textArea = 'the TOP 35% of the canvas (pixels 0-252 in y-axis), spanning the full width or aligned opposite to the person';

  const personArea = layoutType === 'face_left_text_right' || layoutType === 'full_frame_overlay'
    ? 'the BOTTOM-LEFT quadrant (x: 0-640, y: 252-720) — leave it as a clean simple region for the person photo'
    : layoutType === 'face_center_text_top'
      ? 'the BOTTOM-CENTER area (x: 320-960, y: 252-720) — leave it as a clean simple region'
      : 'the BOTTOM-RIGHT quadrant (x: 640-1280, y: 252-720) — leave it as a clean simple region for the person photo';

  return `Generate a YouTube thumbnail BACKGROUND image at 1280x720 pixels (16:9).

## Style Reference
Look at the reference thumbnail attached. Notice its visual language:
- REAL photographic scenes or real objects (NOT illustrated/decorative graphics)
- Massive bold sans-serif Chinese text with thick white outline
- ONE clear focal point per image (not a busy collage)
- Strong contrast color palette
- ZERO decorative graphics: no arrows, no sparkles, no emoji icons,
  no music notes, no glow effects
- Mood: confrontational, documentary, cinematic

Style notes: "${reference.style_description}"

## STRICT LAYOUT REQUIREMENTS

### Text area
- Place the Chinese text "${thumbnailText}" in ${textArea}
- The text MUST fit entirely within this area
- DO NOT extend the text into the person area
- Render in extra-bold sans-serif (Source Han Sans Heavy feel) with
  thick WHITE outline. Massive size, readable at 168×94 px.

### Person area (DO NOT DRAW A PERSON HERE — leave it clean)
- ${personArea}
- A real person photo will be composited into this area later
- Keep this area visually simple: gradient, soft scene element, or
  muted background — NO text, NO graphics, NO drawn people

### CRITICAL TEXT RULES
- Render the text "${thumbnailText}" EXACTLY ONCE — do not duplicate it
- Do not add subtitles, captions, or any other text anywhere
- The 4 characters of the text must appear ONE TIME, not twice or more

## Background scene
- Real scene related to singing tutorials: microphone close-up, recording
  studio with warm lights, vintage radio, sheet music in dramatic lighting,
  vocal booth, sound mixer console, acoustic panels
- Choose ONE scene element, not a collage
- Be CREATIVE and DIFFERENT from the reference — same style, different scene

## Color palette (be diverse)
Choose ONE of these palettes (try to vary across attempts):
- Deep blue (#1A237E) + warm cream/gold accents
- Warm cream (#FFF8E1) + deep red (#B71C1C) accents
- Dark teal + amber spotlight
- Charcoal (#212121) + electric yellow (#FFD600) accents
- Burgundy (#7B1FA2 wait — pick warm only) deep maroon + cream

AVOID: purple, pink, neon, gradient pastels.

## Video Context
"${title}" — singing tutorial for 簡單歌唱 Singple. channel.

## ABSOLUTE RULES
- DO NOT draw any people, faces, hands, body parts, or human figures
- DO NOT add decorative graphics (arrows, sparkles, emoji, music notes, glows)
- DO NOT make it look like a stock illustration or advertisement banner
- DO NOT duplicate the text — render it ONE TIME ONLY
- The text and the person area must NEVER overlap
- Output only the image`;
}

/**
 * Quality gate: detect if a generated background contains people (Gemini
 * sometimes ignores "DO NOT draw people" prompts and paints a person in
 * the slot meant for our cutout, producing ghost-arms/multi-body effects
 * after composite). Returns true if the background is clean.
 *
 * Karen 2026-04-07: this exists because we composite a real Karen cutout
 * onto the background — if Gemini already drew a person, we get two
 * overlapping people. Visual horror.
 */
async function backgroundHasNoPerson(jpegBuffer: Buffer): Promise<boolean> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const b64 = jpegBuffer.toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Does this image contain any visible person, face, hand, arm, body, or human figure (real or drawn)? Answer ONLY "yes" or "no" (lowercase, single word, nothing else).' },
            { inlineData: { mimeType: 'image/jpeg', data: b64 } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      }),
    });
    const data = await res.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (const p of parts) if (p.text) { text = p.text; break; }
    const answer = text.trim().toLowerCase();
    const hasPerson = answer.startsWith('yes');
    console.log(`[Thumbnail Generator] background person check: "${answer}" → clean=${!hasPerson}`);
    return !hasPerson;
  } catch (err) {
    console.warn('[Thumbnail Generator] background person check failed (assume clean):', err);
    return true;  // fail-open: don't block generation if check fails
  }
}

async function generateDesignBackground(
  reference: ReferencePattern,
  thumbnailText: string,
  title: string,
  candidateIndex: number,
): Promise<Buffer> {
  const layoutType = reference.suggested_layout || 'face_right_text_left';
  const prompt = buildDesignPrompt(reference, thumbnailText, title, layoutType);

  // Karen 2026-04-07: pass ONLY this candidate's own reference image
  // (not all 3). Mixing 3 references averaged the styles → all candidates
  // looked the same. Single reference + high temperature 0.95 produces
  // distinctly different backgrounds across the 3 candidates.
  const referenceImages = reference.reference_image_b64
    ? [reference.reference_image_b64]
    : [];

  console.log(`[Thumbnail Generator] Generating background #${candidateIndex} (layout=${layoutType}, ref=${reference.video_id || reference.id})`);

  let lastError: Error | null = null;

  // Up to 3 attempts: each attempt generates + person-checks. If person
  // detected, the next attempt has a stronger no-person clause prepended.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const attemptPrompt = attempt === 0
        ? prompt
        : `🚫 ABSOLUTE RULE: This image must NOT contain any person, face, hand, arm, body, human figure, or any humanoid silhouette. The previous attempt failed because you drew a person — do not draw any. Empty scene only.\n\n${prompt}`;

      const base64Image = await callGeminiImageMultiRef(prompt === attemptPrompt ? prompt : attemptPrompt, referenceImages, 0.95);
      const buffer = Buffer.from(base64Image, 'base64');

      const resized = await sharp(buffer)
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'cover' })
        .jpeg({ quality: 95 })
        .toBuffer();

      // Quality gate: ensure background has no person
      const isClean = await backgroundHasNoPerson(resized);
      if (isClean) {
        if (attempt > 0) {
          console.log(`[Thumbnail Generator] background #${candidateIndex} clean on attempt ${attempt + 1}`);
        }
        return resized;
      }

      console.warn(`[Thumbnail Generator] background #${candidateIndex} contains person on attempt ${attempt + 1}, retrying`);
      lastError = new Error('background contained drawn person');
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Thumbnail Generator] Background generation attempt ${attempt + 1} failed for #${candidateIndex}: ${lastError.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  throw lastError || new Error(`Background generation failed for candidate #${candidateIndex} after 3 attempts`);
}

/**
 * Variant of callGeminiImage that accepts multiple reference images.
 * POC-C (2026-04-07) verified this works with Nano Banana Pro.
 */
async function callGeminiImageMultiRef(
  prompt: string,
  referenceImagesB64: string[],
  temperature = 0.7,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_PRO}:generateContent?key=${GEMINI_API_KEY}`;

  const parts: any[] = [{ text: prompt }];
  for (const ref of referenceImagesB64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: ref } });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json() as Record<string, any>;
    const respParts = data?.candidates?.[0]?.content?.parts || [];
    for (const p of respParts) {
      if (p.inlineData?.data) return p.inlineData.data;
    }
    throw new Error(`Gemini multi-ref returned no image: ${JSON.stringify(data).substring(0, 300)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Step 4: Composite with Sharp ───────────────────────────

/**
 * Determine person placement based on layout type.
 *
 * Karen 2026-04-07 (v14 follow-up): person is now ALWAYS bottom-anchored
 * and 65% height, leaving the top 35% for text. This eliminates the "hard
 * cut at the bottom" issue from v14 — bottom-aligned cutouts blend more
 * naturally because the slot bottom matches the canvas bottom and the
 * additional bottom fade gradient (compositeCandidate) softens any seam.
 *
 * Layout horizontal positions:
 *   - face_left_text_right  → person bottom-LEFT
 *   - face_right_text_left  → person bottom-RIGHT
 *   - face_center_text_top  → person bottom-CENTER
 *   - full_frame_overlay    → same as face_left_text_right (default)
 */
function getPersonPlacement(layoutType: string): {
  personWidth: number;
  personHeight: number;
  personX: number;
  personY: number;
  gradientDirection: 'left' | 'right' | 'both';
} {
  const personWidth = Math.round(THUMBNAIL_WIDTH * 0.5);    // 640
  const personHeight = Math.round(THUMBNAIL_HEIGHT * 0.65); // 468
  const personY = THUMBNAIL_HEIGHT - personHeight;           // 252 (bottom-aligned)

  switch (layoutType) {
    case 'face_left_text_right':
    case 'full_frame_overlay':
      return {
        personWidth,
        personHeight,
        personX: 0,                                           // bottom-left
        personY,
        gradientDirection: 'right',
      };

    case 'face_center_text_top':
      return {
        personWidth,
        personHeight,
        personX: Math.round((THUMBNAIL_WIDTH - personWidth) / 2),
        personY,
        gradientDirection: 'both',
      };

    case 'face_right_text_left':
    default:
      return {
        personWidth,
        personHeight,
        personX: THUMBNAIL_WIDTH - personWidth,               // bottom-right
        personY,
        gradientDirection: 'left',
      };
  }
}

/**
 * Apply a vertical bottom-fade gradient to a PNG with alpha. The bottom
 * `fadeRatio` of the image fades from full opacity to fully transparent,
 * blending the cutout's hard bottom edge into the background underneath.
 */
async function applyBottomFade(pngBuffer: Buffer, fadeRatio = 0.25): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = Buffer.from(data);
  const w = info.width;
  const h = info.height;
  const fadeStart = Math.round(h * (1 - fadeRatio));

  for (let y = fadeStart; y < h; y++) {
    const t = (y - fadeStart) / (h - fadeStart);  // 0 at fadeStart, 1 at bottom
    const alphaScale = 1 - t;                     // 1 at top of fade, 0 at bottom
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4 + 3;            // alpha channel
      px[idx] = Math.round(px[idx] * alphaScale);
    }
  }

  return sharp(px, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Remove the background from a person frame using Gemini Nano Banana Pro.
 *
 * Strategy: ask Gemini to replace the background with pure green (#00FF00),
 * then chroma-key the green out in Sharp to produce a real RGBA cutout.
 *
 * Why not ask Gemini for "transparent background" directly? Gemini's image
 * model returns JPEG (no alpha channel) — when asked for transparency it
 * literally draws a checkerboard pattern, which is unusable.
 */
async function removeBackgroundFromFrame(personFrameBase64: string): Promise<Buffer> {
  // Karen 2026-04-07: replaced Gemini chroma-key (random LLM output)
  // with @imgly/background-removal-node — a real ONNX-based person
  // segmentation model. POC verified:
  //   - 100% reliable: chair, walls, desks all removed
  //   - 2 sec/frame (vs 35 sec for Gemini chroma key)
  //   - Local inference, no API quota
  //
  // imgly returns a SOFT alpha mask (gradient values 0-255). For
  // YouTube thumbnails composited onto cinematic backgrounds, the
  // soft edges look like translucent ghosts. Threshold the alpha at
  // 30 to convert to a hard mask: anything > 30 → fully opaque,
  // anything ≤ 30 → fully transparent. This preserves clothing
  // edges (which the model gives ~50 alpha) without leaking gradient
  // through the body.
  const inputBuffer = Buffer.from(personFrameBase64, 'base64');

  // imgly internally calls Blob([buf]) without type when given a Buffer,
  // producing empty mime → "Unsupported format" error. Wrap explicitly.
  // Use node:buffer Blob (not global) for cross-runtime safety on Zeabur.
  const { Blob: NodeBlob } = await import('node:buffer');
  const inputBlob = new NodeBlob([inputBuffer], { type: 'image/jpeg' });

  const blob = await imglyRemoveBackground(inputBlob as any, {
    model: 'medium',
    output: { format: 'image/png', quality: 1 },
  });
  const cutoutBuffer = Buffer.from(await blob.arrayBuffer());

  // Convert soft alpha mask → hard alpha mask via threshold
  const { data, info } = await sharp(cutoutBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = Buffer.from(data);
  for (let i = 3; i < px.length; i += 4) {
    px[i] = px[i] > 30 ? 255 : 0;
  }

  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Select the best frame from the provided frames array.
 * Picks the frame closest to 1/3 into the video (often a good representative frame).
 */
function selectBestFrame(frames: string[]): string {
  if (frames.length === 0) throw new Error('No frames provided');
  if (frames.length === 1) return frames[0];

  // Pick frame at ~1/3 position (good balance between intro and content)
  const targetIndex = Math.floor(frames.length / 3);
  return frames[targetIndex];
}

/**
 * Composite a pre-cut-out person (PNG with alpha) onto the design background.
 *
 * Karen 2026-04-07: full quality pipeline:
 *  1. Sharp.trim() — strip transparent margins so the cutout bbox is tight
 *     around the actual person (no floating-head effect from top alignment)
 *  2. Sanity check — if trimmed cutout is too short (chroma key cropped the
 *     torso), fall back to fit:'contain' on the original cutout so the
 *     person stays whole even at smaller size
 *  3. fit:'cover' + position:'top' fills the slot with the head dominant
 */
async function compositeCandidate(
  designBackground: Buffer,
  personCutoutPng: Buffer,
  layoutType: string,
): Promise<Buffer> {
  const placement = getPersonPlacement(layoutType);

  // Step 1: trim transparent margins. Sharp's trim() with a transparent
  // background reads the alpha channel and crops to the non-transparent
  // bounding box. This converts a 1920×1080 cutout with mostly transparent
  // top/bottom into a tight box around the actual person.
  let trimmedCutout: Buffer;
  let trimmedMeta: { width?: number; height?: number };
  try {
    trimmedCutout = await sharp(personCutoutPng)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .png()
      .toBuffer();
    trimmedMeta = await sharp(trimmedCutout).metadata();
  } catch {
    // trim failed (no alpha or fully opaque) — use original
    trimmedCutout = personCutoutPng;
    trimmedMeta = await sharp(personCutoutPng).metadata();
  }

  const tw = trimmedMeta.width || 1;
  const th = trimmedMeta.height || 1;
  const trimmedAspect = tw / th;
  const slotAspect = placement.personWidth / placement.personHeight;

  // Q2 sanity check: if the trimmed cutout aspect is wildly off (e.g. very
  // wide and short → just a head with no torso, or chroma key ate the body),
  // we still want to fit it without distortion. Sharp 'cover' will crop to
  // match slot aspect; if the cutout is "head-only" (height < 30% of width)
  // we use 'contain' so we don't double-zoom into just the head.
  const isHeadOnly = th < tw * 0.6;  // heuristic: torso would make it taller

  const personResizedRaw = await sharp(trimmedCutout)
    .resize(placement.personWidth, placement.personHeight, {
      fit: isHeadOnly ? 'contain' : 'cover',
      position: 'top',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Karen 2026-04-07 v14 follow-up: cutout had a hard bottom seam where
  // the clothing was cut. Apply a vertical bottom-fade gradient to blend
  // the bottom 25% into the background.
  const personResized = await applyBottomFade(personResizedRaw, 0.25);

  console.log(`[Thumbnail Generator] composite layout=${layoutType} trimmed=${tw}×${th} aspect=${trimmedAspect.toFixed(2)} slotAspect=${slotAspect.toFixed(2)} mode=${isHeadOnly ? 'contain' : 'cover'} bottomFade=0.25`);

  return sharp(designBackground)
    .composite([{
      input: personResized,
      left: placement.personX,
      top: placement.personY,
      blend: 'over',
    }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

// ── Step 5: Convert to data URL (no external storage needed) ─

async function uploadCandidate(
  jobId: string,
  candidateIndex: number,
  imageBuffer: Buffer,
): Promise<string> {
  // Store as base64 data URL — each thumbnail is ~100-200KB JPEG
  // This avoids needing a Supabase Storage bucket or GCS setup
  const base64 = imageBuffer.toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

// ── Main Export ─────────────────────────────────────────────

export async function generateThumbnails(params: {
  jobId: string;
  frames: string[];        // base64 JPEG frames from frontend
  title: string;           // Selected SEO title
  videoSummary: string;    // Video analysis summary
  videoType: string;       // 'tutorial' | 'performance' | 'daily'
  sendProgress?: (progress: number, stage: string, detail: string) => void;
}): Promise<{
  candidates: ThumbnailCandidate[];
}> {
  const { jobId, frames, title, videoSummary, videoType, sendProgress } = params;
  const progress = sendProgress || (() => {});
  const candidates: ThumbnailCandidate[] = [];

  console.log(`[Thumbnail Generator] Starting for job ${jobId} — ${frames.length} frames, type: ${videoType}`);

  // ── Step 1: Select references (locked-channel learner pool) ──
  progress(5, 'thumbnail_patterns', '選擇 reference 縮圖（影視颶風 / MrBeast）...');
  const references = await selectReferences();

  // ── Step 2: Generate thumbnail texts ─────────────────────
  progress(15, 'thumbnail_text', '生成縮圖大字（對峙句型）...');
  const texts = await generateThumbnailTexts(title, videoSummary, videoType);
  console.log(`[Thumbnail Generator] Generated texts: ${texts.join(', ')}`);

  // ── Step 3: Generate design backgrounds + remove person bg (parallel) ───
  progress(25, 'thumbnail_design', '生成設計背景 + 去背人物（並行）...');
  const bestFrame = selectBestFrame(frames);

  const [designResults, personCutoutResult] = await Promise.all([
    Promise.allSettled(
      references.map((ref, i) =>
        // Karen 2026-04-07: each candidate uses ONLY its own reference
        // (not all 3). Diversity comes from different references +
        // temperature 0.95.
        generateDesignBackground(ref, texts[i], title, i)
      ),
    ),
    // Run background removal in parallel with design generation
    removeBackgroundFromFrame(bestFrame).catch((err) => {
      console.error(`[Thumbnail Generator] Background removal failed, falling back to raw frame:`, err);
      return null;
    }),
  ]);

  // Fallback: if background removal failed, use raw frame as opaque PNG
  const personCutoutRaw = personCutoutResult ?? await sharp(Buffer.from(bestFrame, 'base64')).png().toBuffer();

  // Beautify: Gemini bbox + Sharp local blur on face skin only
  // (eyes/nose/mouth re-overlaid from original to stay sharp).
  // POC verified this preserves identity + expression while smoothing skin.
  // If Gemini bbox call fails, beautifyFace returns the input unchanged.
  const personCutoutPng = await beautifyFace(personCutoutRaw, 'subtle');
  console.log(`[Thumbnail Generator] Person cutout ready (${personCutoutResult ? 'bg removed' : 'raw fallback'}, beautify=subtle)`);

  // ── Step 4: Composite person + background ────────────────
  progress(65, 'thumbnail_composite', '合成人物與背景...');

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const designResult = designResults[i];

    if (designResult.status === 'rejected') {
      console.error(`[Thumbnail Generator] Candidate #${i} design failed: ${designResult.reason}`);
      continue; // Skip this candidate
    }

    const designBackground = designResult.value;

    try {
      // Composite — use the reference's suggested_layout for placement
      const composited = await compositeCandidate(
        designBackground,
        personCutoutPng,
        references[i].suggested_layout || 'face_right_text_left',
      );

      // ── Step 5: Upload ──────────────────────────────────
      progress(75 + (i * 7), 'thumbnail_upload', `上傳候選 ${i + 1}/${CANDIDATE_COUNT}...`);
      const imageUrl = await uploadCandidate(jobId, i, composited);

      const referenceVideoIds = references
        .map((r) => r.video_id)
        .filter((v): v is string => v !== null);

      // INSERT to seo_thumbnail_candidates so the select endpoint can
      // bump weights of all 3 references when Karen picks this candidate.
      // Without this row the select feedback loop is dead code.
      const { data: row, error: insErr } = await supabase
        .from('seo_thumbnail_candidates')
        .insert({
          job_id: jobId,
          image_url: imageUrl,
          layout_type: references[i].suggested_layout,
          thumbnail_text: texts[i],
          pattern_id: references[i].id,
          reference_video_ids: referenceVideoIds,
        })
        .select('id')
        .single();

      if (insErr) {
        console.error(`[Thumbnail Generator] Insert candidate #${i} failed:`, insErr);
      }

      candidates.push({
        id: row?.id,
        imageUrl,
        thumbnailText: texts[i],
        patternId: references[i].id,
        referenceVideoIds,
      });

      console.log(`[Thumbnail Generator] Candidate #${i} complete: ${imageUrl} (id=${row?.id})`);
    } catch (err) {
      console.error(`[Thumbnail Generator] Candidate #${i} composite/upload failed:`, err);
      // Continue with remaining candidates
    }
  }

  if (candidates.length === 0) {
    throw new Error('All thumbnail candidates failed to generate');
  }

  progress(100, 'thumbnail_done', `完成！生成了 ${candidates.length} 個縮圖候選`);
  console.log(`[Thumbnail Generator] Done — ${candidates.length} candidates generated for job ${jobId}`);

  return { candidates };
}
