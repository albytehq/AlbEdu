// shared/resilience.js — fetch resilience wrapper for AlbEdu (browser-side)
//
// Phase 3: wraps fetch() calls with retry + timeout. NO actly dependency
// in browser (actly is for Deno/EF side). Simple IIFE + manual retry.
//
// Exposed as window.AlbEduResilience with:
//   .callEF(name, body, opts) → { ok, status, data, error }
//   .patchSession(sessionId, patch) → { ok, rowsUpdated, data, error }
//   .selectSession(sessionId) → { ok, data, error }

(function () {
  'use strict';

  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 500;
  const RETRY_MAX_MS = 5_000;
  const EF_TIMEOUT_MS = 10_000;
  const PATCH_TIMEOUT_MS = 5_000;
  const SELECT_TIMEOUT_MS = 3_000;

  // Simple sleep with jitter
  function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function _shouldRetry(err, attempt) {
    if (attempt >= MAX_RETRIES) return false;
    if (err?.name === 'AbortError') return false;
    // Don't retry 4xx (client error) — only 5xx + network
    if (err?.status >= 400 && err?.status < 500) return false;
    // Don't retry rate-limit trigger
    if (err?.message?.includes('heartbeat_rate_limited')) return false;
    if (err?.code === '42901') return false;
    return true;
  }

  async function _retryWithTimeout(fn, timeoutMs) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fn(controller.signal);
        clearTimeout(timer);
        return { ok: true, value: result };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (!_shouldRetry(err, attempt)) break;
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
        const jitter = delay * Math.random();
        console.warn(`[resilience] Attempt ${attempt} failed, retrying in ${Math.round(jitter)}ms:`, err?.message);
        await _sleep(jitter);
      }
    }
    return { ok: false, error: lastErr };
  }

  async function _getAccessToken() {
    // Cookie-auth mode: Worker adds Authorization from HttpOnly cookie.
    // The SDK has no session (persistSession:false), so getSession() returns null.
    // Return null — the Worker proxy will inject the correct JWT.
    return null;
  }

  /**
   * Call a Supabase Edge Function with retry + timeout.
   */
  async function callEF(name, body, opts = {}) {
    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase) return { ok: false, error: 'Supabase not ready' };

    const result = await _retryWithTimeout(async (signal) => {
      const token = opts.noAuth ? null : await _getAccessToken();
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (supabase.supabaseKey) headers['apikey'] = supabase.supabaseKey;

      // FIX (R6 finding): use authFetch for credentials:'include' + CSRF token.
      // Without this, cross-site POST to Worker gets 403 CSRF error.
      const fetchImpl = window.AlbEdu?.authFetch || ((input, init) => fetch(input, { ...init, credentials: 'include' }));

      const res = await fetchImpl(
        `${supabase.supabaseUrl}/functions/v1/${name}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body || {}),
          signal: opts.signal || signal,
          credentials: 'include',
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
    }, EF_TIMEOUT_MS);

    if (result.ok) {
      return { ok: true, status: result.value.status, data: result.value.data };
    }
    return { ok: false, status: result.error?.status || 0, error: result.error?.message || 'Unknown error' };
  }

  /**
   * Direct PostgREST PATCH on assessment_sessions.
   * Used for answer-change sync (Phase 3 wave — replaces heartbeat timer).
   */
  async function patchSession(sessionId, patch) {
    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase) return { ok: false, error: 'Supabase not ready' };

    const result = await _retryWithTimeout(async (signal) => {
      const { data, error } = await supabase
        .from('assessment_sessions')
        .update(patch)
        .eq('id', sessionId)
        .in('status', ['active', 'paused', 'disconnected'])
        .select('id, status, blocked_reason');

      if (error) throw error;
      return data || [];
    }, PATCH_TIMEOUT_MS);

    if (result.ok) {
      return { ok: true, rowsUpdated: result.value.length, data: result.value };
    }
    return { ok: false, error: result.error?.message || 'Unknown error' };
  }

  /**
   * Direct PostgREST SELECT on assessment_sessions.
   * Used by block-checker (10s poll). Pure read, no trigger fires.
   */
  async function selectSession(sessionId) {
    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase) return { ok: false, error: 'Supabase not ready' };

    const result = await _retryWithTimeout(async (signal) => {
      const { data, error } = await supabase
        .from('assessment_sessions')
        .select('id, status, blocked_reason')
        .eq('id', sessionId)
        .maybeSingle();

      if (error) throw error;
      return data;
    }, SELECT_TIMEOUT_MS);

    if (result.ok) {
      return { ok: true, data: result.value };
    }
    return { ok: false, error: result.error?.message || 'Unknown error' };
  }

  window.AlbEduResilience = { callEF, patchSession, selectSession };
})();
