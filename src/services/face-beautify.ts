/**
 * Face Beautify — Gemini bbox + Sharp local blur
 *
 * Strategy (verified by POC 2026-04-07):
 * 1. Send frame to Gemini Pro Vision asking for face + 5 feature bboxes
 *    (left_eye, right_eye, nose, mouth) in 0-1000 normalized coordinates.
 * 2. Sharp extracts the face region, blurs it (smooths skin), then
 *    re-overlays the original eye/nose/mouth regions on top so features
 *    stay sharp.
 * 3. The face shape and identity are preserved (Sharp can't move pixels,
 *    only filter them in place).
 *
 * Why not Gemini full-image edit: POC-B 2026-04-07 confirmed Gemini's
 * image-to-image "subtle beautify" repaints the whole image and changes
 * facial expression. Gemini bbox + Sharp filtering keeps the original
 * pixels intact except for the controlled blur on skin areas.
 *
 * Failure mode: if Gemini bbox call fails or returns malformed JSON,
 * the function returns the input unchanged (no crash, no break in the
 * generation pipeline).
 */

import sharp from 'sharp';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

interface BBox {
  y_min: number;
  x_min: number;
  y_max: number;
  x_max: number;
}

interface FaceBoxes {
  face_box: BBox;
  left_eye_box: BBox;
  right_eye_box: BBox;
  nose_box: BBox;
  mouth_box: BBox;
}

export type BeautifyLevel = 'off' | 'subtle' | 'moderate';

// ── Gemini bbox detection ──────────────────────────────────

async function detectFaceBoxes(jpegBase64: string): Promise<FaceBoxes | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `分析這張人物照片，回傳 JSON 標出以下區域的 bounding box（座標用 0-1000 normalized，左上角 0,0）：

{
  "face_box": {"y_min": ?, "x_min": ?, "y_max": ?, "x_max": ?},
  "left_eye_box": {"y_min": ?, "x_min": ?, "y_max": ?, "x_max": ?},
  "right_eye_box": {"y_min": ?, "x_min": ?, "y_max": ?, "x_max": ?},
  "nose_box": {"y_min": ?, "x_min": ?, "y_max": ?, "x_max": ?},
  "mouth_box": {"y_min": ?, "x_min": ?, "y_max": ?, "x_max": ?}
}

face_box 涵蓋整個臉部含下巴額頭。五官 box 要緊貼但不要切到。
只輸出 JSON，不要其他文字。`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
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
      console.warn('[Beautify] Gemini bbox error:', JSON.stringify(data.error).substring(0, 200));
      return null;
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text) { text = parts[i].text; break; }
    }
    if (!text) {
      console.warn('[Beautify] Gemini returned no text');
      return null;
    }
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { return null; }
      } else {
        return null;
      }
    }
    if (!parsed?.face_box) {
      console.warn('[Beautify] Gemini response missing face_box');
      return null;
    }
    return parsed as FaceBoxes;
  } catch (err) {
    console.error('[Beautify] bbox detection exception:', err);
    return null;
  }
}

// ── Coordinate conversion ──────────────────────────────────

function normalizedToPixels(box: BBox, width: number, height: number): {
  left: number; top: number; width: number; height: number;
} {
  const left = Math.max(0, Math.round((box.x_min / 1000) * width));
  const top = Math.max(0, Math.round((box.y_min / 1000) * height));
  const right = Math.min(width, Math.round((box.x_max / 1000) * width));
  const bottom = Math.min(height, Math.round((box.y_max / 1000) * height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

// ── Main beautify ──────────────────────────────────────────

/**
 * Beautify a person cutout PNG using Gemini bbox + Sharp local blur.
 *
 * @param cutoutPng — RGBA PNG buffer of the person cutout (with alpha)
 * @param level — 'off' (no-op), 'subtle' (default), 'moderate' (stronger blur)
 * @returns beautified PNG buffer (or original if any step fails)
 */
export async function beautifyFace(
  cutoutPng: Buffer,
  level: BeautifyLevel = 'subtle',
): Promise<Buffer> {
  if (level === 'off') return cutoutPng;

  // For Gemini detection, convert to JPEG (smaller payload, no alpha needed)
  const jpegForDetect = await sharp(cutoutPng)
    .flatten({ background: '#FFFFFF' })  // composite alpha onto white
    .jpeg({ quality: 85 })
    .toBuffer();
  const jpegB64 = jpegForDetect.toString('base64');

  const boxes = await detectFaceBoxes(jpegB64);
  if (!boxes) {
    console.log('[Beautify] No face detected, returning original');
    return cutoutPng;
  }

  const meta = await sharp(cutoutPng).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (W === 0 || H === 0) return cutoutPng;

  // Convert face_box to pixel coordinates
  const faceRect = normalizedToPixels(boxes.face_box, W, H);

  // Sanity check — if face is implausibly small or oversized, skip
  if (faceRect.width < 30 || faceRect.height < 30) {
    console.log('[Beautify] Face box too small, returning original');
    return cutoutPng;
  }

  // Karen 2026-04-07: subtle 1.4 felt too gentle, bumped to 1.8.
  // Higher than 2.2 starts producing a halo where blur leaks past face_box.
  const blurSigma = level === 'subtle' ? 1.8 : 2.5;

  // 1. Extract face region, blur it (smooths skin)
  const blurredFace = await sharp(cutoutPng)
    .extract(faceRect)
    .blur(blurSigma)
    .png()
    .toBuffer();

  // 2. Composite blurred face back onto the original
  let result = await sharp(cutoutPng)
    .composite([{ input: blurredFace, left: faceRect.left, top: faceRect.top, blend: 'over' }])
    .png()
    .toBuffer();

  // 3. Re-overlay each feature region from the ORIGINAL on top of the
  //    blurred face, so eyes/nose/mouth stay sharp. Without this step
  //    the features look soft and "doll-like".
  const featureBoxes: BBox[] = [
    boxes.left_eye_box,
    boxes.right_eye_box,
    boxes.nose_box,
    boxes.mouth_box,
  ].filter(Boolean);

  for (const fb of featureBoxes) {
    if (!fb) continue;
    const rect = normalizedToPixels(fb, W, H);
    if (rect.width < 5 || rect.height < 5) continue;
    try {
      const original = await sharp(cutoutPng)
        .extract(rect)
        .png()
        .toBuffer();
      result = await sharp(result)
        .composite([{ input: original, left: rect.left, top: rect.top, blend: 'over' }])
        .png()
        .toBuffer();
    } catch (err) {
      console.warn('[Beautify] feature overlay failed for box, skipping:', err);
    }
  }

  // 4. Final brightness/saturation lift on the whole cutout
  result = await sharp(result)
    .modulate({ brightness: 1.03, saturation: 1.05 })
    .sharpen({ sigma: 0.5 })
    .png()
    .toBuffer();

  return result;
}
