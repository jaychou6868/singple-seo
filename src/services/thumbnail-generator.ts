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

interface ThumbnailPattern {
  id: string;
  layout_type: string;           // face_right_text_left, face_left_text_right, etc.
  color_scheme: string;          // red, dark_blue, yellow_on_dark, etc.
  text_style: string;            // bold_outline, shadow, plain_bold, gradient
  emotional_hook: string;        // curiosity_gap, loss_aversion, fomo, etc.
  weight: number;
  [key: string]: unknown;
}

interface ThumbnailCandidate {
  imageUrl: string;
  thumbnailText: string;
  patternId: string | null;
}

interface ProgressCallback {
  (progress: number, stage: string, detail: string): void;
}

// ── Cold Start Defaults ────────────────────────────────────

const DEFAULT_PATTERNS: ThumbnailPattern[] = [
  {
    id: 'default_1',
    layout_type: 'face_right_text_left',
    color_scheme: 'red',
    text_style: 'bold_outline',
    emotional_hook: 'curiosity_gap',
    weight: 1.0,
  },
  {
    id: 'default_2',
    layout_type: 'face_left_text_right',
    color_scheme: 'dark_blue',
    text_style: 'shadow',
    emotional_hook: 'loss_aversion',
    weight: 1.0,
  },
  {
    id: 'default_3',
    layout_type: 'full_frame_overlay',
    color_scheme: 'semi_transparent_black',
    text_style: 'plain_bold',
    emotional_hook: 'fomo',
    weight: 1.0,
  },
  {
    id: 'default_4',
    layout_type: 'face_right_text_left',
    color_scheme: 'yellow_on_dark',
    text_style: 'bold_outline',
    emotional_hook: 'transformation',
    weight: 1.0,
  },
  {
    id: 'default_5',
    layout_type: 'face_center_text_top',
    color_scheme: 'gradient_purple_blue',
    text_style: 'gradient',
    emotional_hook: 'authority',
    weight: 1.0,
  },
  {
    id: 'default_6',
    layout_type: 'full_frame_overlay',
    color_scheme: 'red_accent',
    text_style: 'bold_outline',
    emotional_hook: 'social_proof',
    weight: 1.0,
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

async function selectPatterns(): Promise<ThumbnailPattern[]> {
  const { data: patterns } = await supabase
    .from('seo_thumbnail_patterns')
    .select('*')
    .order('weight', { ascending: false });

  const pool = (patterns && patterns.length >= CANDIDATE_COUNT) ? patterns : DEFAULT_PATTERNS;
  console.log(`[Thumbnail Generator] Pattern source: ${patterns && patterns.length >= CANDIDATE_COUNT ? 'knowledge base' : 'cold start defaults'} (${pool.length} available)`);

  // Select 3 patterns with diverse layout_type
  const selected: ThumbnailPattern[] = [];
  const usedLayouts = new Set<string>();
  const remaining = [...pool];

  // First pass: pick one of each unique layout_type
  for (const pattern of remaining) {
    if (selected.length >= CANDIDATE_COUNT) break;
    if (!usedLayouts.has(pattern.layout_type)) {
      selected.push(pattern);
      usedLayouts.add(pattern.layout_type);
    }
  }

  // Second pass: fill remaining slots with highest-weight unused patterns
  if (selected.length < CANDIDATE_COUNT) {
    const selectedIds = new Set(selected.map(s => s.id));
    for (const pattern of remaining) {
      if (selected.length >= CANDIDATE_COUNT) break;
      if (!selectedIds.has(pattern.id)) {
        selected.push(pattern);
      }
    }
  }

  return selected.slice(0, CANDIDATE_COUNT);
}

// ── Step 2: Generate Thumbnail Text ────────────────────────

async function generateThumbnailTexts(
  title: string,
  videoSummary: string,
  videoType: string,
): Promise<string[]> {
  const systemPrompt = `你是 YouTube 縮圖文字專家。為「簡單歌唱 Singple.」的歌唱教學頻道設計縮圖上的短語。`;

  const prompt = `## 任務
生成 3 個 YouTube 縮圖短語。

## 規則
1. 每個短語 2-4 個中文字
2. 必須在 168x94px（手機縮圖尺寸）下也能清楚辨識
3. 不能語義重複 SEO 標題
4. 包含情感衝擊詞
5. 3 個短語分別用不同的情感策略：
   - 第 1 個：好奇缺口（讓人想知道答案）
   - 第 2 個：損失框架（不做會怎樣）
   - 第 3 個：轉變/權威（暗示效果）

## 影片資訊
- SEO 標題：${title}
- 影片摘要：${videoSummary.substring(0, 500)}
- 影片類型：${videoType}

## 輸出 JSON
{"phrases": ["短語1", "短語2", "短語3"]}`;

  const raw = await callGeminiText(prompt, systemPrompt);
  const parsed = parseJsonResponse(raw);

  if (parsed?.phrases && Array.isArray(parsed.phrases) && parsed.phrases.length >= CANDIDATE_COUNT) {
    return parsed.phrases.slice(0, CANDIDATE_COUNT);
  }

  console.warn('[Thumbnail Generator] Text generation returned unexpected format, using fallbacks');
  return ['必學秘技', '別再錯了', '聽完驚豔'];
}

// ── Step 3: Generate Design Backgrounds ────────────────────

function buildDesignPrompt(
  pattern: ThumbnailPattern,
  thumbnailText: string,
  title: string,
): string {
  const layoutDescriptions: Record<string, string> = {
    face_right_text_left: 'Text and decorative elements on the LEFT 55% of the image. The RIGHT 45% should have a simpler, cleaner background (soft gradient or solid color) because a person will be composited there later.',
    face_left_text_right: 'Text and decorative elements on the RIGHT 55% of the image. The LEFT 45% should have a simpler, cleaner background (soft gradient or solid color) because a person will be composited there later.',
    face_center_text_top: 'Large text at the TOP 30% of the image. The CENTER and BOTTOM area should have a simpler background (gradient) because a person will be composited there later.',
    full_frame_overlay: 'Full-frame design with text prominently placed. Use a semi-transparent overlay area where a person will be composited later — ensure the text remains readable alongside a person.',
  };

  const layoutInstruction = layoutDescriptions[pattern.layout_type] || layoutDescriptions.face_right_text_left;

  const colorDescriptions: Record<string, string> = {
    red: 'Bold red (#E53935) as dominant color with dark accents',
    dark_blue: 'Deep navy blue (#1A237E) with bright accent highlights',
    semi_transparent_black: 'Dark cinematic background with semi-transparent black overlay',
    yellow_on_dark: 'Dark background (#1C1C1C) with vivid yellow (#FFD600) accent elements',
    gradient_purple_blue: 'Gradient from deep purple (#6A1B9A) to electric blue (#1E88E5)',
    red_accent: 'Dark background with bold red (#F44336) accent stripes or geometric shapes',
  };

  const colorInstruction = colorDescriptions[pattern.color_scheme] || colorDescriptions[pattern.color_scheme] || 'Vibrant, eye-catching colors appropriate for YouTube thumbnails';

  const textStyleDescriptions: Record<string, string> = {
    bold_outline: 'Extra bold text with thick white or contrasting outline/stroke for maximum readability',
    shadow: 'Bold text with strong drop shadow for depth',
    plain_bold: 'Clean, ultra-bold sans-serif text without effects — relies on contrast with background',
    gradient: 'Bold text with gradient fill (gold to white or matching the color scheme)',
  };

  const textStyleInstruction = textStyleDescriptions[pattern.text_style] || textStyleDescriptions.bold_outline;

  return `Generate a YouTube thumbnail design image at 1280x720 pixels (16:9 aspect ratio).

## Design Requirements
- ${layoutInstruction}
- Color scheme: ${colorInstruction}
- Add decorative elements: arrows, sparkles, emoji-style icons, or geometric shapes to make it eye-catching
- The overall design should feel energetic, professional, and click-worthy

## Text on the Thumbnail
- Display this Chinese text prominently: "${thumbnailText}"
- Text style: ${textStyleInstruction}
- The text must be LARGE (at least 120px equivalent), bold, and readable even at small sizes
- Position the text according to the layout description above

## Context
This is for a singing tutorial YouTube channel. The video title is: "${title}"

## Critical Rules
- DO NOT draw any people, faces, or human figures
- DO NOT leave any large gray or empty placeholder areas
- The ENTIRE 1280x720 canvas must be filled with the design
- Make it look like a professional YouTube thumbnail design (without the person)`;
}

async function generateDesignBackground(
  pattern: ThumbnailPattern,
  thumbnailText: string,
  title: string,
  candidateIndex: number,
): Promise<Buffer> {
  const prompt = buildDesignPrompt(pattern, thumbnailText, title);
  console.log(`[Thumbnail Generator] Generating design background #${candidateIndex} (${pattern.layout_type}, ${pattern.color_scheme})`);

  let lastError: Error | null = null;

  // Retry once on failure
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const base64Image = await callGeminiImage(prompt);
      const buffer = Buffer.from(base64Image, 'base64');

      // Ensure the image is exactly 1280x720
      const resized = await sharp(buffer)
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'cover' })
        .jpeg({ quality: 95 })
        .toBuffer();

      return resized;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Thumbnail Generator] Design generation attempt ${attempt + 1} failed for candidate #${candidateIndex}: ${lastError.message}`);
      if (attempt === 0) {
        // Brief pause before retry
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw lastError || new Error(`Design generation failed for candidate #${candidateIndex}`);
}

// ── Step 4: Composite with Sharp ───────────────────────────

/**
 * Determine person placement based on layout type
 */
function getPersonPlacement(layoutType: string): {
  personWidth: number;
  personHeight: number;
  personX: number;
  personY: number;
  gradientDirection: 'left' | 'right' | 'both';
} {
  switch (layoutType) {
    case 'face_left_text_right':
      return {
        personWidth: Math.round(THUMBNAIL_WIDTH * 0.45),   // 576
        personHeight: THUMBNAIL_HEIGHT,                      // 720
        personX: 0,                                          // left edge
        personY: 0,
        gradientDirection: 'right',                          // fade on right edge
      };

    case 'face_center_text_top':
      return {
        personWidth: Math.round(THUMBNAIL_WIDTH * 0.5),     // 640
        personHeight: Math.round(THUMBNAIL_HEIGHT * 0.8),   // 576
        personX: Math.round((THUMBNAIL_WIDTH - THUMBNAIL_WIDTH * 0.5) / 2), // centered
        personY: THUMBNAIL_HEIGHT - Math.round(THUMBNAIL_HEIGHT * 0.8),     // bottom-aligned
        gradientDirection: 'both',                           // fade on both edges
      };

    case 'full_frame_overlay':
      return {
        personWidth: Math.round(THUMBNAIL_WIDTH * 0.45),    // 576
        personHeight: THUMBNAIL_HEIGHT,                      // 720
        personX: Math.round(THUMBNAIL_WIDTH * 0.55),        // right side
        personY: 0,
        gradientDirection: 'left',                           // fade on left edge
      };

    case 'face_right_text_left':
    default:
      return {
        personWidth: Math.round(THUMBNAIL_WIDTH * 0.45),    // 576
        personHeight: THUMBNAIL_HEIGHT,                      // 720
        personX: Math.round(THUMBNAIL_WIDTH * 0.55),        // right side
        personY: 0,
        gradientDirection: 'left',                           // fade on left edge
      };
  }
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
  const greenScreenPrompt =
    'Take this photo and replace the entire background with pure solid green color ' +
    '(#00FF00, RGB 0,255,0). Keep the person (face, hair, body, clothing) EXACTLY as-is, ' +
    'do not modify them in any way. Only the background area (walls, room, furniture) ' +
    'should become solid green. Do not draw a checkerboard pattern. The output should ' +
    'look like a green-screen chroma-key photo.';

  const greenB64 = await callGeminiImage(greenScreenPrompt, personFrameBase64, 0.1);
  const greenBuffer = Buffer.from(greenB64, 'base64');

  // Read into raw RGBA pixels
  const { data, info } = await sharp(greenBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = Buffer.from(data);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (g > 100 && g > r + 50 && g > b + 50) {
      // Strong green → fully transparent
      px[i + 3] = 0;
    } else if (g > 80 && g > r + 20 && g > b + 20) {
      // Weak green tinge → partial alpha + de-spill green channel
      const greenness = Math.min(255, (g - Math.max(r, b)) * 3);
      px[i + 3] = 255 - greenness;
      px[i + 1] = Math.round((r + b) / 2 + (g - (r + b) / 2) * 0.3);
    }
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
 * The person cutout is resized to fit the layout's slot using `fit: 'inside'`
 * so we don't crop hair/hands, then placed at the layout's anchor point.
 */
async function compositeCandidate(
  designBackground: Buffer,
  personCutoutPng: Buffer,
  layoutType: string,
): Promise<Buffer> {
  const placement = getPersonPlacement(layoutType);

  // Resize the cutout to fit within the layout slot, preserving aspect ratio.
  // 'inside' means the result may be smaller in one dimension — we then anchor
  // it so the person stays grounded within the slot.
  const personResized = await sharp(personCutoutPng)
    .resize(placement.personWidth, placement.personHeight, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .modulate({ brightness: 1.05 })
    .sharpen({ sigma: 0.5 })
    .png()
    .toBuffer();

  // Get the actual resized dimensions to compute the final anchor offset
  const { width: rw = placement.personWidth, height: rh = placement.personHeight } =
    await sharp(personResized).metadata();

  // Anchor: bottom-aligned within the slot, horizontally aligned per layout
  let left = placement.personX;
  if (placement.gradientDirection === 'left') {
    // person on right edge — push to the right of the slot
    left = placement.personX + (placement.personWidth - rw);
  } else if (placement.gradientDirection === 'both') {
    // centered slot — center horizontally
    left = placement.personX + Math.round((placement.personWidth - rw) / 2);
  }
  // gradientDirection 'right' = person on left edge → keep personX (already left edge)

  const top = placement.personY + (placement.personHeight - rh);

  return sharp(designBackground)
    .composite([{
      input: personResized,
      left,
      top,
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

  // ── Step 1: Select patterns ──────────────────────────────
  progress(5, 'thumbnail_patterns', '選擇縮圖設計模式...');
  const patterns = await selectPatterns();
  console.log(`[Thumbnail Generator] Selected patterns: ${patterns.map(p => `${p.id}(${p.layout_type})`).join(', ')}`);

  // ── Step 2: Generate thumbnail texts ─────────────────────
  progress(15, 'thumbnail_text', '生成縮圖文字...');
  const texts = await generateThumbnailTexts(title, videoSummary, videoType);
  console.log(`[Thumbnail Generator] Generated texts: ${texts.join(', ')}`);

  // ── Step 3: Generate design backgrounds + remove person bg (parallel) ───
  progress(25, 'thumbnail_design', '生成設計背景 + 去背人物（並行）...');
  const bestFrame = selectBestFrame(frames);

  const [designResults, personCutoutResult] = await Promise.all([
    Promise.allSettled(
      patterns.map((pattern, i) =>
        generateDesignBackground(pattern, texts[i], title, i)
      ),
    ),
    // Run background removal in parallel with design generation
    removeBackgroundFromFrame(bestFrame).catch((err) => {
      console.error(`[Thumbnail Generator] Background removal failed, falling back to raw frame:`, err);
      return null;
    }),
  ]);

  // Fallback: if background removal failed, use raw frame as opaque PNG
  const personCutoutPng = personCutoutResult ?? await sharp(Buffer.from(bestFrame, 'base64')).png().toBuffer();
  console.log(`[Thumbnail Generator] Person cutout ready (${personCutoutResult ? 'background removed' : 'raw fallback'})`);

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
      // Composite
      const composited = await compositeCandidate(
        designBackground,
        personCutoutPng,
        patterns[i].layout_type,
      );

      // ── Step 5: Upload ──────────────────────────────────
      progress(75 + (i * 7), 'thumbnail_upload', `上傳候選 ${i + 1}/${CANDIDATE_COUNT}...`);
      const imageUrl = await uploadCandidate(jobId, i, composited);

      candidates.push({
        imageUrl,
        thumbnailText: texts[i],
        patternId: patterns[i].id,
      });

      console.log(`[Thumbnail Generator] Candidate #${i} complete: ${imageUrl}`);
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
