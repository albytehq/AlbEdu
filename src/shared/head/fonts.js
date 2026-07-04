// =============================================================================
// fonts.js — AlbEdu Shared Head · Self-Hosted Font Strategy (v2.0)
// =============================================================================
// Single responsibility: inject <link rel="preload"> hints for self-hosted
// font files so the browser starts fetching them IMMEDIATELY on first paint,
// in parallel with HTML parsing.
//
// === ARCHITECTURE (v2.0 — self-hosted, instant load) ===
//
// Previous version (v1.x): loaded fonts from Google Fonts CDN.
//   - 2 DNS lookups (fonts.googleapis.com + fonts.gstatic.com)
//   - 2 fetch roundtrips (CSS + woff2)
//   - ~200-800ms total on slow networks
//   - FOUT (Flash Of Unstyled Text) during font swap
//
// Current version (v2.0): self-hosted subsetted variable fonts.
//   - 0 DNS lookups (same origin)
//   - 0 CSS roundtrips (@font-face inlined in critical-css.js)
//   - Just 1 woff2 fetch per font (27KB Latin + 22KB Latin-ext = 49KB total)
//   - ~10-30ms total (same origin, no TLS handshake)
//   - font-display: swap (text visible immediately, swap when ready)
//
// Font files (self-hosted at {BASE_PATH}public/fonts/):
//   - plus-jakarta-sans-latin.woff2      (27 KB) — Latin subset (U+0000-00FF)
//   - plus-jakarta-sans-latin-ext.woff2  (22 KB) — Latin-ext (U+0100-02BA)
//   - jetbrains-mono-latin.woff2         (31 KB) — JetBrains Mono Latin
//
// @font-face declarations are INLINED in critical-css.js (no CSS roundtrip).
// This script just adds <link rel="preload"> hints so the browser knows to
// fetch the woff2 files ASAP — before the parser reaches the @font-face
// declaration in the injected <style>.
//
// === WHY preload (not just @font-face)? ===
//
// @font-face tells the browser "this font exists" but doesn't tell it "fetch
// it now". The browser only fetches the font when it encounters text that
// needs to be rendered with that font — which happens AFTER the CSS is
// parsed and the DOM is built.
//
// <link rel="preload"> tells the browser "fetch this NOW, in parallel with
// everything else". This moves the font fetch to the earliest possible
// moment — before HTML parsing even finishes.
//
// === DEPLOYMENT-AWARE PATHS ===
//
// AlbEdu can be deployed at root domain OR a subdirectory (e.g. GitHub Pages
// /AlbEdu/). Font paths MUST be prefixed with BASE_PATH so preload hints
// resolve correctly. Without this, fonts 404 in subdirectory deployments.
// =============================================================================

(function () {
  'use strict';

  // ── Compute BASE_PATH (deployment-prefix aware) ─────────────────────────
  // Same algorithm as critical-css.js and AUTH_CONFIG.BASE_PATH in main.js.
  // Required so preload hints resolve correctly when AlbEdu is deployed at
  // a subdirectory (e.g. https://albytehq.github.io/AlbEdu/).
  var _computeBasePath = function () {
    var p = window.location.pathname;
    var base = p.substring(0, p.lastIndexOf('/') + 1);
    var APP_SUBFOLDERS = [
      '/pages/admin/pages/', '/pages/assessment/', '/pages/ujian/',
      '/pages/admin/', '/pages/', '/admin/pages/', '/ujian/', '/admin/',
    ];
    for (var i = 0; i < APP_SUBFOLDERS.length; i++) {
      var idx = base.indexOf(APP_SUBFOLDERS[i]);
      if (idx !== -1) return base.substring(0, idx + 1);
    }
    return base || '/';
  };
  var BASE_PATH = _computeBasePath();

  // Font file paths (same origin — no DNS, no TLS).
  // Prefixed with BASE_PATH so they work in subdirectory deployments.
  var FONTS = [
    BASE_PATH + 'public/fonts/plus-jakarta-sans-latin.woff2',
    BASE_PATH + 'public/fonts/plus-jakarta-sans-latin-ext.woff2',
    BASE_PATH + 'public/fonts/jetbrains-mono-latin.woff2',
  ];

  // Inject preload hints. Idempotent — safe to call multiple times.
  for (var i = 0; i < FONTS.length; i++) {
    var href = FONTS[i];

    // Skip if already preloaded (avoid duplicate)
    var existing = document.querySelector(
      'link[rel="preload"][href="' + href + '"]'
    );
    if (existing) continue;

    var link = document.createElement('link');
    link.rel = 'preload';
    link.href = href;
    link.as = 'font';
    link.type = 'font/woff2';
    link.crossOrigin = 'anonymous';  // required for font preload
    document.head.appendChild(link);
  }
})();
