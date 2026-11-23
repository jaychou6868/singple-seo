/**
 * OpenAI 音軌轉錄（TRANSCRIBE_BACKEND=openai）。
 *
 * 2026-11-23 搬到新主機（2 核）：容器內 faster-whisper 會吃滿 CPU，加這個開關可改回 OpenAI。
 *   - gpt-4o transcribe 系列輸出 2048 token 上限會靜默截斷 → 音軌一律切 ≤5 分鐘段
 *   - 每段 reportUsage（按量計費，記帳鐵律；feature 與主站估表 seo-video-transcribe 一致）
 *   - 沒設或其他值 → seo-video.ts 照舊走容器內 faster-whisper
 * 本檔沒有 import 期副作用（不連資料庫），測試可直接 import。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { reportUsage } from './usage-reporter.js';

const execFileAsync = promisify(execFile);

export const TRANSCRIBE_BACKEND = (process.env.TRANSCRIBE_BACKEND || 'local').trim().toLowerCase();
export const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
export const AUDIO_CHUNK_SECONDS = 300;

/** 抽音軌 → 單聲道 16kHz 64kbps mp3，按 AUDIO_CHUNK_SECONDS 分段（OpenAI 轉錄用） */
export async function extractAudioChunks(videoPath: string, dir: string): Promise<string[]> {
  await execFileAsync('ffmpeg', [
    '-y', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
    '-f', 'segment', '-segment_time', String(AUDIO_CHUNK_SECONDS), '-reset_timestamps', '1',
    path.join(dir, 'audio-%03d.mp3'),
  ], { timeout: 600000 });
  const files = (await readdir(dir)).filter((f) => f.startsWith('audio-') && f.endsWith('.mp3')).sort();
  return files.map((f) => path.join(dir, f));
}

/** 單段音訊 → OpenAI 逐字稿（gpt-4o-mini-transcribe 輸出繁體，跟本地路徑轉繁後一致） */
export async function transcribeChunkOpenAI(file: string): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('TRANSCRIBE_BACKEND=openai 但 OPENAI_API_KEY 未設定');
  const buf = await readFile(file);
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }), path.basename(file));
  fd.append('model', OPENAI_TRANSCRIBE_MODEL);
  fd.append('response_format', 'json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal: controller.signal,
    });
    const data = await res.json() as Record<string, any>;
    if (!res.ok || typeof data?.text !== 'string') {
      throw new Error(`transcribe HTTP ${res.status}: ${JSON.stringify(data).substring(0, 200)}`);
    }
    return {
      text: data.text,
      inputTokens: data?.usage?.input_tokens ?? null,
      outputTokens: data?.usage?.output_tokens ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** OpenAI 轉錄整支：分段、逐段轉、逐段記帳、逐段回報進度。 */
export async function transcribeVideoOpenAI(
  videoPath: string,
  dir: string,
  durationSec: number,
  onSeconds?: (seconds: number) => void,
  transcribeChunk: typeof transcribeChunkOpenAI = transcribeChunkOpenAI,
  splitAudio: typeof extractAudioChunks = extractAudioChunks,
): Promise<string> {
  const chunks = await splitAudio(videoPath, dir);
  if (!chunks.length) throw new Error('ffmpeg 抽不出音軌（影片可能沒有聲音）');
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await transcribeChunk(chunks[i]);
    parts.push(r.text);
    const chunkSeconds = Math.max(0, Math.min(AUDIO_CHUNK_SECONDS, Math.round(durationSec - i * AUDIO_CHUNK_SECONDS)));
    reportUsage({
      feature: 'seo-video-transcribe',
      provider: 'openai',
      model: OPENAI_TRANSCRIBE_MODEL,
      promptTokens: r.inputTokens,
      completionTokens: r.outputTokens,
      estimated: r.inputTokens == null,
      meta: { chunkIndex: i, chunkSeconds },
    });
    onSeconds?.(Math.min(durationSec, (i + 1) * AUDIO_CHUNK_SECONDS));
  }
  return parts.join('\n');
}

