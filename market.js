/* market.js — 市場競品：蒐集（Apify／JSON／書籤）、AI 標籤、存活切分、分佈對比 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var API = 'https://api.apify.com/v2/';
  var DEFAULT_ACTOR = 'silva95gustavo~google-ads-scraper';
  var K = {
    token: 'mt2_apify_token', actor: 'mt2_apify_actor',
    params: 'mt2_apify_params', targets: 'mt2_apify_targets', lastRun: 'mt2_apify_lastrun',
    platform: 'mt2_mk_platform', metaActor: 'mt2_meta_actor', metaTargets: 'mt2_meta_targets'
  };
  // Meta 廣告檔案庫沒有免費的公開 API，市面上的 actor 不只一支、輸入格式也不一樣，
  // 所以預設值只是起點，不對的話在畫面上直接改。
  var META_DEFAULT_ACTOR = 'curious_coder~facebook-ads-library-scraper';

  function platform() { return localStorage.getItem(K.platform) || 'google'; }
  function metaActor() { return (localStorage.getItem(K.metaActor) || '').trim() || META_DEFAULT_ACTOR; }
  function metaTargets() { var t = lsGet(K.metaTargets, null); return Array.isArray(t) ? t : []; }

  // Meta 廣告檔案庫的搜尋網址
  function metaUrl(t) {
    var p = params();
    var c = encodeURIComponent(p.region || 'TW');
    if (t.type === 'page') {
      return 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + c +
             '&view_all_page_id=' + encodeURIComponent(String(t.value).trim()) + '&search_type=page';
    }
    return 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + c +
           '&q=' + encodeURIComponent(String(t.value).trim()) + '&search_type=keyword_unordered';
  }
  var ctx = { materials: [], market: [], dimensions: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function today() { return new Date().toISOString().slice(0, 10); }

  function token() { return (localStorage.getItem(K.token) || '').trim(); }
  function actor() { return (localStorage.getItem(K.actor) || '').trim() || DEFAULT_ACTOR; }
  function params() { return Object.assign({ region: 'TW', limit: 100, days: 30 }, lsGet(K.params, {})); }
  function targets() { var t = lsGet(K.targets, null); return Array.isArray(t) ? t : []; }

  /* ============ 抓取結果正規化 ============ */
  var IMG_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;
  var IMG_HOST = /(googleusercontent|ggpht|gstatic|fbcdn|cdninstagram)\./i;

  function walk(obj, fn, path) {
    path = path || '';
    if (obj == null) return;
    if (typeof obj !== 'object') { fn(path, obj); return; }
    Object.keys(obj).forEach(function (k) {
      walk(obj[k], fn, path ? path + '.' + k : k);
    });
  }

  function djb2(str) {
    var h = 5381, i = String(str).length;
    while (i) h = (h * 33) ^ String(str).charCodeAt(--i);
    return (h >>> 0).toString(16);
  }

  function extractAd(item) {
    var out = { image: null, adUrl: null, advertiser: '', id: '', date: '' };
    var dates = [];
    walk(item, function (key, val) {
      var k = String(key).toLowerCase(), v = String(val);
      if (/^https?:\/\//i.test(v)) {
        if (!out.adUrl && /adstransparency\.google\.com/i.test(v)) out.adUrl = v;
        var looksImg = IMG_EXT.test(v) || IMG_HOST.test(v);
        var badKey = /destination|landing|click|advertiserurl|profile|favicon|logo/i.test(k);
        if (!out.image && looksImg && !badKey && !/adstransparency\.google\.com/i.test(v)) out.image = v;
      }
      if (!out.advertiser &&
          /(^|\.)(advertiser|brand|company|domain|page|pagename)(name|title|\.name|\.title)?$/i.test(k) &&
          !/id$/i.test(k) && v && !/^https?:/i.test(v) && v.length < 80) out.advertiser = v;
      if (!out.id && /(^|\.)(adarchiveid|archiveid|libraryid|creativeid|adid|creative_id|ad_id|id)$/i.test(k) && v) out.id = v;
      if (/first|start|shown|date|since/i.test(k) && v && !/^https?:/i.test(v)) dates.push(v);
    });
    var parsed = dates.map(function (v) { var d = new Date(v); return isNaN(d.getTime()) ? null : d; })
                      .filter(Boolean).sort(function (a, b) { return a - b; });
    if (parsed.length) out.date = parsed[0].toISOString().slice(0, 10);
    return out;
  }

  // 純文字或純影片廣告沒有圖，做不了視覺分析，直接略過並回報數量
  function normalize(list) {
    var rows = [], noImage = 0;
    (list || []).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var f = extractAd(it);
      if (!f.image) { noImage++; return; }
      var comp = String(f.advertiser || '未命名').slice(0, 60);
      // 同一支廣告第二次抓回來時，CDN 網址常會多出尺寸參數。
      // 編號若混進網址，同一支廣告會被當成新素材，存活天數就永遠算不出來。
      var id = 'ap' + djb2(f.id ? 'id:' + f.id : 'img:' + String(f.image).split('?')[0]);
      rows.push({
        competitor: comp,
        material_key: id,
        material_name: '市場_' + comp + '_' + id,
        image_url: f.image,
        first_seen_on: f.date || today(),
        last_seen_on: today()
      });
    });
    return { rows: rows, noImage: noImage };
  }

  function ingest(list, label) {
    var n = normalize(list);
    if (!n.rows.length) {
      alert('沒有取得可用的素材。\n\n共 ' + (list || []).length + ' 筆資料，其中 ' +
            n.noImage + ' 筆沒有圖片（純文字或影片廣告）。');
      return Promise.resolve(0);
    }

    // 抓回來的廣告主名稱如果全部一樣或全是「未命名」，多半是來源本身沒帶這個欄位
    // （Meta 書籤就是這種情況）。這時候問一次，總比整批掛在同一個假名字下好。
    var comps = {};
    n.rows.forEach(function (r) { comps[r.competitor] = 1; });
    var names = Object.keys(comps);
    if (names.length === 1 && (names[0] === '未命名' || label === '匯入')) {
      var input = prompt('這批素材要歸給哪個競品？', names[0] === '未命名' ? '' : names[0]);
      if (input === null) return Promise.resolve(0);
      var chosen = input.trim() || names[0];
      n.rows.forEach(function (r) { r.competitor = chosen; });
    }

    var imgByKey = {};
    n.rows.forEach(function (r) { imgByKey[r.competitor + '|' + r.material_key] = r.image_url; });

    var merged = Data.mergeMarket(n.rows, ctx.market).map(function (r) {
      var url = imgByKey[r.competitor + '|' + r.material_key];
      // 合併只處理日期，圖片網址要自己補回去，否則競品素材會全部沒有圖
      return url ? Object.assign({}, r, { image_url: url }) : r;
    });

    // upsert 要求每筆的欄位一致，補齊缺的那個鍵
    merged.forEach(function (r) { if (!('image_url' in r)) r.image_url = null; });
    return Cloud.saveMarket(merged).then(function () {
      return global.__reload ? global.__reload() : null;
    }).then(function () {
      alert(label + '完成：' + merged.length + ' 個競品素材已更新。' +
            (n.noImage ? '\n另有 ' + n.noImage + ' 筆沒有圖片，已略過。' : ''));
      return merged.length;
    });
  }

  /* ============ Apify ============ */
  function targetUrl(t) {
    var p = params();
    var region = encodeURIComponent(p.region || 'TW');
    var days = p.days ? '&preset-date=Last+' + p.days + '+days' : '';
    if (t.type === 'url') return String(t.value);
    if (t.type === 'advertiser') {
      return 'https://adstransparency.google.com/advertiser/' +
             encodeURIComponent(String(t.value).trim()) + '?region=' + region + days;
    }
    return 'https://adstransparency.google.com/?region=' + region +
           '&domain=' + encodeURIComponent(String(t.value).trim()) + days;
  }

  function apifyReq(path, opts) {
    return fetch(API + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token()), opts)
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('Apify ' + r.status + '：' + t.slice(0, 200)); });
        return r.json();
      });
  }

  function currentInput() {
    var p = params();
    var limit = Math.max(1, Math.min(1000, +p.limit || 100));
    if (platform() === 'meta') {
      var on = metaTargets().filter(function (t) { return t.on; });
      return {
        count: limit,
        'scrapeAdDetails': true,
        'scrapePageAds.activeStatus': 'all',
        urls: on.map(function (t) { return { url: metaUrl(t), method: 'GET' }; })
      };
    }
    var g = targets().filter(function (t) { return t.on; });
    return {
      ocr: false,
      resultsLimit: limit,
      shouldDownloadAssets: false,
      shouldDownloadPreviews: false,
      skipDetails: false,
      startUrls: g.map(function (t) { return { url: targetUrl(t) }; })
    };
  }

  function runApify(onStatus) {
    var isMeta = platform() === 'meta';
    var on = (isMeta ? metaTargets() : targets()).filter(function (t) { return t.on; });
    if (!token()) return Promise.reject(new Error('尚未設定 Apify token'));
    if (!on.length) return Promise.reject(new Error('沒有勾選任何監控對象'));

    var custom = $('mk-input') && $('mk-input').value.trim();
    var input;
    if (custom) {
      try { input = JSON.parse(custom); }
      catch (e) { return Promise.reject(new Error('自訂輸入不是有效的 JSON')); }
    } else {
      input = currentInput();
    }

    onStatus('送出抓取任務…');
    return apifyReq('acts/' + encodeURIComponent(isMeta ? metaActor() : actor()) + '/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }).then(function (j) {
      var runId = j.data.id;
      lsSet(K.lastRun, { id: runId, at: new Date().toISOString() });
      var tries = 0;
      function poll() {
        tries++;
        onStatus('抓取中…（已等待 ' + (tries * 5) + ' 秒，通常一到三分鐘）');
        return new Promise(function (res) { setTimeout(res, 5000); })
          .then(function () { return apifyReq('actor-runs/' + runId); })
          .then(function (r) {
            var st = r.data.status;
            if (st === 'SUCCEEDED') return r.data.defaultDatasetId;
            if (st === 'FAILED' || st === 'ABORTED' || st === 'TIMED-OUT') {
              throw new Error('抓取任務 ' + st + '，請到 Apify 後台看原因');
            }
            if (tries > 60) throw new Error('等待超過五分鐘，任務可能還在跑。稍後用「讀取最近一次執行」取回結果。');
            return poll();
          });
      }
      return poll();
    }).then(function (dsId) {
      onStatus('下載結果…');
      return apifyReq('datasets/' + dsId + '/items?clean=true&format=json');
    });
  }

  function loadLastRun(onStatus) {
    var last = lsGet(K.lastRun, null);
    if (!last || !last.id) return Promise.reject(new Error('這台電腦沒有最近一次執行的紀錄'));
    onStatus('讀取上次結果…');
    return apifyReq('actor-runs/' + last.id).then(function (r) {
      if (r.data.status !== 'SUCCEEDED') throw new Error('上次執行的狀態是 ' + r.data.status + '，還沒有結果');
      return apifyReq('datasets/' + r.data.defaultDatasetId + '/items?clean=true&format=json');
    });
  }

  /* ============ 存活天數切分 ============ */
  function survivalDays(m) {
    if (m.survival_days != null) return Math.max(1, Math.min(365, m.survival_days));
    if (!m.first_seen_on) return 1;
    var a = new Date(m.first_seen_on).getTime();
    if (isNaN(a)) return 1;
    var b = m.last_seen_on ? new Date(m.last_seen_on).getTime() : Date.now();
    if (isNaN(b)) b = Date.now();
    return Math.max(1, Math.min(365, Math.round((b - a) / 86400000)));
  }

  function share(list, dims, weighted) {
    var out = {};
    dims.forEach(function (dim) {
      var g = {}, tot = 0;
      list.forEach(function (m) {
        var v = m.tags && m.tags[dim]; if (!v) return;
        v = String(v).replace(/\s*[（(]不確定[)）]\s*/g, '').trim(); if (!v) return;
        var w = weighted ? survivalDays(m) : 1;
        g[v] = (g[v] || 0) + w; tot += w;
      });
      if (tot) { out[dim] = {}; Object.keys(g).forEach(function (k) { out[dim][k] = g[k] / tot * 100; }); }
    });
    return out;
  }

  function renderSurvival() {
    var box = $('survival'); if (!box) return;
    var pool = (ctx.market || []).filter(function (m) { return m.tags && Object.keys(m.tags).length && m.first_seen_on; });
    if (pool.length < 6) {
      box.innerHTML = '<div class="empty">需要至少 6 支「已標籤且有首見日期」的競品素材，目前 ' + pool.length + ' 支。</div>';
      return;
    }
    var sorted = pool.map(function (m) { return { it: m, d: survivalDays(m) }; })
                     .sort(function (a, b) { return b.d - a.d; });
    // 取頭尾各三分之一，中間段捨去——中間的訊號最模糊，納入只會稀釋差異
    var n = Math.max(3, Math.floor(sorted.length / 3));
    var long = sorted.slice(0, n), short = sorted.slice(-n);
    if (long[long.length - 1].d <= short[0].d) {
      box.innerHTML = '<div class="empty">長短兩組的存活天數沒有區隔（首見日期可能都太接近），無法比較。</div>';
      return;
    }
    var dims = Dims.allDims(ctx, true);
    var L = share(long.map(function (x) { return x.it; }), dims, false);
    var S = share(short.map(function (x) { return x.it; }), dims, false);

    var rows = [];
    dims.forEach(function (dim) {
      var a = L[dim] || {}, b = S[dim] || {};
      var keys = {};
      Object.keys(a).forEach(function (k) { keys[k] = 1; });
      Object.keys(b).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var l = a[k] || 0, sh = b[k] || 0, diff = l - sh;
        if (Math.abs(diff) >= 15) rows.push({ dim: dim, key: k, long: l, short: sh, diff: diff });
      });
    });
    rows.sort(function (x, y) { return Math.abs(y.diff) - Math.abs(x.diff); });

    if (!rows.length) {
      box.innerHTML = '<div class="empty">長短存活兩組在各維度上沒有 15 個百分點以上的差異。</div>';
      return;
    }

    box.innerHTML = '<div class="xmeta">' + pool.length + ' 支已標籤素材，取存活最久與最短各 ' + n +
      ' 支對比（存活 ' + long[long.length - 1].d + '～' + long[0].d + ' 天 vs ' +
      short[short.length - 1].d + '～' + short[0].d + ' 天），中間段捨去。</div>' +
      '<table><thead><tr><th>維度</th><th>特徵值</th><th class="num">長存活</th>' +
      '<th class="num">短存活</th><th class="num">差距</th></tr></thead><tbody>' +
      rows.slice(0, 20).map(function (r) {
        var cls = r.diff > 0 ? 'pos' : 'neg';
        return '<tr><td>' + esc(r.dim) + '</td><td>' + esc(r.key) + '</td>' +
          '<td class="num">' + r.long.toFixed(0) + '%</td><td class="num">' + r.short.toFixed(0) + '%</td>' +
          '<td class="num imp-val ' + cls + '">' + (r.diff > 0 ? '+' : '') + r.diff.toFixed(0) + 'pt</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="caveat">讀法：綠色代表這個特徵在「掛比較久」的素材裡更常見，可能是競品驗證過有效的做法。' +
      '這是相關不是因果——素材掛得久也可能只是因為預算或檔期安排。切分用未加權的占比，' +
      '避免同一支長壽素材同時決定分組又主導組內占比。</p>';
  }

  /* ============ 我方 × 市場 分佈對比 ============ */
  function renderDistCompare() {
    var box = $('dist-compare'); if (!box) return;
    var mk = (ctx.market || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });
    var ow = (ctx.materials || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });
    if (mk.length < 5 || ow.length < 3) {
      box.innerHTML = '<div class="empty">需要至少 5 支已標籤的競品素材（目前 ' + mk.length +
        '）與 3 個已標籤的我方素材（目前 ' + ow.length + '）。</div>';
      return;
    }
    var dims = Dims.allDims(ctx, true);
    var A = share(mk, dims, true), B = share(ow, dims, false);

    var html = '<div class="xmeta">市場端以存活天數加權，我方端每支同權。灰色是市場、綠色是我方。</div><div class="xgrid">';
    dims.forEach(function (dim) {
      if (!A[dim] && !B[dim]) return;
      var keys = {};
      Object.keys(A[dim] || {}).forEach(function (k) { keys[k] = 1; });
      Object.keys(B[dim] || {}).forEach(function (k) { keys[k] = 1; });
      var list = Object.keys(keys).map(function (k) {
        return { key: k, a: (A[dim] || {})[k] || 0, b: (B[dim] || {})[k] || 0 };
      }).sort(function (x, y) { return (y.a + y.b) - (x.a + x.b); }).slice(0, 6);
      if (!list.length) return;
      html += '<div class="xcard"><div class="xdim">' + esc(dim) + '</div>' +
        list.map(function (v) {
          var gap = Math.abs(v.a - v.b) >= 30;
          return '<div class="dc-row"><div class="xlabel">' + esc(v.key) +
            (gap ? '<span class="badge">落差大</span>' : '') + '</div>' +
            '<div class="dc-bars">' +
            '<div class="dc-bar mkt" style="width:' + Math.max(1, v.a) + '%"></div>' +
            '<div class="dc-bar own" style="width:' + Math.max(1, v.b) + '%"></div></div>' +
            '<div class="xval">' + v.a.toFixed(0) + '／' + v.b.toFixed(0) + '%</div></div>';
        }).join('') + '</div>';
    });
    box.innerHTML = html + '</div>' +
      '<p class="caveat">數字是「市場／我方」的占比。落差 30 個百分點以上會標記，' +
      '但落差不等於做錯——品牌定位不同本來就會有差異。要 AI 幫忙解讀的話，到「AI 標籤」分頁按產生解讀。</p>';
  }

  /* ============ 競品素材 AI 標籤 ============ */
  // 競品素材的名稱是機器編的，沒有語意，所以一定要看圖才標得準。
  // 圖片來自外部 CDN，有些網域擋跨站讀取，抓不到的會被略過並回報數量。
  function tagMarket(onStatus) {
    var want = Dims.allDims(ctx, true);
    var todo = (ctx.market || []).filter(function (m) {
      if (!m.image_url) return false;
      if (!m.tags || !Object.keys(m.tags).length) return true;
      return want.some(function (d) { return m.tags[d] == null || m.tags[d] === ''; });
    });
    if (!todo.length) return Promise.resolve({ done: 0, blocked: 0, total: 0 });

    var results = [], blocked = 0, done = 0;
    var chain = Promise.resolve();

    todo.slice(0, 60).forEach(function (m) {
      chain = chain.then(function () {
        onStatus('標記中：' + (done + 1) + ' / ' + Math.min(60, todo.length));
        return fetch(m.image_url).then(function (r) {
          if (!r.ok) throw new Error('http');
          return r.blob();
        }).then(function (b) {
          var mime = b.type && /^image\//.test(b.type) ? b.type : 'image/jpeg';
          return new Promise(function (res, rej) {
            var fr = new FileReader();
            fr.onload = function () { res(String(fr.result).split(',')[1]); };
            fr.onerror = rej;
            fr.readAsDataURL(b);
          }).then(function (b64) {
            return AI.callGeminiVision(b64, want, mime);
          });
        }).then(function (tags) {
          if (tags) {
            results.push({
              competitor: m.competitor, material_key: m.material_key, material_name: m.material_name,
              tags: tags, tag_version: AI.TAG_VERSION, tagged_at: new Date().toISOString()
            });
          }
          done++;
        }).catch(function () { blocked++; done++; });
      });
    });

    return chain.then(function () {
      if (!results.length) return { done: 0, blocked: blocked, total: todo.length };
      return Cloud.saveMarket(results).then(function () {
        return global.__reload ? global.__reload() : null;
      }).then(function () { return { done: results.length, blocked: blocked, total: todo.length }; });
    });
  }

  /* ============ 設定與蒐集介面 ============ */
  function renderCollect() {
    var box = $('collect'); if (!box) return;
    var p = params(), isMeta = platform() === 'meta';
    var list = isMeta ? metaTargets() : targets();

    box.innerHTML =
      '<div class="keybar">' +
        '<select id="mk-platform">' +
          '<option value="google"' + (isMeta ? '' : ' selected') + '>Google 廣告透明中心</option>' +
          '<option value="meta"' + (isMeta ? ' selected' : '') + '>Meta 廣告檔案庫</option>' +
        '</select>' +
        '<span class="apibadge ' + (token() ? 'on' : 'off') + '">' +
          (token() ? 'Apify token 已設定' : '未設定 Apify token') + '</span>' +
        '<button class="ghost" id="mk-token">' + (token() ? '更換 token' : '設定 token') + '</button>' +
        '<input id="mk-actor" value="' + esc(isMeta ? metaActor() : actor()) + '" style="width:280px" title="Apify actor">' +
      '</div>' +
      '<div class="filter-row" style="margin-bottom:12px">' +
        '<label>地區 <input id="mk-region" value="' + esc(p.region) + '" style="width:70px"></label>' +
        '<label>筆數上限 <input id="mk-limit" type="number" value="' + p.limit + '" style="width:90px"></label>' +
        (isMeta ? '' : '<label>近幾天 <input id="mk-days" type="number" value="' + p.days + '" style="width:90px"></label>') +
      '</div>' +
      '<h3 class="g-h">監控對象</h3>' +
      (list.length ? '<div class="tg-list">' + list.map(function (t, i) {
        return '<label class="tg"><input type="checkbox" class="tg-on" data-i="' + i + '"' + (t.on ? ' checked' : '') + '>' +
          '<span class="tg-name">' + esc(t.name || t.value) + '</span>' +
          '<span class="muted">' + esc(t.type) + '：' + esc(t.value) + '</span>' +
          '<a class="link" href="' + esc(isMeta ? metaUrl(t) : targetUrl(t)) + '" target="_blank" rel="noopener">開啟</a>' +
          '<button class="link tg-del" data-i="' + i + '">刪除</button></label>';
      }).join('') + '</div>' : '<div class="empty">還沒有監控對象。用下面的欄位新增。</div>') +
      '<div class="dim-add" style="margin-top:12px">' +
        '<select id="tg-type">' +
          (isMeta
            ? '<option value="keyword">關鍵字</option><option value="page">粉絲專頁 ID</option>'
            : '<option value="domain">網域</option><option value="advertiser">廣告主 ID</option><option value="url">完整網址</option>') +
        '</select>' +
        '<input id="tg-name" placeholder="顯示名稱，例如 天堂W">' +
        '<input id="tg-value" placeholder="' + (isMeta ? '例如 天堂W 或 105… 粉專 ID' : '例如 lineagew.com.tw') + '">' +
        '<button class="ghost" id="tg-add">新增</button>' +
      '</div>' +
      '<details class="adv"><summary>進階：自訂送給 actor 的輸入 JSON</summary>' +
        '<textarea id="mk-input" rows="6" placeholder="留空就用預設。不同 actor 的輸入格式不一樣，' +
        '照 Apify 頁面上的說明填。"></textarea>' +
        '<div class="xmeta">目前的預設輸入：<code>' + esc(JSON.stringify(currentInput())) + '</code></div>' +
      '</details>' +
      '<div class="manual-actions" style="margin-top:16px">' +
        '<button class="ghost" id="mk-run">執行新一輪抓取</button>' +
        '<button class="ghost" id="mk-last">讀取最近一次執行</button>' +
        '<button class="ghost" id="mk-json">上傳擷取檔 JSON</button>' +
        (isMeta ? '<button class="ghost" id="mk-book">不用 Apify：Meta 頁面書籤</button>' : '') +
      '</div>' +
      '<div id="mk-status" class="xmeta" style="margin-top:10px"></div>';

    bindCollect();
  }

  function status(msg) { if ($('mk-status')) $('mk-status').textContent = msg || ''; }

  function bindCollect() {
    $('mk-platform').onchange = function () {
      localStorage.setItem(K.platform, this.value);
      if ($('mk-bookmarklet')) $('mk-bookmarklet').innerHTML = '';
      renderCollect();
    };
    $('mk-token').onclick = function () {
      var t = prompt('貼上 Apify API token（只存在這台電腦）', '');
      if (t == null) return;
      localStorage.setItem(K.token, t.trim()); renderCollect();
    };
    $('mk-actor').onchange = function () {
      localStorage.setItem(platform() === 'meta' ? K.metaActor : K.actor, this.value.trim());
    };
    ['region', 'limit', 'days'].forEach(function (f) {
      if (!$('mk-' + f)) return;
      $('mk-' + f).onchange = function () {
        var p = params(); p[f] = f === 'region' ? this.value.trim() : parseInt(this.value, 10) || 0;
        lsSet(K.params, p);
      };
    });
    $('tg-add').onclick = function () {
      var v = $('tg-value').value.trim();
      if (!v) { alert('請填監控對象的值。'); return; }
      var isMeta = platform() === 'meta';
      var list = isMeta ? metaTargets() : targets();
      list.push({ name: $('tg-name').value.trim() || v, type: $('tg-type').value, value: v, on: true });
      lsSet(isMeta ? K.metaTargets : K.targets, list); renderCollect();
    };
    function store() { return platform() === 'meta' ? K.metaTargets : K.targets; }
    function cur() { return platform() === 'meta' ? metaTargets() : targets(); }
    Array.prototype.forEach.call(document.querySelectorAll('.tg-on'), function (cb) {
      cb.onchange = function () {
        var list = cur(); list[+cb.getAttribute('data-i')].on = cb.checked; lsSet(store(), list);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tg-del'), function (b) {
      b.onclick = function () {
        var list = cur(); list.splice(+b.getAttribute('data-i'), 1); lsSet(store(), list); renderCollect();
      };
    });

    $('mk-run').onclick = function () {
      $('mk-run').disabled = true;
      runApify(status).then(function (items) { return ingest(items, '抓取'); })
        .catch(function (e) { status(''); alert('抓取失敗：' + e.message); })
        .then(function () { $('mk-run').disabled = false; status(''); });
    };
    $('mk-last').onclick = function () {
      loadLastRun(status).then(function (items) { return ingest(items, '讀取'); })
        .catch(function (e) { status(''); alert(e.message); });
    };
    $('mk-json').onclick = function () { $('mk-json-input').click(); };
    if ($('mk-book')) $('mk-book').onclick = showBookmarklet;
  }

  /* Meta 廣告庫沒有公開 API，用書籤在你自己的瀏覽器頁面上取資料 */
  /* Meta 廣告檔案庫沒有免費的公開 API。這段書籤在你自己已經開著的頁面上取資料，
     每張圖往上找到它所屬的廣告卡片，再從卡片裡讀廣告主名稱，
     這樣同一次搜尋裡不同品牌的廣告才不會全部掛在同一個名字下。 */
  function showBookmarklet() {
    var code = "javascript:(function(){" +
      "function up(el){var n=el,i=0;while(n&&i<10){if(/Library ID|廣告檔案庫 ID|識別碼/.test(n.innerText||''))return n;n=n.parentElement;i++;}return null;}" +
      "var out=[],seen={};" +
      "document.querySelectorAll('img').forEach(function(im){" +
      "if(im.naturalWidth<200||im.naturalHeight<200)return;" +
      "if(seen[im.src])return;seen[im.src]=1;" +
      "var card=up(im),name='',id='';" +
      "if(card){var a=card.querySelector('a[href*=\"view_all_page_id\"],a[href*=\"facebook.com/\"]');" +
      "if(a)name=(a.innerText||'').trim().split('\\n')[0];" +
      "var m=(card.innerText||'').match(/(?:Library ID|廣告檔案庫 ID|識別碼)[:：]?\\s*(\\d+)/);if(m)id=m[1];}" +
      "out.push({pageName:name||document.title,adArchiveId:id,image:im.src,startDate:''});});" +
      "if(!out.length){alert('這個頁面上沒有抓到夠大的圖片。請先往下捲動讓廣告載入。');return;}" +
      "var b=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});" +
      "var a=document.createElement('a');a.href=URL.createObjectURL(b);" +
      "a.download='meta_ads.json';a.click();alert('已下載 '+out.length+' 筆。');})()";

    var out = $('mk-bookmarklet');
    out.innerHTML = '<div class="xmeta"><b>不用 Apify 也能蒐集 Meta 素材</b>，但要手動走四步：</div>' +
      '<ol class="steps">' +
      '<li>把下面這段存成瀏覽器書籤（書籤列按右鍵 → 加入網頁，名稱隨意、網址貼這段）</li>' +
      '<li>到 Meta 廣告檔案庫搜尋你要看的品牌，<b>往下捲動</b>讓廣告載入（捲多少就抓多少）</li>' +
      '<li>點那個書籤，會下載一個 JSON 檔</li>' +
      '<li>回來按「上傳擷取檔 JSON」把它帶進來</li>' +
      '</ol>' +
      '<textarea readonly rows="5" class="mp-prompt">' + esc(code) + '</textarea>' +
      '<div class="manual-actions"><button class="ghost" id="bk-copy">複製書籤程式碼</button>' +
      '<a class="ghost btnlink" href="https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=TW" ' +
      'target="_blank" rel="noopener">開啟 Meta 廣告檔案庫</a></div>' +
      '<p class="caveat">它只讀取你當下看到的頁面，不會傳送任何資料到外部。' +
      '每張圖會往上找到所屬的廣告卡片，從卡片裡讀廣告主名稱和廣告檔案庫 ID——' +
      '所以同一次搜尋裡不同品牌的廣告會正確分開。' +
      'Meta 的頁面結構會改，哪天抓不到名稱時它會退回用頁面標題，那時候跟我說我來調。</p>';

    $('bk-copy').onclick = function () {
      var ta = out.querySelector('textarea'); ta.select();
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value);
      $('bk-copy').textContent = '已複製';
    };
  }

  /* ============ 組裝 ============ */
  var bound = false;
  function render(state) {
    if (state) ctx = state;
    if (!$('collect')) return;
    if (!bound) {
      bound = true;
      renderCollect();
      $('mk-json-input').addEventListener('change', function () {
        var f = this.files[0]; if (!f) return;
        this.value = '';
        var fr = new FileReader();
        fr.onload = function (e) {
          var data;
          try { data = JSON.parse(e.target.result); } catch (err) { alert('這不是有效的 JSON 檔。'); return; }
          ingest(Array.isArray(data) ? data : (data.items || data.results || []), '匯入');
        };
        fr.readAsText(f);
      });
      $('mk-tag').addEventListener('click', function () {
        if (!AI.getKey()) { alert('競品素材要看圖才標得準，需要先在「AI 標籤」分頁設定 Gemini API Key。'); return; }
        var btn = this; btn.disabled = true;
        tagMarket(status).then(function (r) {
          status('');
          if (!r.total) { alert('沒有需要標記的競品素材。'); return; }
          alert('完成 ' + r.done + ' 筆。' +
                (r.blocked ? '\n有 ' + r.blocked + ' 張圖讀不到（對方網站擋跨站讀取），已略過。' : '') +
                (r.total > 60 ? '\n一次最多處理 60 筆，剩下的再按一次。' : ''));
        }).catch(function (e) { status(''); alert('標記失敗：' + e.message); })
          .then(function () { btn.disabled = false; });
      });
    }
    var n = (ctx.market || []).length;
    var tagged = (ctx.market || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; }).length;
    if ($('mk-summary')) {
      $('mk-summary').textContent = n ? n + ' 個競品素材，其中 ' + tagged + ' 個已標籤。' : '還沒有競品素材。';
    }
    renderSurvival();
    renderDistCompare();
  }

  global.Market = { render: render };
})(window);
