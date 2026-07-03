// =============================================================================
// supabase-client.js — AlbEdu Platform Layer · Native Supabase client
// =============================================================================
// SINGLE responsibility: bootstrap ONE Supabase client and expose it through
// a clearly named, typed service surface. No Firebase vocabulary, no shims,
// no compat events. Supabase is used as Supabase.
//
// Public API (window.AlbEdu.supabase):
//   .client             → raw SupabaseClient (escape hatch, used sparingly)
//   .auth               → AuthService       (session, user, sign-in/out)
//   .db                 → DbService         (typed table access)
//   .realtime           → RealtimeService   (channel subscribe/unsubscribe)
//   .rpc                → RpcService        (Edge Function invocation)
//   .ready              → Promise<true>     (resolves when bootstrap complete)
//   .isReady            → boolean           (sync getter)
//
// Boot contract:
//   1. Config fetched from Cloudflare Worker (cached 1h in sessionStorage).
//   2. Supabase SDK loaded from CDN (deferred in HTML).
//   3. Client created with persistSession + autoRefreshToken + PKCE.
//   4. document.dispatchEvent('albedu:platform-ready')
//   5. window.AlbEdu.supabase.ready resolves.
//
// Failure contract:
//   - On any failure: dispatch 'albedu:platform-error' with detail.message.
//   - .ready rejects with the same Error.
//   - UI shell keeps rendering — it does NOT depend on this layer for paint.
//
// Performance contract:
//   - No top-level await — init is fire-and-forget.
//   - HTML shell is rendered by the browser BEFORE this module runs (defer).
//   - All consumers await window.AlbEdu.supabase.ready — never block paint.
// =============================================================================

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────
  const WORKER_BASE = 'https://edu.albyte-inc.workers.dev';
  const CONFIG_ENDPOINT = `${WORKER_BASE}/api/supabase-config`;
  const CONFIG_CACHE_KEY = 'albedu_sb_config';
  const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const FETCH_RETRY_COUNT = 3;
  const FETCH_RETRY_BASE_MS = 1500;
  const SDK_TIMEOUT_MS = 10_000;

  // ── Module state ───────────────────────────────────────────────────────
  let _client = null;
  let _ready = false;
  let _error = null;

  const _readyResolvers = [];
  const ready = new Promise((resolve, reject) => {
    _readyResolvers.push({ resolve, reject });
  });

  function _markReady() {
    _ready = true;
    _readyResolvers.forEach(r => r.resolve(true));
  }

  function _markError(err) {
    _error = err;
    _readyResolvers.forEach(r => r.reject(err));
  }

  // ── Config cache (sessionStorage) ──────────────────────────────────────
  function _readConfigCache() {
    try {
      const raw = sessionStorage.getItem(CONFIG_CACHE_KEY);
      if (!raw) return null;
      const { ts, config } = JSON.parse(raw);
      if (Date.now() - ts > CONFIG_CACHE_TTL_MS) {
        sessionStorage.removeItem(CONFIG_CACHE_KEY);
        return null;
      }
      if (!config?.url || !config?.anonKey) return null;
      return config;
    } catch (_) { return null; }
  }

  function _writeConfigCache(config) {
    try {
      sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), config }));
    } catch (_) { /* sessionStorage may be full or disabled */ }
  }

  // ── Fetch config from Cloudflare Worker (retry + stale fallback) ───────
  async function _fetchConfig(retryLeft = FETCH_RETRY_COUNT) {
    const cached = _readConfigCache();
    if (cached) return cached;

    try {
      const res = await fetch(CONFIG_ENDPOINT, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'default',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const config = await res.json();
      if (!config?.url || !config?.anonKey) {
        throw new Error('Supabase config incomplete: missing url or anonKey');
      }

      _writeConfigCache(config);
      return config;
    } catch (err) {
      if (retryLeft > 0) {
        const delay = FETCH_RETRY_BASE_MS * Math.pow(2, FETCH_RETRY_COUNT - retryLeft);
        await new Promise(r => setTimeout(r, delay));
        return _fetchConfig(retryLeft - 1);
      }
      // Last-resort stale-cache fallback (better than hard failure)
      try {
        const raw = sessionStorage.getItem(CONFIG_CACHE_KEY);
        if (raw) {
          const { config } = JSON.parse(raw);
          if (config?.url && config?.anonKey) {
            console.warn('[platform] worker unreachable — using stale config cache');
            return config;
          }
        }
      } catch (_) {}
      throw new Error(`Failed to fetch Supabase config: ${err.message}`);
    }
  }

  // ── Wait for Supabase SDK global (loaded via CDN defer) ────────────────
  function _waitForSDK() {
    return new Promise((resolve, reject) => {
      if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
        return resolve();
      }
      let elapsed = 0;
      const tick = 100;
      const id = setInterval(() => {
        elapsed += tick;
        if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
          clearInterval(id);
          clearTimeout(timer);
          resolve();
        }
      }, tick);
      const timer = setTimeout(() => {
        clearInterval(id);
        reject(new Error(
          'Supabase SDK not loaded within 10s. Check CDN script tag in HTML.'
        ));
      }, SDK_TIMEOUT_MS);
    });
  }

  // ── AuthService — thin native wrapper around supabase.auth ─────────────
  function _buildAuthService(client) {
    // Single source of truth for "current user", updated by onAuthStateChange.
    // Avoids the per-call getSession() round-trip that the legacy shim did.
    let _currentUser = null;
    const _listeners = new Set();

    function _toUser(session) {
      if (!session?.user) return null;
      const u = session.user;
      return {
        id: u.id,
        email: u.email || '',
        displayName: u.user_metadata?.full_name || u.user_metadata?.name || '',
        photoURL: u.user_metadata?.avatar_url || null,
        emailVerified: u.email_confirmed_at != null,
        // Raw Supabase user object — escape hatch for advanced consumers.
        raw: u,
      };
    }

    client.auth.onAuthStateChange((_event, session) => {
      _currentUser = _toUser(session);
      _listeners.forEach(cb => {
        try { cb(_currentUser, _event); } catch (_) {}
      });
    });

    // Initial sync — getSession() returns the cached session immediately.
    client.auth.getSession().then(({ data }) => {
      if (!_currentUser && data?.session) {
        _currentUser = _toUser(data.session);
      }
    }).catch(() => { /* non-fatal — onAuthStateChange will fire */ });

    return {
      /** Returns the current user synchronously (may be null until first auth event). */
      get currentUser() { return _currentUser; },

      /**
       * Subscribe to auth state changes.
       * Callback signature: (user, event) => void
       * event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | ...
       * Returns an unsubscribe function.
       */
      onAuthStateChange(callback) {
        _listeners.add(callback);
        // Fire once immediately with current state (so caller doesn't race).
        Promise.resolve().then(() => {
          try { callback(_currentUser, 'INITIALIZE'); } catch (_) {}
        });
        return () => _listeners.delete(callback);
      },

      /** Sign in with Google OAuth (redirect mode — Supabase native). */
      async signInWithGoogle(redirectUrl) {
        const target = redirectUrl || window.location.origin + window.location.pathname;
        const { error } = await client.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: target,
            queryParams: { access_type: 'offline', prompt: 'select_account' },
          },
        });
        if (error) throw new Error(error.message || 'Google sign-in failed');
        // Redirect mode — no return value. onAuthStateChange will fire on return.
        return null;
      },

      /** Sign in with email/password. */
      async signInWithEmail(email, password) {
        return client.auth.signInWithPassword({ email, password });
      },

      /** Sign up with email/password. */
      async signUpWithEmail(email, password) {
        return client.auth.signUp({ email, password });
      },

      /** Send password reset email. */
      async sendPasswordReset(email) {
        return client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname.replace(/[^/]*$/, 'reset-password.html'),
        });
      },

      /** Sign out — clears local + server session. */
      async signOut() {
        return client.auth.signOut();
      },

      /** Get the current access token (for Edge Function Authorization header). */
      async getAccessToken() {
        const { data } = await client.auth.getSession();
        return data?.session?.access_token || null;
      },

      /** Get the raw session object. */
      async getSession() {
        return client.auth.getSession();
      },
    };
  }

  // ── DbService — thin native wrapper around supabase.from() ─────────────
  function _buildDbService(client) {
    return {
      /**
       * Select rows from a table.
       * @param {string} table
       * @param {string} columns — comma-separated column names (default '*')
       * @param {{ filter?: string, order?: { column: string, ascending?: boolean }, limit?: number }} opts
       */
      async select(table, columns = '*', opts = {}) {
        let q = client.from(table).select(columns);
        if (opts.filter) q = q.filter.apply(q, _parseFilterString(opts.filter));
        // Simpler: support eq()/neq() chaining via opts
        if (opts.eq) {
          for (const [col, val] of Object.entries(opts.eq)) q = q.eq(col, val);
        }
        if (opts.order) {
          q = q.order(opts.order.column, { ascending: opts.order.ascending ?? false });
        }
        if (opts.limit) q = q.limit(opts.limit);
        return q;
      },

      /** Select a single row by primary key (id column). */
      async selectOne(table, id, columns = '*') {
        const { data, error } = await client.from(table)
          .select(columns)
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        return data;
      },

      /** Insert one or more rows. */
      async insert(table, payload) {
        return client.from(table).insert(payload);
      },

      /** Update rows matching a filter. */
      async update(table, payload, filter = {}) {
        let q = client.from(table).update(payload);
        for (const [col, val] of Object.entries(filter)) q = q.eq(col, val);
        return q;
      },

      /** Delete rows matching a filter. */
      async delete(table, filter = {}) {
        let q = client.from(table).delete();
        for (const [col, val] of Object.entries(filter)) q = q.eq(col, val);
        return q;
      },

      /** Upsert rows (insert on conflict update). */
      async upsert(table, payload, onConflict = 'id') {
        return client.from(table).upsert(payload, { onConflict });
      },

      /** Raw query escape hatch (returns a query builder). */
      from(table) {
        return client.from(table);
      },
    };
  }

  // ── RealtimeService — channel management ───────────────────────────────
  function _buildRealtimeService(client) {
    const _channels = new Map();

    return {
      /**
       * Subscribe to INSERT/UPDATE/DELETE events on a table.
       * @param {string} name — channel name (unique per subscription)
       * @param {string} table
       * @param {string} event — '*' | 'INSERT' | 'UPDATE' | 'DELETE'
       * @param {function} callback — (payload) => void
       * @param {string} [filter] — e.g. 'access_code=eq.ABC123'
       */
      subscribe(name, table, event, callback, filter) {
        if (_channels.has(name)) {
          console.warn(`[platform] realtime channel "${name}" already exists — replacing`);
          this.unsubscribe(name);
        }
        const channel = client.channel(name, { config: { broadcast: { self: false } } })
          .on('postgres_changes',
            { event, schema: 'public', table, filter: filter || undefined },
            callback
          )
          .subscribe();
        _channels.set(name, channel);
        return () => this.unsubscribe(name);
      },

      /** Unsubscribe a channel by name. */
      unsubscribe(name) {
        const channel = _channels.get(name);
        if (!channel) return;
        try { client.removeChannel(channel); } catch (_) {}
        _channels.delete(name);
      },

      /** Unsubscribe all channels (used on logout). */
      unsubscribeAll() {
        for (const name of Array.from(_channels.keys())) {
          this.unsubscribe(name);
        }
      },
    };
  }

  // ── RpcService — Edge Function invocation ──────────────────────────────
  function _buildRpcService(client) {
    return {
      /**
       * Invoke an Edge Function with the current user's access token.
       * @param {string} name — function name (e.g. 'submit-assessment')
       * @param {object} body — JSON body
       * @param {object} [opts] — { headers?: object, noAuth?: boolean }
       */
      async invoke(name, body = {}, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        if (!opts.noAuth) {
          const token = await _client.auth.getSession()
            .then(r => r.data?.session?.access_token)
            .catch(() => null);
          if (token) headers.Authorization = `Bearer ${token}`;
        }
        return client.functions.invoke(name, { body, headers });
      },
    };
  }

  // ── Bootstrap (fire-and-forget — never blocks paint) ───────────────────
  async function _bootstrap() {
    try {
      const config = await _fetchConfig();
      await _waitForSDK();

      _client = window.supabase.createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce',
        },
        realtime: {
          params: { eventsPerSecond: 10 },
        },
        global: {
          headers: { 'X-Client': 'AlbEdu-Web/1.0' },
        },
      });

      // Build service surface
      const auth = _buildAuthService(_client);
      const db = _buildDbService(_client);
      const realtime = _buildRealtimeService(_client);
      const rpc = _buildRpcService(_client);

      // Online reconnect hint
      window.addEventListener('online', () => {
        document.dispatchEvent(new CustomEvent('albedu:platform-reconnected'));
      }, { passive: true });

      // Expose through window.AlbEdu namespace (NOT window.firebase / window.sb)
      if (!window.AlbEdu) window.AlbEdu = {};
      window.AlbEdu.supabase = {
        client: _client,
        auth,
        db,
        realtime,
        rpc,
        ready,
        isReady: () => _ready,
        isError: () => _error != null,
        getError: () => _error,
      };

      _markReady();
      document.dispatchEvent(new CustomEvent('albedu:platform-ready'));
    } catch (err) {
      console.error('[platform] bootstrap failed:', err?.message || err);
      _markError(err);
      document.dispatchEvent(new CustomEvent('albedu:platform-error', {
        detail: { message: err?.message || 'Bootstrap failed' },
      }));
    }
  }

  // Kick off — fire-and-forget. The HTML shell is already rendered by now.
  _bootstrap();
})();
