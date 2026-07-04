// =============================================================================
// critical-css.js — AlbEdu Shared Head · Paint-First Shell
// =============================================================================
// Single responsibility: inject critical CSS inline into <head> BEFORE the
// browser fetches any external stylesheet. This guarantees the shell renders
// on the very first paint, even on slow networks.
//
// This script is the FIRST <script> in every page's <head>. It runs
// synchronously (no defer/async) and is tiny (~3KB minified) so it does not
// delay first paint materially.
//
// Why inline-injected instead of <style> in HTML:
//   - Single source of truth — update once here, every page gets the fix.
//   - No risk of HTML author forgetting to copy-paste the latest <style>.
//   - File is small enough that the inline cost is negligible.
//
// What this script does NOT do:
//   - Load fonts (handled by shared font strategy — see fonts.js)
//   - Load full design system (loaded async via tokens.css + page CSS)
// =============================================================================

(function () {
  'use strict';

  // Critical CSS is co-located with this script. We embed it inline so the
  // browser doesn't need to round-trip for it.
  // (Source: src/shared/head/critical.css — keep in sync.)

  // ── Compute BASE_PATH (deployment-prefix aware) ─────────────────────────
  // AlbEdu can be deployed at:
  //   - root domain (https://albedu.id/)
  //   - subdirectory (https://albytehq.github.io/AlbEdu/)
  //   - localhost (http://127.0.0.1:5500/)
  //
  // Font paths in @font-face MUST be prefixed with BASE_PATH so they resolve
  // correctly regardless of deployment location. Without this, fonts 404
  // when deployed to a subdirectory because `/public/fonts/...` resolves to
  // the domain root, not the app root.
  //
  // Algorithm mirrors AUTH_CONFIG.BASE_PATH in src/auth/main.js — keep in sync.
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
   icons.js will upgrade these to full registry on load (no-op if already rendered). */
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

  // ── Inject inline SVG sprite for CRITICAL icons ──
  // These 16 icons render INSTANTLY on first paint, before icons.js loads.
  // icons.js will skip re-binding elements that already contain an <svg> child.
  // Use in HTML: <span data-albedu-icon="login"></span>
  // → critical-css.js injects the sprite, then icons.js (deferred) materializes
  //   these 16 icons immediately via <use href="#i-...">. icons.js handles
  //   the remaining ~85 secondary icons via cached-template renderer.
  //
  // Critical icon set (16):
  //   menu, close, login, logout, person, person_add, manage_accounts,
  //   notifications, arrow_back, arrow_forward, chevron_right, chevron_left,
  //   search, home, language, refresh
  //
  // These cover ALL icons in the persistent app shell + auth gates.
  // Sourced from Lucide (ISC license). Keep in sync with
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
    + '</svg>';

  var spriteDiv = document.createElement('div');
  spriteDiv.innerHTML = SPRITE_SVG;
  var spriteEl = spriteDiv.firstChild;
  spriteEl.setAttribute('aria-hidden', 'true');
  document.head.appendChild(spriteEl);

  // ── Phase 1: Resource Hints (zero-risk performance optimization) ────
  // Inject <link> hints ke <head> SEBELUM browser parse <script src="https://...">
  // atau <script type="module" src="...">. Browser mulai resolve DNS + TLS
  // handshake + fetch module secara paralel, hemat 200-500ms perceived load.
  //
  // Affects: semua 27 halaman (critical-css.js di-load synchronously di <head>)
  // Risk:    ZERO — <link rel="preconnect">, dns-prefetch, modulepreload
  //          adalah pure hints. Browser ignore kalau tidak dibutuhkan.
  //          Tidak pernah block rendering.
  //
  // Strategy:
  //   1. preconnect  → start TLS handshake early (cdn.jsdelivr.net, cloudflare)
  //   2. dns-prefetch → fallback DNS-only (untuk browser lama tanpa preconnect)
  //   3. modulepreload → fetch + parse ESM module sebelum <script type="module">
  //
  // Idempotent: skip kalau hint sudah ada di <head> (defensive — HTML mungkin
  // sudah deklarasi manual di beberapa halaman).

  function _injectHint(rel, href, attrs) {
    // Cek existing — selector pakai attribute value match
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
          // crossorigin: true → set attribute empty string (spec requirement)
          link.setAttribute(key, attrs[key] === true ? '' : attrs[key]);
        }
      }
    }
    document.head.appendChild(link);
  }

  // 1. External CDN preconnect — start DNS + TCP + TLS handshake early.
  //    cdn.jsdelivr.net: dipakai di 15+ halaman (Supabase SDK, KaTeX)
  //    challenges.cloudflare.com: dipakai di 4 halaman auth (Turnstile)
  _injectHint('preconnect', 'https://cdn.jsdelivr.net', { crossorigin: true });
  _injectHint('preconnect', 'https://challenges.cloudflare.com', { crossorigin: true });

  // 2. DNS-prefetch — fallback untuk browser yang tidak support preconnect
  //    (Safari < 11, IE). Zero cost di browser modern.
  _injectHint('dns-prefetch', 'https://cdn.jsdelivr.net');
  _injectHint('dns-prefetch', 'https://challenges.cloudflare.com');

  // 3. Modulepreload — fetch + parse ESM module sebelum <script type="module">
  //    tercapai oleh HTML parser. Critical path: resilience.js load Actly
  //    transitively (15 file ESM). Tanpa modulepreload, browser baru mulai
  //    fetch resilience.js setelah parse selesai — hemat 100-300ms.
  //
  //    resilience.js dipakai di 19/27 halaman (admin + auth + assessment).
  //    qnotify-loader.js hanya di admin/assessment pages — skip global preload
  //    untuk avoid waste di landing/auth pages yang tidak pakai QNotify.
  //
  //    Trade-off: 8 halaman kecil (404, docs/PAGE-TEMPLATE, legacy stubs
  //    buat-ujian/data-hasil/ujian-peserta, pages/ujian/*) tidak load
  //    resilience.js tapi tetap dapat modulepreload → waste ~8KB prefetch.
  //    Acceptable karena: (a) halaman tersebut jarang dikunjungi,
  //    (b) file di-cache SW setelah prefetch pertama, (c) cost kompleksitas
  //    deteksi runtime (cek document.scripts saat critical-css.js execute
  //    tidak work — script tags setelahnya belum di-DOM) lebih tinggi dari
  //    benefit ~64KB total waste (8KB × 8 halaman, tapi cuma sekali per SW
  //    cache lifetime).
  _injectHint('modulepreload', BASE_PATH + 'src/shared/resilience.js');

  // ── Phase 2: Inject view-transitions.js (deferred, non-blocking) ─────
  // File ini intercept clicks pada internal <a href> dan wrap navigasi
  // dengan document.startViewTransition() untuk cross-fade halus antar
  // halaman. Progressive enhancement — browser tanpa support tetap jalan.
  //
  // Pakai <script defer> supaya:
  //   - Tidak block HTML parsing (defer = download parallel, execute setelah parse)
  //   - Jalan sebelum DOMContentLoaded (catch clicks awal)
  //   - Idempotent — file punya guard sendiri
  var vtScript = document.createElement('script');
  vtScript.src = BASE_PATH + 'src/shared/view-transitions.js';
  vtScript.defer = true;
  document.head.appendChild(vtScript);

  // ── Phase 3: Inject link-prefetch.js (deferred, non-blocking) ────────
  // File ini prefetch halaman tujuan SEBELUM user klik, supaya saat klik
  // terjadi halaman sudah ada di browser cache → instant load.
  //
  // 3 mode prefetch:
  //   1. Viewport prefetch — saat link masuk viewport (200px margin), prefetch
  //   2. Hover/focus prefetch — saat user hover/focus link (intent-based)
  //   3. Touchstart prefetch — mobile, manfaatkan 300ms delay sebelum click
  //
  // Co-exist dengan Phase 2 (VT):
  //   Prefetch fetch HTML ke cache. VT handle animasi cross-fade.
  //   Kombinasi: instant + animated = native feel.
  //
  // Safety: skip external/anchor/javascript links, dedup via Set,
  //         respect prefers-reduced-data (navigator.connection.saveData).
  var prefetchScript = document.createElement('script');
  prefetchScript.src = BASE_PATH + 'src/shared/link-prefetch.js';
  prefetchScript.defer = true;
  document.head.appendChild(prefetchScript);

  // ── Phase 4: Inject page-transition-overlay.js (deferred, non-blocking)
  // Loading overlay fallback untuk browser tanpa VT support (Firefox/Safari
  // lama) + loading indicator untuk slow navigation (>500ms).
  //
  // Strategy:
  //   - Browser DENGAN VT: overlay TIDAK muncul (VT handle animasi)
  //   - Browser TANPA VT: overlay muncul kalau navigation > 500ms
  //   - Auto-hide di pageshow event (handle bfcache restore juga)
  //   - Safety timeout 8 detik (avoid stuck overlay)
  //
  // Co-exist dengan Phase 2 (VT):
  //   Listen 'viewtransitionstart' event → cancel overlay timer.
  //   VT jalan → overlay skip. VT tidak support → overlay fallback.
  //
  // Co-exist dengan Phase 3 (Prefetch):
  //   Prefetch bikin navigation biasanya < 500ms → overlay jarang muncul.
  //   Tapi kalau network lambat, overlay jadi loading indicator.
  var overlayScript = document.createElement('script');
  overlayScript.src = BASE_PATH + 'src/shared/page-transition-overlay.js';
  overlayScript.defer = true;
  document.head.appendChild(overlayScript);

  // ── Apply saved theme IMMEDIATELY (prevents dark-mode flash) ──
  // This must run BEFORE the body renders. Reading localStorage is sync.
  try {
    var saved = localStorage.getItem('albedu-theme') || 'default';
    if (saved && saved !== 'default') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (_) { /* private mode */ }

  // ── Set <html lang> to Indonesian (single language) ─────────────────────
  document.documentElement.setAttribute('lang', 'id');
  document.documentElement.setAttribute('dir', 'ltr');

  // ── Mark platform as booting ──
  // Consumers can listen for 'albedu:platform-ready' to know when supabase is ready.
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.bootStart = performance.now();
})();
