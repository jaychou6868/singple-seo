/**
 * NLP KB API Client for TypeScript (singple-seo side).
 *
 * Mirrors the Python version in cmo/knowledge-base/external_apis/core/
 * so both Python and TypeScript hooks use the same API/cache semantics.
 *
 * Feature flag: set USE_NLP_KB=true in Zeabur env to enable.
 * Default: OFF (all drop-in functions return null, existing code unchanged).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type NLPMode = 'naive' | 'local' | 'global' | 'hybrid' | 'mix';

export interface AskResult {
  answer: string;
  knowledge_retrieved: boolean;
  mode: NLPMode;
  query: string;
  elapsed: number;
  refused: boolean;
  timestamp: number;
  ensemble?: boolean;
  ensemble_used_modes?: NLPMode[];
}

const REFUSAL_MARKERS = [
  '沒有直接對應',
  '超出目前知識庫',
  '超出我的知識庫',
  '建議查閱原始資料',
  '建議您參考',
  '諮詢專家',
  '不在知識庫',
  '知識庫中沒有',
];

/**
 * Global feature flag check. Honors USE_NLP_KB env var.
 * Set USE_NLP_KB=true in Zeabur env to enable.
 */
export function isNLPKBEnabled(): boolean {
  const v = (process.env.USE_NLP_KB || 'false').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

// ═══════════════════════════════════════════════════════════
// Client
// ═══════════════════════════════════════════════════════════

export class NLPKBClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private maxRetries: number;
  private cacheDir: string;
  private cacheTtlMs: number;

  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    timeout?: number;
    maxRetries?: number;
    cacheDir?: string;
  } = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.NLP_KB_BASE_URL ||
      'https://psyainz-nlp-api-v1.zeabur.app'
    ).replace(/\/$/, '');
    this.apiKey = options.apiKey || process.env.NLP_KB_API_KEY || '';
    this.timeout = options.timeout || parseInt(process.env.NLP_KB_TIMEOUT_SECONDS || '60', 10) * 1000;
    this.maxRetries = options.maxRetries ?? parseInt(process.env.NLP_KB_MAX_RETRIES || '2', 10);
    this.cacheDir = options.cacheDir || path.join(process.cwd(), '.nlp_kb_cache');
    const ttlDays = parseInt(process.env.NLP_KB_CACHE_TTL_DAYS || '30', 10);
    this.cacheTtlMs = ttlDays * 86400 * 1000;

    if (!this.apiKey) {
      console.warn('[nlp_kb] NLP_KB_API_KEY not set — ask() will fail');
    }

    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // Ignore — cache is best effort
    }
  }

  private cacheKey(query: string, mode: NLPMode): string {
    const normalized = `${query.trim().toLowerCase()}|${mode}`;
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }

  private cacheGet(query: string, mode: NLPMode): AskResult | null {
    const key = this.cacheKey(query, mode);
    const cachePath = path.join(this.cacheDir, `${key}.json`);
    if (!fs.existsSync(cachePath)) return null;
    try {
      const stats = fs.statSync(cachePath);
      if (Date.now() - stats.mtimeMs > this.cacheTtlMs) return null;
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  private cacheSet(query: string, mode: NLPMode, result: AskResult): void {
    const key = this.cacheKey(query, mode);
    const cachePath = path.join(this.cacheDir, `${key}.json`);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8');
    } catch (e) {
      console.warn('[nlp_kb] cache write failed:', (e as Error).message);
    }
  }

  private isRefused(answer: string): boolean {
    if (!answer || answer.trim().length < 50) return true;
    return REFUSAL_MARKERS.some((m) => answer.includes(m));
  }

  async ask(
    query: string,
    mode: NLPMode = 'local',
    useCache = true,
    employeeId = 'karen',
  ): Promise<AskResult | null> {
    if (!query || !query.trim()) return null;

    // 1. Cache check
    if (useCache) {
      const cached = this.cacheGet(query, mode);
      if (cached) return cached;
    }

    // 2. HTTP with retry
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const start = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeout);

        const response = await fetch(`${this.baseUrl}/ask/nlp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.apiKey,
          },
          body: JSON.stringify({
            employee_id: employeeId,
            question: query,
            mode,
          }),
          signal: ctrl.signal,
        });

        clearTimeout(timer);
        const elapsed = (Date.now() - start) / 1000;

        if (!response.ok) {
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < this.maxRetries) {
            const backoff = 2 ** attempt * 1000;
            console.warn(`[nlp_kb] HTTP ${response.status}, retry in ${backoff}ms`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          console.error(`[nlp_kb] HTTP ${response.status} [${mode}]: ${query.substring(0, 40)}`);
          return null;
        }

        const data = (await response.json()) as { answer?: string; knowledge_retrieved?: boolean };
        const answer = data.answer || '';
        const refused = this.isRefused(answer);

        const result: AskResult = {
          answer,
          knowledge_retrieved: Boolean(data.knowledge_retrieved),
          mode,
          query,
          elapsed: Math.round(elapsed * 100) / 100,
          refused,
          timestamp: Date.now(),
        };

        if (useCache) {
          this.cacheSet(query, mode, result);
        }

        console.log(`[nlp_kb] [${mode}] ask ok (${answer.length} chars, ${elapsed.toFixed(1)}s, refused=${refused})`);
        return result;
      } catch (e) {
        const err = e as { name?: string; message?: string; code?: string };
        if (attempt < this.maxRetries) {
          const backoff = 2 ** attempt * 1000;
          console.warn(`[nlp_kb] error, retry in ${backoff}ms: ${err.message}`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        console.error(`[nlp_kb] error after retries: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  async askEnsemble(
    query: string,
    modes: NLPMode[] = ['naive', 'local', 'global'],
  ): Promise<AskResult | null> {
    const results: AskResult[] = [];
    for (const m of modes) {
      const r = await this.ask(query, m);
      if (r && !r.refused) results.push(r);
    }
    if (results.length === 0) return null;

    // Pick longest (richest) as the final answer
    const best = results.reduce((a, b) => (a.answer.length > b.answer.length ? a : b));
    return {
      ...best,
      ensemble: true,
      ensemble_used_modes: results.map((r) => r.mode),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      const data = (await r.json()) as { status?: string };
      return data.status === 'ok';
    } catch {
      return false;
    }
  }
}

// Singleton
let _defaultClient: NLPKBClient | null = null;

export function getNLPKBClient(): NLPKBClient {
  if (!_defaultClient) _defaultClient = new NLPKBClient();
  return _defaultClient;
}

// ═══════════════════════════════════════════════════════════
// Query translator — Karen → NLP KB
// ═══════════════════════════════════════════════════════════

const QUERY_RULES: Array<[RegExp, string]> = [
  [/email.*hook|信.*開頭|信.*hook/i, '行銷文案的開頭 hook 用什麼 NLP 技巧最能抓住注意力？封閉性操作、預設前提、同步引導哪個比較適合？'],
  [/email.*cta|信.*cta|信.*行動/i, '行銷文案的 CTA 用什麼 NLP 技巧最能提升點擊率？雙重束縛、損失框架、隱含指令怎麼應用？'],
  [/email.*審|信.*審|信.*評/i, '從 NLP 角度審核這封行銷信件：米爾頓模式、薩提爾四型、痛點三層挖掘分別怎麼評估？'],
  [/信件生成|寫信|寫封信/i, 'Karen 老師的信件撰寫 NLP 框架：hook 技巧、情緒弧線、CTA 設計'],
  [/講稿.*開場|講稿.*hook|影片.*開場/i, '短影音前 3 秒 hook 的 NLP 技巧：封閉性操作、讀心術、痛點暗示、反差對比怎麼選？'],
  [/講稿.*結尾|講稿.*cta/i, '短影音結尾 CTA 的 NLP 技巧：未來模擬、損失框架、雙重束縛的實作範例'],
  [/講稿.*生成|寫講稿|生成.*講稿/i, '歌唱教學短影音的 NLP 說服框架：hook、痛點深化、解方、情緒弧線、CTA'],
  [/youtube.*標題|標題.*生成|yt.*標題/i, 'YouTube 標題的 NLP 心理學技巧：好奇心缺口、損失框架、數字錨定、反差對比、具體場景'],
  [/標題.*審|標題.*評/i, '從 NLP 角度審核 YouTube 標題：點擊率驅動因子、AI 感檢測、承諾一致性'],
  [/ig.*caption|caption|reels/i, 'IG Reels 短影音 caption 的 NLP 技巧：hook 封閉性、痛點暗示、價值前置、CTA 引導'],
  [/seo.*文案|seo.*caption/i, 'IG SEO 文案的 NLP 說服結構：hook、痛點、解方、社會證明、CTA'],
  [/ig.*dm|instagram.*dm|dm.*文案|自動回覆/i, 'Instagram DM 自動回覆的 NLP 框架：同步引導、個人化預設、行動號召'],
  [/痛點/, 'NLP 的痛點三層挖掘方法（表層、生活影響、自我認同威脅）怎麼在教學產業應用？'],
  [/reframe|重新框架|換框/i, 'NLP 框架重置（reframing）的六種技巧：情境換框、意義換框、人稱換框、正向意圖、自我強化、深層結構'],
  [/爆款|病毒|viral/i, '從 NLP 角度分析爆款短影音的共同結構：hook 類型、痛點層次、情緒觸發、CTA 模式'],
];

export function karenToNlp(karenQuery: string, context?: string): string {
  const q = karenQuery.trim().toLowerCase();
  for (const [pattern, translated] of QUERY_RULES) {
    if (pattern.test(q)) {
      return context ? `${translated}\n\n上下文：${context}` : translated;
    }
  }
  if (/email|信/.test(q)) return `行銷文案的 NLP 技巧：${karenQuery}`;
  if (/講稿|影片|腳本/.test(q)) return `短影音腳本的 NLP 說服框架：${karenQuery}`;
  if (/標題/.test(q)) return `標題設計的 NLP 心理學技巧：${karenQuery}`;
  if (/caption|貼文|文案/.test(q)) return `社群貼文的 NLP 框架：${karenQuery}`;
  return `從 NLP 神經語言學角度：${karenQuery}`;
}

export function queryForReview(content: string, contentType = '文案'): string {
  if (!content || !content.trim()) return '';
  const snippet = content.substring(0, 600) + (content.length > 600 ? '...(truncated)' : '');
  return `從 NLP 角度審核以下${contentType}，指出它用了哪些 NLP 技巧（米爾頓模式、薩提爾、痛點挖掘、reframing、損失框架等），並給出可以加強的 3 個具體建議：\n\n${snippet}`;
}

export function queryForExtraction(sourceText: string, sourceType = '逐字稿'): string {
  const snippet = sourceText.substring(0, 800) + (sourceText.length > 800 ? '...(truncated)' : '');
  return `從以下${sourceType}中，提取可複用的 NLP 模式和話術。請識別其中用到的 hook 類型、痛點層次、CTA 框架、情緒觸發點，並說明這些模式在教學產業的複用方式：\n\n${snippet}`;
}

// ═══════════════════════════════════════════════════════════
// Content type → pure NLP query lookup
// ═══════════════════════════════════════════════════════════
//
// CRITICAL DESIGN: 跟 Python 版相同 — topic 是 Karen 的領域（歌唱），
// NLP KB 不懂。所以 preHint 只用 content_type 問純 NLP 理論問題，
// topic 留在 generator 自己處理。
//
// 好處：
// 1. NLP KB 拿到通用問題 → 容易答、不 refused
// 2. 同 content_type 共用 cache → 省 API call
// ═══════════════════════════════════════════════════════════

const CONTENT_TYPE_NLP_QUERIES: Record<string, string> = {
  '行銷信件': '行銷信件的 NLP 寫作技巧：hook 開頭、情緒弧線、CTA 行動呼籲、reframing、痛點三層挖掘',
  'email': '行銷信件的 NLP 寫作技巧：hook 開頭、情緒弧線、CTA 行動呼籲、reframing、痛點三層挖掘',
  '行銷文案': '行銷文案的 NLP 寫作技巧：米爾頓模式、封閉性操作、損失框架、嵌入式指令',
  '短影音講稿': '短影音講稿的 NLP 說服框架：3 秒 hook、痛點三層挖掘、reframing、未來模擬、CTA 設計',
  '講稿': '短影音講稿的 NLP 說服框架：3 秒 hook、痛點三層挖掘、reframing、未來模擬、CTA 設計',
  'IG SEO 文案': 'IG Reels 短影音 caption 的 NLP 技巧：hook 封閉性操作、痛點暗示、價值前置、CTA 引導',
  'IG 文案': 'IG Reels 短影音 caption 的 NLP 技巧：hook 封閉性操作、痛點暗示、價值前置、CTA 引導',
  'IG caption': 'IG Reels 短影音 caption 的 NLP 技巧：hook 封閉性操作、痛點暗示、價值前置、CTA 引導',
  'YouTube 標題': 'YouTube 標題的 NLP 心理學技巧：好奇心缺口、損失框架、數字錨定、反差對比、具體場景',
  '標題': 'YouTube 標題的 NLP 心理學技巧：好奇心缺口、損失框架、數字錨定、反差對比、具體場景',
  '教學簡報': '教學簡報的 NLP 說服結構：Authority Anchor、Submodality Shift、Embedded Command、Future Pacing',
  '簡報': '教學簡報的 NLP 說服結構：Authority Anchor、Submodality Shift、Future Pacing',
  'IG DM': 'Instagram DM 文案的 NLP 技巧：同步引導、個人化預設、嵌入式指令、行動號召',
  'Instagram DM': 'Instagram DM 文案的 NLP 技巧：同步引導、個人化預設、嵌入式指令、行動號召',
  '縮圖大字': '影片縮圖大字的 NLP 心理學技巧：封閉性操作、反差對比、情緒觸發、具體數字',
};

export function contentTypeToNlpQuery(contentType: string): string {
  // Exact match
  if (CONTENT_TYPE_NLP_QUERIES[contentType]) {
    return CONTENT_TYPE_NLP_QUERIES[contentType];
  }
  // Substring match
  const ctLower = contentType.toLowerCase();
  for (const [key, query] of Object.entries(CONTENT_TYPE_NLP_QUERIES)) {
    if (key.toLowerCase().includes(ctLower) || ctLower.includes(key.toLowerCase())) {
      return query;
    }
  }
  // Fallback
  return `${contentType}的 NLP 寫作技巧：hook、痛點挖掘、情緒弧線、CTA 設計`;
}

// ═══════════════════════════════════════════════════════════
// Prompt Architect — 4-stage NLP KB consultation (TS version)
// ═══════════════════════════════════════════════════════════
//
// 跟 Python 版（class_a_generator.py）相同的架構：
//   Stage 1 (Framework)  — per content_type, TTL 7 days
//   Stage 2 (Hook)       — per (topic, content_type), TTL 24h
//   Stage 3 (Pain Point) — per topic, TTL 3 days
//   Stage 4 (CTA)        — per (topic, content_type), TTL 24h
//
// Zeabur 容器內用 filesystem cache (`.nlp_kb_cache/architect/`).
// ═══════════════════════════════════════════════════════════

export function isArchitectEnabled(): boolean {
  const v = (process.env.NLP_KB_ARCHITECT || 'true').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

const ARCHITECT_CACHE_DIR = path.join(process.cwd(), '.nlp_kb_cache', 'architect');

const FRAMEWORK_TTL_HOURS = 24 * 7;  // 1 week
const HOOK_TTL_HOURS = 24;
const PAIN_TTL_HOURS = 24 * 3;       // 3 days
const CTA_TTL_HOURS = 24;

const ARCHITECT_MAX_PROMPT_LENGTH = 2500;

interface ArchitectStage {
  stage: string;
  rawAnswer: string;
  karenHint: string;
  cachedAt: string;
}

interface ArchitectResult {
  topic: string;
  contentType: string;
  framework: ArchitectStage | null;
  hook: ArchitectStage | null;
  painPoint: ArchitectStage | null;
  cta: ArchitectStage | null;
  totalElapsed: number;
  cachedAt: string;
}

function safeFilename(s: string): string {
  return s.replace(/[^\w\u4e00-\u9fff-]/g, '_').substring(0, 60);
}

function stageCachePath(stage: string, ...keyParts: string[]): string {
  const key = keyParts.filter(Boolean).map(safeFilename).join('_');
  return path.join(ARCHITECT_CACHE_DIR, stage, `${key}.json`);
}

function stageCacheGet(stage: string, ttlHours: number, ...keyParts: string[]): ArchitectStage | null {
  const filePath = stageCachePath(stage, ...keyParts);
  if (!fs.existsSync(filePath)) return null;
  try {
    const stats = fs.statSync(filePath);
    if (Date.now() - stats.mtimeMs > ttlHours * 3600 * 1000) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function stageCacheSet(stage: string, data: ArchitectStage, ...keyParts: string[]): void {
  const filePath = stageCachePath(stage, ...keyParts);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[nlp_kb] stage cache write failed:', (e as Error).message);
  }
}

// ─── Stage queries ───

function qFramework(contentType: string): string {
  return `${contentType}的寫作 NLP 主框架是什麼？請推薦 1 個主框架（從痛點三層挖掘、封閉性操作、反常識對比、損失框架、未來模擬 中選），說明核心操作步驟和應用方式。`;
}

function qHook(topic: string, contentType: string, frameworkContext: string): string {
  return `「${contentType}」的開頭 Hook 怎麼寫？主題是「${topic}」（歌唱教學領域）。配合已選的主框架：${frameworkContext.substring(0, 300)}

給 3 個具體 hook 版本，每個用不同技巧：
- 版本 A：用「封閉性操作」（不說完、讓讀者腦補）
- 版本 B：用「反常識對比」（顛覆讀者既有認知）
- 版本 C：用「痛點直擊」（直接說出讀者心裡的話）

每個 hook 25-35 字，台灣日常口語，避免「你是不是」這種太老套的開頭。給具體的句子，不是描述怎麼寫。`;
}

function qPainPoint(topic: string): string {
  return `主題「${topic}」（歌唱教學領域）的 NLP 痛點三層挖掘：

- **L1 表層症狀**：學員直接能說出的困擾（例如「唱高音會破」）— 給 2 句具體描述
- **L2 生活影響**：這個困擾如何實際影響他的生活（例如「KTV 輪到自己都找藉口不唱」）— 給 2 句具體描述
- **L3 自我認同威脅**：背後的自我否定（例如「覺得自己就是沒天分、不適合唱歌」）— 給 2 句具體描述

每一層都要讓讀者覺得「這就是在說我」。用台灣口語。`;
}

function qCta(topic: string, contentType: string, hookContext: string, painContext: string): string {
  return `「${contentType}」的 CTA 設計，主題「${topic}」。

上面的 Hook:
${hookContext.substring(0, 400)}

上面的痛點:
${painContext.substring(0, 400)}

設計 3 個 CTA 版本，每個 15-30 字：
- **緊迫型**：用「損失框架」強調不做的代價
- **希望型**：用「未來模擬」描繪改變後的畫面
- **中性型**：用「同步引導」（2 句認同 + 1 句引導行動）

要明確告訴讀者下一步做什麼。用台灣日常口語。`;
}

// ─── Stage runners ───

async function runStageFramework(contentType: string): Promise<ArchitectStage | null> {
  const cached = stageCacheGet('framework', FRAMEWORK_TTL_HOURS, contentType);
  if (cached) {
    console.log(`[nlp_kb] S1 cache hit: ${contentType}`);
    return cached;
  }

  const client = getNLPKBClient();
  const response = await client.ask(qFramework(contentType), 'local');
  if (!response || response.refused) {
    console.warn(`[nlp_kb] S1 refused: ${contentType}`);
    return null;
  }

  const karenHint = await academicToKaren(response.answer, `${contentType} - 框架選擇`);
  const result: ArchitectStage = {
    stage: 'framework',
    rawAnswer: response.answer,
    karenHint,
    cachedAt: new Date().toISOString(),
  };
  stageCacheSet('framework', result, contentType);
  return result;
}

async function runStageHook(topic: string, contentType: string, frameworkHint: string): Promise<ArchitectStage | null> {
  const cached = stageCacheGet('hook', HOOK_TTL_HOURS, topic, contentType);
  if (cached) {
    console.log(`[nlp_kb] S2 cache hit: ${topic}+${contentType}`);
    return cached;
  }

  const client = getNLPKBClient();
  const response = await client.ask(qHook(topic, contentType, frameworkHint), 'local');
  if (!response || response.refused) {
    console.warn(`[nlp_kb] S2 refused: ${topic}+${contentType}`);
    return null;
  }

  const karenHint = await academicToKaren(response.answer, `${contentType} - Hook 設計`);
  const result: ArchitectStage = {
    stage: 'hook',
    rawAnswer: response.answer,
    karenHint,
    cachedAt: new Date().toISOString(),
  };
  stageCacheSet('hook', result, topic, contentType);
  return result;
}

async function runStagePainPoint(topic: string): Promise<ArchitectStage | null> {
  const cached = stageCacheGet('pain_point', PAIN_TTL_HOURS, topic);
  if (cached) {
    console.log(`[nlp_kb] S3 cache hit: ${topic}`);
    return cached;
  }

  const client = getNLPKBClient();
  const response = await client.ask(qPainPoint(topic), 'local');
  if (!response || response.refused) {
    console.warn(`[nlp_kb] S3 refused: ${topic}`);
    return null;
  }

  const karenHint = await academicToKaren(response.answer, `主題「${topic}」- 痛點三層挖掘`);
  const result: ArchitectStage = {
    stage: 'pain_point',
    rawAnswer: response.answer,
    karenHint,
    cachedAt: new Date().toISOString(),
  };
  stageCacheSet('pain_point', result, topic);
  return result;
}

async function runStageCta(topic: string, contentType: string, hookHint: string, painHint: string): Promise<ArchitectStage | null> {
  const cached = stageCacheGet('cta', CTA_TTL_HOURS, topic, contentType);
  if (cached) {
    console.log(`[nlp_kb] S4 cache hit: ${topic}+${contentType}`);
    return cached;
  }

  const client = getNLPKBClient();
  const response = await client.ask(qCta(topic, contentType, hookHint, painHint), 'local');
  if (!response || response.refused) {
    console.warn(`[nlp_kb] S4 refused: ${topic}+${contentType}`);
    return null;
  }

  const karenHint = await academicToKaren(response.answer, `${contentType} - CTA 設計`);
  const result: ArchitectStage = {
    stage: 'cta',
    rawAnswer: response.answer,
    karenHint,
    cachedAt: new Date().toISOString(),
  };
  stageCacheSet('cta', result, topic, contentType);
  return result;
}

/**
 * Prompt Architect — 4-stage NLP KB consultation.
 *
 * Runs Framework → PainPoint → Hook → CTA (S4 uses S2+S3 as context).
 * Uses stage-level cache to share between generators on same day.
 */
export async function getArchitect(
  topic: string,
  contentType: string,
): Promise<ArchitectResult | null> {
  if (!isNLPKBEnabled()) return null;

  const result: ArchitectResult = {
    topic,
    contentType,
    framework: null,
    hook: null,
    painPoint: null,
    cta: null,
    totalElapsed: 0,
    cachedAt: new Date().toISOString(),
  };

  const tStart = Date.now();

  // S1: framework
  try {
    result.framework = await runStageFramework(contentType);
  } catch (e) {
    console.warn('[nlp_kb] S1 exception:', (e as Error).message);
  }

  // S3: pain_point (independent, run before S2)
  try {
    result.painPoint = await runStagePainPoint(topic);
  } catch (e) {
    console.warn('[nlp_kb] S3 exception:', (e as Error).message);
  }

  // S2: hook (needs framework context)
  try {
    const frameworkHint = result.framework?.karenHint || '';
    result.hook = await runStageHook(topic, contentType, frameworkHint);
  } catch (e) {
    console.warn('[nlp_kb] S2 exception:', (e as Error).message);
  }

  // S4: cta (needs hook + pain_point context)
  try {
    const hookHint = result.hook?.karenHint || '';
    const painHint = result.painPoint?.karenHint || '';
    result.cta = await runStageCta(topic, contentType, hookHint, painHint);
  } catch (e) {
    console.warn('[nlp_kb] S4 exception:', (e as Error).message);
  }

  result.totalElapsed = (Date.now() - tStart) / 1000;

  // Return null only if ALL stages failed
  const anyOk = result.framework || result.hook || result.painPoint || result.cta;
  if (!anyOk) {
    console.warn(`[nlp_kb] architect: all stages failed for ${topic}+${contentType}`);
    return null;
  }

  return result;
}

/**
 * Format architect dict into a markdown prompt block to inject into generator.
 */
export function formatArchitectAsPrompt(architect: ArchitectResult, maxLength = ARCHITECT_MAX_PROMPT_LENGTH): string {
  if (!architect) return '';

  const topic = architect.topic;
  const ct = architect.contentType;

  const sections: Array<{ key: string; title: string; body: string }> = [];
  if (architect.framework?.karenHint) sections.push({ key: 'framework', title: '📐 主框架選擇', body: architect.framework.karenHint });
  if (architect.painPoint?.karenHint) sections.push({ key: 'pain_point', title: '😢 痛點三層挖掘', body: architect.painPoint.karenHint });
  if (architect.hook?.karenHint) sections.push({ key: 'hook', title: '🎣 Hook 開頭設計', body: architect.hook.karenHint });
  if (architect.cta?.karenHint) sections.push({ key: 'cta', title: '🎯 CTA 行動呼籲設計', body: architect.cta.karenHint });

  if (sections.length === 0) return '';

  const header = [
    `## 🧠 NLP 架構建議（NLP KB 4 階段諮詢產出）`,
    `**主題**：${topic}　**類型**：${ct}`,
    '',
    '以下是專業 NLP 策劃師給的寫作架構建議。請以此為骨架，但全程保持 Karen 的口語風格，不要出現學術術語。',
    '',
  ];

  const footer = [
    '',
    '---',
    '**使用規則**：',
    '1. Hook 從 3 個版本選 1 個最適合，或融合 2 個',
    '2. 痛點挖掘至少要觸及 L2，最好到 L3',
    '3. CTA 從 3 個版本選 1 個，要明確',
    '4. 不要直接貼以上範例，要用 Karen 的口吻重寫',
  ];

  const totalLen = sections.reduce((sum, s) => sum + s.body.length, 0) + 500;
  const ordered: string[] = [];

  if (totalLen <= maxLength) {
    // No truncation needed
    const displayOrder = ['framework', 'pain_point', 'hook', 'cta'];
    const sectionsMap = new Map(sections.map(s => [s.key, s]));
    for (const key of displayOrder) {
      const s = sectionsMap.get(key);
      if (s) ordered.push(`### ${s.title}\n\n${s.body}\n`);
    }
  } else {
    // Truncation priority: cta > hook > pain_point > framework
    const priorityOrder = ['cta', 'hook', 'pain_point', 'framework'];
    const keptBodies = new Map<string, string>();
    let budget = maxLength - 500;
    for (const key of priorityOrder) {
      const s = sections.find(x => x.key === key);
      if (s && budget > 0) {
        if (s.body.length <= budget) {
          keptBodies.set(key, s.body);
          budget -= s.body.length;
        } else {
          keptBodies.set(key, s.body.substring(0, budget) + '\n...(截斷)');
          budget = 0;
        }
      }
    }
    const displayOrder = ['framework', 'pain_point', 'hook', 'cta'];
    const sectionsMap = new Map(sections.map(s => [s.key, s]));
    for (const key of displayOrder) {
      if (keptBodies.has(key)) {
        const s = sectionsMap.get(key)!;
        ordered.push(`### ${s.title}\n\n${keptBodies.get(key)}\n`);
      }
    }
  }

  return [...header, ...ordered, ...footer].join('\n');
}

// ═══════════════════════════════════════════════════════════
// Answer translator — academic → Karen plain hint (Gemini 2.5 Flash)
// ═══════════════════════════════════════════════════════════

const TRANSLATE_SYSTEM_PROMPT = `你是把學術 NLP 理論轉成寫作助手 prompt 的翻譯官。

## 背景
這份 hint 會被塞進**另一個 AI 的 prompt**，當作寫作技巧指引。不是給人看的、是給 AI 看的。
**Karen 是台灣男性歌唱老師，學員男女都有，年齡 25-55 歲**（上班族、創作歌手、想突破的 hobbyist）。
所以**不要**用「妳」「姐妹們」等性別化稱呼，用「你」或「學員」。

## 規則（必須全部遵守）
1. **必須保留原文中所有具體技巧**：原文列了 5 個技巧你就全部保留，一個都不能漏
2. **每個技巧都要給具體操作做法**
3. **每個技巧要有 1-2 個具體範例句**：中性日常台灣口語，不帶性別色彩
4. **去掉學術術語**：不出現「米爾頓模式」「薩提爾」「reframing」「情態動詞」
5. **台灣口語**：不用大陸用語
6. **目標長度**：400-700 字
7. **結構**：用 \`## 技巧 X: 名稱\` heading，每段含【做法】【範例】

直接開始寫，不要開場白。`;

export async function academicToKaren(
  academicAnswer: string,
  targetContext = '行銷文案',
): Promise<string> {
  if (!academicAnswer || academicAnswer.trim().length < 50) return academicAnswer;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[nlp_kb] GEMINI_API_KEY not set, returning truncated raw');
    return academicAnswer.substring(0, 500);
  }

  const userPrompt = `目標應用場景：${targetContext}\n\n學術 NLP 建議：\n${academicAnswer}\n\n請轉換成 Karen 風格的寫作 hint：`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);

    // Model routing: Zeabur 端沒有 Opus 可用，直接用 Gemini 3.1 Pro Preview
    // （對齊 Karen 的 feedback_model_routing.md fallback 層）
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: TRANSLATE_SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2048,
            // Gemini 3.1 Pro Preview 支援 thinking，用 medium 比 Flash 的 0 好
            thinkingConfig: { thinkingLevel: 'medium' },
          },
        }),
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);

    const data = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
    // Filter out thinking parts (Gemini 3.1 Pro Preview 會回 thinking + text parts)
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text: string | undefined;
    for (const part of parts) {
      if (part.text && !part.thought) {
        text = part.text.trim();
        break;
      }
    }
    return text || academicAnswer.substring(0, 500);
  } catch (e) {
    console.warn('[nlp_kb] translator failed:', (e as Error).message);
    return academicAnswer.substring(0, 500);
  }
}

// ═══════════════════════════════════════════════════════════
// Class A — Generator drop-ins
// ═══════════════════════════════════════════════════════════

/**
 * L1: Pre-generation hint — inject NLP technique suggestion BEFORE generating content.
 *
 * Drop-in usage:
 *     const hint = await preHint(topic, 'IG SEO 文案');
 *     if (hint) systemPrompt += `\n\n## NLP 技巧建議\n${hint}`;
 */
export async function preHint(
  topic: string,
  contentType = '行銷文案',
): Promise<string | null> {
  if (!isNLPKBEnabled()) return null;

  // ─── Architect mode (4-stage) — default ───
  if (isArchitectEnabled()) {
    try {
      const architect = await getArchitect(topic, contentType);
      if (architect) {
        return formatArchitectAsPrompt(architect);
      }
      console.log('[nlp_kb] architect returned null, falling back to single-stage');
    } catch (e) {
      console.warn('[nlp_kb] architect failed, falling back:', (e as Error).message);
    }
  }

  // ─── Single-stage mode (legacy fallback) ───
  try {
    const client = getNLPKBClient();
    const nlpQuery = contentTypeToNlpQuery(contentType);  // 純 content_type, 不帶 topic
    // local mode 比 global 更可靠（empirical finding from Python testing）
    const response = await client.ask(nlpQuery, 'local');
    if (!response || response.refused) return null;

    const hint = await academicToKaren(response.answer, contentType);
    return hint && hint.length > 30 ? hint : null;
  } catch (e) {
    console.warn('[nlp_kb] preHint single-stage failed:', (e as Error).message);
    return null;
  }
}

/**
 * L2: Post-generation review — ask NLP KB to review the generated content and suggest improvements.
 *
 * Drop-in usage:
 *     const review = await postReview(generatedText, 'YouTube 標題');
 *     if (review) regeneratePrompt += `\n\n## 審稿建議\n${review}`;
 */
export async function postReview(
  content: string,
  contentType = '行銷文案',
): Promise<string | null> {
  if (!isNLPKBEnabled()) return null;
  if (!content || content.trim().length < 30) return null;

  try {
    const client = getNLPKBClient();
    const reviewQuery = queryForReview(content, contentType);
    const response = await client.ask(reviewQuery, 'local');
    if (!response || response.refused) return null;

    const reviewHint = await academicToKaren(response.answer, `${contentType} 審稿建議`);
    return reviewHint && reviewHint.length > 30 ? reviewHint : null;
  } catch (e) {
    console.warn('[nlp_kb] postReview failed:', (e as Error).message);
    return null;
  }
}

/**
 * Extract NLP patterns from source material (viral content, transcript, competitor copy).
 *
 * Used by Class C (extractor) hooks — viral-learner, trend analysis.
 */
export async function extractPatterns(
  sourceText: string,
  sourceType = '逐字稿',
): Promise<{ academicAnswer: string; karenHint: string } | null> {
  if (!isNLPKBEnabled()) return null;
  if (!sourceText || sourceText.trim().length < 50) return null;

  try {
    const client = getNLPKBClient();
    const query = queryForExtraction(sourceText, sourceType);
    const response = await client.ask(query, 'global');
    if (!response || response.refused) return null;

    const karenHint = await academicToKaren(response.answer, `${sourceType}模式提取`);
    return {
      academicAnswer: response.answer,
      karenHint,
    };
  } catch (e) {
    console.warn('[nlp_kb] extractPatterns failed:', (e as Error).message);
    return null;
  }
}
