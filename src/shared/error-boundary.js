// error-boundary.js — global error boundary + offline detection.
// Catches window.onerror, unhandledrejection, and resource-load failures.
// Shows user-facing toast + tracks error count for SLO budget.

(function () {
  'use strict';

  if (window.__albeduErrorBoundary) return;
  window.__albeduErrorBoundary = true;

  const _errorCount = { total: 0, byType: {} };
  const ERROR_BUDGET_PER_1000 = 1; // SLO: 1 error per 1000 requests (99.9%)

  function _trackError(type) {
    _errorCount.total++;
    _errorCount.byType[type] = (_errorCount.byType[type] || 0) + 1;

    if (_errorCount.total % 100 === 0) {
      console.warn(`[error-boundary] Error count: ${_errorCount.total}`, _errorCount.byType);
    }
  }

  function _showErrorToast(message) {
    // Throttle to max 1 toast per 5 seconds to avoid spamming.
    if (_lastErrorToast && Date.now() - _lastErrorToast < 5000) return;
    _lastErrorToast = Date.now();

    try {
      if (window.notify?.error) {
        window.notify.error('Terjadi Kesalahan', message || 'Coba lagi dalam beberapa saat.', 5000);
      }
    } catch (_) { /* notify not ready — silent */ }
  }
  let _lastErrorToast = 0;

  // Synchronous errors
  window.addEventListener('error', function (e) {
    _trackError('error');

    const safeMsg = _sanitizeMessage(e.message);
    console.error('[error-boundary] window.onerror:', {
      message: safeMsg,
      filename: e.filename ? e.filename.split('/').pop() : 'unknown',
      lineno: e.lineno,
      colno: e.colno,
    });

    // Don't show toast for script loading errors (usually non-critical)
    if (e.target && e.target.tagName === 'SCRIPT') return;

    _showErrorToast('Terjadi kesalahan sistem. Tim kami telah diberi tahu.');
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', function (e) {
    _trackError('unhandledrejection');

    const reason = e.reason;
    const safeMsg = _sanitizeMessage(reason?.message || String(reason));

    // Don't log full reason — may contain sensitive data
    console.error('[error-boundary] unhandledrejection:', { message: safeMsg });

    // Our toast is friendlier than the default browser warning.
    e.preventDefault();

    // AbortError is expected behavior, don't toast it.
    if (reason?.name === 'AbortError') return;

    _showErrorToast('Operasi gagal. Periksa koneksi internet Anda.');
  });

  // Resource-load failures (images, scripts, css). Use capture phase —
  // these don't bubble.
  window.addEventListener('error', function (e) {
    const target = e.target;
    if (target && target.tagName) {
      const tag = target.tagName.toLowerCase();
      if (tag === 'img' || tag === 'script' || tag === 'link') {
        _trackError('resource');
        console.warn(`[error-boundary] Resource failed: ${tag} src=${target.src || target.href}`);

        // Hide broken image without spamming a toast.
        if (tag === 'img' && target.parentNode) {
          target.style.display = 'none';
        }
      }
    }
  }, true);

  function _sanitizeMessage(msg) {
    // Strip stack traces + cap length so we never leak internals to users.
    if (!msg) return 'Unknown error';
    const str = String(msg);
    return str
      .replace(/at\s+.*?\(.*?\)/g, '')
      .replace(/\n\s*at\s+.*/g, '')
      .trim()
      .substring(0, 200);
  }

  // Offline banner
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
    document.dispatchEvent(new CustomEvent('albedu:online'));
  });

  if (!_isOnline()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _showOfflineBanner, { once: true });
    } else {
      _showOfflineBanner();
    }
  }

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.errorBoundary = {
    getErrorCount: () => _errorCount.total,
    getErrorBreakdown: () => ({ ..._errorCount.byType }),
    isOnline: _isOnline,
    sanitizeMessage: _sanitizeMessage,
  };
})();
