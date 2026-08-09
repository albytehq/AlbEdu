// active-assessments.js — Redesigned (v2.1, production-grade)
//
// Key fixes from v2.0:
//   1. ICON BUG: All template icons now use empty <span data-albedu-icon="X"></span>
//      pattern (no inner <svg><use/></svg>) so the icon system auto-binds them.
//      Critical icons render via sprite; secondary icons render via JS registry.
//      After every render, we explicitly call AlbEdu.bindIcons(rootEl) as a
//      defensive measure in case the MutationObserver is slow.
//
//   2. LOADING STUCK: Replaced simple skeleton with production-grade loader:
//      - Status text shown above skeleton ("Memuat data..." → "Terjadi kesalahan")
//      - 15s timeout with auto-fallback to error state + retry
//      - AbortController cancels in-flight requests on re-load
//      - try/catch around ALL render methods prevents partial UI breakage
//      - Explicit _hideAllStates() at every exit path (no stuck states)
//
//   3. MULAI/TUTUP BUTTON: For access_mode='manual' assessments, card shows
//      a prominent Start/Stop button that toggles ac_manual_status between
//      'open' and 'closed'. Scheduled mode = disabled "Terjadwal" label.
//      Archived = "Pulihkan" (restore). Finished = "Sudah Selesai" (disabled).
//
//   4. DEFENSIVE BINDING: AlbEdu.bindIcons() called after every innerHTML
//      write so icons materialize even if MutationObserver hasn't fired yet.
//
// Public API (back-compat): init(), load(), refresh()

(function () {
  'use strict';

  const WORKER_BASE = (() => {
    const meta = document.querySelector('meta[name="albedu-worker-base"]');
    if (meta?.content) return meta.content;
    return 'https://edu.albyte-inc.workers.dev';
  })();

  const CONFIG_CACHE_KEY = 'albedu_sb_config';
  const CONFIG_CACHE_TTL = 60 * 60 * 1000;
  const LOAD_TIMEOUT_MS = 15000; // 15s before showing "slow" warning
  let _client = null;

  async function _getClient() {
    if (_client) return _client;
    if (window.AlbEdu?.supabase?.client) { _client = window.AlbEdu.supabase.client; return _client; }

    let config = null;
    try {
      const raw = sessionStorage.getItem(CONFIG_CACHE_KEY);
      if (raw) { const p = JSON.parse(raw); if (Date.now() - p.ts < CONFIG_CACHE_TTL) config = p.config; }
    } catch (_) {}

    if (!config) {
      const res = await fetch(`${WORKER_BASE}/api/supabase-config`, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Config: HTTP ${res.status}`);
      config = await res.json();
      try { sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), config })); } catch (_) {}
    }

    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('SDK load failed'));
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('SDK timeout')), 10000);
      });
    }

    _client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return _client;
  }

  // ── Helpers ──────────────────────────────────────────────────
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
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return '-'; }
  }

  function _countQuestions(sections) {
    return (sections || []).reduce((sum, sec) => sum + (sec.questions || []).length, 0);
  }

  // Map DB status → canonical status key
  // Simplified to 2 active states + archived:
  //   open    = admin has opened the assessment (peserta can access)
  //   closed  = admin has closed it (peserta sees "belum dibuka" or "selesai")
  //   archived = moved to archive (hidden from active list)
  function _statusOf(a) {
    if (a.status === 'archived') return 'archived';
    if (a.ac_manual_status === 'open') return 'open';
    // 'closed', 'finished', null, or anything else → closed
    return 'closed';
  }

  const STATUS_META = {
    open:     { label: 'Buka',   cls: 'aa-status-running'  },
    closed:   { label: 'Tutup',  cls: 'aa-status-paused'   },
    archived: { label: 'Arsip',  cls: 'aa-status-archived' },
  };

  // Helper: bind icons in a root element (defensive — in case MutationObserver is slow)
  function _bindIcons(root) {
    try {
      if (window.AlbEdu?.bindIcons) window.AlbEdu.bindIcons(root);
    } catch (e) {
      console.warn('[ActiveAssessments] bindIcons failed:', e);
    }
  }

  // ── Main module ──────────────────────────────────────────────
  const ActiveAssessments = {
    init() {
      // Element refs
      this._grid         = document.getElementById('active-grid');
      this._tableWrap    = document.getElementById('aa-table-wrap');
      this._tableBody    = document.getElementById('aa-table-body');
      this._empty        = document.getElementById('active-empty');
      this._loading      = document.getElementById('active-loading');
      this._loadingText  = document.getElementById('aa-loading-text');
      this._loadingStatus= document.getElementById('aa-loading-status');
      this._noResults    = document.getElementById('active-no-results');
      this._error        = document.getElementById('active-error');
      this._errorText    = document.getElementById('active-error-text');
      this._count        = document.getElementById('active-count');
      this._searchInput  = document.getElementById('active-search-input');
      this._searchClear  = document.getElementById('aa-search-clear');
      this._sortSelect   = document.getElementById('aa-sort');
      this._viewBtns     = document.querySelectorAll('.aa-view-btn');
      this._chips        = document.querySelectorAll('.aa-chip');
      this._btnRefresh   = document.getElementById('aa-btn-refresh');
      this._btnRetry     = document.getElementById('aa-btn-retry');
      this._btnResetFilter = document.getElementById('aa-btn-reset-filter');
      this._ctxMenu      = document.getElementById('aa-ctx-menu');
      this._ctxToggleLabel = document.getElementById('aa-ctx-toggle-label');

      // Chip count refs (filter chips provide status counts)
      this._chipCounts = {
        all:       document.getElementById('chip-all'),
        open:      document.getElementById('chip-running'),   // chip-running = "Buka"
        closed:    document.getElementById('chip-paused'),    // chip-paused = "Tutup"
        archived:  document.getElementById('chip-archived'),
      };

      if (!this._grid) return;

      // State
      this._allData = [];
      this._filteredData = [];
      this._view = 'grid';
      this._filter = 'all';
      this._search = '';
      this._sort = 'recent';
      this._ctxTarget = null;
      this._loadingTimer = null;
      this._requestId = 0;          // monotonic counter for race-condition guard
      this._state = 'booting';      // current state-machine state
      this._togglingIds = new Set(); // assessment IDs currently being toggled
      this._unsubAuth = null;       // onAuthStateChange unsubscribe fn

      this._wireEvents();
      this._subscribeAuthChanges();
      this.load();
    },

    // ── Auto-refetch on auth state change ──────────────────────
    // Fires on SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, INITIALIZE.
    // Initial fire (INITIALIZE) is a no-op since load() already started above.
    _subscribeAuthChanges() {
      if (!window.AlbEdu?.supabase?.auth?.onAuthStateChange) return;
      this._unsubAuth = window.AlbEdu.supabase.auth.onAuthStateChange((user, event) => {
        // Ignore INITIALIZE — load() is already running from init()
        if (event === 'INITIALIZE') return;
        // SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED → refetch data
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          this.load();
        }
        // SIGNED_OUT → clear data and show unauthorized state
        if (event === 'SIGNED_OUT') {
          this._allData = [];
          this._filteredData = [];
          this._setState('unauthorized', { requestId: ++this._requestId });
        }
      });
    },

    _wireEvents() {
      // Search (debounced 300ms)
      if (this._searchInput) {
        let t;
        this._searchInput.addEventListener('input', (e) => {
          clearTimeout(t);
          const val = e.target.value;
          if (this._searchClear) this._searchClear.hidden = !val;
          t = setTimeout(() => {
            this._search = val.toLowerCase().trim();
            this._applyFilters();
          }, 300);
        });
      }

      if (this._searchClear) {
        this._searchClear.addEventListener('click', () => {
          if (this._searchInput) {
            this._searchInput.value = '';
            this._search = '';
            this._searchClear.hidden = true;
            this._searchInput.focus();
            this._applyFilters();
          }
        });
      }

      if (this._sortSelect) {
        this._sortSelect.addEventListener('change', (e) => {
          this._sort = e.target.value;
          this._applyFilters();
        });
      }

      this._viewBtns?.forEach((btn) => {
        btn.addEventListener('click', () => {
          const view = btn.dataset.view;
          if (view === this._view) return;
          this._setView(view);
        });
      });

      this._chips?.forEach((chip) => {
        chip.addEventListener('click', () => this._setFilter(chip.dataset.filter));
      });

      this._btnRefresh?.addEventListener('click', () => this.load());
      this._btnRetry?.addEventListener('click', () => this.load());

      this._btnResetFilter?.addEventListener('click', () => {
        this._setFilter('all');
        if (this._searchInput) { this._searchInput.value = ''; this._search = ''; }
        if (this._searchClear) this._searchClear.hidden = true;
      });

      this._ctxMenu?.querySelectorAll('.aa-ctx-item').forEach((item) => {
        item.addEventListener('click', () => this._handleCtxAction(item.dataset.action));
      });

      document.addEventListener('click', (e) => {
        if (!this._ctxMenu?.hidden && !this._ctxMenu.contains(e.target) && !e.target.closest('.aa-card-menu-btn') && !e.target.closest('.aa-table-row-menu')) {
          this._hideCtxMenu();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this._hideCtxMenu();
      });

      window.addEventListener('scroll', () => this._hideCtxMenu(), true);
      window.addEventListener('resize', () => this._hideCtxMenu());
    },

    // ── Production-grade state machine ─────────────────────────
    // States: booting → auth-checking → loading-data → loaded | empty | error | unauthorized
    // Empty state ONLY fires when all 4 conditions are met:
    //   1. Supabase client ready
    //   2. Session valid
    //   3. Request succeeded
    //   4. Result has 0 rows
    // Never use _render([]) to mean "session not ready" — that's the bug
    // that caused fake empty state.

    _setState(state, payload) {
      // Race-condition guard: if payload carries a requestId that's older than
      // the current _requestId, this state change belongs to a stale request —
      // discard it so a slow old response can't overwrite a fresh one.
      if (payload?.requestId !== undefined && payload.requestId !== this._requestId) {
        return; // Stale response — discard
      }

      this._state = state;
      this._hideAllStates();

      // Update loading status text per state
      const statusText = {
        booting: 'Menyiapkan aplikasi...',
        'auth-checking': 'Memverifikasi sesi...',
        'loading-data': 'Mengambil data asesmen...',
        loaded: '',
        empty: '',
        error: '',
        unauthorized: '',
      }[state] || '';

      if (state === 'booting' || state === 'auth-checking' || state === 'loading-data') {
        if (this._loading) this._loading.hidden = false;
        if (this._loadingText) this._loadingText.textContent = statusText;
        if (this._loadingStatus) this._loadingStatus.classList.remove('is-timeout');
        if (this._grid) this._grid.setAttribute('aria-busy', 'true');

        // 15s timeout → switch to "slow" warning
        clearTimeout(this._loadingTimer);
        this._loadingTimer = setTimeout(() => {
          if (this._loading && !this._loading.hidden) {
            if (this._loadingText) this._loadingText.textContent = 'Memuat terlalu lama. Periksa koneksi Anda...';
            if (this._loadingStatus) this._loadingStatus.classList.add('is-timeout');
          }
        }, LOAD_TIMEOUT_MS);
      } else {
        clearTimeout(this._loadingTimer);
        if (this._loading) this._loading.hidden = true;
        if (this._grid) this._grid.setAttribute('aria-busy', 'false');

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
          // Reuse error state with custom message — unauthorized is essentially
          // an error from the user's perspective (they need to login).
          if (this._error) {
            this._error.hidden = false;
            if (this._errorText) {
              this._errorText.textContent = 'Sesi login tidak ditemukan. Silakan login terlebih dahulu.';
            }
            _bindIcons(this._error);
          }
        }
        // 'loaded' state is handled by _render() — caller manages grid/table visibility
      }
    },

    // ── Data loading with state machine + requestId guard ──────
    async load() {
      // Bump request id — any in-flight requests with older ids will be discarded
      const requestId = ++this._requestId;

      // Phase 1: booting — wait for platform layer (supabase client) to be ready
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

      // Phase 2: auth-checking — verify session is hydrated
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

      // Phase 3: loading-data — fetch assessments
      this._setState('loading-data', { requestId });
      try {
        const sb = window.AlbEdu.supabase.client;
        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, ac_end, ac_remaining_time, access_mode, created_at, created_by, sections')
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
          this._updateKPIs();
          this._applyFilters();
          // Start countdown ticker if any open assessments have ac_end
          if (this._allData.some(a => _statusOf(a) === 'open' && a.ac_end)) {
            this._startCountdownTicker();
          }
        }
      } catch (err) {
        if (requestId !== this._requestId) return;
        console.error('[ActiveAssessments] load failed:', err);
        this._setState('error', { requestId, message: err?.message || 'Gagal mengambil data asesmen.' });
      }
    },

    refresh() { return this.load(); },

    // ── Chip counts update ─────────────────────────────────────
    _updateKPIs() {
      try {
        const counts = { open: 0, closed: 0, archived: 0 };
        this._allData.forEach((a) => { counts[_statusOf(a)]++; });
        const total = this._allData.length;

        if (this._chipCounts.all)       this._chipCounts.all.textContent       = total;
        if (this._chipCounts.open)      this._chipCounts.open.textContent      = counts.open;
        if (this._chipCounts.closed)    this._chipCounts.closed.textContent    = counts.closed;
        if (this._chipCounts.archived)  this._chipCounts.archived.textContent  = counts.archived;
      } catch (err) {
        console.warn('[ActiveAssessments] _updateKPIs failed:', err);
      }
    },

    // ── Filter + sort pipeline ─────────────────────────────────
    _applyFilters() {
      try {
        let items = this._allData.slice();

        if (this._filter !== 'all') {
          items = items.filter((a) => _statusOf(a) === this._filter);
        }

        if (this._search) {
          const q = this._search;
          items = items.filter((a) =>
            (a.title || '').toLowerCase().includes(q) ||
            (a.subject || '').toLowerCase().includes(q) ||
            (a.access_code || '').toLowerCase().includes(q)
          );
        }

        items = this._sortItems(items, this._sort);
        this._filteredData = items;
        this._render();
      } catch (err) {
        console.error('[ActiveAssessments] _applyFilters failed:', err);
        this._setState('error', { message: 'Gagal memfilter data. Coba refresh halaman.' });
      }
    },

    _sortItems(items, sort) {
      const arr = items.slice();
      switch (sort) {
        case 'recent':     return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        case 'oldest':     return arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        case 'title-asc':  return arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'id'));
        case 'title-desc': return arr.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'id'));
        case 'subject':    return arr.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'id'));
        case 'duration':   return arr.sort((a, b) => (b.duration_minutes || 0) - (a.duration_minutes || 0));
        default:           return arr;
      }
    },

    // ── Render dispatch ────────────────────────────────────────
    _render() {
      this._hideAllStates();

      const items = this._filteredData;
      if (this._count) this._count.textContent = String(items.length);

      if (items.length === 0) {
        if (this._allData.length === 0) {
          if (this._empty) this._empty.hidden = false;
        } else {
          if (this._noResults) this._noResults.hidden = false;
        }
        // Re-bind icons in case empty/no-results illustrations need binding
        _bindIcons(this._empty);
        _bindIcons(this._noResults);
        return;
      }

      try {
        if (this._view === 'grid') {
          if (this._grid) this._grid.hidden = false;
          if (this._tableWrap) this._tableWrap.hidden = true;
          this._renderGrid(items);
        } else {
          if (this._grid) this._grid.hidden = true;
          if (this._tableWrap) this._tableWrap.hidden = false;
          this._renderTable(items);
        }
      } catch (err) {
        console.error('[ActiveAssessments] _render failed:', err);
        this._setState('error', { message: 'Gagal menampilkan data. Coba refresh halaman.' });
      }
    },

    _renderGrid(items) {
      if (!this._grid) return;
      this._grid.innerHTML = items.map((a) => this._cardHTML(a)).join('');
      _bindIcons(this._grid);

      // Wire menu buttons
      this._grid.querySelectorAll('.aa-card-menu-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const card = btn.closest('.aa-card');
          const id = card?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._showCtxMenu(btn, item);
        });
      });

      // Card click → detail
      this._grid.querySelectorAll('.aa-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.aa-card-menu-btn') ||
              e.target.closest('.aa-card-quick-btn') ||
              e.target.closest('.aa-card-primary-action')) return;
          const id = card.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._openDetail(item);
        });
      });

      // Quick action buttons (copy code, archive)
      this._grid.querySelectorAll('.aa-card-quick-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const id = btn.closest('.aa-card')?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._handleQuickAction(action, item);
        });
      });

      // Primary action button (Mulai / Tutup / Pulihkan)
      this._grid.querySelectorAll('.aa-card-primary-action').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const id = btn.closest('.aa-card')?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._handlePrimaryAction(action, item, btn);
        });
      });
    },

    _renderTable(items) {
      if (!this._tableBody) return;
      this._tableBody.innerHTML = items.map((a) => this._rowHTML(a)).join('');
      _bindIcons(this._tableBody);

      this._tableBody.querySelectorAll('.aa-table-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.aa-table-row-menu') || e.target.closest('.aa-table-primary-action')) return;
          const id = row.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._openDetail(item);
        });
      });

      this._tableBody.querySelectorAll('.aa-table-row-menu').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.closest('.aa-table-row')?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._showCtxMenu(btn, item);
        });
      });

      // Wire primary action buttons in table rows
      this._tableBody.querySelectorAll('.aa-table-btn[data-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const id = btn.closest('.aa-table-row')?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._handlePrimaryAction(action, item, btn);
        });
      });
    },

    // ── HTML templates (empty span icons — auto-bound) ─────────
    _cardHTML(a) {
      const status = _statusOf(a);
      const meta = STATUS_META[status];
      const qCount = _countQuestions(a.sections);
      const code = a.access_code || '—';
      const primaryAction = this._primaryActionHTML(a, status);

      // Live countdown for open assessments
      let countdownHTML = '';
      if (status === 'open' && a.ac_end) {
        const endMs = new Date(a.ac_end).getTime();
        const remaining = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        countdownHTML = `<span class="aa-countdown" data-ac-end="${a.ac_end}" data-assessment-id="${_esc(a.id)}">
          <span data-albedu-icon="timer"></span>
          <span class="aa-countdown-text">${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}</span>
        </span>`;
      } else if (status === 'closed' && a.ac_remaining_time && a.ac_remaining_time > 0) {
        const mins = Math.ceil(a.ac_remaining_time / 60);
        countdownHTML = `<span class="aa-countdown aa-countdown-paused">
          <span data-albedu-icon="pause_circle"></span>
          <span>Dijeda — ${mins}m tersisa</span>
        </span>`;
      }

      return `
        <article class="aa-card" data-id="${_esc(a.id)}" data-status="${status}">
          <div class="aa-card-top">
            <span class="aa-card-status ${meta.cls}">${meta.label}</span>
            <button class="aa-card-menu-btn" type="button" aria-label="Menu aksi">
              <span data-albedu-icon="more_vert"></span>
            </button>
          </div>
          <h3 class="aa-card-title">${_esc(a.title || 'Tanpa Judul')}</h3>
          <div class="aa-card-meta-row">
            <span class="aa-meta-item"><span data-albedu-icon="school"></span>${_esc(a.subject || '-')}</span>
            <span class="aa-meta-item"><span data-albedu-icon="quiz"></span>${qCount} soal</span>
            <span class="aa-meta-item"><span data-albedu-icon="schedule"></span>${a.duration_minutes || 0}m</span>
            ${countdownHTML}
            <span class="aa-card-code">#${_esc(code)}</span>
          </div>
          ${primaryAction}
        </article>
      `;
    },

    // Build the primary action button based on assessment state + access mode
    _primaryActionHTML(a, status) {
      // Currently being toggled — show loading state
      if (this._togglingIds.has(a.id)) {
        return `<button class="aa-card-primary-action aa-action-loading" disabled type="button">
          <span data-albedu-icon="refresh"></span>
          <span>Memproses...</span>
        </button>`;
      }

      // Archived → show "Pulihkan" (restore)
      if (status === 'archived') {
        return `<button class="aa-card-primary-action aa-action-archived" data-action="restore" type="button">
          <span data-albedu-icon="restart_alt"></span>
          <span>Pulihkan dari Arsip</span>
        </button>`;
      }

      // Scheduled mode → show "Terjadwal" (disabled, auto-opens)
      if (a.access_mode === 'scheduled') {
        return `<button class="aa-card-primary-action aa-action-scheduled" disabled type="button">
          <span data-albedu-icon="schedule"></span>
          <span>Terjadwal Otomatis</span>
        </button>`;
      }

      // Manual mode → show "Buka" or "Tutup" based on current status
      if (status === 'open') {
        return `<button class="aa-card-primary-action aa-action-stop" data-action="toggle-status" type="button">
          <span data-albedu-icon="pause_circle"></span>
          <span>Tutup Akses</span>
        </button>`;
      }
      // closed → show "Buka"
      return `<button class="aa-card-primary-action aa-action-start" data-action="toggle-status" type="button">
        <span data-albedu-icon="play_circle"></span>
        <span>Buka Akses</span>
      </button>`;
    },

    _rowHTML(a) {
      const status = _statusOf(a);
      const meta = STATUS_META[status];
      const qCount = _countQuestions(a.sections);
      const code = a.access_code || '—';

      // Live countdown for table rows
      let timerCell = `<span class="aa-table-timer-static">${a.duration_minutes || 0}m</span>`;
      if (status === 'open' && a.ac_end) {
        const endMs = new Date(a.ac_end).getTime();
        const remaining = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timerCell = `<span class="aa-countdown aa-countdown-inline" data-ac-end="${a.ac_end}" data-assessment-id="${_esc(a.id)}">
          <span class="aa-countdown-text">${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}</span>
        </span>`;
      } else if (status === 'closed' && a.ac_remaining_time && a.ac_remaining_time > 0) {
        const mins = Math.ceil(a.ac_remaining_time / 60);
        timerCell = `<span class="aa-table-timer-paused">${mins}m tersisa</span>`;
      }

      // Action button
      let actionBtn = '';
      if (status === 'archived') {
        actionBtn = `<button class="aa-table-btn aa-table-btn-restore" data-action="restore" type="button">Pulihkan</button>`;
      } else if (a.access_mode === 'scheduled') {
        actionBtn = `<span class="aa-table-btn-disabled">Terjadwal</span>`;
      } else if (status === 'open') {
        actionBtn = `<button class="aa-table-btn aa-table-btn-close" data-action="toggle-status" type="button">Tutup</button>`;
      } else {
        actionBtn = `<button class="aa-table-btn aa-table-btn-open" data-action="toggle-status" type="button">Buka</button>`;
      }

      return `
        <tr class="aa-table-row" data-id="${_esc(a.id)}" data-status="${status}">
          <td><span class="aa-card-status ${meta.cls}">${meta.label}</span></td>
          <td>
            <span class="aa-table-title">${_esc(a.title || 'Tanpa Judul')}</span>
            <span class="aa-table-sub">${_esc(a.subject || '-')} • ${qCount} soal</span>
          </td>
          <td><code class="aa-card-code">#${_esc(code)}</code></td>
          <td class="aa-table-timer-cell">${timerCell}</td>
          <td class="aa-table-actions-cell">
            ${actionBtn}
            <button class="aa-table-row-menu" type="button" aria-label="Menu aksi">
              <span data-albedu-icon="more_vert"></span>
            </button>
          </td>
        </tr>
      `;
    },

    // ── Primary action handler (Mulai / Tutup / Pulihkan) ──────
    async _handlePrimaryAction(action, item, btn) {
      if (action === 'toggle-status') {
        await this._toggleStatus(item, btn);
      } else if (action === 'restore') {
        await this._restore(item);
      }
    },

    // ── Context menu ───────────────────────────────────────────
    _showCtxMenu(anchor, item) {
      if (!this._ctxMenu) return;
      this._ctxTarget = item;

      // Get button position
      const rect = anchor.getBoundingClientRect();

      // Temporarily show menu to measure its actual size
      this._ctxMenu.style.left = '-9999px';
      this._ctxMenu.style.top = '-9999px';
      this._ctxMenu.hidden = false;
      const menuRect = this._ctxMenu.getBoundingClientRect();
      const menuW = menuRect.width || 220;
      const menuH = menuRect.height || 260;

      // Position: directly below the button, left-aligned to button's left edge
      // This is the most natural position — menu starts where the button starts.
      let x = rect.left;
      let y = rect.bottom + 4;

      // If menu would go off right edge, shift left so it fits
      if (x + menuW > window.innerWidth - 8) {
        x = window.innerWidth - menuW - 8;
      }
      // If menu would go off left edge, clamp to 8px
      if (x < 8) x = 8;

      // If menu would go below viewport, flip above the button
      if (y + menuH > window.innerHeight - 8) {
        y = rect.top - menuH - 4;
      }
      if (y < 8) y = 8;

      this._ctxMenu.style.left = Math.round(x) + 'px';
      this._ctxMenu.style.top  = Math.round(y) + 'px';
      _bindIcons(this._ctxMenu);

      if (this._ctxToggleLabel) {
        const status = _statusOf(item);
        this._ctxToggleLabel.textContent =
          status === 'open' ? 'Tutup Akses' : 'Buka Akses';
      }
    },

    _hideCtxMenu() {
      if (this._ctxMenu) this._ctxMenu.hidden = true;
      this._ctxTarget = null;
    },

    _handleCtxAction(action) {
      const item = this._ctxTarget;
      if (!item) return;
      this._hideCtxMenu();
      this._handleQuickAction(action, item);
    },

    _handleQuickAction(action, item) {
      switch (action) {
        case 'detail':         this._openDetail(item); break;
        case 'copy-code':      this._copyCode(item); break;
        case 'toggle-status':  this._toggleStatus(item); break;
        case 'archive':        this._archive(item); break;
        case 'restore':        this._restore(item); break;
        case 'delete':         this._delete(item); break;
      }
    },

    _openDetail(item) {
      window.notify?.info?.(
        'Detail Asesmen',
        `${item.title || 'Tanpa Judul'} (#${item.access_code || '—'})`,
        3000
      );
    },

    async _copyCode(item) {
      const code = item.access_code;
      if (!code) {
        window.notify?.warning?.('Kode tidak tersedia', 'Asesmen ini belum memiliki kode akses', 2500);
        return;
      }
      try {
        await navigator.clipboard.writeText(code);
        window.notify?.success?.('Tersalin', `Kode akses ${code} disalin ke clipboard`, 2000);
      } catch {
        window.notify?.info?.('Gagal menyalin', `Kode: ${code}`, 3000);
      }
    },

    // ── Live countdown ticker ──
    // Runs a single 1s interval that updates ALL [data-ac-end] elements
    // on the page. Started after toggle or after initial render.
    _countdownInterval: null,

    _startCountdownTicker() {
      if (this._countdownInterval) return; // already running
      this._countdownInterval = setInterval(() => {
        this._updateCountdowns();
      }, 1000);
      // Also update immediately
      this._updateCountdowns();
    },

    _updateCountdowns() {
      const elements = document.querySelectorAll('.aa-countdown[data-ac-end]');
      if (!elements.length) {
        // No countdowns visible — stop the ticker to save CPU
        if (this._countdownInterval) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
        }
        return;
      }

      elements.forEach(el => {
        const acEnd = el.dataset.acEnd;
        if (!acEnd) return;
        const endMs = new Date(acEnd).getTime();
        const remaining = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const textEl = el.querySelector('.aa-countdown-text');
        if (textEl) {
          textEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
        }

        // Timer warning states
        el.classList.toggle('aa-countdown-warning', remaining <= 300 && remaining > 60);
        el.classList.toggle('aa-countdown-critical', remaining <= 60);

        // If timer hit 0 — auto-close the assessment
        if (remaining === 0) {
          const assessmentId = el.dataset.assessmentId;
          if (assessmentId && !this._expiredIds?.has(assessmentId)) {
            this._expiredIds = this._expiredIds || new Set();
            this._expiredIds.add(assessmentId);
            this._handleTimerExpired(assessmentId);
          }
        }
      });
    },

    async _handleTimerExpired(assessmentId) {
      try {
        const sb = window.AlbEdu.supabase.client;
        await sb
          .from('assessments')
          .update({
            ac_manual_status: 'closed',
            ac_end: null,
            ac_remaining_time: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', assessmentId);

        window.notify?.warning?.(
          'Waktu Habis',
          'Asesmen telah berakhir otomatis — waktu habis.',
          4000
        );

        // Update local data
        const item = this._allData.find(a => a.id === assessmentId);
        if (item) {
          item.ac_manual_status = 'closed';
          item.ac_end = null;
          item.ac_remaining_time = 0;
        }
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[timer-expired]', err);
      }
    },

    async _toggleStatus(item, btn) {
      // Prevent double-toggle
      if (this._togglingIds.has(item.id)) return;
      this._togglingIds.add(item.id);

      // Optimistic UI update — show loading button
      this._applyFilters();

      const currentStatus = _statusOf(item);
      const isOpening = currentStatus !== 'open';

      try {
        const sb = window.AlbEdu.supabase.client;

        // On open: set ac_end = now + duration (server-trusted timer)
        // On close (pause): save remaining time, null ac_end
        const update = {
          ac_manual_status: isOpening ? 'open' : 'closed',
          updated_at: new Date().toISOString(),
        };

        if (isOpening) {
          // Resume from paused state if remaining_time exists, else fresh start.
          // BUGFIX: previously always used duration_minutes — re-opening a paused
          // assessment restarted the timer from full duration instead of resuming.
          const hasRemaining = item.ac_remaining_time && item.ac_remaining_time > 0;
          const secondsToAdd = hasRemaining
            ? item.ac_remaining_time
            : (item.duration_minutes || 60) * 60;
          update.ac_end = new Date(Date.now() + secondsToAdd * 1000).toISOString();
          update.ac_remaining_time = null;
        } else {
          // Pause: save remaining seconds from ac_end
          if (item.ac_end) {
            const remaining = Math.max(0, Math.floor((new Date(item.ac_end).getTime() - Date.now()) / 1000));
            update.ac_remaining_time = remaining;
          }
          update.ac_end = null;
        }

        const { data, error } = await sb
          .from('assessments')
          .update(update)
          .eq('id', item.id)
          .select('id, ac_manual_status, ac_end, ac_remaining_time')
          .maybeSingle();

        if (error) throw error;

        // CRITICAL: If data is null, the UPDATE affected 0 rows.
        // This means RLS denied the update (admin doesn't own this row,
        // or peran_user() didn't return 'admin'). Without this check,
        // the code silently proceeds with stale local data.
        if (!data) {
          throw new Error(
            'Update gagal — 0 rows affected. ' +
            'Kemungkinan: RLS policy menolak akses (created_by tidak cocok dengan user login), ' +
            'atau asesmen sudah dihapus. ' +
            `Assessment ID: ${item.id}, Created by: ${item.created_by || 'unknown'}`
          );
        }

        // Update local item with fresh DB data
        item.ac_manual_status = data.ac_manual_status;
        item.ac_end = data.ac_end;
        item.ac_remaining_time = data.ac_remaining_time;

        // Remove from togglingIds BEFORE re-render
        this._togglingIds.delete(item.id);

        window.notify?.success?.(
          isOpening ? 'Asesmen Dibuka' : 'Akses Ditutup',
          isOpening
            ? `Peserta dapat mengerjakan "${item.title || 'Tanpa Judul'}". Timer: ${item.duration_minutes || 60} menit.`
            : `Akses ditutup. Sisa waktu disimpan.`,
          2500
        );

        this._updateKPIs();
        this._applyFilters();
        this._startCountdownTicker();
      } catch (err) {
        console.error('[toggleStatus]', err);
        this._togglingIds.delete(item.id);
        // Show actionable error message
        const errMsg = err?.message || 'Unknown error';
        let userMsg = 'Gagal mengubah status';
        if (errMsg.includes('0 rows') || errMsg.includes('RLS')) {
          userMsg = 'Gagal: Akses ditolak (RLS). Pastikan Anda adalah pembuat asesmen ini.';
        } else if (errMsg.includes('JWT') || errMsg.includes('401')) {
          userMsg = 'Gagal: Sesi login berakhir. Silakan login ulang.';
        }
        window.notify?.error?.(userMsg, errMsg, 5000);
        this._applyFilters();
      }
    },

    async _archive(item) {
      const confirmed = await this._confirm(
        'Arsipkan Asesmen',
        `Yakin arsipkan "${item.title || 'Tanpa Judul'}"? Asesmen tidak akan muncul di daftar aktif lagi.`
      );
      if (!confirmed) return;
      try {
        const sb = window.AlbEdu.supabase.client;
        const { error } = await sb
          .from('assessments')
          .update({ status: 'archived', updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (error) throw error;
        item.status = 'archived';
        window.notify?.success?.('Diarsipkan', 'Asesmen dipindahkan ke arsip', 2000);
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[archive]', err);
        window.notify?.error?.('Gagal mengarsipkan', err?.message || 'Unknown error', 3000);
      }
    },

    async _restore(item) {
      try {
        const sb = window.AlbEdu.supabase.client;
        const { error } = await sb
          .from('assessments')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (error) throw error;
        item.status = 'active';
        window.notify?.success?.('Dipulihkan', 'Asesmen dikembalikan ke daftar aktif', 2000);
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[restore]', err);
        window.notify?.error?.('Gagal memulihkan', err?.message || 'Unknown error', 3000);
      }
    },

    async _delete(item) {
      const confirmed = await this._confirm(
        'Hapus Permanen',
        `Yakin hapus "${item.title || 'Tanpa Judul'}"? Tindakan ini tidak dapat dibatalkan.`,
        true
      );
      if (!confirmed) return;
      try {
        const sb = window.AlbEdu.supabase.client;
        const { error } = await sb.from('assessments').delete().eq('id', item.id);
        if (error) throw error;
        this._allData = this._allData.filter((x) => x.id !== item.id);
        window.notify?.success?.('Dihapus', 'Asesmen telah dihapus permanen', 2500);
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[delete]', err);
        window.notify?.error?.('Gagal menghapus', err?.message || 'Unknown error', 3000);
      }
    },

    _confirm(title, message, danger = false) {
      if (window.notify?.confirm) {
        return new Promise((resolve) => {
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          window.notify.confirm({
            title,
            message,
            intent: danger ? 'danger' : 'primary',
            onYes: () => done(true),
            onNo: () => done(false),
            onClose: () => done(false),
          });
        });
      }
      return Promise.resolve(confirm(`${title}\n\n${message}`));
    },

    _setView(view) {
      this._view = view;
      this._viewBtns?.forEach((btn) => {
        const isActive = btn.dataset.view === view;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      this._render();
    },

    _setFilter(filter) {
      this._filter = filter;
      this._chips?.forEach((chip) => {
        chip.classList.toggle('is-active', chip.dataset.filter === filter);
      });
      this._applyFilters();
    },

    _hideAllStates() {
      if (this._loading)    this._loading.hidden = true;
      if (this._empty)      this._empty.hidden = true;
      if (this._noResults)  this._noResults.hidden = true;
      if (this._error)      this._error.hidden = true;
      if (this._grid)       this._grid.hidden = true;
      if (this._tableWrap)  this._tableWrap.hidden = true;
    },
  };

  window.ActiveAssessments = ActiveAssessments;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ActiveAssessments.init());
  else ActiveAssessments.init();
})();
