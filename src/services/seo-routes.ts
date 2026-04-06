/**
 * SEO Video API Routes — Hono 路由
 *
 * POST /api/seo/upload/init      → GCS signed URL 初始化（前端直傳 GCS）
 * GET  /api/seo/process/:jobId   → SSE 進度推送 + 觸發處理
 * GET  /api/seo/jobs              → 歷史記錄
 * GET  /api/seo/jobs/:jobId       → 單筆結果
 * POST /api/seo/jobs/:jobId/select → 選標題
 * DELETE /api/seo/jobs/all        → 刪除所有 jobs
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Storage } from '@google-cloud/storage';
import { createClient } from '@supabase/supabase-js';
import { processVideoSeo, deleteGcsObject } from './seo-video.js';
import { runViralLearner } from './viral-learner.js';
import { nanoid } from 'nanoid';

// ── Config ──────────────────────────────────────────────────

const GCS_BUCKET_NAME = 'singple-seo-videos';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── Clients ─────────────────────────────────────────────────

// GCS: support env var (for Zeabur deploy) or local key file
let storageOptions: ConstructorParameters<typeof Storage>[0] = {};
if (process.env.GCS_KEY_JSON) {
  const credentials = JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, 'base64').toString());
  storageOptions = { credentials };
} else {
  storageOptions = { keyFilename: './gcs-key.json' };
}
const gcsStorage = new Storage(storageOptions);
const gcsBucket = gcsStorage.bucket(GCS_BUCKET_NAME);

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

// ── Upload: Init (GCS signed URL) ──────────────────────────

seoRoutes.post('/upload/init', async (c) => {
  try {
    const { fileName, fileSize, description, videoType, duration, thumbnail } = await c.req.json();

    if (!fileName || !fileSize) {
      return c.json({ error: 'Missing fileName or fileSize' }, 400);
    }

    // Validate file size (3GB max)
    if (fileSize > 3 * 1024 * 1024 * 1024) {
      return c.json({ error: '檔案大小超過 3GB 限制' }, 400);
    }

    const fileId = nanoid();
    const key = `uploads/${fileId}.mp4`;
    const gcsUri = `gs://${GCS_BUCKET_NAME}/${key}`;

    // Generate GCS signed URL for direct PUT upload
    const [uploadUrl] = await gcsBucket.file(key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
      contentType: 'video/mp4',
    });

    // Create seo_jobs record
    const { data: job, error } = await supabase.from('seo_jobs').insert({
      status: 'pending',
      progress: 0,
      stage: 'uploaded',
      stage_detail: '影片已上傳，等待處理',
      file_key: gcsUri,
      file_name: fileName,
      file_size: fileSize,
      description: description || '',
      video_type: (duration && duration > 60) ? 'long' : (videoType || 'auto'),
      caption: thumbnail ? { thumbnail } : null,
      source: 'web',
    }).select().single();

    if (error) throw error;

    return c.json({ jobId: job.id, uploadUrl, key });
  } catch (err) {
    console.error('Upload init error:', err);
    return c.json({ error: 'Upload initialization failed' }, 500);
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
      const resultPromise = processVideoSeo(jobId, sendProgress);
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

// ── Jobs: Delete ALL ──────────────────────────────────────

seoRoutes.delete('/jobs/all', async (c) => {
  try {
    const { data: jobs } = await supabase.from('seo_jobs').select('id, file_key');
    if (jobs && jobs.length > 0) {
      for (const job of jobs) {
        if (job.file_key?.startsWith('gs://')) {
          deleteGcsObject(job.file_key).catch(() => {});
        }
      }
    }
    const { error, count } = await supabase.from('seo_jobs').delete().not('id', 'is', null);
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ ok: true, deleted: count || (jobs?.length ?? 0) });
  } catch (err) {
    console.error('Delete all jobs error:', err);
    return c.json({ error: 'Failed to delete all jobs' }, 500);
  }
});

// ── Jobs: Delete ───────────────────────────────────────────

seoRoutes.delete('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  const { data: job } = await supabase.from('seo_jobs').select('file_key').eq('id', jobId).single();
  if (job?.file_key?.startsWith('gs://')) {
    deleteGcsObject(job.file_key).catch(() => {});
  }

  const { error } = await supabase.from('seo_jobs').delete().eq('id', jobId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// ── Debug: Check knowledge base status ─────────────────────
seoRoutes.get('/kb-status', async (c) => {
  const { data: skeletons } = await supabase.from('seo_title_skeletons').select('id, pattern, weight').order('weight', { ascending: false });
  const { data: examples } = await supabase.from('seo_viral_examples').select('id, content, type, category, angle').order('created_at', { ascending: false }).limit(10);
  const { data: trackers } = await supabase.from('seo_trackers').select('id, data, updated_at');
  return c.json({
    skeletons: { count: skeletons?.length || 0, top5: skeletons?.slice(0, 5) },
    examples: { count: examples?.length || 0, latest5: examples?.slice(0, 5) },
    trackers: trackers
  });
});

// ── Debug: Test viral examples insert ──────────────────────

seoRoutes.get('/kb-test-insert', async (c) => {
  const testId = `test_${Date.now()}`;
  const { data, error } = await supabase.from('seo_viral_examples').insert({
    id: testId,
    content: 'TEST — will be deleted',
    type: 'test',
    category: 'test',
    angle: 'test',
  }).select();

  if (error) {
    return c.json({ ok: false, error, hint: 'Table schema mismatch — check required columns' });
  }

  // Clean up test row
  await supabase.from('seo_viral_examples').delete().eq('id', testId);
  return c.json({ ok: true, inserted: data, message: 'Insert + delete succeeded' });
});

// ── Viral Learner: Manual trigger ──────────────────────────

seoRoutes.post('/viral-learn', async (c) => {
  try {
    const result = await runViralLearner();
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('Viral Learner error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
