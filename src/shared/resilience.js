// shared/resilience.js — actly 1.3.0 wrapper for AlbEdu fetch sites
//
// Wraps fetch() calls with retry + timeout + circuit breaker + dedupe.
// Phase 3 wave architecture: peserta client only sends answer-change events,
// not heartbeat timer. Each answer-change PATCH is wrapped with this module
// for resilience (retry on network blip, circuit breaker if Supabase down).
//
// Usage:
//   import { callEF, patchSession, selectSession } from '../shared/resilience.js';
//
//   const res = await callEF('submit-assessment', { session_id, answers });
//   if (res.ok) { ... } else { ... }

import { act, InMemoryStore } from 'actly';

// Scoped store for AlbEdu (request isolation + LRU bounded)
const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true });

/**
 * Call a Supabase Edge Function with resilience.
 * Retry 3x, timeout 10s, circuit breaker (5 consecutive failures → 30s open).
 *
 * @param {string} name - EF name (e.g. 'submit-assessment')
 * @param {object} body - JSON body
 * @param {object} [opts] - { noAuth, signal }
 * @returns {Promise<{ok, status, data, error}>}
 */
export async function callEF(name, body, opts = {}) {
  const result = await act(
    `ef:${name}`,
    async ({ signal }) => {
      const token = opts.noAuth ? null : await getAccessToken();
      const headers = {
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      // apikey is needed for EF calls (even with auth)
      const supabase = window.AlbEdu?.supabase?.client;
      if (supabase?.supabaseKey) headers['apikey'] = supabase.supabaseKey;

      const res = await fetch(
        `${supabase?.supabaseUrl}/functions/v1/${name}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body || {}),
          signal: opts.signal || signal,
        }
      );

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${data?.error?.message || text}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return { status: res.status, data };
    },
    {
      retry: {
        attempts: 3,
        delayMs: 500,
        backoff: 'exponential',
        maxDelay: 5_000,
        jitter: 'full',
        shouldRetry: (err) => {
          // Don't retry 4xx (client error) — only 5xx + network
          if (err?.status >= 400 && err?.status < 500) return false;
          // Don't retry abort
          if (err?.name === 'AbortError') return false;
          return true;
        },
      },
      timeout: { ms: 10_000 },
      circuitBreaker: {
        threshold: 5,
        cooldownMs: 30_000,
        strategy: 'consecutive',
      },
      store,
    }
  );

  if (result.ok) {
    return { ok: true, status: result.value.status, data: result.value.data };
  }
  return { ok: false, status: result.error?.status || 0, error: result.error?.message || 'Unknown error' };
}

/**
 * Direct PostgREST PATCH on assessment_sessions.
 * Used for answer-change sync (Phase 3 wave — replaces heartbeat timer).
 *
 * @param {string} sessionId
 * @param {object} patch - fields to update (draft_answers, current_section, etc.)
 * @returns {Promise<{ok, rowsUpdated, error}>}
 */
export async function patchSession(sessionId, patch) {
  const supabase = window.AlbEdu?.supabase?.client;
  if (!supabase) return { ok: false, error: 'Supabase not ready' };

  const result = await act(
    `patch-session:${sessionId}`,
    async ({ signal }) => {
      const { data, error } = await supabase
        .from('assessment_sessions')
        .update(patch)
        .eq('id', sessionId)
        .in('status', ['active', 'paused', 'disconnected'])
        .select('id, status, blocked_reason');

      if (error) throw error;
      return data || [];
    },
    {
      retry: {
        attempts: 2,
        delayMs: 1_000,
        backoff: 'exponential',
        shouldRetry: (err) => {
          // Don't retry rate-limit trigger error
          if (err?.message?.includes('heartbeat_rate_limited')) return false;
          if (err?.code === '42901') return false;
          return true;
        },
      },
      timeout: { ms: 5_000 },
      store,
    }
  );

  if (result.ok) {
    return { ok: true, rowsUpdated: result.value.length, data: result.value };
  }
  return { ok: false, error: result.error?.message || 'Unknown error' };
}

/**
 * Direct PostgREST SELECT on assessment_sessions.
 * Used by block-checker (10s poll). Pure read, no trigger fires.
 *
 * @param {string} sessionId
 * @returns {Promise<{ok, data, error}>}
 */
export async function selectSession(sessionId) {
  const supabase = window.AlbEdu?.supabase?.client;
  if (!supabase) return { ok: false, error: 'Supabase not ready' };

  const result = await act(
    `select-session:${sessionId}`,
    async ({ signal }) => {
      const { data, error } = await supabase
        .from('assessment_sessions')
        .select('id, status, blocked_reason')
        .eq('id', sessionId)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    {
      retry: { attempts: 2, delayMs: 500, backoff: 'exponential' },
      timeout: { ms: 3_000 },
      // No circuit breaker for SELECT — too many false positives on network blip
      store,
    }
  );

  if (result.ok) {
    return { ok: true, data: result.value };
  }
  return { ok: false, error: result.error?.message || 'Unknown error' };
}

// Helper: get peserta access token
async function getAccessToken() {
  const supabase = window.AlbEdu?.supabase?.client;
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

// Expose for debugging
window.AlbEduResilience = { callEF, patchSession, selectSession };
