// =============================================================================
// fonts.js — AlbEdu Shared Head · Single Font Strategy
// =============================================================================
// Single responsibility: load the app's fonts through ONE preconnect +
// ONE stylesheet request, instead of every page duplicating the link tags.
//
// Strategy:
//   - Plus Jakarta Sans (variable, swap) — primary body/UI font
//   - JetBrains Mono (swap) — code/numeric
//   - NO Material Symbols font — icons are SVG (see icons.js)
//   - NO @import — too slow and forces serial fetch
//
// This file is loaded as <script defer> in <head> AFTER critical-css.js.
// It injects the preconnect + stylesheet <link> tags. defer ensures it
// runs after HTML parse but before DOMContentLoaded — fonts begin
// fetching in parallel with the rest of the page.
//
// IMPORTANT: this script de-duplicates. If a page already has the font
// links (legacy), this script detects them and skips re-injection.
// =============================================================================

(function () {
  'use strict';

  var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap';

  // Skip if already loaded by legacy <link> tags — avoid duplicate fetch.
  var existing = document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
  var alreadyHas = false;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].href.indexOf('Plus+Jakarta') !== -1) {
      alreadyHas = true;
      break;
    }
  }
  if (alreadyHas) return;

  // Preconnect — must be early so the TLS handshake overlaps with CSS download
  var preconnect1 = document.createElement('link');
  preconnect1.rel = 'preconnect';
  preconnect1.href = 'https://fonts.googleapis.com';
  document.head.appendChild(preconnect1);

  var preconnect2 = document.createElement('link');
  preconnect2.rel = 'preconnect';
  preconnect2.href = 'https://fonts.gstatic.com';
  preconnect2.crossOrigin = 'anonymous';
  document.head.appendChild(preconnect2);

  // The stylesheet itself — font-display: swap means text renders immediately
  // with system fallback, swaps to Plus Jakarta Sans when ready (no FOIT).
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  link.media = 'all';
  document.head.appendChild(link);
})();
