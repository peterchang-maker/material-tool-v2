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

  function looksLikeMaterial(s) {
    return typeof s === 'string' && s.length >= 5 && s.indexOf('_') > 0 && !/^https?:/i.test(s);
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
            var re = /<xdr:(?:two|one)CellAnchor[\s\S]*?<\/xdr:(?:two|one)CellAnchor>/g, m;
            while ((m = re.exec(x || ''))) {
              var block = m[0];
              var from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(block);
              var embed = /r:embed="([^"]+)"/.exec(block);
              if (!from || !embed) continue;
              var col = /<xdr:col>(\d+)<\/xdr:col>/.exec(from[1]);
              var row = /<xdr:row>(\d+)<\/xdr:row>/.exec(from[1]);
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
        for (var dr = 0; dr <= 6; dr++) for (var dc = -2; dc <= 3; dc++) OFFSETS.push([dr, dc]);
        OFFSETS.sort(function (a, b) { return (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])); });

        var matched = [], unmatched = 0;
        anchors.forEach(function (a) {
          var cells = sheets[a.sheet] || {};
          var name = null;
          for (var i = 0; i < OFFSETS.length; i++) {
            var v = cells[(a.row + OFFSETS[i][0]) + ',' + (a.col + OFFSETS[i][1])];
            if (looksLikeMaterial(v)) { name = v; break; }
          }
          if (name) matched.push({ name: name, media: a.media });
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
          return {
            images: list.filter(Boolean),
            matchedCount: matched.length,
            unmatched: unmatched,
            totalAnchors: anchors.length
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
