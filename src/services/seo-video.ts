/**
 * SEO Video Service — 影片 SEO 文案 + YouTube 標題生成
 *
 * 流程：前端直傳 GCS → Gemini 直讀 gs:// URI（零下載）
 *
 * 生成: Gemini 3.1 Pro (thinkingLevel: high)
 * 審核: Gemini 3.1 Pro NLP 審核
 * 編號: YouTube Data API v3
 */

import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';
import { selectDiverseSkeletons, buildDiversityConstraint, getRecentDNA, recordDNA } from './dna-tracker.js';
import type { CaptionDNA } from './dna-tracker.js';
import { preHint, postReview } from './nlp_kb_client.js';

// ── Config ──────────────────────────────────────────────────

const GCS_BUCKET_NAME = 'singple-seo-videos';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = 'UCo3Z0bh4OnwPL5z4rMwNqbg';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const GEMINI_MODEL = 'gemini-3.5-flash';

// ── Clients ─────────────────────────────────────────────────

let gcsStorageOptions: ConstructorParameters<typeof Storage>[0] = {};
if (process.env.GCS_KEY_JSON) {
  const credentials = JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, 'base64').toString());
  gcsStorageOptions = { credentials };
} else {
  gcsStorageOptions = { keyFilename: './gcs-key.json' };
}
const gcsStorage = new Storage(gcsStorageOptions);
const gcsBucket = gcsStorage.bucket(GCS_BUCKET_NAME);

// Reuse the same credentials for Gemini OAuth (files:register requires OAuth, not API key)
let geminiAuth: GoogleAuth;
if (process.env.GCS_KEY_JSON) {
  const credentials = JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, 'base64').toString());
  geminiAuth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/generative-language', 'https://www.googleapis.com/auth/cloud-platform'] });
} else {
  geminiAuth = new GoogleAuth({ keyFilename: './gcs-key.json', scopes: ['https://www.googleapis.com/auth/generative-language', 'https://www.googleapis.com/auth/cloud-platform'] });
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ───────────────────────────────────────────────────

interface ProgressCallback {
  (progress: number, stage: string, detail: string): void;
}

interface SeoResult {
  caption: Record<string, unknown>;
  titles: Record<string, unknown>[];
  episodeNumber: number | null;
  transcript?: string;
  thumbnailTimestamps?: { timestamp: number; description: string }[];
}

// ── Progress updater ────────────────────────────────────────

async function updateJobProgress(
  jobId: string,
  progress: number,
  stage: string,
  detail: string,
  onProgress?: ProgressCallback,
) {
  await supabase
    .from('seo_jobs')
    .update({ progress, stage, stage_detail: detail, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  onProgress?.(progress, stage, detail);
}

// ── GCS helpers ────────────────────────────────────────────

/** Delete a GCS object by its gs:// URI */
export async function deleteGcsObject(gcsUri: string): Promise<void> {
  const path = gcsUri.replace(`gs://${GCS_BUCKET_NAME}/`, '');
  await gcsBucket.file(path).delete();
  console.log(`[SEO] GCS deleted: ${path}`);
}

// ── Gemini API ──────────────────────────────────────────────

async function callGemini(prompt: string, systemPrompt?: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingLevel: 'high' },
    },
  };

  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

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
    throw new Error(`Gemini returned no text: ${JSON.stringify(data).substring(0, 200)}`);
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

// ── Gemini Video Analysis (GCS → register → analyze) ──────

async function analyzeVideoWithGemini(
  gcsUri: string,
  description: string,
  jobId: string,
  onProgress?: ProgressCallback,
): Promise<{ analysis: string; transcript: string; fileUri: string }> {
  await updateJobProgress(jobId, 10, 'preparing', '準備影片中（GCS 直讀）...', onProgress);

  // Register GCS file with Gemini (OAuth + /v1beta/files:register)
  await updateJobProgress(jobId, 12, 'uploading_gemini', '向 Gemini 註冊 GCS 影片...', onProgress);

  const authClient = await geminiAuth.getClient();
  const tokenRes = await authClient.getAccessToken();
  const accessToken = tokenRes.token;

  const registerRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/files:register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'x-goog-user-project': 'gen-lang-client-0010622782',
      },
      body: JSON.stringify({ uris: [gcsUri] }),
    },
  );

  const registerData = await registerRes.json() as any;
  console.log(`[SEO] Gemini register GCS:`, JSON.stringify(registerData).substring(0, 300));
  const registeredFile = registerData?.files?.[0];
  let fileUri = registeredFile?.uri;

  if (!fileUri) {
    throw new Error(`Gemini GCS register failed: ${JSON.stringify(registerData).substring(0, 300)}`);
  }

  // Small delay for propagation (registered GCS files are immediately available)
  await new Promise(r => setTimeout(r, 3000));
  console.log(`[SEO] Gemini file registered: ${fileUri}`);

  // Analyze video
  const analysisUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const videoFilePart = { fileData: { mimeType: 'video/mp4', fileUri } };

  await updateJobProgress(jobId, 20, 'analyzing', '分析影片中...', onProgress);

  const analysisData = await fetch(analysisUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          videoFilePart,
          { text: `仔細觀看這支影片，分析以下資訊，用繁體中文輸出 JSON：
{
  "video_type": "教學/翻唱/日常/其他",
  "song_name": "歌曲名稱（如果有，沒有就留空字串）",
  "original_artist": "原唱（如果有，沒有就留空字串）",
  "vocal_techniques": ["使用的唱歌技巧"],
  "emotional_core": "影片的情感核心",
  "pain_points": {"L1": "表層痛點", "L2": "生活影響", "L3": "自我認同"},
  "search_keywords": ["觀眾可能搜尋的關鍵字"],
  "best_hook_type": "最適合的 hook 類型",
  "best_cta_type": "最適合的 CTA 類型"
}

影片描述：${description}` },
        ],
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'high' },
      },
    }),
  }).then(r => r.json() as Promise<any>);

  const transcript = '';
  const analysisParts = analysisData?.candidates?.[0]?.content?.parts || [];
  let analysisText = '';
  for (let i = analysisParts.length - 1; i >= 0; i--) {
    if (analysisParts[i].text) { analysisText = analysisParts[i].text; break; }
  }

  return { analysis: analysisText, transcript, fileUri };
}

// ── Thumbnail Frame Timestamps (separate Gemini call) ───────

export async function extractThumbnailTimestamps(
  fileUri: string,
): Promise<{ timestamp: number; description: string }[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const videoFilePart = { fileData: { mimeType: 'video/mp4', fileUri } };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            videoFilePart,
            { text: `你是 YouTube 封面選擇專家。分析影片中的人物表情和構圖，選出最適合做 YouTube 封面的 5 個時間點。

選擇標準：
1. 人物臉部清晰、表情生動（驚訝、興奮、認真講解）
2. 構圖好（人物不要太小、不要被遮擋）
3. 背景不要太雜亂
4. 盡量分散在影片的不同段落

如果影片沒有出現人物，選擇視覺上最吸引人的畫面。

輸出 JSON 陣列：
[
  {"timestamp": 23.5, "description": "講者驚訝表情，手勢誇張", "people_count": 1},
  ...
]

只輸出 JSON，不要其他文字。` },
          ],
        }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'high' },
        },
      }),
    }).then(r => r.json() as Promise<any>);

    if (res?.error) {
      console.error('[SEO] Thumbnail timestamps Gemini error:', JSON.stringify(res.error).substring(0, 500));
      return [];
    }

    const parts = res?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text) { text = parts[i].text; break; }
    }

    if (!text) {
      console.warn('[SEO] Thumbnail timestamps: empty text from Gemini. Raw response:', JSON.stringify(res).substring(0, 500));
      return [];
    }
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }
    console.warn('[SEO] Thumbnail timestamps: failed to parse JSON. Text was:', text.substring(0, 300));
    return [];
  } catch (err) {
    console.error('[SEO] Thumbnail timestamp extraction failed:', err);
    return [];
  }
}

// ── SEO Caption Generation ──────────────────────────────────

async function generateSeoCaption(
  content: string,
  description: string,
  videoAnalysis: string | null,
): Promise<Record<string, unknown> | null> {
  const { data: examples } = await supabase.from('seo_viral_examples').select('*').limit(5);
  const { data: trackerData } = await supabase.from('seo_trackers').select('*').eq('id', 'style_tracker').single();

  const recentHooks = trackerData?.data?.recent_hooks || [];
  const exampleText = examples?.map((e: any) => `[${e.angle || e.category}] ${e.content}`).join('\n') || '（無）';

  // DNA diversity constraint
  const recentDNA = await getRecentDNA(5);
  const diversityConstraint = buildDiversityConstraint(recentDNA);

  const systemPrompt = `你是簡單歌唱工作室的 Instagram SEO 文案專家。用 Karen 的口語風格寫文案。

## Karen 的語氣
台灣口語（欸、啦、超、根本、好嗎），像跟朋友聊天，不正式，適當 emoji（3-5 個），有畫面感、有梗。

## SEO 規則（2026 最新研究）
- Reels 未展開只顯示 55 字元 → Hook 必須在這範圍內
- 21-50 字元互動率最高（7.29%），90+ 字互動率跌到 0.3% 以下
- 口語化長尾關鍵字比短關鍵字好

## 結構（嚴格遵守）— 總計不超過 100 字（不含 hashtag）
1. Hook（20 中文字內，必含核心關鍵字，55 字元內）
2. 價值描述（1 句話，點出影片教了什麼）
3. CTA（1 句，具體指令）
4. Hashtag（3-5 個：1品牌 + 2利基 + 1-2情境）

## NLP 技巧（必須使用）
- 封閉性操作（說一半不說完）
- L2/L3 痛點觸及（不只表層）
- 損失框架（比獲得框架強 2 倍）
- 雙重束縛 CTA

## 爆款範例
${exampleText}

## 不能做
- 正文不能超過 100 個中文字
- Hook 不能超過 20 個中文字
- 不能堆砌關鍵字
- 不能用「大家好」開頭
- 最近用過的 hook 類型（避免重複）：${recentHooks.slice(-5).join(', ')}
${diversityConstraint}

## 輸出 JSON
{
  "hook": "開頭（20字內）",
  "value": "價值描述（1句話）",
  "cta": "行動呼籲（1句）",
  "full_caption": "完整文案（60-100字）",
  "hashtags": "#tag1 #tag2",
  "alt_text": "影片 alt text",
  "hook_type": "hook 類型",
  "cta_type": "收藏/分享/留言",
  "primary_keywords": ["kw1", "kw2"],
  "char_count": 80
}`;

  const userPrompt = `## 影片內容
${content.substring(0, 2000)}

${videoAnalysis ? `## 影片分析\n${videoAnalysis.substring(0, 1000)}` : ''}

${description ? `## 描述\n${description}` : ''}`;

  const raw = await callGemini(userPrompt, systemPrompt);
  return parseJsonResponse(raw);
}

// ── NLP Caption Review ──────────────────────────────────────

async function nlpCaptionReview(
  caption: Record<string, unknown>,
  content: string,
): Promise<Record<string, unknown>> {
  // NLP KB post-generation review hint (feature flagged, returns null when off)
  let _nlpReviewBlock = '';
  try {
    const _captionText = (caption.full_caption as string)
      || (caption.hook as string)
      || JSON.stringify(caption);
    const _review = await postReview(_captionText, 'IG SEO 文案');
    if (_review) {
      console.log('[nlp_kb] caption review hint:', _review.substring(0, 200));
      _nlpReviewBlock = `\n\n## 🧠 NLP KB 額外審稿建議（融入修改，不要複製）\n${_review}\n`;
    }
  } catch (e) {
    console.warn('[nlp_kb] postReview (caption) failed:', (e as Error).message);
  }

  const prompt = `你是 NLP 神經語言學行銷專家。審核以下 IG SEO 文案，用 NLP 技巧強化說服力。
${_nlpReviewBlock}

## 審核重點
1. Hook 有沒有封閉性？
2. 有沒有觸及 L2/L3 痛點？
3. 是否用了損失框架？
4. CTA 是否讓人無法說「不」？

## 待審核的文案
${JSON.stringify(caption, null, 2)}

## 原始內容
${content.substring(0, 500)}

## 輸出 JSON
{
  "approved": true/false,
  "revised_full_caption": "修改後的完整文案（如果需要）",
  "revised_hook": "修改後的 hook（如果需要）",
  "nlp_techniques_applied": ["技巧1", "技巧2"],
  "pain_level_reached": "L1/L2/L3",
  "suggestions": "改進建議"
}`;

  const raw = await callGemini(prompt);
  const review = parseJsonResponse(raw);
  if (!review) return caption;

  if (!review.approved && review.revised_full_caption) {
    caption.full_caption = review.revised_full_caption;
    if (review.revised_hook) caption.hook = review.revised_hook;
  }
  caption.nlp_review = {
    approved: review.approved,
    pain_level: review.pain_level_reached,
    techniques: review.nlp_techniques_applied,
    suggestions: review.suggestions,
  };

  return caption;
}

// ── YouTube Title Generation ────────────────────────────────

async function generateYouTubeTitles(
  content: string,
  caption: Record<string, unknown>,
  videoAnalysis: string | null,
): Promise<Record<string, unknown>[] | null> {
  const { data: skeletons } = await supabase.from('seo_title_skeletons').select('*');
  const { data: trackerData } = await supabase.from('seo_trackers').select('*').eq('id', 'title_tracker').single();
  const { data: examples } = await supabase.from('seo_viral_examples').select('*').eq('type', 'title').limit(10);

  const tracker = trackerData?.data || {};
  const recentAngles = tracker.recent_angles || [];
  const angles = ['痛點', '反差', '數字', '場景', '挑戰', '權威', '結果', '否定'];

  // Use DNA-aware diverse skeleton selection
  const recentDNA = await getRecentDNA(10);
  const diverseSkeletons = await selectDiverseSkeletons(skeletons || [], recentDNA, 5);
  const diversityConstraint = buildDiversityConstraint(recentDNA);

  const availableAngles = angles.filter(a => !recentAngles.slice(-5).includes(a));

  const skeletonText = diverseSkeletons
    .map((s: any) => `- ${s.id}: ${s.pattern}（例：${s.example}）`)
    .join('\n');

  const angleText = (availableAngles.length >= 5 ? availableAngles : angles).slice(0, 5).join('、');
  const exampleText = (examples || []).map((e: any) => `- [${e.angle}] ${e.content}`).join('\n') || '（無）';

  const recentUsed = (tracker.recent_titles || [])
    .slice(-10)
    .map((t: any) => `[${t.angle}+${t.skeleton_id}] ${t.title}`)
    .join('\n') || '（無）';

  // NLP KB pre-generation hint (feature flagged, returns null when off)
  let _nlpHintBlock = '';
  try {
    const _topicHint = (caption.hook as string)
      || content.substring(0, 200)
      || 'YouTube 標題';
    const _hint = await preHint(_topicHint, 'YouTube 標題生成');
    if (_hint) {
      _nlpHintBlock = `\n\n## 🧠 NLP 技巧建議（融入標題設計，不要直接引用術語）\n${_hint}\n`;
    }
  } catch (e) {
    console.warn('[nlp_kb] preHint (YT titles) failed:', (e as Error).message);
  }

  const prompt = `你是「簡單歌唱 Singple.」的 YouTube 標題專家。目標：讓陌生人停下來點擊。
${_nlpHintBlock}

## 任務
生成 5 個 YouTube 標題候選。

## 嚴格規則
1. 5 個標題分別用這 5 種切入角度：${angleText}
2. 5 個標題分別用不同的骨架結構
3. 每個標題 ≤ 42 個字元（後面要加「｜簡單歌唱 Singple. #xxx」）
4. 禁止：四字成語對仗、「掌握/解鎖/開啟/蛻變」、空泛承諾、過度完美句式
5. 必須有：口語詞或具體場景
6. 標題承諾 ≤ 內容實際教的
7. 不能像 AI 公式化產出

## 骨架結構
${skeletonText}

## 爆款標題範例
${exampleText}

## 最近用過的（避免重複）
${recentUsed}

## 內容
${content.substring(0, 2000)}

${videoAnalysis ? `## 影片分析\n${videoAnalysis.substring(0, 500)}` : ''}

## 已生成的 SEO 文案
Hook: ${caption.hook || ''}
關鍵字: ${(caption.primary_keywords as string[] || []).join(', ')}
${diversityConstraint}

## 輸出 JSON 陣列
[{"title":"標題","skeleton_id":"骨架ID","angle":"角度","why":"原因","char_count":30}]
共 5 個。`;

  const raw = await callGemini(prompt);
  return parseJsonResponse(raw) as Record<string, unknown>[] | null;
}

// ── NLP Title Review ────────────────────────────────────────

async function nlpTitleReview(
  titles: Record<string, unknown>[],
  content: string,
): Promise<Record<string, unknown>[]> {
  // NLP KB post-generation review hint (feature flagged, returns null when off)
  let _nlpReviewBlock = '';
  try {
    const _titlesText = titles.map((t) => `- ${(t.title as string) || ''}`).join('\n');
    const _review = await postReview(_titlesText, 'YouTube 標題');
    if (_review) {
      console.log('[nlp_kb] titles review hint:', _review.substring(0, 200));
      _nlpReviewBlock = `\n\n## 🧠 NLP KB 額外審稿建議（參考並融入判斷，不要直接複製）\n${_review}\n`;
    }
  } catch (e) {
    console.warn('[nlp_kb] postReview (titles) failed:', (e as Error).message);
  }

  const prompt = `你是 YouTube 標題 NLP 審核專家。逐一審核以下 ${titles.length} 個標題。
${_nlpReviewBlock}

## 審核維度
A. 內容一致性（標題承諾 ≤ 內容實際教的）
B. AI 感檢測（四字成語、萬用動詞、空泛承諾、過度完美句式 → 紅旗）
C. 人味指標（具體數字/場景、口語詞、不完美感 → 至少 2 個）

## 標題
${JSON.stringify(titles, null, 2)}

## 內容
${content.substring(0, 1000)}

## 輸出 JSON 陣列
[{"index":0,"original_title":"xxx","overall":"pass/revise","revised_title":"修改版","note":"說明"}]`;

  const raw = await callGemini(prompt);
  const reviews = parseJsonResponse(raw) as any[] | null;
  if (!reviews) return titles;

  for (const review of reviews) {
    const idx = review.index;
    if (idx >= 0 && idx < titles.length) {
      if (review.overall === 'revise' && review.revised_title) {
        titles[idx].title = review.revised_title;
        titles[idx].revised = true;
      }
      titles[idx].nlp_review = {
        overall: review.overall,
        note: review.note,
      };
    }
  }
  return titles;
}

// ── YouTube Episode Number ──────────────────────────────────

async function getNextEpisodeNumber(): Promise<number | null> {
  if (!YOUTUBE_API_KEY) return null;

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&order=date&maxResults=5&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json() as any;

    let maxNum = 0;
    for (const item of data.items || []) {
      const match = item.snippet?.title?.match(/#(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    }

    if (maxNum > 0) {
      console.log(`[SEO] YouTube latest: #${maxNum} → next: #${maxNum + 1}`);
      return maxNum + 1;
    }
  } catch (err) {
    console.error('YouTube API error:', err);
  }

  return null;
}

// ── Update Shared Trackers ──────────────────────────────────

async function updateTrackers(
  caption: Record<string, unknown>,
  titles: Record<string, unknown>[],
) {
  const { data: styleTracker } = await supabase
    .from('seo_trackers')
    .select('data')
    .eq('id', 'style_tracker')
    .single();

  const styleData = styleTracker?.data || { recent_hooks: [], recent_cta_types: [], generation_count: 0 };
  styleData.recent_hooks = [...(styleData.recent_hooks || []), caption.hook_type].slice(-10);
  styleData.recent_cta_types = [...(styleData.recent_cta_types || []), caption.cta_type].slice(-10);
  styleData.generation_count = (styleData.generation_count || 0) + 1;
  styleData.last_generated = new Date().toISOString();

  await supabase
    .from('seo_trackers')
    .upsert({ id: 'style_tracker', data: styleData, updated_at: new Date().toISOString() });

  const { data: titleTracker } = await supabase
    .from('seo_trackers')
    .select('data')
    .eq('id', 'title_tracker')
    .single();

  const titleData = titleTracker?.data || { recent_titles: [], recent_skeletons: [], recent_angles: [], title_generation_count: 0 };

  for (const t of titles) {
    titleData.recent_titles = [...(titleData.recent_titles || []), {
      date: new Date().toISOString().split('T')[0],
      title: t.title,
      skeleton_id: t.skeleton_id,
      angle: t.angle,
      source: 'web-gemini',
    }].slice(-10);
    titleData.recent_skeletons = [...(titleData.recent_skeletons || []), t.skeleton_id].slice(-10);
    titleData.recent_angles = [...(titleData.recent_angles || []), t.angle].slice(-10);
  }
  titleData.title_generation_count = (titleData.title_generation_count || 0) + 1;
  titleData.last_generated = new Date().toISOString();

  await supabase
    .from('seo_trackers')
    .upsert({ id: 'title_tracker', data: titleData, updated_at: new Date().toISOString() });
}

// ── Main Processing Pipeline ────────────────────────────────

export async function processVideoSeo(
  jobId: string,
  onProgress?: ProgressCallback,
): Promise<SeoResult> {
  const { data: job } = await supabase.from('seo_jobs').select('*').eq('id', jobId).single();
  if (!job) throw new Error(`Job ${jobId} not found`);

  const fileKey = job.file_key as string;
  const description = job.description || '';
  await updateJobProgress(jobId, 5, 'starting', '開始處理...', onProgress);
  await supabase.from('seo_jobs').update({ status: 'processing' }).eq('id', jobId);

  if (!fileKey.startsWith('gs://')) {
    throw new Error(`Unsupported file_key format (R2 no longer supported): ${fileKey}`);
  }

  const result = await analyzeVideoWithGemini(fileKey, description, jobId, onProgress);
  const content = result.transcript;
  const videoAnalysis: string | null = result.analysis;

  // Generate SEO caption + YouTube titles IN PARALLEL
  // Thumbnail timestamps only for long videos (duration > 60s)
  const isLongVideo = job.video_type === 'long';
  await updateJobProgress(jobId, 45, 'generating_caption', '並行生成 SEO 文案 + YouTube 標題' + (isLongVideo ? ' + 封面分析' : '') + '...', onProgress);
  const [captionRaw, titlesRaw, thumbnailTimestamps] = await Promise.all([
    generateSeoCaption(content, description, videoAnalysis),
    generateYouTubeTitles(content, {} as any, videoAnalysis),
    isLongVideo ? extractThumbnailTimestamps(result.fileUri) : Promise.resolve([]),
  ]);
  console.log(`[SEO] isLongVideo=${isLongVideo}, thumbnail timestamps: ${JSON.stringify(thumbnailTimestamps)}`);
  let caption = captionRaw;
  if (!caption) throw new Error('SEO caption generation failed');
  caption.source_model = 'gemini-3.1-pro';
  let titles = titlesRaw || [];

  // NLP review caption + titles IN PARALLEL
  await updateJobProgress(jobId, 65, 'reviewing_caption', '並行 NLP 審核文案 + 標題...', onProgress);
  const [reviewedCaption, reviewedTitles] = await Promise.all([
    nlpCaptionReview(caption, content),
    nlpTitleReview(titles, content),
  ]);
  caption = reviewedCaption;
  titles = reviewedTitles;

  // YouTube episode number
  await updateJobProgress(jobId, 85, 'numbering', '取得 YouTube 編號...', onProgress);
  const episodeNumber = await getNextEpisodeNumber();

  // Add suffix to titles
  const suffix = episodeNumber
    ? `｜簡單歌唱 Singple. #${episodeNumber}`
    : '｜簡單歌唱 Singple. #???';
  for (const t of titles) {
    t.full_title = `${t.title}${suffix}`;
    t.episode_number = episodeNumber;
  }

  // Record DNA for diversity tracking
  const dna: CaptionDNA = {
    skeleton_id: (titles[0]?.skeleton_id as string) || '',
    angle: (titles[0]?.angle as string) || '',
    hook_type: (caption.hook_type as string) || '',
    cta_type: (caption.cta_type as string) || '',
    emotion: (caption.nlp_review as any)?.pain_level || '',
    pain_level: (caption.nlp_review as any)?.pain_level || '',
    technique: ((caption.nlp_review as any)?.techniques?.[0]) || '',
  };
  await recordDNA(jobId, dna);

  // Update shared trackers
  await updateTrackers(caption, titles);

  // Save results (preserve thumbnail from initial upload)
  await updateJobProgress(jobId, 95, 'saving', '儲存結果...', onProgress);
  const existingThumbnail = job.caption?.thumbnail;
  if (existingThumbnail) caption.thumbnail = existingThumbnail;
  // Persist thumbnail timestamps for history/audit (was previously lost on refresh)
  caption.thumbnail_timestamps = thumbnailTimestamps;

  await supabase.from('seo_jobs').update({
    status: 'done',
    progress: 100,
    stage: 'done',
    stage_detail: '完成！',
    transcript: content.substring(0, 10000),
    caption: caption,
    titles: titles,
    episode_number: episodeNumber,
    model_used: 'gemini-3.1-pro',
    video_type: job.video_type || 'auto',
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  // Clean up GCS file after processing
  deleteGcsObject(fileKey).catch((err) => {
    console.error(`[SEO] GCS cleanup failed: ${err}`);
  });

  return { caption, titles, episodeNumber, transcript: content, thumbnailTimestamps };
}
