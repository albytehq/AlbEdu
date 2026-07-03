// =============================================================================
// boot.js — AlbEdu Shared Layer · Page Boot Orchestrator
// =============================================================================
// Single responsibility: define and enforce the canonical page boot order
// across every page in the app. Eliminates the per-page chaos of mixed
// defer/module/inline scripts with different load orders.
//
// Boot contract (every page MUST follow):
//
//   1. <head> — CRITICAL (synchronous, tiny):
//        <script src="src/shared/head/critical-css.js"></script>
//        → injects critical CSS inline + applies saved theme
//
//   2. <head> — DEFERRED (parallel fetch, runs after parse):
//        <script defer src="src/shared/head/fonts.js"></script>
//        <script defer src="src/shared/icons/icons.js"></script>
//        <script defer src="src/platform/supabase-client.js"></script>
//        <script defer src="src/platform/repository.js"></script>
//        <script defer src="src/security/sanitize.js"></script>
//        <script defer src="src/shared/boot.js"></script>
//        → these all run in order, AFTER HTML parse, BEFORE DOMContentLoaded
//
//   3. <head> — ASYNC (totally non-blocking, may run anytime):
//        <script async src="...turnstile..."></script>
//        <script async src="...supabase-sdk-cdn..."></script>
//        → these may load at any time; the platform layer polls for them
//
//   4. <body> end — PAGE-SPECIFIC (defer or type=module):
//        Page controllers wait for AlbEdu.boot.ready, then run.
//
// This file exposes AlbEdu.boot, a tiny orchestrator that:
//   - Tracks when the shell is ready (DOMContentLoaded)
//   - Tracks when the platform (supabase) is ready
//   - Provides AlbEdu.boot.ready — a Promise that resolves when both are done
//   - Provides AlbEdu.boot.whenReady(cb) — convenience wrapper
//
// Page controllers and feature modules should await AlbEdu.boot.ready
// before initializing. This guarantees deterministic order without
// fragile setTimeout races.
// =============================================================================

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
    document.addEventListener('albedu:platform-ready', function () { resolve(); }, { once: true });
    document.addEventListener('albedu:platform-error', function (e) {
      reject(new Error(e?.detail?.message || 'platform bootstrap failed'));
    }, { once: true });
  });

  var ready = Promise.all([domReady, platformReady]).then(function () { return true; });

  // ── Public API ─────────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.boot = {
    /** Resolves when DOM is parsed + platform (supabase) is bootstrapped. */
    ready: ready,
    /** Convenience wrapper for non-Promise consumers. */
    whenReady: function (cb) { ready.then(cb).catch(function () {}); return ready; },
    /** Resolves when DOM is parsed (doesn't wait for supabase). */
    domReady: domReady,
    /** Resolves when supabase is bootstrapped (doesn't wait for DOM). */
    platformReady: platformReady,
    /** Sync getter — true if everything is ready. */
    isReady: function () {
      return document.readyState !== 'loading' &&
             !!(window.AlbEdu && window.AlbEdu.supabase && window.AlbEdu.supabase.isReady());
    },
    /** Sync getter — boot start timestamp (set by critical-css.js). */
    bootStart: function () { return window.AlbEdu.bootStart || 0; },
  };
})();
