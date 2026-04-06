/**
 * DNA Tracker — 文案 DNA 追蹤，確保生成多樣性
 *
 * 追蹤每次生成的結構 DNA，避免重複使用相同的骨架、角度、情感。
 */

import { createClient } from '@supabase/supabase-js';

// ── Config ──────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ───────────────────────────────────────────────────

export interface CaptionDNA {
  skeleton_id: string;
  angle: string;
  hook_type: string;
  cta_type: string;
  emotion: string;
  pain_level: string;
  technique: string;
}

interface Skeleton {
  id: string;
  pattern: string;
  example: string;
  weight: number;
  [key: string]: unknown;
}

// ── Record DNA ──────────────────────────────────────────────

export async function recordDNA(jobId: string, dna: CaptionDNA): Promise<void> {
  const { data: existing } = await supabase
    .from('seo_trackers')
    .select('data')
    .eq('id', 'dna_tracker')
    .single();

  const currentData = existing?.data || { recent_dna: [] };
  const recentDna: (CaptionDNA & { job_id: string; date: string })[] = currentData.recent_dna || [];

  recentDna.push({
    ...dna,
    job_id: jobId,
    date: new Date().toISOString(),
  });

  // Keep last 20
  const trimmed = recentDna.slice(-20);

  await supabase.from('seo_trackers').upsert({
    id: 'dna_tracker',
    data: { recent_dna: trimmed },
    updated_at: new Date().toISOString(),
  });
}

// ── Get Recent DNA ──────────────────────────────────────────

export async function getRecentDNA(count = 10): Promise<CaptionDNA[]> {
  const { data } = await supabase
    .from('seo_trackers')
    .select('data')
    .eq('id', 'dna_tracker')
    .single();

  const recentDna = data?.data?.recent_dna || [];
  return recentDna.slice(-count);
}

// ── Select Diverse Skeletons ────────────────────────────────

export async function selectDiverseSkeletons(
  allSkeletons: Skeleton[],
  recentDNA: CaptionDNA[],
  count = 5,
): Promise<Skeleton[]> {
  // Get recently used skeleton IDs (last 10)
  const recentSkeletonIds = new Set(
    recentDNA.slice(-10).map(d => d.skeleton_id).filter(Boolean),
  );

  // Exclude recently used
  let available = allSkeletons.filter(s => !recentSkeletonIds.has(s.id));

  // If not enough available, use all
  if (available.length < count) {
    available = allSkeletons;
  }

  // Sort by weight descending
  available.sort((a, b) => (b.weight ?? 1.0) - (a.weight ?? 1.0));

  // Take top 15
  const topCandidates = available.slice(0, 15);

  // Randomly pick `count` from top candidates
  const selected: Skeleton[] = [];
  const pool = [...topCandidates];

  while (selected.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    selected.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return selected;
}

// ── Build Diversity Constraint ──────────────────────────────

export function buildDiversityConstraint(recentDNA: CaptionDNA[]): string {
  const last5 = recentDNA.slice(-5);
  if (last5.length === 0) return '';

  const recentHooks = [...new Set(last5.map(d => d.hook_type).filter(Boolean))];
  const recentAngles = [...new Set(last5.map(d => d.angle).filter(Boolean))];
  const recentEmotions = [...new Set(last5.map(d => d.emotion).filter(Boolean))];
  const recentTechniques = [...new Set(last5.map(d => d.technique).filter(Boolean))];

  const parts: string[] = [];
  if (recentHooks.length > 0) parts.push(`Hook 類型：${recentHooks.join('、')}`);
  if (recentAngles.length > 0) parts.push(`切入角度：${recentAngles.join('、')}`);
  if (recentEmotions.length > 0) parts.push(`情感基調：${recentEmotions.join('、')}`);
  if (recentTechniques.length > 0) parts.push(`NLP 技巧：${recentTechniques.join('、')}`);

  if (parts.length === 0) return '';

  return `\n## 多樣性規則（強制）\n最近 5 次已使用過，必須避免重複：\n${parts.map(p => `- ${p}`).join('\n')}\n請選擇不同的組合。`;
}
