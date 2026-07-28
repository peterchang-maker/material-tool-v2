/* watch.js — 競品監控名單(存雲端、頁面編輯)與每日聲量檢視 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var targets = [], signals = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadAll() {
    var since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return Promise.all([
      Cloud.sb.from('watch_targets').select('*').is('deleted_at', null).order('created_at'),
      Cloud.sb.from('signals').select('*').gte('stat_date', since).order('stat_date', { ascending: false })
    ]).then(function (res) {
      if (res[0].error) throw res[0].error;
      targets = res[0].data || [];
      signals = res[1].error ? [] : (res[1].data || []);
      renderTargets(); renderSignals();
    }).catch(function (e) {
      var box = $('watch-list');
      if (box && /watch_targets/.test(e.message || '')) {
        box.innerHTML = '<div class="check warn">監控名單的資料表還沒建立。' +
          '請先到 Supabase 的 SQL Editor 執行 patch_02.sql。</div>';
      }
    });
  }

  /* ---------- 名單管理 ---------- */
  function renderTargets() {
    var box = $('watch-list'); if (!box) return;
    var html = targets.length
      ? '<table><thead><tr><th>啟用</th><th>競品</th><th>Google Play</th><th>App Store</th>' +
        '<th>巴哈關鍵字</th><th></th></tr></thead><tbody>' +
        targets.map(function (t) {
          return '<tr><td><input type="checkbox" class="wt-on" data-id="' + esc(t.id) + '"' +
            (t.enabled ? ' checked' : '') + '></td>' +
            '<td><b>' + esc(t.name) + '</b></td>' +
            '<td class="muted">' + esc(t.google_play_id || '—') + '</td>' +
            '<td class="muted">' + esc(t.appstore_id || '—') + '</td>' +
            '<td class="muted">' + esc(t.bahamut_kw || t.name) + '</td>' +
            '<td><button class="link wt-del" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">刪除</button></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">還沒有監控對象。用下面的欄位新增——存在雲端,爬蟲每天讀這份名單。</div>';

    html += '<div class="dim-add" style="margin-top:12px">' +
      '<input id="wt-name" placeholder="競品名,例如 天堂W" style="min-width:130px">' +
      '<input id="wt-gp" placeholder="Google Play ID,例如 com.ncsoft.lineagew">' +
      '<input id="wt-as" placeholder="App Store 數字 ID">' +
      '<input id="wt-ba" placeholder="巴哈關鍵字(留空用競品名)">' +
      '<button class="ghost" id="wt-add">新增</button></div>' +
      '<p class="caveat">Google Play ID 在商店網址的 id= 後面;App Store ID 在網址的 id 後面那串數字。' +
      '兩個都留空的話,那個競品只會抓巴哈聲量。</p>';

    box.innerHTML = html;

    $('wt-add').onclick = function () {
      var name = $('wt-name').value.trim();
      if (!name) { alert('競品名要填。'); return; }
      this.disabled = true;
      Cloud.sb.from('watch_targets').upsert([{
        name: name,
        google_play_id: $('wt-gp').value.trim() || null,
        appstore_id: $('wt-as').value.trim() || null,
        bahamut_kw: $('wt-ba').value.trim() || null,
        enabled: true, deleted_at: null
      }], { onConflict: 'name' }).then(function (r) {
        if (r.error) throw r.error;
        return loadAll();
      }).catch(function (e) { alert('新增失敗:' + e.message); })
        .then(function () { var b = $('wt-add'); if (b) b.disabled = false; });
    };

    Array.prototype.forEach.call(box.querySelectorAll('.wt-on'), function (cb) {
      cb.onchange = function () {
        Cloud.sb.from('watch_targets').update({ enabled: cb.checked }).eq('id', cb.getAttribute('data-id'))
          .then(function (r) { if (r.error) { alert('更新失敗:' + r.error.message); cb.checked = !cb.checked; } });
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.wt-del'), function (b) {
      b.onclick = function () {
        if (!confirm('移除「' + b.getAttribute('data-name') + '」?已抓到的聲量資料會留著。')) return;
        Cloud.softDelete('watch_targets', b.getAttribute('data-id')).then(loadAll)
          .catch(function (e) { alert('刪除失敗:' + e.message); });
      };
    });
  }

  /* ---------- 聲量檢視 ---------- */
  var SRC_NAME = { googleplay: 'Google Play', appstore: 'App Store', bahamut: '巴哈姆特' };

  function renderSignals() {
    var box = $('watch-signals'); if (!box) return;
    if (!signals.length) {
      box.innerHTML = '<div class="empty">還沒有聲量資料。GitHub Actions 排程跑過第一輪之後,' +
        '每天早上這裡會自動更新。也可以到 repo 的 Actions 頁面手動觸發一次。</div>';
      return;
    }
    var latest = signals[0].stat_date;
    var byComp = {};
    signals.filter(function (s) { return s.stat_date === latest; })
      .forEach(function (s) { (byComp[s.competitor] = byComp[s.competitor] || {})[s.source] = s; });

    var html = '<div class="xmeta">最新資料:' + esc(latest) + '(每天早上自動更新,保留 30 天)</div>' +
      '<div class="xgrid">';
    Object.keys(byComp).forEach(function (comp) {
      var g = byComp[comp];
      html += '<div class="xcard"><div class="xdim">' + esc(comp) + '</div>';
      ['googleplay', 'appstore', 'bahamut'].forEach(function (src) {
        var s = g[src]; if (!s) return;
        var m = s.metrics || {};
        var line = src === 'googleplay'
          ? (m.rating != null ? '評分 ' + m.rating : '評分讀取失敗') + (m.review_count_text ? '｜' + m.review_count_text + ' 則' : '')
          : src === 'appstore'
          ? (m.recent_avg_rating != null ? '近期均分 ' + m.recent_avg_rating : '無資料') +
            (m.one_star_share != null ? '｜一星占比 ' + Math.round(m.one_star_share * 100) + '%' : '')
          : '搜尋結果 ' + (m.result_titles != null ? m.result_titles + ' 筆' : '—');
        html += '<div class="sig-row"><span class="sig-src">' + SRC_NAME[src] + '</span>' +
                '<span>' + esc(line) + '</span></div>';
        (s.samples || []).slice(0, 2).forEach(function (t) {
          html += '<div class="sig-sample">' + esc(t) + '</div>';
        });
      });
      html += '</div>';
    });
    box.innerHTML = html + '</div>' +
      '<p class="caveat">評分與評論來自商店頁面的公開資訊;巴哈的數字是搜尋結果數,只能看相對趨勢不能當絕對量。' +
      '來源改版時對應欄位會變成「讀取失敗」——那是來源的問題,跟我說我來修對應的解析。</p>';
  }

  function render() { if ($('watch-list')) loadAll(); }
  global.Watch = { render: render };
})(window);
