/* aiops.js — AI 分頁：用量成本、提議維度、解讀差異、週報文字、手動 Prompt 流程 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ctx = { rows: [], byKey: {}, materials: [], market: [], dimensions: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tok(v) {
    return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);
  }

  /* ============ 用量與成本 ============ */
  function renderUsage() {
    var el = $('api-usage'); if (!el) return;
    var all = AI.readUsage();
    var months = Object.keys(all).sort().reverse();
    var cur = all[AI.monthKey()];

    var line = cur && cur.calls
      ? '本月 ' + cur.calls + ' 次呼叫｜輸入 ' + tok(cur.inTok) + '／輸出 ' + tok(cur.outTok) +
        ' tokens｜估算成本 <b>US$' + fmtCost(AI.usageCost(cur)) + '</b>'
      : '本月還沒有呼叫過。';

    var hist = months.length > 1
      ? '<table style="margin-top:12px"><thead><tr><th>月份</th><th class="num">呼叫</th>' +
        '<th class="num">輸入</th><th class="num">輸出</th><th class="num">估算成本</th></tr></thead><tbody>' +
        months.map(function (k) {
          var m = all[k];
          return '<tr><td>' + esc(k) + '</td><td class="num">' + m.calls + '</td><td class="num">' +
            tok(m.inTok) + '</td><td class="num">' + tok(m.outTok) + '</td><td class="num">US$' +
            fmtCost(AI.usageCost(m)) + '</td></tr>';
        }).join('') + '</tbody></table>' : '';

    el.innerHTML = '<div class="xmeta">' + line + '</div>' + hist +
      '<p class="caveat">這是依 ' + esc(AI.getModel()) + ' 的公開牌價估算，不是帳單。' +
      '免費額度內實際為 $0，真實花費以 Google Cloud 帳單為準。用量只記在這台電腦，換裝置會從零開始。</p>';
  }
  function fmtCost(c) { return c > 0 && c < 0.01 ? c.toFixed(4) : c.toFixed(2); }

  /* ============ 金鑰與型號 ============ */
  var keyBarState = null;
  function renderKeyBar() {
    var el = $('api-key-bar'); if (!el) return;
    var on = !!AI.getKey();
    if (keyBarState === on && el.innerHTML) return;
    keyBarState = on;
    el.innerHTML =
      '<span class="apibadge ' + (on ? 'on' : 'off') + '">' + (on ? '金鑰已設定' : '尚未設定金鑰') + '</span>' +
      '<input id="ai-model" value="' + esc(AI.getModel()) + '" style="width:180px" title="Gemini 型號">' +
      '<button class="ghost" id="ai-setkey">' + (on ? '更換金鑰' : '設定金鑰') + '</button>' +
      (on ? '<button class="link" id="ai-clearkey">移除金鑰</button>' : '');

    $('ai-model').onchange = function () { AI.setModel(this.value); renderUsage(); };
    $('ai-setkey').onclick = function () {
      var k = prompt('貼上 Gemini API Key（只存在這台電腦，不會上傳雲端）', '');
      if (k == null) return;
      AI.setKey(k.trim()); render(ctx);
    };
    if ($('ai-clearkey')) $('ai-clearkey').onclick = function () {
      if (confirm('移除這台電腦上的金鑰？')) { AI.setKey(''); render(ctx); }
    };
  }

  /* ============ 共用：跑一段 AI 或給手動流程 ============ */
  function runOrManual(outId, prompt, onText) {
    var out = $(outId);
    if (!AI.getKey()) {
      out.innerHTML = manualBlock(outId, prompt);
      bindManual(outId, onText);
      return;
    }
    out.innerHTML = '<div class="muted">AI 產生中，通常十幾秒…</div>';
    AI.callGemini(prompt).then(function (text) {
      onText(text, out);
    }).catch(function (e) {
      out.innerHTML = '<div class="check err">呼叫失敗：' + esc(e.message) + '</div>' + manualBlock(outId, prompt);
      bindManual(outId, onText);
    });
  }

  // 沒有金鑰時不隱藏功能，改成手動流程：複製 Prompt → 去 Gemini 貼 → 把結果貼回來
  function manualBlock(id, prompt) {
    return '<div class="manual">' +
      '<div class="xmeta">沒有 API Key 也能用，只是要手動走三步：</div>' +
      '<textarea class="mp-prompt" readonly rows="6">' + esc(prompt) + '</textarea>' +
      '<div class="manual-actions">' +
      '<button class="ghost mp-copy">1. 複製 Prompt</button>' +
      '<a class="ghost btnlink" href="https://gemini.google.com/" target="_blank" rel="noopener">2. 在 Gemini 開啟</a>' +
      '</div>' +
      '<textarea class="mp-paste" rows="5" placeholder="3. 把 Gemini 的回覆整段貼回這裡"></textarea>' +
      '<button class="ghost mp-apply">套用結果</button>' +
      '</div>';
  }

  function bindManual(outId, onText) {
    var out = $(outId);
    var copy = out.querySelector('.mp-copy');
    if (copy) copy.onclick = function () {
      var ta = out.querySelector('.mp-prompt');
      ta.select();
      navigator.clipboard ? navigator.clipboard.writeText(ta.value).then(function () { copy.textContent = '已複製'; })
                          : document.execCommand('copy');
      copy.textContent = '已複製';
    };
    var apply = out.querySelector('.mp-apply');
    if (apply) apply.onclick = function () {
      var v = out.querySelector('.mp-paste').value.trim();
      if (!v) { alert('請先把 Gemini 的回覆貼進來。'); return; }
      onText(v, out);
    };
  }

  /* ============ AI 提議維度 ============ */
  // 用「表現最好」與「表現最差」兩組對照著問，AI 才會提出有區辨力的維度；
  // 只丟一堆素材名進去，它只會回一些放諸四海皆準的廢話。
  function buildDimPrompt() {
    var agg = {};
    ctx.rows.forEach(function (d) {
      var a = agg[d.material_key] = agg[d.material_key] || { imp: 0, clk: 0 };
      a.imp += d.impressions || 0; a.clk += d.clicks || 0;
    });
    var list = Object.keys(agg).map(function (k) {
      var m = ctx.byKey[k] || {};
      return { name: m.material_name || k, imp: agg[k].imp, ctr: agg[k].imp ? agg[k].clk / agg[k].imp : null };
    }).filter(function (r) { return r.ctr != null && r.imp >= Dims.threshold(); })
      .sort(function (a, b) { return b.ctr - a.ctr; });

    if (list.length < 6) return null;
    var n = Math.min(8, Math.floor(list.length / 2));
    var hi = list.slice(0, n), lo = list.slice(-n);
    var known = Dims.allDims(ctx).join('、');

    return '你是行銷素材分析顧問。以下兩組是同一檔活動的素材，分成 CTR 表現最好與最差兩群。\n\n' +
      '【表現好的】\n' + hi.map(function (r) { return '- ' + r.name + '（CTR ' + (r.ctr * 100).toFixed(2) + '%）'; }).join('\n') +
      '\n\n【表現差的】\n' + lo.map(function (r) { return '- ' + r.name + '（CTR ' + (r.ctr * 100).toFixed(2) + '%）'; }).join('\n') +
      '\n\n我們目前已經在標的維度有：' + known + '\n\n' +
      '請提出 3 到 6 個「現有維度沒有涵蓋、但可能解釋這兩群差異」的新維度。\n' +
      '規則：\n- 只輸出 JSON 陣列，不要說明文字或 markdown 標記\n' +
      '- 格式：[{"name":"維度名稱","hint":"可選值，用／分隔","why":"為什麼這個維度可能有解釋力"}]\n' +
      '- 不要重複已有的維度\n- 維度要能從素材本身客觀判斷，不要是主觀感受';
  }

  function applyDimSuggestion(text, out) {
    var parsed;
    try { parsed = JSON.parse(AI.normalizeAiText(text)); } catch (e) { parsed = null; }
    // AI 回傳的鍵名不固定，全部接受，免得因為鍵名不同就判定「沒有建議」
    if (parsed && !Array.isArray(parsed)) {
      parsed = parsed.維度 || parsed.dimensions || parsed.suggestions || null;
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      out.innerHTML = '<div class="check warn">看不懂 AI 的回覆格式。原文如下，可以自己挑要用的：</div>' +
        '<pre class="raw">' + esc(String(text).slice(0, 2000)) + '</pre>';
      return;
    }
    var items = parsed.map(function (d) {
      if (typeof d === 'string') return { name: d, hint: '', why: '' };
      return {
        name: String(d.name || d.維度 || d.維度名稱 || d.dimension || '').trim(),
        hint: String(d.hint || d.選項 || d.options || d.values || '').trim(),
        why: String(d.why || d.reason || d.說明 || d.理由 || '').trim()
      };
    }).filter(function (d) { return d.name; });

    out.innerHTML = '<div class="xmeta">AI 提議了 ' + items.length + ' 個維度。要用的按「加入」，會存進自訂維度。</div>' +
      items.map(function (d, i) {
        return '<div class="sug"><div class="sug-head"><b>' + esc(d.name) + '</b>' +
          '<button class="ghost sug-add" data-i="' + i + '">加入</button></div>' +
          (d.hint ? '<div class="muted">可選值：' + esc(d.hint) + '</div>' : '') +
          (d.why ? '<div class="muted">' + esc(d.why) + '</div>' : '') + '</div>';
      }).join('');

    Array.prototype.forEach.call(out.querySelectorAll('.sug-add'), function (btn) {
      btn.onclick = function () {
        var d = items[parseInt(btn.getAttribute('data-i'), 10)];
        btn.disabled = true; btn.textContent = '加入中…';
        Cloud.saveDimensions([{
          layer: 2, name: d.name, definition: d.hint || d.why || '',
          examples: [], sort_order: 99, deleted_at: null
        }]).then(function () {
          btn.textContent = '已加入';
          if (global.__reload) global.__reload();
        }).catch(function (e) { btn.disabled = false; btn.textContent = '失敗：' + e.message; });
      };
    });
  }

  /* ============ AI 解讀差異（我方 vs 市場） ============ */
  function buildGapPrompt() {
    var pool = (ctx.market || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });
    var ours = (ctx.materials || []).filter(function (m) { return m.tags && Object.keys(m.tags).length; });
    if (pool.length < 5 || ours.length < 3) return null;

    var dims = Dims.allDims(ctx, true);
    function share(list, weighted) {
      var out = {};
      dims.forEach(function (dim) {
        var g = {}, tot = 0;
        list.forEach(function (m) {
          var v = m.tags[dim]; if (!v) return;
          v = String(v).replace(/\s*[（(]不確定[)）]\s*/g, '').trim(); if (!v) return;
          var w = weighted ? Math.max(1, m.survival_days || 1) : 1;
          g[v] = (g[v] || 0) + w; tot += w;
        });
        if (tot) { out[dim] = {}; Object.keys(g).forEach(function (k) { out[dim][k] = g[k] / tot * 100; }); }
      });
      return out;
    }
    var mk = share(pool, true), ow = share(ours, false);

    var lines = [];
    dims.forEach(function (dim) {
      if (!mk[dim] || !ow[dim]) return;
      Object.keys(mk[dim]).forEach(function (k) {
        var a = mk[dim][k], b = ow[dim][k] || 0;
        if (Math.abs(a - b) >= 20) {
          lines.push(dim + '「' + k + '」：市場 ' + a.toFixed(0) + '%、我方 ' + b.toFixed(0) + '%');
        }
      });
    });
    if (!lines.length) return null;

    return '你是遊戲行銷素材顧問。以下是我方素材與市場競品素材在各視覺特徵上的分佈落差' +
      '（市場端以素材存活天數加權，存活越久代表競品越可能認為它有效）。\n\n' +
      lines.slice(0, 25).join('\n') +
      '\n\n請用繁體中文回答三件事，每件不超過三句：\n' +
      '1. 這些落差裡，哪幾項最可能是我們的機會或風險？為什麼？\n' +
      '2. 哪些落差其實是合理的差異化，不需要跟進？\n' +
      '3. 如果下一輪只能改一件事，你建議改什麼？\n\n' +
      '注意：不要假設落差一定代表我方做錯，也要考慮品牌定位不同的可能。不要輸出 JSON，直接寫文字。';
  }

  /* ============ AI 週報文字 ============ */
  function buildReportPrompt() {
    if (!ctx.rows.length) return null;
    var m = Data.metrics(ctx.rows);
    var byAngle = Data.groupBy(ctx.rows, ctx.byKey, 'angle').slice(0, 6);
    var bySp = Data.groupBy(ctx.rows, ctx.byKey, 'selling_point').slice(0, 6);
    var dates = ctx.rows.map(function (d) { return d.stat_date; }).sort();

    function tbl(list) {
      return list.map(function (g) {
        return '- ' + g.key + '：花費 $' + Math.round(g.spend) + '、CTR ' +
          (g.ctr != null ? (g.ctr * 100).toFixed(2) + '%' : '—') + '、CPA ' +
          (g.cpa != null ? '$' + g.cpa.toFixed(1) : '—') + '（' + g.count + ' 個素材）';
      }).join('\n');
    }

    return '你是遊戲行銷團隊的數據分析師，要寫一份給主管看的素材成效週報。\n\n' +
      '【期間】' + (dates[0] || '') + ' ~ ' + (dates[dates.length - 1] || '') + '\n' +
      '【整體】花費 $' + Math.round(m.spend) + '、曝光 ' + m.impressions.toLocaleString() +
      '、點擊 ' + m.clicks.toLocaleString() + '、CTR ' + (m.ctr != null ? (m.ctr * 100).toFixed(2) + '%' : '—') +
      '、CPA ' + (m.cpa != null ? '$' + m.cpa.toFixed(1) : '—') + '\n\n' +
      '【依素材切角】\n' + tbl(byAngle) + '\n\n【依賣點】\n' + tbl(bySp) + '\n\n' +
      '請用繁體中文寫，結構如下，總長度控制在 400 字內：\n' +
      '1. 一句話結論\n2. 這週有效的是什麼（要指名切角或賣點，並附數字）\n' +
      '3. 這週無效的是什麼\n4. 下週建議做什麼（具體到可執行）\n\n' +
      '要求：不要用「顯著」「大幅」這種沒有數字支撐的形容詞；' +
      '樣本少的項目要標注「樣本不足，僅供參考」；不要輸出 JSON。';
  }

  function showText(text, out) {
    out.innerHTML = '<div class="aitext">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
      '<button class="ghost copy-text">複製全文</button>';
    out.querySelector('.copy-text').onclick = function () {
      var b = this;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { b.textContent = '已複製'; });
    };
  }

  /* ============ 組裝 ============ */
  function render(state) {
    if (state) ctx = state;
    if (!$('api-usage')) return;
    renderKeyBar();
    renderUsage();

    var pend = AI.pending(ctx.materials || []).length;
    var st = $('ai-tagline');
    if (st) {
      st.innerHTML = pend
        ? pend + ' 個素材待標記（含新增維度後需要補的），預估 ' + AI.costText(AI.estimateCost(pend))
        : '所有素材都標記完成了。';
    }

    bindOnce();
  }

  var bound = false;
  function bindOnce() {
    if (bound) return; bound = true;

    $('btn-dim-suggest').onclick = function () {
      var p = buildDimPrompt();
      if (!p) { $('out-dim').innerHTML = '<div class="empty">需要至少 6 個曝光達門檻的素材才能對照出差異。</div>'; return; }
      runOrManual('out-dim', p, applyDimSuggestion);
    };
    $('btn-gap').onclick = function () {
      var p = buildGapPrompt();
      if (!p) {
        $('out-gap').innerHTML = '<div class="empty">需要至少 5 支已標籤的競品素材與 3 個已標籤的我方素材，' +
          '而且兩邊要有 20 個百分點以上的落差才值得解讀。</div>';
        return;
      }
      runOrManual('out-gap', p, showText);
    };
    $('btn-report').onclick = function () {
      var p = buildReportPrompt();
      if (!p) { $('out-report').innerHTML = '<div class="empty">目前的篩選條件沒有成效資料。</div>'; return; }
      runOrManual('out-report', p, showText);
    };
  }

  global.AiOps = { render: render, renderUsage: renderUsage };
})(window);
