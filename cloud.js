/* cloud.js — 跟 Supabase 講話：登入、讀資料、寫資料、離線處理 */
(function (global) {
  'use strict';

  var SUPABASE_URL = 'https://kldhlljoqpaqllmaptki.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_AMXqil_UgjXADag8U0VoCw_2nuMDYns';

  var PREFIX = 'mt2_';                 // v2 自己的暫存一律加前綴，絕不碰舊版的 key
  var CACHE_KEY = PREFIX + 'cache';
  var QUEUE_KEY = PREFIX + 'queue';

  if (!global.supabase || !global.supabase.createClient) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML =
        '<div style="padding:40px;font:15px/1.6 sans-serif">' +
        '<h1 style="font-size:20px;font-weight:500">連線元件沒有載入</h1>' +
        '<p>網路可能被擋住，或公司防火牆封鎖了 cdn.jsdelivr.net。' +
        '請換一個網路環境重新整理；若持續發生，需要請 IT 開放這個網域。</p></div>';
    });
    return;
  }

  var sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  var state = { online: navigator.onLine, user: null };
  var listeners = [];

  function emit(evt, payload) {
    listeners.forEach(function (fn) { try { fn(evt, payload); } catch (e) { console.error(e); } });
  }
  function on(fn) { listeners.push(fn); }

  /* ---------- 本機快取（開頁先畫，不等雲端） ---------- */
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch (e) { return null; }
  }
  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), data: data }));
    } catch (e) { console.warn('快取寫入失敗（可能空間已滿）', e); }
  }

  /* ---------- 離線佇列 ---------- */
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; }
  }
  function pushQueue(job) {
    var q = readQueue(); q.push(job);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    emit('queue', q.length);
  }
  function clearQueue() { localStorage.removeItem(QUEUE_KEY); emit('queue', 0); }

  function flushQueue() {
    var q = readQueue();
    if (!q.length || !state.online) return Promise.resolve(0);
    var chain = Promise.resolve();
    q.forEach(function (job) {
      chain = chain.then(function () { return upsert(job.table, job.rows, job.conflict); });
    });
    return chain.then(function () { clearQueue(); return q.length; })
                .catch(function (e) { console.error('補送失敗', e); return 0; });
  }

  /* ---------- 登入 ---------- */
  function signIn(email, password) {
    return sb.auth.signInWithPassword({ email: email, password: password })
      .then(function (r) {
        if (r.error) throw r.error;
        state.user = r.data.user;
        return r.data.user;
      });
  }
  function signOut() {
    return sb.auth.signOut().then(function () { state.user = null; });
  }
  function currentUser() {
    return sb.auth.getSession().then(function (r) {
      state.user = r.data.session ? r.data.session.user : null;
      return state.user;
    });
  }

  /* ---------- 讀 ---------- */
  function loadAll(sinceDate) {
    var jobs = [
      sb.from('materials').select('*').is('deleted_at', null),
      sb.from('material_daily').select('*').gte('stat_date', sinceDate).order('stat_date', { ascending: false }),
      sb.from('market_materials').select('*').is('deleted_at', null),
      sb.from('dimensions').select('*').is('deleted_at', null).order('sort_order'),
      sb.from('import_log').select('*').order('stat_date', { ascending: false }).limit(400)
    ];
    return Promise.all(jobs).then(function (res) {
      res.forEach(function (r) { if (r.error) throw r.error; });
      var data = {
        materials: res[0].data || [],
        daily: res[1].data || [],
        market: res[2].data || [],
        dimensions: res[3].data || [],
        importLog: res[4].data || []
      };
      writeCache(data);
      return data;
    });
  }

  function loadGaps() {
    return sb.from('v_import_gaps').select('*')
      .then(function (r) { return r.error ? [] : (r.data || []); });
  }

  /* ---------- 寫 ---------- */
  function upsert(table, rows, conflict) {
    if (!rows || !rows.length) return Promise.resolve([]);
    if (!state.online) {
      pushQueue({ table: table, rows: rows, conflict: conflict });
      return Promise.resolve([]);
    }
    var out = [];
    var CHUNK = 500;
    var chain = Promise.resolve();
    for (var i = 0; i < rows.length; i += CHUNK) {
      (function (slice) {
        chain = chain.then(function () {
          return sb.from(table).upsert(slice, { onConflict: conflict }).select()
            .then(function (r) {
              if (r.error) throw r.error;
              out = out.concat(r.data || []);
            });
        });
      })(rows.slice(i, i + CHUNK));
    }
    return chain.then(function () { return out; })
      .catch(function (e) {
        pushQueue({ table: table, rows: rows, conflict: conflict });
        throw e;
      });
  }

  function saveMaterials(rows) { return upsert('materials', rows, 'material_key'); }
  function saveDaily(rows) { return upsert('material_daily', rows, 'stat_date,material_key,channel'); }
  function saveImportLog(rows) { return upsert('import_log', rows, 'stat_date,channel,source'); }
  function saveDimensions(rows) { return upsert('dimensions', rows, 'layer,name'); }
  function saveMarket(rows) { return upsert('market_materials', rows, 'competitor,material_key'); }
  function saveSnapshot(row) {
    return sb.from('snapshots').insert(row).select().then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    });
  }
  function softDelete(table, id) {
    return sb.from(table).update({ deleted_at: new Date().toISOString() }).eq('id', id)
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return true;
      });
  }

  /* ---------- 圖片 ---------- */
  function uploadImage(fileOrBlob, hash, ext) {
    var path = hash + '.' + (ext || 'png');
    return sb.storage.from('material-images')
      .upload(path, fileOrBlob, { upsert: true, contentType: fileOrBlob.type || 'image/png' })
      .then(function () {
        return sb.storage.from('material-images').getPublicUrl(path).data.publicUrl;
      });
  }

  /* ---------- 連線狀態 ---------- */
  function setOnline(v) {
    if (state.online === v) return;
    state.online = v;
    document.body.classList.toggle('readonly', !v);
    emit('online', v);
    if (v) flushQueue().then(function (n) { if (n) emit('flushed', n); });
  }
  global.addEventListener('online', function () { setOnline(true); });
  global.addEventListener('offline', function () { setOnline(false); });

  global.Cloud = {
    sb: sb, state: state, on: on,
    signIn: signIn, signOut: signOut, currentUser: currentUser,
    loadAll: loadAll, loadGaps: loadGaps, readCache: readCache, writeCache: writeCache,
    saveMaterials: saveMaterials, saveDaily: saveDaily,
    saveImportLog: saveImportLog, saveDimensions: saveDimensions, saveSnapshot: saveSnapshot,
    saveMarket: saveMarket, softDelete: softDelete,
    uploadImage: uploadImage,
    queueLength: function () { return readQueue().length; },
    flushQueue: flushQueue, setOnline: setOnline, PREFIX: PREFIX
  };
})(window);
