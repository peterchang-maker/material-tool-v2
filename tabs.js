/* tabs.js — 分頁切換。記住上次看的那一頁，重新整理不會跳回第一頁 */
(function (global) {
  'use strict';
  var KEY = 'mt2_tab';

  // 篩選條件只跟這幾頁有關，其他頁面不顯示，免得誤以為有套用
  var NEEDS_FILTER = { overview: 1, wall: 1, dims: 1, trend: 1 };

  function go(name) {
    var pages = document.querySelectorAll('.tabpage');
    var found = false;
    Array.prototype.forEach.call(pages, function (p) {
      var on = p.getAttribute('data-page') === name;
      p.hidden = !on;
      p.style.display = on ? '' : 'none';
      if (on) found = true;
    });
    if (!found) return go('overview');

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });

    var f = document.querySelector('.filters');
    if (f) f.style.display = NEEDS_FILTER[name] ? '' : 'none';

    try { localStorage.setItem(KEY, name); } catch (e) {}
    global.scrollTo(0, 0);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-tab')); });
    });
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    go(saved || 'overview');
  }

  global.Tabs = { go: go, init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
