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
// Font files (self-hosted at /public/fonts/):
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
// Combined with @font-face in critical CSS, the timeline becomes:
//   0ms   — HTML parser sees <link rel="preload"> → starts woff2 fetch
//   2ms   — critical-css.js injects @font-face (browser knows about font)
//   5ms   — text renders with system fallback (font-display: swap)
//   15ms  — woff2 arrives (27KB, same origin) → font swaps
//   15ms  — user sees Plus Jakarta Sans
//
// Without preload:
//   0ms   — HTML parser starts
//   2ms   — critical-css.js injects @font-face
//   5ms   — text renders with system fallback
//   10ms  — DOM built, browser realizes it needs the font → starts fetch
//   25ms  — woff2 arrives → font swaps
//
// Preload saves ~10ms on fast connections, ~100ms+ on slow ones.
// =============================================================================

(function () {
  'use strict';

  // Font file paths (same origin — no DNS, no TLS)
  var FONTS = [
    '/public/fonts/plus-jakarta-sans-latin.woff2',
    '/public/fonts/plus-jakarta-sans-latin-ext.woff2',
    '/public/fonts/jetbrains-mono-latin.woff2',
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
