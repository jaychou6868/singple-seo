/**
 * SEO Video API Routes — Hono 路由
 *
 * POST /api/seo/upload            → 直接上傳影片（multipart form data）
 * GET  /api/seo/process/:jobId    → SSE 進度推送 + 觸發處理
 * GET  /api/seo/jobs              → 歷史記錄
 * GET  /api/seo/jobs/:jobId       → 單筆結果
 * POST /api/seo/jobs/:jobId/select → 選標題
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createClient } from '@supabase/supabase-js';
import { processVideoSeo, deleteR2Object } from './seo-video.js';
import { nanoid } from 'nanoid';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ── Config ──────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── Clients ─────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Route group ─────────────────────────────────────────────

export const seoRoutes = new Hono();

// ── Orphaned job cleanup (runs once on import) ─────────────

(async () => {
  try {
    // 1. Mark orphaned processing jobs as failed
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: orphans } = await supabase
      .from('seo_jobs')
      .select('id, stage, updated_at')
      .eq('status', 'processing')
      .lt('updated_at', thirtyMinAgo);

    if (orphans && orphans.length > 0) {
      console.log(`[SEO] Cleaning up ${orphans.length} orphaned jobs`);
      for (const job of orphans) {
        await supabase.from('seo_jobs').update({
          status: 'failed',
          stage: 'error',
          stage_detail: `處理中斷（卡在 ${job.stage}），請重試`,
          updated_at: new Date().toISOString(),
        }).eq('id', job.id);
      }
    }

    // 2. Auto-delete failed jobs older than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: oldFailed } = await supabase
      .from('seo_jobs')
      .select('id')
      .eq('status', 'failed')
      .lt('updated_at', oneDayAgo);

    if (oldFailed && oldFailed.length > 0) {
      console.log(`[SEO] Auto-deleting ${oldFailed.length} old failed jobs`);
      const ids = oldFailed.map(j => j.id);
      await supabase.from('seo_jobs').delete().in('id', ids);
    }
  } catch (err) {
    console.error('[SEO] Cleanup error:', err);
  }
})();

// ── Upload: Two-step (init + stream file) ───────────────────

// Step 1: Create job with metadata
seoRoutes.post('/upload/init', async (c) => {
  try {
    const { fileName, fileSize, description, videoType, duration, thumbnail } = await c.req.json();
    if (!fileName) return c.json({ error: 'Missing fileName' }, 400);

    // Let Supabase auto-generate UUID
    const { data: job, error } = await supabase.from('seo_jobs').insert({
      status: 'pending',
      progress: 0,
      stage: 'waiting_upload',
      stage_detail: '等待影片上傳',
      file_key: '/tmp/placeholder',
      file_name: fileName,
      file_size: fileSize || 0,
      description: description || '',
      video_type: (duration && duration > 60) ? 'long' : (videoType || 'auto'),
      caption: thumbnail ? { thumbnail } : null,
      source: 'web',
    }).select().single();

    if (error) throw error;

    // Create tmp dir and update file_key with actual path
    const jobId = job.id;
    const tmpDir = `/tmp/seo-${jobId}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const videoPath = `${tmpDir}/video.mp4`;
    await supabase.from('seo_jobs').update({ file_key: videoPath }).eq('id', jobId);

    return c.json({ jobId });
  } catch (err) {
    console.error('Upload init error:', err);
    return c.json({ error: 'Failed to create job' }, 500);
  }
});

// Step 2: Stream raw video to disk (no multipart, no memory buffering)
seoRoutes.post('/upload/file/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  try {
    const tmpDir = `/tmp/seo-${jobId}`;
    const videoPath = `${tmpDir}/video.mp4`;

    if (!fs.existsSync(tmpDir)) {
      return c.json({ error: 'Job not found' }, 404);
    }

    // Stream request body directly to disk
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'No file data' }, 400);

    const reader = body.getReader();
    const writeStream = fs.createWriteStream(videoPath);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writeStream.write(value);
    }
    writeStream.end();
    await new Promise((resolve) => writeStream.on('finish', resolve));

    const fileSize = fs.statSync(videoPath).size;
    console.log(`[SEO] Upload saved: ${videoPath} (${fileSize} bytes)`);

    // Update job: file uploaded, ready to process
    await supabase.from('seo_jobs').update({
      stage: 'uploaded',
      stage_detail: '影片已上傳，等待處理',
      file_size: fileSize,
    }).eq('id', jobId);

    return c.json({ jobId, status: 'pending' });
  } catch (err) {
    console.error('Upload error:', err);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// ── Process: SSE progress ───────────────────────────────────

seoRoutes.get('/process/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  return streamSSE(c, async (stream) => {
    let completed = false;

    const sendProgress = (progress: number, stage: string, detail: string) => {
      if (!completed) {
        stream.writeSSE({
          data: JSON.stringify({ progress, stage, detail }),
          event: 'progress',
        });
      }
    };

    try {
      // Start processing in background
      const resultPromise = processVideoSeo(jobId, sendProgress);

      // No polling - sendProgress callback handles all updates directly
      const result = await resultPromise;
      completed = true;

      await stream.writeSSE({
        data: JSON.stringify({
          progress: 100,
          stage: 'done',
          detail: '完成！',
          result: {
            caption: result.caption,
            titles: result.titles,
            episodeNumber: result.episodeNumber,
            transcript: result.transcript,
          },
        }),
        event: 'done',
      });
    } catch (err) {
      completed = true;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Processing error:', err);

      await supabase.from('seo_jobs').update({
        status: 'failed',
        stage: 'error',
        stage_detail: msg,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);

      await stream.writeSSE({
        data: JSON.stringify({ progress: 0, stage: 'error', detail: msg }),
        event: 'error',
      });
    }
  });
});

// ── Jobs: History list ──────────────────────────────────────

seoRoutes.get('/jobs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const { data, error, count } = await supabase
    .from('seo_jobs')
    .select('id, status, progress, stage, file_name, video_type, description, episode_number, source, model_used, caption, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data, total: count });
});

// ── Jobs: Single result ─────────────────────────────────────

seoRoutes.get('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  const { data, error } = await supabase
    .from('seo_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) return c.json({ error: error.message }, 404);
  return c.json({ data });
});

// ── Jobs: Select title ──────────────────────────────────────

seoRoutes.post('/jobs/:jobId/select', async (c) => {
  const jobId = c.req.param('jobId');
  const { titleIndex } = await c.req.json();

  const { error } = await supabase
    .from('seo_jobs')
    .update({ selected_title_index: titleIndex, updated_at: new Date().toISOString() })
    .eq('id', jobId);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// ── Jobs: Retry ─────────────────────────────────────────────

seoRoutes.post('/jobs/:jobId/retry', async (c) => {
  const jobId = c.req.param('jobId');

  // Reset job status
  const { error } = await supabase.from('seo_jobs').update({
    status: 'pending',
    progress: 0,
    stage: 'retrying',
    stage_detail: '重新處理中...',
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, message: '已重新排隊' });
});

// ── Jobs: Delete ───────────────────────────────────────────

seoRoutes.delete('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  // Get file_key to clean up storage
  const { data: job } = await supabase.from('seo_jobs').select('file_key').eq('id', jobId).single();
  if (job?.file_key) {
    if (job.file_key.startsWith('/tmp/')) {
      // New flow: local /tmp file
      const tmpDir = job.file_key.replace(/\/video\.mp4$/, '');
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } else {
      // Legacy: R2 object
      deleteR2Object(job.file_key).catch(() => {});
    }
  }

  const { error } = await supabase.from('seo_jobs').delete().eq('id', jobId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
