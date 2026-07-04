// =============================================================================
// loader.js — AlbEdu Icon System · Lazy Loader + Idle Preloader
// =============================================================================
// Responsibility:
//   Coordinate WHEN icon binding happens to minimize impact on first paint
//   and interactive time.
//
// Loading strategy (enterprise-grade):
//
//   App Start (HTML parse begins)
//     ↓
//   critical-css.js (sync, in <head>)
//     ↓ injects inline sprite (16 critical icons available IMMEDIATELY)
//     ↓ injects critical CSS (shell paints)
//     ↓
//   First Paint (icons visible via <use href="#i-...">)
//     ↓
//   icons.js loads (deferred, ~10-30ms after parse)
//     ↓ runs _autoInit() — binds visible icons immediately
//     ↓
//   requestIdleCallback (after first interaction)
//     ↓ preload secondary icons into cache
//     ↓ bind off-screen icons via IntersectionObserver
//     ↓
//   User scrolls / dynamic content added
//     ↓ IntersectionObserver fires → bind on demand
//     ↓ MutationObserver fires → bind new content
//
// Public API (attached to window.AlbEdu.__iconLoader):
//   .onIdle(cb, opts)         → schedule callback when browser is idle
//   .preloadIcons(names)      → pre-render icons into cache (Layer 1)
//   .preloadCriticalSet()     → pre-render the 16 critical icons
//   .preloadAll()             → pre-render entire registry (warm cache)
//   .scheduleBind(fn)         → schedule a bind operation (rAF + idle)
// =============================================================================

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

  // ── Schedule a callback when the browser is idle ────────────────────
  function onIdle(cb, opts) {
    opts = opts || {};
    return _ric(cb, { timeout: opts.timeout || 2000 });
  }

  // ── Pre-render icons into the cache (Layer 1) ───────────────────────
  // This warms the cache so subsequent renders are pure cloneNode.
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

  // ── Pre-render the 16 critical icons ────────────────────────────────
  // (These are usually already in the sprite, but this populates the
  //  renderer cache for setIcon() calls.)
  function preloadCriticalSet() {
    var sprite = window.AlbEdu && window.AlbEdu.__iconSprite;
    if (!sprite) return;
    preloadIcons(sprite.CRITICAL_NAMES);
  }

  // ── Pre-render the entire registry (warm cache) ─────────────────────
  // Useful for SPA navigation — after this completes, every icon render
  // is a pure cache hit (~0.005ms per render).
  function preloadAll() {
    var listFn = window.AlbEdu && window.AlbEdu.listIcons;
    if (!listFn) return;
    onIdle(function () {
      var names = listFn();
      preloadIcons(names);
    }, { timeout: 5000 });
  }

  // ── Schedule a bind operation ───────────────────────────────────────
  // Uses rAF for visual sync, then idle callback for the actual work.
  // This prevents bind operations from blocking animation frames.
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
