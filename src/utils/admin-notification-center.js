// =============================================================================
// AdminNotificationCenter.js — AlbEdu v0.5.2
// =============================================================================
//
// Real-time violation signal hub. Subscribes to Firestore violations collection
// and pushes live alerts to any admin page that loads this script.
//
// v0.5.2: Removed "Live" badge from header + "Real-time aktif" text from footer
//         per user request. Footer now shows "Terhubung" (Connected) instead.
//
// v0.5.0 ENTERPRISE REDESIGN:
//   - Refined header with clean light theme + brand accent strip
//   - 2-row header layout (title+close / Baca Semua+Hapus Semua)
//   - Sliding pill tab indicator (refined typography + tabular-nums counters)
//   - Notification items with rounded-square icons + severity-tinted borders
//   - Critical (max violation) items pulse to draw attention
//   - Hover-revealed action buttons (mark-read + dismiss)
//   - Refined empty state with rotating dashed ring + contextual messaging
//   - Footer with status dot + last-updated timestamp
//   - All animations respect prefers-reduced-motion
//
// STRATEGI DISMISS (v0.4.1 fix, preserved):
//   - Notifikasi TIDAK disimpan di localStorage
//   - State 100% dari Firestore onSnapshot (source of truth)
//   - Dismiss satu  → deleteDoc dari Firestore → onSnapshot 'removed' → hilang
//   - Clear all     → batch.delete semua doc  → onSnapshot 'removed' → bersih
//   - Pindah halaman → onSnapshot load ulang → hanya tampilkan doc yang masih ada
//
// KONSEKUENSI:
//   - Data violations hilang permanen saat di-dismiss (by design, pilihan 1)
//   - Tidak ada ghost notif setelah navigasi
// =============================================================================

(function (global) {
  'use strict';

  // v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
  const t = (key, vars, fallback) => {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key, vars);
      return v !== undefined ? v : fallback;
    }
    return fallback;
  };

  // ── Constants ──────────────────────────────────────────────────────────────
  const MAX_NOTIFS    = 150;
  const PANEL_ID      = 'anc-panel';
  const OVERLAY_ID    = 'anc-overlay';

  // ── State ──────────────────────────────────────────────────────────────────
  let _db             = null;
  let _unsubscribe    = null;
  let _panelEl        = null;
  let _overlayEl      = null;
  let _activeTab      = 'all';
  let _isInitialized  = false;
  let _isPanelOpen    = false;
  let _isClearingAll  = false;

  // Source of truth: diisi HANYA dari onSnapshot, tidak dari localStorage
  // { id, docId, type, userName, examTitle, message, warningNum, maxWarnings, ts, read }
  let _notifications  = [];

  // docId → { eventCount, status } — track perubahan per doc
  const _docState = new Map();

  // ── Badge ──────────────────────────────────────────────────────────────────
  function _getUnreadCount() {
    return _notifications.filter(n => !n.read).length;
  }

  function _updateBadge() {
    const count = _getUnreadCount();
    document.querySelectorAll('.notification-btn .badge, #anc-bell-badge').forEach(badge => {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = count > 0 ? 'flex' : 'none';
      if (count > 0) {
        badge.classList.add('anc-badge-pulse');
        setTimeout(() => badge.classList.remove('anc-badge-pulse'), 800);
      }
    });
    if (count > 0) {
      document.querySelectorAll('.notification-btn').forEach(btn => {
        btn.classList.add('anc-bell-pulse');
        setTimeout(() => btn.classList.remove('anc-bell-pulse'), 600);
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  // ── Firestore snapshot → state ─────────────────────────────────────────────
  // v1.0.0 SCHEMA: each doc in `violation_events` is a SINGLE event
  // (not an embedded array). One doc → one notification. The old
  // `_docState` per-doc event-count tracking is no longer needed.
  //
  // Field map (new → notification):
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
      const examTitle  = data.exam_title  || data.access_code || t('notif.default_exam', null, 'Ujian');
      const severity   = data.severity    || 'warning';
      // data.event_type (e.g. 'keyboard_violation', 'tab_switch') is available
      // for future per-type rendering; currently all events render as 'violation'.
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
      _updateBadge();
      _updateFooterTimestamp();
      if (_isPanelOpen) _renderPanelContent();
    }
  }

  // ── Footer "last updated" timestamp ─────────────────────────────────────────
  function _updateFooterTimestamp() {
    const el = document.getElementById('anc-footer-note');
    if (!el) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `Diperbarui ${hh}:${mm}:${ss}`;
  }

  // ── Firestore subscription ─────────────────────────────────────────────────
  // v1.0.0: subscribe to `violation_events` (was `violations`). Each doc is
  // one event; we order by `created_at` desc (was `updatedAt`).
  function _subscribeToViolations() {
    if (!_db) return;
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    try {
      _unsubscribe = _db
        .collection('violation_events')
        .orderBy('created_at', 'desc')
        .limit(300)
        .onSnapshot(_handleSnapshot, (err) => {
          const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
          if (isDev) console.warn('[ANC] violation_events onSnapshot error:', err?.message || err);
        });
    } catch (err) {
      const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (isDev) console.warn('[ANC] _subscribeToViolations setup error:', err?.message || err);
    }
  }

  // ── Dismiss satu ───────────────────────────────────────────────────────────
  // Langsung deleteDoc → onSnapshot 'removed' akan bersihin state otomatis
  async function _dismissOne(notifId) {
    const notif = _notifications.find(n => n.id === notifId);
    if (!notif || !_db) return;

    // Animasi keluar dulu
    const el = _panelEl && _panelEl.querySelector(`[data-notif-id="${CSS.escape(notifId)}"]`);
    if (el) {
      el.classList.add('anc-item-removing');
      await new Promise(r => setTimeout(r, 230));
    }

    // Hapus dari state lokal sementara (biar UI responsif)
    _notifications = _notifications.filter(n => n.id !== notifId);
    _updateBadge();
    if (_isPanelOpen) _renderPanelContent();

    // Delete doc Firestore → onSnapshot akan konfirmasi removal
    // v1.0.0: delete from `violation_events` (was `violations`).
    try {
      await _db.collection('violation_events').doc(notif.docId).delete();
    } catch (err) {
      console.warn('[ANC] deleteDoc gagal:', err);
    }
  }

  // ── Clear all ──────────────────────────────────────────────────────────────
  // Batch delete semua doc → onSnapshot 'removed' akan kosongkan state
  async function _clearAll() {
    if (_isClearingAll || _notifications.length === 0) return;
    _isClearingAll = true;

    const btn = _panelEl && _panelEl.querySelector('#anc-clear-all-btn');
    if (btn) btn.disabled = true;

    // Animasi stagger
    const items = _panelEl ? Array.from(_panelEl.querySelectorAll('.anc-notif-item')) : [];
    items.forEach((el, i) => setTimeout(() => el.classList.add('anc-item-removing'), i * 35));

    // Kumpulkan docId unik sebelum clear
    const docIds = [...new Set(_notifications.map(n => n.docId).filter(Boolean))];

    await new Promise(r => setTimeout(r, items.length * 35 + 260));

    // Bersihkan state lokal sementara
    _notifications = [];
    _docState.clear();
    _updateBadge();
    if (_isPanelOpen) _renderPanelContent();

    // Batch delete Firestore (max 500 per batch)
    // v1.0.0: delete from `violation_events` (was `violations`).
    if (docIds.length > 0 && _db) {
      try {
        for (let i = 0; i < docIds.length; i += 500) {
          const chunk = docIds.slice(i, i + 500);
          const batch = _db.batch();
          chunk.forEach(id => batch.delete(_db.collection('violation_events').doc(id)));
          await batch.commit();
        }
      } catch (err) {
        console.warn('[ANC] batch delete gagal:', err);
      }
    }

    _isClearingAll = false;
  }

  // ── Panel DOM ──────────────────────────────────────────────────────────────
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
            <span class="anc-panel-icon"><i aria-hidden="true" class="material-symbols-outlined">notifications</i></span>
            <div class="anc-panel-title-text">
              <h2 class="anc-panel-heading">${t('notif.panel_title', null, 'Notifikasi')}</h2>
              <p class="anc-panel-sub" id="anc-sub-text">${t('common.loading', null, 'Memuat...')}</p>
            </div>
          </div>
          <button class="anc-close-btn" id="anc-close-btn" aria-label="${t('notif.close_aria', null, 'Tutup panel notifikasi')}">
            <i aria-hidden="true" class="material-symbols-outlined">close</i>
          </button>
        </div>
        <div class="anc-panel-header-row2">
          <button class="anc-mark-read-btn" id="anc-mark-all-btn" aria-label="${t('notif.mark_all_read_aria', null, 'Tandai semua dibaca')}">
            <i aria-hidden="true" class="material-symbols-outlined">done_all</i>
            <span>${t('notif.mark_all_read', null, 'Baca Semua')}</span>
          </button>
          <button class="anc-clear-all-btn" id="anc-clear-all-btn" aria-label="${t('notif.clear_all_aria', null, 'Hapus semua notifikasi')}" disabled>
            <i aria-hidden="true" class="material-symbols-outlined">delete</i>
            <span>${t('notif.clear_all', null, 'Hapus Semua')}</span>
          </button>
        </div>
      </div>
      <div class="anc-tabs" role="tablist">
        <button class="anc-tab active" data-tab="all" role="tab" aria-selected="true">
          <i aria-hidden="true" class="material-symbols-outlined">inbox</i> ${t('notif.tab_all', null, 'Semua')}
          <span class="anc-tab-count" id="anc-tab-count-all">0</span>
        </button>
        <button class="anc-tab" data-tab="violation" role="tab" aria-selected="false">
          <i aria-hidden="true" class="material-symbols-outlined">warning</i> ${t('notif.tab_violation', null, 'Kecurangan')}
          <span class="anc-tab-count anc-tab-count-red" id="anc-tab-count-violation">0</span>
        </button>
        <button class="anc-tab" data-tab="submitted" role="tab" aria-selected="false">
          <i aria-hidden="true" class="material-symbols-outlined">check_circle</i> ${t('notif.tab_submitted', null, 'Selesai')}
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
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && _isPanelOpen) closePanel(); });
  }

  // ── Render list ────────────────────────────────────────────────────────────
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
    if (type === 'submitted')     return '<i aria-hidden="true" class="material-symbols-outlined anc-icon-green">check_circle</i>';
    if (type === 'max_violation') return '<i aria-hidden="true" class="material-symbols-outlined anc-icon-red">dangerous</i>';
    return '<i aria-hidden="true" class="material-symbols-outlined anc-icon-orange">warning</i>';
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
        ? t('notif.empty_submitted_sub', null, 'Notifikasi peserta yang mengumpulkan ujian akan muncul di sini secara otomatis.')
        : _activeTab === 'violation'
          ? t('notif.empty_violation_sub', null, 'Sistem memantau pelanggaran secara real-time. Notifikasi akan muncul di sini saat terdeteksi.')
          : t('notif.empty_all_sub', null, 'Notifikasi pelanggaran dan pengumpulan ujian akan muncul di sini secara otomatis.');

      body.innerHTML = `
        <div class="anc-empty-state">
          <div class="anc-empty-icon">
            <i class="material-symbols-outlined" aria-hidden="true">${emptyIcon}</i>
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
            <div class="anc-item-time"><i aria-hidden="true" class="material-symbols-outlined">schedule</i> ${_relativeTime(n.ts)}</div>
          </div>
          <div class="anc-item-controls">
            ${!n.read ? `<button class="anc-item-mark-btn" data-id="${_sanitize(n.id)}" title="${t('notif.mark_read', null, 'Tandai dibaca')}" aria-label="${t('notif.mark_read', null, 'Tandai dibaca')}"><i aria-hidden="true" class="material-symbols-outlined">check</i></button>` : ''}
            <button class="anc-item-dismiss-btn" data-id="${_sanitize(n.id)}" title="${t('notif.dismiss', null, 'Hapus notifikasi')}" aria-label="${t('notif.dismiss_aria', { name: _sanitize(n.userName) }, 'Hapus notifikasi ' + _sanitize(n.userName))}">
              <i aria-hidden="true" class="material-symbols-outlined">close</i>
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
    if (n) { n.read = true; _updateBadge(); _renderPanelContent(); }
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  function markAllRead() {
    _notifications.forEach(n => n.read = true);
    _updateBadge();
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

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    if (_isInitialized) return;
    _updateBadge();
    _createPanel();

    function _waitForFirebase(ms) {
      if (window.__firebaseReady) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Koneksi timeout')), ms);
        document.addEventListener('firebase-ready', () => { clearTimeout(t); resolve(); }, { once: true });
        document.addEventListener('firebase-error', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    try {
      await _waitForFirebase(10_000);
      _db = window.firebaseDb || null;
      if (!_db) return;

      window.firebaseAuth.onAuthStateChanged(user => {
        if (user) {
          // Guard: _db mungkin belum di-set jika auth shim fire sebelum assignment selesai.
          if (!_db) _db = window.firebaseDb || null;
          if (_db) _subscribeToViolations();
        } else if (_unsubscribe) {
          _unsubscribe();
          _unsubscribe = null;
          _notifications = [];
          _docState.clear();
          _updateBadge();
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