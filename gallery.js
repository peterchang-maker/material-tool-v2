/* gallery.js — 素材牆：瀏覽、高低比較、標籤檢查 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MIN_IMP = 1000;   // 曝光太少的素材不進比較，避免用雜訊下結論

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function card(r, opts) {
    opts = opts || {};
    var img = r.image_url
      ? '<img src="' + esc(r.image_url) + '" alt="' + esc(r.name) + '" loading="lazy">'
      : '<div class="noimg">沒有圖片</div>';

    var stats = '<div class="g-stats">' +
      '<span>CTR <b>' + Data.fmt(r.ctr, 'pct') + '</b></span>' +
      '<span>CPA <b>' + Data.fmt(r.cpa, 'money') + '</b></span>' +
      '<span>' + Data.fmt(r.impressions) + ' 曝光</span></div>';

    var tags = '';
    if (opts.showTags) {
      var t = r.tags || {};
      var keys = Object.keys(t);
      tags = keys.length
        ? '<div class="g-tags">' + keys.slice(0, 18).map(function (k) {
            return '<span class="ai-val">' + esc(k) + '：' + esc(t[k]) + '</span>';
          }).join('') + '</div>' +
          '<button class="link g-retag" data-key="' + esc(r.key) + '">這筆標錯了，重打</button>'
        : '<div class="muted" style="padding:8px 0">還沒有 AI 標籤</div>';
    }

    return '<figure class="g-card' + (opts.rank ? ' rank-' + opts.rank : '') + '">' +
      '<div class="g-img">' + img + '</div>' +
      '<figcaption><div class="g-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
      stats + tags + '</figcaption></figure>';
  }

  function buildRows(state) {
    var agg = {};
    state.rows.forEach(function (d) { (agg[d.material_key] = agg[d.material_key] || []).push(d); });
    return Object.keys(agg).map(function (k) {
      var m = Data.metrics(agg[k]);
      var mat = state.byKey[k] || {};
      m.key = k;
      m.name = mat.material_name || k;
      m.image_url = mat.image_url || '';
      m.tags = mat.tags || {};
      m.tagged = (mat.tag_version || 0) >= AI.TAG_VERSION;
      return m;
    });
  }

  function render(state) {
    var box = $('gallery');
    if (!box) return;
    var mode = $('g-mode') ? $('g-mode').value : 'browse';
    var onlyImg = $('g-onlyimg') ? $('g-onlyimg').checked : false;

    var rows = buildRows(state);
    if (onlyImg) rows = rows.filter(function (r) { return r.image_url; });

    if (!rows.length) {
      box.innerHTML = '<div class="empty">目前的篩選條件沒有素材。<br>' +
        '如果是圖片還沒進來，按上面的「從 Excel 抽圖」。</div>';
      return;
    }

    var withImg = rows.filter(function (r) { return r.image_url; }).length;
    var note = withImg < rows.length
      ? '<div class="muted" style="margin-bottom:10px">' + rows.length + ' 個素材中有 ' +
        withImg + ' 個有圖片。沒有圖的通常是那份 Excel 裡沒有內嵌它。</div>' : '';

    if (mode === 'compare') {
      var pool = rows.filter(function (r) { return r.impressions >= MIN_IMP && r.ctr != null; })
                     .sort(function (a, b) { return b.ctr - a.ctr; });
      if (pool.length < 4) {
        box.innerHTML = note + '<div class="empty">可比較的素材太少（需要曝光滿 ' +
          MIN_IMP.toLocaleString() + ' 的素材至少 4 個）。</div>';
        return;
      }
      var n = Math.min(6, Math.floor(pool.length / 2));
      var top = pool.slice(0, n), low = pool.slice(-n).reverse();
      box.innerHTML = note +
        '<div class="g-split"><div><h3 class="g-h">CTR 最高 ' + n + ' 個</h3><div class="g-grid">' +
        top.map(function (r) { return card(r, { rank: 'top' }); }).join('') +
        '</div></div><div><h3 class="g-h">CTR 最低 ' + n + ' 個</h3><div class="g-grid">' +
        low.map(function (r) { return card(r, { rank: 'low' }); }).join('') +
        '</div></div></div>';
      return;
    }

    if (mode === 'tags') {
      var tagged = rows.filter(function (r) { return r.tagged; });
      var list = tagged.length ? tagged : rows;
      box.innerHTML = note + '<div class="g-grid wide">' +
        list.slice(0, 60).map(function (r) { return card(r, { showTags: true }); }).join('') + '</div>';
      bindRetag(state);
      return;
    }

    rows.sort(function (a, b) { return b.spend - a.spend; });
    box.innerHTML = note + '<div class="g-grid">' +
      rows.slice(0, 120).map(function (r) { return card(r, {}); }).join('') + '</div>';
  }

  // 標籤打錯時把它退回未標記，下次補標會重打這一筆
  function bindRetag(state) {
    Array.prototype.forEach.call(document.querySelectorAll('.g-retag'), function (btn) {
      btn.onclick = function () {
        var key = btn.getAttribute('data-key');
        var mat = state.byKey[key];
        if (!mat) return;
        if (!confirm('把「' + mat.material_name + '」退回未標記？\n下次按「補打 AI 標籤」時會重新標這一筆。')) return;
        btn.disabled = true; btn.textContent = '處理中…';
        Cloud.saveMaterials([{
          material_key: key, material_name: mat.material_name,
          tags: {}, tag_version: 0, tagged_at: null
        }]).then(function () {
          btn.textContent = '已退回，重新整理後生效';
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = '失敗：' + e.message;
        });
      };
    });
  }

  global.Gallery = { render: render };
})(window);
