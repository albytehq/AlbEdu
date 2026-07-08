// renderer.js — clone-based SVG renderer.
// Strategy: cache parsed SVG as a <template> (one-time string parse), then
// cloneNode(true) on subsequent renders — O(1) DOM cloning, no string
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

  // Resolve icon name through alias chain (max depth 5)
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

  // Attribute escaping (XSS prevention)
  function _escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Build the full SVG string for a given inner path. SLOW path — only called on cache miss.
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

  // String cache (Layer 1a) — for the icon() string API. Avoids DOM round-trip on cache hits. Keyed identically to _cache.
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

  // Build a cached <template> for an icon. Cloning the template is much faster than re-parsing the string.
  function _createTemplate(name, innerPath, opts, classes) {
    var svgString = _buildSvgString(innerPath, opts, classes);
    var tpl = document.createElement('template');
    tpl.innerHTML = svgString;
    return { tpl: tpl, str: svgString };
  }

  // render() — returns HTML string. Uses the string cache (Layer 1a), pure O(1) on cache hit, no DOM round-trip.
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

      // Try string cache FIRST (Layer 1a) — pure O(1), no DOM
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
  // Uses the template cache (Layer 1b) — cloneNode(true) is faster than string parsing.
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
      // Clone the SVG node — zero string parsing.
      return tpl.content.firstChild.cloneNode(true);
    } catch (err) {
      if (_metrics) _metrics.recordError('renderer.renderNode:' + name, err);
      return null;
    }
  }

  // renderBatch() — build many icons into a DocumentFragment. Used by bindIcons() to batch DOM writes — minimizes reflow.
  function renderBatch(items) {
    // items: Array<{ el: Element, name: string, opts: Object }>
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var node = renderNode(item.name, item.opts);
      if (node) {
        // Wrap in a placeholder we can swap in
        var holder = document.createElement('div');
        holder.appendChild(node);
        fragment.appendChild(holder);
      }
    }
    return fragment;
  }

  // bindToElement() — replace element's content with the icon. Used by setIcon() and bindIcons(). Uses cloneNode — no innerHTML serialization when the template is cached.
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

  // Allow orchestrator to wire in the registry + aliases.
  function setRegistry(registry, aliases) {
    _registry = registry || _registry;
    _aliases = aliases || _aliases;
  }

  // Allow access to the fallback constant (for testing).
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
