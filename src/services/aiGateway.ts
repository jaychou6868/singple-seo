// ---------------------------------------------------------------------------
// AI 呼叫出口：ChatGPT 訂閱橋接（singple-chatgpt-bridge）
//
// 2026-08-14 起本服務的文字生成可改走 Karen 的 ChatGPT Team 訂閱額度，
// 不再產生 OpenAI 按量費用。橋接對外長得跟 OpenAI API 一樣，呼叫端寫法不用改。
//
// ⚠️ 切換由「有沒有設 AI_GATEWAY_KEY」決定，而不是由程式碼寫死：
//   - 沒設 → 照舊打真正的 OpenAI API，行為完全不變
//   - 有設 → 走橋接，用訂閱額度
//
// 這樣「部署程式碼」和「實際切換」就分開了：先部署不會有任何影響，
// 等環境變數設好才生效；要回退也只要刪掉 AI_GATEWAY_KEY，不用重新部署。
//
// ⚠️ 音軌轉錄（/v1/audio/transcriptions）不走這裡——訂閱額度沒有轉錄介面。
//    那條仍用真正的 OPENAI_API_KEY，見 seo-video.ts 的 transcribeChunk。
// ---------------------------------------------------------------------------

const OPENAI_DIRECT = 'https://api.openai.com/v1/chat/completions';

/** 同專案內走 Zeabur 內網，不繞公網；本機開發時用公開網址。 */
const BRIDGE_URL =
  process.env.NODE_ENV === 'production'
    ? 'http://singple-chatgpt-bridge.zeabur.internal:8080/v1/chat/completions'
    : 'https://singple-chatgpt-bridge.zeabur.app/v1/chat/completions';

/** 有設 AI_GATEWAY_KEY 才走橋接。 */
export const USING_GATEWAY = !!process.env.AI_GATEWAY_KEY;

export const AI_CHAT_URL =
  process.env.AI_GATEWAY_URL || (USING_GATEWAY ? BRIDGE_URL : OPENAI_DIRECT);

/** 呼叫時該帶的金鑰：走橋接用橋接的，否則用原本的 OpenAI 金鑰。 */
export const AI_CHAT_KEY = process.env.AI_GATEWAY_KEY || process.env.OPENAI_API_KEY || '';

/** 埋點該標的 provider——走橋接是訂閱制（成本 0），否則仍是按量。 */
export const AI_PROVIDER: 'chatgpt-subscription' | 'openai' =
  USING_GATEWAY ? 'chatgpt-subscription' : 'openai';
