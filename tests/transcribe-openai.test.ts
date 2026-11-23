// 2026-11-23：TRANSCRIBE_BACKEND=openai 轉錄——分段、逐段轉、照順序接起來、逐段回報進度
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transcribeVideoOpenAI, AUDIO_CHUNK_SECONDS } from '../src/services/transcribe-openai.js';

test('逐段轉錄、照順序接起來、進度回報到片長為止', async () => {
  const seen: string[] = [];
  const progress: number[] = [];
  const text = await transcribeVideoOpenAI(
    '/v.mp4', '/tmp/x', 650,
    (s) => progress.push(s),
    async (f) => { seen.push(f); return { text: `T(${f})`, inputTokens: 10, outputTokens: 5 }; },
    async () => ['/a-000.mp3', '/a-001.mp3', '/a-002.mp3'],
  );
  assert.deepEqual(seen, ['/a-000.mp3', '/a-001.mp3', '/a-002.mp3']);
  assert.equal(text, 'T(/a-000.mp3)\nT(/a-001.mp3)\nT(/a-002.mp3)');
  assert.deepEqual(progress, [AUDIO_CHUNK_SECONDS, AUDIO_CHUNK_SECONDS * 2, 650]);
});

test('抽不出音軌就明確報錯', async () => {
  await assert.rejects(
    transcribeVideoOpenAI('/v.mp4', '/tmp/x', 10, undefined, async () => ({ text: '', inputTokens: null, outputTokens: null }), async () => []),
    /抽不出音軌/,
  );
});

test('某一段失敗整支失敗（不靜默少一段）', async () => {
  await assert.rejects(
    transcribeVideoOpenAI('/v.mp4', '/tmp/x', 400, undefined,
      async (f) => { if (f.endsWith('1.mp3')) throw new Error('transcribe HTTP 429'); return { text: 'ok', inputTokens: 1, outputTokens: 1 }; },
      async () => ['/a-000.mp3', '/a-001.mp3']),
    /429/,
  );
});

test('seo-video 依開關分派：openai 走 transcribeVideoOpenAI，其他走本地', () => {
  const s = readFileSync('src/services/seo-video.ts', 'utf8');
  assert.match(s, /const useOpenAI = TRANSCRIBE_BACKEND === 'openai';/);
  assert.match(s, /useOpenAI\s*\?\s*await transcribeVideoOpenAI\(/);
  assert.match(s, /:\s*await transcribeAudio\(audioPath/);
});

test('每段都埋點、feature 跟主站估表一致', () => {
  const s = readFileSync('src/services/transcribe-openai.ts', 'utf8');
  assert.match(s, /reportUsage\(\{\s*feature: 'seo-video-transcribe',\s*provider: 'openai'/);
});
