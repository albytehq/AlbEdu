// =============================================================================
// icons.js — AlbEdu Shared Layer · SVG Icon System
// =============================================================================
// Single responsibility: provide a fast, dependency-free SVG icon registry
// that replaces the Material Symbols font. SVGs render instantly (no font
// download), don't flash, and don't shift layout (fixed 1em × 1em box).
//
// Public API:
//   AlbEdu.icon(name, opts?) → HTML string
//   AlbEdu.setIcon(el, name, opts?) → sets innerHTML of an element
//
// Usage in HTML:
//   <span data-albedu-icon="login" aria-hidden="true"></span>
//   ... then AlbEdu.bindIcons(rootEl) materializes them.
//
// Usage in JS:
//   const html = AlbEdu.icon('login', { size: 20 });
//   el.innerHTML = '<a href=...>' + html + ' Login</a>';
//
// Naming: lowercase, hyphen-separated, mirroring the Material Symbols names
// the codebase already uses — so consumer code can switch with minimal churn.
// =============================================================================

(function () {
  'use strict';

  // ── Icon registry ──────────────────────────────────────────────────────
  // All icons use the same 24×24 viewBox, stroke=currentColor, stroke-width=2.
  // Keep this list short — only icons actually used by critical UI.
  // Page-specific icons can be added via AlbEdu.registerIcon(name, svg).
  var ICONS = {
    // Auth / nav
    'login': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
    'logout': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    'person-add': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
    'account-circle': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.5 19a6 6 0 0 1 11 0"/>',
    'manage-accounts': '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/><path d="M18 14l2 2 4-4"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'arrow-back': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    'arrow-forward': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    'expand-more': '<polyline points="6 9 12 15 18 9"/>',
    'language': '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'menu': '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
    'close': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',

    // Status
    'lock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'unlock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    'timer': '<circle cx="12" cy="13" r="8"/><line x1="12" y1="13" x2="12" y2="9"/><line x1="12" y1="13" x2="15" y2="15"/>',
    'pause-circle': '<circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>',
    'play-circle': '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
    'task-alt': '<circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>',
    'warning': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'error': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    'info': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'refresh': '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',

    // Notifications / comms
    'notifications': '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    'mail': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 5L2 7"/>',

    // Domain
    'school': '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    'assignment': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
    'assignment-turnedIn': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>',
    'auto-fix-high': '<path d="M5 7l3 3M8 4l3 3M5 7l-3 3 5 5 3-3z"/><path d="M14 6l8 8-4 4-8-8z"/><line x1="17" y1="3" x2="17" y2="6"/><line x1="20" y1="5" x2="22" y2="3"/>',
    'rocketLaunch': '<path d="M5 13c-1.5 1.5-3 5-3 5s3.5-1.5 5-3"/><path d="M13 19l1-1c4-4 6-9 6-12 0-1-.5-2-1-2-3 0-8 2-12 6l-1 1"/><circle cx="14" cy="10" r="2"/>',
    'science': '<path d="M10 2v7.5L4 20a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L14 9.5V2"/><line x1="8" y1="2" x2="16" y2="2"/>',
    'bolt': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    'monitoring': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    'history': '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 14"/>',
    'design-services': '<path d="M3 21l9-9M14 4l6 6-9 9-6 0 0-6z"/>',
    'smart-toy': '<rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/><line x1="12" y1="4" x2="12" y2="8"/>',
    'chat-bubble': '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',

    // CRUD
    'add': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'edit': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    'delete': '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'save': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    'search': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    'filter': '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    'more-vert': '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',

    // Eye / eye-off (password visibility)
    'eye': '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  };

  // ── Public API ─────────────────────────────────────────────────────────
  function icon(name, opts) {
    var path = ICONS[name];
    if (!path) {
      if (window.console && console.warn) {
        console.warn('[albedu:icons] unknown icon:', name);
      }
      return '';
    }
    opts = opts || {};
    var size = opts.size != null ? opts.size : null;
    var classes = opts.class || '';
    var label = opts['aria-label'];

    var attrs = 'class="albedu-icon ' + classes + '"' +
                (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') +
                (label ? ' role="img" aria-label="' + _escapeAttr(label) + '"' : ' aria-hidden="true"');

    return '<svg viewBox="0 0 24 24" ' + attrs + '>' + path + '</svg>';
  }

  function setIcon(el, name, opts) {
    if (!el) return;
    el.innerHTML = icon(name, opts);
  }

  function registerIcon(name, svgPath) {
    if (!name || typeof svgPath !== 'string') return false;
    ICONS[name] = svgPath;
    return true;
  }

  // Bind all [data-albedu-icon="name"] elements within a root.
  // Called once after DOM ready, and again after any dynamic HTML injection
  // that contains icons.
  function bindIcons(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-albedu-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var name = nodes[i].getAttribute('data-albedu-icon');
      if (!name) continue;
      // Preserve any classes already on the element
      var existingClass = nodes[i].className || '';
      // Strip any 'material-symbols-outlined' legacy class
      existingClass = existingClass.replace(/\bmaterial-symbols-outlined\b/g, '').trim();
      setIcon(nodes[i], name, { class: existingClass });
    }
  }

  function _escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Auto-bind on DOMContentLoaded ──────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindIcons(document); });
  } else {
    bindIcons(document);
  }

  // ── Public surface ─────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.icon = icon;
  window.AlbEdu.setIcon = setIcon;
  window.AlbEdu.registerIcon = registerIcon;
  window.AlbEdu.bindIcons = bindIcons;
})();
