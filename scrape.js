// scraper/scrape.js — 每天由 GitHub Actions 執行
// 讀 Supabase 的 watch_targets 名單 → 抓各來源 → 寫回 signals / market_materials
// 金鑰一律從環境變數來(GitHub Secrets),絕不寫在程式裡

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json'
};
const today = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

async function db(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) }
  });
  if (!r.ok) throw new Error(`DB ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

function upsertSignal(row) {
  return db('signals?on_conflict=stat_date,competitor,source', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([row])
  });
}

/* ---------- Google Play:評分、評論數、最新評論 ---------- */
async function googlePlay(t) {
  if (!t.google_play_id) return null;
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(t.google_play_id)}&hl=zh_TW&gl=TW`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();

  // 頁面內嵌的 JSON 裡有評分與評論數;正則抓不到就回報 null,不要猜
  const rating = (html.match(/"([0-4]\.\d|5\.0)"\s*,\s*"星"/) || html.match(/aria-label="評分為 ([\d.]+) 顆星/) || [])[1];
  const reviews = (html.match(/([\d,.]+萬?)\s*則評論/) || [])[1];

  // 最新幾則評論文字(頁面上就有,取前三則、各截 80 字)
  const samples = [];
  const re = /"((?:[^"\\]|\\.){20,300})",\s*null,\s*\[\s*\d+\s*,/g;
  let m, n = 0;
  while ((m = re.exec(html)) && n < 3) {
    const text = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    if (/[\u4e00-\u9fff]/.test(text)) { samples.push(text.slice(0, 80)); n++; }
  }

  return {
    stat_date: today, competitor: t.name, source: 'googleplay',
    metrics: { rating: rating ? parseFloat(rating) : null, review_count_text: reviews || null },
    samples
  };
}

/* ---------- App Store:官方公開 RSS,最穩的一條 ---------- */
async function appStore(t) {
  if (!t.appstore_id) return null;
  const url = `https://itunes.apple.com/tw/rss/customerreviews/id=${t.appstore_id}/sortby=mostrecent/json`;
  const j = await (await fetch(url, { headers: { 'User-Agent': UA } })).json();
  const entries = (j.feed && j.feed.entry) || [];
  const reviews = entries.filter(e => e['im:rating']);
  const ratings = reviews.map(e => parseInt(e['im:rating'].label, 10)).filter(n => n >= 1);
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  return {
    stat_date: today, competitor: t.name, source: 'appstore',
    metrics: {
      recent_avg_rating: avg ? +avg.toFixed(2) : null,
      recent_count: ratings.length,
      one_star_share: ratings.length ? +(ratings.filter(r => r === 1).length / ratings.length).toFixed(2) : null
    },
    samples: reviews.slice(0, 3).map(e => `[${e['im:rating'].label}星] ${(e.title?.label || '')}:${(e.content?.label || '').slice(0, 70)}`)
  };
}

/* ---------- 巴哈姆特:搜尋結果聲量(盡力而為,改版會斷) ---------- */
async function bahamut(t) {
  const kw = t.bahamut_kw || t.name;
  if (!kw) return null;
  const url = `https://search.gamer.com.tw/?q=${encodeURIComponent(kw)}&s=2`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.gamer.com.tw/' } })).text();
  const titles = [...html.matchAll(/<h1[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  return {
    stat_date: today, competitor: t.name, source: 'bahamut',
    metrics: { result_titles: titles.length },
    samples: titles.slice(0, 5).map(s => s.slice(0, 60))
  };
}

/* ---------- 主流程:單一來源失敗不拖垮整輪 ---------- */
(async () => {
  const targets = await db('watch_targets?select=*&enabled=eq.true&deleted_at=is.null');
  if (!targets.length) { console.log('名單是空的,結束。'); return; }
  console.log(`監控 ${targets.length} 個競品`);

  const errors = [];
  for (const t of targets) {
    for (const [label, fn] of [['GooglePlay', googlePlay], ['AppStore', appStore], ['巴哈', bahamut]]) {
      try {
        const row = await fn(t);
        if (row) { await upsertSignal(row); console.log(`OK  ${t.name} · ${label}`); }
      } catch (e) {
        errors.push(`${t.name} · ${label}:${e.message}`);
        console.error(`FAIL ${t.name} · ${label}:${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2500)); // 放緩,一天一輪不用急
    }
  }

  // 失敗不能安靜:寫進 import_log,工具開頁看得到
  if (errors.length) {
    await db('import_log?on_conflict=stat_date,channel,source', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        stat_date: today, channel: '競品監控', source: 'github_actions',
        row_count: targets.length * 3 - errors.length, status: 'partial',
        message: errors.slice(0, 5).join(' | ')
      }])
    }).catch(() => {});
    process.exit(1); // 讓 Actions 顯示紅色,GitHub 會寄通知信給你
  }
})();
