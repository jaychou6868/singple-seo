/**
 * SEO Video Service — 影片 SEO 文案 + YouTube 標題生成
 *
 * 新流程：瀏覽器直傳 → /tmp → Gemini（跳過 R2）
 * 舊流程（向下相容）：R2 → 下載 → Gemini
 *
 * 生成: Gemini 3.1 Pro (thinkingLevel: high)
 * 審核: Gemini 3.1 Pro NLP 審核
 * 編號: YouTube Data API v3
 */

import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

// ── Config ──────────────────────────────────────────────────

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'b4dcf0aa309942f83f66289fb22cfe2f';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '6aefc53c434ae7e17bc09902d744f568';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '48b5829b321582ccd142d05228bd58fcad56e4fce65195c1e401db3566b7e71b';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'seo-videos';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = 'UCo3Z0bh4OnwPL5z4rMwNqbg';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024; // 200MB — use disk instead of buffer

// ── Clients ─────────────────────────────────────────────────

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

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

// ── R2 helpers ──────────────────────────────────────────────

export async function getR2Buffer(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
  const response = await s3.send(command);
  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getR2Stream(key: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
  const response = await s3.send(command);
  return {
    stream: response.Body as NodeJS.ReadableStream,
    contentType: response.ContentType || 'video/mp4',
  };
}

export async function deleteR2Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
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
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout (high thinking needs more time)

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

// ── Gemini Video Analysis (all videos) ─────────────────────

async function analyzeVideoWithGemini(
  fileKey: string,
  description: string,
  jobId: string,
  onProgress?: ProgressCallback,
): Promise<{ analysis: string; transcript: string }> {
  await updateJobProgress(jobId, 10, 'preparing', '準備影片中...', onProgress);

  // Read video from local /tmp or fall back to R2 for legacy jobs
  let videoBuffer: Buffer;
  const isLocalFile = fileKey.startsWith('/tmp/');

  if (isLocalFile) {
    // New flow: file already on disk from upload endpoint
    if (!fs.existsSync(fileKey)) {
      throw new Error(`影片檔案不存在：${fileKey}`);
    }
    videoBuffer = fs.readFileSync(fileKey);
    console.log(`[SEO] Local file read OK: ${fileKey} (${videoBuffer.length} bytes)`);
  } else {
    // Legacy flow: download from R2
    const jobData = (await supabase.from('seo_jobs').select('file_size, video_type').eq('id', jobId).single()).data;
    const fileSize = jobData?.file_size || 0;
    if (fileSize > LARGE_FILE_THRESHOLD) {
      const tmpDir = `/tmp/seo-${jobId}`;
      fs.mkdirSync(tmpDir, { recursive: true });
      const videoPath = `${tmpDir}/video.mp4`;
      try {
        const { stream: r2Stream } = await getR2Stream(fileKey);
        await Promise.race([
          pipeline(r2Stream, fs.createWriteStream(videoPath)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('下載超時（30分鐘）')), 1800000)),
        ]);
        videoBuffer = fs.readFileSync(videoPath);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    } else {
      videoBuffer = await getR2Buffer(fileKey);
    }
    console.log(`[SEO] R2 download OK: ${fileKey} (${videoBuffer.length} bytes)`);
  }

  await updateJobProgress(jobId, 15, 'uploading_gemini', '上傳影片到 Gemini...', onProgress);

  // Upload to Gemini Files API
  const geminiUploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;
  let fileUri: string;
  const uploadRes = await fetch(geminiUploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4',
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Header-Content-Length': videoBuffer.length.toString(),
    },
    body: new Uint8Array(videoBuffer),
  });

  const fileData = await uploadRes.json() as any;
  console.log(`[SEO] Gemini upload:`, JSON.stringify(fileData).substring(0, 300));
  fileUri = fileData?.file?.uri;
  if (!fileUri) throw new Error(`Gemini upload failed: ${JSON.stringify(fileData).substring(0, 200)}`);

  // Free disk space immediately after Gemini upload (for /tmp files)
  if (isLocalFile) {
    const tmpDir = fileKey.replace(/\/video\.mp4$/, '');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log(`[SEO] Freed tmp after Gemini upload: ${tmpDir}`);
  }

  // Wait for Gemini to process the uploaded file
  await new Promise(r => setTimeout(r, 5000));

  const analysisUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const videoFilePart = { fileData: { mimeType: 'video/mp4', fileUri } };

  // 只做內容分析（文字轉錄留到未來 YouTube 縮圖功能再加）
  await updateJobProgress(jobId, 20, 'analyzing', '分析影片中...', onProgress);

  const analyzePromise = fetch(analysisUrl, {
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

  const analysisData = await analyzePromise;
  const transcript = '';

  // 解析分析結果
  const analysisParts = analysisData?.candidates?.[0]?.content?.parts || [];
  let analysisText = '';
  for (let i = analysisParts.length - 1; i >= 0; i--) {
    if (analysisParts[i].text) { analysisText = analysisParts[i].text; break; }
  }

  return { analysis: analysisText, transcript };
}

// ── SEO Caption Generation ──────────────────────────────────

async function generateSeoCaption(
  content: string,
  description: string,
  videoAnalysis: string | null,
): Promise<Record<string, unknown> | null> {
  // Read shared knowledge from Supabase
  const { data: skeletons } = await supabase.from('seo_title_skeletons').select('*');
  const { data: examples } = await supabase.from('seo_viral_examples').select('*').limit(5);
  const { data: trackerData } = await supabase.from('seo_trackers').select('*').eq('id', 'style_tracker').single();

  const recentHooks = trackerData?.data?.recent_hooks || [];
  const exampleText = examples?.map((e: any) => `[${e.angle || e.category}] ${e.content}`).join('\n') || '（無）';

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
  const prompt = `你是 NLP 神經語言學行銷專家。審核以下 IG SEO 文案，用 NLP 技巧強化說服力。

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
  // Read skeletons from Supabase
  const { data: skeletons } = await supabase.from('seo_title_skeletons').select('*');
  const { data: trackerData } = await supabase.from('seo_trackers').select('*').eq('id', 'title_tracker').single();
  const { data: examples } = await supabase.from('seo_viral_examples').select('*').eq('type', 'title').limit(10);

  const tracker = trackerData?.data || {};
  const recentSkeletons = tracker.recent_skeletons || [];
  const recentAngles = tracker.recent_angles || [];
  const angles = ['痛點', '反差', '數字', '場景', '挑戰', '權威', '結果', '否定'];

  // Select 5 different skeletons and angles
  const availableSkeletons = (skeletons || []).filter((s: any) => !recentSkeletons.slice(-5).includes(s.id));
  const availableAngles = angles.filter(a => !recentAngles.slice(-5).includes(a));

  const skeletonText = (availableSkeletons.length >= 5 ? availableSkeletons : skeletons || [])
    .slice(0, 5)
    .map((s: any) => `- ${s.id}: ${s.pattern}（例：${s.example}）`)
    .join('\n');

  const angleText = (availableAngles.length >= 5 ? availableAngles : angles).slice(0, 5).join('、');
  const exampleText = (examples || []).map((e: any) => `- [${e.angle}] ${e.content}`).join('\n') || '（無）';

  const recentUsed = (tracker.recent_titles || [])
    .slice(-10)
    .map((t: any) => `[${t.angle}+${t.skeleton_id}] ${t.title}`)
    .join('\n') || '（無）';

  const prompt = `你是「簡單歌唱 Singple.」的 YouTube 標題專家。目標：讓陌生人停下來點擊。

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
  const prompt = `你是 YouTube 標題 NLP 審核專家。逐一審核以下 ${titles.length} 個標題。

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
      // Always use YouTube actual number + 1, never increment locally
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
  // Update style tracker
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

  // Update title tracker
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
  // Read job
  const { data: job } = await supabase.from('seo_jobs').select('*').eq('id', jobId).single();
  if (!job) throw new Error(`Job ${jobId} not found`);

  const fileKey = job.file_key;
  const fileSize = job.file_size || 0;
  const description = job.description || '';
  await updateJobProgress(jobId, 5, 'starting', '開始處理...', onProgress);
  await supabase.from('seo_jobs').update({ status: 'processing' }).eq('id', jobId);

  // All videos → Gemini direct analysis (no FFmpeg needed)
  const result = await analyzeVideoWithGemini(fileKey, description, jobId, onProgress);
  const content = result.transcript;
  const videoAnalysis: string | null = result.analysis;

  // Generate SEO caption + YouTube titles IN PARALLEL
  await updateJobProgress(jobId, 45, 'generating_caption', '並行生成 SEO 文案 + YouTube 標題...', onProgress);
  const [captionRaw, titlesRaw] = await Promise.all([
    generateSeoCaption(content, description, videoAnalysis),
    generateYouTubeTitles(content, {} as any, videoAnalysis), // no caption dependency for titles
  ]);
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

  // Update shared trackers
  await updateTrackers(caption, titles);

  // Save results (preserve thumbnail from initial upload)
  await updateJobProgress(jobId, 95, 'saving', '儲存結果...', onProgress);
  const existingThumbnail = job.caption?.thumbnail;
  if (existingThumbnail) caption.thumbnail = existingThumbnail;

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

  // Clean up: /tmp immediately, R2 after 48 hours
  if (fileKey.startsWith('/tmp/')) {
    const tmpDir = fileKey.replace(/\/video\.mp4$/, '');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log(`[SEO] Cleaned up tmp: ${tmpDir}`);
  } else {
    setTimeout(() => {
      deleteR2Object(fileKey).catch(() => {});
    }, 48 * 3600 * 1000);
  }

  return { caption, titles, episodeNumber, transcript: content };
}
