/**
 * SEO Video API Routes — Hono 路由
 *
 * POST /api/seo/upload/init      → R2 multipart upload 初始化
 * POST /api/seo/upload/presign   → 取得 chunk presigned URLs
 * POST /api/seo/upload/complete  → 完成上傳 + 建立 job
 * GET  /api/seo/process/:jobId   → SSE 進度推送 + 觸發處理
 * GET  /api/seo/jobs              → 歷史記錄
 * GET  /api/seo/jobs/:jobId       → 單筆結果
 * POST /api/seo/jobs/:jobId/select → 選標題
 * DELETE /api/seo/jobs/all        → 刪除所有 jobs
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';
import { processVideoSeo, deleteR2Object } from './seo-video.js';
import { nanoid } from 'nanoid';

// ── Config ──────────────────────────────────────────────────

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'b4dcf0aa309942f83f66289fb22cfe2f';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '6aefc53c434ae7e17bc09902d744f568';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '48b5829b321582ccd142d05228bd58fcad56e4fce65195c1e401db3566b7e71b';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'seo-videos';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── Clients ─────────────────────────────────────────────────

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

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

// ── Upload: Init multipart ──────────────────────────────────

seoRoutes.post('/upload/init', async (c) => {
  try {
    const { fileName, fileSize, contentType } = await c.req.json();

    if (!fileName || !fileSize) {
      return c.json({ error: 'Missing fileName or fileSize' }, 400);
    }

    // Validate file size (3GB max)
    if (fileSize > 3 * 1024 * 1024 * 1024) {
      return c.json({ error: '檔案大小超過 3GB 限制' }, 400);
    }

    // Validate content type
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (contentType && !allowedTypes.includes(contentType)) {
      return c.json({ error: '不支援的影片格式' }, 400);
    }

    const key = `uploads/${nanoid()}_${fileName}`;

    const cmd = new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'video/mp4',
    });

    const result = await s3.send(cmd);

    return c.json({
      uploadId: result.UploadId,
      key,
      chunkSize: 50 * 1024 * 1024, // 50MB recommended chunk size
    });
  } catch (err) {
    console.error('Upload init error:', err);
    return c.json({ error: 'Upload initialization failed' }, 500);
  }
});

// ── Upload: Get presigned URLs for chunks ───────────────────

seoRoutes.post('/upload/presign', async (c) => {
  try {
    const { uploadId, key, parts } = await c.req.json();

    if (!uploadId || !key || !parts) {
      return c.json({ error: 'Missing uploadId, key, or parts' }, 400);
    }

    const urls: string[] = [];

    for (let i = 1; i <= parts; i++) {
      const cmd = new UploadPartCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        PartNumber: i,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      urls.push(url);
    }

    return c.json({ urls });
  } catch (err) {
    console.error('Presign error:', err);
    return c.json({ error: 'Failed to generate presigned URLs' }, 500);
  }
});

// ── Upload: Complete multipart + create job ─────────────────

seoRoutes.post('/upload/complete', async (c) => {
  try {
    const { uploadId, key, parts, fileName, fileSize, duration, thumbnail, description, videoType } = await c.req.json();

    // Complete R2 multipart upload
    const cmd = new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p: { ETag: string; PartNumber: number }) => ({
          ETag: p.ETag,
          PartNumber: p.PartNumber,
        })),
      },
    });

    await s3.send(cmd);

    // Create seo_jobs record
    const { data: job, error } = await supabase.from('seo_jobs').insert({
      status: 'pending',
      progress: 0,
      stage: 'uploaded',
      stage_detail: '影片已上傳，等待處理',
      file_key: key,
      file_name: fileName,
      file_size: fileSize,
      description: description || '',
      video_type: (duration && duration > 60) ? 'long' : (videoType || 'auto'),
      caption: thumbnail ? { thumbnail } : null,
      source: 'web',
    }).select().single();

    if (error) throw error;

    return c.json({ jobId: job.id, status: 'pending' });
  } catch (err) {
    console.error('Upload complete error:', err);
    return c.json({ error: 'Failed to complete upload' }, 500);
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

// ── Jobs: Delete ALL ──────────────────────────────────────

seoRoutes.delete('/jobs/all', async (c) => {
  try {
    // Get all jobs to clean up storage
    const { data: jobs } = await supabase.from('seo_jobs').select('id, file_key');
    if (jobs && jobs.length > 0) {
      for (const job of jobs) {
        if (job.file_key) {
          deleteR2Object(job.file_key).catch(() => {});
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

  // Get file_key to clean up R2
  const { data: job } = await supabase.from('seo_jobs').select('file_key').eq('id', jobId).single();
  if (job?.file_key) {
    deleteR2Object(job.file_key).catch(() => {});
  }

  const { error } = await supabase.from('seo_jobs').delete().eq('id', jobId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
