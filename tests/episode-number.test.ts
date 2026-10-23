// YouTube 標題序號（2026-10-05 oneflow）的單元測試。
// 只 import 沒有副作用的 episode-number.ts——不載入 .env、不連資料庫、不打網路。
// （seo-video.ts 檔案頂層就 createClient(...)，一 import 就會丟錯，所以那邊只讀原始碼檢查接線。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANNEL_SUFFIX, EPISODE_SUFFIX_RE, EPISODE_TAIL_PREFIX, maxEpisodeFromTitles, uploadsPlaylistUrl } from '../src/services/episode-number.js';

test('結尾固定後綴才算序號', () => {
  assert.equal(maxEpisodeFromTitles(['高音不用天分｜簡單歌唱 Singple. #842']), 842);
  assert.equal(maxEpisodeFromTitles(['A｜簡單歌唱 Singple. #840', 'B｜簡單歌唱 Singple. #843', 'C｜簡單歌唱 Singple. #841']), 843);
});

test('Singple 後面沒有句點也算', () => {
  assert.equal(maxEpisodeFromTitles(['沒有句點｜簡單歌唱 Singple #843']), 843);
});

test('結尾有空白也算', () => {
  assert.equal(maxEpisodeFromTitles(['結尾空白｜簡單歌唱 Singple. #843  ']), 843);
});

test('標題中間的 #數字不算', () => {
  assert.equal(maxEpisodeFromTitles(['3 個技巧 #900｜簡單歌唱 Singple. #842']), 842);
  assert.equal(maxEpisodeFromTitles(['#3 個技巧｜簡單歌唱 Singple. #841']), 841);
  // 「#3 個技巧」這種沒有固定後綴的標題：整支都不算
  assert.equal(maxEpisodeFromTitles(['#3 個技巧', '直播回放 #999', '練習 #1000 次']), 0);
});

test('後綴不在結尾、半形直線都不算', () => {
  assert.equal(maxEpisodeFromTitles(['｜簡單歌唱 Singple. #900 後面還有字', '正常｜簡單歌唱 Singple. #842']), 842);
  assert.equal(maxEpisodeFromTitles(['半形|簡單歌唱 Singple. #900', '全形｜簡單歌唱 Singple. #842']), 842);
});

test('空陣列、null、undefined、非字串 → 0', () => {
  assert.equal(maxEpisodeFromTitles([]), 0);
  assert.equal(maxEpisodeFromTitles([null, undefined]), 0);
  assert.equal(maxEpisodeFromTitles([null, '好的｜簡單歌唱 Singple. #842', undefined]), 842);
  assert.equal(maxEpisodeFromTitles([842 as unknown as string]), 0);
});

test('新格式 EP（2026-10-23 起）也認；新舊混著取最大', () => {
  assert.equal(maxEpisodeFromTitles(['高音不用天分｜簡單歌唱 EP854']), 854);
  assert.equal(maxEpisodeFromTitles(['新片｜簡單歌唱 EP854', '舊片｜簡單歌唱 Singple. #853']), 854);
  assert.equal(maxEpisodeFromTitles(['3 個技巧 #900｜簡單歌唱 EP854  ']), 854);
  // 沒有「｜簡單歌唱」、後面還有字、還沒給號的 EP??? → 不算
  assert.equal(maxEpisodeFromTitles(['沒前綴 EP900', '｜簡單歌唱 EP900 後面還有字', '還沒給號｜簡單歌唱 EP???']), 0);
});

test('新片結尾一律產 EP', () => {
  assert.equal(EPISODE_TAIL_PREFIX, '｜簡單歌唱 EP');
  const src = readFileSync(new URL('../src/services/seo-video.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('｜簡單歌唱 Singple. #${'), '還在產舊的「Singple. #」結尾');
  assert.ok(src.includes('`${EPISODE_TAIL_PREFIX}${episodeNumber}`'));
});

test('模型自己寫的頻道後綴（新舊都）剪乾淨', () => {
  const strip = (t: string) => t.replace(CHANNEL_SUFFIX, '').trim();
  assert.equal(strip('喉嚨痛怎麼辦｜簡單歌唱 Singple. #825'), '喉嚨痛怎麼辦');
  assert.equal(strip('喉嚨痛怎麼辦｜簡單歌唱 EP854'), '喉嚨痛怎麼辦');
  assert.equal(strip('喉嚨痛怎麼辦 | 簡單歌唱 EP???'), '喉嚨痛怎麼辦');
  assert.equal(strip('沒有後綴的標題'), '沒有後綴的標題');
});

test('EPISODE_SUFFIX_RE 跟主站、產線同一個規則', () => {
  assert.equal(EPISODE_SUFFIX_RE.source, '｜簡單歌唱(?: Singple\\.?)? ?(?:#|EP)(\\d+)\\s*$');
  assert.equal(EPISODE_SUFFIX_RE.global, false); // 不能有 g：exec 會記住上次位置
});

test('上傳清單網址：UC 換成 UU、part=snippet、maxResults=15、不是 search', () => {
  const url = uploadsPlaylistUrl('UCo3Z0bh4OnwPL5z4rMwNqbg', 'K');
  assert.ok(url.startsWith('https://www.googleapis.com/youtube/v3/playlistItems?'));
  assert.ok(url.includes('playlistId=UUo3Z0bh4OnwPL5z4rMwNqbg'));
  assert.ok(url.includes('maxResults=15'));
  assert.ok(url.includes('part=snippet'));
  assert.ok(url.includes('key=K'));
  assert.ok(!url.includes('/search'));
  assert.ok(uploadsPlaylistUrl('UCo3Z0bh4OnwPL5z4rMwNqbg', 'K', 5).includes('maxResults=5'));
});

test('seo-video.ts 的 getNextEpisodeNumber 改用上傳清單（讀原始碼檢查接線）', () => {
  const src = readFileSync(new URL('../src/services/seo-video.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ CHANNEL_SUFFIX, EPISODE_TAIL_PREFIX, maxEpisodeFromTitles, uploadsPlaylistUrl \} from '\.\/episode-number\.js';/);
  const start = src.indexOf('async function getNextEpisodeNumber()');
  assert.ok(start >= 0, '找不到 getNextEpisodeNumber');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(body.includes('uploadsPlaylistUrl(YOUTUBE_CHANNEL_ID, YOUTUBE_API_KEY)'));
  assert.ok(body.includes('maxEpisodeFromTitles('));
  assert.ok(!body.includes('/youtube/v3/search'), '還在用 search.list');
  assert.ok(!/match\(\/#\(\\d\+\)\/\)/.test(body), '還在用「標題任何位置的 #數字」');
  // 2026-08 金鑰過期靜默一個月的教訓：失敗要出聲的那段原樣保留
  assert.ok(body.includes('if (!res.ok || data.error) {'));
  assert.ok(body.includes('[SEO] YouTube 取集數失敗 (HTTP ${res.status})'));
  // 上傳清單裡一支帶後綴的都沒有：也要出聲（不然標題默默變 #???）
  assert.ok(body.includes("console.warn('[SEO] YouTube 上傳清單最新 15 支都沒有"));
});
