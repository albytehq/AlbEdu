// icons.js — AlbEdu icon system. Inline SVG sprite + cached-template renderer.
// Modules are concatenated at build time by scripts/build_icons_bundle.py;
// in dev they load as separate <script> tags via scripts/serve.mjs.
// Lucide icons (ISC license — https://lucide.dev).
//
// Public API (backward compatible):
//   AlbEdu.icon(name, opts?)              → HTML string
//   AlbEdu.setIcon(el, name, opts?)       → set icon on existing element
//   AlbEdu.registerIcon(name, svgPath)    → register custom SVG icon
//   AlbEdu.bindIcons(rootEl)              → materialize all [data-albedu-icon]
//   AlbEdu.listIcons()                    → list all registered icon names
//   AlbEdu.hasIcon(name)                  → check if icon exists
//   AlbEdu.getMetrics()                   → performance metrics
//   AlbEdu.resetMetrics()                 → reset metrics
//   AlbEdu.addEventListener(event, cb)    → subscribe to events
//   AlbEdu.preloadIcons(names?)           → preload icons into cache
//   AlbEdu.preloadAll()                   → preload entire registry
//   AlbEdu.ICONS_VERSION                  → version string

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  if (window.AlbEdu.__iconSystemV7) return;
  window.AlbEdu.__iconSystemV7 = true;

  // Module refs (_metrics, _renderer, etc.) are captured AFTER the inlined
  // modules below, because the modules populate window.AlbEdu.__iconXxx
  // when they execute.

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
  var MODULES_DIR = BASE_PATH + 'src/shared/icons/modules/';

  // metrics.js — collects render/binding/cache metrics for the debug overlay
  // and benchmark suite. Attached to window.AlbEdu.__iconMetrics.
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconMetrics) return;

  var MAX_ERRORS = 50;
  var _listeners = {};

  var _state = {
    iconsRendered: 0,
    iconsBound: 0,
    cacheHits: 0,
    cacheMisses: 0,
    renderTimeUs: 0,
    renderSamples: 0,
    bindTimeMs: 0,
    initTimeMs: 0,
    lastBindTimestamp: null,
    missingIcons: Object.create(null),
    errors: [],
    _bindStart: 0,
    _initStart: 0,
  };

  function emit(event, detail) {
    var listeners = _listeners[event];
    if (!listeners) return;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail || {}); }
      catch (e) {
        if (window.console && console.error) {
          console.error('[albedu:icons:metrics] listener error:', e);
        }
      }
    }
  }

  function addEventListener(event, cb) {
    if (typeof event !== 'string' || typeof cb !== 'function') return function () {};
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(cb);
    return function unsubscribe() {
      var idx = _listeners[event].indexOf(cb);
      if (idx !== -1) _listeners[event].splice(idx, 1);
    };
  }

  function incRender() { _state.iconsRendered++; }
  function incBind() { _state.iconsBound++; }
  function incCacheHit() { _state.cacheHits++; }
  function incCacheMiss() { _state.cacheMisses++; }

  function recordRenderTime(us) {
    _state.renderTimeUs += us;
    _state.renderSamples++;
  }

  function recordMissing(name) {
    if (!name) return;
    _state.missingIcons[name] = (_state.missingIcons[name] || 0) + 1;
    emit('icon-missing', { requested: name, normalized: name });
  }

  function recordError(context, err) {
    var entry = {
      context: context,
      message: err && (err.message || String(err)),
      stack: err && err.stack,
      timestamp: Date.now(),
    };
    _state.errors.push(entry);
    if (_state.errors.length > MAX_ERRORS) _state.errors.shift();
    emit('icon-error', { context: context, error: err });
    if (window.console && console.error) {
      console.error('[albedu:icons] ' + context + ':', err);
    }
  }

  function startBind() {
    _state._bindStart = performance.now();
    if (window.performance && performance.mark) {
      try { performance.mark('albedu:icons:bind-start'); } catch (_) {}
    }
  }

  function endBind() {
    if (!_state._bindStart) return;
    _state.bindTimeMs = performance.now() - _state._bindStart;
    _state.lastBindTimestamp = Date.now();
    _state._bindStart = 0;
    if (window.performance && performance.mark && performance.measure) {
      try {
        performance.mark('albedu:icons:bind-end');
        performance.measure('albedu:icons:bind', 'albedu:icons:bind-start', 'albedu:icons:bind-end');
      } catch (_) {}
    }
    emit('icons-bound', { durationMs: _state.bindTimeMs });
  }

  function startInit() {
    _state._initStart = performance.now();
  }

  function endInit() {
    if (!_state._initStart) return;
    _state.initTimeMs = performance.now() - _state._initStart;
    _state._initStart = 0;
  }

  function snapshot() {
    var missing = Object.assign({}, _state.missingIcons);
    return {
      iconsRendered: _state.iconsRendered,
      iconsBound: _state.iconsBound,
      cacheHits: _state.cacheHits,
      cacheMisses: _state.cacheMisses,
      cacheHitRate: (_state.cacheHits + _state.cacheMisses) === 0
        ? 0 : _state.cacheHits / (_state.cacheHits + _state.cacheMisses),
      avgRenderTimeUs: _state.renderSamples === 0
        ? 0 : _state.renderTimeUs / _state.renderSamples,
      totalRenderTimeUs: _state.renderTimeUs,
      bindTimeMs: _state.bindTimeMs,
      initTimeMs: _state.initTimeMs,
      lastBindTimestamp: _state.lastBindTimestamp,
      missingIcons: missing,
      missingIconCount: Object.keys(missing).length,
      errorCount: _state.errors.length,
      errors: _state.errors.slice(),
    };
  }

  function reset() {
    _state.iconsRendered = 0;
    _state.iconsBound = 0;
    _state.cacheHits = 0;
    _state.cacheMisses = 0;
    _state.renderTimeUs = 0;
    _state.renderSamples = 0;
    _state.bindTimeMs = 0;
    _state.initTimeMs = 0;
    _state.lastBindTimestamp = null;
    _state.missingIcons = Object.create(null);
    _state.errors = [];
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.__iconMetrics = {
    incRender: incRender,
    incBind: incBind,
    incCacheHit: incCacheHit,
    incCacheMiss: incCacheMiss,
    recordRenderTime: recordRenderTime,
    recordMissing: recordMissing,
    recordError: recordError,
    startBind: startBind,
    endBind: endBind,
    startInit: startInit,
    endInit: endInit,
    snapshot: snapshot,
    reset: reset,
    addEventListener: addEventListener,
    emit: emit,
  };
})();


  // cache.js — in-memory LRU cache of parsed SVG <template> elements.
  // Subsequent renders clone the cached template via cloneNode(true) —
  // zero string parsing, zero attribute serialization.
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconCache) return; // idempotent

  var MAX_ENTRIES = 256;
  var _map = new Map();        // insertion-ordered (used for LRU eviction)
  var _hits = 0;
  var _misses = 0;

  function _key(name, size, strokeWidth, classes, label) {
    // Composite key includes all options that affect rendered SVG output,
    // so the cache is never wrong.
    return name + '|' + (size || '') + '|' + (strokeWidth || '') +
           '|' + (classes || '') + '|' + (label ? '1' : '0');
  }

  function get(key) {
    var tpl = _map.get(key);
    if (tpl) {
      // LRU refresh: move to end (most-recently-used)
      _map.delete(key);
      _map.set(key, tpl);
      _hits++;
      return tpl;
    }
    _misses++;
    return null;
  }

  function set(key, template) {
    if (!template) return;
    if (_map.size >= MAX_ENTRIES) {
      var oldest = _map.keys().next().value;
      _map.delete(oldest);
    }
    _map.set(key, template);
  }

  function has(key) {
    return _map.has(key);
  }

  function clear() {
    _map.clear();
    _hits = 0;
    _misses = 0;
  }

  function stats() {
    var total = _hits + _misses;
    return {
      size: _map.size,
      maxEntries: MAX_ENTRIES,
      hits: _hits,
      misses: _misses,
      hitRate: total === 0 ? 0 : _hits / total,
    };
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.__iconCache = {
    _key: _key,
    get: get,
    set: set,
    has: has,
    clear: clear,
    stats: stats,
    get size() { return _map.size; },
  };
})();


  // sprite.js — inline SVG sprite of CRITICAL icons (the persistent app shell:
  // navbar, sidebar, header, footer, auth gates). These render instantly via
  // <use href="#i-NAME"> — zero JS execution, zero network requests.
  // critical-css.js injects the sprite synchronously into <head> before
  // first paint.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconSprite) return;

  // Admin sidebar icons moved from secondary to critical so they render via
  // inline sprite before first paint (instant, zero JS).
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
    'account_circle': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
    'edit_note': '<path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/>',
    'menu_book': '<path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/>',
    'inventory_2': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
    'monitor_heart': '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    'bar_chart': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    'list': '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
    'left_panel_open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
    'left_panel_close': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  };

  function isCritical(name) {
    if (!name) return false;
    var normalized = name
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/-/g, '_');
    return Object.prototype.hasOwnProperty.call(CRITICAL_ICONS, normalized);
  }

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

  // Idempotent — used by critical-css.js. Safe to call multiple times.
  function injectInto(doc) {
    doc = doc || document;
    if (doc.getElementById('albedu-icon-sprite')) return;

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


  // critical.js — registry of critical icons (same set as the sprite above).
  // Kept as a separate object so the renderer can look them up by name when
  // setIcon() is called on an element that's not in the DOM at sprite-inject
  // time. Lucide (ISC).
window.AlbEdu = window.AlbEdu || {};
window.AlbEdu.__iconRegistryCritical = {
  'arrow_back': '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />',
  'arrow_forward': '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />',
  'chevron_left': '<path d="m15 18-6-6 6-6" />',
  'chevron_right': '<path d="m9 18 6-6-6-6" />',
  'close': '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
  'home': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  'language': '<path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />',
  'login': '<path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />',
  'logout': '<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />',
  'manage_accounts': '<path d="M10 15H6a4 4 0 0 0-4 4v2" /><path d="m14.305 16.53.923-.382" /><path d="m15.228 13.852-.923-.383" /><path d="m16.852 12.228-.383-.923" /><path d="m16.852 17.772-.383.924" /><path d="m19.148 12.228.383-.923" /><path d="m19.53 18.696-.382-.924" /><path d="m20.772 13.852.924-.383" /><path d="m20.772 16.148.924.383" /><circle cx="18" cy="15" r="3" /><circle cx="9" cy="7" r="4" />',
  'menu': '<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />',
  'notifications': '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />',
  'person': '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />',
  'person_add': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" x2="19" y1="8" y2="14" /><line x1="22" x2="16" y1="11" y2="11" />',
  'refresh': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'search': '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
  'account_circle': '<circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3" /><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />',
  'edit_note': '<path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z" /><path d="M14.487 7.858A1 1 0 0 1 14 7V2" /><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516" /><path d="M8 18h1" />',
  'menu_book': '<path d="M12 7v14" /><path d="M16 12h2" /><path d="M16 8h2" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /><path d="M6 12h2" /><path d="M6 8h2" />',
  'inventory_2': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><polyline points="3.29 7 12 12 20.71 7" /><path d="m7.5 4.27 9 5.15" />',
  'monitor_heart': '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />',
  'bar_chart': '<path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />',
  'list': '<path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />',
  'left_panel_open': '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m14 9 3 3-3 3" />',
  'left_panel_close': '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" />',
};


  // secondary.js — feature-specific icons (charts, editor, admin tools).
  // Rendered via the cached-template renderer (cloneNode).
  // Lucide (ISC).
window.AlbEdu = window.AlbEdu || {};
window.AlbEdu.__iconRegistrySecondary = {
  'add': '<path d="M5 12h14" /><path d="M12 5v14" />',
  'add_circle': '<circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" />',
  'arrow_downward': '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />',
  'arrow_upward': '<path d="m5 12 7-7 7 7" /><path d="M12 19V5" />',
  'assignment': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />',
  'assignment_turned_in': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="m9 15 2 2 4-4" />',
  'auto_fix_high': '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" /><path d="m14 7 3 3" /><path d="M5 6v4" /><path d="M19 14v4" /><path d="M10 2v2" /><path d="M7 8H3" /><path d="M21 16h-4" /><path d="M11 3H9" />',
  'badge': '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /><path d="m9 12 2 2 4-4" />',
  'block': '<circle cx="12" cy="12" r="10" /><path d="M4.929 4.929 19.07 19.071" />',
  'bolt': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />',
  'book': '<path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />',
  'category': '<rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" />',
  'chat_bubble': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />',
  'check': '<path d="M20 6 9 17l-5-5" />',
  'check_circle': '<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />',
  'content_copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  'dangerous': '<path d="M12 16h.01" /><path d="M12 8v4" /><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" />',
  'data_object': '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />',
  'delete': '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
  'design_services': '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" /><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" /><path d="m2.3 2.3 7.286 7.286" /><circle cx="11" cy="11" r="2" />',
  'done_all': '<path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" />',
  'edit': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
  'error': '<circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" />',
  'expand_less': '<path d="m18 15-6-6-6 6" />',
  'expand_more': '<path d="m6 9 6 6 6-6" />',
  'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
  'eye_off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" />',
  'file_download': '<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />',
  'file_upload': '<path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />',
  'filter': '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />',
  'fingerprint': '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" /><path d="M14 13.12c0 2.38 0 6.38-1 8.88" /><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" /><path d="M2 12a10 10 0 0 1 18-6" /><path d="M2 16h.01" /><path d="M21.8 16c.2-2 .131-5.354 0-6" /><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" /><path d="M8.65 22c.21-.66.45-1.32.57-2" /><path d="M9 6.8a6 6 0 0 1 9 5.2v2" />',
  'folder_open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />',
  'format_list_bulleted': '<path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />',
  'groups': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" />',
  'history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />',
  'hourglass_top': '<path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />',
  'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />',
  'info': '<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />',
  'keyboard': '<path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" />',
  'list_alt': '<path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" />',
  'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
  'mail': '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" /><rect x="2" y="4" width="20" height="16" rx="2" />',
  'mail_alt': '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" /><rect x="2" y="4" width="20" height="16" rx="2" />',
  'monitoring': '<path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m19 9-5 5-4-4-3 3" />',
  'more_horiz': '<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />',
  'more_vert': '<circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />',
  'pause': '<rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />',
  'pause_circle': '<circle cx="12" cy="12" r="10" /><line x1="10" x2="10" y1="15" y2="9" /><line x1="14" x2="14" y1="15" y2="9" />',
  'person_edit': '<path d="M11.5 15H7a4 4 0 0 0-4 4v2" /><path d="M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" /><circle cx="10" cy="7" r="4" />',
  'person_off': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="17" x2="22" y1="8" y2="13" /><line x1="22" x2="17" y1="8" y2="13" />',
  'photo_camera': '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" />',
  'picture_as_pdf': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />',
  'play_arrow': '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',
  'play_circle': '<path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" /><circle cx="12" cy="12" r="10" />',
  'quiz': '<circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />',
  'restart_alt': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />',
  'rocket_launch': '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" /><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" />',
  'rocket_launch_alt': '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" /><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" />',
  'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
  'schedule': '<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />',
  'school': '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" /><path d="M22 10v6" /><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />',
  'science': '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" /><path d="M6.453 15h11.094" /><path d="M8.5 2h7" />',
  'search_off': '<path d="m13.5 8.5-5 5" /><path d="m8.5 8.5 5 5" /><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />',
  'sell': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />',
  'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />',
  'smart_toy': '<path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />',
  'stop_circle': '<circle cx="12" cy="12" r="10" /><rect x="9" y="9" width="6" height="6" rx="1" />',
  'sync': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'table_view': '<path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />',
  'task_alt': '<path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" />',
  'timer': '<line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" />',
  'unlock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />',
  'view_column': '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" />',
  'warning': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />',
  'x': '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
};


  // renderer.js — clone-based SVG renderer.
  // Strategy: cache parsed SVG as a <template> (one-time string parse),
  // then cloneNode(true) on subsequent renders — O(1) DOM cloning, no string
  // parsing, no attribute serialization. <template>.content is an inert
  // DocumentFragment, and cloneNode on it is highly optimized in V8/JSC/SpiderMonkey.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconRenderer) return;

  var _cache = window.AlbEdu && window.AlbEdu.__iconCache;
  var _metrics = window.AlbEdu && window.AlbEdu.__iconMetrics;
  var _registry = null;        // set by orchestrator via setRegistry()
  var _aliases = Object.create(null);

  // Fallback placeholder (shown when icon is missing — never breaks UI)
  var FALLBACK_SVG_INNER = '<rect x="2" y="2" width="20" height="20" rx="3" '
    + 'fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-dasharray="3 3" opacity="0.4"/>'
    + '<text x="12" y="16" font-size="10" font-family="monospace" '
    + 'text-anchor="middle" fill="currentColor" opacity="0.6">?</text>';

  // Accepts: account_circle, account-circle, accountCircle → account_circle
  function _normalizeName(name) {
    if (typeof name !== 'string') return name;
    return name
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/-/g, '_');
  }

  function _resolve(name) {
    var normalized = _normalizeName(name);
    var seen = Object.create(null);
    var current = normalized;
    for (var i = 0; i < 5; i++) {
      if (seen[current]) break;
      seen[current] = true;
      if (_aliases[current]) {
        current = _aliases[current];
      } else {
        break;
      }
    }
    var path = _registry ? (_registry[current] || null) : null;
    return { name: current, path: path };
  }

  function _escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // SLOW path — only called on cache miss.
  function _buildSvgString(innerPath, opts, classes) {
    var size = opts.size != null ? opts.size : null;
    var label = opts['aria-label'];
    var strokeWidth = opts.strokeWidth != null ? opts.strokeWidth : 2;
    var allClasses = classes + ' ' + (opts.class || '');

    var attrs = 'class="' + allClasses + '"' +
                ' viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                ' stroke-width="' + strokeWidth + '"' +
                ' stroke-linecap="round" stroke-linejoin="round"' +
                (size ? ' width="' + size + '" height="' + size + '"' : '') +
                (label
                  ? ' role="img" aria-label="' + _escapeAttr(label) + '"'
                  : ' aria-hidden="true"');

    return '<svg ' + attrs + '>' + innerPath + '</svg>';
  }

  // String cache (Layer 1a) — for the icon() string API. Avoids DOM
  // round-trip on cache hits. Keyed identically to _cache.
  var _stringCache = new Map();
  var STRING_CACHE_MAX = 256;

  function _getString(cacheKey) {
    var s = _stringCache.get(cacheKey);
    if (s) {
      // LRU refresh
      _stringCache.delete(cacheKey);
      _stringCache.set(cacheKey, s);
    }
    return s;
  }

  function _setString(cacheKey, s) {
    if (_stringCache.size >= STRING_CACHE_MAX) {
      var oldest = _stringCache.keys().next().value;
      _stringCache.delete(oldest);
    }
    _stringCache.set(cacheKey, s);
  }

  // Build a cached <template> for an icon. Cloning the template is much
  // faster than re-parsing the string.
  function _createTemplate(name, innerPath, opts, classes) {
    var svgString = _buildSvgString(innerPath, opts, classes);
    var tpl = document.createElement('template');
    tpl.innerHTML = svgString;
    return { tpl: tpl, str: svgString };
  }

  // render() — returns HTML string. Uses the string cache (Layer 1a),
  // pure O(1) on cache hit, no DOM round-trip.
  function render(name, opts) {
    opts = opts || {};
    var startTime = _metrics ? performance.now() : 0;

    try {
      var resolved = _resolve(name);

      if (!resolved.path) {
        if (_metrics) _metrics.recordMissing(resolved.name);
        if (opts.fallback === false) return '';
        if (window.console && console.warn) {
          console.warn('[albedu:icons] unknown icon:', name);
        }
        var fallbackClasses = 'albedu-icon albedu-icon--missing';
        return _buildSvgString(FALLBACK_SVG_INNER, opts, fallbackClasses);
      }

      var classes = 'albedu-icon';
      var cacheKey = _cache ? _cache._key(resolved.name, opts.size, opts.strokeWidth, opts.class, opts['aria-label']) : null;

      // Try string cache FIRST — pure O(1), no DOM
      var cachedString = cacheKey ? _getString(cacheKey) : null;
      if (cachedString) {
        if (_metrics) {
          _metrics.incRender();
          _metrics.incCacheHit();
          _metrics.recordRenderTime((performance.now() - startTime) * 1000);
        }
        return cachedString;
      }

      // Cache miss — build the string and cache it
      var svgString = _buildSvgString(resolved.path, opts, classes);
      if (cacheKey) {
        _setString(cacheKey, svgString);
        _metrics && _metrics.incCacheMiss();
      }

      if (_metrics) {
        _metrics.incRender();
        _metrics.recordRenderTime((performance.now() - startTime) * 1000);
      }

      return svgString;
    } catch (err) {
      if (_metrics) _metrics.recordError('renderer.render:' + name, err);
      return _buildSvgString(FALLBACK_SVG_INNER, opts || {}, 'albedu-icon albedu-icon--error');
    }
  }

  // renderNode() — returns a cloned SVGElement. FAST path for DOM insertion.
  // Uses the template cache (Layer 1b) — cloneNode(true) is faster than
  // string parsing.
  function renderNode(name, opts) {
    opts = opts || {};

    try {
      var resolved = _resolve(name);

      if (!resolved.path) {
        if (_metrics) _metrics.recordMissing(resolved.name);
        if (opts.fallback === false) return null;
        var fb = _createTemplate('_fallback', FALLBACK_SVG_INNER, opts, 'albedu-icon albedu-icon--missing');
        return fb.tpl.content.firstChild.cloneNode(true);
      }

      var classes = 'albedu-icon';
      var cacheKey = _cache ? _cache._key(resolved.name, opts.size, opts.strokeWidth, opts.class, opts['aria-label']) : null;
      var tpl = _cache ? _cache.get(cacheKey) : null;

      if (!tpl) {
        var built = _createTemplate(resolved.name, resolved.path, opts, classes);
        tpl = built.tpl;
        if (_cache) {
          _cache.set(cacheKey, tpl);
          _metrics && _metrics.incCacheMiss();
        }
      } else if (_metrics) {
        _metrics.incCacheHit();
      }

      if (_metrics) _metrics.incRender();
      return tpl.content.firstChild.cloneNode(true);
    } catch (err) {
      if (_metrics) _metrics.recordError('renderer.renderNode:' + name, err);
      return null;
    }
  }

  // Used by bindIcons() to batch DOM writes — minimizes reflow.
  function renderBatch(items) {
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var node = renderNode(item.name, item.opts);
      if (node) {
        var holder = document.createElement('div');
        holder.appendChild(node);
        fragment.appendChild(holder);
      }
    }
    return fragment;
  }

  // Used by setIcon() and bindIcons(). Uses cloneNode — no innerHTML
  // serialization when the template is cached.
  function bindToElement(el, name, opts) {
    if (!el) return;
    opts = opts || {};

    try {
      var node = renderNode(name, opts);
      if (!node) return;

      // Clear existing children (single reflow)
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(node);

      // Propagate parent classes to the SVG (preserves styling hooks)
      if (el.className && typeof el.className === 'string') {
        var classes = el.className.split(/\s+/);
        for (var i = 0; i < classes.length; i++) {
          var c = classes[i];
          if (c && c !== 'material-symbols-outlined' && c !== 'albedu-icon') {
            node.classList.add(c);
          }
        }
      }
    } catch (err) {
      if (_metrics) _metrics.recordError('renderer.bindToElement:' + name, err);
    }
  }

  function has(name) {
    var resolved = _resolve(name);
    return !!resolved.path;
  }

  function setRegistry(registry, aliases) {
    _registry = registry || _registry;
    _aliases = aliases || _aliases;
  }

  function getFallback() { return FALLBACK_SVG_INNER; }

  // Clear both string cache (Layer 1a) and template cache (Layer 1b).
  // Called by registerIcon() to invalidate stale entries.
  function clearCache() {
    _stringCache.clear();
    if (_cache) _cache.clear();
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.__iconRenderer = {
    render: render,
    renderNode: renderNode,
    renderBatch: renderBatch,
    bindToElement: bindToElement,
    has: has,
    setRegistry: setRegistry,
    getFallback: getFallback,
    clearCache: clearCache,
    _normalizeName: _normalizeName,
    _resolve: _resolve,
  };
})();


  // loader.js — schedules icon binding to minimize impact on first paint
  // and interactive time. critical-css.js injects the sprite sync, then
  // icons.js (deferred) binds visible icons immediately, defers off-screen
  // binding to IntersectionObserver, and preloads secondary icons into the
  // cache during requestIdleCallback.
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

  function onIdle(cb, opts) {
    opts = opts || {};
    return _ric(cb, { timeout: opts.timeout || 2000 });
  }

  // Pre-render icons into the cache so subsequent renders are pure cloneNode.
  function preloadIcons(names) {
    if (!names || !names.length) return;
    var renderer = window.AlbEdu && window.AlbEdu.__iconRenderer;
    if (!renderer) return;

    onIdle(function () {
      for (var i = 0; i < names.length; i++) {
        try {
          renderer.render(names[i], {});
        } catch (_) { /* swallow — preload is best-effort */ }
      }
    }, { timeout: 3000 });
  }

  // Pre-render the critical icons. They're already in the sprite, but this
  // warms the renderer cache for setIcon() calls.
  function preloadCriticalSet() {
    var sprite = window.AlbEdu && window.AlbEdu.__iconSprite;
    if (!sprite) return;
    preloadIcons(sprite.CRITICAL_NAMES);
  }

  // Pre-render the entire registry — useful for SPA navigation.
  function preloadAll() {
    var listFn = window.AlbEdu && window.AlbEdu.listIcons;
    if (!listFn) return;
    onIdle(function () {
      var names = listFn();
      preloadIcons(names);
    }, { timeout: 5000 });
  }

  // rAF for visual sync, then idle callback for the actual work — keeps
  // bind operations from blocking animation frames.
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

  var _metrics = window.AlbEdu.__iconMetrics;
  if (_metrics) _metrics.startInit();

  var _renderer = window.AlbEdu.__iconRenderer;
  var _sprite = window.AlbEdu.__iconSprite;
  var _loader = window.AlbEdu.__iconLoader;
  var _cache = window.AlbEdu.__iconCache;

  var _mergedRegistry = Object.assign(
    {},
    window.AlbEdu.__iconRegistryCritical || {},
    window.AlbEdu.__iconRegistrySecondary || {}
  );

  // Build aliases for common alternative names (hyphenated, camelCase).
  // person-add → person_add, etc.
  var _aliases = Object.create(null);
  Object.keys(_mergedRegistry).forEach(function (name) {
    var hyphen = name.replace(/_/g, '-');
    if (hyphen !== name) _aliases[hyphen] = name;
    var camel = name.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
    if (camel !== name) _aliases[camel] = name;
  });
  // x is a common alias for close
  _aliases['x'] = 'close';

  if (_renderer) _renderer.setRegistry(_mergedRegistry, _aliases);

  function icon(name, opts) {
    return _renderer ? _renderer.render(name, opts || {}) : '';
  }

  function setIcon(el, name, opts) {
    if (!_renderer || !el) return;
    _renderer.bindToElement(el, name, opts || {});
  }

  function registerIcon(name, svgPath) {
    if (!name || typeof svgPath !== 'string') return false;
    try {
      var normalized = _renderer._normalizeName(name);
      _mergedRegistry[normalized] = svgPath;
      _renderer.setRegistry(_mergedRegistry, _aliases);
      _renderer.clearCache();
      return true;
    } catch (err) {
      if (_metrics) _metrics.recordError('registerIcon:' + name, err);
      return false;
    }
  }

  function listIcons() {
    var all = Object.keys(_mergedRegistry).concat(Object.keys(_aliases));
    var seen = Object.create(null);
    var result = [];
    for (var i = 0; i < all.length; i++) {
      if (!seen[all[i]]) {
        seen[all[i]] = true;
        result.push(all[i]);
      }
    }
    return result.sort();
  }

  function hasIcon(name) {
    return _renderer ? _renderer.has(name) : false;
  }

  function getMetrics() {
    if (!_metrics) return {};
    var snap = _metrics.snapshot();
    var cacheStats = _cache ? _cache.stats() : {};
    return Object.assign(snap, {
      cacheSize: cacheStats.size || 0,
      cacheMaxEntries: cacheStats.maxEntries || 0,
      totalIconsInRegistry: Object.keys(_mergedRegistry).length,
      criticalIconsCount: _sprite ? _sprite.CRITICAL_NAMES.length : 0,
    });
  }

  function resetMetrics() {
    if (_metrics) _metrics.reset();
    if (_renderer) _renderer.clearCache();
    else if (_cache) _cache.clear();
  }

  function addEventListener(event, cb) {
    return _metrics ? _metrics.addEventListener(event, cb) : function () {};
  }

  function preloadIcons(names) {
    if (!_loader) return;
    if (!names) {
      _loader.preloadCriticalSet();
    } else if (Array.isArray(names)) {
      _loader.preloadIcons(names);
    }
  }

  function preloadAll() {
    if (_loader) _loader.preloadAll();
  }

  // DOM binder: bind [data-albedu-icon] elements to actual SVGs.

  var _io = null;

  function _bindNode(node) {
    if (!_renderer) return;
    if (node.querySelector('svg.albedu-icon')) return;

    var rawName = node.getAttribute('data-albedu-icon');
    if (!rawName) return;

    var existingClass = node.className || '';
    existingClass = existingClass
      .replace(/\bmaterial-symbols-outlined\b/g, '')
      .replace(/\balbedu-icon\b/g, '')
      .trim();

    var normalizedName = _renderer._normalizeName(rawName);

    // Critical icon fast path: <use href="#i-..."> — pure DOM clone, no
    // template cache lookup.
    if (_sprite && _sprite.isCritical(normalizedName)) {
      var useHtml = _sprite.buildUseHtml(normalizedName, { class: existingClass });
      node.innerHTML = useHtml;
      if (_metrics) {
        _metrics.incBind();
        _metrics.incCacheHit(); // sprite is effectively a permanent cache hit
      }
      return;
    }

    _renderer.bindToElement(node, rawName, { class: existingClass });
    if (_metrics) _metrics.incBind();
  }

  function _setupObserver() {
    if (_io) return;
    if (!('IntersectionObserver' in window)) return;
    _io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          _bindNode(entries[i].target);
          _io.unobserve(entries[i].target);
        }
      }
    }, {
      rootMargin: '50px 0px',
      threshold: 0.01,
    });
  }

  function _bindImmediate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-albedu-icon]');
    var immediate = [];
    var deferred = [];

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.querySelector('svg.albedu-icon')) continue;

      var rect = node.getBoundingClientRect();
      // If rect is all zeros (no layout available — jsdom, hidden tab,
      // display:none ancestor), bind immediately to be safe.
      var noLayout = rect.top === 0 && rect.bottom === 0 &&
                     rect.left === 0 && rect.right === 0;
      // Off-canvas chrome (mobile sidebar drawers, slide-in panels) uses
      // transform: translateX(...) to sit outside the viewport while
      // "closed". getBoundingClientRect() reflects that transform, so these
      // nodes look like real off-screen content and get queued into the
      // IntersectionObserver instead of binding now — the icon only renders
      // mid-animation when the drawer opens. They're persistent UI the user
      // is about to reveal, so opt them out of lazy-binding via
      // [data-icon-eager] on the drawer/nav container.
      var isEager = !!node.closest('[data-icon-eager]');
      var inViewport = noLayout || isEager ||
                       (rect.top < window.innerHeight && rect.bottom > 0 &&
                        rect.left < window.innerWidth && rect.right > 0);

      if (inViewport) {
        immediate.push(node);
      } else {
        deferred.push(node);
      }
    }

    // Each _bindNode is fast (~0.05ms), so a simple loop is fine — no need
    // for DocumentFragment batching here (nodes live in different parts of DOM).
    for (var j = 0; j < immediate.length; j++) {
      _bindNode(immediate[j]);
    }

    if (deferred.length > 0) {
      _setupObserver();
      if (_io) {
        for (var k = 0; k < deferred.length; k++) {
          _io.observe(deferred[k]);
        }
      } else {
        // No IO support — bind all immediately
        for (var m = 0; m < deferred.length; m++) {
          _bindNode(deferred[m]);
        }
      }
    }

    return { immediate: immediate.length, deferred: deferred.length };
  }

  function bindIcons(root) {
    if (_metrics) _metrics.startBind();
    var result;

    try {
      if (!('IntersectionObserver' in window)) {
        var scope = root || document;
        var nodes = scope.querySelectorAll('[data-albedu-icon]');
        for (var i = 0; i < nodes.length; i++) {
          if (!nodes[i].querySelector('svg.albedu-icon')) {
            _bindNode(nodes[i]);
          }
        }
        result = { immediate: nodes.length, deferred: 0 };
      } else {
        result = _bindImmediate(root);
      }
    } catch (err) {
      if (_metrics) _metrics.recordError('bindIcons', err);
      result = { immediate: 0, deferred: 0 };
    }

    if (_metrics) _metrics.endBind();
    return result;
  }

  // Auto-bind dynamic content via MutationObserver.
  var _mo = null;

  function _setupMutationObserver() {
    if (_mo) return;
    if (!('MutationObserver' in window)) return;

    _mo = new MutationObserver(function (mutations) {
      var pending = [];
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;

          if (node.hasAttribute && node.hasAttribute('data-albedu-icon')) {
            pending.push(node);
          }
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll('[data-albedu-icon]');
            for (var k = 0; k < inner.length; k++) {
              pending.push(inner[k]);
            }
          }
        }
      }

      if (pending.length === 0) return;

      // requestAnimationFrame batches DOM updates — no layout thrash.
      if ('requestAnimationFrame' in window) {
        requestAnimationFrame(function () {
          for (var m = 0; m < pending.length; m++) {
            if (!pending[m].querySelector('svg.albedu-icon')) {
              _bindNode(pending[m]);
            }
          }
        });
      } else {
        for (var n = 0; n < pending.length; n++) {
          if (!pending[n].querySelector('svg.albedu-icon')) {
            _bindNode(pending[n]);
          }
        }
      }
    });

    _mo.observe(document.body, { childList: true, subtree: true });
  }

  function _cleanup() {
    if (_io) { try { _io.disconnect(); } catch (_) {} _io = null; }
    if (_mo) { try { _mo.disconnect(); } catch (_) {} _mo = null; }
  }

  function _autoInit() {
    try {
      bindIcons(document);
      _setupMutationObserver();

      // Preload critical icons into renderer cache during idle time so
      // setIcon() calls (for example, mobile menu toggle) are instant cache hits.
      if (_loader) {
        _loader.onIdle(function () {
          _loader.preloadCriticalSet();
        }, { timeout: 2000 });
      }

      if (_metrics) _metrics.endInit();
    } catch (err) {
      if (_metrics) _metrics.recordError('autoInit', err);
    }
  }

  // This file loads via <script defer>, which guarantees document.readyState
  // is already 'interactive' by the time we execute — so bind immediately.
  // The readyState==='loading' branch is technically dead code, kept as a
  // defensive fallback for non-deferred loads.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  window.addEventListener('pagehide', _cleanup, { once: true });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) _autoInit();
  });

  window.AlbEdu.icon = icon;
  window.AlbEdu.setIcon = setIcon;
  window.AlbEdu.registerIcon = registerIcon;
  window.AlbEdu.bindIcons = bindIcons;
  window.AlbEdu.listIcons = listIcons;
  window.AlbEdu.hasIcon = hasIcon;
  window.AlbEdu.getMetrics = getMetrics;
  window.AlbEdu.resetMetrics = resetMetrics;
  window.AlbEdu.addEventListener = addEventListener;
  window.AlbEdu.on = addEventListener;
  window.AlbEdu.preloadIcons = preloadIcons;
  window.AlbEdu.preloadAll = preloadAll;
  window.AlbEdu.ICONS_VERSION = '7.0.0';
})();
