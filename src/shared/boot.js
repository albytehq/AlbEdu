// boot.js — defines and enforces the canonical page boot order.
// Exposes AlbEdu.boot.ready (resolves when DOM is parsed + supabase is ready).

(function () {
  'use strict';

  if (window.AlbEdu && window.AlbEdu.boot) return; // idempotent

  var domReady = new Promise(function (resolve) {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
  });

  var platformReady = new Promise(function (resolve, reject) {
    if (window.AlbEdu && window.AlbEdu.supabase && window.AlbEdu.supabase.isReady()) {
      return resolve();
    }
    var settled = false;
    function onReady() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function onError(e) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(e?.detail?.message || 'platform bootstrap failed'));
    }
    function onTimeout() {
      if (settled) return;
      settled = true;
      cleanup();
      // Resolve optimistically so pages can attempt a degraded mode instead of hanging.
      console.warn('[boot] platform-ready timed out after 30s, continuing in degraded mode');
      resolve();
    }
    function cleanup() {
      document.removeEventListener('albedu:platform-ready', onReady);
      document.removeEventListener('albedu:platform-error', onError);
      if (timer) clearTimeout(timer);
    }
    document.addEventListener('albedu:platform-ready', onReady, { once: true });
    document.addEventListener('albedu:platform-error', onError, { once: true });
    var timer = setTimeout(onTimeout, 30000);
  });

  var ready = Promise.all([domReady, platformReady]).then(function () { return true; });

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.boot = {
    ready: ready,
    whenReady: function (cb) { ready.then(cb).catch(function () {}); return ready; },
    domReady: domReady,
    platformReady: platformReady,
    isReady: function () {
      return document.readyState !== 'loading' &&
             !!(window.AlbEdu && window.AlbEdu.supabase && window.AlbEdu.supabase.isReady());
    },
    bootStart: function () { return window.AlbEdu.bootStart || 0; },
  };
})();
