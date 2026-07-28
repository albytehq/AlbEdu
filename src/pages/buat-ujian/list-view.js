// list-view.js — lists admin's assessments on the buat-ujian page.
//
// Production-grade state machine:
//   booting → auth-checking → loading-data → loaded | empty | error | unauthorized
//
// Empty state ONLY fires when ALL of these are true:
//   1. Supabase client ready (await window.AlbEdu.supabase.ready)
//   2. Session valid (sb.auth.getSession returns a user)
//   3. Request succeeded (no error)
//   4. Result has 0 rows
//
// Never use _render([]) to mean "session not ready" — that bug caused
// fake empty states when session wasn't hydrated yet.
//
// Guards:
//   - requestId counter: stale responses (from older load() calls) are discarded
//   - onAuthStateChange subscription: auto-refetch on SIGNED_IN / TOKEN_REFRESHED,
//     show unauthorized on SIGNED_OUT
//   - try/catch around every async phase with explicit error state

(function () {
  'use strict';

  const LOAD_TIMEOUT_MS = 15000;

  // Helper: bind icons in a root element (defensive — in case MutationObserver is slow)
  function _bindIcons(root) {
    try {
      if (window.AlbEdu?.bindIcons) window.AlbEdu.bindIcons(root);
    } catch (e) {
      console.warn('[ListView] bindIcons failed:', e);
    }
  }

  function _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _fmtDate(ts) {
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '-';
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch { return '-'; }
  }

  const ListView = {
    init() {
      // Element refs
      this._grid           = document.getElementById('assessments-grid');
      this._empty          = document.getElementById('empty-state');
      this._loading        = document.getElementById('list-loading');
      this._loadingText    = document.getElementById('list-loading-text');
      this._error          = document.getElementById('list-error');
      this._errorText      = document.getElementById('list-error-text');
      this._unauthorized   = document.getElementById('list-unauthorized');
      this._btnRetry       = document.getElementById('list-btn-retry');

      if (!this._grid) return;

      // State
      this._allData = [];
      this._requestId = 0;
      this._state = 'booting';
      this._loadingTimer = null;
      this._unsubAuth = null;

      // Wire retry button
      this._btnRetry?.addEventListener('click', () => this.load());

      // Subscribe to auth state changes for auto-refetch
      this._subscribeAuthChanges();

      // Kick off load
      this.load();
    },

    // ── State machine ──────────────────────────────────────────
    // States: booting → auth-checking → loading-data → loaded | empty | error | unauthorized
    _setState(state, payload) {
      // Race-condition guard: discard stale state changes from older requests
      if (payload?.requestId !== undefined && payload.requestId !== this._requestId) {
        return;
      }

      this._state = state;
      this._hideAllStates();

      const statusText = {
        booting: 'Menyiapkan aplikasi...',
        'auth-checking': 'Memverifikasi sesi...',
        'loading-data': 'Mengambil data asesmen...',
      }[state] || '';

      if (state === 'booting' || state === 'auth-checking' || state === 'loading-data') {
        if (this._loading) this._loading.hidden = false;
        if (this._loadingText) this._loadingText.textContent = statusText;

        // 15s timeout → switch to "slow" warning
        clearTimeout(this._loadingTimer);
        this._loadingTimer = setTimeout(() => {
          if (this._loading && !this._loading.hidden) {
            if (this._loadingText) this._loadingText.textContent = 'Memuat terlalu lama. Periksa koneksi Anda...';
          }
        }, LOAD_TIMEOUT_MS);
      } else {
        clearTimeout(this._loadingTimer);
        if (this._loading) this._loading.hidden = true;

        if (state === 'empty') {
          if (this._empty) { this._empty.hidden = false; _bindIcons(this._empty); }
        } else if (state === 'error') {
          if (this._error) {
            this._error.hidden = false;
            if (this._errorText) {
              this._errorText.textContent = payload?.message ||
                'Terjadi kesalahan saat memuat data asesmen. Periksa koneksi internet Anda lalu coba lagi.';
            }
            _bindIcons(this._error);
          }
        } else if (state === 'unauthorized') {
          if (this._unauthorized) { this._unauthorized.hidden = false; _bindIcons(this._unauthorized); }
        }
        // 'loaded' state is set by load() before calling _render()
      }
    },

    _hideAllStates() {
      if (this._loading)      this._loading.hidden = true;
      if (this._empty)        this._empty.hidden = true;
      if (this._error)        this._error.hidden = true;
      if (this._unauthorized) this._unauthorized.hidden = true;
      if (this._grid)         this._grid.hidden = true;
    },

    // ── Data loading with state machine + requestId guard ──────
    async load() {
      const requestId = ++this._requestId;

      // Phase 1: booting — wait for platform layer
      this._setState('booting', { requestId });
      try {
        if (window.AlbEdu?.supabase?.ready) {
          await window.AlbEdu.supabase.ready;
        } else {
          // Fallback: poll for client availability (max 10s)
          const start = Date.now();
          while (!window.AlbEdu?.supabase?.client && Date.now() - start < 10000) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        if (requestId !== this._requestId) return; // stale
        if (!window.AlbEdu?.supabase?.client) {
          throw new Error('Platform layer gagal dimuat. Coba refresh halaman.');
        }
      } catch (err) {
        if (requestId !== this._requestId) return;
        this._setState('error', { requestId, message: err?.message || 'Gagal memuat platform layer.' });
        return;
      }

      // Phase 2: auth-checking
      this._setState('auth-checking', { requestId });
      let session;
      try {
        const sb = window.AlbEdu.supabase.client;
        ({ data: { session } } = await sb.auth.getSession());
        if (requestId !== this._requestId) return; // stale
      } catch (err) {
        if (requestId !== this._requestId) return;
        this._setState('error', { requestId, message: 'Gagal memverifikasi sesi: ' + (err?.message || 'unknown') });
        return;
      }

      if (!session?.user) {
        if (requestId !== this._requestId) return;
        this._setState('unauthorized', { requestId });
        return;
      }

      // Phase 3: loading-data
      this._setState('loading-data', { requestId });
      try {
        const sb = window.AlbEdu.supabase.client;
        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, access_mode, created_at, sections, identity_mode')
          .eq('created_by', session.user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (requestId !== this._requestId) return; // stale — newer request in flight
        if (error) throw error;

        this._allData = data || [];
        // Phase 4a: loaded (with data) or 4b: empty (0 rows — final decision)
        if (this._allData.length === 0) {
          this._setState('empty', { requestId });
        } else {
          this._setState('loaded', { requestId });
          this._render();
        }
      } catch (err) {
        if (requestId !== this._requestId) return;
        console.error('[ListView] load failed:', err);
        this._setState('error', { requestId, message: err?.message || 'Gagal mengambil data asesmen.' });
      }
    },

    // ── Render (only called in 'loaded' state) ─────────────────
    _render() {
      const exams = this._allData;
      if (!exams?.length) {
        // Defensive: should never happen since load() sets 'empty' state for 0 rows,
        // but if it does, fall back to empty state instead of showing empty grid.
        this._setState('empty', { requestId: this._requestId });
        return;
      }

      this._hideAllStates();
      this._grid.hidden = false;
      this._grid.innerHTML = exams.map(e => {
        const tq = (e.sections || []).reduce((s, sec) => s + (sec.questions || []).length, 0);
        return `<article class="albedu-exam-card"><div class="albedu-exam-card-header"><h3 class="albedu-exam-card-title">${_esc(e.title || 'Tanpa Judul')}</h3><span class="albedu-exam-card-token">#${_esc(e.access_code || e.id)}</span></div><div class="albedu-exam-card-meta"><span><span data-albedu-icon="book"></span> ${_esc(e.subject || '-')}</span><span><span data-albedu-icon="schedule"></span> ${e.duration_minutes || 0}m</span><span><span data-albedu-icon="quiz"></span> ${tq} soal</span>${e.identity_mode ? `<span><span data-albedu-icon="badge"></span> ${e.identity_mode === 'daftar' ? 'Daftar' : 'Manual'}</span>` : ''}</div><div class="albedu-exam-card-date">Dibuat: ${_fmtDate(e.created_at)}</div></article>`;
      }).join('');
      _bindIcons(this._grid);
    },

    refresh() { return this.load(); },

    // ── Auto-refetch on auth state change ──────────────────────
    _subscribeAuthChanges() {
      if (!window.AlbEdu?.supabase?.auth?.onAuthStateChange) return;
      // Defer subscription until platform is ready
      const trySubscribe = () => {
        if (!window.AlbEdu?.supabase?.auth?.onAuthStateChange) {
          setTimeout(trySubscribe, 200);
          return;
        }
        this._unsubAuth = window.AlbEdu.supabase.auth.onAuthStateChange((user, event) => {
          if (event === 'INITIALIZE') return; // load() already running
          if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
            this.load();
          }
          if (event === 'SIGNED_OUT') {
            this._allData = [];
            this._setState('unauthorized', { requestId: ++this._requestId });
          }
        });
      };
      trySubscribe();
    },
  };

  window.ListView = ListView;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ListView.init());
  else ListView.init();
})();
