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
//   - Initialize auth/i18n/analytics (all deferred until after paint)
// =============================================================================

(function () {
  'use strict';

  // Critical CSS is co-located with this script. We embed it inline so the
  // browser doesn't need to round-trip for it.
  // (Source: src/shared/head/critical.css — keep in sync.)

  var CRITICAL_CSS = `
:root{--albedu-blue-600:#2563eb;--albedu-blue-700:#1d4ed8;--albedu-slate-50:#f8fafc;--albedu-slate-100:#f1f5f9;--albedu-slate-200:#e2e8f0;--albedu-slate-500:#64748b;--albedu-slate-700:#334155;--albedu-slate-900:#0f172a;--albedu-white:#fff;--albedu-red-600:#dc2626;--albedu-emerald-600:#059669;--albedu-amber-500:#f59e0b;--albedu-font-sans:'Plus Jakarta Sans',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif;--albedu-font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,Monaco,Consolas,monospace;--albedu-skeleton-base:#e2e8f0;--albedu-skeleton-shine:#f1f5f9}
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
.albedu-cloak{visibility:hidden!important}.albedu-cloak--ready{visibility:visible!important}
.albedu-skip-link{position:absolute;top:-40px;left:8px;background:var(--albedu-blue-600);color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;z-index:1000;transition:top 0.15s ease}.albedu-skip-link:focus{top:8px;outline:2px solid var(--albedu-blue-700);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}
html[data-theme="dark"]{--albedu-slate-50:#0f172a;--albedu-slate-100:#1e293b;--albedu-slate-200:#334155;--albedu-slate-500:#94a3b8;--albedu-slate-700:#cbd5e1;--albedu-slate-900:#f1f5f9;--albedu-white:#1e293b;--albedu-skeleton-base:#334155;--albedu-skeleton-shine:#475569}html[data-theme="dark"] body{background:var(--albedu-slate-50);color:var(--albedu-slate-900)}html[data-theme="dark"] .albedu-shell__header{background:var(--albedu-white)}html[data-theme="dark"] .albedu-loading{background:var(--albedu-slate-50)}
`;

  var style = document.createElement('style');
  style.setAttribute('data-albedu-critical', '');
  style.textContent = CRITICAL_CSS;
  document.head.appendChild(style);

  // ── Apply saved theme IMMEDIATELY (prevents dark-mode flash) ──
  // This must run BEFORE the body renders. Reading localStorage is sync.
  try {
    var saved = localStorage.getItem('albedu-theme') || 'default';
    if (saved && saved !== 'default') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (_) { /* private mode */ }

  // ── Mark platform as booting ──
  // Consumers can listen for 'albedu:platform-ready' to know when supabase is ready.
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.bootStart = performance.now();
})();
