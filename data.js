/* data.js — 算數據：素材編號、Excel 解析、彙總、走期趨勢 */
(function (global) {
  'use strict';

  var CHANNELS = ['成效型Meta', '成效型Google', '曝光型META', '雷電', 'LINE Backdrop'];

  /* ---------- 素材的穩定身分 ---------- */
  // 名稱被改一個字就變成新素材是舊版的痛點。這裡先正規化再雜湊，
  // 並且把走期後綴拿掉——走期由每日流水表達，不該編進身分裡。
  function normalizeName(name) {
    return String(name || '')
      .replace(/[\uFF01-\uFF5E]/g, function (c) {          // 全形轉半形
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\s+/g, '')
      .replace(/[_\-]?(\d{4}[./]?\d{2}[./]?\d{2})(-\d{4}[./]?\d{2}[./]?\d{2})?$/, '')
      .toLowerCase();
  }

  function hash(str) {
    var h = 5381, i = str.length;
    while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function materialKey(name) { return hash(normalizeName(name)); }

  // 命名規則：格式_視覺類型_素材切角_賣點_走期
  function parseName(name) {
    var parts = String(name || '').split('_');
    return {
      format: parts[0] || '',
      visual_type: parts[1] || '',
      angle: parts[2] || '',
      selling_point: parts[3] || ''
    };
  }

  /* ---------- Excel 解析 ---------- */
  var ALIASES = {
    name: ['素材', '素材名稱', '素材名', 'creative', 'ad name', '廣告名稱'],
    date: ['日期', 'date', '統計日期', 'day'],
    channel: ['渠道', '通路', 'channel', '媒體', '版位'],
    impressions: ['曝光', '曝光數', 'impressions', 'imp'],
    clicks: ['點擊', '點擊數', 'clicks', 'click'],
    spend: ['花費', '費用', 'spend', 'cost', '金額'],
    conversions: ['預約', '預約數', '轉換', '轉換數', 'conversions', 'conversion', 'results', '安裝', 'install', 'installs']
  };

  // 「曝光佔比」不是「曝光」、「點擊率」不是「點擊」。
  // CTR / CVR / CPC 這類縮寫是算出來的指標，絕對不能被當成原始數據欄。
  var METRIC_ABBR = /^(ctr|cvr|cpc|cpm|cpa|cpi|cpl|roas|roi|freq|frequency|reach率)$/i;
  var RATIO_WORDS = /率|佔比|占比|比例|百分|%|rate|ratio|percent|avg|平均|per\s|每次|單次/i;

  function findCol(headers, field) {
    var alias = ALIASES[field].map(function (a) { return a.toLowerCase(); });
    var norm = headers.map(function (h) { return String(h || '').trim().toLowerCase(); });

    for (var i = 0; i < norm.length; i++) {
      if (METRIC_ABBR.test(norm[i])) continue;
      if (alias.indexOf(norm[i]) >= 0) return i;
    }
    for (var k = 0; k < norm.length; k++) {
      if (!norm[k] || METRIC_ABBR.test(norm[k]) || RATIO_WORDS.test(norm[k])) continue;
      for (var j = 0; j < alias.length; j++) {
        if (norm[k].indexOf(alias[j]) === 0) return k;
      }
    }
    return -1;
  }

  function toNumber(v) {
    if (v == null || v === '') return 0;
    var n = parseFloat(String(v).replace(/[,$%\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function toInt(v) { return Math.round(toNumber(v)); }

  // Excel 的日期常常是序號（45000 這種），不是字串。這坑踩過了。
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 60000) {
      var d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.toISOString().slice(0, 10);
    }
    var s = String(v).trim().replace(/[./]/g, '-');
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    var p = new Date(s);
    return isNaN(p) ? null : p.toISOString().slice(0, 10);
  }

  // 同一天、同一素材、同一渠道在檔案裡出現多列（跑在多個廣告組時很常見）
  // 必須先加總成一列，否則寫入資料庫時整批會失敗。
  function aggregateDaily(rows) {
    var map = {};
    rows.forEach(function (r) {
      var k = r.stat_date + '|' + r.material_key + '|' + r.channel;
      if (!map[k]) {
        map[k] = {
          stat_date: r.stat_date, material_key: r.material_key, channel: r.channel,
          material_name: r.material_name,
          impressions: 0, clicks: 0, spend: 0, conversions: 0
        };
      }
      map[k].impressions += r.impressions || 0;
      map[k].clicks += r.clicks || 0;
      map[k].spend += r.spend || 0;
      map[k].conversions += r.conversions || 0;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function parseWorkbook(wb, fallbackDate, fallbackChannel) {
    var out = { rows: [], skipped: 0, sheets: [], hasDateCol: false, merged: 0 };
    wb.SheetNames.forEach(function (sn) {
      var grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
      if (!grid.length) return;

      var headerRow = -1, cols = null;
      for (var r = 0; r < Math.min(grid.length, 15); r++) {
        var c = {
          name: findCol(grid[r], 'name'),
          impressions: findCol(grid[r], 'impressions'),
          clicks: findCol(grid[r], 'clicks'),
          spend: findCol(grid[r], 'spend')
        };
        if (c.name >= 0 && (c.clicks >= 0 || c.impressions >= 0)) {
          headerRow = r;
          c.date = findCol(grid[r], 'date');
          c.channel = findCol(grid[r], 'channel');
          c.conversions = findCol(grid[r], 'conversions');
          if (c.date >= 0) out.hasDateCol = true;
          cols = c;
          break;
        }
      }
      if (headerRow < 0) return;
      out.sheets.push(sn);

      for (var i = headerRow + 1; i < grid.length; i++) {
        var row = grid[i];
        var name = String(row[cols.name] || '').trim();
        if (!name) { continue; }
        var date = cols.date >= 0 ? toDate(row[cols.date]) : fallbackDate;
        if (!date) { out.skipped++; continue; }
        var channel = cols.channel >= 0 ? String(row[cols.channel] || '').trim() : '';
        if (!channel) channel = fallbackChannel || sn;

        out.rows.push({
          material_name: name,
          material_key: materialKey(name),
          stat_date: date,
          channel: channel,
          impressions: cols.impressions >= 0 ? toInt(row[cols.impressions]) : 0,
          clicks: cols.clicks >= 0 ? toInt(row[cols.clicks]) : 0,
          spend: cols.spend >= 0 ? toNumber(row[cols.spend]) : 0,
          conversions: cols.conversions >= 0 ? toInt(row[cols.conversions]) : 0
        });
      }
    });
    var before = out.rows.length;
    out.rows = aggregateDaily(out.rows);
    out.merged = before - out.rows.length;
    return out;
  }

  /* ---------- 彙總 ---------- */
  function sum(rows, f) { return rows.reduce(function (a, r) { return a + (r[f] || 0); }, 0); }

  function metrics(rows) {
    var imp = sum(rows, 'impressions'), clk = sum(rows, 'clicks');
    var spd = sum(rows, 'spend'), cvs = sum(rows, 'conversions');
    return {
      impressions: imp, clicks: clk, spend: spd, conversions: cvs,
      ctr: imp ? clk / imp : null,
      cpc: clk ? spd / clk : null,
      cpm: imp ? spd * 1000 / imp : null,
      cvr: clk ? cvs / clk : null,
      cpa: cvs ? spd / cvs : null
    };
  }

  // 加權，不是把各素材的 CTR 平均起來——那是舊版算錯過的地方
  function groupBy(dailyRows, materialsByKey, field) {
    var buckets = {};
    dailyRows.forEach(function (d) {
      var m = materialsByKey[d.material_key];
      var k = (m && m[field]) || '未分類';
      (buckets[k] = buckets[k] || []).push(d);
    });
    return Object.keys(buckets).map(function (k) {
      var mm = metrics(buckets[k]);
      mm.key = k; mm.count = new Set(buckets[k].map(function (r) { return r.material_key; })).size;
      return mm;
    }).sort(function (a, b) { return b.spend - a.spend; });
  }

  function trendFor(dailyRows, key) {
    var byDate = {};
    dailyRows.filter(function (d) { return d.material_key === key; })
      .forEach(function (d) { (byDate[d.stat_date] = byDate[d.stat_date] || []).push(d); });
    return Object.keys(byDate).sort().map(function (dt) {
      var mm = metrics(byDate[dt]); mm.date = dt; return mm;
    });
  }

  function fmt(v, kind) {
    if (v == null) return '—';
    if (kind === 'pct') return (v * 100).toFixed(2) + '%';
    if (kind === 'money') return '$' + v.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
    return Math.round(v).toLocaleString('zh-TW');
  }

  global.Data = {
    CHANNELS: CHANNELS,
    normalizeName: normalizeName, materialKey: materialKey, parseName: parseName,
    parseWorkbook: parseWorkbook, toDate: toDate, aggregateDaily: aggregateDaily,
    metrics: metrics, groupBy: groupBy, trendFor: trendFor, fmt: fmt
  };
})(window);
