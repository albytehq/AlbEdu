// race-condition.js — mutex, debounce, AbortControllerManager, IdempotencyGuard.
// Usage:
//   const mutex = createMutex('submit-assessment');
//   const result = await mutex.run(async () => { ... });
//   if (!result) { /* another submit already in progress */ }

(function () {
  'use strict';

  // Mutex — prevent concurrent execution. Returns a wrapper; second call
  // while locked returns null immediately.
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

      // Queue version — waits for the lock instead of skipping.
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

  // Debounce (trailing edge). Last call wins.
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

  // AbortControllerManager — track all in-flight AbortControllers and abort
  // them on pagehide to prevent ghost callbacks after navigation.
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

  // IdempotencyGuard — track operation keys to prevent duplicate execution
  // (for example, double-click submit).
  const _executed = new Set();
  const _inflight = new Set();

  function createIdempotencyGuard() {
    return {
      canExecute(key) {
        return !_executed.has(key) && !_inflight.has(key);
      },

      markInflight(key) {
        if (_inflight.has(key)) return false;
        _inflight.add(key);
        return true;
      },

      markDone(key) {
        _inflight.delete(key);
        _executed.add(key);
        // Auto-cleanup after 5 minutes — allows retry after cooldown.
        setTimeout(() => _executed.delete(key), 5 * 60 * 1000);
      },

      markFailed(key) {
        _inflight.delete(key);
        // Don't add to _executed — allow retry.
      },

      isInflight(key) {
        return _inflight.has(key);
      },

      isDone(key) {
        return _executed.has(key);
      },

      reset(key) {
        _inflight.delete(key);
        _executed.delete(key);
      },
    };
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.raceCondition = {
    createMutex,
    createDebounce,
    createAbortable,
    abortAll,
    createIdempotencyGuard,
  };
})();
