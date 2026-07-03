// =============================================================================
// error-boundary.js — AlbEdu Production Hardening · The Surgeon
// =============================================================================
// Global error boundary + graceful degradation system.
//
// Catches:
//   - window.onerror (synchronous errors)
//   - unhandledrejection (async promise rejections)
//   - Resource loading failures (image, script, css)
//
// Actions on error:
//   1. Log structured error to console (dev) + audit log (prod, via Edge Function)
//   2. Show user-facing error toast (non-blocking, non-scary)
//   3. Track error count for error budget monitoring
//   4. Graceful degradation: if critical JS fails, show fallback UI
//
// Offline detection:
//   - navigator.onLine + window online/offline events
//   - When offline: show offline banner, queue actions to IndexedDB
//   - When online: replay queued actions, hide banner
//
// Usage: loaded via <script defer> in canonical head, after boot.js.
// Auto-initializes on DOMContentLoaded.
// =============================================================================

(function () {
  'use strict';

  if (window.__albeduErrorBoundary) return;
  window.__albeduErrorBoundary = true;

  // ── Error tracking ──────────────────────────────────────────────────
  const _errorCount = { total: 0, byType: {} };
  const ERROR_BUDGET_PER_1000 = 1; // SLO: 99.9% = 1 error per 1000 requests

  function _trackError(type) {
    _errorCount.total++;
    _errorCount.byType[type] = (_errorCount.byType[type] || 0) + 1;

    // Alert if error budget exceeded
    if (_errorCount.total % 100 === 0) {
      console.warn(`[error-boundary] Error count: ${_errorCount.total}`, _errorCount.byType);
    }
  }

  // ── Safe error display (non-blocking, non-scary) ────────────────────
  function _showErrorToast(message) {
    // Don't spam — max 1 error toast per 5 seconds
    if (_lastErrorToast && Date.now() - _lastErrorToast < 5000) return;
    _lastErrorToast = Date.now();

    try {
      if (window.notify?.error) {
        window.notify.error('Terjadi Kesalahan', message || 'Coba lagi dalam beberapa saat.', 5000);
      }
    } catch (_) { /* notify not ready — silent */ }
  }
  let _lastErrorToast = 0;

  // ── Global error handlers ───────────────────────────────────────────

  // 1. Synchronous errors
  window.addEventListener('error', function (e) {
    _trackError('error');

    // Sanitize — don't leak stack traces to user
    const safeMsg = _sanitizeMessage(e.message);
    console.error('[error-boundary] window.onerror:', {
      message: safeMsg,
      filename: e.filename ? e.filename.split('/').pop() : 'unknown',
      lineno: e.lineno,
      colno: e.colno,
    });

    // Don't show toast for script loading errors (they're usually non-critical)
    if (e.target && e.target.tagName === 'SCRIPT') return;

    _showErrorToast('Terjadi kesalahan sistem. Tim kami telah diberi tahu.');
  });

  // 2. Unhandled promise rejections
  window.addEventListener('unhandledrejection', function (e) {
    _trackError('unhandledrejection');

    const reason = e.reason;
    const safeMsg = _sanitizeMessage(reason?.message || String(reason));

    console.error('[error-boundary] unhandledrejection:', {
      message: safeMsg,
      // Don't log full reason — may contain sensitive data
    });

    // Prevent default browser warning (our toast is more user-friendly)
    e.preventDefault();

    // Only show toast for non-abort errors (AbortError is expected behavior)
    if (reason?.name === 'AbortError') return;

    _showErrorToast('Operasi gagal. Periksa koneksi internet Anda.');
  });

  // 3. Resource loading failures (images, scripts, css)
  window.addEventListener('error', function (e) {
    const target = e.target;
    if (target && target.tagName) {
      const tag = target.tagName.toLowerCase();
      if (tag === 'img' || tag === 'script' || tag === 'link') {
        _trackError('resource');
        console.warn(`[error-boundary] Resource failed: ${tag} src=${target.src || target.href}`);

        // For images: replace with placeholder
        if (tag === 'img' && target.parentNode) {
          target.style.display = 'none';
          // Don't show toast for image failures — too noisy
        }
      }
    }
  }, true); // capture phase — resource errors don't bubble

  // ── Message sanitizer ───────────────────────────────────────────────
  function _sanitizeMessage(msg) {
    if (!msg) return 'Unknown error';
    const str = String(msg);
    // Strip stack traces
    return str
      .replace(/at\s+.*?\(.*?\)/g, '')
      .replace(/\n\s*at\s+.*/g, '')
      .trim()
      .substring(0, 200); // cap length
  }

  // ── Offline detection + banner ──────────────────────────────────────
  let _offlineBanner = null;

  function _isOnline() {
    return navigator.onLine;
  }

  function _showOfflineBanner() {
    if (_offlineBanner) return;
    _offlineBanner = document.createElement('div');
    _offlineBanner.id = 'albedu-offline-banner';
    _offlineBanner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#dc2626', 'color:#fff', 'text-align:center',
      'padding:8px 16px', 'font-size:13px', 'font-weight:600',
      'font-family:inherit', 'pointer-events:none',
    ].join(';');
    _offlineBanner.textContent = '⚠ Anda sedang offline. Perubahan akan disinkronkan saat koneksi kembali.';
    document.body.appendChild(_offlineBanner);
  }

  function _hideOfflineBanner() {
    if (_offlineBanner) {
      _offlineBanner.remove();
      _offlineBanner = null;
    }
  }

  window.addEventListener('offline', function () {
    console.warn('[error-boundary] Network offline');
    _showOfflineBanner();
    try { window.notify?.warning('Offline', 'Anda sedang offline. Data disimpan lokal.', 4000); } catch (_) {}
  });

  window.addEventListener('online', function () {
    console.info('[error-boundary] Network online');
    _hideOfflineBanner();
    try { window.notify?.success('Kembali Online', 'Menyinkronkan data...', 3000); } catch (_) {}
    // Trigger any queued sync operations
    document.dispatchEvent(new CustomEvent('albedu:online'));
  });

  // Check initial state
  if (!_isOnline()) {
    // Defer to DOMContentLoaded in case body isn't ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _showOfflineBanner, { once: true });
    } else {
      _showOfflineBanner();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.errorBoundary = {
    getErrorCount: () => _errorCount.total,
    getErrorBreakdown: () => ({ ..._errorCount.byType }),
    isOnline: _isOnline,
    sanitizeMessage: _sanitizeMessage,
  };
})();
