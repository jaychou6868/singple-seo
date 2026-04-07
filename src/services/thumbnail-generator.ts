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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { removeBackground as imglyRemoveBackground } from '@imgly/background-removal-node';
import { beautifyFace } from './face-beautify.js';

// ── Bundled font ─────────────────────────────────────────────
//
// Karen 2026-04-07 v29: Zeabur Linux container has no CJK fonts so SVG
// text rendered as 豆腐 (□). Bundle Noto Sans TC Black with the repo
// and embed it as base64 in every SVG via @font-face data URL.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let CJK_FONT_BASE64 = '';
try {
  // dist/services/thumbnail-generator.js → ../../assets/fonts/...
  const fontPath = path.resolve(__dirname, '../../assets/fonts/NotoSansTC-Black.ttf');
  CJK_FONT_BASE64 = fs.readFileSync(fontPath).toString('base64');
  console.log(`[Thumbnail Generator] Loaded CJK font from ${fontPath} (${CJK_FONT_BASE64.length} bytes b64)`);
} catch (err) {
  console.error('[Thumbnail Generator] Failed to load CJK font — text will fall back to system fonts:', err);
}

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
  text_layout_hint?: 'single' | 'split' | 'top_banner' | null;  // v32b
}

interface ThumbnailCandidate {
  id: string | undefined;        // seo_thumbnail_candidates.id (for select feedback)
  imageUrl: string;
  thumbnailText: string;
  patternId: string | null;
  referenceVideoIds: string[];
}

// ── v32a: split-aware text structure ───────────────────────
//
// Karen 2026-04-07 (v32 影視颶風 Pattern A study): the most distinctive
// 影視颶風 layout splits the title into a big primary keyword + a
// smaller secondary modifier on the *opposite side of the figure*
// (e.g. iPhone | Air, 鎖喉 | 真相). To support that we have to stop
// treating the thumbnail title as a single string. ThumbnailText is
// the new contract: every render flows through it, single-block titles
// just leave secondary undefined and the renderer falls back to v31
// behaviour.
interface ThumbnailText {
  primary: string;
  secondary?: string;
  // Which block carries the visual emphasis (yellow fill in v32c).
  // 'primary' is the default; for 揭密型/痛點型 Sophia copy the
  // secondary block is the punchline so emphasis flips to 'secondary'.
  emphasisOn?: 'primary' | 'secondary';
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
    .select('id, channel_source, reference_image_b64, style_description, suggested_layout, video_id, weight, text_layout_hint')
    .eq('channel_source', 'lks')
    .not('reference_image_b64', 'is', null)
    .order('learned_at', { ascending: false })
    .limit(15);

  const { data: mrbeast } = await supabase
    .from('seo_thumbnail_patterns')
    .select('id, channel_source, reference_image_b64, style_description, suggested_layout, video_id, weight, text_layout_hint')
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

// ── v32b: Sophia 三句型自動拆字 ──────────────────────────
//
// Splits the 2-4 char thumbnail title into a primary + secondary block
// based on which Sophia句型 it matches. The split decides where the
// visual emphasis lands (揭密型 / 痛點型 → punchline is the second block;
// 反差數字型 → number leads).
//
// Guards (from v32 adversarial review):
//   - both blocks must have ≥1 char
//   - block char-count ratio must be ≤ 2.5:1 (otherwise font sizes would
//     blow out — single-block fallback is safer)
//   - if no rule matches, fall through to a single block (v31 behaviour)
function splitTitleByPattern(text: string): ThumbnailText {
  const cleaned = text.replace(/\s/g, '');
  const chars = [...cleaned];

  // Too short to split — keep as single block.
  if (chars.length < 3) return { primary: cleaned };

  // Helper: build a split if it passes the ≤2.5 ratio guard.
  const tryBuild = (
    a: string,
    b: string,
    emphasisOn: 'primary' | 'secondary',
  ): ThumbnailText | null => {
    const al = [...a].length;
    const bl = [...b].length;
    if (al === 0 || bl === 0) return null;
    const ratio = Math.max(al, bl) / Math.min(al, bl);
    if (ratio > 2.5) return null;
    return { primary: a, secondary: b, emphasisOn };
  };

  // 反差數字型: starts with digit(s) + 秒/分/招/天 → emphasis on number (primary)
  const numMatch = cleaned.match(/^(\d+\s*[秒分招天日])(.+)$/);
  if (numMatch) {
    const split = tryBuild(numMatch[1].replace(/\s/g, ''), numMatch[2], 'primary');
    if (split) return split;
  }

  // 痛點型: ends with '?' or '？' → split off the punctuation block,
  // emphasis on the punchline (secondary)
  const punctMatch = cleaned.match(/^(.+?)([^?？]*[?？])$/);
  if (punctMatch && [...punctMatch[1]].length > 0 && [...punctMatch[2]].length > 0) {
    const split = tryBuild(punctMatch[1], punctMatch[2], 'secondary');
    if (split) return split;
  }

  // 揭密型 / 一般 4 字: split in half (2+2 or 2+3 etc.), emphasis on
  // secondary (the reveal). The ratio guard above will reject 1+3 splits
  // for very short titles.
  const half = Math.ceil(chars.length / 2);
  const firstHalf = chars.slice(0, half).join('');
  const secondHalf = chars.slice(half).join('');
  const split = tryBuild(firstHalf, secondHalf, 'secondary');
  if (split) return split;

  // Fall through: single block.
  return { primary: cleaned };
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
  _thumbnailText: string,
  title: string,
  _layoutType: string,
): string {
  // Karen 2026-04-07 v27: Gemini ignored every text-position prompt
  // we wrote and rendered text across the full width every time. Stop
  // asking Gemini to render text. Instead it generates a CLEAN background
  // (no text, no people) and Sharp/SVG composites the text afterward
  // with pixel-perfect placement.
  return `Generate a YouTube thumbnail BACKGROUND image at 1280x720 pixels (16:9).

## Style Reference
Look at the reference thumbnail attached. Match its visual language:
- REAL photographic scene or real object (NOT illustrated/decorative)
- ONE clear focal point per image
- Strong contrast color palette
- Mood: confrontational, documentary, cinematic

Style notes: "${reference.style_description}"

## What to draw
A real-scene background related to singing tutorials. Pick ONE scene
element, not a collage:
- A close-up of a studio microphone with warm lighting
- A vocal recording booth with acoustic panels and dramatic light
- Sheet music on a stand under a spotlight
- A sound mixer console with backlit faders
- A vintage radio in dramatic lighting
- A pop filter and shock mount in close-up

Be CREATIVE — pick something different from the reference and from
typical stock photos. Same documentary spirit, different scene.

## Color palette (vary across attempts)
Pick ONE of these palettes (be diverse):
- Deep blue + warm cream/gold accents
- Warm cream + deep red accents
- Dark teal + amber spotlight
- Charcoal + electric yellow accents
- Deep maroon + cream

AVOID: purple, pink, neon, gradient pastels.

## Video Context
"${title}" — singing tutorial for 簡單歌唱 Singple. channel.

## ABSOLUTE RULES
- DO NOT draw any people, faces, hands, body parts, or human figures
- DO NOT add ANY text, characters, words, captions, or letters
- DO NOT add decorative graphics (arrows, sparkles, emoji, music notes, glows)
- DO NOT make it look like a stock illustration or advertisement banner
- The image must be a clean photographic scene with NO text and NO people
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

  // Karen 2026-04-07 v22: removed the ghost-person detect-retry loop —
  // it added 3x latency and pushed total generation past Zeabur's 100s
  // proxy timeout. With imgly cutout extending past canvas edges and
  // covering ~70% width, any Gemini-drawn ghost person in the
  // background is barely visible. Single attempt is enough.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const base64Image = await callGeminiImageMultiRef(prompt, referenceImages, 0.95);
      const buffer = Buffer.from(base64Image, 'base64');
      const resized = await sharp(buffer)
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'cover' })
        .jpeg({ quality: 95 })
        .toBuffer();
      return resized;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Thumbnail Generator] Background gen attempt ${attempt + 1} failed for #${candidateIndex}: ${lastError.message}`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }

  throw lastError || new Error(`Background generation failed for candidate #${candidateIndex}`);
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
 * Karen 2026-04-07 (影視颶風 study): looked at multiple LKs thumbnails —
 * the person is ALWAYS half-cut by the canvas edge. The head/shoulders
 * extend OUT OF the canvas top/sides, so the cutout never floats with
 * a visible bottom seam. To match this:
 *   - personWidth = 70% of canvas (896px) — chunky like LKs
 *   - personHeight = 110% of canvas (792px) — over-fills the slot
 *   - Anchor from one corner (bottom-left or bottom-right) so the
 *     opposite top/side edge gets cropped by the canvas bound
 *   - cover-fit + 'left top' or 'right top' makes the cover crop the
 *     opposite edge cleanly
 *
 * The person is then composited so part of them naturally extends
 * past the canvas edges — exactly the LKs / 影視颶風 look.
 */
function getPersonPlacement(layoutType: string): {
  personWidth: number;
  personHeight: number;
  personX: number;
  personY: number;
  resizePosition: string;
} {
  // Karen 2026-04-07 v26: removed over-extend. person exactly fills
  // canvas height (720) and 50% width (640). Cover-fit + position 'top'
  // pins head to canvas top with body extending down. No cropping math,
  // no negative coordinates, no floating-head effect because the
  // cutout's top edge IS the canvas top edge.
  const personWidth = Math.round(THUMBNAIL_WIDTH * 0.5);    // 640
  const personHeight = THUMBNAIL_HEIGHT;                      // 720

  switch (layoutType) {
    case 'face_left_text_right':
    case 'full_frame_overlay':
      return {
        personWidth,
        personHeight,
        personX: 0,
        personY: 0,
        resizePosition: 'left top',
      };

    case 'face_center_text_top':
      // Slightly narrower so the text on top has clearance
      return {
        personWidth: Math.round(THUMBNAIL_WIDTH * 0.45),
        personHeight,
        personX: Math.round((THUMBNAIL_WIDTH - THUMBNAIL_WIDTH * 0.45) / 2),
        personY: 0,
        resizePosition: 'top',
      };

    case 'split_around_face': {
      // v32b: 影視颶風 Pattern A — figure dead-center, text wraps both
      // sides at shoulder height. Person slot is narrower (42%) than the
      // top-banner case so primary/secondary blocks have real estate.
      const w = Math.round(THUMBNAIL_WIDTH * 0.42);
      return {
        personWidth: w,
        personHeight,
        personX: Math.round((THUMBNAIL_WIDTH - w) / 2),
        personY: 0,
        resizePosition: 'top',
      };
    }

    case 'face_right_text_left':
    default:
      return {
        personWidth,
        personHeight,
        personX: THUMBNAIL_WIDTH - personWidth,
        personY: 0,
        resizePosition: 'right top',
      };
  }
}

// ── v32a/b/c: SVG text overlay ──────────────────────────────
//
// Karen 2026-04-07 v27: Gemini rendered text across full width every
// time, so it always overlapped the person. Sharp/SVG renders the text
// exactly where we want it.
//
// v32 changes:
//   - Accepts ThumbnailText {primary, secondary?, emphasisOn?} instead of
//     a single string. Single-block titles (secondary undefined) render
//     identically to v31.
//   - New layout `split_around_face` puts primary/secondary blocks at
//     shoulder height on opposite sides of the actual person bbox.
//   - emphasis block renders in #FFD60A yellow when the background under
//     it is dark enough; otherwise falls back to white (luminance guard).

const SPLIT_PERSON_BBOX_FALLBACK = { left: 540, right: 740, top: 0, bottom: THUMBNAIL_HEIGHT };

interface PersonBBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface BuildOverlayOpts {
  layoutType: string;
  personBBox?: PersonBBox;            // v32b: actual cutout bbox in canvas space
}

function buildTextOverlaySvg(text: ThumbnailText, opts: BuildOverlayOpts): Buffer {
  const W = THUMBNAIL_WIDTH;
  const H = THUMBNAIL_HEIGHT;
  const { layoutType } = opts;

  // ── v32b: split_around_face dual-block path ────────────────
  if (layoutType === 'split_around_face' && text.secondary) {
    return buildSplitOverlaySvg(text, opts);
  }

  // ── Single-block path (v31 behaviour, layout-aware area) ───
  let textCenterX: number;
  let textWidth: number;
  if (layoutType === 'face_left_text_right') {
    textCenterX = W * 0.75;        // 960 — center of right half
    textWidth = W * 0.5 - 60;      // 580 px usable width
  } else if (layoutType === 'face_center_text_top') {
    textCenterX = W / 2;
    textWidth = W * 0.9;
  } else {
    // face_right_text_left or default → person on RIGHT, text on LEFT
    textCenterX = W * 0.25;
    textWidth = W * 0.5 - 60;
  }

  const chars = [...text.primary];
  const charCount = chars.length;

  // For 2-4 characters: render in 2x2 grid for max readability at small sizes
  // For 1 character: single huge centered
  // For 3 chars: 2 top + 1 bottom centered
  let lines: string[][];
  if (charCount === 1) {
    lines = [[chars[0]]];
  } else if (charCount === 2) {
    lines = [[chars[0], chars[1]]];
  } else if (charCount === 3) {
    lines = [[chars[0], chars[1]], [chars[2]]];
  } else {
    lines = [[chars[0], chars[1]], [chars[2], chars[3]]];
  }

  const maxCharsPerLine = Math.max(...lines.map(l => l.length));
  const fontSize = Math.min(220, Math.round((textWidth * 0.85) / maxCharsPerLine));
  const lineHeight = Math.round(fontSize * 1.05);
  const totalTextHeight = lines.length * lineHeight;
  const startY = Math.round((H - totalTextHeight) / 2 + fontSize * 0.85);

  const textElements: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineWidth = line.length * fontSize;
    const lineStartX = Math.round(textCenterX - lineWidth / 2);
    const y = startY + li * lineHeight;
    for (let ci = 0; ci < line.length; ci++) {
      const x = lineStartX + ci * fontSize;
      textElements.push(`<text class="t" x="${x}" y="${y}">${escapeXml(line[ci])}</text>`);
    }
  }

  return wrapSvg(W, H, fontSize, textElements.join('\n  '));
}

/**
 * v32b: Render primary + secondary blocks on opposite sides of the
 * person bbox at shoulder height.
 *
 * Routing rules (from v32 Party Mode round 14 + adversarial #9):
 *   - emphasisOn === 'primary'   → primary on the right (visual gravity)
 *   - emphasisOn === 'secondary' → primary on the left  (so secondary lands on the right)
 *   - undefined                  → primary on the left (deterministic default)
 *
 * The actual person bbox (from sharp.trim()) is used to find the empty
 * gutter widths on each side, NOT the placement container — this avoids
 * the v21-v25 floating-anchor class of bug (adversarial #2).
 */
function buildSplitOverlaySvg(text: ThumbnailText, opts: BuildOverlayOpts): Buffer {
  const W = THUMBNAIL_WIDTH;
  const H = THUMBNAIL_HEIGHT;
  const bbox = opts.personBBox ?? SPLIT_PERSON_BBOX_FALLBACK;

  const padding = 30;
  const leftGutterWidth = Math.max(0, bbox.left - padding);
  const rightGutterWidth = Math.max(0, W - bbox.right - padding);

  // Decide which block goes left vs right.
  let primaryOnRight: boolean;
  if (text.emphasisOn === 'primary') {
    primaryOnRight = true;        // emphasis follows visual gravity (right)
  } else if (text.emphasisOn === 'secondary') {
    primaryOnRight = false;       // secondary (the punchline) on the right
  } else {
    primaryOnRight = false;       // default: primary leads (left)
  }

  const primaryGutter = primaryOnRight ? rightGutterWidth : leftGutterWidth;
  const secondaryGutter = primaryOnRight ? leftGutterWidth : rightGutterWidth;
  const primaryCenterX = primaryOnRight
    ? bbox.right + padding + primaryGutter / 2
    : padding + primaryGutter / 2;
  const secondaryCenterX = primaryOnRight
    ? padding + secondaryGutter / 2
    : bbox.right + padding + secondaryGutter / 2;

  // Font sizing — primary fills its gutter, secondary is 0.65x.
  const primaryChars = [...text.primary];
  const secondaryChars = [...(text.secondary || '')];

  const primaryFontSize = Math.min(
    240,
    Math.max(
      48,
      Math.round((primaryGutter * 0.9) / Math.max(1, primaryChars.length)),
    ),
  );
  const secondaryFontSize = Math.max(48, Math.round(primaryFontSize * 0.62));

  // Vertical anchor: shoulder height ≈ 0.42 H. Both blocks share Y so the
  // visual line is consistent across the figure.
  const shoulderY = Math.round(H * 0.42);

  // Both blocks render in white. v32c (follow-up commit) adds the
  // emphasis-yellow path with a background-luminance guard.
  const primaryFill = '#FFFFFF';
  const secondaryFill = '#FFFFFF';

  const renderBlock = (
    chars: string[],
    centerX: number,
    fontSize: number,
    fill: string,
    yOffset = 0,
  ): string => {
    if (chars.length === 0) return '';
    // 1 char or 2 char: single line. ≥3: 2 per line, max 2 lines (rare for split).
    const lines: string[][] = [];
    if (chars.length <= 2) {
      lines.push(chars);
    } else {
      lines.push(chars.slice(0, 2));
      lines.push(chars.slice(2));
    }
    const lineHeight = Math.round(fontSize * 1.05);
    const totalH = lines.length * lineHeight;
    // Center each line vertically around shoulderY.
    const startY = Math.round(shoulderY - totalH / 2 + fontSize * 0.85) + yOffset;
    const els: string[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineW = line.length * fontSize;
      const lineStartX = Math.round(centerX - lineW / 2);
      const y = startY + li * lineHeight;
      for (let ci = 0; ci < line.length; ci++) {
        const x = lineStartX + ci * fontSize;
        els.push(
          `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${fill}" stroke="#000000" stroke-width="${Math.round(fontSize * 0.08)}" paint-order="stroke fill">${escapeXml(line[ci])}</text>`,
        );
      }
    }
    return els.join('\n  ');
  };

  const primarySvg = renderBlock(primaryChars, primaryCenterX, primaryFontSize, primaryFill);
  const secondarySvg = renderBlock(secondaryChars, secondaryCenterX, secondaryFontSize, secondaryFill);

  return wrapSvg(W, H, primaryFontSize, `${primarySvg}\n  ${secondarySvg}`);
}

/**
 * Build the wrapping <svg> with the bundled CJK font @font-face.
 * stroke-width is referenced from `defs` for the .t class used by
 * the single-block path; the split-block path inlines its own
 * stroke-width per text element.
 */
function wrapSvg(width: number, height: number, defaultFontSize: number, body: string): Buffer {
  const fontFaceCss = CJK_FONT_BASE64
    ? `@font-face {
        font-family: 'NotoTC';
        src: url('data:font/ttf;base64,${CJK_FONT_BASE64}') format('truetype');
      }`
    : '';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" font-family="Noto Sans CJK TC, Noto Sans CJK SC, NotoTC, PingFang TC, sans-serif" font-weight="900">
  <defs>
    <style>
      ${fontFaceCss}
      .t {
        font-family: "Noto Sans CJK TC", "Noto Sans CJK SC", 'NotoTC', "PingFang TC", sans-serif;
        font-size: ${defaultFontSize}px;
        font-weight: 900;
        fill: #ffffff;
        stroke: #000000;
        stroke-width: ${Math.round(defaultFontSize * 0.08)};
        paint-order: stroke fill;
      }
    </style>
  </defs>
  ${body}
</svg>`;

  return Buffer.from(svg);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  } as Record<string, string>)[c]);
}

/**
 * Add a white outline (stroke) around the person cutout.
 *
 * Implementation: extract alpha → blur → threshold → use as the alpha
 * channel of a white layer → composite original cutout on top. All
 * heavy lifting is done by Sharp's C++ blur (vs slow JS pixel loops).
 *
 * The blur sigma controls the stroke width: sigma ~ stroke-radius / 2.
 */
async function addWhiteStroke(cutoutPng: Buffer, strokeRadius = 6): Promise<Buffer> {
  const meta = await sharp(cutoutPng).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const sigma = Math.max(1, strokeRadius / 1.5);

  // Extract alpha channel as grayscale, blur it (creates a halo), then
  // threshold so the halo becomes opaque pixels at full alpha.
  const dilatedAlphaPng = await sharp(cutoutPng)
    .extractChannel('alpha')
    .blur(sigma)
    .threshold(40)
    .png()
    .toBuffer();

  // Create a pure white layer at the same dimensions
  const whiteLayer = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  // Apply the dilated alpha mask to the white layer (joinChannel)
  const whiteWithDilatedAlpha = await sharp(whiteLayer)
    .joinChannel(dilatedAlphaPng)
    .png()
    .toBuffer();

  // Composite original cutout on top of white-with-dilated-alpha
  return sharp(whiteWithDilatedAlpha)
    .composite([{ input: cutoutPng, top: 0, left: 0, blend: 'over' }])
    .png()
    .toBuffer();
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

  // Karen 2026-04-07 Zeabur 502: imgly + 1920×1080 + parallel Gemini =
  // OOM/timeout. Downsize to 960×540 (¼ pixels) before imgly. We don't
  // lose quality because the cutout is then composited into a 640px-wide
  // slot anyway.
  const downsized = await sharp(inputBuffer)
    .resize(960, 540, { fit: 'inside' })
    .jpeg({ quality: 92 })
    .toBuffer();

  // imgly internally calls Blob([buf]) without type when given a Buffer,
  // producing empty mime → "Unsupported format" error. Wrap explicitly.
  // Use node:buffer Blob (not global) for cross-runtime safety on Zeabur.
  const { Blob: NodeBlob } = await import('node:buffer');
  // Convert Buffer to Uint8Array view to satisfy NodeBlob's BlobPart type
  // (newer @types/node Buffer has a wider ArrayBufferLike that doesn't fit)
  const inputBlob = new NodeBlob([new Uint8Array(downsized)], { type: 'image/jpeg' });

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

  // Karen 2026-04-07 v18 fix: imgly sometimes leaves false-positive
  // alpha clusters disconnected from the main person. Keep only the
  // largest connected component (the person) and zero-alpha everything
  // else, so floating debris never makes it into the composited output.
  keepLargestComponent(px, info.width, info.height);

  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Mutate the RGBA pixel buffer to zero-alpha all pixels not in the
 * largest connected alpha component (4-connected flood fill via
 * iterative stack).
 */
function keepLargestComponent(px: Buffer, width: number, height: number): void {
  const total = width * height;
  // visited / label: 0=unvisited, otherwise component id
  const labels = new Int32Array(total);
  const sizes: number[] = [0]; // sizes[0] unused
  let nextLabel = 1;

  // BFS / flood fill
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (labels[i] !== 0) continue;
      const alphaIdx = i * 4 + 3;
      if (px[alphaIdx] === 0) continue;

      // Start a new component
      const label = nextLabel++;
      let size = 0;
      stack.push(i);
      labels[i] = label;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        size++;
        const cy = Math.floor(cur / width);
        const cx = cur - cy * width;
        // 4 neighbors
        const neighbors = [
          cx > 0          ? cur - 1 : -1,
          cx < width - 1  ? cur + 1 : -1,
          cy > 0          ? cur - width : -1,
          cy < height - 1 ? cur + width : -1,
        ];
        for (const n of neighbors) {
          if (n < 0) continue;
          if (labels[n] !== 0) continue;
          if (px[n * 4 + 3] === 0) continue;
          labels[n] = label;
          stack.push(n);
        }
      }
      sizes.push(size);
    }
  }

  if (sizes.length <= 1) return; // no components

  // Find largest
  let maxLabel = 1;
  for (let l = 2; l < sizes.length; l++) {
    if (sizes[l] > sizes[maxLabel]) maxLabel = l;
  }

  // Zero alpha for any pixel not in the largest component
  let killed = 0;
  for (let i = 0; i < total; i++) {
    if (labels[i] !== 0 && labels[i] !== maxLabel) {
      px[i * 4 + 3] = 0;
      killed++;
    }
  }
  console.log(`[Thumbnail Generator] keepLargestComponent: ${sizes.length - 1} components, kept label ${maxLabel} (${sizes[maxLabel]} px), killed ${killed} px in ${sizes.length - 2} other components`);
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
 * Sample the dominant color of the background, return as { r, g, b }.
 * Used to color-match the person cutout to the background lighting.
 */
async function sampleBackgroundColor(bgBuffer: Buffer): Promise<{ r: number; g: number; b: number }> {
  // Sharp's stats() returns per-channel mean
  const { channels } = await sharp(bgBuffer).stats();
  return {
    r: Math.round(channels[0].mean),
    g: Math.round(channels[1].mean),
    b: Math.round(channels[2].mean),
  };
}

/**
 * Compute the person cutout's average opaque color (skin/clothing tone)
 * and return how much warm/cool tint to apply to match the background.
 */
async function colorMatchCutoutToBackground(cutoutPng: Buffer, bgRgb: { r: number; g: number; b: number }): Promise<Buffer> {
  // Get cutout's average opaque color
  const { data, info } = await sharp(cutoutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  }
  if (count === 0) return cutoutPng;

  const cutR = rSum / count;
  const cutG = gSum / count;
  const cutB = bSum / count;

  // Compute warmth difference: positive = bg is warmer (more red/yellow)
  // We blend ~25% of the difference into the cutout to match the bg lighting
  // without losing the person's natural skin tone.
  const blendStrength = 0.25;
  const targetR = cutR + (bgRgb.r - cutR) * blendStrength;
  const targetG = cutG + (bgRgb.g - cutG) * blendStrength;
  const targetB = cutB + (bgRgb.b - cutB) * blendStrength;

  // Convert to per-channel multipliers (avoid divide-by-zero)
  const mulR = cutR > 5 ? targetR / cutR : 1;
  const mulG = cutG > 5 ? targetG / cutG : 1;
  const mulB = cutB > 5 ? targetB / cutB : 1;

  // Apply per-channel scale to opaque pixels only (preserve alpha)
  const px = Buffer.from(data);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 0) {
      px[i]     = Math.min(255, Math.round(px[i]     * mulR));
      px[i + 1] = Math.min(255, Math.round(px[i + 1] * mulG));
      px[i + 2] = Math.min(255, Math.round(px[i + 2] * mulB));
    }
  }

  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Composite a pre-cut-out person (PNG with alpha) onto the design background.
 *
 * Karen 2026-04-07 v28 follow-up: cutout had visible "拼接感" because the
 * person was lit by their own room (cool/blue) while the background was
 * warm studio lighting. Color-match the cutout to the background's
 * dominant tone before compositing so they look like one scene.
 *
 * v32: takes ThumbnailText (primary + optional secondary). For
 * split_around_face the actual person bbox is computed from the resized
 * cutout (not the placement container) so text anchors to real shoulder
 * edges, not invisible padding (adversarial review #2).
 */
async function compositeCandidate(
  designBackground: Buffer,
  personCutoutPng: Buffer,
  layoutType: string,
  thumbnailText: ThumbnailText,
): Promise<Buffer> {
  const placement = getPersonPlacement(layoutType);

  // Trim transparent margins so the cutout bbox is tight on the person
  let trimmedCutout: Buffer;
  try {
    trimmedCutout = await sharp(personCutoutPng)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .png()
      .toBuffer();
  } catch {
    trimmedCutout = personCutoutPng;
  }

  // Sample background dominant color and shift cutout toward it
  const bgRgb = await sampleBackgroundColor(designBackground);
  const colorMatchedCutout = await colorMatchCutoutToBackground(trimmedCutout, bgRgb);
  console.log(`[Thumbnail Generator] color match: bg=(${bgRgb.r},${bgRgb.g},${bgRgb.b})`);

  // Contain-fit: person is fully visible at native aspect ratio. Sharp
  // returns the actual content size (no padding) when fit='inside'.
  const personResized = await sharp(colorMatchedCutout)
    .resize(placement.personWidth, placement.personHeight, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const resizedMeta = await sharp(personResized).metadata();
  const rw = resizedMeta.width || placement.personWidth;
  const rh = resizedMeta.height || placement.personHeight;

  // Anchor the resized cutout to one of the canvas corners. This keeps
  // one edge of the cutout flush against the canvas edge → no seam.
  let finalLeft: number;
  let finalTop: number;
  switch (layoutType) {
    case 'face_left_text_right':
    case 'full_frame_overlay':
      finalLeft = 0;
      finalTop = THUMBNAIL_HEIGHT - rh;
      break;
    case 'face_center_text_top':
    case 'split_around_face':
      // Bottom-CENTER for both centered layouts.
      finalLeft = Math.round((THUMBNAIL_WIDTH - rw) / 2);
      finalTop = THUMBNAIL_HEIGHT - rh;
      break;
    case 'face_right_text_left':
    default:
      finalLeft = THUMBNAIL_WIDTH - rw;
      finalTop = THUMBNAIL_HEIGHT - rh;
      break;
  }

  // v32b: actual visible person bbox in canvas coordinates. The trim()
  // above already removed transparent margins so resized cutout's
  // (rw × rh) IS the visible person — finalLeft/finalTop give where it
  // sits on the 1280×720 canvas.
  const personBBox: PersonBBox = {
    left: finalLeft,
    right: finalLeft + rw,
    top: finalTop,
    bottom: finalTop + rh,
  };

  // Karen 2026-04-07 v20 feedback: liked the white outline.
  const personWithStroke = await addWhiteStroke(personResized, 6);

  console.log(`[Thumbnail Generator] composite layout=${layoutType} slot=${placement.personWidth}×${placement.personHeight} resized=${rw}×${rh} placed=(${finalLeft},${finalTop}) text=primary:${thumbnailText.primary}${thumbnailText.secondary ? '/' + thumbnailText.secondary : ''}`);

  // Composite person on background — text overlay goes on top after.
  const withPerson = await sharp(designBackground)
    .composite([{
      input: personWithStroke,
      left: finalLeft,
      top: finalTop,
      blend: 'over',
    }])
    .png()
    .toBuffer();

  const textSvg = buildTextOverlaySvg(thumbnailText, {
    layoutType,
    personBBox,
  });
  return sharp(withPerson)
    .composite([{ input: textSvg, top: 0, left: 0 }])
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
  // v32: smoke-test path. When true, skip the seo_thumbnail_candidates
  // INSERT (which would otherwise FK-fail without a real seo_jobs row)
  // and skip the select-feedback weight bumps. Returns inline base64
  // data URLs only.
  dryRun?: boolean;
}): Promise<{
  candidates: ThumbnailCandidate[];
}> {
  const { jobId, frames, title, videoSummary, videoType, sendProgress, dryRun } = params;
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
    // Run background removal in parallel with design generation.
    // Karen 2026-04-07: retry imgly up to 2 times. If it still fails,
    // throw — we never want to show the raw frame as a "cutout" because
    // it produces visible米色方框 in the final composite. Better to fail
    // the whole generation than ship that.
    (async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await removeBackgroundFromFrame(bestFrame);
        } catch (err) {
          lastErr = err;
          console.warn(`[Thumbnail Generator] imgly removal attempt ${attempt + 1} failed:`, err);
          await new Promise(r => setTimeout(r, 500));
        }
      }
      throw lastErr;
    })(),
  ]);

  // No raw-frame fallback — if imgly failed 3x, the Promise.all rejected
  // and we're never here. personCutoutResult is always a real cutout.
  const personCutoutRaw = personCutoutResult;

  // Beautify: Gemini bbox + Sharp local blur on face skin only
  // (eyes/nose/mouth re-overlaid from original to stay sharp).
  // POC verified this preserves identity + expression while smoothing skin.
  // If Gemini bbox call fails, beautifyFace returns the input unchanged.
  const personCutoutPng = await beautifyFace(personCutoutRaw, 'subtle');
  console.log(`[Thumbnail Generator] Person cutout ready (${personCutoutResult ? 'bg removed' : 'raw fallback'}, beautify=subtle)`);

  // ── Step 4: Composite person + background ────────────────
  progress(65, 'thumbnail_composite', '合成人物與背景...');

  const compositeErrors: string[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const designResult = designResults[i];

    if (designResult.status === 'rejected') {
      const reason = designResult.reason instanceof Error ? designResult.reason.message : String(designResult.reason);
      console.error(`[Thumbnail Generator] Candidate #${i} design failed: ${reason}`);
      compositeErrors.push(`#${i} design: ${reason}`);
      continue;
    }

    const designBackground = designResult.value;

    try {
      // v32a/b: split the text into primary/secondary blocks via Sophia
      // 三句型 patterns. Single-block titles fall through unchanged.
      const thumbnailText = splitTitleByPattern(texts[i]);

      // v32b: resolve final layout. When the reference hints split AND
      // the title actually split into two blocks, force split_around_face
      // (Pattern A 影視颶風). Otherwise honour the reference's
      // suggested_layout from v31.
      const referenceLayout = references[i].suggested_layout || 'face_right_text_left';
      const wantsSplit = references[i].text_layout_hint === 'split';
      const layoutType = (wantsSplit && thumbnailText.secondary)
        ? 'split_around_face'
        : referenceLayout;

      const composited = await compositeCandidate(
        designBackground,
        personCutoutPng,
        layoutType,
        thumbnailText,
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
      // v32: dryRun (smoke test) skips this — there's no real seo_jobs
      // row backing the FK and we don't want pollution.
      let insertedId: string | undefined;
      if (!dryRun) {
        const { data: row, error: insErr } = await supabase
          .from('seo_thumbnail_candidates')
          .insert({
            job_id: jobId,
            image_url: imageUrl,
            layout_type: layoutType,
            thumbnail_text: texts[i],
            text_primary: thumbnailText.primary,
            text_secondary: thumbnailText.secondary ?? null,
            text_layout_used: layoutType,
            pattern_id: references[i].id,
            reference_video_ids: referenceVideoIds,
          })
          .select('id')
          .single();

        if (insErr) {
          console.error(`[Thumbnail Generator] Insert candidate #${i} failed:`, insErr);
        }
        insertedId = row?.id;
      }

      candidates.push({
        id: insertedId,
        imageUrl,
        thumbnailText: texts[i],
        patternId: references[i].id,
        referenceVideoIds,
      });

      console.log(`[Thumbnail Generator] Candidate #${i} complete (layout=${layoutType}, dryRun=${!!dryRun})`);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${(err.stack || '').split('\n').slice(0, 5).join('\n')}` : String(err);
      console.error(`[Thumbnail Generator] Candidate #${i} composite/upload failed:`, msg);
      compositeErrors.push(`#${i} composite: ${msg}`);
    }
  }

  if (candidates.length === 0) {
    throw new Error('All thumbnail candidates failed to generate. Errors:\n' + compositeErrors.join('\n---\n'));
  }

  progress(100, 'thumbnail_done', `完成！生成了 ${candidates.length} 個縮圖候選`);
  console.log(`[Thumbnail Generator] Done — ${candidates.length} candidates generated for job ${jobId}`);

  return { candidates };
}
