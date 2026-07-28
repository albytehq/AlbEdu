// active-assessments.js — Redesigned (v2, enterprise-grade)
//
// Fetches admin's assessments and renders them in two switchable views
// (card grid + data table). Supports KPI strip, filter chips, search,
// sort, refresh, and a context menu per card/row.
//
// INDEPENDENT: creates own Supabase client, does NOT depend on
// window.AlbEdu.supabase (matches old behavior).
//
// Public API (back-compat):
//   window.ActiveAssessments.init()
//   window.ActiveAssessments.load()       // re-fetch from DB
//   window.ActiveAssessments.refresh()    // alias for load()

(function () {
  'use strict';

  const WORKER_BASE = (() => {
    const meta = document.querySelector('meta[name="albedu-worker-base"]');
    if (meta?.content) return meta.content;
    return 'https://edu.albyte-inc.workers.dev';
  })();

  const CONFIG_CACHE_KEY = 'albedu_sb_config';
  const CONFIG_CACHE_TTL = 60 * 60 * 1000;
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

  // ── Main module ──────────────────────────────────────────────
  const ActiveAssessments = {
    init() {
      // Element refs
      this._grid         = document.getElementById('active-grid');
      this._tableWrap    = document.getElementById('aa-table-wrap');
      this._tableBody    = document.getElementById('aa-table-body');
      this._empty        = document.getElementById('active-empty');
      this._loading      = document.getElementById('active-loading');
      this._noResults    = document.getElementById('active-no-results');
      this._error        = document.getElementById('active-error');
      this._errorText    = document.getElementById('active-error-text');
      this._count        = document.getElementById('active-count');
      this._searchInput  = document.getElementById('active-search-input');
      this._searchClear  = document.getElementById('aa-search-clear');
      this._sortSelect   = document.getElementById('aa-sort');
      this._viewBtns     = document.querySelectorAll('.aa-view-btn');
      this._kpiCards     = document.querySelectorAll('.aa-kpi-card');
      this._chips        = document.querySelectorAll('.aa-chip');
      this._btnRefresh   = document.getElementById('aa-btn-refresh');
      this._btnRetry     = document.getElementById('aa-btn-retry');
      this._btnResetFilter = document.getElementById('aa-btn-reset-filter');
      this._ctxMenu      = document.getElementById('aa-ctx-menu');
      this._ctxToggleLabel = document.getElementById('aa-ctx-toggle-label');

      // KPI value refs
      this._kpi = {
        total:    document.getElementById('kpi-total'),
        running:  document.getElementById('kpi-running'),
        paused:   document.getElementById('kpi-paused'),
        finished: document.getElementById('kpi-finished'),
        archived: document.getElementById('kpi-archived'),
      };
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
      this._view = 'grid';        // 'grid' | 'table'
      this._filter = 'all';       // 'all' | 'running' | 'paused' | 'finished' | 'archived'
      this._search = '';
      this._sort = 'recent';
      this._ctxTarget = null;     // assessment object for context menu

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

      // Search clear
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

      // Sort
      if (this._sortSelect) {
        this._sortSelect.addEventListener('change', (e) => {
          this._sort = e.target.value;
          this._applyFilters();
        });
      }

      // View toggle
      this._viewBtns?.forEach((btn) => {
        btn.addEventListener('click', () => {
          const view = btn.dataset.view;
          if (view === this._view) return;
          this._setView(view);
        });
      });

      // KPI cards → click to filter
      this._kpiCards?.forEach((card) => {
        card.addEventListener('click', () => {
          const f = card.dataset.filter;
          this._setFilter(f);
        });
      });

      // Filter chips
      this._chips?.forEach((chip) => {
        chip.addEventListener('click', () => {
          const f = chip.dataset.filter;
          this._setFilter(f);
        });
      });

      // Refresh
      this._btnRefresh?.addEventListener('click', () => this.load());
      this._btnRetry?.addEventListener('click', () => this.load());

      // Reset filter
      this._btnResetFilter?.addEventListener('click', () => {
        this._setFilter('all');
        if (this._searchInput) { this._searchInput.value = ''; this._search = ''; }
        if (this._searchClear) this._searchClear.hidden = true;
      });

      // Context menu item clicks
      this._ctxMenu?.querySelectorAll('.aa-ctx-item').forEach((item) => {
        item.addEventListener('click', () => {
          const action = item.dataset.action;
          this._handleCtxAction(action);
        });
      });

      // Close context menu on outside click or escape
      document.addEventListener('click', (e) => {
        if (!this._ctxMenu?.hidden && !this._ctxMenu.contains(e.target) && !e.target.closest('.aa-card-menu-btn') && !e.target.closest('.aa-table-row-menu')) {
          this._hideCtxMenu();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this._hideCtxMenu();
      });

      // Re-position context menu on scroll/resize
      window.addEventListener('scroll', () => this._hideCtxMenu(), true);
      window.addEventListener('resize', () => this._hideCtxMenu());
    },

    // ── Data loading ───────────────────────────────────────────
    async load() {
      this._hideAllStates();
      if (this._loading) this._loading.hidden = false;
      if (this._grid) this._grid.setAttribute('aria-busy', 'true');

      try {
        const sb = await _getClient();
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.user) {
          if (this._loading) this._loading.hidden = true;
          if (this._empty) this._empty.hidden = false;
          return;
        }

        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, access_mode, created_at, sections')
          .eq('created_by', session.user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        this._allData = data || [];
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[ActiveAssessments]', err);
        if (this._loading) this._loading.hidden = true;
        if (this._error) {
          this._error.hidden = false;
          if (this._errorText) {
            this._errorText.textContent = err?.message
              ? `Terjadi kesalahan: ${err.message}`
              : 'Terjadi kesalahan saat memuat data asesmen. Periksa koneksi internet Anda lalu coba lagi.';
          }
        }
      } finally {
        if (this._grid) this._grid.setAttribute('aria-busy', 'false');
      }
    },

    refresh() { return this.load(); },

    // ── KPI update ─────────────────────────────────────────────
    _updateKPIs() {
      const counts = { running: 0, paused: 0, finished: 0, archived: 0 };
      this._allData.forEach((a) => { counts[_statusOf(a)]++; });
      const total = this._allData.length;

      if (this._kpi.total)    this._kpi.total.textContent    = total;
      if (this._kpi.running)  this._kpi.running.textContent  = counts.running;
      if (this._kpi.paused)   this._kpi.paused.textContent   = counts.paused;
      if (this._kpi.finished) this._kpi.finished.textContent = counts.finished;
      if (this._kpi.archived) this._kpi.archived.textContent = counts.archived;

      if (this._chipCounts.all)       this._chipCounts.all.textContent       = total;
      if (this._chipCounts.running)   this._chipCounts.running.textContent   = counts.running;
      if (this._chipCounts.paused)    this._chipCounts.paused.textContent    = counts.paused;
      if (this._chipCounts.finished)  this._chipCounts.finished.textContent  = counts.finished;
      if (this._chipCounts.archived)  this._chipCounts.archived.textContent  = counts.archived;
    },

    // ── Filter + sort pipeline ─────────────────────────────────
    _applyFilters() {
      let items = this._allData.slice();

      // Filter by status
      if (this._filter !== 'all') {
        items = items.filter((a) => _statusOf(a) === this._filter);
      }

      // Filter by search query
      if (this._search) {
        const q = this._search;
        items = items.filter((a) =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.subject || '').toLowerCase().includes(q) ||
          (a.access_code || '').toLowerCase().includes(q)
        );
      }

      // Sort
      items = this._sortItems(items, this._sort);
      this._filteredData = items;
      this._render();
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
        // Distinguish "no data at all" vs "no results after filter"
        if (this._allData.length === 0) {
          if (this._empty) this._empty.hidden = false;
        } else {
          if (this._noResults) this._noResults.hidden = false;
        }
        return;
      }

      if (this._view === 'grid') {
        if (this._grid) this._grid.hidden = false;
        if (this._tableWrap) this._tableWrap.hidden = true;
        this._renderGrid(items);
      } else {
        if (this._grid) this._grid.hidden = true;
        if (this._tableWrap) this._tableWrap.hidden = false;
        this._renderTable(items);
      }
    },

    _renderGrid(items) {
      if (!this._grid) return;
      this._grid.innerHTML = items.map((a) => this._cardHTML(a)).join('');

      // Wire menu buttons + card click
      this._grid.querySelectorAll('.aa-card-menu-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const card = btn.closest('.aa-card');
          const id = card?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._showCtxMenu(btn, item);
        });
      });

      this._grid.querySelectorAll('.aa-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.aa-card-menu-btn') || e.target.closest('.aa-card-quick-btn')) return;
          const id = card.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._openDetail(item);
        });
      });

      // Wire quick action buttons
      this._grid.querySelectorAll('.aa-card-quick-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const id = btn.closest('.aa-card')?.dataset.id;
          const item = items.find((x) => x.id === id);
          if (item) this._handleQuickAction(action, item);
        });
      });
    },

    _renderTable(items) {
      if (!this._tableBody) return;
      this._tableBody.innerHTML = items.map((a) => this._rowHTML(a)).join('');

      this._tableBody.querySelectorAll('.aa-table-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.aa-table-row-menu')) return;
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
    },

    // ── HTML templates ─────────────────────────────────────────
    _cardHTML(a) {
      const status = _statusOf(a);
      const meta = STATUS_META[status];
      const qCount = _countQuestions(a.sections);
      const code = a.access_code || '—';

      return `
        <article class="aa-card" data-id="${_esc(a.id)}" data-status="${status}">
          <header class="aa-card-head">
            <span class="aa-card-status ${meta.cls}">${meta.label}</span>
            <button class="aa-card-menu-btn" type="button" aria-label="Menu aksi">
              <svg class="albedu-icon" aria-hidden="true"><use href="#i-chevron_right"/></svg>
            </button>
          </header>
          <h3 class="aa-card-title">${_esc(a.title || 'Tanpa Judul')}</h3>
          <p class="aa-card-sub">
            <span data-albedu-icon="school"><svg class="albedu-icon" aria-hidden="true"><use href="#i-school"/></svg></span>
            <span>${_esc(a.subject || 'Tanpa mapel')}</span>
          </p>
          <div class="aa-card-meta">
            <div class="aa-meta-item">
              <span data-albedu-icon="schedule"><svg class="albedu-icon" aria-hidden="true"><use href="#i-schedule"/></svg></span>
              <strong>${a.duration_minutes || 0}</strong>&nbsp;menit
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="quiz"><svg class="albedu-icon" aria-hidden="true"><use href="#i-quiz"/></svg></span>
              <strong>${qCount}</strong>&nbsp;soal
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="sell"><svg class="albedu-icon" aria-hidden="true"><use href="#i-sell"/></svg></span>
              <span class="aa-card-code">#${_esc(code)}</span>
            </div>
            <div class="aa-meta-item">
              <span data-albedu-icon="timer"><svg class="albedu-icon" aria-hidden="true"><use href="#i-timer"/></svg></span>
              <span>${a.access_mode === 'scheduled' ? 'Terjadwal' : 'Manual'}</span>
            </div>
          </div>
          <footer class="aa-card-footer">
            <span class="aa-card-date">
              <span data-albedu-icon="schedule"><svg class="albedu-icon" aria-hidden="true"><use href="#i-schedule"/></svg></span>
              ${_fmtDate(a.created_at)}
            </span>
            <div class="aa-card-quick-actions">
              <button class="aa-card-quick-btn" data-action="copy-code" type="button" aria-label="Salin kode">
                <span data-albedu-icon="content_copy"><svg class="albedu-icon" aria-hidden="true"><use href="#i-content_copy"/></svg></span>
              </button>
              <button class="aa-card-quick-btn ${status === 'archived' ? '' : 'aa-quick-danger'}" data-action="${status === 'archived' ? 'restore' : 'archive'}" type="button" aria-label="${status === 'archived' ? 'Restore' : 'Arsipkan'}">
                <span data-albedu-icon="folder_open"><svg class="albedu-icon" aria-hidden="true"><use href="#i-folder_open"/></svg></span>
              </button>
            </div>
          </footer>
        </article>
      `;
    },

    _rowHTML(a) {
      const status = _statusOf(a);
      const meta = STATUS_META[status];
      const qCount = _countQuestions(a.sections);
      const code = a.access_code || '—';

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
            <button class="aa-table-row-menu" type="button" aria-label="Menu aksi">
              <svg class="albedu-icon" aria-hidden="true"><use href="#i-chevron_right"/></svg>
            </button>
          </td>
        </tr>
      `;
    },

    // ── Context menu ───────────────────────────────────────────
    _showCtxMenu(anchor, item) {
      if (!this._ctxMenu) return;
      this._ctxTarget = item;

      const rect = anchor.getBoundingClientRect();
      const menuW = 240;
      const menuH = 280; // approximate
      let x = rect.right - menuW;
      let y = rect.bottom + 6;

      // Keep within viewport
      if (y + menuH > window.innerHeight) y = rect.top - menuH - 6;
      if (x < 8) x = 8;

      this._ctxMenu.style.left = x + 'px';
      this._ctxMenu.style.top  = y + 'px';
      this._ctxMenu.hidden = false;

      // Update toggle label based on current status
      if (this._ctxToggleLabel) {
        const status = _statusOf(item);
        this._ctxToggleLabel.textContent =
          status === 'running' ? 'Tutup Akses' :
          status === 'paused'  ? 'Buka Akses'  :
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
        case 'detail':
          this._openDetail(item);
          break;
        case 'copy-code':
          this._copyCode(item);
          break;
        case 'toggle-status':
          this._toggleStatus(item);
          break;
        case 'archive':
          this._archive(item);
          break;
        case 'restore':
          this._restore(item);
          break;
        case 'delete':
          this._delete(item);
          break;
      }
    },

    _openDetail(item) {
      // For now, simply notify — could route to a detail page later
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

    async _toggleStatus(item) {
      const status = _statusOf(item);
      const newStatus = status === 'running' ? 'closed' : 'open';
      const label = newStatus === 'open' ? 'dibuka' : 'ditutup';
      try {
        const sb = await _getClient();
        const { error } = await sb
          .from('assessments')
          .update({ ac_manual_status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (error) throw error;
        item.ac_manual_status = newStatus;
        window.notify?.success?.('Status diperbarui', `Akses asesmen ${label}`, 2000);
        this._updateKPIs();
        this._applyFilters();
      } catch (err) {
        console.error('[toggleStatus]', err);
        window.notify?.error?.('Gagal mengubah status', err?.message || 'Unknown error', 3000);
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

    // ── View + filter setters ──────────────────────────────────
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
      this._kpiCards?.forEach((card) => {
        card.classList.toggle('is-active', card.dataset.filter === filter);
      });
      this._applyFilters();
    },

    // ── State management ───────────────────────────────────────
    _hideAllStates() {
      if (this._loading)   this._loading.hidden = true;
      if (this._empty)     this._empty.hidden = true;
      if (this._noResults) this._noResults.hidden = true;
      if (this._error)     this._error.hidden = true;
      if (this._grid)      this._grid.hidden = true;
      if (this._tableWrap) this._tableWrap.hidden = true;
    },
  };

  window.ActiveAssessments = ActiveAssessments;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ActiveAssessments.init());
  else ActiveAssessments.init();
})();
