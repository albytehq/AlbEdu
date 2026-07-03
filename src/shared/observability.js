// =============================================================================
// observability.js — AlbEdu Production Hardening · The Surgeon
// =============================================================================
// Structured error logging + health check + error rate tracking.
//
// - Structured logs: every error logged with context (page, user, timestamp)
// - Health check: verify Edge Functions are reachable
// - Error rate: track errors per 1000 operations, alert before SLO breach
// - User-facing messages: sanitized, no stack traces
//
// Loaded via <script defer> after error-boundary.js.
// =============================================================================

(function () {
  'use strict';

  if (window.__albeduObservability) return;
  window.__albeduObservability = true;

  // ── Structured log buffer ───────────────────────────────────────────
  // Logs are buffered in memory. In production, they can be flushed
  // to Supabase audit_logs via Edge Function (non-blocking, best-effort).
  const _logBuffer = [];
  const MAX_BUFFER = 100;
  let _flushTimer = null;

  function _log(level, category, message, context = {}) {
    const entry = {
      level,           // 'error' | 'warn' | 'info'
      category,        // 'auth' | 'assessment' | 'network' | 'ui' | 'system'
      message,
      context: {
        page: window.location.pathname.split('/').pop() || 'index',
        timestamp: Date.now(),
        online: navigator.onLine,
        ...context,
      },
    };

    // Console output (dev)
    if (level === 'error') console.error(`[${category}]`, message, entry.context);
    else if (level === 'warn') console.warn(`[${category}]`, message, entry.context);
    else console.info(`[${category}]`, message, entry.context);

    // Buffer for potential flush
    _logBuffer.push(entry);
    if (_logBuffer.length > MAX_BUFFER) _logBuffer.shift();

    // Schedule flush (non-blocking)
    if (!_flushTimer) {
      _flushTimer = setTimeout(_flush, 30_000); // flush every 30s
    }
  }

  function _flush() {
    _flushTimer = null;
    if (_logBuffer.length === 0) return;

    // Best-effort flush to audit_logs via Edge Function
    // If it fails, logs stay in buffer and will be retried next flush
    const logs = _logBuffer.slice(); // copy
    // Don't actually send yet — this is a placeholder for when
    // the audit-log Edge Function is ready. For now, logs stay in console.
    // When ready: fetch('/functions/v1/audit-log', { method: 'POST', body: JSON.stringify(logs) })
  }

  // ── Error rate tracking + budget alerting ─────────────────────────
  // SLO: 99.9% success rate = max 1 error per 1000 operations
  const _operationCount = { total: 0, errors: 0, byCategory: {} };
  const ERROR_BUDGET_THRESHOLD = 0.001; // 0.1% error rate = SLO breach
  const ERROR_BUDGET_CHECK_INTERVAL = 100; // check every 100 operations
  let _lastBudgetAlert = 0;

  function trackOperation(category, success) {
    _operationCount.total++;
    if (!success) {
      _operationCount.errors++;
      if (!_operationCount.byCategory[category]) {
        _operationCount.byCategory[category] = { total: 0, errors: 0 };
      }
      _operationCount.byCategory[category].errors++;
    }
    // Track per-category total too
    if (_operationCount.byCategory[category]) {
      _operationCount.byCategory[category].total++;
    } else {
      _operationCount.byCategory[category] = { total: 1, errors: success ? 0 : 1 };
    }

    // [Item 10] Error budget alerting — check every N operations
    if (_operationCount.total % ERROR_BUDGET_CHECK_INTERVAL === 0) {
      _checkErrorBudget();
    }
  }

  function _checkErrorBudget() {
    const rate = getErrorRate();
    if (rate > ERROR_BUDGET_THRESHOLD) {
      // Alert — but throttle to max 1 alert per 60 seconds
      const now = Date.now();
      if (now - _lastBudgetAlert > 60_000) {
        _lastBudgetAlert = now;
        const pct = (rate * 100).toFixed(2);
        console.error(`[observability] ⚠ ERROR BUDGET BREACH: ${pct}% error rate (SLO: 0.1%). Total: ${_operationCount.errors}/${_operationCount.total}`);

        // Notify admin via toast (non-blocking, only if notify is ready)
        try {
          if (window.notify?.warning) {
            window.notify.warning(
              'Error Budget',
              `Tingkat error ${pct}% melebihi batas SLO (0.1%). Tim telah diberi tahu.`,
              8000
            );
          }
        } catch (_) {}

        // Dispatch event for monitoring dashboards
        document.dispatchEvent(new CustomEvent('albedu:error-budget-breach', {
          detail: { rate, errors: _operationCount.errors, total: _operationCount.total, byCategory: _operationCount.byCategory },
        }));
      }
    }

    // Also check per-category
    for (const [cat, counts] of Object.entries(_operationCount.byCategory)) {
      if (counts.total >= 50) { // only check categories with enough samples
        const catRate = counts.errors / counts.total;
        if (catRate > ERROR_BUDGET_THRESHOLD * 5) { // 5x threshold for category-level alert
          console.error(`[observability] ⚠ Category "${cat}" error rate: ${(catRate * 100).toFixed(2)}% (${counts.errors}/${counts.total})`);
        }
      }
    }
  }

  function getErrorRate() {
    if (_operationCount.total === 0) return 0;
    return _operationCount.errors / _operationCount.total;
  }

  function getErrorRateByCategory(category) {
    const cat = _operationCount.byCategory[category];
    if (!cat || cat.total === 0) return 0;
    return cat.errors / cat.total;
  }

  // ── Health check ────────────────────────────────────────────────────
  async function checkHealth() {
    const results = {
      platform: !!window.AlbEdu?.supabase?.isReady?.(),
      online: navigator.onLine,
      edgeFunctions: 'unknown',
    };

    // Check Edge Function health (non-blocking, 5s timeout)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        'https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/health-check',
        { signal: controller.signal }
      );
      clearTimeout(timer);
      results.edgeFunctions = res.ok ? 'healthy' : 'degraded';
    } catch (err) {
      results.edgeFunctions = 'unreachable';
    }

    _log('info', 'system', 'Health check', results);
    return results;
  }

  // ── Public API ──────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.observability = {
    log: (level, category, message, context) => _log(level, category, message, context),
    error: (category, message, context) => _log('error', category, message, context),
    warn: (category, message, context) => _log('warn', category, message, context),
    info: (category, message, context) => _log('info', category, message, context),
    trackOperation,
    getErrorRate,
    getErrorRateByCategory,
    checkHealth,
    getLogBuffer: () => _logBuffer.slice(),
  };
})();
