// =============================================================================
// sprite.js — AlbEdu Icon System · Inline SVG Sprite Manager
// =============================================================================
// Responsibility:
//   Build and inject the inline SVG sprite containing all CRITICAL icons.
//   The sprite is injected into <head> BEFORE first paint, so critical
//   icons render instantly via `<use href="#i-NAME">` — zero JS execution,
//   zero network requests.
//
// Architecture:
//   critical-css.js (sync, in <head>)
//     └─ injects sprite DOM (16 <symbol> elements)
//     └─ injects inline style for .albedu-sprite (hidden)
//
//   HTML pages use:
//     <span data-albedu-icon="login"></span>
//
//   icons.js (deferred) upgrades them:
//     1. For critical icons: <svg><use href="#i-login"/></svg> (instant)
//     2. For non-critical icons: full <svg>...</svg> (cached template)
//
// Why <symbol> + <use>?
//   - <symbol> is the SVG2 standard for reusable shapes.
//   - <use> clones the symbol at render time — browser-native cloneNode.
//   - Single source of truth: the sprite defines the icon once.
//   - Instant render: no JS, no string parse, no DOM mutation beyond <use>.
//
// Critical Icons (16):
//   The set is chosen to cover ALL icons that appear in the persistent
//   application shell (navbar, sidebar, header, footer, auth gates).
//   These icons must render before first paint to avoid any flash.
//
//   menu, close, login, logout, person, person_add, manage_accounts,
//   notifications, arrow_back, arrow_forward, chevron_right, chevron_left,
//   search, home, language, refresh
//
// Public API (attached to window.AlbEdu.__iconSprite):
//   .CRITICAL_ICONS      → array of critical icon names
//   .isCritical(name)    → boolean
//   .buildSpriteSvg()    → string (full <svg>...</svg> for injection)
//   .buildUseHtml(name, opts) → string (e.g. '<svg class="albedu-icon" ...><use href="#i-login"/></svg>')
//   .injectInto(doc)     → void (idempotent — used by critical-css.js)
// =============================================================================

(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconSprite) return;

  // ── Critical icon set (16 icons) ────────────────────────────────────
  // These are the icons that appear in the persistent app shell and
  // auth gates — they MUST render on first paint.
  //
  // SVG path data is the inner content of <svg> (paths, circles, lines).
  // Sourced from Lucide (ISC license). Keep in sync with registry/critical.js.
  var CRITICAL_ICONS = {
    'menu': '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    'close': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'login': '<path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>',
    'logout': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
    'person': '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'person_add': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    'manage_accounts': '<path d="M10 15H6a4 4 0 0 0-4 4v2"/><path d="m14.305 16.53.923-.382"/><path d="m15.228 13.852-.923-.383"/><path d="m16.852 12.228-.383-.923"/><path d="m16.852 17.772-.383.924"/><path d="m19.148 12.228.383-.923"/><path d="m19.53 18.696-.382-.924"/><path d="m20.772 13.852.924-.383"/><path d="m20.772 16.148.924.383"/><circle cx="18" cy="15" r="3"/><circle cx="9" cy="7" r="4"/>',
    'notifications': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    'arrow_back': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow_forward': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'chevron_right': '<path d="m9 18 6-6-6-6"/>',
    'chevron_left': '<path d="m15 18-6-6 6-6"/>',
    'search': '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    'home': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'language': '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    'refresh': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  };

  // ── Check if a name is in the critical set ──────────────────────────
  function isCritical(name) {
    if (!name) return false;
    var normalized = name
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/-/g, '_');
    return Object.prototype.hasOwnProperty.call(CRITICAL_ICONS, normalized);
  }

  // ── Build the full sprite SVG string ────────────────────────────────
  // Used by critical-css.js to inject the sprite synchronously into <head>.
  function buildSpriteSvg() {
    var symbols = '';
    var names = Object.keys(CRITICAL_ICONS);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var inner = CRITICAL_ICONS[name];
      symbols += '<symbol id="i-' + name + '" viewBox="0 0 24 24">' + inner + '</symbol>';
    }
    return '<svg class="albedu-sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">'
         + symbols
         + '</svg>';
  }

  // ── Build the <use> HTML for a critical icon ────────────────────────
  // Returns the full <svg>...</svg> string with <use> inside.
  function buildUseHtml(name, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : null;
    var label = opts['aria-label'];
    var strokeWidth = opts.strokeWidth != null ? opts.strokeWidth : 2;
    var extraClasses = opts.class || '';

    var attrs = 'class="albedu-icon ' + extraClasses + '"' +
                ' viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                ' stroke-width="' + strokeWidth + '"' +
                ' stroke-linecap="round" stroke-linejoin="round"' +
                (size ? ' width="' + size + '" height="' + size + '"' : '') +
                (label
                  ? ' role="img" aria-label="' + label.replace(/"/g, '&quot;') + '"'
                  : ' aria-hidden="true"');

    return '<svg ' + attrs + '><use href="#i-' + name + '"/></svg>';
  }

  // ── Inject the sprite into the document (idempotent) ────────────────
  // Used by critical-css.js. Safe to call multiple times.
  function injectInto(doc) {
    doc = doc || document;
    if (doc.getElementById('albedu-icon-sprite')) return; // already injected

    var holder = doc.createElement('div');
    holder.innerHTML = buildSpriteSvg();
    var spriteEl = holder.firstChild;
    spriteEl.setAttribute('id', 'albedu-icon-sprite');
    spriteEl.setAttribute('aria-hidden', 'true');
    (doc.head || doc.documentElement).appendChild(spriteEl);
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.__iconSprite = {
    CRITICAL_ICONS: CRITICAL_ICONS,
    CRITICAL_NAMES: Object.keys(CRITICAL_ICONS),
    isCritical: isCritical,
    buildSpriteSvg: buildSpriteSvg,
    buildUseHtml: buildUseHtml,
    injectInto: injectInto,
  };
})();
