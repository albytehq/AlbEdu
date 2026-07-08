// loader.js — schedules icon binding to minimize impact on first paint and
// interactive time. critical-css.js injects the sprite synchronously, then
// icons.js (deferred) binds visible icons immediately, defers off-screen
// binding to IntersectionObserver, and preloads secondary icons into the
// cache during requestIdleCallback.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconLoader) return;

  var _ric = window.requestIdleCallback || function (cb) {
    // Polyfill: defer to next frame if requestIdleCallback unavailable.
    var start = Date.now();
    return setTimeout(function () {
      cb({
        didTimeout: false,
        timeRemaining: function () { return Math.max(0, 50 - (Date.now() - start)); },
      });
    }, 1);
  };
  var _cancelRic = window.cancelIdleCallback || function (id) { clearTimeout(id); };

  var _raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };

  // Schedule a callback when the browser is idle.
  function onIdle(cb, opts) {
    opts = opts || {};
    return _ric(cb, { timeout: opts.timeout || 2000 });
  }

  // Pre-render icons into the cache so subsequent renders are pure cloneNode.
  function preloadIcons(names) {
    if (!names || !names.length) return;
    var renderer = window.AlbEdu && window.AlbEdu.__iconRenderer;
    if (!renderer) return;

    onIdle(function () {
      for (var i = 0; i < names.length; i++) {
        try {
          // Render to cache (result discarded — we just want the cache populated)
          renderer.render(names[i], {});
        } catch (_) { /* swallow — preload is best-effort */ }
      }
    }, { timeout: 3000 });
  }

  // Pre-render the critical icons. They're usually already in the sprite,
  // but this warms the renderer cache for setIcon() calls.
  function preloadCriticalSet() {
    var sprite = window.AlbEdu && window.AlbEdu.__iconSprite;
    if (!sprite) return;
    preloadIcons(sprite.CRITICAL_NAMES);
  }

  // Pre-render the entire registry — useful for SPA navigation.
  function preloadAll() {
    var listFn = window.AlbEdu && window.AlbEdu.listIcons;
    if (!listFn) return;
    onIdle(function () {
      var names = listFn();
      preloadIcons(names);
    }, { timeout: 5000 });
  }

  // rAF for visual sync, then idle callback for the actual work — keeps
  // bind operations from blocking animation frames.
  function scheduleBind(fn) {
    if (typeof fn !== 'function') return;
    _raf(function () {
      onIdle(fn, { timeout: 1000 });
    });
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.__iconLoader = {
    onIdle: onIdle,
    preloadIcons: preloadIcons,
    preloadCriticalSet: preloadCriticalSet,
    preloadAll: preloadAll,
    scheduleBind: scheduleBind,
  };
})();
