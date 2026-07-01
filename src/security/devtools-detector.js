// =============================================================================
// security/devtools-detector.js — DevTools detection (3 methods combined)
// =============================================================================
// v1.0.0 — Phase 5 Anti-Cheat Hardening
//
// 3 detection methods:
//   1. Window size diff (outer - inner > threshold) — detects docked DevTools
//   2. Debugger statement timing — detects undocked DevTools
//   3. console.log getter override — detects open console panel
//
// Philosophy: False positive > false negative
//   - If detector fails, DON'T block (graceful degradation)
//   - DevTools detection is a SIGNAL, not proof — log as violation, don't instant-block
//   - 3 detections → max violation → reset (same as keyboard shortcut)
//
// Edge cases (15):
//   1. F12 → keyboard (Guardian handles, not here)
//   2. Ctrl+Shift+I → keyboard (Guardian handles)
//   3. Browser menu → window size diff detects
//   4. Docked bottom → outerHeight - innerHeight > 160
//   5. Docked right → outerWidth - innerWidth > 160
//   6. Undocked → debugger timing detects
//   7. Closed quickly → debounce 800ms
//   8. Browser extension → false positive → log, don't block
//   9. Responsive design mode → whitelist (Firefox)
//   10. Iframe → size diff unreliable → skip
//   11. Mobile remote → can't detect → rely on heartbeat
//   12. Identity phase → don't care
//   13. Exam phase → violation
//   14. Result phase → don't care
//   15. 3 detections → max violation → reset
// =============================================================================

(function () {
  'use strict';

  const SIZE_THRESHOLD = 160;        // px difference for docked DevTools
  const DEBUGGER_THRESHOLD = 100;    // ms — if debugger takes >100ms, DevTools open
  const CHECK_INTERVAL_SIZE = 1000;  // check window size every 1s
  const CHECK_INTERVAL_DEBUGGER = 5000; // check debugger every 5s (heavier)
  const DEBOUNCE_MS = 800;           // debounce to avoid false positives
  const MAX_DEVIATIONS = 3;          // 3 DevTools detections → max violation

  const DevToolsDetector = {
    _isActive: false,
    _sizeTimer: null,
    _debuggerTimer: null,
    _debounceTimer: null,
    _detectionCount: 0,
    _lastSizeDiff: { w: 0, h: 0 },
    _onViolation: null,
    _onMaxViolation: null,
    _consoleTrapTimer: null,
    _consoleTrapSet: false,
    _origConsoleLog: null,

    start(callbacks = {}) {
      if (this._isActive) {
        console.warn('[devtools-detector] Already running');
        return;
      }
      this._isActive = true;
      this._detectionCount = 0;
      this._onViolation = callbacks.onViolation;
      this._onMaxViolation = callbacks.onMaxViolation;

      // Method 1: Window size diff (every 1s)
      this._sizeTimer = setInterval(() => this._checkSizeDiff(), CHECK_INTERVAL_SIZE);

      // Method 2: Debugger timing (every 5s)
      this._debuggerTimer = setInterval(() => this._checkDebuggerTiming(), CHECK_INTERVAL_DEBUGGER);

      // Method 3: Console getter trap (one-time setup)
      this._setupConsoleTrap();

      // Listen for window resize (catches dock/undock transitions)
      window.addEventListener('resize', () => {
        // Debounce — don't check immediately, wait for resize to settle
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._checkSizeDiff(), DEBOUNCE_MS);
      });

      // Cleanup on page unload (prevent memory leaks)
      window.addEventListener('beforeunload', () => this.stop());

      console.info('[devtools-detector] Started (3 methods active)');
    },

    stop() {
      if (!this._isActive) return;
      this._isActive = false;

      if (this._sizeTimer) {
        clearInterval(this._sizeTimer);
        this._sizeTimer = null;
      }
      if (this._debuggerTimer) {
        clearInterval(this._debuggerTimer);
        this._debuggerTimer = null;
      }
      clearTimeout(this._debounceTimer);

      this._restoreConsoleTrap();

      console.info('[devtools-detector] Stopped');
    },

    // ── Method 1: Window size diff ──
    // Detects DevTools docked at bottom (height diff) or right (width diff)
    _checkSizeDiff() {
      if (!this._isActive) return;

      // Skip if in iframe (size diff unreliable)
      if (window.self !== window.top) return;

      // Skip if responsive design mode (Firefox)
      if (window.matchMedia('(max-width: 100px)').matches) return;

      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;

      this._lastSizeDiff = { w: widthDiff, h: heightDiff };

      // DevTools docked bottom → height diff > threshold
      // DevTools docked right → width diff > threshold
      if (heightDiff > SIZE_THRESHOLD || widthDiff > SIZE_THRESHOLD) {
        // Debounce — check again after 800ms to confirm (not just transient resize)
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const wDiff = window.outerWidth - window.innerWidth;
          const hDiff = window.outerHeight - window.innerHeight;
          if (hDiff > SIZE_THRESHOLD || wDiff > SIZE_THRESHOLD) {
            this._triggerDetection('devtools_size_diff',
              `DevTools terdeteksi (size diff: ${wDiff}x${hDiff}px)`);
          }
        }, DEBOUNCE_MS);
      }
    },

    // ── Method 2: Debugger statement timing ──
    // If DevTools is open, `debugger;` statement pauses execution.
    // Measure time — if >100ms, DevTools is likely open.
    _checkDebuggerTiming() {
      if (!this._isActive) return;

      const start = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      const elapsed = performance.now() - start;

      if (elapsed > DEBUGGER_THRESHOLD) {
        this._triggerDetection('devtools_debugger',
          `DevTools terdeteksi (debugger pause: ${elapsed.toFixed(0)}ms)`);
      }
    },

    // ── Method 3: Console getter trap ──
    // Override console.log with a getter. If DevTools console panel is open,
    // it renders the log object, triggering the getter.
    _setupConsoleTrap() {
      if (this._consoleTrapSet) return;
      this._consoleTrapSet = true;
      this._origConsoleLog = console.log;

      let triggered = false;
      const self = this;
      const trapLog = function () {
        if (!triggered && self._isActive) {
          triggered = true;
          // DevTools console is open (it rendered this log)
          // Don't trigger immediately — console could be open for legitimate reasons
          // Just log it as a soft signal
          console.info('[devtools-detector] Console panel may be open');
          setTimeout(() => { triggered = false; }, 5000); // reset after 5s
        }
        // Call original
        return self._origConsoleLog.apply(console, arguments);
      };

      // Only trap if DevTools is likely open (combine with size diff)
      // We don't want to trap console.log permanently — too aggressive
      // Instead, we use a passive approach: create a dummy object with getter
      const devtools = /./;
      devtools.toString = function () {
        if (self._isActive) {
          self._triggerDetection('devtools_console',
            'DevTools console terdeteksi (object getter triggered)');
        }
        return '';
      };
      // Periodically log the trap object — if console open, getter fires
      this._consoleTrapTimer = setInterval(() => {
        if (self._isActive) {
          console.log('%c', devtools);
        }
      }, CHECK_INTERVAL_DEBUGGER);
    },

    _restoreConsoleTrap() {
      // Clear the console trap interval to prevent memory leaks
      if (this._consoleTrapTimer) {
        clearInterval(this._consoleTrapTimer);
        this._consoleTrapTimer = null;
      }
      this._consoleTrapSet = false;
    },

    _triggerDetection(type, message) {
      if (!this._isActive) return;

      this._detectionCount++;
      console.warn(`[devtools-detector] Detection #${this._detectionCount}: ${type}`);

      this._onViolation?.({
        type,
        message,
        count: this._detectionCount,
        max: MAX_DEVIATIONS,
        isFinal: this._detectionCount >= MAX_DEVIATIONS,
      });

      if (this._detectionCount >= MAX_DEVIATIONS) {
        this._isActive = false;
        this._onMaxViolation?.();
      }
    },

    getDetectionCount() {
      return this._detectionCount;
    },

    resetDetectionCount() {
      this._detectionCount = 0;
    },
  };

  window.DevToolsDetector = DevToolsDetector;
})();
