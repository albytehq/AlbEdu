// resilience.js — wraps every network call (Supabase / Edge Function / Worker)
// with circuit breaker, exponential-backoff retry with jitter, timeout,
// dedupe, and cache. Presets:
//   READ      10s timeout, 3x retry, 30s total, dedupe, 60s cache
//   WRITE     30s timeout, 2x retry, 60s total, no dedupe/cache
//   HEARTBEAT 5s timeout, 1x retry (fail fast), no cache
//   SUBMIT    30s timeout, 3x retry, 90s total, no dedupe (idempotent via session_id)
//
// Usage:
//   import { resilientRead, resilientWrite } from './resilience.js';
//   const result = await resilientRead('user-profile', async (signal) => {
//     return fetch('/api/user', { signal });
//   });
//   if (result.ok) { console.log(result.value); } else { console.error(result.error); }

// Actly is loaded from public/lib/actly/ (bundled dist).
// Browser cannot resolve bare module specifiers like "actly" — must use relative path.

import { act, sanitizeErrorMessage } from '../../public/lib/actly/index.js';

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

export async function resilientRead(key, fn, overrides = {}) {
  return act(key, fn, {
    ...READ_PRESET,
    ...overrides,
    observability: _observability,
  });
}

export async function resilientWrite(key, fn, overrides = {}) {
  return act(key, fn, {
    ...WRITE_PRESET,
    ...overrides,
    observability: _observability,
  });
}

// Heartbeat runs every 15s; a failed one is non-critical because the next
// heartbeat will retry.
export async function resilientHeartbeat(key, fn, overrides = {}) {
  return act(key, fn, {
    ...HEARTBEAT_PRESET,
    ...overrides,
    observability: _observability,
  });
}

// Submit is idempotent via session_id UNIQUE constraint, so retries are safe.
export async function resilientSubmit(key, fn, overrides = {}) {
  return act(key, fn, {
    ...SUBMIT_PRESET,
    ...overrides,
    observability: _observability,
  });
}

// Call after a WRITE to ensure subsequent READs get fresh data.
export function invalidateCache(key) {
  try {
    return act.invalidate(key);
  } catch (_) {
    return false;
  }
}

export function safeErrorMessage(error) {
  return sanitizeErrorMessage(error);
}

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
