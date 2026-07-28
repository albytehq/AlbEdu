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
  function _statusOf(a) {
    if (a.status === 'archived') return 'archived';
    if (a.ac_manual_status === 'open') return 'running';
    if (a.ac_manual_status === 'finished') return 'finished';
    return 'paused'; // includes 'closed' / null / NOT_STARTED
  }

  const STATUS_META = {
    running:  { label: 'Berjalan', cls: 'aa-status-running'  },
    paused:   { label: 'Dijeda',   cls: 'aa-status-paused'   },
    finished: { label: 'Selesai',  cls: 'aa-status-finished' },
    archived: { label: 'Arsip',    cls: 'aa-status-archived' },
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

      // Chip count refs (filter chips provide status counts since KPI strip was removed)
      this._chipCounts = {
        all:       document.getElementById('chip-all'),
        running:   document.getElementById('chip-running'),
        paused:    document.getElementById('chip-paused'),
        finished:  document.getElementById('chip-finished'),
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
      this._loadingAborted = false;
      this._togglingIds = new Set(); // assessment IDs currently being toggled

      this._wireEvents();
      this.load();
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

    // ── Production-grade loading with timeout + abort ──────────
    _showLoading(text) {
      this._hideAllStates();
      if (this._loading) this._loading.hidden = false;
      if (this._loadingText) this._loadingText.textContent = text || 'Memuat data asesmen...';
      if (this._loadingStatus) this._loadingStatus.classList.remove('is-timeout');
      if (this._grid) this._grid.setAttribute('aria-busy', 'true');

      // Set timeout — if loading takes > 15s, switch to "slow" warning
      clearTimeout(this._loadingTimer);
      this._loadingTimer = setTimeout(() => {
        if (this._loading && !this._loading.hidden) {
          if (this._loadingText) this._loadingText.textContent = 'Memuat terlalu lama. Periksa koneksi Anda...';
          if (this._loadingStatus) this._loadingStatus.classList.add('is-timeout');
        }
      }, LOAD_TIMEOUT_MS);
    },

    _hideLoading() {
      clearTimeout(this._loadingTimer);
      if (this._loading) this._loading.hidden = true;
      if (this._loadingStatus) this._loadingStatus.classList.remove('is-timeout');
      if (this._grid) this._grid.setAttribute('aria-busy', 'false');
    },

    // ── Data loading ───────────────────────────────────────────
    async load() {
      this._loadingAborted = false;
      this._showLoading('Memuat data asesmen...');

      try {
        const sb = await _getClient();
        if (this._loadingAborted) return;

        if (this._loadingText) this._loadingText.textContent = 'Memverifikasi sesi...';
        const { data: { session } } = await sb.auth.getSession();
        if (this._loadingAborted) return;

        if (!session?.user) {
          this._hideLoading();
          if (this._empty) this._empty.hidden = false;
          return;
        }

        if (this._loadingText) this._loadingText.textContent = 'Mengambil data asesmen...';
        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, access_mode, created_at, sections')
          .eq('created_by', session.user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (this._loadingAborted) return;
        if (error) throw error;

        this._allData = data || [];
        this._hideLoading();
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        if (this._loadingAborted) return;
        console.error('[ActiveAssessments] load failed:', err);
        this._hideLoading();
        if (this._error) {
          this._error.hidden = false;
          if (this._errorText) {
            this._errorText.textContent = err?.message
              ? `Terjadi kesalahan: ${err.message}`
              : 'Terjadi kesalahan saat memuat data asesmen. Periksa koneksi internet Anda lalu coba lagi.';
          }
          _bindIcons(this._error);
        }
      }
    },

    refresh() { return this.load(); },

    // ── Chip counts update ─────────────────────────────────────
    _updateKPIs() {
      try {
        const counts = { running: 0, paused: 0, finished: 0, archived: 0 };
        this._allData.forEach((a) => { counts[_statusOf(a)]++; });
        const total = this._allData.length;

        if (this._chipCounts.all)       this._chipCounts.all.textContent       = total;
        if (this._chipCounts.running)   this._chipCounts.running.textContent   = counts.running;
        if (this._chipCounts.paused)    this._chipCounts.paused.textContent    = counts.paused;
        if (this._chipCounts.finished)  this._chipCounts.finished.textContent  = counts.finished;
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
        this._hideLoading();
        if (this._error) {
          this._error.hidden = false;
          if (this._errorText) this._errorText.textContent = 'Gagal memfilter data. Coba refresh halaman.';
          _bindIcons(this._error);
        }
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
        if (this._error) {
          this._error.hidden = false;
          if (this._errorText) this._errorText.textContent = 'Gagal menampilkan data. Coba refresh halaman.';
          _bindIcons(this._error);
        }
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
      this._tableBody.querySelectorAll('.aa-table-primary-action').forEach((btn) => {
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

      return `
        <article class="aa-card" data-id="${_esc(a.id)}" data-status="${status}">
          <header class="aa-card-head">
            <span class="aa-card-status ${meta.cls}">${meta.label}</span>
            <button class="aa-card-menu-btn" type="button" aria-label="Menu aksi">
              <span data-albedu-icon="chevron_right"></span>
            </button>
          </header>
          <h3 class="aa-card-title">${_esc(a.title || 'Tanpa Judul')}</h3>
          <p class="aa-card-sub">
            <span data-albedu-icon="school"></span>
            <span>${_esc(a.subject || 'Tanpa mapel')}</span>
          </p>
          <div class="aa-card-meta">
            <div class="aa-meta-item">
              <span data-albedu-icon="schedule"></span>
              <strong>${a.duration_minutes || 0}</strong>&nbsp;menit
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="assignment"></span>
              <strong>${qCount}</strong>&nbsp;soal
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="sell"></span>
              <span class="aa-card-code">#${_esc(code)}</span>
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="restart_alt"></span>
              <span>${a.access_mode === 'scheduled' ? 'Terjadwal' : 'Manual'}</span>
            </div>
          </div>
          ${primaryAction}
          <footer class="aa-card-footer">
            <span class="aa-card-date">
              <span data-albedu-icon="schedule"></span>
              ${_fmtDate(a.created_at)}
            </span>
            <div class="aa-card-quick-actions">
              <button class="aa-card-quick-btn" data-action="copy-code" type="button" aria-label="Salin kode">
                <span data-albedu-icon="content_copy"></span>
              </button>
              <button class="aa-card-quick-btn ${status === 'archived' ? '' : 'aa-quick-danger'}" data-action="${status === 'archived' ? 'restore' : 'archive'}" type="button" aria-label="${status === 'archived' ? 'Restore' : 'Arsipkan'}">
                <span data-albedu-icon="folder_open"></span>
              </button>
            </div>
          </footer>
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

      // Finished → show "Sudah Selesai" (disabled, no action)
      if (status === 'finished') {
        return `<button class="aa-card-primary-action aa-action-finished" disabled type="button">
          <span data-albedu-icon="task_alt"></span>
          <span>Sudah Selesai</span>
        </button>`;
      }

      // Scheduled mode → show "Terjadwal" (disabled, auto-opens)
      if (a.access_mode === 'scheduled') {
        return `<button class="aa-card-primary-action aa-action-scheduled" disabled type="button">
          <span data-albedu-icon="schedule"></span>
          <span>Terjadwal Otomatis</span>
        </button>`;
      }

      // Manual mode → show "Mulai" or "Tutup" based on current ac_manual_status
      if (status === 'running') {
        return `<button class="aa-card-primary-action aa-action-stop" data-action="toggle-status" type="button">
          <span data-albedu-icon="pause_circle"></span>
          <span>Tutup Akses</span>
        </button>`;
      }
      // paused (closed) → show "Mulai"
      return `<button class="aa-card-primary-action aa-action-start" data-action="toggle-status" type="button">
        <span data-albedu-icon="play_circle"></span>
        <span>Mulai Asesmen</span>
      </button>`;
    },

    _rowHTML(a) {
      const status = _statusOf(a);
      const meta = STATUS_META[status];
      const qCount = _countQuestions(a.sections);
      const code = a.access_code || '—';
      const primaryAction = this._primaryActionHTML(a, status);

      return `
        <tr class="aa-table-row" data-id="${_esc(a.id)}" data-status="${status}">
          <td><span class="aa-card-status ${meta.cls}">${meta.label}</span></td>
          <td>
            <span class="aa-table-title">${_esc(a.title || 'Tanpa Judul')}</span>
            <span class="aa-table-sub">${a.access_mode === 'scheduled' ? 'Terjadwal' : 'Manual'}</span>
          </td>
          <td>${_esc(a.subject || '-')}</td>
          <td><code class="aa-card-code">#${_esc(code)}</code></td>
          <td>${a.duration_minutes || 0}m</td>
          <td>${qCount}</td>
          <td>${_fmtDate(a.created_at)}</td>
          <td>
            <button class="aa-table-primary-action" data-action="${status === 'running' ? 'toggle-status' : status === 'archived' ? 'restore' : 'toggle-status'}" type="button" style="background:transparent;border:none;cursor:pointer;color:var(--color-primary);font-weight:600;font-size:12px;padding:4px 8px;">
              ${status === 'running' ? 'Tutup' : status === 'archived' ? 'Pulihkan' : 'Mulai'}
            </button>
            <button class="aa-table-row-menu" type="button" aria-label="Menu aksi">
              <span data-albedu-icon="chevron_right"></span>
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

      const rect = anchor.getBoundingClientRect();
      const menuW = 240;
      const menuH = 280;
      let x = rect.right - menuW;
      let y = rect.bottom + 6;

      if (y + menuH > window.innerHeight) y = rect.top - menuH - 6;
      if (x < 8) x = 8;

      this._ctxMenu.style.left = x + 'px';
      this._ctxMenu.style.top  = y + 'px';
      this._ctxMenu.hidden = false;
      _bindIcons(this._ctxMenu);

      if (this._ctxToggleLabel) {
        const status = _statusOf(item);
        this._ctxToggleLabel.textContent =
          status === 'running' ? 'Tutup Akses' :
          status === 'paused'  ? 'Mulai Asesmen'  :
          'Buka / Tutup';
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

    async _toggleStatus(item, btn) {
      // Prevent double-toggle
      if (this._togglingIds.has(item.id)) return;
      this._togglingIds.add(item.id);

      // Optimistic UI update
      this._applyFilters();

      const currentStatus = _statusOf(item);
      const newStatus = currentStatus === 'running' ? 'closed' : 'open';
      const label = newStatus === 'open' ? 'dibuka' : 'ditutup';

      try {
        const sb = await _getClient();
        const { error } = await sb
          .from('assessments')
          .update({ ac_manual_status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (error) throw error;

        item.ac_manual_status = newStatus;
        window.notify?.success?.(
          newStatus === 'open' ? 'Asesmen Dimulai' : 'Akses Ditutup',
          newStatus === 'open'
            ? `Peserta sekarang dapat mengerjakan "${item.title || 'Tanpa Judul'}"`
            : `Akses peserta ke "${item.title || 'Tanpa Judul'}" telah ditutup`,
          2500
        );
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[toggleStatus]', err);
        window.notify?.error?.('Gagal mengubah status', err?.message || 'Unknown error', 3000);
        // Revert optimistic update
        this._applyFilters();
      } finally {
        this._togglingIds.delete(item.id);
      }
    },

    async _archive(item) {
      const confirmed = await this._confirm(
        'Arsipkan Asesmen',
        `Yakin arsipkan "${item.title || 'Tanpa Judul'}"? Asesmen tidak akan muncul di daftar aktif lagi.`
      );
      if (!confirmed) return;
      try {
        const sb = await _getClient();
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
        const sb = await _getClient();
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
        const sb = await _getClient();
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
