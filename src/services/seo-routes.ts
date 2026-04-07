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
import { processVideoSeo, deleteGcsObject, extractThumbnailTimestamps } from './seo-video.js';
import { runViralLearner, testViralLearnerSave } from './viral-learner.js';
import { runLockedChannelLearner } from './locked-channel-learner.js';
import { generateThumbnails } from './thumbnail-generator.js';
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

// ── Locked-channel learner self-waking cron (runs once on import) ─
//
// Zeabur has no native cron. Instead we check on every cold start
// whether the learner ran > 30 days ago and trigger it in the background
// if so. Because Zeabur services restart at least weekly (push, idle reset),
// this approximates a monthly cron without external dependencies.

(async () => {
  try {
    const { data } = await supabase
      .from('learner_meta')
      .select('last_run_at')
      .eq('id', 'locked_channel_learner')
      .maybeSingle();
    const lastRun = data?.last_run_at ? new Date(data.last_run_at) : null;
    // Karen 2026-04-07: bumped from 30 → 14 days. Two channels post 1-2
    // videos a week each, so a 14-day refresh keeps the reference pool
    // closer to current trends without burning Gemini quota.
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    if (!lastRun || lastRun.getTime() < fourteenDaysAgo) {
      console.log(`[SEO] Locked learner auto-trigger: lastRun=${lastRun?.toISOString() ?? 'never'} (running in background)`);
      // Don't await — let it run async, the run takes ~5-7 minutes
      runLockedChannelLearner().catch(err => {
        console.error('[SEO] Locked learner auto-trigger failed:', err);
      });
    } else {
      const daysAgo = Math.round((Date.now() - lastRun.getTime()) / (24 * 60 * 60 * 1000));
      console.log(`[SEO] Locked learner last ran ${daysAgo} days ago — skipping auto-trigger`);
    }
  } catch (err) {
    console.error('[SEO] Locked learner auto-trigger check failed:', err);
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
            thumbnailTimestamps: result.thumbnailTimestamps,
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
  const { data: examples } = await supabase.from('seo_viral_examples').select('id, content, type, category, angle, source, quality_score').order('learned_at', { ascending: false }).limit(10);
  const { data: trackers } = await supabase.from('seo_trackers').select('id, data, updated_at');
  return c.json({
    skeletons: { count: skeletons?.length || 0, top5: skeletons?.slice(0, 5) },
    examples: { count: examples?.length || 0, latest5: examples?.slice(0, 5) },
    trackers: trackers
  });
});

// ── Debug: Test viral examples insert ──────────────────────

seoRoutes.get('/kb-test-insert', async (c) => {
  const { data, error } = await supabase.from('seo_viral_examples').insert({
    content: 'TEST — will be deleted',
    type: 'test',
    category: 'test',
    angle: 'test',
  }).select();

  if (error) {
    return c.json({ ok: false, error, hint: 'Table schema mismatch — check required columns' });
  }

  // Clean up test row
  if (data?.[0]?.id) {
    await supabase.from('seo_viral_examples').delete().eq('id', data[0].id);
  }
  return c.json({ ok: true, inserted: data, message: 'Insert + delete succeeded' });
});

// ── Debug: Cleanup test data ──────────────────────────────

seoRoutes.delete('/kb-test-cleanup', async (c) => {
  // Delete test examples (source = viral_learner from test)
  const { data: exDeleted, error: exErr } = await supabase
    .from('seo_viral_examples')
    .delete()
    .eq('source', 'viral_learner')
    .select('id');

  // Delete test skeletons (vl_ prefix)
  const { data: skDeleted, error: skErr } = await supabase
    .from('seo_title_skeletons')
    .delete()
    .like('id', 'vl_%')
    .select('id');

  return c.json({
    ok: !exErr && !skErr,
    deletedExamples: exDeleted?.length || 0,
    deletedSkeletons: skDeleted?.length || 0,
    errors: [exErr, skErr].filter(Boolean),
  });
});

// ── Thumbnail: Generate candidates ────────────────────────

seoRoutes.post('/thumbnail/generate', async (c) => {
  try {
    const { jobId, frames, title, videoSummary, videoType } = await c.req.json();
    if (!jobId || !frames?.length || !title) {
      return c.json({ error: 'Missing jobId, frames, or title' }, 400);
    }

    // Normalize frames: strip "data:image/jpeg;base64," prefix if present.
    // The frontend uses canvas.toDataURL() which returns the full data URL,
    // but Sharp's Buffer.from(x, 'base64') needs pure base64 — otherwise
    // it decodes the prefix as garbage bytes and throws "Input buffer
    // contains unsupported image format" inside Sharp.
    // Karen 2026-04-07 main-site test caught this — first front-end run
    // failed with that error while my curl tests using pre-stripped base64
    // succeeded.
    const normalizedFrames = (frames as string[]).map((f) => {
      if (typeof f !== 'string') return f;
      const commaIdx = f.indexOf(',');
      if (f.startsWith('data:') && commaIdx > 0) {
        return f.substring(commaIdx + 1);
      }
      return f;
    });

    // Run thumbnail generation (async, returns when done)
    const result = await generateThumbnails({
      jobId,
      frames: normalizedFrames,
      title,
      videoSummary: videoSummary || '',
      videoType: videoType || 'tutorial',
    });

    return c.json({ ok: true, candidates: result.candidates });
  } catch (err) {
    console.error('Thumbnail generation error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ── Thumbnail: Debug test timestamp extraction ────────────

seoRoutes.get('/thumbnail/test-timestamps/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const { data: job } = await supabase.from('seo_jobs').select('file_key').eq('id', jobId).single();
  if (!job?.file_key) return c.json({ error: 'Job not found or no file_key' }, 404);

  // Re-register the GCS file with Gemini (same as in analyzeVideoWithGemini)
  const { GoogleAuth } = await import('google-auth-library');
  let storageOptions: any = {};
  if (process.env.GCS_KEY_JSON) {
    storageOptions = JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, 'base64').toString());
  }
  const auth = new GoogleAuth({ credentials: storageOptions, scopes: ['https://www.googleapis.com/auth/generative-language', 'https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();

  const registerRes = await fetch('https://generativelanguage.googleapis.com/v1beta/files:register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenRes.token}`,
      'x-goog-user-project': 'gen-lang-client-0010622782',
    },
    body: JSON.stringify({ uris: [job.file_key] }),
  });
  const registerData = await registerRes.json() as any;
  const fileUri = registerData?.files?.[0]?.uri;
  if (!fileUri) return c.json({ error: 'GCS register failed', detail: registerData }, 500);

  // Wait for propagation
  await new Promise(r => setTimeout(r, 3000));

  // Call extractThumbnailTimestamps
  const timestamps = await extractThumbnailTimestamps(fileUri);
  return c.json({ ok: true, fileUri, timestamps, count: timestamps.length });
});

// ── Thumbnail: Debug imgly background removal ─────────────
//
// Karen 2026-04-07: imgly was returning the raw frame in production
// (fallback path), meaning the lib silently throws on Zeabur. This
// endpoint runs imgly directly on a tiny test image and returns the
// error string so we can see what's wrong.

seoRoutes.get('/thumbnail/debug-imgly', async (c) => {
  try {
    const { removeBackground } = await import('@imgly/background-removal-node');
    // 1×1 red JPEG (smallest valid JPEG, so we don't ship test asset)
    const tinyJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+B/9k=',
      'base64',
    );
    const t0 = Date.now();
    const blob = await removeBackground(tinyJpeg, { model: 'medium' });
    const elapsed = Date.now() - t0;
    const buf = Buffer.from(await blob.arrayBuffer());
    return c.json({
      ok: true,
      elapsed_ms: elapsed,
      output_bytes: buf.length,
      cwd: process.cwd(),
    });
  } catch (err) {
    const e = err as any;
    return c.json({
      ok: false,
      error: e?.message || String(err),
      stack: (e?.stack || '').split('\n').slice(0, 10).join('\n'),
      code: e?.code,
      cwd: process.cwd(),
    }, 500);
  }
});

// ── Thumbnail: Manual learn from locked channels ──────────
//
// Triggers the locked-channel learner (MrBeast + 影視颶風) to refresh the
// reference pool used by /thumbnail/generate. Protected by ADMIN_KEY env
// var to prevent random callers burning Gemini quota.

seoRoutes.post('/thumbnail/learn', async (c) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    if (c.req.header('x-admin-key') !== adminKey) {
      return c.json({ error: 'Unauthorized — provide X-Admin-Key header' }, 401);
    }
  } else {
    console.warn('[Locked Learner] ADMIN_KEY env var not set — endpoint is unprotected');
  }

  try {
    const result = await runLockedChannelLearner();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('Locked-channel learner error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ── Thumbnail: Get candidates ─────────────────────────────

seoRoutes.get('/thumbnail/candidates/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const { data, error } = await supabase
    .from('seo_thumbnail_candidates')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at');

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ data });
});

// ── Thumbnail: Select candidate ───────────────────────────

seoRoutes.post('/thumbnail/select', async (c) => {
  const { jobId, candidateId } = await c.req.json();

  // Unselect all for this job
  await supabase.from('seo_thumbnail_candidates')
    .update({ selected: false })
    .eq('job_id', jobId);

  // Select the chosen one
  const { data, error } = await supabase.from('seo_thumbnail_candidates')
    .update({ selected: true })
    .eq('id', candidateId)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);

  // Bump weight of every reference used by the chosen candidate.
  // The new generator stores all 3 reference video_ids in
  // reference_video_ids; the legacy pattern_id is also bumped for
  // backward compat with old candidates.
  const idsToBump = new Set<string>();
  const referenceVideoIds: string[] = data?.reference_video_ids ?? [];
  if (referenceVideoIds.length > 0) {
    const { data: refs } = await supabase
      .from('seo_thumbnail_patterns')
      .select('id')
      .in('video_id', referenceVideoIds);
    for (const r of (refs ?? []) as { id: string }[]) idsToBump.add(r.id);
  }
  if (data?.pattern_id) idsToBump.add(data.pattern_id);

  for (const id of idsToBump) {
    const { data: pattern } = await supabase
      .from('seo_thumbnail_patterns')
      .select('weight')
      .eq('id', id)
      .maybeSingle();
    if (pattern) {
      await supabase
        .from('seo_thumbnail_patterns')
        .update({ weight: Math.min((pattern.weight || 1) + 0.2, 3.0) })
        .eq('id', id);
    }
  }

  return c.json({ ok: true, bumpedReferences: idsToBump.size });
});

// ── Viral Learner: Test save pipeline (bypass YouTube) ────

seoRoutes.post('/viral-learn-test', async (c) => {
  try {
    const result = await testViralLearnerSave();
    return c.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    console.error('Viral Learner test error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ── Viral Learner: Manual trigger ──────────────────────────

seoRoutes.post('/viral-learn', async (c) => {
  try {
    const result = await runViralLearner();

    // Note: thumbnail learning is no longer chained to viral-learner — it now
    // runs only on manual POST /thumbnail/learn (locked channels only).

    return c.json({ ok: true, result });
  } catch (err) {
    console.error('Viral Learner error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
