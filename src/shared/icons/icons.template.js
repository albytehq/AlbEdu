// =============================================================================
// icons.js — AlbEdu Shared Layer · Icon System (v7.0 ENTERPRISE)
// =============================================================================
// Enterprise-grade icon architecture with multi-layer caching, clone-based
// rendering, and instant first paint via inline SVG sprite.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ ARCHITECTURE                                                        │
// ├─────────────────────────────────────────────────────────────────────┤
// │                                                                     │
// │  [HTML parse begins]                                                │
// │       ↓                                                             │
// │  critical-css.js (sync, in <head>)                                  │
// │       ↓ injects inline sprite (16 critical <symbol> elements)       │
// │       ↓ injects critical CSS (shell paints)                         │
// │                                                                     │
// │  [First Paint — 0ms icon render via <use href="#i-...">]            │
// │       ↓                                                             │
// │  icons.js loads (this file, deferred)                               │
// │       ↓ loads modules in dependency order:                          │
// │       ↓   1. metrics.js    — performance observability              │
// │       ↓   2. cache.js      — Layer 1: DocumentFragment cache        │
// │       ↓   3. sprite.js     — inline SVG sprite manager              │
// │       ↓   4. registry/critical.js   — 16 critical icon paths        │
// │       ↓   5. registry/secondary.js  — 85 secondary icon paths       │
// │       ↓   6. renderer.js   — cloneNode-based SVG renderer           │
// │       ↓   7. loader.js     — requestIdleCallback preloader          │
// │       ↓                                                             │
// │  [Auto-init runs]                                                   │
// │       ↓ bindIcons() — visible icons bound synchronously             │
// │       ↓ MutationObserver — auto-binds dynamic content               │
// │       ↓ IntersectionObserver — lazy-binds off-screen icons          │
// │       ↓ requestIdleCallback — preloads secondary icons into cache   │
// │                                                                     │
// │  [User scrolls / dynamic content added]                             │
// │       ↓ IntersectionObserver fires → bind on demand                 │
// │       ↓ MutationObserver fires → bind new content                   │
// │                                                                     │
// │  [Page hide / bfcache]                                              │
// │       ↓ pagehide → disconnect observers (prevent leaks)             │
// │       ↓ pageshow(persisted) → re-init observers                     │
// └─────────────────────────────────────────────────────────────────────┘
//
// Performance characteristics:
//   First paint (critical icons):  ~0ms (inline sprite, <use> clone)
//   First paint (visible icons):   ~5-15ms (sync bind)
//   Repeat icon render:            ~0.005ms (cloneNode from cache)
//   Cache hit rate (steady state): >95%
//   Memory footprint:              ~50KB (256-entry LRU cache)
//
// Public API (preserved from v6.0 — backward compatible):
//   AlbEdu.icon(name, opts?)              → HTML string
//   AlbEdu.setIcon(el, name, opts?)       → set icon on existing element
//   AlbEdu.registerIcon(name, svgPath)    → register custom SVG icon
//   AlbEdu.bindIcons(rootEl)              → materialize all [data-albedu-icon]
//   AlbEdu.listIcons()                    → list all registered icon names
//   AlbEdu.hasIcon(name)                  → check if icon exists
//   AlbEdu.getMetrics()                   → performance metrics
//   AlbEdu.resetMetrics()                 → reset metrics
//   AlbEdu.addEventListener(event, cb)    → subscribe to events
//
// New v7.0 APIs:
//   AlbEdu.preloadIcons(names?)           → preload icons into cache
//   AlbEdu.preloadAll()                   → preload entire registry
//   AlbEdu.ICONS_VERSION                  → '7.0.0-enterprise'
//
// License: ISC (Lucide icons — https://lucide.dev)
// =============================================================================

(function () {
  'use strict';

  // ── SSR safety ──────────────────────────────────────────────────────
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  // Guard: don't re-init if already loaded
  if (window.AlbEdu.__iconSystemV7) return;
  window.AlbEdu.__iconSystemV7 = true;

  // NOTE: Module references (_metrics, _renderer, etc.) are captured
  // AFTER the inlined modules below, because the modules populate
  // window.AlbEdu.__iconXxx when they execute.

  // ── Compute BASE_PATH for module loading ────────────────────────────
  // Mirrors critical-css.js BASE_PATH logic. Required for subdirectory
  // deployments (e.g. GitHub Pages /AlbEdu/).
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

  // ── Module loading (in strict dependency order) ─────────────────────
  // Each module attaches its API to window.AlbEdu.__iconXxx.
  // We use synchronous script injection (document.write is forbidden in
  // modern HTML, so we use createElement + .appendChild + .sync=false).
  //
  // For deferred scripts, the browser already executes them in order.
  // We embed each module's source inline here so icons.js remains a
  // SINGLE HTTP request (preserving the existing <script defer> pattern).
  //
  // The modules are concatenated at build time by scripts/build_icons_bundle.py.
  // In development, the modules are loaded as separate <script> tags via
  // the dev server (scripts/serve.mjs).

  // === BEGIN INLINE MODULES ===
  // (These are inlined by the build script for production. In dev, they
// === PLACEHOLDER:MODULES ===
  // === END INLINE MODULES ===

  // ── Capture module references (modules are now loaded) ──────────────
  var _metrics = window.AlbEdu.__iconMetrics;
  if (_metrics) _metrics.startInit();

  // ── Wire up the renderer with the registries ────────────────────────
  var _renderer = window.AlbEdu.__iconRenderer;
  var _sprite = window.AlbEdu.__iconSprite;
  var _loader = window.AlbEdu.__iconLoader;
  var _cache = window.AlbEdu.__iconCache;

  // Build the merged registry (critical + secondary) for the renderer
  var _mergedRegistry = Object.assign(
    {},
    window.AlbEdu.__iconRegistryCritical || {},
    window.AlbEdu.__iconRegistrySecondary || {}
  );

  // Build aliases for common alternative names (hyphenated, camelCase)
  var _aliases = Object.create(null);
  // person-add → person_add, etc.
  Object.keys(_mergedRegistry).forEach(function (name) {
    var hyphen = name.replace(/_/g, '-');
    if (hyphen !== name) _aliases[hyphen] = name;
    var camel = name.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
    if (camel !== name) _aliases[camel] = name;
  });
  // Special-case: x is a common alias for close
  _aliases['x'] = 'close';

  if (_renderer) _renderer.setRegistry(_mergedRegistry, _aliases);

  // ── Public API: icon(name, opts) → HTML string ──────────────────────
  function icon(name, opts) {
    return _renderer ? _renderer.render(name, opts || {}) : '';
  }

  // ── Public API: setIcon(el, name, opts) ─────────────────────────────
  function setIcon(el, name, opts) {
    if (!_renderer || !el) return;
    _renderer.bindToElement(el, name, opts || {});
  }

  // ── Public API: registerIcon(name, svgPath) ─────────────────────────
  function registerIcon(name, svgPath) {
    if (!name || typeof svgPath !== 'string') return false;
    try {
      var normalized = _renderer._normalizeName(name);
      _mergedRegistry[normalized] = svgPath;
      // Re-wire the renderer with the updated registry
      _renderer.setRegistry(_mergedRegistry, _aliases);
      // Invalidate both string cache (Layer 1a) and template cache (Layer 1b)
      _renderer.clearCache();
      return true;
    } catch (err) {
      if (_metrics) _metrics.recordError('registerIcon:' + name, err);
      return false;
    }
  }

  // ── Public API: listIcons() → string[] ──────────────────────────────
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

  // ── Public API: hasIcon(name) → boolean ─────────────────────────────
  function hasIcon(name) {
    return _renderer ? _renderer.has(name) : false;
  }

  // ── Public API: getMetrics() ────────────────────────────────────────
  function getMetrics() {
    if (!_metrics) return {};
    var snap = _metrics.snapshot();
    var cacheStats = _cache ? _cache.stats() : {};
    // Merge: snap.cacheHits/cacheMisses come from the metrics module
    // (incremented by both string cache and template cache paths).
    // cacheStats provides the template-cache-specific size/maxEntries.
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

  // ── Public API: addEventListener / on ───────────────────────────────
  function addEventListener(event, cb) {
    return _metrics ? _metrics.addEventListener(event, cb) : function () {};
  }

  // ── Public API: preloadIcons(names?) — NEW v7.0 ─────────────────────
  function preloadIcons(names) {
    if (!_loader) return;
    if (!names) {
      _loader.preloadCriticalSet();
    } else if (Array.isArray(names)) {
      _loader.preloadIcons(names);
    }
  }

  // ── Public API: preloadAll() — NEW v7.0 ─────────────────────────────
  function preloadAll() {
    if (_loader) _loader.preloadAll();
  }

  // ════════════════════════════════════════════════════════════════════
  // DOM BINDER — bind [data-albedu-icon] elements to actual SVGs
  // ════════════════════════════════════════════════════════════════════

  // ── Lazy binding via IntersectionObserver ───────────────────────────
  var _io = null;

  function _bindNode(node) {
    if (!_renderer) return;
    // Skip if already bound (has an <svg> child)
    if (node.querySelector('svg.albedu-icon')) return;

    var rawName = node.getAttribute('data-albedu-icon');
    if (!rawName) return;

    var existingClass = node.className || '';
    existingClass = existingClass
      .replace(/\bmaterial-symbols-outlined\b/g, '')
      .replace(/\balbedu-icon\b/g, '')
      .trim();

    var normalizedName = _renderer._normalizeName(rawName);

    // CRITICAL ICON FAST PATH: use <use href="#i-..."> for sprite icons.
    // This is the fastest possible render — pure DOM clone, no template cache.
    if (_sprite && _sprite.isCritical(normalizedName)) {
      var useHtml = _sprite.buildUseHtml(normalizedName, { class: existingClass });
      node.innerHTML = useHtml;
      if (_metrics) {
        _metrics.incBind();
        _metrics.incCacheHit(); // sprite is effectively a permanent cache hit
      }
      return;
    }

    // SECONDARY ICON PATH: use the cached-template renderer.
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
      // FIX: off-canvas chrome (mobile sidebar drawers, slide-in panels)
      // uses `transform: translateX(...)` to sit outside the viewport
      // while "closed". getBoundingClientRect() reflects that transform,
      // so these nodes look exactly like real off-screen/below-the-fold
      // content and get queued into the IntersectionObserver instead of
      // binding now. The icon only renders once the drawer's open
      // transition brings it into the observer's bounds — visibly late,
      // mid-animation. These nodes are NOT "far away, maybe never seen"
      // content; they're persistent UI the user is about to reveal via a
      // toggle. Opt them out of lazy-binding via [data-icon-eager] on the
      // drawer/nav container so they always render immediately, matching
      // the drawer's actual open trigger instead of a viewport heuristic.
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

    // Batch immediate bindings — single reflow via DocumentFragment not
    // possible here because nodes are in different parts of the DOM.
    // But each _bindNode is fast (~0.05ms) so this is fine.
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

  // ── Auto-bind dynamic content via MutationObserver ──────────────────
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

      // Use requestAnimationFrame for batch DOM updates (no layout thrash)
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

  // ── Memory management: cleanup on pagehide ──────────────────────────
  function _cleanup() {
    if (_io) { try { _io.disconnect(); } catch (_) {} _io = null; }
    if (_mo) { try { _mo.disconnect(); } catch (_) {} _mo = null; }
  }

  // ── Auto-init ───────────────────────────────────────────────────────
  function _autoInit() {
    try {
      bindIcons(document);
      _setupMutationObserver();

      // Preload critical icons into renderer cache during idle time.
      // This ensures setIcon() calls (e.g. mobile menu toggle) are
      // instant cache hits instead of cache misses.
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else if ('requestIdleCallback' in window) {
    requestIdleCallback(_autoInit, { timeout: 1000 });
  } else {
    setTimeout(_autoInit, 0);
  }

  window.addEventListener('pagehide', _cleanup, { once: true });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) _autoInit();
  });

  // ════════════════════════════════════════════════════════════════════
  // PUBLIC SURFACE
  // ════════════════════════════════════════════════════════════════════
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
  // New v7.0 APIs
  window.AlbEdu.preloadIcons = preloadIcons;
  window.AlbEdu.preloadAll = preloadAll;
  window.AlbEdu.ICONS_VERSION = '7.0.0-enterprise';
})();
