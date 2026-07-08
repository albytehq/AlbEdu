// critical-css.js — injects critical CSS + inline SVG sprite into <head>
// BEFORE the browser fetches any external stylesheet. Runs synchronously
// (no defer/async) as the FIRST <script> in <head>, so the shell paints on
// first paint even on slow networks.
//
// @font-face declarations are inlined here too — no CSS roundtrip needed.

(function () {
  'use strict';

  // Compute BASE_PATH (deployment-prefix aware). AlbEdu can be deployed at
  // the root domain OR at a subdirectory (for example, GitHub Pages /AlbEdu/).
  // Font paths in @font-face MUST be prefixed so they resolve in both.
  // Mirrors AUTH_CONFIG.BASE_PATH in src/auth/main.js — keep in sync.
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
  var FONT_DIR = BASE_PATH + 'public/fonts/';

  var CRITICAL_CSS = `
:root{--albedu-blue-600:#2563eb;--albedu-blue-700:#1d4ed8;--albedu-slate-50:#f8fafc;--albedu-slate-100:#f1f5f9;--albedu-slate-200:#e2e8f0;--albedu-slate-500:#64748b;--albedu-slate-700:#334155;--albedu-slate-900:#0f172a;--albedu-white:#fff;--albedu-red-600:#dc2626;--albedu-emerald-600:#059669;--albedu-amber-500:#f59e0b;--albedu-font-sans:'Plus Jakarta Sans',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif;--albedu-font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,Monaco,Consolas,monospace;--albedu-skeleton-base:#e2e8f0;--albedu-skeleton-shine:#f1f5f9}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url(${FONT_DIR}plus-jakarta-sans-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url(${FONT_DIR}plus-jakarta-sans-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 600;font-display:swap;src:url(${FONT_DIR}jetbrains-mono-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:var(--albedu-font-sans);font-size:14px;line-height:1.5;color:var(--albedu-slate-900);background:var(--albedu-slate-50);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeSpeed}img,svg{display:block;max-width:100%}button{font:inherit;cursor:pointer}a{color:inherit;text-decoration:none}
.albedu-shell{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
.albedu-shell__header{height:56px;background:var(--albedu-white);border-bottom:1px solid var(--albedu-slate-200);display:flex;align-items:center;padding:0 16px;gap:12px;position:sticky;top:0;z-index:10}
.albedu-shell__brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--albedu-slate-900)}.albedu-shell__brand img{width:28px;height:28px}
.albedu-shell__main{flex:1;padding:16px;max-width:1280px;width:100%;margin:0 auto}
.albedu-shell__footer{padding:12px 16px;border-top:1px solid var(--albedu-slate-200);color:var(--albedu-slate-500);font-size:12px;text-align:center}
.albedu-skeleton{background:var(--albedu-skeleton-base);border-radius:6px;position:relative;overflow:hidden}.albedu-skeleton::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--albedu-skeleton-shine),transparent);animation:albedu-skeleton-shimmer 1.6s infinite}@keyframes albedu-skeleton-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}@media(prefers-reduced-motion:reduce){.albedu-skeleton::after{animation:none}}
.albedu-loading{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--albedu-slate-50);gap:16px;padding:24px}.albedu-loading__logo{width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:var(--albedu-blue-600);border-radius:12px;color:#fff;font-weight:800;font-size:20px;letter-spacing:-0.02em}.albedu-loading__spinner{width:28px;height:28px;border:3px solid var(--albedu-slate-200);border-top-color:var(--albedu-blue-600);border-radius:50%;animation:albedu-spin 0.8s linear infinite}@keyframes albedu-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.albedu-loading__spinner{animation:none;border-top-color:var(--albedu-slate-500)}}.albedu-loading__text{color:var(--albedu-slate-500);font-size:13px;font-weight:500;margin:0}
.albedu-icon{display:inline-block;width:1em;height:1em;vertical-align:-0.15em;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.albedu-icon--16{width:16px;height:16px}.albedu-icon--20{width:20px;height:20px}.albedu-icon--24{width:24px;height:24px}
/* Inline SVG sprite for critical icons — renders INSTANTLY without waiting for icons.js.
   Use: <svg class="albedu-icon"><use href="#i-login"/></svg>
   icons.js upgrades these to full registry on load (no-op if already rendered). */
.albedu-sprite{position:absolute;width:0;height:0;overflow:hidden;visibility:hidden}
.albedu-cloak{visibility:hidden!important}.albedu-cloak--ready{visibility:visible!important}
.albedu-skip-link{position:absolute;top:-40px;left:8px;background:var(--albedu-blue-600);color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;z-index:1000;transition:top 0.15s ease}.albedu-skip-link:focus{top:8px;outline:2px solid var(--albedu-blue-700);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}
html[data-theme="dark"]{--albedu-slate-50:#0f172a;--albedu-slate-100:#1e293b;--albedu-slate-200:#334155;--albedu-slate-500:#94a3b8;--albedu-slate-700:#cbd5e1;--albedu-slate-900:#f1f5f9;--albedu-white:#1e293b;--albedu-skeleton-base:#334155;--albedu-skeleton-shine:#475569}html[data-theme="dark"] body{background:var(--albedu-slate-50);color:var(--albedu-slate-900)}html[data-theme="dark"] .albedu-shell__header{background:var(--albedu-white)}html[data-theme="dark"] .albedu-loading{background:var(--albedu-slate-50)}
`;

  var style = document.createElement('style');
  style.setAttribute('data-albedu-critical', '');
  style.textContent = CRITICAL_CSS;
  document.head.appendChild(style);

  // Inline SVG sprite: 33 critical icons (16 shell + 17 admin). These render
  // on first paint via <use href="#i-...">, before icons.js loads. icons.js
  // will skip elements that already have an <svg> child.
  // Lucide (ISC license). Keep in sync with
  // src/shared/icons/modules/sprite/sprite.js CRITICAL_ICONS.
  var SPRITE_SVG = '<svg class="albedu-sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" id="albedu-icon-sprite">'
    + '<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/></symbol>'
    + '<symbol id="i-close" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></symbol>'
    + '<symbol id="i-login" viewBox="0 0 24 24"><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></symbol>'
    + '<symbol id="i-logout" viewBox="0 0 24 24"><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></symbol>'
    + '<symbol id="i-person" viewBox="0 0 24 24"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></symbol>'
    + '<symbol id="i-person_add" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></symbol>'
    + '<symbol id="i-manage_accounts" viewBox="0 0 24 24"><path d="M10 15H6a4 4 0 0 0-4 4v2"/><path d="m14.305 16.53.923-.382"/><path d="m15.228 13.852-.923-.383"/><path d="m16.852 12.228-.383-.923"/><path d="m16.852 17.772-.383.924"/><path d="m19.148 12.228.383-.923"/><path d="m19.53 18.696-.382-.924"/><path d="m20.772 13.852.924-.383"/><path d="m20.772 16.148.924.383"/><circle cx="18" cy="15" r="3"/><circle cx="9" cy="7" r="4"/></symbol>'
    + '<symbol id="i-notifications" viewBox="0 0 24 24"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></symbol>'
    + '<symbol id="i-arrow_back" viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></symbol>'
    + '<symbol id="i-arrow_forward" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></symbol>'
    + '<symbol id="i-chevron_right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol>'
    + '<symbol id="i-chevron_left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></symbol>'
    + '<symbol id="i-search" viewBox="0 0 24 24"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></symbol>'
    + '<symbol id="i-home" viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>'
    + '<symbol id="i-language" viewBox="0 0 24 24"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></symbol>'
    + '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></symbol>'
    + '<symbol id="i-account_circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/></symbol>'
    + '<symbol id="i-edit_note" viewBox="0 0 24 24"><path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/></symbol>'
    + '<symbol id="i-menu_book" viewBox="0 0 24 24"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/></symbol>'
    + '<symbol id="i-inventory_2" viewBox="0 0 24 24"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></symbol>'
    + '<symbol id="i-monitor_heart" viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></symbol>'
    + '<symbol id="i-bar_chart" viewBox="0 0 24 24"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></symbol>'
    + '<symbol id="i-list" viewBox="0 0 24 24"><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></symbol>'
    + '<symbol id="i-fingerprint" viewBox="0 0 24 24"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></symbol>'
    + '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></symbol>'
    + '<symbol id="i-schedule" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></symbol>'
    + '<symbol id="i-shield" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></symbol>'
    + '<symbol id="i-photo_camera" viewBox="0 0 24 24"><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/></symbol>'
    + '<symbol id="i-left_panel_open" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></symbol>'
    + '<symbol id="i-left_panel_close" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></symbol>'
    + '<symbol id="i-assignment_turned_in" viewBox="0 0 24 24"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m9 15 2 2 4-4"/></symbol>'
    + '<symbol id="i-auto_fix_high" viewBox="0 0 24 24"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></symbol>'
    + '</svg>';

  var spriteDiv = document.createElement('div');
  spriteDiv.innerHTML = SPRITE_SVG;
  var spriteEl = spriteDiv.firstChild;
  spriteEl.setAttribute('aria-hidden', 'true');
  document.head.appendChild(spriteEl);

  // Resource hints. <link rel="preconnect"> + dns-prefetch + modulepreload
  // let the browser start DNS/TLS/module-fetch in parallel with HTML parse.
  // Pure hints — zero risk, browser ignores when not needed.
  function _injectHint(rel, href, attrs) {
    var existing = document.querySelector(
      'link[rel="' + rel + '"][href="' + href + '"]'
    );
    if (existing) return;
    var link = document.createElement('link');
    link.setAttribute('rel', rel);
    link.setAttribute('href', href);
    if (attrs) {
      for (var key in attrs) {
        if (attrs[key]) {
          // crossorigin: true → set attribute to empty string (spec requirement)
          link.setAttribute(key, attrs[key] === true ? '' : attrs[key]);
        }
      }
    }
    document.head.appendChild(link);
  }

  _injectHint('preconnect', 'https://cdn.jsdelivr.net', { crossorigin: true });
  _injectHint('preconnect', 'https://challenges.cloudflare.com', { crossorigin: true });
  _injectHint('dns-prefetch', 'https://cdn.jsdelivr.net');
  _injectHint('dns-prefetch', 'https://challenges.cloudflare.com');

  // Modulepreload resilience.js — it's loaded on 19/27 pages and pulls in
  // Actly transitively (15 ESM files). Without this the browser only starts
  // fetching after the parser reaches the <script type="module"> tag.
  _injectHint('modulepreload', BASE_PATH + 'src/shared/resilience.js');

  // Inject view-transitions.js (deferred). Cross-fades internal-link clicks
  // via document.startViewTransition(). No-op in browsers without the API.
  var vtScript = document.createElement('script');
  vtScript.src = BASE_PATH + 'src/shared/view-transitions.js';
  vtScript.defer = true;
  document.head.appendChild(vtScript);

  // Inject link-prefetch.js (deferred). Prefetches destination pages on
  // viewport-enter / hover / focus / touchstart.
  var prefetchScript = document.createElement('script');
  prefetchScript.src = BASE_PATH + 'src/shared/link-prefetch.js';
  prefetchScript.defer = true;
  document.head.appendChild(prefetchScript);

  // Inject page-transition-overlay.js (deferred). Loading overlay for
  // browsers without VT support + slow-network fallback. Auto-hides on
  // pageshow. Listens for 'viewtransitionstart' to cancel its timer when VT
  // takes over.
  var overlayScript = document.createElement('script');
  overlayScript.src = BASE_PATH + 'src/shared/page-transition-overlay.js';
  overlayScript.defer = true;
  document.head.appendChild(overlayScript);

  // Apply saved theme BEFORE body renders — prevents dark-mode flash.
  // Reading localStorage is sync.
  try {
    var saved = localStorage.getItem('albedu-theme') || 'default';
    if (saved && saved !== 'default') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (_) { /* private mode */ }

  document.documentElement.setAttribute('lang', 'id');
  document.documentElement.setAttribute('dir', 'ltr');

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.bootStart = performance.now();
})();
