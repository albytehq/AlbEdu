// active-sessions.js — Enterprise-grade Active Sessions dashboard (v2)
//
// Key changes from v1:
//   - SCOPED to current admin's own assessments only (via assessments.created_by
//     filter). Previously showed ALL sessions across all admins — useless for
//     multi-tenant scenarios and cluttered with test data.
//   - Enterprise UI: KPI strip with live counts, sticky toolbar with search +
//     filter chips + sort + view toggle (table/grid), per-row context menu,
//     live timer for active sessions.
//   - Back-compat: window.ActiveSessions.init() + load() API preserved.

(function () {
  'use strict';

  const REFRESH_INTERVAL_MS = 30_000; // 30s auto-refresh
  const STALE_HEARTBEAT_MS = 90_000;  // >90s = stale

  // ═══════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════
  const state = {
    sessions: [],            // all sessions for this admin (active + paused + disconnected)
    blockedCount: 0,         // total blocked sessions for this admin (separate query)
    assessments: [],         // admin's assessments (for filter dropdown)
    filteredSessions: [],    // sessions after applying filters/search/sort
    adminUserId: null,
    adminEmail: null,
    // UI state
    autoRefresh: false,
    autoRefreshTimer: null,
    lastRefreshAt: null,
    searchQuery: '',
    statusFilter: 'all',     // 'all' | 'active' | 'paused' | 'disconnected' | 'stale'
    assessmentFilter: 'all', // 'all' | <assessment_id>
    sortBy: 'recent',        // 'recent' | 'oldest' | 'name' | 'progress' | 'violations'
    view: 'table',           // 'table' | 'grid'
    loading: false,
    error: null,
    contextMenu: { open: false, sessionId: null, x: 0, y: 0 },
  };

  // ═══════════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
    const supabase = window.AlbEdu?.supabase;
    if (!supabase) {
      console.error('[active-sessions] Supabase not ready');
      _showFatalError('Platform tidak siap. Muat ulang halaman.');
      return;
    }
    await supabase.ready;

    // Get current admin
    try {
      const { data: { session: authSession } } = await supabase.client.auth.getSession();
      if (!authSession?.user?.id) {
        _showFatalError('Sesi login tidak ditemukan. Silakan masuk kembali.');
        return;
      }
      state.adminUserId = authSession.user.id;
      state.adminEmail = authSession.user.email;
    } catch (err) {
      _showFatalError('Gagal mengambil sesi login: ' + (err.message || 'unknown'));
      return;
    }

    _wireControls();
    await loadSessions(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Data load (scoped to admin's own assessments)
  // ═══════════════════════════════════════════════════════════════════
  async function loadSessions(initial = false) {
    const supabase = window.AlbEdu.supabase.client;
    state.loading = true;
    _renderLoadingState(initial);

    try {
      // Single query: sessions JOIN assessments, filtered by assessments.created_by.
      // The .eq('assessments.created_by', ...) is the SCOPING filter — only
      // sessions for assessments created by this admin are returned.
      const { data: sessions, error } = await supabase
        .from('assessment_sessions')
        .select(`
          id, status, started_at, last_heartbeat_at, current_section, current_question,
          progress_pct, violation_count, blocked_at, blocked_reason,
          user_id, user_email, identity_snapshot, draft_answers,
          assessments!inner(id, access_code, title, subject, duration_minutes, created_by, ac_manual_status)
        `)
        .in('status', ['active', 'paused', 'disconnected'])
        .eq('assessments.created_by', state.adminUserId)
        .order('last_heartbeat_at', { ascending: false, nullsFirst: false })
        .limit(200);

      if (error) throw error;

      // Separate count for blocked sessions (also scoped to this admin)
      const { count: blockedCount } = await supabase
        .from('assessment_sessions')
        .select('id, assessments!inner(created_by)', { count: 'exact', head: true })
        .eq('status', 'blocked')
        .eq('assessments.created_by', state.adminUserId);

      // Extract distinct assessments for filter dropdown
      const assessmentsMap = new Map();
      (sessions || []).forEach(s => {
        const a = s.assessments;
        if (a && !assessmentsMap.has(a.id)) {
          assessmentsMap.set(a.id, { id: a.id, title: a.title, access_code: a.access_code });
        }
      });

      state.sessions = sessions || [];
      state.blockedCount = blockedCount || 0;
      state.assessments = Array.from(assessmentsMap.values());
      state.lastRefreshAt = new Date();
      state.error = null;
      state.loading = false;

      _applyFiltersAndRender();
      _renderKPIs();
      _renderAssessmentFilter();
      _updateLastRefresh();
    } catch (err) {
      console.error('[active-sessions] load failed:', err);
      state.error = err;
      state.loading = false;
      _renderErrorState(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Filter + sort pipeline
  // ═══════════════════════════════════════════════════════════════════
  function _applyFiltersAndRender() {
    let out = state.sessions.slice();

    // 1. Status filter
    if (state.statusFilter === 'stale') {
      out = out.filter(s => _isStale(s));
    } else if (state.statusFilter !== 'all') {
      out = out.filter(s => s.status === state.statusFilter);
    }

    // 2. Assessment filter
    if (state.assessmentFilter !== 'all') {
      out = out.filter(s => s.assessments?.id === state.assessmentFilter);
    }

    // 3. Search query (matches peserta name, email, assessment title, access_code)
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.trim().toLowerCase();
      out = out.filter(s => {
        const name = _getPesertaName(s).toLowerCase();
        const email = (s.user_email || '').toLowerCase();
        const title = (s.assessments?.title || '').toLowerCase();
        const code = (s.assessments?.access_code || '').toLowerCase();
        return name.includes(q) || email.includes(q) || title.includes(q) || code.includes(q);
      });
    }

    // 4. Sort
    out.sort((a, b) => {
      switch (state.sortBy) {
        case 'oldest':
          return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
        case 'name':
          return _getPesertaName(a).localeCompare(_getPesertaName(b), 'id');
        case 'progress':
          return (b.progress_pct || 0) - (a.progress_pct || 0);
        case 'violations':
          return (b.violation_count || 0) - (a.violation_count || 0);
        case 'recent':
        default:
          return new Date(b.last_heartbeat_at || b.started_at).getTime() -
                 new Date(a.last_heartbeat_at || a.started_at).getTime();
      }
    });

    state.filteredSessions = out;
    _renderList();
    _renderFilterChips();
  }

  // ═══════════════════════════════════════════════════════════════════
  // KPI strip
  // ═══════════════════════════════════════════════════════════════════
  function _renderKPIs() {
    const total = state.sessions.length;
    const active = state.sessions.filter(s => s.status === 'active' && !_isStale(s)).length;
    const stale = state.sessions.filter(s => _isStale(s)).length;
    const paused = state.sessions.filter(s => s.status === 'paused').length;
    const disconnected = state.sessions.filter(s => s.status === 'disconnected').length;
    const totalViolations = state.sessions.reduce((sum, s) => sum + (s.violation_count || 0), 0);
    const avgProgress = total > 0
      ? Math.round(state.sessions.reduce((sum, s) => sum + (s.progress_pct || 0), 0) / total)
      : 0;

    _setText('kpi-total', total);
    _setText('kpi-active', active);
    _setText('kpi-stale', stale);
    _setText('kpi-paused', paused + disconnected);
    _setText('kpi-violations', totalViolations);
    _setText('kpi-blocked', state.blockedCount);
    _setText('kpi-avg-progress', avgProgress + '%');

    // Animate KPI cards on count change
    document.querySelectorAll('.as-kpi-card').forEach(card => {
      card.classList.remove('as-kpi-pulse');
      void card.offsetWidth; // force reflow
      card.classList.add('as-kpi-pulse');
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // List rendering (table view + grid view)
  // ═══════════════════════════════════════════════════════════════════
  function _renderList() {
    const listEl = document.getElementById('sessions-list');
    if (!listEl) return;

    if (state.filteredSessions.length === 0) {
      if (state.sessions.length === 0) {
        listEl.innerHTML = _renderEmptyState('no-sessions');
      } else {
        listEl.innerHTML = _renderEmptyState('no-results');
      }
      return;
    }

    if (state.view === 'table') {
      listEl.innerHTML = _renderTableView(state.filteredSessions);
    } else {
      listEl.innerHTML = _renderGridView(state.filteredSessions);
    }

    // Wire row actions (block button + context menu trigger)
    listEl.querySelectorAll('[data-action="block"]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const sessionId = btn.closest('[data-session-id]')?.dataset.sessionId;
        if (sessionId) _handleBlock(sessionId);
      });
    });
    listEl.querySelectorAll('[data-action="menu"]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const row = btn.closest('[data-session-id]');
        const sessionId = row?.dataset.sessionId;
        const rect = btn.getBoundingClientRect();
        if (sessionId) _openContextMenu(sessionId, rect.left, rect.bottom + 4);
      });
    });
  }

  function _renderTableView(sessions) {
    const rows = sessions.map(s => _renderTableRow(s)).join('');
    return `
      <div class="as-table-wrap">
        <table class="as-table">
          <thead>
            <tr>
              <th class="as-col-status">Status</th>
              <th class="as-col-peserta">Peserta</th>
              <th class="as-col-assessment">Asesmen</th>
              <th class="as-col-progress">Progress</th>
              <th class="as-col-position">Posisi</th>
              <th class="as-col-violations">Pelanggaran</th>
              <th class="as-col-heartbeat">Heartbeat</th>
              <th class="as-col-actions" aria-label="Aksi"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _renderTableRow(s) {
    const assessment = s.assessments || {};
    const pesertaName = _getPesertaName(s);
    const pesertaSub = _getPesertaSub(s);
    const lastHb = s.last_heartbeat_at ? _timeAgo(s.last_heartbeat_at) : '—';
    const progress = Number(s.progress_pct || 0);
    const violations = s.violation_count || 0;
    const isStale = _isStale(s);
    const statusBadge = _renderStatusBadge(s.status, isStale);
    const progressClass = progress >= 75 ? 'as-progress-high' : progress >= 40 ? 'as-progress-mid' : 'as-progress-low';
    const violationClass = violations >= 3 ? 'as-badge-danger' : violations >= 1 ? 'as-badge-warn' : 'as-badge-ok';

    return `
      <tr class="as-row${isStale ? ' as-row-stale' : ''}" data-session-id="${escapeAttr(s.id)}">
        <td class="as-col-status">${statusBadge}</td>
        <td class="as-col-peserta">
          <div class="as-peserta-cell">
            <div class="as-peserta-avatar" aria-hidden="true">${_initials(pesertaName)}</div>
            <div class="as-peserta-info">
              <div class="as-peserta-name">${escapeHtml(pesertaName)}</div>
              ${pesertaSub ? `<div class="as-peserta-sub">${escapeHtml(pesertaSub)}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="as-col-assessment">
          <div class="as-assessment-cell">
            <div class="as-assessment-title">${escapeHtml(assessment.title || '—')}</div>
            <div class="as-assessment-code">${escapeHtml(assessment.subject || '')} · ${escapeHtml(assessment.access_code || '—')}</div>
          </div>
        </td>
        <td class="as-col-progress">
          <div class="as-progress-wrap">
            <div class="as-progress-bar">
              <div class="as-progress-fill ${progressClass}" style="width: ${progress}%"></div>
            </div>
            <span class="as-progress-text">${progress}%</span>
          </div>
        </td>
        <td class="as-col-position"><span class="as-position-pill">S${(s.current_section || 0) + 1} · Q${(s.current_question || 0) + 1}</span></td>
        <td class="as-col-violations"><span class="as-badge ${violationClass}">${violations}</span></td>
        <td class="as-col-heartbeat"><span class="as-heartbeat${isStale ? ' as-heartbeat-stale' : ''}" title="${escapeAttr(s.last_heartbeat_at || '')}">${lastHb}</span></td>
        <td class="as-col-actions">
          <div class="as-row-actions">
            <button class="as-icon-btn" data-action="menu" aria-label="Menu aksi" type="button">
              <span data-albedu-icon="more_vert"></span>
            </button>
          </div>
        </td>
      </tr>`;
  }

  function _renderGridView(sessions) {
    return `<div class="as-grid">${sessions.map(s => _renderGridCard(s)).join('')}</div>`;
  }

  function _renderGridCard(s) {
    const assessment = s.assessments || {};
    const pesertaName = _getPesertaName(s);
    const pesertaSub = _getPesertaSub(s);
    const lastHb = s.last_heartbeat_at ? _timeAgo(s.last_heartbeat_at) : '—';
    const progress = Number(s.progress_pct || 0);
    const violations = s.violation_count || 0;
    const isStale = _isStale(s);
    const statusBadge = _renderStatusBadge(s.status, isStale);
    const progressClass = progress >= 75 ? 'as-progress-high' : progress >= 40 ? 'as-progress-mid' : 'as-progress-low';
    const violationClass = violations >= 3 ? 'as-badge-danger' : violations >= 1 ? 'as-badge-warn' : 'as-badge-ok';

    return `
      <div class="as-card${isStale ? ' as-card-stale' : ''}" data-session-id="${escapeAttr(s.id)}">
        <div class="as-card-header">
          <div class="as-card-peserta">
            <div class="as-peserta-avatar as-peserta-avatar-lg" aria-hidden="true">${_initials(pesertaName)}</div>
            <div>
              <div class="as-card-name">${escapeHtml(pesertaName)}</div>
              ${pesertaSub ? `<div class="as-card-sub">${escapeHtml(pesertaSub)}</div>` : ''}
            </div>
          </div>
          <button class="as-icon-btn" data-action="menu" aria-label="Menu aksi" type="button">
            <span data-albedu-icon="more_vert"></span>
          </button>
        </div>
        <div class="as-card-meta">
          ${statusBadge}
          <span class="as-card-assessment">${escapeHtml(assessment.title || '—')}</span>
        </div>
        <div class="as-card-progress">
          <div class="as-progress-bar">
            <div class="as-progress-fill ${progressClass}" style="width: ${progress}%"></div>
          </div>
          <span class="as-progress-text">${progress}%</span>
        </div>
        <div class="as-card-stats">
          <div class="as-card-stat">
            <span class="as-card-stat-label">Posisi</span>
            <span class="as-card-stat-value">S${(s.current_section || 0) + 1} · Q${(s.current_question || 0) + 1}</span>
          </div>
          <div class="as-card-stat">
            <span class="as-card-stat-label">Pelanggaran</span>
            <span class="as-card-stat-value"><span class="as-badge ${violationClass}">${violations}</span></span>
          </div>
          <div class="as-card-stat">
            <span class="as-card-stat-label">Heartbeat</span>
            <span class="as-card-stat-value${isStale ? ' as-text-warn' : ''}">${lastHb}</span>
          </div>
        </div>
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers — peserta name, initials, status badges, time
  // ═══════════════════════════════════════════════════════════════════
  function _getPesertaName(s) {
    if (!s) return 'Unknown';
    const snap = s.identity_snapshot;
    if (snap) {
      if (snap._display_name) return snap._display_name;
      if (snap.nama) return snap.nama;
      if (snap.field_nama) return snap.field_nama;
    }
    if (s.user_email) return s.user_email.split('@')[0];
    return 'Unknown';
  }

  function _getPesertaSub(s) {
    if (!s) return '';
    const snap = s.identity_snapshot;
    if (snap) {
      const parts = [];
      if (snap.field_kelas || snap.kelas || snap.tab_nama) {
        parts.push(snap.field_kelas || snap.kelas || snap.tab_nama);
      }
      if (snap.field_nis) parts.push('NIS ' + snap.field_nis);
      if (parts.length) return parts.join(' · ');
    }
    return s.user_email || '';
  }

  function _initials(name) {
    if (!name || name === 'Unknown') return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map(p => p.charAt(0).toUpperCase()).join('') || '?';
  }

  function _renderStatusBadge(status, isStale) {
    if (status === 'active' && isStale) {
      return '<span class="as-badge as-badge-warn"><span class="as-dot as-dot-warn"></span>Stale</span>';
    }
    if (status === 'active') return '<span class="as-badge as-badge-success"><span class="as-dot as-dot-success"></span>Aktif</span>';
    if (status === 'paused') return '<span class="as-badge as-badge-warn"><span class="as-dot as-dot-warn"></span>Jeda</span>';
    if (status === 'disconnected') return '<span class="as-badge as-badge-danger"><span class="as-dot as-dot-danger"></span>Terputus</span>';
    return `<span class="as-badge">${escapeHtml(status)}</span>`;
  }

  function _isStale(s) {
    if (!s.last_heartbeat_at) return s.status !== 'active' ? false : true;
    const age = Date.now() - new Date(s.last_heartbeat_at).getTime();
    return age > STALE_HEARTBEAT_MS;
  }

  function _timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}d lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m lalu`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}j lalu`;
    const day = Math.floor(hr / 24);
    return `${day}h lalu`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Filter chips, assessment dropdown, toolbar
  // ═══════════════════════════════════════════════════════════════════
  function _renderFilterChips() {
    const wrap = document.getElementById('filter-chips');
    if (!wrap) return;
    const counts = {
      all: state.sessions.length,
      active: state.sessions.filter(s => s.status === 'active' && !_isStale(s)).length,
      stale: state.sessions.filter(s => _isStale(s)).length,
      paused: state.sessions.filter(s => s.status === 'paused').length,
      disconnected: state.sessions.filter(s => s.status === 'disconnected').length,
    };
    const chips = [
      { id: 'all', label: 'Semua', count: counts.all, icon: 'list' },
      { id: 'active', label: 'Aktif', count: counts.active, icon: 'play_circle' },
      { id: 'stale', label: 'Stale', count: counts.stale, icon: 'warning' },
      { id: 'paused', label: 'Jeda', count: counts.paused, icon: 'pause_circle' },
      { id: 'disconnected', label: 'Terputus', count: counts.disconnected, icon: 'cloud_off' },
    ];
    wrap.innerHTML = chips.map(c => `
      <button class="as-chip${state.statusFilter === c.id ? ' as-chip-active' : ''}" data-filter="${c.id}" type="button">
        <span data-albedu-icon="${c.icon}"></span>
        <span>${escapeHtml(c.label)}</span>
        <span class="as-chip-count">${c.count}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('.as-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.statusFilter = chip.dataset.filter;
        _applyFiltersAndRender();
      });
    });
  }

  function _renderAssessmentFilter() {
    const sel = document.getElementById('filter-assessment');
    if (!sel) return;
    const opts = ['<option value="all">Semua Asesmen</option>']
      .concat(state.assessments.map(a =>
        `<option value="${escapeAttr(a.id)}"${state.assessmentFilter === a.id ? ' selected' : ''}>${escapeHtml(a.title)} · ${escapeHtml(a.access_code)}</option>`
      ))
      .join('');
    sel.innerHTML = opts;
  }

  // ═══════════════════════════════════════════════════════════════════
  // State rendering — loading, empty, error
  // ═══════════════════════════════════════════════════════════════════
  function _renderLoadingState(initial) {
    if (initial) {
      const listEl = document.getElementById('sessions-list');
      if (listEl) {
        listEl.innerHTML = `
          <div class="as-skeleton-wrap">
            ${Array.from({length: 6}, () => `
              <div class="as-skeleton-row">
                <div class="as-skeleton as-sk-status"></div>
                <div class="as-skeleton as-sk-peserta"></div>
                <div class="as-skeleton as-sk-assessment"></div>
                <div class="as-skeleton as-sk-progress"></div>
                <div class="as-skeleton as-sk-position"></div>
                <div class="as-skeleton as-sk-violations"></div>
                <div class="as-skeleton as-sk-heartbeat"></div>
                <div class="as-skeleton as-sk-actions"></div>
              </div>
            `).join('')}
          </div>`;
      }
    }
  }

  function _renderEmptyState(kind) {
    if (kind === 'no-sessions') {
      return `
        <div class="as-empty">
          <div class="as-empty-icon"><span data-albedu-icon="groups"></span></div>
          <h3 class="as-empty-title">Tidak Ada Peserta Aktif</h3>
          <p class="as-empty-msg">Belum ada peserta yang sedang mengerjakan asesmen Anda saat ini.</p>
          <p class="as-empty-sub">Peserta yang memulai asesmen akan muncul di sini secara real-time (auto-refresh 30s).</p>
          <button class="as-btn as-btn-primary" type="button" onclick="window.ActiveSessions.load()">
            <span data-albedu-icon="refresh"></span>
            <span>Refresh Sekarang</span>
          </button>
        </div>`;
    }
    return `
      <div class="as-empty">
        <div class="as-empty-icon"><span data-albedu-icon="search_off"></span></div>
        <h3 class="as-empty-title">Tidak Ada Hasil</h3>
        <p class="as-empty-msg">Tidak ada sesi yang cocok dengan filter atau pencarian Anda.</p>
        <button class="as-btn as-btn-secondary" type="button" id="as-clear-filters">
          <span data-albedu-icon="filter_alt_off"></span>
          <span>Reset Filter</span>
        </button>
      </div>`;
  }

  function _renderErrorState(err) {
    const listEl = document.getElementById('sessions-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="as-empty as-empty-error">
          <div class="as-empty-icon as-empty-icon-error"><span data-albedu-icon="error"></span></div>
          <h3 class="as-empty-title">Gagal Memuat Sesi</h3>
          <p class="as-empty-msg">${escapeHtml(err.message || 'Unknown error')}</p>
          <button class="as-btn as-btn-primary" type="button" onclick="window.ActiveSessions.load()">
            <span data-albedu-icon="refresh"></span>
            <span>Coba Lagi</span>
          </button>
        </div>`;
    }
  }

  function _showFatalError(msg) {
    const listEl = document.getElementById('sessions-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="as-empty as-empty-error">
          <div class="as-empty-icon as-empty-icon-error"><span data-albedu-icon="error"></span></div>
          <h3 class="as-empty-title">Error</h3>
          <p class="as-empty-msg">${escapeHtml(msg)}</p>
        </div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Context menu
  // ═══════════════════════════════════════════════════════════════════
  let _ctxMenuEl = null;

  function _openContextMenu(sessionId, x, y) {
    _closeContextMenu();
    const s = state.sessions.find(x => x.id === sessionId);
    if (!s) return;
    const assessment = s.assessments || {};
    const isStale = _isStale(s);

    _ctxMenuEl = document.createElement('div');
    _ctxMenuEl.className = 'as-ctx-menu';
    _ctxMenuEl.style.position = 'fixed';
    _ctxMenuEl.style.left = Math.min(x, window.innerWidth - 240) + 'px';
    _ctxMenuEl.style.top = Math.min(y, window.innerHeight - 240) + 'px';
    _ctxMenuEl.innerHTML = `
      <div class="as-ctx-header">
        <div class="as-ctx-title">${escapeHtml(_getPesertaName(s))}</div>
        <div class="as-ctx-sub">${escapeHtml(assessment.title || '')}</div>
      </div>
      <button class="as-ctx-item" data-ctx="detail" type="button">
        <span data-albedu-icon="info"></span>
        <span>Lihat Detail</span>
      </button>
      <button class="as-ctx-item" data-ctx="copy-code" type="button">
        <span data-albedu-icon="content_copy"></span>
        <span>Salin Kode Asesmen</span>
      </button>
      ${s.user_email ? `
        <button class="as-ctx-item" data-ctx="copy-email" type="button">
          <span data-albedu-icon="mail"></span>
          <span>Salin Email Peserta</span>
        </button>` : ''}
      <div class="as-ctx-divider"></div>
      <button class="as-ctx-item as-ctx-danger" data-ctx="block" type="button">
        <span data-albedu-icon="block"></span>
        <span>Blokir Peserta</span>
      </button>
    `;
    document.body.appendChild(_ctxMenuEl);
    window.AlbEdu?.bindIcons?.(_ctxMenuEl);

    _ctxMenuEl.querySelectorAll('.as-ctx-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.ctx;
        _closeContextMenu();
        if (action === 'detail') _showDetailModal(s);
        else if (action === 'copy-code') _copyToClipboard(assessment.access_code || '');
        else if (action === 'copy-email') _copyToClipboard(s.user_email || '');
        else if (action === 'block') _handleBlock(sessionId);
      });
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _closeContextMenu, { once: true });
    }, 0);
  }

  function _closeContextMenu() {
    if (_ctxMenuEl) {
      _ctxMenuEl.remove();
      _ctxMenuEl = null;
    }
  }

  function _showDetailModal(s) {
    // Simple modal — could be enhanced later
    const assessment = s.assessments || {};
    const detail = [
      ['Peserta', _getPesertaName(s)],
      ['Email', s.user_email || '—'],
      ['Kelas', _getPesertaSub(s) || '—'],
      ['Asesmen', assessment.title || '—'],
      ['Kode', assessment.access_code || '—'],
      ['Status', s.status],
      ['Progress', (s.progress_pct || 0) + '%'],
      ['Posisi', `S${(s.current_section || 0) + 1} Q${(s.current_question || 0) + 1}`],
      ['Pelanggaran', String(s.violation_count || 0)],
      ['Mulai', s.started_at ? new Date(s.started_at).toLocaleString('id-ID') : '—'],
      ['Heartbeat', s.last_heartbeat_at ? new Date(s.last_heartbeat_at).toLocaleString('id-ID') : '—'],
      ['Sesi ID', s.id],
    ];
    const rows = detail.map(([k, v]) => `
      <tr><td class="as-modal-key">${escapeHtml(k)}</td><td class="as-modal-val">${escapeHtml(String(v))}</td></tr>
    `).join('');
    if (window.notify?.dialog) {
      window.notify.dialog({
        title: 'Detail Sesi Peserta',
        message: `<table class="as-modal-table">${rows}</table>`,
        intent: 'info',
        confirmText: 'Tutup',
        onYes: () => {},
      });
    } else {
      alert(rows);
    }
  }

  function _copyToClipboard(text) {
    if (!text) return;
    try {
      navigator.clipboard?.writeText(text);
      window.notify?.success?.('Disalin', `"${text}" disalin ke clipboard.`, 2000);
    } catch (_) {
      window.notify?.warning?.('Gagal Menyalin', 'Clipboard tidak tersedia.', 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Block handler
  // ═══════════════════════════════════════════════════════════════════
  async function _handleBlock(sessionId) {
    const s = state.sessions.find(x => x.id === sessionId);
    if (!s) return;
    const pesertaName = _getPesertaName(s);

    const reason = prompt(`Alasan pemblokiran untuk ${pesertaName}?\n(kosongkan untuk default)`) || 'Blocked by admin';
    if (reason.length > 500) {
      window.notify?.error?.('Terlalu Panjang', 'Alasan maksimal 500 karakter.', 3000);
      return;
    }

    if (!confirm(`Yakin blokir ${pesertaName}?\n\nPeserta akan diarahkan ke halaman blocked.html dalam ≤15 detik.`)) {
      return;
    }

    try {
      const supabase = window.AlbEdu.supabase.client;
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession?.access_token) throw new Error('Not authenticated');

      const res = await fetch(`${supabase.supabaseUrl}/functions/v1/block-participant`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authSession.access_token}`,
          'apikey': supabase.supabaseKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ session_id: sessionId, reason }),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || `HTTP ${res.status}`);

      // Remove from local state + re-render
      state.sessions = state.sessions.filter(x => x.id !== sessionId);
      state.blockedCount += 1;
      _applyFiltersAndRender();
      _renderKPIs();

      window.notify?.success?.(
        'Peserta Diblokir',
        `${pesertaName} akan diarahkan ke halaman blocked.html dalam ≤15 detik.`,
        5000
      );
    } catch (err) {
      console.error('[active-sessions] block failed:', err);
      window.notify?.error?.('Gagal Memblokir', err.message, 5000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Auto-refresh
  // ═══════════════════════════════════════════════════════════════════
  function _toggleAutoRefresh() {
    state.autoRefresh = !state.autoRefresh;
    const btn = document.getElementById('btn-auto-refresh');
    const indicator = document.getElementById('auto-refresh-indicator');

    if (state.autoRefresh) {
      btn?.classList.add('as-btn-active');
      btn?.setAttribute('aria-pressed', 'true');
      if (indicator) indicator.textContent = 'Auto-refresh 30s (aktif)';
      state.autoRefreshTimer = setInterval(() => loadSessions(false), REFRESH_INTERVAL_MS);
    } else {
      btn?.classList.remove('as-btn-active');
      btn?.setAttribute('aria-pressed', 'false');
      if (indicator) indicator.textContent = 'Auto-refresh 30s';
      if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }

  function _updateLastRefresh() {
    const el = document.getElementById('last-refresh');
    if (el && state.lastRefreshAt) {
      el.textContent = `Terakhir refresh: ${state.lastRefreshAt.toLocaleTimeString('id-ID')}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Wire up toolbar controls
  // ═══════════════════════════════════════════════════════════════════
  function _wireControls() {
    document.getElementById('btn-refresh')?.addEventListener('click', () => loadSessions(true));
    document.getElementById('btn-auto-refresh')?.addEventListener('click', _toggleAutoRefresh);

    // Search input
    const searchInput = document.getElementById('as-search');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', e => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          state.searchQuery = e.target.value;
          _applyFiltersAndRender();
        }, 200);
      });
      // Clear button
      const clearBtn = document.getElementById('as-search-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          searchInput.value = '';
          state.searchQuery = '';
          _applyFiltersAndRender();
        });
      }
    }

    // Assessment filter
    document.getElementById('filter-assessment')?.addEventListener('change', e => {
      state.assessmentFilter = e.target.value;
      _applyFiltersAndRender();
    });

    // Sort dropdown
    document.getElementById('filter-sort')?.addEventListener('change', e => {
      state.sortBy = e.target.value;
      _applyFiltersAndRender();
    });

    // View toggle (table/grid)
    document.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.view = btn.dataset.view;
        document.querySelectorAll('[data-view]').forEach(b => {
          b.classList.toggle('as-view-btn-active', b.dataset.view === state.view);
          b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
        });
        _renderList();
      });
    });

    // Reset filters (delegated)
    document.addEventListener('click', e => {
      if (e.target.closest('#as-clear-filters')) {
        state.searchQuery = '';
        state.statusFilter = 'all';
        state.assessmentFilter = 'all';
        state.sortBy = 'recent';
        const si = document.getElementById('as-search');
        if (si) si.value = '';
        const af = document.getElementById('filter-assessment');
        if (af) af.value = 'all';
        const sf = document.getElementById('filter-sort');
        if (sf) sf.value = 'recent';
        _applyFiltersAndRender();
      }
    });

    // Live-update heartbeat times every 30s (even without auto-refresh)
    setInterval(() => {
      if (state.filteredSessions.length > 0 && !state.loading) {
        _renderList();
      }
    }, 30_000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOM helpers
  // ═══════════════════════════════════════════════════════════════════
  function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Public API (back-compat)
  // ═══════════════════════════════════════════════════════════════════
  window.ActiveSessions = {
    load: (showToast) => loadSessions(showToast || false),
    init: () => loadSessions(true),
    getState: () => ({ ...state }),
  };
})();
