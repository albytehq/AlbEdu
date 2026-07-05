// =============================================================================
// metrics.js — AlbEdu Icon System · Performance Observability
// =============================================================================
// Responsibility:
//   Collect, aggregate, and expose performance metrics for every icon render.
//   Used by the benchmark suite (scripts/benchmark_icons.mjs) and the
//   runtime debug overlay (AlbEdu.getMetrics()).
//
// Tracked metrics:
//   - iconsRendered:        total icon() calls that succeeded
//   - iconsBound:           total DOM bindings via bindIcons()
//   - cacheHits / cacheMisses: Layer 1 memory cache stats
//   - renderTimeUs:         total time spent in renderer (microseconds)
//   - bindTimeMs:           last bindIcons() duration
//   - initTimeMs:           total module init duration
//   - missingIcons:         map of icon-name → request count
//   - errors:               capped array of caught errors (max 50)
//
// Performance marks (via Performance API when available):
//   'albedu:icons:init'        — module init start
//   'albedu:icons:bind'        — bindIcons() start
//   'albedu:icons:render'      — individual icon render (sampled)
//
// Public API (attached to window.AlbEdu.__iconMetrics):
//   .incRender()             → void
//   .incBind()               → void
//   .incCacheHit() / .incCacheMiss()
//   .recordRenderTime(us)    → void
//   .recordMissing(name)     → void
//   .recordError(ctx, err)   → void
//   .startBind() / .endBind()
//   .startInit() / .endInit()
//   .snapshot()              → IconMetrics (immutable)
//   .reset()                 → void
//   .addEventListener(event, cb) → unsubscribe
//   .emit(event, detail)
// =============================================================================

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
