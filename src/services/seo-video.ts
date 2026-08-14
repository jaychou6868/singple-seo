/**
 * SEO Video Service — 影片 SEO 文案 + YouTube 標題生成
 *
 * 流程：前端直傳 GCS → 服務端下載 → ffmpeg 抽音軌/截圖 →
 *       faster-whisper 容器內轉錄 → gpt-5.6-terra 分析＋生成
 *
 * 2026-07-10 從 Gemini 全面遷移到 OpenAI：Google 帳務事故後所有 Gemini key
 * 作廢（400 API_KEY_INVALID），Karen 拍板改用 gpt-5.6-terra（5.6 家族中階層）。
 * GPT-5.6 全家族（sol/terra/luna）都不支援原生影片/音訊輸入（官方 modality 表
 * video ✗ audio ✗，實測丟 mp4 回 400 invalid_image_format），故影片理解改為
 * 「轉錄文字＋畫面截圖」組合。
 *
 * 2026-08-14 全面脫離 OpenAI 按量計費：
 *   - 文字生成 → ChatGPT 訂閱橋接（見 aiGateway.ts）
 *   - 音軌轉錄 → 容器內 faster-whisper（見 scripts/transcribe.py）
 * 起因是按量帳號餘額歸零（429 credit_balance_exhausted），轉錄整條是壞的。
 * 訂閱端點沒有轉錄介面，所以轉錄不是「改省錢」而是「改成能跑」。
 * 本檔案已不再需要 OPENAI_API_KEY。
 *
 * 生成: gpt-5.6-terra（走訂閱額度，成本 0）
 * 審核: gpt-5.6-terra NLP 審核
 * 轉錄: faster-whisper large-v3-turbo（容器內 CPU，免費）
 * 編號: YouTube Data API v3
 */

import { Storage } from '@google-cloud/storage';
import { createClient } from '@supabase/supabase-js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectDiverseSkeletons, buildDiversityConstraint, getRecentDNA, recordDNA } from './dna-tracker.js';
import type { CaptionDNA } from './dna-tracker.js';
import { preHint, postReview } from './nlp_kb_client.js';
import { reportUsage } from './usage-reporter.js';
import { AI_CHAT_URL, AI_CHAT_KEY, AI_PROVIDER } from './aiGateway.js';

// ── Config ──────────────────────────────────────────────────

const GCS_BUCKET_NAME = 'singple-seo-videos';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = 'UCo3Z0bh4OnwPL5z4rMwNqbg';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const OPENAI_MODEL = 'gpt-5.6-terra';

// 容器內轉錄。模型與參數在 scripts/transcribe.py，這裡只負責叫它。
const TRANSCRIBE_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', 'scripts', 'transcribe.py',
);
const PYTHON_BIN = process.env.PYTHON_BIN || '/opt/venv/bin/python3';

const execFileAsync = promisify(execFile);

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

// ── GCS helpers ────────────────────────────────────────────

/** Delete a GCS object by its gs:// URI */
export async function deleteGcsObject(gcsUri: string): Promise<void> {
  const path = gcsUri.replace(`gs://${GCS_BUCKET_NAME}/`, '');
  await gcsBucket.file(path).delete();
  console.log(`[SEO] GCS deleted: ${path}`);
}

// ── OpenAI API（gpt-5.6-terra）───────────────────────────────
// GPT-5 系列雷點：不支援自訂 temperature/top_p（硬塞回 400）、
// 要用 max_completion_tokens 不是 max_tokens。

async function callLuna(
  prompt: string,
  systemPrompt?: string,
  feature = 'seo-video',
  imageDataUrls: string[] = [],
): Promise<string> {
  // 檢查實際會用到的那把（走橋接是 AI_GATEWAY_KEY，沒設才退回 OPENAI_API_KEY）。
  // 以前這裡檢查 OPENAI_API_KEY，但呼叫時用的是 AI_CHAT_KEY——只設橋接金鑰時
  // 會誤報「未設定」讓功能整個不能用。
  if (!AI_CHAT_KEY) throw new Error('AI_GATEWAY_KEY / OPENAI_API_KEY 皆未設定');

  const userContent: unknown = imageDataUrls.length
    ? [
        ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: prompt },
      ]
    : prompt;

  const messages: Record<string, unknown>[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userContent });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch(AI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_CHAT_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        max_completion_tokens: 16384,
      }),
      signal: controller.signal,
    });

    const data = await res.json() as Record<string, any>;

    // Report AI usage (fire-and-forget).
    const usage = data?.usage;
    if (usage) {
      reportUsage({
        feature,
        provider: AI_PROVIDER,
        model: data?.model || OPENAI_MODEL,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      });
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!res.ok || !text) {
      throw new Error(`${OPENAI_MODEL} returned no text: ${JSON.stringify(data).substring(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ── ffmpeg helpers ──────────────────────────────────────────

async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

/** 抽音軌 → 單聲道 16kHz WAV（whisper 的原生格式，不再經過一次有損壓縮）。
 *
 * 以前切成 5 分鐘一段是因為 gpt-4o transcribe 輸出有 2048 token 上限、超過會
 * 靜默截斷。本地模型沒這個上限，所以整支一次轉，讓模型保有完整上下文。
 * 一小時的影片約 115MB WAV，跟原始影片比起來不算什麼。 */
async function extractAudio(videoPath: string, dir: string): Promise<string> {
  const out = path.join(dir, 'audio.wav');
  await execFileAsync('ffmpeg', [
    '-y', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    out,
  ], { timeout: 600000 });
  return out;
}

/** 抽 2 張畫面截圖（720px 寬 jpeg）給 terra 看畫面；失敗不阻擋（轉錄文字才是主體） */
async function extractFrames(videoPath: string, dir: string, duration: number): Promise<string[]> {
  const times = duration > 4 ? [duration * 0.25, duration * 0.6] : [0];
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const p = path.join(dir, `frame-${i}.jpg`);
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-ss', times[i].toFixed(2), '-i', videoPath,
        '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4',
        p,
      ], { timeout: 60000 });
      out.push(p);
    } catch (err) {
      console.warn(`[SEO] frame extract failed @${times[i].toFixed(1)}s:`, (err as Error).message);
    }
  }
  return out;
}

/** 音檔 → 逐字稿（容器內 faster-whisper，不打外部 API、不花錢）。
 *
 * 用 spawn 而不是 execFile：execFile 會等程式跑完才把 stdout 交出來，長影片
 * 就完全沒有中途進度。而 seo-routes 有「30 分鐘沒更新 updated_at 就判定殭屍」
 * 的守衛，一支一小時的影片轉到一半會被自己人判死。所以這裡逐行讀進度，
 * 每前進一段就回報一次。 */
export async function transcribeAudio(
  audioPath: string,
  durationSec: number,
  onSeconds?: (seconds: number) => void,
): Promise<string> {
  // 沒有固定總時限，改用「閒置看門狗」：只要還在吐進度就讓它跑，
  // 連續 10 分鐘沒有任何輸出才判定卡死。這樣既不會誤殺長影片，
  // 也不會讓真的當掉的程序無限期佔著任務。
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [TRANSCRIBE_SCRIPT, audioPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let text: string | null = null;
    let settled = false;
    let stderrTail = '';
    let idleTimer: NodeJS.Timeout;

    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      if (err) reject(err); else resolve(value as string);
    };

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`轉錄逾時：連續 ${IDLE_TIMEOUT_MS / 60000} 分鐘沒有進度`));
      }, IDLE_TIMEOUT_MS);
    };
    resetIdle();

    createInterface({ input: child.stdout }).on('line', (line) => {
      resetIdle();
      if (!line.trim()) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        // 轉錄腳本以外的雜訊（套件的 warning 之類）直接忽略，不要讓它毒死整包
        return;
      }
      if (msg.type === 'progress' && typeof msg.seconds === 'number') {
        onSeconds?.(msg.seconds);
      } else if (msg.type === 'env') {
        // 轉錄慢的時候先看這行——容器實際拿到幾核是最常見的原因
        console.log(`[SEO] 轉錄環境：${msg.cpu_count} 核 / ${msg.threads} 執行緒 / ${msg.compute} / beam ${msg.beam}`);
      } else if (msg.type === 'result') {
        text = typeof msg.text === 'string' ? msg.text : '';
        console.log(`[SEO] 轉錄完成：${text.length} 字（音檔 ${msg.duration}s / 影片 ${Math.round(durationSec)}s）`);
      }
    });

    // stderr 只留尾巴——模型會印一堆 warning，全部收下來只會塞爆記憶體，
    // 但出錯時又需要最後那幾行才知道原因。
    child.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000);
    });

    child.on('error', (err) => finish(new Error(`轉錄程序啟動失敗：${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`轉錄程序結束碼 ${code}：${stderrTail.trim().slice(-500) || '（無錯誤訊息）'}`));
        return;
      }
      if (text === null) {
        finish(new Error(`轉錄程序沒有回傳結果：${stderrTail.trim().slice(-500) || '（無錯誤訊息）'}`));
        return;
      }
      finish(null, text);
    });
  });
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

// ── Video Analysis（下載 → 轉錄 → 截圖 → terra 分析）─────────
// exported for smoke testing（_smoke_analyze.mjs 之類的一次性驗證腳本）

export async function analyzeVideo(
  gcsUri: string,
  description: string,
  jobId: string,
  onProgress?: ProgressCallback,
): Promise<{ analysis: string; transcript: string }> {
  await updateJobProgress(jobId, 10, 'preparing', '從雲端下載影片中...', onProgress);

  const workDir = await mkdtemp(path.join(tmpdir(), 'seo-'));
  try {
    const objectPath = gcsUri.replace(`gs://${GCS_BUCKET_NAME}/`, '');
    const videoPath = path.join(workDir, 'video.mp4');
    await gcsBucket.file(objectPath).download({ destination: videoPath });

    const duration = await ffprobeDuration(videoPath);
    console.log(`[SEO] video downloaded: ${objectPath} (${Math.round(duration)}s)`);

    // 轉錄（GPT-5.6 家族不吃音訊 → 音軌轉成文字才是內容主體）
    // 容器內跑 faster-whisper，不打外部 API，所以沒有 reportUsage——
    // 這符合 repo CLAUDE.md 記帳鐵律的例外條款（本地免費模型，同 ollama / MLX）。
    await updateJobProgress(jobId, 12, 'transcribing', `抽取音軌中（片長 ${Math.round(duration)} 秒）...`, onProgress);
    const audioPath = await extractAudio(videoPath, workDir);

    // 進度條 12% → 40% 對應轉錄進度，讓長影片看得出來還在動
    // （同時每次更新都會刷新 updated_at，避開殭屍任務判定）。
    //
    // ⚠️ 一定要「同時只跑一筆、且限流」，不能每段都直接發。whisper 一分鐘影片
    //    就吐 30 段，全部併發寫 Supabase 會亂序完成，進度條在畫面上會
    //    30% → 40% → 32% → 34% 來回跳，看起來像壞掉。
    let writing = false;
    let lastWriteAt = 0;
    const transcript = (
      await transcribeAudio(audioPath, duration, (seconds) => {
        const now = Date.now();
        if (writing || now - lastWriteAt < 5000) return;
        writing = true;
        lastWriteAt = now;
        const ratio = duration > 0 ? Math.min(seconds / duration, 1) : 0;
        void updateJobProgress(
          jobId,
          12 + Math.round(ratio * 28),
          'transcribing',
          `轉錄中 ${Math.round(seconds)} / ${Math.round(duration)} 秒...`,
          onProgress,
        ).catch(() => {}).finally(() => { writing = false; });
      })
    ).trim();
    if (!transcript) throw new Error('轉錄結果為空（影片沒有可辨識的人聲）');

    // 截圖給 terra 看畫面（輔助判斷影片類型；失敗不阻擋）
    await updateJobProgress(jobId, 20, 'analyzing', '分析影片內容中...', onProgress);
    const frames = await extractFrames(videoPath, workDir, duration);
    const frameUrls: string[] = [];
    for (const f of frames) {
      frameUrls.push(`data:image/jpeg;base64,${(await readFile(f)).toString('base64')}`);
    }

    const analysisPrompt = `以下是一支影片的完整逐字稿${frameUrls.length ? '，以及 ' + frameUrls.length + ' 張畫面截圖' : ''}。請根據這些內容分析以下資訊，用繁體中文輸出 JSON：
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

## 影片逐字稿
${transcript.substring(0, 12000)}

## 影片描述
${description || '（無）'}`;

    const analysis = await callLuna(analysisPrompt, undefined, 'seo-video', frameUrls);
    return { analysis, transcript };
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {});
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

  const raw = await callLuna(userPrompt, systemPrompt, 'seo-video');
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

  const raw = await callLuna(prompt, undefined, 'seo-video');
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

  const raw = await callLuna(prompt, undefined, 'seo-video');
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

  const raw = await callLuna(prompt, undefined, 'seo-video');
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

    // YouTube 回 4xx 時 fetch 不會 throw，錯誤只在 body 裡；不明講就會像
    // 2026-07-10～08-14 那樣：金鑰過期整整一個月，標題默默變 #???，日誌一行都沒有。
    if (!res.ok || data.error) {
      console.error(
        `[SEO] YouTube 取集數失敗 (HTTP ${res.status})：`,
        data?.error?.message || JSON.stringify(data).slice(0, 200),
      );
      return null;
    }

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

  const result = await analyzeVideo(fileKey, description, jobId, onProgress);
  const content = result.transcript;
  const videoAnalysis: string | null = result.analysis;

  // Generate SEO caption + YouTube titles IN PARALLEL
  await updateJobProgress(jobId, 45, 'generating_caption', '並行生成 SEO 文案 + YouTube 標題...', onProgress);
  const [captionRaw, titlesRaw] = await Promise.all([
    generateSeoCaption(content, description, videoAnalysis),
    generateYouTubeTitles(content, {} as any, videoAnalysis),
  ]);
  let caption = captionRaw;
  if (!caption) throw new Error('SEO caption generation failed');
  caption.source_model = OPENAI_MODEL;
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

  await supabase.from('seo_jobs').update({
    status: 'done',
    progress: 100,
    stage: 'done',
    stage_detail: '完成！',
    transcript: content.substring(0, 10000),
    caption: caption,
    titles: titles,
    episode_number: episodeNumber,
    model_used: OPENAI_MODEL,
    video_type: job.video_type || 'auto',
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  // Clean up GCS file after processing
  deleteGcsObject(fileKey).catch((err) => {
    console.error(`[SEO] GCS cleanup failed: ${err}`);
  });

  return { caption, titles, episodeNumber, transcript: content };
}
