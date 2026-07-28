/* export.js — 歷史庫、圖片包 zip、週報圖卡 PNG、Google Sheet 讀取 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var GAS_KEY = 'mt2_gas_url';
  var ctx = { rows: [], byKey: {}, materials: [], market: [], dimensions: [] };
  var snapshots = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function status(id, msg) { if ($(id)) $(id).textContent = msg || ''; }

  /* ============ 歷史庫 ============ */
  // 存的是「當時算出來的結論」，不是原始資料——原始資料已經在資料庫裡，
  // 再存一份只會佔空間。要回頭比較的是數字和排名。
  function snapshotPayload() {
    var m = Data.metrics(ctx.rows);
    var dates = ctx.rows.map(function (d) { return d.stat_date; }).sort();
    return {
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
      materials: Object.keys(ctx.rows.reduce(function (a, d) { a[d.material_key] = 1; return a; }, {})).length,
      metrics: { spend: m.spend, impressions: m.impressions, clicks: m.clicks, ctr: m.ctr, cpc: m.cpc, cpa: m.cpa },
      byAngle: Data.groupBy(ctx.rows, ctx.byKey, 'angle').slice(0, 8).map(pick),
      bySp: Data.groupBy(ctx.rows, ctx.byKey, 'selling_point').slice(0, 8).map(pick)
    };
    function pick(g) { return { key: g.key, spend: g.spend, ctr: g.ctr, cpa: g.cpa, count: g.count }; }
  }

  function saveSnapshot() {
    if (!ctx.rows.length) { alert('目前的篩選條件沒有資料，沒有東西可以存。'); return; }
    var p = snapshotPayload();
    var label = prompt('這次分析要叫什麼名字？', (p.from || '') + ' ~ ' + (p.to || ''));
    if (label == null) return;
    status('hist-status', '儲存中…');
    Cloud.saveSnapshot({
      kind: 'analysis', title: label.trim() || (p.from + ' ~ ' + p.to),
      payload: p, date_from: p.from, date_to: p.to
    }).then(function () { return loadSnapshots(); }).then(function () { status('hist-status', '已存入歷史庫。'); })
      .catch(function (e) { status('hist-status', '儲存失敗：' + e.message); });
  }

  function loadSnapshots() {
    return Cloud.sb.from('snapshots').select('*').is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(50)
      .then(function (r) {
        snapshots = r.error ? [] : (r.data || []);
        renderHistory();
      });
  }

  function renderHistory() {
    var box = $('history'); if (!box) return;
    if (!snapshots.length) {
      box.innerHTML = '<div class="empty">還沒有歷史紀錄。分析完一檔活動後按「存入歷史庫」，' +
        '之後就能回頭比較。</div>';
      return;
    }
    box.innerHTML = snapshots.map(function (s, i) {
      var p = s.payload || {}, m = p.metrics || {};
      return '<div class="hist"><div class="hist-head">' +
        '<div><b>' + esc(s.title) + '</b><div class="muted">' +
        esc(String(s.created_at).slice(0, 10)) + '　·　' + (p.materials || 0) + ' 個素材　·　CTR ' +
        (m.ctr != null ? (m.ctr * 100).toFixed(2) + '%' : '—') + '　·　CPA ' +
        (m.cpa != null ? '$' + m.cpa.toFixed(1) : '—') + '</div></div>' +
        '<div><button class="link hist-open" data-i="' + i + '">展開</button>' +
        '<button class="link hist-del" data-id="' + esc(s.id) + '" data-t="' + esc(s.title) + '">刪除</button></div>' +
        '</div><div class="hist-body" hidden></div></div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.hist-open'), function (b) {
      b.onclick = function () {
        var body = b.closest('.hist').querySelector('.hist-body');
        if (!body.hidden) { body.hidden = true; body.style.display = 'none'; b.textContent = '展開'; return; }
        var p = snapshots[+b.getAttribute('data-i')].payload || {};
        body.innerHTML = tbl('依素材切角', p.byAngle) + tbl('依賣點', p.bySp) + cmp(p);
        body.hidden = false; body.style.display = '';
        b.textContent = '收合';
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.hist-del'), function (b) {
      b.onclick = function () {
        if (!confirm('刪除歷史紀錄「' + b.getAttribute('data-t') + '」？')) return;
        b.disabled = true;
        Cloud.softDelete('snapshots', b.getAttribute('data-id'))
          .then(loadSnapshots)
          .catch(function (e) { b.disabled = false; alert('刪除失敗：' + e.message); });
      };
    });

    function tbl(title, list) {
      if (!list || !list.length) return '';
      return '<h3 class="g-h">' + title + '</h3><table><thead><tr><th>項目</th><th class="num">花費</th>' +
        '<th class="num">CTR</th><th class="num">CPA</th></tr></thead><tbody>' +
        list.map(function (g) {
          return '<tr><td>' + esc(g.key) + '</td><td class="num">' + Data.fmt(g.spend, 'money') +
            '</td><td class="num">' + Data.fmt(g.ctr, 'pct') + '</td><td class="num">' +
            Data.fmt(g.cpa, 'money') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    // 拿當時的結論跟現在的篩選結果對照，這才是歷史庫的用處
    function cmp(p) {
      if (!ctx.rows.length || !p.metrics) return '';
      var now = Data.metrics(ctx.rows);
      function d(a, b, pct) {
        if (a == null || b == null) return '—';
        var diff = (b - a) / a * 100;
        return (diff >= 0 ? '+' : '') + diff.toFixed(0) + '%';
      }
      return '<h3 class="g-h">跟目前篩選範圍比較</h3><table><thead><tr><th>指標</th>' +
        '<th class="num">當時</th><th class="num">目前</th><th class="num">變化</th></tr></thead><tbody>' +
        [['CTR', p.metrics.ctr, now.ctr, 'pct'], ['CPA', p.metrics.cpa, now.cpa, 'money'],
         ['CPC', p.metrics.cpc, now.cpc, 'money']].map(function (r) {
          return '<tr><td>' + r[0] + '</td><td class="num">' + Data.fmt(r[1], r[3]) +
            '</td><td class="num">' + Data.fmt(r[2], r[3]) + '</td><td class="num">' + d(r[1], r[2]) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="caveat">兩邊的篩選條件不一定相同，比較前先確認期間與渠道是不是可比。</p>';
    }
  }

  /* ============ 圖片包 zip ============ */
  function downloadZip() {
    var who = $('zip-who').value;
    var list = who === 'market'
      ? (ctx.market || []).filter(function (m) { return m.image_url; })
          .map(function (m) { return { name: m.competitor + '_' + m.material_name, url: m.image_url }; })
      : (ctx.materials || []).filter(function (m) { return m.image_url; })
          .map(function (m) { return { name: m.material_name, url: m.image_url }; });

    if (!list.length) { alert('沒有帶圖片的素材。'); return; }

    var zip = new JSZip(), ok = 0, fail = 0;
    var chain = Promise.resolve();
    list.slice(0, 300).forEach(function (it, i) {
      chain = chain.then(function () {
        status('zip-status', '打包中：' + (i + 1) + ' / ' + Math.min(300, list.length));
        return fetch(it.url).then(function (r) {
          if (!r.ok) throw new Error('http');
          return r.blob();
        }).then(function (b) {
          var ext = (b.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          // 同名素材會互相覆蓋而且不會報錯，所以加序號
          var safe = it.name.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80);
          zip.file(String(i + 1).padStart(3, '0') + '_' + safe + '.' + ext, b);
          ok++;
        }).catch(function () { fail++; });
      });
    });

    chain.then(function () {
      if (!ok) { status('zip-status', ''); alert('一張圖都抓不到。競品素材的圖片在對方網站上，通常會擋跨站讀取。'); return; }
      status('zip-status', '產生檔案…');
      return zip.generateAsync({ type: 'blob' }).then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '素材圖片包_' + new Date().toISOString().slice(0, 10) + '.zip';
        a.click();
        status('zip-status', '完成 ' + ok + ' 張' + (fail ? '，' + fail + ' 張讀不到已略過' : '') + '。');
      });
    });
  }

  /* ============ 週報圖卡 PNG ============ */
  function buildCard() {
    var m = Data.metrics(ctx.rows);
    var dates = ctx.rows.map(function (d) { return d.stat_date; }).sort();
    var ang = Data.groupBy(ctx.rows, ctx.byKey, 'angle').slice(0, 5);
    var best = ang.slice().sort(function (a, b) { return (b.ctr || 0) - (a.ctr || 0); })[0];

    var el = document.createElement('div');
    el.className = 'card-shot';
    el.innerHTML =
      '<div class="cs-head"><div class="cs-title">素材成效週報</div>' +
      '<div class="cs-date">' + esc(dates[0] || '') + ' ~ ' + esc(dates[dates.length - 1] || '') + '</div></div>' +
      '<div class="cs-kpis">' +
        kpi('花費', Data.fmt(m.spend, 'money')) + kpi('曝光', Data.fmt(m.impressions)) +
        kpi('點擊', Data.fmt(m.clicks)) + kpi('CTR', Data.fmt(m.ctr, 'pct')) +
        kpi('CPC', Data.fmt(m.cpc, 'money')) + kpi('CPA', Data.fmt(m.cpa, 'money')) +
      '</div>' +
      '<div class="cs-sec">依素材切角</div>' +
      '<table class="cs-tbl"><tbody>' + ang.map(function (g) {
        return '<tr><td>' + esc(g.key) + '</td><td>' + Data.fmt(g.spend, 'money') + '</td><td>' +
          Data.fmt(g.ctr, 'pct') + '</td><td>' + Data.fmt(g.cpa, 'money') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (best ? '<div class="cs-note">CTR 最高：' + esc(best.key) + '（' + Data.fmt(best.ctr, 'pct') +
              '，' + best.count + ' 個素材）</div>' : '') +
      '<div class="cs-foot">CTR 與 CPA 皆為加權計算　·　' + new Date().toISOString().slice(0, 10) + '</div>';
    return el;

    function kpi(k, v) { return '<div class="cs-kpi"><div class="cs-k">' + k + '</div><div class="cs-v">' + v + '</div></div>'; }
  }

  function exportCard() {
    if (!ctx.rows.length) { alert('目前的篩選條件沒有資料。'); return; }
    if (typeof html2canvas === 'undefined') { alert('圖卡元件沒有載入，可能是網路被擋。'); return; }
    var el = buildCard();
    var host = $('card-preview');
    host.innerHTML = ''; host.appendChild(el);
    status('card-status', '產生圖片…');
    html2canvas(el, { backgroundColor: '#ffffff', scale: 2 }).then(function (canvas) {
      canvas.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '素材週報_' + new Date().toISOString().slice(0, 10) + '.png';
        a.click();
        status('card-status', '完成。圖卡也留在下方，可以直接截圖或再產生一次。');
      });
    }).catch(function (e) { status('card-status', '產生失敗：' + e.message); });
  }

  /* ============ Google Sheet 讀取 ============ */
  // 走 Apps Script Web App，因為 Google Sheet 沒辦法直接從網頁跨站讀取。
  function loadSheet() {
    var url = (localStorage.getItem(GAS_KEY) || '').trim();
    if (!url) { alert('請先填入 Apps Script 的網址。'); return; }
    status('gs-status', '讀取中…');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);

    fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'action=materialSheets', { signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '讀取失敗');
        if (!Array.isArray(j.data) || !j.data.length) throw new Error('回傳的資料是空的');
        var ws = XLSX.utils.aoa_to_sheet(j.data);
        var wb = { SheetNames: [j.activeSheet || 'Sheet1'], Sheets: {} };
        wb.Sheets[wb.SheetNames[0]] = ws;
        var parsed = Data.parseWorkbook(wb, new Date().toISOString().slice(0, 10), '');
        if (!parsed.rows.length) throw new Error('這張表裡找不到素材與成效欄位');
        status('gs-status', '解析到 ' + parsed.rows.length + ' 筆，寫入中…');
        if (global.__saveImport) return global.__saveImport(parsed);
        throw new Error('匯入流程沒有就緒');
      })
      .then(function (r) {
        status('gs-status', r && r.ok === false ? '寫入失敗，詳見上方訊息。' : '完成。');
      })
      .catch(function (e) {
        clearTimeout(timer);
        status('gs-status', '讀取失敗：' + (e.name === 'AbortError' ? '超過 30 秒沒有回應' : e.message));
      });
  }

  /* ============ 組裝 ============ */
  var bound = false;
  function render(state) {
    if (state) ctx = state;
    if (!$('history')) return;
    if (!bound) {
      bound = true;
      $('btn-snapshot').onclick = saveSnapshot;
      $('btn-zip').onclick = downloadZip;
      $('btn-card').onclick = exportCard;
      $('gs-url').value = localStorage.getItem(GAS_KEY) || '';
      $('gs-url').onchange = function () { localStorage.setItem(GAS_KEY, this.value.trim()); };
      $('btn-gs').onclick = loadSheet;
      loadSnapshots();
    } else {
      renderHistory();
    }
  }

  global.Exporter = { render: render, reloadSnapshots: loadSnapshots };
})(window);
