/* dims.js — 維度分析：命名檢查、特徵×成效、共通性排行、自訂維度管理 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var THR_KEY = 'mt2_impr_threshold';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function threshold() {
    var v = parseInt(($('impr-thr') && $('impr-thr').value) || localStorage.getItem(THR_KEY), 10);
    return isNaN(v) || v < 0 ? 3000 : v;
  }

  /* ============ 1. 命名規則檢查 ============ */
  // 段數超過五代表某一段裡多打了底線。前五段都有值、看起來完整，
  // 但賣點與走期已經錯位，畫面不會有任何異狀——所以要單獨標出來。
  function parseName(raw) {
    var name = String(raw || '').split('\n')[0];
    var parts = name.split('_');
    var seg = function (i) { return parts[i] ? parts[i].trim() : null; };
    var has5 = parts.length >= 5 && [0, 1, 2, 3, 4].every(function (i) { return seg(i); });
    var shifted = parts.length > 5;
    var p5 = seg(4);
    var badPeriod = !!p5 && !/\d/.test(p5);
    return {
      格式: seg(0), 視覺類型: seg(1), 素材切角: seg(2), 賣點: seg(3), 走期: p5,
      完整: has5 && !shifted && !badPeriod,
      段數: parts.length, 段數異常: shifted, 走期可疑: badPeriod, 素材名稱: name
    };
  }

  function renderNameCheck(state) {
    var box = $('name-check'); if (!box) return;
    var mats = state.materials || [];
    if (!mats.length) { box.innerHTML = ''; return; }

    var parsed = mats.map(function (m) { return parseName(m.material_name); });
    var bad = parsed.filter(function (p) { return !p.完整; });
    var rate = Math.round((parsed.length - bad.length) / parsed.length * 100);

    if (!bad.length) {
      box.innerHTML = '<div class="check ok">命名檢查通過：' + parsed.length +
        ' 筆素材全部符合「格式_視覺類型_切角_賣點_走期」五段式命名。</div>';
      return;
    }

    var shifted = bad.filter(function (p) { return p.段數異常 || p.走期可疑; });
    var missing = bad.filter(function (p) { return !(p.段數異常 || p.走期可疑); });
    var segNames = ['格式', '視覺類型', '素材切角', '賣點', '走期'];
    var html = '';

    if (shifted.length) {
      html += '<div class="check err"><b>命名錯位：' + shifted.length + ' 筆</b><br>' +
        '名稱被拆成超過五段，或走期段裡沒有數字。這代表某一段多打了底線' +
        '（例：<code>技能_覺醒</code> 應為 <code>技能覺醒</code>）。' +
        '<b>賣點與走期已經錯位</b>——分析照跑，但這幾筆的分類是錯的。<ul>' +
        shifted.slice(0, 10).map(function (p) {
          return '<li>' + esc(p.素材名稱) + ' — 拆成 ' + p.段數 + ' 段｜賣點讀成「' +
                 esc(p.賣點 || '') + '」、走期讀成「' + esc(p.走期 || '') + '」</li>';
        }).join('') +
        (shifted.length > 10 ? '<li>…另有 ' + (shifted.length - 10) + ' 筆</li>' : '') + '</ul></div>';
    }
    if (missing.length) {
      html += '<div class="check warn"><b>命名不完整：' + missing.length + ' 筆</b>（整體合格率 ' + rate + '%）<br>' +
        '缺漏的段會讓該素材在切角／賣點分析中被歸入「未分類」。<ul>' +
        missing.slice(0, 12).map(function (p) {
          var miss = segNames.filter(function (k) { return !p[k]; }).join('、');
          return '<li>' + esc(p.素材名稱) + ' — 缺少：' + (miss || '段數不足') + '</li>';
        }).join('') +
        (missing.length > 12 ? '<li>…另有 ' + (missing.length - 12) + ' 筆</li>' : '') + '</ul></div>';
    }
    box.innerHTML = html;
  }

  /* ============ 2. 特徵 × 實際成效 ============ */
  function renderFeatureCross(state) {
    var box = $('feature-cross'); if (!box) return;

    var agg = {};
    (state.rows || []).forEach(function (d) {
      var a = agg[d.material_key] = agg[d.material_key] || { impressions: 0, clicks: 0 };
      a.impressions += d.impressions || 0; a.clicks += d.clicks || 0;
    });

    var records = [];
    Object.keys(agg).forEach(function (k) {
      var m = state.byKey[k];
      if (!m || !m.tags || !Object.keys(m.tags).length) return;
      records.push({ tags: m.tags, impressions: agg[k].impressions, clicks: agg[k].clicks });
    });

    if (records.length < 2) {
      box.innerHTML = '<div class="empty">需要至少 2 個已標籤且有成效資料的素材。' +
        '目前 ' + records.length + ' 個。先到「大盤總覽」按補打 AI 標籤。</div>';
      return;
    }

    var totImp = records.reduce(function (s, r) { return s + r.impressions; }, 0);
    var totClk = records.reduce(function (s, r) { return s + r.clicks; }, 0);
    var overall = totImp ? totClk / totImp : 0;
    var thr = threshold();

    var dimData = [], impact = [];
    Dims.allDims(state).forEach(function (dim) {
      var g = {};
      records.forEach(function (r) {
        var v = r.tags[dim];
        if (v == null || v === '') return;
        v = String(v);
        var uncertain = v.indexOf('不確定') >= 0;
        var key = v.replace(/\s*[（(]不確定[)）]\s*/g, '').trim() || v;
        g[key] = g[key] || { click: 0, impr: 0, n: 0, uncertain: 0 };
        g[key].click += r.clicks; g[key].impr += r.impressions; g[key].n++;
        if (uncertain) g[key].uncertain++;
      });
      var vals = Object.keys(g).map(function (k) {
        var v = g[k];
        return { key: k, n: v.n, impr: v.impr, uncertain: v.uncertain, ctr: v.impr ? v.click / v.impr : null };
      }).filter(function (v) { return v.ctr != null; }).sort(function (a, b) { return b.ctr - a.ctr; });
      if (vals.length < 2) return;
      dimData.push({ dim: dim, vals: vals });
      vals.forEach(function (v) {
        var lift = overall > 0 ? (v.ctr - overall) / overall * 100 : 0;
        if (v.n >= 2 && v.impr >= thr) impact.push({ label: dim + '·' + v.key, lift: lift });
      });
    });

    if (!dimData.length) {
      box.innerHTML = '<div class="empty">已標籤素材的特徵值都相同，沒有可交叉比較的維度。</div>';
      return;
    }

    impact.sort(function (a, b) { return Math.abs(b.lift) - Math.abs(a.lift); });
    var top = impact.slice(0, 10).sort(function (a, b) { return b.lift - a.lift; });
    var maxAbs = Math.max.apply(null, top.map(function (t) { return Math.abs(t.lift); }).concat([1]));

    var html = '<div class="xmeta">整體 CTR ' + (overall * 100).toFixed(2) + '%　·　' +
      records.length + ' 個素材　·　曝光門檻 ' + thr.toLocaleString() + '</div>';

    html += '<h3 class="g-h">影響力排行（相對整體 CTR 的增減）</h3><div class="impact">' +
      top.map(function (t) {
        var w = Math.max(3, Math.round(Math.abs(t.lift) / maxAbs * 100));
        var pos = t.lift >= 0;
        return '<div class="imp-row"><span class="imp-label" title="' + esc(t.label) + '">' + esc(t.label) + '</span>' +
          '<span class="imp-bar-wrap"><span class="imp-bar ' + (pos ? 'pos' : 'neg') +
          '" style="width:' + w + '%"></span></span>' +
          '<span class="imp-val ' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '') + t.lift.toFixed(0) + '%</span></div>';
      }).join('') + '</div>';

    html += '<div class="xgrid">' + dimData.map(function (d) {
      var maxCtr = Math.max.apply(null, d.vals.map(function (v) { return v.ctr; }).concat([1e-9]));
      return '<div class="xcard"><div class="xdim">' + esc(d.dim) + '</div>' +
        d.vals.map(function (v) {
          var lift = overall > 0 ? (v.ctr - overall) / overall * 100 : 0;
          var cls = lift >= 10 ? 'pos' : lift <= -10 ? 'neg' : 'mid';
          var w = Math.max(6, Math.round(v.ctr / maxCtr * 100));
          var badges = (v.impr < thr ? '<span class="badge">樣本不足</span>' : '') +
                       (v.uncertain ? '<span class="badge">含' + v.uncertain + '筆不確定</span>' : '');
          return '<div class="xrow"><div class="xlabel" title="' + esc(v.key) + '">' + esc(v.key) + badges + '</div>' +
            '<div class="xbar-wrap"><div class="xbar ' + cls + '" style="width:' + w + '%"></div></div>' +
            '<div class="xval">' + (v.ctr * 100).toFixed(2) + '%<span class="xn">' + v.n + '個</span></div></div>';
        }).join('') + '</div>';
    }).join('') + '</div>';

    html += '<p class="caveat">讀法：綠色代表這個特徵值的加權 CTR 高出整體一成以上，紅色代表低一成以上。' +
      '標「樣本不足」的曝光沒到門檻，數字容易是雜訊，不要據以下結論。' +
      'CTR 是加權算的（總點擊÷總曝光），不是各素材 CTR 的平均。</p>';

    box.innerHTML = html;
  }

  /* ============ 3. 維度共通性排行（市場共識） ============ */
  function survivalDays(m) {
    if (m.survival_days != null) return Math.max(1, m.survival_days);
    if (m.first_seen_on && m.last_seen_on) {
      return Math.max(1, Math.round((new Date(m.last_seen_on) - new Date(m.first_seen_on)) / 86400000) + 1);
    }
    return 1;
  }

  function distShare(records, dims) {
    var out = {};
    dims.forEach(function (dim) {
      var g = {}, tot = 0;
      records.forEach(function (r) {
        var v = r.tags[dim];
        if (v == null || v === '') return;
        v = String(v).replace(/\s*[（(]不確定[)）]\s*/g, '').trim();
        if (!v) return;
        g[v] = (g[v] || 0) + r.w; tot += r.w;
      });
      if (tot > 0) { out[dim] = {}; Object.keys(g).forEach(function (k) { out[dim][k] = g[k] / tot * 100; }); }
    });
    return out;
  }

  function renderCommonality(state) {
    var box = $('commonality'); if (!box) return;
    var pool = (state.market || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });

    if (pool.length < 5) {
      box.innerHTML = '<div class="empty">需要至少 5 支已標籤的競品素材，目前 ' + pool.length +
        ' 支。先到「資料與備份」匯入競品素材並標籤。</div>';
      return;
    }

    var dims = Dims.allDims(state, true);
    var marketOnly = {};
    (state.dimensions || []).filter(function (d) { return d.layer === 3; })
      .forEach(function (d) { marketOnly[d.name] = 1; });

    var dist = distShare(pool.map(function (m) { return { tags: m.tags, w: survivalDays(m) }; }), dims);

    var ourTagged = (state.materials || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });
    var dOwn = ourTagged.length >= 3
      ? distShare(ourTagged.map(function (m) { return { tags: m.tags, w: 1 }; }), dims) : null;

    var rows = [];
    dims.forEach(function (dim) {
      var m = dist[dim]; if (!m) return;
      Object.keys(m).forEach(function (k) {
        // 「95% 都無」不是共識，是這個題目不適用
        if (/^(無|沒有|不確定|其他)$/.test(k) && m[k] >= 95) return;
        rows.push({ dim: dim, key: k, pct: m[k], isMk: !!marketOnly[dim],
                    own: dOwn && dOwn[dim] ? (dOwn[dim][k] || 0) : null });
      });
    });
    rows.sort(function (a, b) { return b.pct - a.pct; });
    var top = rows.slice(0, 15);
    if (!top.length) { box.innerHTML = '<div class="empty">沒有可排序的特徵。</div>'; return; }

    box.innerHTML = '<div class="xmeta">樣本 ' + pool.length + ' 支競品素材　·　存活天數加權　·　' +
      (dOwn ? '右欄是我方占比，落差 30 個百分點以上標紅' : '我方素材尚未標籤，沒有對照欄') + '</div>' +
      '<div class="cn">' + top.map(function (r, i) {
        var gap = r.own != null && Math.abs(r.pct - r.own) >= 30;
        return '<div class="cn-row' + (i < 3 ? ' top3' : '') + '">' +
          '<span class="cn-rank">' + (i + 1) + '</span>' +
          '<span class="cn-dim">' + esc(r.dim) + '</span>' +
          '<span class="cn-key">' + esc(r.key) + (r.isMk ? '<span class="badge">市場專屬</span>' : '') + '</span>' +
          '<span class="cn-bar-wrap"><span class="cn-bar" style="width:' + Math.max(2, r.pct).toFixed(0) + '%"></span></span>' +
          '<span class="cn-pct' + (r.pct >= 70 ? ' strong' : '') + '">' + r.pct.toFixed(0) + '%</span>' +
          '<span class="cn-own' + (gap ? ' gap' : '') + '">' + (r.own != null ? '我方 ' + r.own.toFixed(0) + '%' : '') + '</span>' +
          '</div>';
      }).join('') + '</div>' +
      '<p class="caveat">讀法：占比 70% 以上是市場共識——跟不跟是策略選擇，但偏離它應該是自覺的決定。' +
      '右欄標紅代表我方跟市場差超過 30 個百分點，不一定是問題，但值得知道。' +
      '市場專屬維度我方沒有資料，不顯示對照。</p>';
  }

  /* ============ 4. 自訂三層維度 ============ */
  var LAYER_NAME = { 1: '共用（我方與競品都標）', 2: '我方自訂', 3: '市場專屬' };

  function allDims(state, includeMarket) {
    var base = AI.ALL_DIMS.slice();
    (state.dimensions || []).forEach(function (d) {
      if (d.layer === 1 || d.layer === 2) { if (base.indexOf(d.name) < 0) base.push(d.name); }
      if (includeMarket && d.layer === 3 && base.indexOf(d.name) < 0) base.push(d.name);
    });
    return base;
  }

  function renderCustomDims(state) {
    var box = $('custom-dims'); if (!box) return;
    var list = (state.dimensions || []).slice().sort(function (a, b) {
      return (a.layer - b.layer) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name);
    });

    var html = '<div class="dim-add">' +
      '<select id="nd-layer"><option value="1">共用</option><option value="2" selected>我方自訂</option>' +
      '<option value="3">市場專屬</option></select>' +
      '<input id="nd-name" placeholder="維度名稱，例如 角色數量">' +
      '<input id="nd-def" placeholder="判斷說明／可選值，例如 單人／雙人／多人">' +
      '<button class="ghost" id="nd-add">新增</button></div>';

    html += '<div class="xmeta">內建 ' + AI.ALL_DIMS.length + ' 維不列在這裡，只顯示你加的。' +
      '新增維度後，已標記的素材會被判定為需要補標。</div>';

    if (!list.length) {
      html += '<div class="empty">還沒有自訂維度。內建的 ' + AI.ALL_DIMS.length + ' 維已經在用了。</div>';
    } else {
      html += '<table><thead><tr><th>層級</th><th>維度</th><th>說明</th><th></th></tr></thead><tbody>' +
        list.map(function (d) {
          return '<tr><td>' + esc(LAYER_NAME[d.layer] || d.layer) + '</td>' +
            '<td>' + esc(d.name) + '</td><td>' + esc(d.definition || '') + '</td>' +
            '<td><button class="link dim-del" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">刪除</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    box.innerHTML = html;

    $('nd-add').onclick = function () {
      var name = ($('nd-name').value || '').trim();
      if (!name) { alert('請填維度名稱。'); return; }
      if (AI.ALL_DIMS.indexOf(name) >= 0) { alert('「' + name + '」已經是內建維度了。'); return; }
      var row = {
        layer: parseInt($('nd-layer').value, 10),
        name: name,
        definition: ($('nd-def').value || '').trim(),
        examples: [], sort_order: list.length,
        deleted_at: null
      };
      $('nd-add').disabled = true;
      Cloud.saveDimensions([row]).then(function () {
        if (global.__reload) global.__reload();
      }).catch(function (e) {
        $('nd-add').disabled = false; alert('新增失敗：' + e.message);
      });
    };

    Array.prototype.forEach.call(box.querySelectorAll('.dim-del'), function (btn) {
      btn.onclick = function () {
        if (!confirm('刪除維度「' + btn.getAttribute('data-name') + '」？\n已經標好的資料不會被清掉，只是之後不再標這一維。')) return;
        btn.disabled = true;
        Cloud.sb.from('dimensions').update({ deleted_at: new Date().toISOString() })
          .eq('id', btn.getAttribute('data-id'))
          .then(function () { if (global.__reload) global.__reload(); });
      };
    });
  }

  function render(state) {
    renderNameCheck(state);
    renderFeatureCross(state);
    renderCommonality(state);
    renderCustomDims(state);
  }

  global.Dims = { render: render, allDims: allDims, parseName: parseName, threshold: threshold };
})(window);
