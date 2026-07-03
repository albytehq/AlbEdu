// =============================================================================
// resilience.js — AlbEdu Production Hardening · The Surgeon (Stability-First)
// =============================================================================
// Wrapper Actly 1.2.0 untuk semua network calls di AlbEdu.
// Setiap call ke Supabase / Edge Function / Worker dilindungi oleh:
//   - Circuit breaker (stop setelah N failures, cooldown)
//   - Retry exponential backoff + jitter (tidak hammer server saat down)
//   - Timeout (fail fast, tidak hang selamanya)
//   - Dedupe (collapse concurrent calls ke satu)
//   - Fallback (graceful degradation, return default saat service down)
//
// Policy presets:
//   READ    — 10s timeout, 3x retry, 30s total, dedupe, 60s cache, circuit breaker
//   WRITE   — 30s timeout, 2x retry, 60s total, no dedupe, no cache, circuit breaker
//   HEARTBEAT — 5s timeout, 1x retry (fail fast), no cache, circuit breaker
//   SUBMIT  — 30s timeout, 3x retry, 90s total, no dedupe (idempotent via session_id),
//             circuit breaker, fallback: queue to IndexedDB
//
// Usage:
//   import { resilientRead, resilientWrite, resilientHeartbeat, resilientSubmit } from './resilience.js';
//
//   const result = await resilientRead('user-profile', async (signal) => {
//     return fetch('/api/user', { signal });
//   });
//   if (result.ok) { console.log(result.value); }
//   else { console.error(result.error); }
// =============================================================================

// Actly is loaded from public/lib/actly/ (bundled dist).
// Browser cannot resolve bare module specifiers like "actly" — must use relative path.

import { act, sanitizeErrorMessage } from '../../public/lib/actly/index.js';

// ── Policy Presets ──────────────────────────────────────────────────────

const READ_PRESET = {
  retry: {
    attempts: 3,
    delayMs: 500,
    backoff: 'exponential',
    maxDelay: 5_000,
    jitter: 'full',
    shouldRetry: (err) => {
      // Don't retry 4xx (client errors) — they won't succeed
      if (err?.status >= 400 && err?.status < 500) return false;
      // Don't retry aborted requests
      if (err?.name === 'AbortError') return false;
      return true;
    },
  },
  timeout: { ms: 10_000 },
  totalTimeout: { ms: 30_000 },
  dedupe: { enabled: true, inflightTtl: 15_000 },
  cache: { ttl: 60_000 },
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 30_000,
    resetTimeoutMs: 60_000,
  },
};

const WRITE_PRESET = {
  retry: {
    attempts: 2,
    delayMs: 1_000,
    backoff: 'exponential',
    maxDelay: 10_000,
    jitter: 'full',
    shouldRetry: (err) => {
      if (err?.status >= 400 && err?.status < 500) return false;
      if (err?.name === 'AbortError') return false;
      return true;
    },
  },
  timeout: { ms: 30_000 },
  totalTimeout: { ms: 60_000 },
  circuitBreaker: {
    threshold: 3,
    cooldownMs: 60_000,
    resetTimeoutMs: 120_000,
  },
};

const HEARTBEAT_PRESET = {
  retry: {
    attempts: 2,
    delayMs: 1_500,
    backoff: 'exponential',
    maxDelay: 3_000,
    jitter: 'full',
    shouldRetry: (err) => {
      if (err?.status === 401 || err?.status === 403) return false;
      if (err?.name === 'AbortError') return false;
      return true;
    },
  },
  timeout: { ms: 5_000 },
  totalTimeout: { ms: 10_000 },
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 15_000,
    resetTimeoutMs: 30_000,
  },
};

const SUBMIT_PRESET = {
  retry: {
    attempts: 3,
    delayMs: 1_500,
    backoff: 'exponential',
    maxDelay: 8_000,
    jitter: 'full',
    shouldRetry: (err) => {
      // Don't retry 409 (conflict — already submitted), 400 (validation)
      if (err?.status === 409) return false;
      if (err?.status >= 400 && err?.status < 500) return false;
      if (err?.name === 'AbortError') return false;
      return true;
    },
  },
  timeout: { ms: 30_000 },
  totalTimeout: { ms: 90_000 },
  circuitBreaker: {
    threshold: 3,
    cooldownMs: 60_000,
    resetTimeoutMs: 120_000,
  },
};

// ── Observability hooks (shared by all presets) ─────────────────────────

const _observability = {
  onFinalFailure: (e) => {
    const safeMsg = sanitizeErrorMessage(e.error);
    console.error(`[resilience] FAIL key=${e.key} traceId=${e.traceId} failedBy=${e.failedBy} attempts=${e.attempts} duration=${e.durationMs}ms error=${safeMsg}`);
  },
  onFinalSuccess: (e) => {
    if (e.attempts > 1) {
      console.info(`[resilience] OK (recovered) key=${e.key} attempts=${e.attempts} duration=${e.durationMs}ms`);
    }
  },
};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a READ operation with resilience policies.
 * Suitable for: fetching user data, assessment data, question bank, etc.
 *
 * @param {string} key — unique identifier for dedupe + cache
 * @param {function} fn — async function receiving AbortSignal
 * @param {object} [overrides] — override preset options
 * @returns {Promise<{ok: boolean, value?: any, error?: unknown, attempts: number}>}
 */
export async function resilientRead(key, fn, overrides = {}) {
  return act(key, fn, {
    ...READ_PRESET,
    ...overrides,
    observability: _observability,
  });
}

/**
 * Execute a WRITE operation with resilience policies.
 * Suitable for: creating assessments, updating profile, deleting questions.
 *
 * @param {string} key — unique identifier
 * @param {function} fn — async function receiving AbortSignal
 * @param {object} [overrides]
 */
export async function resilientWrite(key, fn, overrides = {}) {
  return act(key, fn, {
    ...WRITE_PRESET,
    ...overrides,
    observability: _observability,
  });
}

/**
 * Execute a HEARTBEAT with resilience policies.
 * Fail fast — 5s timeout, minimal retry. Heartbeat runs every 15s,
 * a failed one is non-critical (next heartbeat will retry).
 *
 * @param {string} key — unique identifier (e.g. `heartbeat:${sessionId}`)
 * @param {function} fn — async function receiving AbortSignal
 * @param {object} [overrides]
 */
export async function resilientHeartbeat(key, fn, overrides = {}) {
  return act(key, fn, {
    ...HEARTBEAT_PRESET,
    ...overrides,
    observability: _observability,
  });
}

/**
 * Execute a SUBMIT operation with resilience policies.
 * Most critical write — 3x retry, 90s total budget. Submit is idempotent
 * via session_id UNIQUE constraint, so retries are safe.
 *
 * @param {string} key — unique identifier (e.g. `submit:${sessionId}`)
 * @param {function} fn — async function receiving AbortSignal
 * @param {object} [overrides]
 */
export async function resilientSubmit(key, fn, overrides = {}) {
  return act(key, fn, {
    ...SUBMIT_PRESET,
    ...overrides,
    observability: _observability,
  });
}

/**
 * Invalidate cached value for a key.
 * Call this after a WRITE to ensure subsequent READs get fresh data.
 *
 * @param {string} key
 */
export function invalidateCache(key) {
  try {
    return act.invalidate(key);
  } catch (_) {
    return false;
  }
}

/**
 * Sanitize an error for user-facing display.
 * Strips stack traces, internal paths, and sensitive details.
 *
 * @param {unknown} error
 * @returns {string} safe error message
 */
export function safeErrorMessage(error) {
  return sanitizeErrorMessage(error);
}

// ── Expose to window for non-module scripts ─────────────────────────────

if (typeof window !== 'undefined') {
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.resilience = {
    read: resilientRead,
    write: resilientWrite,
    heartbeat: resilientHeartbeat,
    submit: resilientSubmit,
    invalidate: invalidateCache,
    sanitizeError: safeErrorMessage,
  };
}
