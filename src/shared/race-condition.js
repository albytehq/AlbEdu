// =============================================================================
// race-condition.js — AlbEdu Production Hardening · The Surgeon
// =============================================================================
// Race condition prevention utilities:
//   - Mutex: prevent concurrent execution of the same async operation
//   - Debounce: collapse rapid calls into one (trailing edge)
//   - AbortControllerManager: abort in-flight requests on navigation
//   - IdempotencyGuard: prevent duplicate submit
//
// Usage:
//   const mutex = createMutex('submit-assessment');
//   const result = await mutex.run(async () => { ... });
//   if (!result) { /* another submit already in progress */ }
// =============================================================================

(function () {
  'use strict';

  // ── Mutex — prevent concurrent execution ────────────────────────────
  // Returns a function that wraps async operations. If the same mutex
  // is already running, the second call returns null immediately.
  const _mutexes = new Map();

  function createMutex(name) {
    if (_mutexes.has(name)) return _mutexes.get(name);
    let _locked = false;
    let _queue = [];

    const mutex = {
      get isLocked() { return _locked; },

      async run(fn) {
        if (_locked) {
          // Already running — skip (caller should handle null)
          return null;
        }
        _locked = true;
        try {
          const result = await fn();
          return result;
        } finally {
          _locked = false;
          // Process queue (if any)
          if (_queue.length > 0) {
            const next = _queue.shift();
            next.resolve(mutex.run(next.fn));
          }
        }
      },

      // Queue version — waits for lock instead of skipping
      async queue(fn) {
        if (!_locked) return mutex.run(fn);
        return new Promise((resolve) => {
          _queue.push({ fn, resolve });
        });
      },

      reset() {
        _locked = false;
        _queue = [];
      },
    };

    _mutexes.set(name, mutex);
    return mutex;
  }

  // ── Debounce (trailing edge) ────────────────────────────────────────
  // Collapse rapid calls into one. The last call wins.
  function createDebounce(delayMs) {
    let _timer = null;
    let _lastArgs = null;

    return {
      call(fn, ...args) {
        _lastArgs = args;
        if (_timer) clearTimeout(_timer);
        _timer = setTimeout(() => {
          _timer = null;
          fn(..._lastArgs);
        }, delayMs);
      },
      cancel() {
        if (_timer) { clearTimeout(_timer); _timer = null; }
      },
      flush() {
        if (_timer) {
          clearTimeout(_timer);
          _timer = null;
          // Can't flush without the fn reference — caller must handle
        }
      },
    };
  }

  // ── AbortControllerManager ──────────────────────────────────────────
  // Track all in-flight AbortControllers. On page navigation (pagehide),
  // abort all pending requests to prevent ghost callbacks.
  const _controllers = new Set();

  function createAbortable() {
    const controller = new AbortController();
    _controllers.add(controller);

    const originalAbort = controller.abort.bind(controller);
    controller.abort = function () {
      _controllers.delete(controller);
      originalAbort();
    };

    return controller;
  }

  function abortAll() {
    _controllers.forEach(c => {
      try { c.abort(); } catch (_) {}
    });
    _controllers.clear();
  }

  // On page hide (navigation, tab close, bfcache) — abort all pending
  window.addEventListener('pagehide', function () {
    abortAll();
  }, { passive: true });

  // ── IdempotencyGuard ────────────────────────────────────────────────
  // Track operation keys that have been executed. Prevent duplicate
  // execution of the same operation (e.g., double-click submit).
  const _executed = new Set();
  const _inflight = new Set();

  function createIdempotencyGuard() {
    return {
      // Check if operation is already done or in-flight
      canExecute(key) {
        return !_executed.has(key) && !_inflight.has(key);
      },

      // Mark as in-flight (call before starting async operation)
      markInflight(key) {
        if (_inflight.has(key)) return false;
        _inflight.add(key);
        return true;
      },

      // Mark as completed (call after async operation finishes)
      markDone(key) {
        _inflight.delete(key);
        _executed.add(key);
        // Auto-cleanup after 5 minutes (allow retry after cooldown)
        setTimeout(() => _executed.delete(key), 5 * 60 * 1000);
      },

      // Mark as failed (allow retry)
      markFailed(key) {
        _inflight.delete(key);
        // Don't add to _executed — allow retry
      },

      // Check if currently in-flight
      isInflight(key) {
        return _inflight.has(key);
      },

      // Check if already completed
      isDone(key) {
        return _executed.has(key);
      },

      // Reset (for testing or manual recovery)
      reset(key) {
        _inflight.delete(key);
        _executed.delete(key);
      },
    };
  }

  // ── Public API ──────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.raceCondition = {
    createMutex,
    createDebounce,
    createAbortable,
    abortAll,
    createIdempotencyGuard,
  };
})();
