/* ui.js — 畫面反應：登入、篩選、表格、匯入、搬遷 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    materials: [], daily: [], dimensions: [], importLog: [],
    byKey: {}, cacheAt: null, filters: { range: '14', channel: '', angle: '', sp: '', q: '' },
    sortField: 'spend', sortDir: -1, pendingUpdate: null, tagCtl: null
  };

  /* ================= 橫幅：只在需要你做事時才說話 ================= */
  function banner(msg, kind) {
    var b = $('banner');
    if (!msg) { b.hidden = true; return; }
    b.className = 'banner ' + (kind || '');
    b.textContent = msg;
    b.hidden = false;
  }

  /* ================= 登入 ================= */
  function showLogin(err) {
    $('login').hidden = false; $('app').hidden = true;
    var e = $('login-err');
    if (err) { e.textContent = err; e.hidden = false; } else { e.hidden = true; }
  }

  $('login-btn').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = '登入中…';
    Cloud.signIn($('login-email').value.trim(), $('login-pw').value)
      .then(start)
      .catch(function (e) { showLogin('登入失敗：' + (e.message || '請確認帳號密碼')); })
      .then(function () { btn.disabled = false; btn.textContent = '登入'; });
  });
  $('login-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('login-btn').click(); });
  $('btn-signout').addEventListener('click', function () {
    Cloud.signOut().then(function () { location.reload(); });
  });

  /* ================= 啟動：快取先畫，雲端後補 ================= */
  function start() {
    $('login').hidden = true; $('app').hidden = false;

    var cached = Cloud.readCache();
    if (cached) { apply(cached.data, cached.at); }
    else { renderEmpty(); }

    if (!navigator.onLine) { Cloud.setOnline(false); offlineBanner(); return; }

    var since = sinceDate();
    Cloud.loadAll(since).then(function (fresh) {
      if (!cached) { apply(fresh, new Date().toISOString()); }
      else if (changed(cached.data, fresh)) { S.pendingUpdate = fresh; $('update-prompt').hidden = false; }
      else { S.cacheAt = new Date().toISOString(); renderFreshness(); }
      return Cloud.loadGaps();
    }).then(renderGaps)
      .catch(function (e) {
        console.error(e);
        banner('連不上雲端，畫面顯示的是本機暫存的資料。修改暫時不會存回雲端。', 'offline');
        document.body.classList.add('readonly');
      });
  }

  function changed(a, b) {
    return a.materials.length !== b.materials.length ||
           a.daily.length !== b.daily.length ||
           JSON.stringify((a.daily[0] || {})) !== JSON.stringify((b.daily[0] || {}));
  }

  // 數字不自己跳。要換由你按。
  $('btn-apply-update').addEventListener('click', function () {
    if (!S.pendingUpdate) return;
    apply(S.pendingUpdate, new Date().toISOString());
    Cloud.writeCache(S.pendingUpdate);
    S.pendingUpdate = null;
    $('update-prompt').hidden = true;
  });

  function offlineBanner() {
    banner('目前離線。畫面是本機暫存的資料，所有修改會先排隊，恢復連線後自動送出。', 'offline');
  }
  Cloud.on(function (evt, payload) {
    if (evt === 'online') { payload ? banner(null) : offlineBanner(); }
    if (evt === 'flushed') { banner(null); alert('離線期間的 ' + payload + ' 筆修改已送出。'); }
  });

  function sinceDate() {
    var n = parseInt(S.filters.range, 10) || 400;
    var d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  function apply(data, at) {
    S.materials = data.materials || [];
    S.daily = data.daily || [];
    S.dimensions = data.dimensions || [];
    S.importLog = data.importLog || [];
    S.byKey = {};
    S.materials.forEach(function (m) { S.byKey[m.material_key] = m; });
    S.cacheAt = at;
    renderAll();
  }

  /* ================= 資料新鮮度 ================= */
  function renderFreshness() {
    var latest = S.daily.reduce(function (a, d) { return d.stat_date > a ? d.stat_date : a; }, '');
    var el = $('freshness');
    if (!latest) { el.textContent = ''; return; }
    var days = Math.floor((Date.now() - new Date(latest + 'T00:00:00')) / 86400000);
    el.textContent = '數據更新至 ' + latest.slice(5).replace('-', '/');
    el.className = 'freshness' + (days > 1 ? ' stale' : '');
  }

  /* ================= 匯入缺口 ================= */
  var DISMISS = Cloud.PREFIX + 'gaps_dismissed';
  function renderGaps(gaps) {
    var box = $('gaps');
    if (localStorage.getItem(DISMISS) === new Date().toISOString().slice(0, 10)) { box.hidden = true; return; }
    if (!gaps || !gaps.length) { box.hidden = true; return; }
    var by = {};
    gaps.forEach(function (g) { (by[g.channel] = by[g.channel] || []).push(g.stat_date.slice(5)); });
    var txt = Object.keys(by).map(function (c) { return c + ' 缺 ' + by[c].slice(0, 5).join('、'); }).join('；');
    box.innerHTML = '';
    var span = document.createElement('span'); span.textContent = '最近 14 天有資料沒進來：' + txt;
    var btn = document.createElement('button'); btn.className = 'link'; btn.textContent = '今天不再提醒';
    btn.onclick = function () { localStorage.setItem(DISMISS, new Date().toISOString().slice(0, 10)); box.hidden = true; };
    box.appendChild(span); box.appendChild(btn);
    box.hidden = false;
  }

  /* ================= 篩選 ================= */
  function filtered() {
    var f = S.filters, cutoff = sinceDate();
    return S.daily.filter(function (d) {
      if (f.range !== '0' && d.stat_date < cutoff) return false;
      if (f.channel && d.channel !== f.channel) return false;
      var m = S.byKey[d.material_key] || {};
      if (f.angle && m.angle !== f.angle) return false;
      if (f.sp && m.selling_point !== f.sp) return false;
      if (f.q && String(m.material_name || '').toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
      return true;
    });
  }

  function fillSelect(el, values, placeholder) {
    var cur = el.value;
    el.innerHTML = '';
    var o = document.createElement('option'); o.value = ''; o.textContent = placeholder; el.appendChild(o);
    values.forEach(function (v) {
      var op = document.createElement('option'); op.value = v; op.textContent = v; el.appendChild(op);
    });
    if (values.indexOf(cur) >= 0) el.value = cur;
  }

  function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); }

  function renderFilters() {
    fillSelect($('f-channel'), Data.CHANNELS, '全部渠道');
    fillSelect($('f-angle'), uniq(S.materials.map(function (m) { return m.angle; })), '全部切角');
    fillSelect($('f-sp'), uniq(S.materials.map(function (m) { return m.selling_point; })), '全部賣點');
    renderChips();
  }

  // 已套用的條件永遠列在畫面上，不會躲起來害你看錯數字
  function renderChips() {
    var wrap = $('chips'); wrap.innerHTML = '';
    var labels = { channel: '渠道', angle: '切角', sp: '賣點', q: '關鍵字' };
    var any = false;
    Object.keys(labels).forEach(function (k) {
      if (!S.filters[k]) return;
      any = true;
      var chip = document.createElement('span'); chip.className = 'chip';
      chip.appendChild(document.createTextNode(labels[k] + '：' + S.filters[k]));
      var x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', '移除' + labels[k]);
      x.onclick = function () {
        S.filters[k] = '';
        if (k === 'channel') $('f-channel').value = '';
        if (k === 'angle') $('f-angle').value = '';
        if (k === 'sp') $('f-sp').value = '';
        if (k === 'q') $('f-q').value = '';
        renderAll();
      };
      chip.appendChild(x); wrap.appendChild(chip);
    });
    $('btn-clear-filters').hidden = !any;
  }

  $('btn-clear-filters').addEventListener('click', function () {
    S.filters = { range: S.filters.range, channel: '', angle: '', sp: '', q: '' };
    ['f-channel', 'f-angle', 'f-sp', 'f-q'].forEach(function (id) { $(id).value = ''; });
    renderAll();
  });

  ['f-range', 'f-channel', 'f-angle', 'f-sp'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      S.filters[{ 'f-range': 'range', 'f-channel': 'channel', 'f-angle': 'angle', 'f-sp': 'sp' }[id]] = this.value;
      renderAll();
    });
  });
  $('f-q').addEventListener('input', function () { S.filters.q = this.value; renderAll(); });

  /* ================= 畫面 ================= */
  function renderEmpty() {
    $('mat-table').innerHTML = '<div class="empty">還沒有任何資料。先匯入一份成效表，或把舊版的資料搬過來。</div>';
    $('kpi').innerHTML = ''; $('dim-table').innerHTML = ''; $('trend').innerHTML = '';
  }

  function renderAll() {
    renderFilters(); renderFreshness();
    var rows = filtered();
    if (!S.materials.length) { renderEmpty(); return; }
    renderKPI(rows); renderDim(rows); renderMaterials(rows); renderTrendSelect(rows);
  }

  function renderKPI(rows) {
    var m = Data.metrics(rows);
    var items = [
      ['花費', Data.fmt(m.spend, 'money')], ['曝光', Data.fmt(m.impressions)],
      ['點擊', Data.fmt(m.clicks)], ['CTR', Data.fmt(m.ctr, 'pct')],
      ['CPC', Data.fmt(m.cpc, 'money')], ['CPA', Data.fmt(m.cpa, 'money')]
    ];
    $('kpi').innerHTML = items.map(function (it) {
      return '<div class="card"><div class="k">' + it[0] + '</div><div class="v">' + it[1] + '</div></div>';
    }).join('');
  }

  function renderDim(rows) {
    var field = $('dim-select').value;
    var groups = Data.groupBy(rows, S.byKey, field);
    if (!groups.length) { $('dim-table').innerHTML = '<div class="empty">目前的篩選條件沒有資料。</div>'; return; }
    var max = Math.max.apply(null, groups.map(function (g) { return g.ctr || 0; }));
    var html = '<div class="scroll-x"><table><thead><tr><th>項目</th><th class="num">素材數</th>' +
      '<th class="num">花費</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">CPA</th><th>CTR 比較</th></tr></thead><tbody>';
    groups.forEach(function (g) {
      var w = max ? Math.round((g.ctr || 0) / max * 100) : 0;
      html += '<tr><td>' + esc(g.key) + '</td><td class="num">' + g.count + '</td><td class="num">' +
        Data.fmt(g.spend, 'money') + '</td><td class="num">' + Data.fmt(g.ctr, 'pct') + '</td><td class="num">' +
        Data.fmt(g.cpc, 'money') + '</td><td class="num">' + Data.fmt(g.cpa, 'money') +
        '</td><td><div class="bar" style="width:' + w + '%"></div></td></tr>';
    });
    $('dim-table').innerHTML = html + '</tbody></table></div>';
  }
  $('dim-select').addEventListener('change', renderAll);

  function renderMaterials(rows) {
    var agg = {};
    rows.forEach(function (d) { (agg[d.material_key] = agg[d.material_key] || []).push(d); });
    var list = Object.keys(agg).map(function (k) {
      var m = Data.metrics(agg[k]);
      var mat = S.byKey[k] || {};
      m.key = k; m.name = mat.material_name || k;
      m.angle = mat.angle; m.tagged = (mat.tag_version || 0) >= AI.TAG_VERSION;
      m.tone = (mat.tags || {})['色調'] || '';
      m.days = new Set(agg[k].map(function (r) { return r.stat_date; })).size;
      return m;
    });
    list.sort(function (a, b) {
      var x = a[S.sortField], y = b[S.sortField];
      if (x == null) return 1; if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * S.sortDir;
    });

    var untagged = list.filter(function (r) { return !r.tagged; }).length;
    $('tag-status').textContent = untagged ? untagged + ' 筆未標記，預估 $' + AI.estimateCost(untagged).toFixed(0) : '全部已標記';
    $('btn-tag').disabled = !untagged;

    var cols = [['name', '素材'], ['days', '在跑天數'], ['spend', '花費'], ['impressions', '曝光'],
                ['clicks', '點擊'], ['ctr', 'CTR'], ['cpc', 'CPC'], ['cpa', 'CPA'], ['tone', '色調（AI）']];
    var html = '<div class="legend"><span><i class="swatch measured"></i>實際量測</span>' +
               '<span><i class="swatch inferred"></i>AI 推論，僅供參考</span></div>' +
               '<table><thead><tr>';
    cols.forEach(function (c) {
      html += '<th class="' + (c[0] === 'name' || c[0] === 'tone' ? '' : 'num') + '" data-f="' + c[0] + '">' + c[1] +
              (S.sortField === c[0] ? (S.sortDir < 0 ? ' ↓' : ' ↑') : '') + '</th>';
    });
    html += '</tr></thead><tbody>';
    list.slice(0, 300).forEach(function (r) {
      html += '<tr><td>' + esc(r.name) + '</td><td class="num">' + r.days + '</td><td class="num">' +
        Data.fmt(r.spend, 'money') + '</td><td class="num">' + Data.fmt(r.impressions) + '</td><td class="num">' +
        Data.fmt(r.clicks) + '</td><td class="num">' + Data.fmt(r.ctr, 'pct') + '</td><td class="num">' +
        Data.fmt(r.cpc, 'money') + '</td><td class="num">' + Data.fmt(r.cpa, 'money') + '</td><td>' +
        (r.tone ? '<span class="ai-val">' + esc(r.tone) + '</span>' : '<span class="muted">未標記</span>') +
        '</td></tr>';
    });
    $('mat-table').innerHTML = html + '</tbody></table>';

    Array.prototype.forEach.call($('mat-table').querySelectorAll('th[data-f]'), function (th) {
      th.onclick = function () {
        var f = th.getAttribute('data-f');
        if (S.sortField === f) S.sortDir = -S.sortDir; else { S.sortField = f; S.sortDir = -1; }
        renderMaterials(filtered());
      };
    });
  }

  function renderTrendSelect(rows) {
    var keys = uniq(rows.map(function (d) { return d.material_key; }));
    var sel = $('trend-select'); var cur = sel.value;
    sel.innerHTML = '';
    keys.slice(0, 200).forEach(function (k) {
      var o = document.createElement('option'); o.value = k;
      o.textContent = (S.byKey[k] || {}).material_name || k;
      sel.appendChild(o);
    });
    if (keys.indexOf(cur) >= 0) sel.value = cur;
    renderTrend();
  }
  $('trend-select').addEventListener('change', renderTrend);

  function renderTrend() {
    var key = $('trend-select').value;
    if (!key) { $('trend').innerHTML = '<div class="empty">選一個素材看它的走期表現。</div>'; return; }
    var series = Data.trendFor(filtered(), key);
    if (!series.length) { $('trend').innerHTML = '<div class="empty">這個素材在目前的期間內沒有資料。</div>'; return; }
    var max = Math.max.apply(null, series.map(function (s) { return s.ctr || 0; }));
    var html = '<div class="scroll-x"><table><thead><tr><th>日期</th><th class="num">花費</th>' +
      '<th class="num">曝光</th><th class="num">CTR</th><th class="num">CPA</th><th>CTR 走勢</th></tr></thead><tbody>';
    series.forEach(function (s) {
      var w = max ? Math.round((s.ctr || 0) / max * 100) : 0;
      html += '<tr><td>' + s.date.slice(5) + '</td><td class="num">' + Data.fmt(s.spend, 'money') +
        '</td><td class="num">' + Data.fmt(s.impressions) + '</td><td class="num">' + Data.fmt(s.ctr, 'pct') +
        '</td><td class="num">' + Data.fmt(s.cpa, 'money') + '</td><td><div class="bar" style="width:' + w + '%"></div></td></tr>';
    });
    $('trend').innerHTML = html + '</tbody></table></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================= 匯入成效表 ================= */
  $('btn-import').addEventListener('click', function () { $('file-input').click(); });
  $('file-input').addEventListener('change', function () {
    var file = this.files[0]; if (!file) return;
    this.value = '';
    var reader = new FileReader();
    reader.onload = function (e) {
      var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
      var parsed = Data.parseWorkbook(wb, null, '');

      if (!parsed.hasDateCol) {
        var d = prompt('這份檔案沒有日期欄。這批資料要算成哪一天？（YYYY-MM-DD）',
                       new Date(Date.now() - 86400000).toISOString().slice(0, 10));
        if (!Data.toDate(d)) { alert('日期格式看不懂，匯入取消。'); return; }
        parsed = Data.parseWorkbook(wb, Data.toDate(d), '');
      }

      if (!parsed.rows.length) { alert('這份檔案裡找不到素材與成效欄位。請確認欄位名稱包含「素材」，以及「點擊」或「曝光」。'); return; }
      saveImport(parsed);
    };
    reader.readAsArrayBuffer(file);
  });

  function saveImport(parsed) {
    var matMap = {};
    parsed.rows.forEach(function (r) {
      if (matMap[r.material_key]) return;
      var p = Data.parseName(r.material_name);
      var exist = S.byKey[r.material_key] || {};
      matMap[r.material_key] = {
        material_key: r.material_key, material_name: r.material_name,
        format: p.format, visual_type: p.visual_type, angle: p.angle, selling_point: p.selling_point,
        tag_version: exist.tag_version || 0, tags: exist.tags || {}
      };
    });
    var daily = parsed.rows.map(function (r) {
      return {
        stat_date: r.stat_date, material_key: r.material_key, channel: r.channel,
        impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions,
        source: 'manual_import'
      };
    });
    var logs = {};
    daily.forEach(function (d) { logs[d.stat_date + '|' + d.channel] = { stat_date: d.stat_date, channel: d.channel, source: 'manual_import', row_count: 0, status: 'ok' }; });
    Object.keys(logs).forEach(function (k) {
      logs[k].row_count = daily.filter(function (d) { return d.stat_date + '|' + d.channel === k; }).length;
    });

    banner('正在寫入雲端…', '');
    Cloud.saveMaterials(Object.values(matMap))
      .then(function () { return Cloud.saveDaily(daily); })
      .then(function () { return Cloud.saveImportLog(Object.values(logs)); })
      .then(function () { return Cloud.loadAll(sinceDate()); })
      .then(function (fresh) {
        apply(fresh, new Date().toISOString());
        banner(null);
        document.body.classList.remove('readonly');
        alert('匯入完成：' + Object.keys(matMap).length + ' 個素材、' + daily.length + ' 筆每日資料。' +
              (parsed.merged ? '\n（有 ' + parsed.merged + ' 列是同一天同一素材的重複紀錄，已自動加總）' : ''));
      })
      .catch(function (e) {
        banner('寫入失敗，這批資料已排進佇列，恢復連線後會自動送出。（' + e.message + '）', 'error');
      });
  }

  /* ================= 從舊版搬資料 ================= */
  $('btn-migrate').addEventListener('click', function () {
    var found = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf(Cloud.PREFIX) === 0) continue;   // 舊版的 key 只讀不寫
      var v = localStorage.getItem(k);
      if (v && v.length > 40 && (v[0] === '{' || v[0] === '[')) found.push({ key: k, size: v.length });
    }
    var msg = found.length
      ? '在這台瀏覽器找到 ' + found.length + ' 筆舊版資料：\n\n' +
        found.map(function (f) { return '• ' + f.key + '（' + Math.round(f.size / 1024) + ' KB）'; }).join('\n') +
        '\n\n按「確定」全部搬進雲端，按「取消」改成上傳舊版的匯出 JSON 檔。'
      : '這台瀏覽器沒有找到舊版資料。\n\n按「確定」改用上傳舊版匯出 JSON 檔的方式。';
    if (found.length && confirm(msg)) { migrate(found.map(function (f) { return localStorage.getItem(f.key); })); }
    else { $('json-input').click(); }
  });

  $('json-input').addEventListener('change', function () {
    var file = this.files[0]; if (!file) return;
    this.value = '';
    var reader = new FileReader();
    reader.onload = function (e) { migrate([e.target.result]); };
    reader.readAsText(file);
  });

  // 舊版的格式不只一種，所以這裡不假設結構，只把「看起來像素材」的東西撈出來
  function migrate(payloads) {
    var mats = {}, dims = [], dimSeen = {};
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      var name = node.material_name || node.name || node.素材 || node.素材名稱;
      if (typeof name === 'string' && name.length > 3 && name.indexOf('_') > 0) {
        var key = Data.materialKey(name);
        var p = Data.parseName(name);
        var tags = node.tags || node.標籤 || null;
        if (!mats[key] || (tags && !mats[key].tags)) {
          mats[key] = {
            material_key: key, material_name: name,
            format: p.format, visual_type: p.visual_type, angle: p.angle, selling_point: p.selling_point,
            tags: tags && typeof tags === 'object' ? tags : {},
            tag_version: tags && typeof tags === 'object' ? AI.TAG_VERSION : 0,
            tagged_at: tags ? new Date().toISOString() : null
          };
        }
      }
      if (node.layer && node.name && node.definition) {
        var dk = node.layer + '|' + node.name;
        if (!dimSeen[dk]) {
          dimSeen[dk] = 1;
          dims.push({ layer: node.layer, name: node.name, definition: node.definition, examples: node.examples || [] });
        }
      }
      Object.keys(node).forEach(function (k) { walk(node[k]); });
    }
    payloads.forEach(function (p) { try { walk(JSON.parse(p)); } catch (e) { console.warn('這筆不是 JSON，跳過'); } });

    var list = Object.values(mats);
    if (!list.length && !dims.length) { alert('沒有辨識出可以搬的素材。舊版的匯出 JSON 檔可能是別的格式，把檔案傳給我我來調整。'); return; }
    if (!confirm('辨識到 ' + list.length + ' 個素材、' + dims.length + ' 個維度定義。\n\n這些會寫進雲端（已存在的不會被覆蓋標籤）。要繼續嗎？')) return;

    banner('正在搬遷…', '');
    Cloud.saveMaterials(list)
      .then(function () { return dims.length ? Cloud.saveDimensions(dims) : null; })
      .then(function () { return Cloud.loadAll(sinceDate()); })
      .then(function (fresh) {
        apply(fresh, new Date().toISOString()); banner(null);
        alert('搬遷完成。舊版的資料原封不動留著，沒有被刪除。');
      })
      .catch(function (e) { banner('搬遷失敗：' + e.message, 'error'); });
  }

  /* ================= AI 補標 ================= */
  $('btn-tag').addEventListener('click', function () {
    if (!AI.getKey()) {
      var k = prompt('請輸入 Gemini API Key（只存在這台電腦，不會上傳雲端）');
      if (!k) return;
      AI.setKey(k.trim());
    }
    var todo = AI.pending(S.materials);
    if (!todo.length) return;
    if (!confirm('要補標 ' + todo.length + ' 筆素材，預估花費 $' + AI.estimateCost(todo.length).toFixed(0) + '。\n\n中途可以按「停止」，已標好的會保留。要開始嗎？')) return;

    $('tag-progress').hidden = false;
    $('btn-tag').disabled = true;
    S.tagCtl = AI.tagBatch(S.materials, {
      onProgress: function (done, total) {
        $('tag-progress-text').textContent = '標記中：第 ' + done + ' / ' + total + ' 筆';
      }
    });
    S.tagCtl.promise.then(function (out) {
      $('tag-progress').hidden = true;
      if (!out.results.length) { alert('沒有成功標記任何素材。'); $('btn-tag').disabled = false; return; }
      return Cloud.saveMaterials(out.results)
        .then(function () { return Cloud.loadAll(sinceDate()); })
        .then(function (fresh) {
          apply(fresh, new Date().toISOString());
          alert('完成 ' + out.results.length + ' 筆' + (out.aborted ? '（已中止，其餘保留未標記）' : '') + '。');
        });
    }).catch(function (e) {
      $('tag-progress').hidden = true; $('btn-tag').disabled = false;
      banner('標記失敗：' + e.message, 'error');
    });
  });

  $('btn-tag-abort').addEventListener('click', function () {
    if (S.tagCtl) { S.tagCtl.abort(); $('tag-progress-text').textContent = '停止中，等這批跑完…'; }
  });

  /* ================= 匯出備份 ================= */
  $('btn-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(),
      materials: S.materials, daily: S.daily, dimensions: S.dimensions
    }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '素材資料備份_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  });

  /* ================= 進場 ================= */
  Cloud.currentUser().then(function (u) { u ? start() : showLogin(); })
    .catch(function () { showLogin(); });

})(window);
