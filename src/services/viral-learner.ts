/**
 * Viral Learner — YouTube 跨類目爆款結構自動學習
 *
 * 每週一 09:00 (台灣時間) 自動執行：
 * 1. 搜尋 7 個類目的 YouTube 熱門影片
 * 2. 過濾超額表現影片（觀看數 > 頻道平均 3 倍）
 * 3. Gemini 分析標題模式
 * 4. 更新 Supabase 知識庫
 */

import { createClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

// ── Config ──────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Search Categories ───────────────────────────────────────

const SEARCH_QUERIES = [
  // Singing/Music
  '唱歌技巧', '聲樂教學', '高音怎麼唱',
  // Fitness
  '健身教學', '瘦身運動',
  // Cooking
  '新手做菜', '快速料理',
  // Language
  '英文口說', '日文自學',
  // Personal growth
  '時間管理', '自律習慣',
  // Beauty
  '新手化妝', '穿搭技巧',
  // Tech
  'iPhone技巧', 'App推薦',
];

// ── Types ───────────────────────────────────────────────────

interface YouTubeVideo {
  videoId: string;
  title: string;
  channelId: string;
  viewCount: number;
}

interface OverperformerVideo extends YouTubeVideo {
  channelAvgViews: number;
  overperformanceRatio: number;
  subscriberCount: number;
}

interface GeminiAnalysis {
  title_skeleton: string;
  ig_hook: string;
  ig_cta: string;
  rhetoric_technique: string;
  emotional_trigger: string;
  content_framework: string;
  singing_title: string;
  singing_caption: string;
}

interface WeeklyReport {
  date: string;
  videosAnalyzed: number;
  overperformersFound: number;
  newPatterns: number;
  skeletonsUpdated: number;
  topHooks: string[];
}

// ── Channel stats cache ─────────────────────────────────────

const channelCache = new Map<string, { avgViews: number; subscriberCount: number }>();

// ── YouTube API helpers ─────────────────────────────────────

async function searchYouTube(query: string, maxResults = 15): Promise<YouTubeVideo[]> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('order', 'viewCount');
  searchUrl.searchParams.set('publishedAfter', ninetyDaysAgo);
  searchUrl.searchParams.set('maxResults', String(maxResults));
  searchUrl.searchParams.set('relevanceLanguage', 'zh');
  searchUrl.searchParams.set('regionCode', 'TW');
  searchUrl.searchParams.set('key', YOUTUBE_API_KEY);

  const res = await fetch(searchUrl.toString());
  const data = await res.json() as any;

  if (!data.items?.length) return [];

  // Get video statistics in batch
  const videoIds = data.items.map((item: any) => item.id.videoId).join(',');
  const statsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  statsUrl.searchParams.set('part', 'statistics');
  statsUrl.searchParams.set('id', videoIds);
  statsUrl.searchParams.set('key', YOUTUBE_API_KEY);

  const statsRes = await fetch(statsUrl.toString());
  const statsData = await statsRes.json() as any;
  const statsMap = new Map<string, number>();
  for (const item of statsData.items || []) {
    statsMap.set(item.id, parseInt(item.statistics.viewCount || '0'));
  }

  return data.items.map((item: any) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    viewCount: statsMap.get(item.id.videoId) || 0,
  }));
}

async function getChannelStats(channelId: string): Promise<{ avgViews: number; subscriberCount: number }> {
  if (channelCache.has(channelId)) {
    return channelCache.get(channelId)!;
  }

  // Single API call: get channel statistics (1 unit instead of 102)
  // Use totalViewCount / videoCount as estimated average
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'statistics');
  channelUrl.searchParams.set('id', channelId);
  channelUrl.searchParams.set('key', YOUTUBE_API_KEY);

  const channelRes = await fetch(channelUrl.toString());
  const channelData = await channelRes.json() as any;
  const stats = channelData.items?.[0]?.statistics;

  if (!stats) {
    const result = { avgViews: 0, subscriberCount: 0 };
    channelCache.set(channelId, result);
    return result;
  }

  const subscriberCount = parseInt(stats.subscriberCount || '0');
  const totalViews = parseInt(stats.viewCount || '0');
  const videoCount = parseInt(stats.videoCount || '0');
  const avgViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;

  const result = { avgViews, subscriberCount };
  channelCache.set(channelId, result);
  return result;
}

// ── Filtering ───────────────────────────────────────────────

async function filterOverperformers(videos: YouTubeVideo[]): Promise<OverperformerVideo[]> {
  // Deduplicate by videoId
  const unique = new Map<string, YouTubeVideo>();
  for (const v of videos) {
    if (!unique.has(v.videoId)) unique.set(v.videoId, v);
  }

  const candidates: OverperformerVideo[] = [];

  for (const video of unique.values()) {
    try {
      const stats = await getChannelStats(video.channelId);

      // Filter: channel subscribers between 5K and 1M
      if (stats.subscriberCount < 5000 || stats.subscriberCount > 1_000_000) continue;

      // Filter: channel must have average views > 0
      if (stats.avgViews <= 0) continue;

      const ratio = video.viewCount / stats.avgViews;

      // Filter: overperformance > 3x
      if (ratio > 3) {
        candidates.push({
          ...video,
          channelAvgViews: stats.avgViews,
          overperformanceRatio: Math.round(ratio * 10) / 10,
          subscriberCount: stats.subscriberCount,
        });
      }
    } catch (err) {
      console.warn(`[Viral Learner] Error checking channel ${video.channelId}:`, err);
    }
  }

  // Sort by overperformance ratio descending, take top 10
  candidates.sort((a, b) => b.overperformanceRatio - a.overperformanceRatio);
  return candidates.slice(0, 10);
}

// ── Gemini Analysis ─────────────────────────────────────────

async function analyzeWithGemini(
  titles: { title: string; views: number; ratio: number }[],
): Promise<GeminiAnalysis[]> {
  const titlesText = titles
    .map((t, i) => `${i + 1}. 「${t.title}」(觀看: ${t.views}, 超額: ${t.ratio}倍)`)
    .join('\n');

  const prompt = `你是一位資深的 YouTube SEO 和社群媒體文案分析專家。

分析以下超額表現的影片標題（觀看數遠超頻道平均），提取「可直接複用」的模式和話術。

標題列表：
${titlesText}

對每個標題，提取以下 6 類可複用的模式：

1. title_skeleton: 標題骨架結構（用 {變數} 表示可替換部分）
2. ig_hook: 轉化為 IG 文案的開頭 Hook（20字內，繁體中文）
3. ig_cta: 轉化為 IG 文案的 CTA 呼籲（一句話）
4. rhetoric_technique: 使用的話術技巧（封閉性操作/損失框架/雙重束縛/讀心術/未來模擬/反差對比/數字錨定）
5. emotional_trigger: 情感觸發策略（恐懼→希望/好奇→滿足/焦慮→行動/挑戰→成就）
6. content_framework: 內容框架（問題→解法/迷思→真相/故事→教訓/挑戰→結果）

另外為每個標題生成：
7. singing_title: 轉化為唱歌教學的標題範例
8. singing_caption: 轉化為唱歌教學的 IG 文案範例（含 Hook + 價值 + CTA，60字內）

輸出 JSON 陣列。`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 16384,
          thinkingConfig: { thinkingLevel: 'high' },
        },
      }),
      signal: controller.signal,
    });

    const data = await res.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text) { text = parts[i].text; break; }
    }

    if (!text) {
      console.error('[Viral Learner] Gemini returned no text');
      return [];
    }

    // Parse JSON from response
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Knowledge Base Update ───────────────────────────────────

async function updateKnowledgeBase(
  analyses: GeminiAnalysis[],
  overperformers: OverperformerVideo[],
): Promise<{ newPatterns: number; updatedSkeletons: number }> {
  let newPatterns = 0;
  let updatedSkeletons = 0;

  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    const video = overperformers[i];
    if (!analysis || !video) continue;

    // ── Update seo_title_skeletons (columns: id, pattern, example, weight) ──

    const { data: existing, error: fetchErr } = await supabase
      .from('seo_title_skeletons')
      .select('*')
      .eq('pattern', analysis.title_skeleton)
      .single();

    if (fetchErr && fetchErr.code !== 'PGRST116') {
      // PGRST116 = no rows found, anything else is a real error
      console.error('[Viral Learner] Error fetching skeleton:', fetchErr);
    }

    if (existing) {
      // Skeleton exists — increase weight (market validation)
      const currentWeight = existing.weight ?? 1.0;
      const { error: updateErr } = await supabase
        .from('seo_title_skeletons')
        .update({ weight: Math.min(currentWeight + 0.1, 3.0) })
        .eq('id', existing.id)
        .select();
      if (updateErr) console.error('[Viral Learner] Error updating skeleton:', updateErr);
      else updatedSkeletons++;
    } else {
      // New skeleton — insert
      const { error: insertErr } = await supabase.from('seo_title_skeletons').insert({
        id: `vl_${nanoid(6)}`,
        pattern: analysis.title_skeleton,
        example: analysis.singing_title,
        weight: 1.0,
      }).select();
      if (insertErr) console.error('[Viral Learner] Error inserting skeleton:', insertErr);
      else newPatterns++;
    }

    // ── Insert diverse entries into seo_viral_examples ──
    // Table columns: id, content, type, category, angle

    const exampleEntries: { content: string; type: string; category: string; angle: string }[] = [
      {
        content: analysis.title_skeleton,
        type: 'title',
        category: analysis.rhetoric_technique,
        angle: analysis.emotional_trigger,
      },
      {
        content: analysis.ig_hook,
        type: 'ig_hook',
        category: analysis.rhetoric_technique,
        angle: analysis.emotional_trigger,
      },
      {
        content: analysis.ig_cta,
        type: 'ig_cta',
        category: analysis.content_framework,
        angle: analysis.emotional_trigger,
      },
      {
        content: analysis.rhetoric_technique,
        type: 'rhetoric',
        category: analysis.content_framework,
        angle: analysis.emotional_trigger,
      },
      {
        content: `${analysis.singing_title}\n${analysis.singing_caption}`,
        type: 'caption',
        category: analysis.rhetoric_technique,
        angle: analysis.emotional_trigger,
      },
    ];

    for (const entry of exampleEntries) {
      const { data: exData, error: exErr } = await supabase.from('seo_viral_examples').insert({
        content: entry.content,
        type: entry.type,
        category: entry.category,
        angle: entry.angle,
        source: 'viral_learner',
        quality_score: video.overperformanceRatio,
      }).select();
      if (exErr) {
        console.error(`[Viral Learner] Error inserting example (${entry.type}):`, JSON.stringify(exErr));
      } else {
        console.log(`[Viral Learner] ✓ Inserted example: ${entry.type} (id: ${exData?.[0]?.id})`);
      }
    }
  }

  return { newPatterns, updatedSkeletons };
}

// ── Stale skeleton decay ────────────────────────────────────

async function decrementStaleSkeletons(): Promise<number> {
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const { data: stale, error: fetchErr } = await supabase
    .from('seo_title_skeletons')
    .select('*')
    .lt('updated_at', fourWeeksAgo)
    .gt('weight', 0.1);

  if (fetchErr) {
    console.error('[Viral Learner] Error fetching stale skeletons:', fetchErr);
    return 0;
  }

  if (!stale?.length) return 0;

  let count = 0;
  for (const skeleton of stale) {
    const newWeight = Math.max((skeleton.weight ?? 1.0) - 0.1, 0.1);
    const { error: updateErr } = await supabase
      .from('seo_title_skeletons')
      .update({ weight: Math.round(newWeight * 10) / 10 })
      .eq('id', skeleton.id)
      .select();
    if (updateErr) {
      console.error(`[Viral Learner] Error decaying skeleton ${skeleton.id}:`, updateErr);
    } else {
      count++;
    }
  }

  return count;
}

// ── Weekly report ───────────────────────────────────────────

async function generateWeeklyReport(
  videosAnalyzed: number,
  overperformersFound: number,
  newPatterns: number,
  skeletonsUpdated: number,
  topHooks: string[],
): Promise<WeeklyReport> {
  const report: WeeklyReport = {
    date: new Date().toISOString().split('T')[0],
    videosAnalyzed,
    overperformersFound,
    newPatterns,
    skeletonsUpdated,
    topHooks,
  };

  // Store report in seo_trackers
  const { data: existing } = await supabase
    .from('seo_trackers')
    .select('data')
    .eq('id', 'viral_learner')
    .single();

  const history = existing?.data?.reports || [];
  history.push(report);
  // Keep last 12 weekly reports
  const trimmed = history.slice(-12);

  await supabase.from('seo_trackers').upsert({
    id: 'viral_learner',
    data: {
      reports: trimmed,
      last_run: new Date().toISOString(),
      total_runs: (existing?.data?.total_runs || 0) + 1,
    },
    updated_at: new Date().toISOString(),
  });

  return report;
}

// ── Main orchestrator ───────────────────────────────────────

export async function runViralLearner(): Promise<WeeklyReport> {
  console.log('[Viral Learner] Starting weekly learning...');

  // Clear channel cache for fresh data
  channelCache.clear();

  // 1. Search YouTube across all categories
  let allVideos: YouTubeVideo[] = [];
  for (const query of SEARCH_QUERIES) {
    try {
      console.log(`[Viral Learner] Searching: ${query}`);
      const videos = await searchYouTube(query, 15);
      allVideos = allVideos.concat(videos);

      // Small delay to respect API rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`[Viral Learner] Search failed for "${query}":`, err);
    }
  }
  console.log(`[Viral Learner] Total videos found: ${allVideos.length}`);

  // 2. Filter for overperformers
  const overperformers = await filterOverperformers(allVideos);
  console.log(`[Viral Learner] Overperformers: ${overperformers.length}`);

  if (overperformers.length === 0) {
    console.log('[Viral Learner] No overperformers found, generating minimal report');
    return generateWeeklyReport(allVideos.length, 0, 0, 0, []);
  }

  // 3. Analyze with Gemini
  const titlesForAnalysis = overperformers.map(v => ({
    title: v.title,
    views: v.viewCount,
    ratio: v.overperformanceRatio,
  }));
  const analyses = await analyzeWithGemini(titlesForAnalysis);
  console.log(`[Viral Learner] Analyses completed: ${analyses.length}`);

  // 4. Update knowledge base
  const { newPatterns, updatedSkeletons } = await updateKnowledgeBase(analyses, overperformers);
  console.log(`[Viral Learner] New patterns: ${newPatterns}, Updated: ${updatedSkeletons}`);

  // 5. Decay stale skeletons
  const decayed = await decrementStaleSkeletons();
  console.log(`[Viral Learner] Decayed skeletons: ${decayed}`);

  // 6. Generate report
  const topHooks = analyses
    .filter(a => a.rhetoric_technique)
    .map(a => a.rhetoric_technique)
    .slice(0, 5);

  const report = await generateWeeklyReport(
    allVideos.length,
    overperformers.length,
    newPatterns,
    updatedSkeletons,
    topHooks,
  );

  console.log('[Viral Learner] Weekly report:', JSON.stringify(report));
  return report;
}
