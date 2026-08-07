// cache.js — in-memory LRU cache of parsed SVG <template> elements.
// Subsequent renders clone the cached template via cloneNode(true) — zero string parsing,
// zero attribute serialization. LRU with default cap of 256 entries (~50KB max memory).

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.AlbEdu && window.AlbEdu.__iconCache) return; // idempotent

  var MAX_ENTRIES = 256;
  var _map = new Map();        // insertion-ordered (used for LRU eviction)
  var _hits = 0;
  var _misses = 0;

  function _key(name, size, strokeWidth, classes, label) {
    // Composite cache key. Includes all options that affect rendered SVG output,
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
