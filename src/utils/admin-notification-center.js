// admin-notification-center.js — real-time violation signal hub. Subscribes
// to the violations table and pushes live alerts to any admin page that
// loads this script. Source of truth is the DB snapshot — dismissed rows
// are deleted from the DB, not from localStorage, so there are no ghost
// notifications after navigation.

(function (global) {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const MAX_NOTIFS    = 150;
  const PANEL_ID      = 'anc-panel';
  const OVERLAY_ID    = 'anc-overlay';

  let _db             = null;
  let _unsubscribe    = null;
  let _panelEl        = null;
  let _overlayEl      = null;
  let _activeTab      = 'all';
  let _isInitialized  = false;
  let _isPanelOpen    = false;
  let _isClearingAll  = false;

  // Source of truth: populated from the realtime subscription only (not localStorage).
  // { id, docId, type, userName, examTitle, message, warningNum, maxWarnings, ts, read }
  let _notifications  = [];

  // docId → { eventCount, status } — track perubahan per doc
  const _docState = new Map();

  function _getUnreadCount() {
    return _notifications.filter(n => !n.read).length;
  }

  // Suppress pulse on initial load / page navigate. The first snapshot fires
  // with all existing notifications (not new ones) — no bell shake on every
  // page navigation. After the first snapshot, _isInitialSnapshot flips false
  // so pulse only fires for real-time NEW violations.
  let _isInitialSnapshot = true;

  function _updateBadge(opts) {
    // opts.pulse (default true) — false to suppress animation
    // (for example, on init, dismiss, markAllRead, page load)
    var pulse = !opts || opts.pulse !== false;
    var count = _getUnreadCount();
    document.querySelectorAll('.notification-btn .badge, #anc-bell-badge').forEach(badge => {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = count > 0 ? 'flex' : 'none';
      if (count > 0 && pulse) {
        badge.classList.add('anc-badge-pulse');
        setTimeout(() => badge.classList.remove('anc-badge-pulse'), 300);
      }
    });
    if (count > 0 && pulse) {
      document.querySelectorAll('.notification-btn').forEach(btn => {
        btn.classList.add('anc-bell-pulse');
        setTimeout(() => btn.classList.remove('anc-bell-pulse'), 360);
      });
    }
  }

  function _makeId(docId, suffix) {
    return `${docId}__${suffix}`;
  }

  function _relativeTime(isoOrDate) {
    try {
      const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
      if (isNaN(date.getTime())) return t('notif.time_just_now', null, 'baru saja');
      const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
      if (diffSec < 60)    return t('notif.time_just_now', null, 'baru saja');
      if (diffSec < 3600)  return t('notif.time_minutes_ago', { n: Math.floor(diffSec / 60) }, `${Math.floor(diffSec / 60)} menit lalu`);
      if (diffSec < 86400) return t('notif.time_hours_ago', { n: Math.floor(diffSec / 3600) }, `${Math.floor(diffSec / 3600)} jam lalu`);
      return t('notif.time_days_ago', { n: Math.floor(diffSec / 86400) }, `${Math.floor(diffSec / 86400)} hari lalu`);
    } catch (_) { return t('notif.time_just_now', null, 'baru saja'); }
  }

  function _sanitize(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Each row in `violation_events` is a SINGLE event (not an embedded array).
  // One row → one notification. Field map:
  //   event_type  → type (mapped: keyboard_violation → 'violation')
  //   severity    → bumps type to 'max_violation' when severity === 'critical'
  //   message     → message
  //   user_name   → userName
  //   exam_title  → examTitle
  //   warning_num → warningNum
  //   created_at  → ts (ISO string)
  function _handleSnapshot(snapshot) {
    let changed = false;

    snapshot.docChanges().forEach(change => {
      const docSnap = change.doc;
      const data    = docSnap.data() || {};
      const docId   = docSnap.id;

      // Doc dihapus (dari dismiss/clear all) → buang notif dari doc ini
      if (change.type === 'removed') {
        const before = _notifications.length;
        _notifications = _notifications.filter(n => n.docId !== docId);
        _docState.delete(docId);
        if (_notifications.length !== before) changed = true;
        return;
      }

      // Skip if we already have a notification for this doc id
      // (modification events just re-flatten the same data).
      const notifId = _makeId(docId, 'evt_0');
      if (_notifications.some(n => n.id === notifId)) {
        _docState.set(docId, { eventCount: 1, status: null });
        return;
      }

      const userName   = data.user_name   || data.user_id   || t('notif.default_user', null, 'Peserta');
      const examTitle  = data.exam_title  || data.access_code || t('notif.default_exam', null, 'Asesmen');
      const severity   = data.severity    || 'warning';
      // data.event_type (for example 'keyboard_violation', 'tab_switch') is
      // available for future per-type rendering; currently all events render as 'violation'.
      const ts         = (data.created_at instanceof Date)
        ? data.created_at.toISOString()
        : (typeof data.created_at === 'string' ? data.created_at : new Date().toISOString());

      // severity=critical → render as max_violation (red chip + dangerous icon)
      // otherwise → plain violation warning chip
      const type = severity === 'critical' ? 'max_violation' : 'violation';

      _notifications.push({
        id:          notifId,
        docId,
        type,
        userName,
        examTitle,
        message:     data.message || t('notif.violation_detected', null, 'Pelanggaran terdeteksi'),
        warningNum:  data.warning_num || null,
        maxWarnings: 4,
        ts,
        read:        false,
      });
      _docState.set(docId, { eventCount: 1, status: null });
      changed = true;
    });

    // Cap
    if (_notifications.length > MAX_NOTIFS) {
      _notifications = _notifications.slice(-MAX_NOTIFS);
    }

    if (changed) {
      // Suppress pulse on the initial snapshot (page load). After the first
      // snapshot, _isInitialSnapshot flips false so pulse only fires for
      // real-time NEW violations.
      _updateBadge({ pulse: !_isInitialSnapshot });
      _updateFooterTimestamp();
      if (_isPanelOpen) _renderPanelContent();
    }
    _isInitialSnapshot = false;
  }

  function _updateFooterTimestamp() {
    const el = document.getElementById('anc-footer-note');
    if (!el) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `Diperbarui ${hh}:${mm}:${ss}`;
  }

  // Subscribe to `violation_events`. Each row is one event; ordered by
  // created_at desc.
  function _subscribeToViolations() {
    if (!window.AlbEdu?.repository) return;
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    try {
      const repo = window.AlbEdu.repository;
      const channelName = 'admin-notification-center:violation_events';
      // Filter by assessments this admin owns so we don't refetch 300 rows
      // on every violation INSERT across ALL assessments (thundering herd).
      // Falls back to unfiltered subscribe if the admin's assessment list
      // can't be resolved (e.g. still loading).
      let filter = undefined;
      try {
        const owned = JSON.parse(sessionStorage.getItem('albedu_admin_owned_assessments') || '[]');
        if (Array.isArray(owned) && owned.length > 0) {
          filter = `assessment_id=in.(${owned.slice(0, 50).join(',')})`;
        }
      } catch (_) { /* ignore */ }

      let refetchTimer = null;
      const debouncedRefetch = async () => {
        // Debounce rapid-fire realtime events so 5 violations in 2s
        // produce 1 refetch, not 5.
        if (refetchTimer) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(async () => {
          refetchTimer = null;
          try {
            const snap = await repo.getDocs('violation_events', {
              order: { column: 'created_at', ascending: false },
              limit: 300,
            });
            _handleSnapshot(snap);
          } catch (err) {
            const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            if (isDev) console.warn('[ANC] violation_events refetch error:', err?.message || err);
          }
        }, 200);
      };

      _unsubscribe = repo.subscribe(
        channelName,
        'violation_events',
        debouncedRefetch,
        filter
      );
    } catch (err) {
      const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (isDev) console.warn('[ANC] _subscribeToViolations setup error:', err?.message || err);
    }
  }

  // Delete the row → the realtime 'removed' event cleans state.
  async function _dismissOne(notifId) {
    const notif = _notifications.find(n => n.id === notifId);
    if (!notif || !window.AlbEdu?.repository) return;

    // Exit animation first
    const el = _panelEl && _panelEl.querySelector(`[data-notif-id="${CSS.escape(notifId)}"]`);
    if (el) {
      el.classList.add('anc-item-removing');
      await new Promise(r => setTimeout(r, 230));
    }

    // Drop from local state (keeps UI responsive)
    _notifications = _notifications.filter(n => n.id !== notifId);
    // No pulse on dismiss — user initiated.
    _updateBadge({ pulse: false });
    if (_isPanelOpen) _renderPanelContent();

    try {
      await window.AlbEdu?.repository?.deleteDoc('violation_events', notif.docId);
    } catch (err) {
      console.warn('[ANC] deleteDoc gagal:', err);
    }
  }

  // Batch-delete every row → realtime 'removed' events empty the state.
  async function _clearAll() {
    if (_isClearingAll || _notifications.length === 0) return;
    _isClearingAll = true;

    const btn = _panelEl && _panelEl.querySelector('#anc-clear-all-btn');
    if (btn) btn.disabled = true;

    // Staggered exit animation
    const items = _panelEl ? Array.from(_panelEl.querySelectorAll('.anc-notif-item')) : [];
    items.forEach((el, i) => setTimeout(() => el.classList.add('anc-item-removing'), i * 35));

    const docIds = [...new Set(_notifications.map(n => n.docId).filter(Boolean))];

    await new Promise(r => setTimeout(r, items.length * 35 + 260));

    _notifications = [];
    _docState.clear();
    _updateBadge({ pulse: false });
    if (_isPanelOpen) _renderPanelContent();

    // Bulk delete in chunks of 500 (Supabase batch limit).
    if (docIds.length > 0) {
      try {
        for (let i = 0; i < docIds.length; i += 500) {
          const chunk = docIds.slice(i, i + 500);
          await window.AlbEdu?.repository?.bulkDelete('violation_events', chunk);
        }
      } catch (err) {
        console.warn('[ANC] batch delete gagal:', err);
      }
    }

    _isClearingAll = false;
  }

  function _createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    _overlayEl = document.createElement('div');
    _overlayEl.id = OVERLAY_ID;
    _overlayEl.className = 'anc-overlay';
    _overlayEl.setAttribute('aria-hidden', 'true');
    _overlayEl.addEventListener('click', closePanel);

    _panelEl = document.createElement('div');
    _panelEl.id = PANEL_ID;
    _panelEl.className = 'anc-panel';
    _panelEl.setAttribute('role', 'dialog');
    _panelEl.setAttribute('aria-label', t('notif.panel_aria', null, 'Panel Notifikasi'));
    _panelEl.setAttribute('aria-modal', 'true');

    _panelEl.innerHTML = `
      <div class="anc-panel-header">
        <div class="anc-panel-header-row1">
          <div class="anc-panel-title">
            <span class="anc-panel-icon"><span aria-hidden="true" data-albedu-icon="notifications"></span></span>
            <div class="anc-panel-title-text">
              <h2 class="anc-panel-heading">${t('notif.panel_title', null, 'Notifikasi')}</h2>
              <p class="anc-panel-sub" id="anc-sub-text">${t('common.loading', null, 'Memuat...')}</p>
            </div>
          </div>
          <button class="anc-close-btn" id="anc-close-btn" aria-label="${t('notif.close_aria', null, 'Tutup panel notifikasi')}">
            <span aria-hidden="true" data-albedu-icon="close"></span>
          </button>
        </div>
        <div class="anc-panel-header-row2">
          <button class="anc-mark-read-btn" id="anc-mark-all-btn" aria-label="${t('notif.mark_all_read_aria', null, 'Tandai semua dibaca')}">
            <span aria-hidden="true" data-albedu-icon="done_all"></span>
            <span>${t('notif.mark_all_read', null, 'Baca Semua')}</span>
          </button>
          <button class="anc-clear-all-btn" id="anc-clear-all-btn" aria-label="${t('notif.clear_all_aria', null, 'Hapus semua notifikasi')}" disabled>
            <span aria-hidden="true" data-albedu-icon="delete"></span>
            <span>${t('notif.clear_all', null, 'Hapus Semua')}</span>
          </button>
        </div>
      </div>
      <div class="anc-tabs" role="tablist">
        <button class="anc-tab active" data-tab="all" role="tab" aria-selected="true">
          <span aria-hidden="true" data-albedu-icon="inbox"></span> ${t('notif.tab_all', null, 'Semua')}
          <span class="anc-tab-count" id="anc-tab-count-all">0</span>
        </button>
        <button class="anc-tab" data-tab="violation" role="tab" aria-selected="false">
          <span aria-hidden="true" data-albedu-icon="warning"></span> ${t('notif.tab_violation', null, 'Kecurangan')}
          <span class="anc-tab-count anc-tab-count-red" id="anc-tab-count-violation">0</span>
        </button>
        <button class="anc-tab" data-tab="submitted" role="tab" aria-selected="false">
          <span aria-hidden="true" data-albedu-icon="check_circle"></span> ${t('notif.tab_submitted', null, 'Selesai')}
          <span class="anc-tab-count anc-tab-count-green" id="anc-tab-count-submitted">0</span>
        </button>
      </div>
      <div class="anc-panel-body" id="anc-panel-body" role="log" aria-live="polite"></div>
      <div class="anc-panel-footer">
        <span class="anc-footer-status">
          <span class="anc-footer-status-dot" aria-hidden="true"></span>
          ${t('notif.connected', null, 'Terhubung')}
        </span>
        <span class="anc-footer-note" id="anc-footer-note">${t('notif.auto_update', null, 'Data diperbarui otomatis')}</span>
      </div>
    `;

    document.body.appendChild(_overlayEl);
    document.body.appendChild(_panelEl);

    _panelEl.querySelectorAll('.anc-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.tab;
        _panelEl.querySelectorAll('.anc-tab').forEach(t => {
          t.classList.toggle('active', t.dataset.tab === _activeTab);
          t.setAttribute('aria-selected', t.dataset.tab === _activeTab ? 'true' : 'false');
        });
        _renderPanelContent();
      });
    });

    document.getElementById('anc-close-btn').addEventListener('click', closePanel);
    document.getElementById('anc-mark-all-btn').addEventListener('click', markAllRead);
    document.getElementById('anc-clear-all-btn').addEventListener('click', () => _clearAll());

    // Named keydown handler so we can remove it on pagehide.
    const _onKeydown = function (e) { if (e.key === 'Escape' && _isPanelOpen) closePanel(); };
    document.addEventListener('keydown', _onKeydown);

    // Cleanup on pagehide — remove document listener + unsubscribe realtime
    // + tear down panel DOM so bfcache restore doesn't show stale UI.
    window.addEventListener('pagehide', function () {
      document.removeEventListener('keydown', _onKeydown);
      if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
      if (_panelEl) { try { _panelEl.remove(); } catch (_) {} _panelEl = null; }
      if (_overlayEl) { try { _overlayEl.remove(); } catch (_) {} _overlayEl = null; }
      _isPanelOpen = false;
    }, { once: true });
  }

  function _getFiltered() {
    const sorted = [..._notifications].sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return new Date(b.ts) - new Date(a.ts);
    });
    if (_activeTab === 'violation') return sorted.filter(n => n.type === 'violation' || n.type === 'max_violation');
    if (_activeTab === 'submitted') return sorted.filter(n => n.type === 'submitted');
    return sorted;
  }

  function _iconFor(type) {
    if (type === 'submitted')     return '<span class="anc-icon-green" aria-hidden="true" data-albedu-icon="check_circle"></span>';
    if (type === 'max_violation') return '<span class="anc-icon-red" aria-hidden="true" data-albedu-icon="dangerous"></span>';
    return '<span class="anc-icon-orange" aria-hidden="true" data-albedu-icon="warning"></span>';
  }

  function _chipFor(type, warningNum, maxWarnings) {
    if (type === 'submitted')     return '<span class="anc-chip anc-chip-green">' + t('notif.chip_submitted', null, 'Selesai') + '</span>';
    if (type === 'max_violation') return '<span class="anc-chip anc-chip-red">' + t('notif.chip_max_violation', null, 'Batas Pelanggaran!') + '</span>';
    return `<span class="anc-chip anc-chip-orange">${t('notif.chip_warning', { num: warningNum || '?', max: maxWarnings || 4 }, 'Peringatan ' + (warningNum || '?') + '/' + (maxWarnings || 4))}</span>`;
  }

  function _renderPanelContent() {
    const body     = document.getElementById('anc-panel-body');
    const subText  = document.getElementById('anc-sub-text');
    const clearBtn = document.getElementById('anc-clear-all-btn');
    if (!body) return;

    const items  = _getFiltered();
    const total  = _notifications.length;
    const unread = _getUnreadCount();

    if (subText) {
      subText.textContent = total === 0
        ? t('notif.empty_all_title', null, 'Belum ada notifikasi')
        : unread > 0
          ? t('notif.unread_count', { unread, total }, `${unread} belum dibaca dari ${total} total`)
          : `${total} ${t('notif.count_suffix', null, 'notifikasi')}, ${t('notif.all_read', null, 'semua sudah dibaca')}`;
    }

    if (clearBtn) clearBtn.disabled = total === 0;

    // Tab counts
    [
      ['anc-tab-count-all',       _notifications.length],
      ['anc-tab-count-violation', _notifications.filter(n => n.type === 'violation' || n.type === 'max_violation').length],
      ['anc-tab-count-submitted', _notifications.filter(n => n.type === 'submitted').length],
    ].forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.textContent = val; });

    if (items.length === 0) {
      const emptyIcon = _activeTab === 'submitted' ? 'task_alt'
                      : _activeTab === 'violation' ? 'verified_user'
                      : 'notifications';
      const emptyTitle = _activeTab === 'submitted' ? t('notif.empty_submitted_title', null, 'Belum ada peserta selesai')
                       : _activeTab === 'violation' ? t('notif.empty_violation_title', null, 'Tidak ada indikasi kecurangan')
                       : t('notif.empty_all_title', null, 'Tidak ada notifikasi');
      const emptySub = _activeTab === 'submitted'
        ? t('notif.empty_submitted_sub', null, 'Notifikasi peserta yang mengumpulkan asesmen akan muncul di sini secara otomatis.')
        : _activeTab === 'violation'
          ? t('notif.empty_violation_sub', null, 'Sistem memantau pelanggaran secara real-time. Notifikasi akan muncul di sini saat terdeteksi.')
          : t('notif.empty_all_sub', null, 'Notifikasi pelanggaran dan pengumpulan asesmen akan muncul di sini secara otomatis.');

      body.innerHTML = `
        <div class="anc-empty-state">
          <div class="anc-empty-icon">
            <span aria-hidden="true" data-albedu-icon="${emptyIcon}"></span>
          </div>
          <p class="anc-empty-title">${emptyTitle}</p>
          <p class="anc-empty-sub">${emptySub}</p>
        </div>`;
      return;
    }

    let html = '';
    let lastRead = null;
    items.forEach((n, i) => {
      if (i === 0 && !n.read) html += `<div class="anc-separator anc-separator-new"><span>${t('notif.section_new', null, 'Baru')}</span></div>`;
      if (lastRead === false && n.read) html += `<div class="anc-separator"><span>${t('notif.section_read', null, 'Sudah Dibaca')}</span></div>`;
      lastRead = n.read;

      const typeClass = n.type === 'submitted' ? 'anc-item-green'
                      : n.type === 'max_violation' ? 'anc-item-red anc-item-critical'
                      : 'anc-item-orange';

      html += `
        <div class="anc-notif-item ${typeClass} ${n.read ? 'anc-item-read' : 'anc-item-unread'}"
             data-notif-id="${_sanitize(n.id)}" role="listitem">
          <div class="anc-item-indicator" aria-hidden="true"></div>
          <div class="anc-item-icon" aria-hidden="true">${_iconFor(n.type)}</div>
          <div class="anc-item-content">
            <div class="anc-item-top">
              <span class="anc-item-user">${_sanitize(n.userName)}</span>
              ${_chipFor(n.type, n.warningNum, n.maxWarnings)}
            </div>
            <div class="anc-item-exam">${_sanitize(n.examTitle)}</div>
            <div class="anc-item-msg">${_sanitize(n.message)}</div>
            <div class="anc-item-time"><span aria-hidden="true" data-albedu-icon="schedule"></span> ${_relativeTime(n.ts)}</div>
          </div>
          <div class="anc-item-controls">
            ${!n.read ? `<button class="anc-item-mark-btn" data-id="${_sanitize(n.id)}" title="${t('notif.mark_read', null, 'Tandai dibaca')}" aria-label="${t('notif.mark_read', null, 'Tandai dibaca')}"><span aria-hidden="true" data-albedu-icon="check"></span></button>` : ''}
            <button class="anc-item-dismiss-btn" data-id="${_sanitize(n.id)}" title="${t('notif.dismiss', null, 'Hapus notifikasi')}" aria-label="${t('notif.dismiss_aria', { name: _sanitize(n.userName) }, 'Hapus notifikasi ' + _sanitize(n.userName))}">
              <span aria-hidden="true" data-albedu-icon="close"></span>
            </button>
          </div>
        </div>`;
    });

    body.innerHTML = html;

    body.querySelectorAll('.anc-item-mark-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _markOneRead(btn.dataset.id); });
    });
    body.querySelectorAll('.anc-item-dismiss-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _dismissOne(btn.dataset.id); });
    });
  }

  function _markOneRead(id) {
    const n = _notifications.find(n => n.id === id);
    // No pulse on mark-read — user initiated.
    if (n) { n.read = true; _updateBadge({ pulse: false }); _renderPanelContent(); }
  }

  function markAllRead() {
    _notifications.forEach(n => n.read = true);
    // No pulse on mark-all-read — user initiated.
    _updateBadge({ pulse: false });
    if (_isPanelOpen) _renderPanelContent();
  }

  function openPanel() {
    if (!_panelEl) _createPanel();
    _isPanelOpen = true;
    _renderPanelContent();
    _overlayEl.classList.add('anc-visible');
    _panelEl.classList.add('anc-panel-open');
    _panelEl.focus();
    document.body.style.overflow = 'hidden';
  }

  function closePanel() {
    if (!_panelEl) return;
    _isPanelOpen = false;
    _overlayEl.classList.remove('anc-visible');
    _panelEl.classList.remove('anc-panel-open');
    document.body.style.overflow = '';
  }

  async function init() {
    if (_isInitialized) return;
    // No pulse on init — page load should be silent. Pulse only fires for
    // NEW violations that arrive real-time after the first snapshot.
    _updateBadge({ pulse: false });
    _createPanel();

    function _waitForPlatform(ms) {
      if (window.AlbEdu?.supabase?.isReady?.()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Koneksi timeout')), ms);
        document.addEventListener('albedu:platform-ready', () => { clearTimeout(t); resolve(); }, { once: true });
        document.addEventListener('albedu:platform-error', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    try {
      await _waitForPlatform(10_000);
      if (!window.AlbEdu?.repository) return;
      _db = true; // marker: platform ready (actual access via AlbEdu.repository)

      window.AlbEdu.supabase.auth.onAuthStateChange((user) => {
        if (user) {
          _subscribeToViolations();
        } else if (_unsubscribe) {
          _unsubscribe();
          _unsubscribe = null;
          _notifications = [];
          _docState.clear();
          // No pulse on logout — silent cleanup.
          _updateBadge({ pulse: false });
          if (_isPanelOpen) _renderPanelContent();
        }
      });

      _isInitialized = true;
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    setTimeout(init, 0);
  }

  global.AdminNotificationCenter = {
    init, openPanel, closePanel, markAllRead,
    clearAll: _clearAll,
    getNotifications: () => [..._notifications],
    getUnreadCount:   () => _getUnreadCount(),
  };

})(window);