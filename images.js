/* images.js — 把 Excel 裡內嵌的素材圖抽出來，對上素材名，傳到雲端 */
(function (global) {
  'use strict';

  function txt(x) { return String(x == null ? '' : x); }

  // A1 → {col:0, row:0}
  function refToRC(ref) {
    var m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return null;
    var col = 0;
    for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
    return { col: col - 1, row: parseInt(m[2], 10) - 1 };
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    var out = [];
    var re = /<si>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var parts = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      out.push(parts.map(function (p) {
        return p.replace(/<[^>]+>/g, '');
      }).join(''));
    }
    return out;
  }

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  // 回傳 { "0,3": "文字內容", ... }（key 是 row,col）
  function parseSheetCells(xml, shared) {
    var cells = {};
    var re = /<c\s+r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g, m;
    while ((m = re.exec(xml))) {
      var rc = refToRC(m[1]); if (!rc) continue;
      var isShared = /t="s"/.test(m[2]);
      var vm = /<v>([\s\S]*?)<\/v>/.exec(m[3]);
      var val;
      if (isShared && vm) val = shared[parseInt(vm[1], 10)] || '';
      else {
        var tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[3]);
        val = tm ? tm[1] : (vm ? vm[1] : '');
      }
      val = decodeEntities(txt(val).replace(/<[^>]+>/g, '')).trim();
      if (val) cells[rc.row + ',' + rc.col] = val;
    }
    return cells;
  }

  // 「圖影組合」這種沒有底線的命名，用舊的判定會永遠對不上。
  // 底線改成加分條件：先找有底線的，找不到再接受一般文字。
  var NOT_NAME = /^(素材|素材名稱|名稱|合計|總計|小計|備註|項目|日期|花費|曝光|點擊|ctr|cpc|cpm|cpa|cvr|預約|轉換|no|#)$/i;

  function nameScore(s) {
    if (typeof s !== 'string') return 0;
    var v = s.trim();
    if (v.length < 3 || v.length > 120) return 0;
    if (/^https?:/i.test(v)) return 0;
    if (/^[\d.,%$\-\s]+$/.test(v)) return 0;        // 純數字或金額
    if (NOT_NAME.test(v)) return 0;                    // 表頭字樣
    return v.indexOf('_') > 0 ? 2 : 1;
  }

  function hashBytes(bytes) {
    var h = 5381;
    var step = Math.max(1, Math.floor(bytes.length / 4096));
    for (var i = 0; i < bytes.length; i += step) h = ((h * 33) ^ bytes[i]) >>> 0;
    return (h >>> 0).toString(16) + '-' + bytes.length.toString(16);
  }

  /* 主流程：解壓 → 找圖片錨點 → 往附近找素材名 → 回傳配對結果 */
  function extract(arrayBuffer) {
    return JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var jobs = [];
      var shared = [], sheets = {}, drawingRels = {}, sheetDrawing = {};

      function readText(path) {
        var f = zip.file(path);
        return f ? f.async('string') : Promise.resolve('');
      }

      jobs.push(readText('xl/sharedStrings.xml').then(function (x) { shared = parseSharedStrings(x); }));

      var sheetFiles = Object.keys(zip.files).filter(function (p) {
        return /^xl\/worksheets\/sheet\d+\.xml$/.test(p);
      });

      return Promise.all(jobs).then(function () {
        var more = [];
        sheetFiles.forEach(function (sp) {
          more.push(readText(sp).then(function (x) { sheets[sp] = parseSheetCells(x, shared); }));
          var relPath = sp.replace('worksheets/', 'worksheets/_rels/') + '.rels';
          more.push(readText(relPath).then(function (x) {
            var m = /Target="([^"]*drawing\d+\.xml)"/.exec(x || '');
            if (m) sheetDrawing[sp] = 'xl/drawings/' + m[1].split('/').pop();
          }));
        });
        return Promise.all(more);
      }).then(function () {
        var more = [];
        Object.keys(sheetDrawing).forEach(function (sp) {
          var dp = sheetDrawing[sp];
          var rp = dp.replace('drawings/', 'drawings/_rels/') + '.rels';
          more.push(readText(rp).then(function (x) {
            var map = {}, re = /Id="([^"]+)"[^>]*Target="([^"]+)"/g, m;
            while ((m = re.exec(x || ''))) map[m[1]] = 'xl/' + m[2].replace(/^\.\.\//, '');
            drawingRels[dp] = map;
          }));
        });
        return Promise.all(more);
      }).then(function () {
        var anchors = [];
        var more = [];
        Object.keys(sheetDrawing).forEach(function (sp) {
          var dp = sheetDrawing[sp];
          more.push(readText(dp).then(function (x) {
            // 有些工具產生的 xlsx 不用 xdr: 前綴，寫死前綴會一張圖都找不到
            var re = /<(?:\w+:)?(?:two|one)CellAnchor[\s\S]*?<\/(?:\w+:)?(?:two|one)CellAnchor>/g, m;
            while ((m = re.exec(x || ''))) {
              var block = m[0];
              var from = /<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/.exec(block);
              var embed = /(?:r|relationships):embed="([^"]+)"/.exec(block) || /embed="([^"]+)"/.exec(block);
              if (!from || !embed) continue;
              var col = /<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>/.exec(from[1]);
              var row = /<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/.exec(from[1]);
              var target = (drawingRels[dp] || {})[embed[1]];
              if (!target) continue;
              anchors.push({
                sheet: sp,
                row: row ? parseInt(row[1], 10) : 0,
                col: col ? parseInt(col[1], 10) : 0,
                media: target
              });
            }
          }));
        });
        return Promise.all(more).then(function () { return anchors; });
      }).then(function (anchors) {
        // 對位：從錨點往下往旁邊找，第一個像素材名的就是它
        var OFFSETS = [];
        for (var dr = -3; dr <= 8; dr++) for (var dc = -3; dc <= 4; dc++) OFFSETS.push([dr, dc]);
        OFFSETS.sort(function (a, b) { return (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])); });

        var matched = [], unmatched = 0;
        anchors.forEach(function (a) {
          var cells = sheets[a.sheet] || {};
          var best = null, bestScore = 0, fallback = null;
          for (var i = 0; i < OFFSETS.length; i++) {
            var v = cells[(a.row + OFFSETS[i][0]) + ',' + (a.col + OFFSETS[i][1])];
            var sc = nameScore(v);
            if (sc === 2) { best = String(v).trim(); bestScore = 2; break; }
            if (sc === 1 && !fallback) fallback = String(v).trim();
          }
          var name = best || fallback;
          if (name) matched.push({ name: name, media: a.media, loose: bestScore !== 2 });
          else unmatched++;
        });

        // 讀出圖片位元組
        var seen = {};
        var reads = matched.map(function (item) {
          var f = zip.file(item.media);
          if (!f) return Promise.resolve(null);
          return f.async('uint8array').then(function (bytes) {
            var h = hashBytes(bytes);
            var ext = (item.media.split('.').pop() || 'png').toLowerCase();
            var mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                     : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
            return {
              name: item.name,
              hash: h,
              ext: ext === 'jpeg' ? 'jpg' : ext,
              blob: new Blob([bytes], { type: mime }),
              duplicate: !!seen[h] || (seen[h] = false)
            };
          });
        });

        return Promise.all(reads).then(function (list) {
          var mediaFiles = Object.keys(zip.files).filter(function (p) { return /^xl\/media\//.test(p); });
          var sample = [];
          if (anchors.length) {
            var a0 = anchors[0], c0 = sheets[a0.sheet] || {};
            for (var dr = -3; dr <= 8; dr++) {
              for (var dc = -3; dc <= 4; dc++) {
                var v = c0[(a0.row + dr) + ',' + (a0.col + dc)];
                if (v) sample.push('(' + (a0.row + dr + 1) + ',' + (a0.col + dc + 1) + ') ' + String(v).slice(0, 40));
              }
            }
          }
          return {
            images: list.filter(Boolean),
            matchedCount: matched.length,
            looseCount: matched.filter(function (m) { return m.loose; }).length,
            unmatched: unmatched,
            totalAnchors: anchors.length,
            diag: {
              sheets: Object.keys(sheets),
              drawings: Object.keys(sheetDrawing).length,
              mediaFiles: mediaFiles.length,
              firstAnchor: anchors.length ? (anchors[0].row + 1) + ' 列 ' + (anchors[0].col + 1) + ' 欄' : '無',
              nearbyCells: sample.slice(0, 25)
            }
          };
        });
      });
    });
  }

  /* 上傳並寫回素材主檔 */
  // opts.target: 'materials'（預設）或 'market'
  // 競品的圖沒有競品名可推，所以用已匯入的競品清單反查
  function uploadAll(result, onProgress, opts) {
    opts = opts || {};
    var images = result.images;
    var uploadedByHash = {};
    var rows = [];
    var done = 0;
    var chain = Promise.resolve();

    images.forEach(function (img) {
      chain = chain.then(function () {
        var pre = uploadedByHash[img.hash];
        var p = pre ? Promise.resolve(pre)
                    : Cloud.uploadImage(img.blob, img.hash, img.ext).then(function (url) {
                        uploadedByHash[img.hash] = url; return url;
                      });
        return p.then(function (url) {
          var key = Data.materialKey(img.name);
          if (opts.target === 'market') {
            var comp = (opts.competitorByKey || {})[key];
            if (comp) {
              rows.push({ competitor: comp, material_key: key, material_name: img.name,
                          image_url: url, image_hash: img.hash });
            }
          } else {
            rows.push({ material_key: key, material_name: img.name,
                        image_url: url, image_hash: img.hash });
          }
          done++;
          if (onProgress) onProgress(done, images.length);
        });
      });
    });

    return chain.then(function () {
      var uniq = {}, out = [];
      rows.forEach(function (r) { uniq[(r.competitor || '') + '|' + r.material_key] = r; });
      Object.keys(uniq).forEach(function (k) { out.push(uniq[k]); });
      if (!out.length) return 0;
      var save = opts.target === 'market' ? Cloud.saveMarket(out) : Cloud.saveMaterials(out);
      return save.then(function () { return out.length; });
    });
  }

  global.Images = { extract: extract, uploadAll: uploadAll };
})(window);
