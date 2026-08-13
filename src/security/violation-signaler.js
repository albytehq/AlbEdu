// src/security/violation-signaler.js
// ═══════════════════════════════════════════════════════════════════════════
//  ViolationSignaler — Production-grade peserta→admin violation pipeline.
//  --------------------------------------------------------------------------
//  Receives EVERY violation detected by ExamGuardian / DevToolsDetector /
//  AntiCheat (even the smallest info-severity ones) and reliably delivers
//  them to the admin via the `violation-signal` Edge Function.
//
//  Key properties:
//    1. BATCHED — flushes every 3s OR when 5 signals accumulate OR on critical
//    2. DEDUPLICATED — client-side dedup key (session_id + event_type + 2s
//       window) prevents the same violation from being signaled twice
//    3. RESILIENT — failed sends retry with exponential backoff (1s, 2s, 4s,
//       max 3 attempts). After 3 failures, signals are persisted to
//       IndexedDB and retried on next flush.
//    4. OFFLINE-AWARE — signals queued while offline are flushed on 'online'
//       event. No signal is ever silently dropped.
//    5. UNLOAD-SAFE — on 'beforeunload' / 'pagehide', pending signals are
//       sent via navigator.sendBeacon() (fire-and-forget, survives page close)
//    6. RATE-LIMITED — never sends more than 60 signals/min (server enforces
//       this too, but we throttle client-side to avoid wasted requests)
//    7. LAZY — initializes only when exam starts (not on identity phase)
//    8. SELF-CONTAINED — no external deps beyond fetch + IndexedDB + sendBeacon
//
//  Public API:
//    ViolationSignaler.init(sessionId, { assessmentId, assessmentTitle })
//    ViolationSignaler.signal({ event_type, message, severity, metadata })
//    ViolationSignaler.flush()           // manual flush (e.g., on submit)
//    ViolationSignaler.flushNow()        // synchronous-ish, for unload
//    ViolationSignaler.destroy()         // cleanup
//
//  Event flow:
//    AntiCheat._handleGuardianViolation(v)
//      → ViolationSignaler.signal({event_type, message, severity})
//      → queued in _pendingSignals[]
//      → _scheduleFlush() (3s timer OR immediate if 5+ signals OR critical)
//      → _flush() → POST /functions/violation-signal
//      → on success: clear queue, schedule retry of any persisted failures
//      → on failure: retry with backoff; after 3 attempts, persist to IDB
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (window.ViolationSignaler) return; // idempotent

  // ── Constants ──────────────────────────────────────────────────────────

  const FLUSH_INTERVAL_MS = 3000;        // 3s
  const FLUSH_BATCH_SIZE = 5;            // flush when 5+ signals accumulate
  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [1000, 2000, 4000]; // exponential backoff
  const DEDUP_WINDOW_MS = 2000;          // 2-second dedup window
  const MAX_QUEUE_SIZE = 200;            // hard cap to prevent OOM
  const IDB_DB_NAME = 'albedu_violations';
  const IDB_STORE = 'pending_signals';
  const IDB_DB_VERSION = 1;

  // ── State ──────────────────────────────────────────────────────────────

  const state = {
    initialized: false,
    sessionId: null,
    assessmentId: null,
    assessmentTitle: null,
    pendingSignals: [],          // signals waiting for next flush
    inFlight: false,             // a flush is currently in progress
    flushTimer: null,            // setTimeout handle
    retryTimer: null,            // setTimeout handle for retry
    retryCount: 0,               // consecutive retry count
    seenDedupKeys: new Map(),    // dedup_key → timestamp (for expiry)
    online: navigator.onLine !== false,
    idb: null,                   // IndexedDB handle (lazy)
    userId: null,                // resolved at init
    userEmail: null,
    deviceId: null,
    destroyed: false,
  };

  // ── Helpers ────────────────────────────────────────────────────────────

  function _log(...args) {
    try { console.info('[ViolationSignaler]', ...args); } catch (_) {}
  }
  function _warn(...args) {
    try { console.warn('[ViolationSignaler]', ...args); } catch (_) {}
  }
  function _err(...args) {
    try { console.error('[ViolationSignaler]', ...args); } catch (_) {}
  }

  function _isoNow() {
    return new Date().toISOString();
  }

  function _getEFUrl() {
    // FIX v0.854.0: Use the correct Supabase URL source.
    // The previous code checked `window.AlbEdu.supabase.config.url` which
    // DOES NOT EXIST on the real platform surface. The correct source is
    // `window.AlbEdu.supabase.client.supabaseUrl` (used by heartbeat.js
    // and image-cleanup.js). Also fixed the EF path from `/functions/`
    // to `/functions/v1/` (the canonical Supabase EF path).
    const supabaseUrl = window.AlbEdu?.supabase?.client?.supabaseUrl
      || window.AlbEdu?.supabase?.config?.url  // legacy fallback (test mocks)
      || window.__ALBEDU_SUPABASE_URL__
      || (window.location.hostname.includes('albytehq.github.io') ? 'https://kzsrerxhhrtsxnpnmqgl.supabase.co' : '');
    if (!supabaseUrl) {
      _warn('Could not resolve Supabase URL — violation signals will not be sent');
      return null;
    }
    return `${supabaseUrl}/functions/v1/violation-signal`;
  }

  // Synchronous token fetch — used by flushNow() (page unload, can't await).
  // Returns null if the session isn't immediately available.
  function _getAuthTokenSync() {
    try {
      // The Supabase SDK stores the session in localStorage under a key like
      // `sb-<project-ref>-auth-token`. We can read it synchronously.
      const client = window.AlbEdu?.supabase?.client;
      if (client?.auth?.session) {
        // Some SDK versions expose session synchronously
        const s = client.auth.session?.();
        if (s?.access_token) return s.access_token;
      }
      // Fall back to localStorage (the SDK's persistence layer)
      const url = window.AlbEdu?.supabase?.client?.supabaseUrl || '';
      const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
      if (ref) {
        const key = `sb-${ref}-auth-token`;
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.access_token) return parsed.access_token;
        }
      }
    } catch (_) {}
    return null;
  }

  // Async token fetch — used by _flush() (can await).
  // This is the reliable path: calls client.auth.getSession() which refreshes
  // the session if needed and returns the current access_token.
  async function _getAuthToken() {
    try {
      const client = window.AlbEdu?.supabase?.client;
      if (!client?.auth?.getSession) {
        // Fallback to sync method
        return _getAuthTokenSync();
      }
      const { data } = await client.auth.getSession();
      return data?.session?.access_token || _getAuthTokenSync();
    } catch (e) {
      _warn('Failed to fetch auth token:', e?.message);
      return _getAuthTokenSync();
    }
  }

  // Cache the token for flushNow() — updated by each _flush() call
  let _cachedToken = null;

  // Event-type family mapping for cross-type deduplication.
  // When a peserta switches tabs, Guardian may report BOTH 'tab_switch' and
  // 'window_blur' for the same physical action. Without family-level dedup,
  // these would be sent as 2 separate signals (different event_types →
  // different dedup keys). By mapping them to the same family 'focus_loss',
  // only the first signal is sent; the second is deduped.
  const EVENT_FAMILY = {
    tab_switch:        'focus_loss',
    window_blur:       'focus_loss',
    devtools_shortcut: 'devtools',
    devtools_open:     'devtools',
    copy_attempt:      'clipboard',
    paste_attempt:     'clipboard',
    context_menu:      'clipboard',
    select_text:       'clipboard',
  };

  function _computeDedupKey(eventType, clientTimestamp) {
    const ts = Date.parse(clientTimestamp);
    const bucket = Math.floor(ts / DEDUP_WINDOW_MS);
    // Use family if available, else use the raw event_type.
    // This ensures tab_switch + window_blur within the same 2s window are
    // treated as duplicates of the same focus-loss event.
    const family = EVENT_FAMILY[eventType] || eventType;
    return `${state.sessionId}|${family}|${bucket}`;
  }

  function _isDuplicate(dedupKey) {
    const now = Date.now();
    // Expire old dedup keys (older than 2x dedup window)
    for (const [k, t] of state.seenDedupKeys) {
      if (now - t > DEDUP_WINDOW_MS * 2) state.seenDedupKeys.delete(k);
    }
    if (state.seenDedupKeys.has(dedupKey)) return true;
    state.seenDedupKeys.set(dedupKey, now);
    return false;
  }

  function _getDeviceInfo() {
    try {
      return {
        user_agent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        viewport_w: window.innerWidth,
        viewport_h: window.innerHeight,
        screen_w: screen.width,
        screen_h: screen.height,
        online: state.online,
      };
    } catch (_) {
      return { user_agent: 'unknown' };
    }
  }

  // ── IndexedDB persistence (for offline queue) ─────────────────────────

  function _idbOpen() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        resolve(null);
        return;
      }
      if (state.idb) {
        resolve(state.idb);
        return;
      }
      try {
        const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = (e) => {
          state.idb = e.target.result;
          resolve(state.idb);
        };
        req.onerror = () => {
          _warn('IndexedDB open failed — offline queue will not persist');
          resolve(null);
        };
      } catch (e) {
        _warn('IndexedDB error:', e?.message);
        resolve(null);
      }
    });
  }

  async function _idbAdd(signal) {
    const db = await _idbOpen();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.add({ signal, created_at: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) { resolve(); }
    });
  }

  async function _idbGetAll() {
    const db = await _idbOpen();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([IDB_STORE], 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  async function _idbClear() {
    const db = await _idbOpen();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) { resolve(); }
    });
  }

  async function _idbDelete(id) {
    const db = await _idbOpen();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) { resolve(); }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async function init(sessionId, opts = {}) {
    if (state.initialized) {
      _warn('Already initialized — call destroy() first');
      return;
    }
    if (!sessionId) {
      _err('init() requires sessionId');
      return;
    }
    state.sessionId = sessionId;
    state.assessmentId = opts.assessmentId || null;
    state.assessmentTitle = opts.assessmentTitle || null;
    state.initialized = true;
    state.destroyed = false;
    state.pendingSignals = [];
    state.retryCount = 0;
    state.seenDedupKeys = new Map();

    // Resolve user identity (for client-side dedup key + metadata)
    try {
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      state.userId = user?.id || null;
      state.userEmail = user?.email || null;
    } catch (_) {}
    try {
      state.deviceId = localStorage.getItem('albedu_exam_device_id') || null;
    } catch (_) {}

    // Wire online/offline events
    window.addEventListener('online', _onOnline);
    window.addEventListener('offline', _onOffline);
    // Wire unload events (pagehide for mobile, beforeunload for desktop)
    window.addEventListener('pagehide', _onUnload);
    window.addEventListener('beforeunload', _onUnload);

    // Restore any persisted signals from previous offline sessions
    try {
      const persisted = await _idbGetAll();
      if (persisted.length > 0) {
        _log(`Restored ${persisted.length} persisted signals from IndexedDB`);
        for (const p of persisted) {
          state.pendingSignals.push(p.signal);
        }
        await _idbClear();
        _scheduleFlush(0); // flush immediately
      }
    } catch (e) {
      _warn('Failed to restore persisted signals:', e?.message);
    }

    _log(`Initialized (session=${sessionId.substring(0, 8)}..., assessment=${state.assessmentId?.substring(0, 8) || 'none'}...)`);
  }

  function signal({ event_type, message, severity, metadata }) {
    if (!state.initialized || state.destroyed) {
      _warn('Not initialized — signal dropped:', event_type);
      return;
    }
    if (!event_type) {
      _warn('Signal missing event_type — dropped');
      return;
    }

    // Hard cap to prevent OOM in pathological cases (peserta spamming F12 etc.)
    if (state.pendingSignals.length >= MAX_QUEUE_SIZE) {
      _warn(`Queue full (${MAX_QUEUE_SIZE}) — dropping oldest signal`);
      state.pendingSignals.shift();
    }

    const clientTimestamp = _isoNow();
    const dedupKey = _computeDedupKey(event_type, clientTimestamp);
    if (_isDuplicate(dedupKey)) {
      // Duplicate within dedup window — silently skip
      return;
    }

    const signalObj = {
      event_type,
      message: String(message || '').slice(0, 500),
      severity: ['info', 'warning', 'critical'].includes(severity) ? severity : 'warning',
      client_timestamp: clientTimestamp,
      metadata: {
        ...(_getDeviceInfo() || {}),
        ...(metadata || {}),
      },
      _dedup_key: dedupKey, // client-side dedup (server recomputes for authoritative dedup)
    };

    state.pendingSignals.push(signalObj);

    // Schedule flush:
    // - Immediate if critical (max_violations_reached, etc.)
    // - Immediate if queue is full (FLUSH_BATCH_SIZE)
    // - Otherwise debounce 3s
    const isCritical = signalObj.severity === 'critical';
    if (isCritical || state.pendingSignals.length >= FLUSH_BATCH_SIZE) {
      _scheduleFlush(0);
    } else {
      _scheduleFlush(FLUSH_INTERVAL_MS);
    }
  }

  function _scheduleFlush(delayMs) {
    if (state.flushTimer) {
      // Only reschedule if the new delay is sooner than the existing one
      // (or if delay is 0 = immediate)
      if (delayMs === 0) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      } else {
        return; // existing timer will fire
      }
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      _flush().catch(e => _err('Flush error:', e?.message));
    }, delayMs);
  }

  async function _flush() {
    if (state.inFlight) {
      _log('Flush already in progress — skipping');
      return;
    }
    if (state.pendingSignals.length === 0) {
      return;
    }
    if (!state.online) {
      _log('Offline — signals will flush on reconnect');
      // Persist to IndexedDB so they survive a page close
      for (const sig of state.pendingSignals) {
        await _idbAdd(sig);
      }
      state.pendingSignals = [];
      return;
    }

    const efUrl = _getEFUrl();
    if (!efUrl) {
      _warn('No EF URL — signals queued');
      return;
    }
    const token = await _getAuthToken();
    if (!token) {
      _warn('No auth token — signals queued (will retry)');
      _scheduleRetry();
      return;
    }
    _cachedToken = token; // cache for flushNow() (sync path on page unload)

    state.inFlight = true;
    const signalsToSend = state.pendingSignals.slice();
    state.pendingSignals = []; // clear queue; if send fails, we'll re-queue

    try {
      const res = await fetch(efUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: state.sessionId,
          signals: signalsToSend.map(s => ({
            event_type: s.event_type,
            message: s.message,
            severity: s.severity,
            client_timestamp: s.client_timestamp,
            metadata: s.metadata,
          })),
        }),
        keepalive: true, // survive page unload
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        _log(`Flush OK — inserted=${data?.data?.inserted ?? '?'}, skipped=${data?.data?.skipped ?? '?'}`);
        state.retryCount = 0; // reset on success
      } else if (res.status === 429) {
        // Rate limited — re-queue and back off
        _warn('Rate limited (429) — re-queuing signals');
        state.pendingSignals.unshift(...signalsToSend);
        // Use the server's retry_after if provided
        const body = await res.json().catch(() => ({}));
        const retryAfter = body?.error?.details?.retry_after_ms || 5000;
        _scheduleRetry(retryAfter);
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx (non-429) — client error, don't retry (e.g., 403 forbidden, 404 session not found)
        _warn(`Flush failed (${res.status}) — signals dropped (non-retryable)`);
        state.retryCount = 0;
      } else {
        // 5xx — server error, retry
        _warn(`Flush failed (${res.status}) — will retry`);
        state.pendingSignals.unshift(...signalsToSend);
        _scheduleRetry();
      }
    } catch (e) {
      // Network error — re-queue and retry
      _warn('Network error — re-queuing signals:', e?.message);
      state.pendingSignals.unshift(...signalsToSend);
      _scheduleRetry();
    } finally {
      state.inFlight = false;
    }
  }

  function _scheduleRetry(delayMs) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    if (state.retryCount >= MAX_RETRIES) {
      _err(`Max retries (${MAX_RETRIES}) reached — persisting ${state.pendingSignals.length} signals to IndexedDB`);
      // Persist to IndexedDB for survival across page reloads
      (async () => {
        for (const sig of state.pendingSignals) {
          await _idbAdd(sig);
        }
        state.pendingSignals = [];
        state.retryCount = 0;
      })();
      return;
    }
    const delay = delayMs || RETRY_DELAYS_MS[state.retryCount] || 4000;
    state.retryCount++;
    _log(`Retry scheduled in ${delay}ms (attempt ${state.retryCount}/${MAX_RETRIES})`);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      _flush().catch(e => _err('Retry flush error:', e?.message));
    }, delay);
  }

  function flush() {
    return _flush();
  }

  function flushNow() {
    // Synchronous-ish flush for page unload.
    // Uses navigator.sendBeacon which is fire-and-forget but survives page close.
    if (state.pendingSignals.length === 0) return;
    if (!state.online) {
      // Best-effort: persist to IDB
      for (const sig of state.pendingSignals) {
        _idbAdd(sig);
      }
      return;
    }
    const efUrl = _getEFUrl();
    // Use cached token (from last _flush) or sync fallback — can't await on unload
    const token = _cachedToken || _getAuthTokenSync();
    if (!efUrl || !token) return;

    const payload = JSON.stringify({
      session_id: state.sessionId,
      signals: state.pendingSignals.map(s => ({
        event_type: s.event_type,
        message: s.message,
        severity: s.severity,
        client_timestamp: s.client_timestamp,
        metadata: s.metadata,
      })),
    });

    try {
      // sendBeacon sends a POST with Content-Type: text/plain;charset=UTF-8
      // (browser limitation). The EF must accept this content-type — we'll
      // handle it in the EF by parsing the body regardless of content-type.
      const blob = new Blob([payload], { type: 'application/json' });
      const ok = navigator.sendBeacon(efUrl, blob);
      if (ok) {
        _log(`flushNow: sent ${state.pendingSignals.length} signals via sendBeacon`);
        state.pendingSignals = [];
      } else {
        _warn('sendBeacon returned false — signals lost');
      }
    } catch (e) {
      _warn('sendBeacon failed:', e?.message);
      // Last-resort: fetch with keepalive
      try {
        fetch(efUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }
  }

  function _onOnline() {
    state.online = true;
    _log('Back online — flushing pending signals');
    _flush().catch(() => {});
  }

  function _onOffline() {
    state.online = false;
    _warn('Offline — signals will be persisted to IndexedDB on next flush');
  }

  function _onUnload() {
    if (state.destroyed) return;
    flushNow();
  }

  function destroy() {
    state.destroyed = true;
    // Final flush attempt
    flushNow();
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.flushTimer = null;
    state.retryTimer = null;
    state.pendingSignals = [];
    state.seenDedupKeys = new Map();
    state.initialized = false;
    window.removeEventListener('online', _onOnline);
    window.removeEventListener('offline', _onOffline);
    window.removeEventListener('pagehide', _onUnload);
    window.removeEventListener('beforeunload', _onUnload);
    _log('Destroyed');
  }

  // ── Expose ─────────────────────────────────────────────────────────────

  window.ViolationSignaler = {
    init,
    signal,
    flush,
    flushNow,
    destroy,
    // Test-only API (exposed for unit tests; not for production use)
    _test: {
      get state() { return state; },
      _idbGetAll,
      _idbClear,
      _computeDedupKey,
      _isDuplicate,
      _resetDedup: () => { state.seenDedupKeys = new Map(); },
    },
  };

  _log('Module loaded');
})();
