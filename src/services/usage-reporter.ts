/**
 * AI Usage Reporter — fire-and-forget POST to the main site's ingest endpoint.
 *
 * The main site (slide-hosting) owns the ai_usage_log table, cost calculation
 * and billing classification. This module only ships raw usage records
 * (provider/model/tokens/images) so the main site can compute cost itself.
 *
 * Rules (per plan Contract):
 * - service is always 'singple-seo'
 * - fire-and-forget: never await, never throw, never block the SEO pipeline
 * - if AI_USAGE_INGEST_URL / AI_USAGE_INGEST_SECRET are missing → no-op + one
 *   console.log explaining why (so a missing env doesn't fail silently)
 * - meta must never contain prompt content (only non-sensitive fields like
 *   basenames / elapsed)
 */

const INGEST_URL = process.env.AI_USAGE_INGEST_URL || '';
const INGEST_SECRET = process.env.AI_USAGE_INGEST_SECRET || '';

// Log the "missing env" reason at most once per process so a busy pipeline
// doesn't spam the logs.
let warnedMissingEnv = false;

export interface UsageReport {
  feature: string;
  // chatgpt-subscription：2026-08-14 起文字生成改走 singple-chatgpt-bridge
  // （Karen 的 ChatGPT Team 訂閱額度，成本 0）。主站 ingest 白名單已同步新增。
  // 音軌轉錄仍是 'openai'——訂閱額度沒有轉錄介面，那條還在按量計費。
  provider: 'openai' | 'gemini' | 'chatgpt-subscription';
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  images?: number | null;
  estimated?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Report a single AI usage event to the main site.
 *
 * Fire-and-forget: returns immediately, swallows all errors. Safe to call
 * from any hot path without awaiting.
 */
export function reportUsage(report: UsageReport): void {
  if (!INGEST_URL || !INGEST_SECRET) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.log(
        '[usage-reporter] AI_USAGE_INGEST_URL / AI_USAGE_INGEST_SECRET not set — usage reporting disabled (no-op)',
      );
    }
    return;
  }

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    service: 'singple-seo',
    feature: report.feature,
    provider: report.provider,
    model: report.model,
    prompt_tokens: report.promptTokens ?? null,
    completion_tokens: report.completionTokens ?? null,
    images: report.images ?? null,
    estimated: report.estimated ?? false,
    dedupe_key: null,
    meta: report.meta ?? {},
  };

  // Fire-and-forget: do not await. Any failure (network, 4xx/5xx, abort) is
  // logged as a single warn line and never propagated to the caller.
  void (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INGEST_SECRET}`,
        },
        body: JSON.stringify({ records: [record] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[usage-reporter] ingest returned HTTP ${res.status} for feature=${report.feature}`);
      }
    } catch (err) {
      console.warn(`[usage-reporter] ingest failed for feature=${report.feature}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  })();
}
