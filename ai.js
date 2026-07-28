/* ai.js — 跟 Gemini 講話：18 維標籤、成本估算、批次補標（可中止） */
(function (global) {
  'use strict';

  var BATCH_SIZE = 20;
  var TAG_VERSION = 1;                       // 維度改了就把這個加一，舊素材會自動被算成「待補標」
  var KEY_STORE = 'mt2_gemini_key';          // 只存本機，不上雲
  var MODEL_KEY = 'mt2_gemini_model';
  var USAGE_KEY = 'mt2_api_usage';
  var DEFAULT_MODEL = 'gemini-2.5-flash';

  // USD / 1M tokens。找不到對應型號時用 flash 價當保守估計。
  var PRICING = {
    'gemini-2.5-flash': { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':   { in: 1.25, out: 10.0 },
    'gemini-2.0-flash': { in: 0.10, out: 0.40 },
    _default:           { in: 0.30, out: 2.50 }
  };

  function getModel() { return (localStorage.getItem(MODEL_KEY) || '').trim() || DEFAULT_MODEL; }
  function setModel(m) { localStorage.setItem(MODEL_KEY, (m || '').trim()); }

  function monthKey() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function readUsage() {
    try { return JSON.parse(localStorage.getItem(USAGE_KEY)) || {}; } catch (e) { return {}; }
  }

  function recordUsage(inTok, outTok) {
    var all = readUsage(), k = monthKey();
    var m = all[k] || { calls: 0, inTok: 0, outTok: 0 };
    m.calls += 1; m.inTok += (inTok || 0); m.outTok += (outTok || 0);
    all[k] = m;
    var keys = Object.keys(all).sort();
    while (keys.length > 6) { delete all[keys.shift()]; }   // 只留最近六個月
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(all)); } catch (e) {}
    if (global.AiOps && AiOps.renderUsage) AiOps.renderUsage();
  }

  function usageCost(m) {
    if (!m) return 0;
    var p = PRICING[getModel()] || PRICING._default;
    return m.inTok / 1e6 * p.in + m.outTok / 1e6 * p.out;
  }


  var TAG_SCHEMA = {
    視覺: ['色調', '主色系', '人物類型', '人物大小占比', '人物動作姿態',
          '表情情緒', '眼神方向', '構圖密度', '視覺焦點數量'],
    文案與CTA: ['是否有數字', 'CTA明確度', '文字資訊量', '標題語法'],
    心理效果: ['稀缺感信號', '社群認同信號', '損失厭惡語法', '福利明確性', '畫面複雜度評分']
  };
  var ALL_DIMS = Object.keys(TAG_SCHEMA).reduce(function (a, k) { return a.concat(TAG_SCHEMA[k]); }, []);

  function getKey() { return localStorage.getItem(KEY_STORE) || ''; }
  function setKey(k) { localStorage.setItem(KEY_STORE, k || ''); }

  // 只看版本號會漏：加了新維度但版本沒動時，舊素材少了那一維卻被當成已標記。
  // 所以同時檢查「該有的維度是不是都在」。
  var extraDims = [];
  function setExtraDims(list) { extraDims = (list || []).slice(); }
  function expectedDims() { return ALL_DIMS.concat(extraDims); }

  function pending(materials) {
    var want = expectedDims();
    return materials.filter(function (m) {
      if ((m.tag_version || 0) < TAG_VERSION) return true;
      var t = m.tags || {};
      for (var i = 0; i < want.length; i++) {
        if (t[want[i]] == null || t[want[i]] === '') return true;
      }
      return false;
    });
  }
  // 用實際牌價估，不用固定單價——固定單價會跟用量頁的數字互相矛盾。
  // 一批 20 筆：輸入約 400 token 的維度說明加上每筆約 30 token 的素材名；輸出每筆約 220 token。
  function estimateCost(n) {
    var p = PRICING[getModel()] || PRICING._default;
    var batches = Math.ceil(n / BATCH_SIZE);
    var inTok = batches * 400 + n * 30;
    var outTok = n * 220;
    return inTok / 1e6 * p.in + outTok / 1e6 * p.out;   // 回傳 USD
  }
  function costText(c) { return 'US$' + (c > 0 && c < 0.01 ? c.toFixed(4) : c.toFixed(2)); }

  function buildPrompt(names) {
    var want = expectedDims();
    return '你是行銷素材分析助理。以下是素材名稱清單，命名規則為 格式_視覺類型_素材切角_賣點_走期。\n' +
      '請針對每一個素材，就下列 ' + want.length + ' 個維度給出判斷。\n\n' +
      '維度清單：\n' + want.map(function (d, i) { return (i + 1) + '. ' + d; }).join('\n') + '\n\n' +
      '規則：\n' +
      '- 只輸出 JSON 陣列，不要任何說明文字或 markdown 標記\n' +
      '- 每個元素格式：{"name":"素材名稱","tags":{"維度名":"判斷值"}}\n' +
      '- 無法從名稱判斷的維度填 "未知"，不要臆測\n' +
      '- 所有維度都要出現，不可省略\n\n' +
      '素材清單：\n' + names.map(function (n) { return '- ' + n; }).join('\n');
  }

  // AI 常常包一層 ```json 或講一句廢話再給 JSON，這裡先洗乾淨
  function normalizeAiText(text) {
    var t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
    return t;
  }

  function callGemini(prompt) {
    var key = getKey();
    if (!key) return Promise.reject(new Error('尚未設定 Gemini API Key'));
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              getModel() + ':generateContent?key=' + encodeURIComponent(key);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
      })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Gemini 回應 ' + r.status + '：' + t.slice(0, 200)); });
      return r.json();
    }).then(function (j) {
      var u = j.usageMetadata || {};
      recordUsage(u.promptTokenCount || 0, u.candidatesTokenCount || 0);
      var parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map(function (p) { return p.text || ''; }).join('');
    });
  }

  /* 批次補標：一次 20 筆，回報進度，可中止 */
  function tagBatch(materials, opts) {
    opts = opts || {};
    var todo = pending(materials);
    var BATCH = BATCH_SIZE;
    var done = 0, results = [], aborted = false;
    var ctl = { abort: function () { aborted = true; } };

    var chain = Promise.resolve();
    for (var i = 0; i < todo.length; i += BATCH) {
      (function (slice) {
        chain = chain.then(function () {
          if (aborted) return;
          return callGemini(buildPrompt(slice.map(function (m) { return m.material_name; })))
            .then(function (text) {
              var parsed;
              try { parsed = JSON.parse(normalizeAiText(text)); }
              catch (e) { parsed = []; console.warn('這批解析失敗，跳過', e); }
              var byName = {};
              (parsed || []).forEach(function (p) { if (p && p.name) byName[p.name] = p.tags || {}; });

              slice.forEach(function (m) {
                var tags = byName[m.material_name];
                if (!tags) return;
                results.push({
                  material_key: m.material_key,
                  material_name: m.material_name,
                  tags: tags,
                  tag_version: TAG_VERSION,
                  tagged_at: new Date().toISOString(),
                  tag_cost_twd: 0
                });
              });
              done += slice.length;
              if (opts.onProgress) opts.onProgress(done, todo.length);
            });
        });
      })(todo.slice(i, i + BATCH));
    }

    ctl.promise = chain.then(function () {
      return { results: results, total: todo.length, done: done, aborted: aborted };
    });
    return ctl;
  }

  global.AI = {
    TAG_VERSION: TAG_VERSION, TAG_SCHEMA: TAG_SCHEMA, ALL_DIMS: ALL_DIMS,
    getKey: getKey, setKey: setKey, setExtraDims: setExtraDims, expectedDims: expectedDims,
    getModel: getModel, setModel: setModel, readUsage: readUsage, usageCost: usageCost,
    monthKey: monthKey, PRICING: PRICING,
    pending: pending, estimateCost: estimateCost, costText: costText,
    buildPrompt: buildPrompt, normalizeAiText: normalizeAiText,
    callGemini: callGemini, tagBatch: tagBatch
  };
})(window);
