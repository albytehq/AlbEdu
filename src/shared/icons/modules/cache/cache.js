// =============================================================================
// cache.js — AlbEdu Icon System · Layer 1: In-Memory Template Cache
// =============================================================================
// Responsibility:
//   Cache parsed SVG <template> elements keyed by (name + size + strokeWidth).
//   Subsequent renders clone the cached template via `cloneNode(true)` —
//   zero string parsing, zero attribute serialization, zero layout thrash.
//
// Architecture:
//   request icon → cache.get(key) → if hit: cloneNode → else: build → cache.set
//
// Cache layers (defense-in-depth):
//   Layer 1: This module — in-memory DocumentFragment cache (sub-millisecond)
//   Layer 2: Browser HTTP cache — immutable assets (handled by service worker)
//   Layer 3: Service Worker cache — offline support (public/service-worker.js)
//   Layer 4: HTTP cache — long-term immutable caching (Cache-Control headers)
//
// Eviction:
//   LRU with default cap of 256 entries. Each entry is a <template> element
//   (~200 bytes). 256 × 200B = ~50KB max memory — negligible.
//
// Public API (attached to window.AlbEdu.__iconCache):
//   .get(key)                → HTMLTemplateElement | null
//   .set(key, template)      → void
//   .has(key)                → boolean
//   .size                    → number (current entry count)
//   .clear()                 → void
//   .stats()                 → { hits, misses, hitRate, size }
// =============================================================================

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconCache) return; // idempotent

  var MAX_ENTRIES = 256;
  var _map = new Map();        // insertion-ordered (used for LRU eviction)
  var _hits = 0;
  var _misses = 0;

  function _key(name, size, strokeWidth, classes, label) {
    // Build a composite cache key. Includes all options that affect the
    // rendered SVG output so the cache is never wrong.
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
    // Evict oldest entry if at capacity
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
