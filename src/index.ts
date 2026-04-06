import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import cron from 'node-cron';
import { seoRoutes } from './services/seo-routes.js';
import { runViralLearner } from './services/viral-learner.js';

const app = new Hono();

// Allow cross-origin from main site
app.use('*', cors({
  origin: ['https://singple-marketing.zeabur.app', 'http://localhost:3000'],
  credentials: true,
}));

// Health check
app.get('/health', (c) => c.json({ ok: true }));

// Serve SEO page directly
app.get('/seo', async (c) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const html = fs.readFileSync(path.join(dir, 'templates/seo-video-new.html'), 'utf-8');
  return c.html(html);
});

// SEO routes
app.route('/api/seo', seoRoutes);

// ── Cron: Viral Learner (Every Monday 09:00 Taiwan / 01:00 UTC) ──
cron.schedule('0 1 * * 1', async () => {
  console.log('[Viral Learner] Weekly learning started');
  try {
    await runViralLearner();
    console.log('[Viral Learner] Weekly learning completed');
  } catch (err) {
    console.error('[Viral Learner] Error:', err);
  }
});

// Start
const port = Number(process.env.PORT) || 3001;
console.log(`SEO service starting on port ${port}...`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SEO service running at http://localhost:${info.port}`);
});

export default app;
