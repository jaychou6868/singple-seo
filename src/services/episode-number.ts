// YouTube 標題序號（2026-10-05 oneflow）：只認標題結尾的固定後綴。
// 這支模組沒有任何副作用（不讀 env、不連資料庫、不打網路），測試可以直接 import。
// 2026-10-23 Karen 定：結尾的「#853」在 YouTube 會變成可點的 hashtag（把人帶去不相關的影片）→ 新片一律「｜簡單歌唱 EP854」；
// 舊片標題「｜簡單歌唱 Singple. #843」不改，所以新舊都認（跟主站 src/lib/ytEpisodeCore.ts、產線 youtube_title_generator.py 同一條）。
export const EPISODE_SUFFIX_RE = /｜簡單歌唱(?: Singple\.?)? ?(?:#|EP)(\d+)\s*$/;
/** 新片標題結尾（接號碼） */
export const EPISODE_TAIL_PREFIX = '｜簡單歌唱 EP';
/** 模型自己寫進標題的頻道後綴（新「｜簡單歌唱 EP854」、舊「｜簡單歌唱 Singple. #xxx」）——半形直線也認，一路剪到結尾。 */
export const CHANNEL_SUFFIX = /\s*[｜|]\s*簡單歌唱\s*(?:Singple|EP).*$/;

/** 一組標題裡結尾後綴的最大號；都沒有 → 0 */
export function maxEpisodeFromTitles(titles: Array<string | null | undefined>): number {
  let max = 0;
  for (const t of titles) {
    const m = typeof t === 'string' ? EPISODE_SUFFIX_RE.exec(t) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 頻道的「上傳」播放清單：頻道 id 開頭 UC 換成 UU（playlistItems 1 配額；search.list 100 配額而且常漏最新片） */
export function uploadsPlaylistUrl(channelId: string, apiKey: string, maxResults = 15): string {
  const playlistId = 'UU' + channelId.slice(2);
  return `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=${maxResults}&key=${apiKey}`;
}
