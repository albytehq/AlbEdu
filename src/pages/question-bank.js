// =============================================================================
// question-bank.js — AlbEdu Bank Soal v1.0.0
// =============================================================================
// Full CRUD for the `question_bank` table (RLS: admin can only CRUD own
// questions where owner_id = auth.uid()).
//
// Features:
//   1. List questions owned by the current admin
//   2. Search (debounced 240ms, client-side, matches question/subject/tags)
//   3. Filter by subject (dynamic), difficulty, tags (comma-separated)
//   4. Create / Edit question via modal
//   5. Delete with hold-to-confirm (2s)
//   6. Import JSON (batch insert via Firestore shim, skip invalid)
//   7. Export JSON (Blob download)
//   8. Add-to-Assessment stub (Phase 8 — toast only)
//
// DB access: window.firebaseDb (Firestore shim → Supabase).
//            See /src/utils/supabase-api.js for shim coverage.
//
// NOTE on `pilihan` JSONB keys:
//   The Firestore shim applies camelCase → snake_case translation recursively
//   to ALL keys, including single uppercase letters inside nested objects.
//   That means `{A,B,C,D}` becomes `{a,b,c,d}` on write, and stays lowercase
//   on read. To keep the documented schema intent ({A,B,C,D}) intact for the
//   UI layer, we normalize pilihan defensively on every read path. The DB
//   may end up storing either case depending on the write path; the UI only
//   ever sees uppercase A/B/C/D.
//
// Depends on:
//   - window.firebaseDb            (DB shim)
//   - window.firebaseAuth          (auth shim)
//   - window.notify / .confirm / .holdConfirmAsync (QNotify bridge)
//   - window.i18n.t                (translations — best-effort)
// =============================================================================

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────────
  const COLLECTION             = 'question_bank';
  const SEARCH_DEBOUNCE_MS     = 240;
  const HOLD_CONFIRM_MS        = 2000;
  const MIN_QUESTION_LEN       = 3;
  const VALID_TYPES            = ['PG', 'esai'];
  const VALID_DIFFICULTIES     = ['easy', 'medium', 'hard'];
  const OPTION_KEYS            = ['A', 'B', 'C', 'D'];
  const AUTH_WAIT_TIMEOUT_MS   = 10_000;
  const PRESET_SUBJECTS        = [
    'Matematika', 'Bahasa Indonesia', 'Bahasa Inggris',
    'IPA Terpadu', 'IPS Terpadu', 'PPKn',
  ];

  // ─── State ──────────────────────────────────────────────────────────────
  const _state = {
    user:             null,
    questions:        [],   // all loaded questions
    filtered:         [],   // after filter
    subjects:         [],   // distinct subjects from loaded data
    tags:             [],   // distinct tags from loaded data
    search:           '',
    filterSubject:    '',
    filterDifficulty: '',
    filterTags:       [],   // lowercased tags to match (any-match)
    editingId:        null, // null = create mode
    modalOpen:        false,
  };

  // ─── DOM cache ──────────────────────────────────────────────────────────
  const _dom = {};
  let _tagFilterTimer = null;
  let _searchTimer    = null;

  // ─── Helpers ────────────────────────────────────────────────────────────
  function _t(key, params) {
    try {
      if (window.i18n && typeof window.i18n.t === 'function') {
        return window.i18n.t(key, params);
      }
    } catch (_) { /* noop */ }
    return key;
  }

  function _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _truncate(str, n) {
    const s = String(str ?? '').replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : s.slice(0, n).trimEnd() + '…';
  }

  function _uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // RFC4122 v4 fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function _parseTags(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((s) => String(s).trim()).filter(Boolean);
    }
    return String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function _normalizeType(t) {
    if (!t) return '';
    const lower = String(t).toLowerCase();
    if (lower === 'pg' || lower === 'pilihan ganda') return 'PG';
    if (lower === 'esai' || lower === 'essay' || lower === 'esei') return 'esai';
    return VALID_TYPES.includes(t) ? t : '';
  }

  function _normalizeDifficulty(d) {
    if (!d) return null;
    const lower = String(d).toLowerCase();
    return VALID_DIFFICULTIES.includes(lower) ? lower : null;
  }

  /**
   * Normalize pilihan JSONB to canonical {A,B,C,D} format.
   * Defensive: handles both uppercase (DB-intended) and lowercase (shim-written)
   * keys, since the Firestore shim's recursive camelCase→snake_case translation
   * converts single uppercase letters to lowercase.
   */
  function _normalizePilihan(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const out = {};
    for (const k of OPTION_KEYS) {
      const v = p[k] ?? p[k.toLowerCase()] ?? p[k.toUpperCase()] ?? '';
      out[k] = typeof v === 'string' ? v : String(v ?? '');
    }
    return out;
  }

  function _normalizeJawaban(j) {
    if (!j) return null;
    const upper = String(j).toUpperCase();
    return OPTION_KEYS.includes(upper) ? upper : null;
  }

  // ─── Firebase / Auth wait ───────────────────────────────────────────────
  async function _waitForFirebase(timeout) {
    if (window.__firebaseReady) return true;
    if (typeof window.waitForFirebase === 'function') {
      try {
        await window.waitForFirebase(timeout);
        return true;
      } catch (_) {
        return false;
      }
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);
      function cleanup() {
        clearTimeout(t);
        document.removeEventListener('firebase-ready', onReady);
        document.removeEventListener('firebase-error', onError);
      }
      function onReady() { cleanup(); resolve(true); }
      function onError() { cleanup(); resolve(false); }
      document.addEventListener('firebase-ready', onReady, { once: true });
      document.addEventListener('firebase-error', onError, { once: true });
    });
  }

  async function _waitForAuth(timeout) {
    const auth = window.firebaseAuth;
    if (auth && auth.currentUser) return auth.currentUser;

    return new Promise((resolve) => {
      let settled = false;
      let unsub = null;
      let poll = null;

      const done = (user) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsub) { try { unsub(); } catch (_) {} }
        if (poll) clearInterval(poll);
        resolve(user || null);
      };
      const timer = setTimeout(() => done(null), timeout);

      try {
        unsub = auth && typeof auth.onAuthStateChanged === 'function'
          ? auth.onAuthStateChanged((u) => { if (u) done(u); })
          : null;
      } catch (_) { /* noop */ }

      // Polling fallback in case onAuthStateChanged never fires
      poll = setInterval(() => {
        if (window.firebaseAuth && window.firebaseAuth.currentUser) {
          done(window.firebaseAuth.currentUser);
        }
      }, 200);
    });
  }

  // ─── DOM cache + wiring ─────────────────────────────────────────────────
  function _cacheDom() {
    _dom.searchInput      = document.getElementById('qb-search-input');
    _dom.filterSubject    = document.getElementById('qb-filter-subject');
    _dom.filterDifficulty = document.getElementById('qb-filter-difficulty');
    _dom.filterTags       = document.getElementById('qb-filter-tags');
    _dom.count            = document.getElementById('qb-count');
    _dom.grid             = document.getElementById('qb-grid');
    _dom.empty            = document.getElementById('qb-empty');
    _dom.noResults        = document.getElementById('qb-no-results');
    _dom.btnAdd           = document.getElementById('btn-qb-add');
    _dom.btnImport        = document.getElementById('btn-qb-import');
    _dom.btnExport        = document.getElementById('btn-qb-export');
    _dom.btnEmptyAdd      = document.getElementById('btn-qb-empty-add');

    // Hidden file input for JSON import (re-used across multiple imports)
    _dom.fileInput        = document.createElement('input');
    _dom.fileInput.type   = 'file';
    _dom.fileInput.accept = '.json,application/json';
    _dom.fileInput.style.display = 'none';
    document.body.appendChild(_dom.fileInput);
  }

  function _wireEvents() {
    if (_dom.btnAdd)      _dom.btnAdd.addEventListener('click', () => _openModal(null));
    if (_dom.btnEmptyAdd) _dom.btnEmptyAdd.addEventListener('click', () => _openModal(null));
    if (_dom.btnImport)   _dom.btnImport.addEventListener('click', () => _dom.fileInput.click());
    if (_dom.btnExport)   _dom.btnExport.addEventListener('click', () => _exportJson());
    _dom.fileInput.addEventListener('change', (e) => _importJson(e));

    // Search (debounced)
    if (_dom.searchInput) {
      _dom.searchInput.addEventListener('input', (e) => {
        _state.search = e.target.value || '';
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(_applyFilters, SEARCH_DEBOUNCE_MS);
      });
    }

    // Filters (immediate — subject + difficulty)
    if (_dom.filterSubject) {
      _dom.filterSubject.addEventListener('change', (e) => {
        _state.filterSubject = e.target.value || '';
        _applyFilters();
      });
    }
    if (_dom.filterDifficulty) {
      _dom.filterDifficulty.addEventListener('change', (e) => {
        _state.filterDifficulty = e.target.value || '';
        _applyFilters();
      });
    }

    // Filter tags (debounced — comma-separated input)
    if (_dom.filterTags) {
      _dom.filterTags.addEventListener('input', () => {
        clearTimeout(_tagFilterTimer);
        _tagFilterTimer = setTimeout(() => {
          _state.filterTags = _parseTags(_dom.filterTags.value)
            .map((t) => t.toLowerCase());
          _applyFilters();
        }, SEARCH_DEBOUNCE_MS);
      });
    }

    // ESC closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _state.modalOpen) _closeModal();
    });
  }

  // ─── Load + render ──────────────────────────────────────────────────────
  async function _loadQuestions() {
    const db = window.firebaseDb;
    if (!db || !_state.user) return;

    if (_dom.grid) _dom.grid.setAttribute('aria-busy', 'true');
    try {
      const snap = await db.collection(COLLECTION)
        .where('owner_id', '==', _state.user.uid)
        .orderBy('created_at', 'desc')
        .get();

      _state.questions = (snap.docs || []).map((d) => {
        const data = d.data() || {};
        return _normalizeRow(d.id, data);
      });

      _rebuildFilters();
      _applyFilters();
    } catch (err) {
      console.error('[QuestionBank] load:', err);
      window.notify && window.notify.error
        ? window.notify.error('Gagal Memuat', (err && err.message) || 'Tidak dapat memuat bank soal.')
        : console.warn('[QuestionBank] notify unavailable');
      _state.questions = [];
      _applyFilters();
    } finally {
      if (_dom.grid) _dom.grid.setAttribute('aria-busy', 'false');
    }
  }

  function _normalizeRow(id, data) {
    const type = data.type === 'PG' ? 'PG' : 'esai';
    const pilihan = type === 'PG' ? _normalizePilihan(data.pilihan) : null;
    const jawaban = type === 'PG' ? _normalizeJawaban(data.jawaban_benar) : null;
    return {
      id,
      owner_id: data.owner_id || data.ownerId || null,
      subject: data.subject || '',
      topic: data.topic || null,
      difficulty: _normalizeDifficulty(data.difficulty) || null,
      type,
      question: data.question || '',
      pilihan,
      jawaban_benar: jawaban,
      media: (data.media && typeof data.media === 'object' && !Array.isArray(data.media))
        ? data.media : {},
      tags: Array.isArray(data.tags) ? data.tags.filter(Boolean) : [],
      usage_count: Number(data.usage_count) || 0,
      last_used_at: data.last_used_at || data.lastUsedAt || null,
      created_at: data.created_at || data.createdAt || null,
      updated_at: data.updated_at || data.updatedAt || null,
    };
  }

  function _rebuildFilters() {
    // Distinct subjects from loaded data
    const subjectSet = new Set();
    for (const q of _state.questions) {
      if (q.subject) subjectSet.add(q.subject);
    }
    _state.subjects = [...subjectSet].sort((a, b) => a.localeCompare(b));

    // Rebuild subject dropdown — preserve first option (Semua), merge presets + loaded
    if (_dom.filterSubject) {
      const currentValue = _dom.filterSubject.value;
      const firstOpt = _dom.filterSubject.querySelector('option:first-child');
      const merged = [...new Set([...PRESET_SUBJECTS, ..._state.subjects])];
      _dom.filterSubject.innerHTML = '';
      if (firstOpt) _dom.filterSubject.appendChild(firstOpt);
      for (const s of merged) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        _dom.filterSubject.appendChild(opt);
      }
      _dom.filterSubject.value = currentValue;
    }

    // Distinct tags
    const tagSet = new Set();
    for (const q of _state.questions) {
      for (const t of q.tags) {
        if (t) tagSet.add(String(t));
      }
    }
    _state.tags = [...tagSet].sort((a, b) => a.localeCompare(b));

    // Build / update datalist for tag autocomplete
    if (_dom.filterTags) {
      let dl = document.getElementById('qb-filter-tags-list');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'qb-filter-tags-list';
        _dom.filterTags.setAttribute('list', dl.id);
        document.body.appendChild(dl);
      }
      dl.innerHTML = _state.tags
        .map((t) => `<option value="${_esc(t)}">`).join('');
    }
  }

  function _applyFilters() {
    const search = _state.search.trim().toLowerCase();
    const subject = _state.filterSubject;
    const difficulty = _state.filterDifficulty;
    const tags = _state.filterTags;

    _state.filtered = _state.questions.filter((q) => {
      if (subject && q.subject !== subject) return false;
      if (difficulty && q.difficulty !== difficulty) return false;
      if (tags.length > 0) {
        const qTags = q.tags.map((t) => String(t).toLowerCase());
        const hasAny = tags.some((t) => qTags.includes(t));
        if (!hasAny) return false;
      }
      if (search) {
        const haystack = [
          q.question || '',
          q.subject || '',
          q.topic || '',
          q.tags.join(' '),
        ].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    _render();
  }

  function _render() {
    if (!_dom.grid) return;
    const total = _state.filtered.length;

    if (_dom.count) _dom.count.textContent = String(total);

    // Empty bank (no questions at all)
    if (_state.questions.length === 0) {
      _dom.grid.hidden = true;
      _dom.grid.innerHTML = '';
      if (_dom.empty)     _dom.empty.hidden = false;
      if (_dom.noResults) _dom.noResults.hidden = true;
      return;
    }
    // Has questions but filter returned nothing
    if (total === 0) {
      _dom.grid.hidden = true;
      _dom.grid.innerHTML = '';
      if (_dom.empty)     _dom.empty.hidden = true;
      if (_dom.noResults) _dom.noResults.hidden = false;
      return;
    }

    if (_dom.empty)     _dom.empty.hidden = true;
    if (_dom.noResults) _dom.noResults.hidden = true;
    _dom.grid.hidden = false;
    _dom.grid.innerHTML = _state.filtered.map(_renderCard).join('');

    // Wire card actions
    _dom.grid.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (!action || !id) return;
        if (action === 'edit')              _openModal(id);
        else if (action === 'delete')       _confirmDelete(id);
        else if (action === 'add-to-asm')   _addToAssessment(id);
      });
    });
  }

  function _renderCard(q) {
    const type = q.type || 'esai';
    const typeClass = type === 'PG' ? 'qb-type-PG' : 'qb-type-ESAI';
    const typeLabel = type === 'PG' ? 'PG' : 'Esai';

    const diff = q.difficulty || '';
    const diffKey = diff ? ('question_bank.difficulty_' + diff) : '';
    const diffLabel = diff ? _t(diffKey) : '';
    const diffBadge = diff
      ? `<span class="qb-difficulty-badge qb-difficulty-${_esc(diff)}">${_esc(diffLabel)}</span>`
      : '';

    const tags = Array.isArray(q.tags) ? q.tags : [];
    const tagsHtml = tags.length
      ? tags.map((t) => `<span class="qb-tag">#${_esc(t)}</span>`).join('')
      : '';

    const usage = Number(q.usage_count) || 0;
    const usageLabel = _t('question_bank.usage_count', { count: usage });

    return `
      <article class="qb-card" data-id="${_esc(q.id)}">
        <header class="qb-card-head">
          <span class="qb-type-badge ${typeClass}">${_esc(typeLabel)}</span>
          ${diffBadge}
          <span class="qb-usage" title="Jumlah dipakai di asesmen">${_esc(usageLabel)}</span>
        </header>
        <div class="qb-card-text">${_esc(_truncate(q.question, 200))}</div>
        <div class="qb-card-meta">
          <span class="qb-subject">${_esc(q.subject || '—')}</span>
          ${q.topic ? `<span>• ${_esc(q.topic)}</span>` : ''}
          ${tagsHtml}
        </div>
        <footer class="qb-card-actions">
          <button class="albedu-btn albedu-btn-secondary albedu-btn-sm" data-action="edit" data-id="${_esc(q.id)}" type="button">
            <i class="material-symbols-outlined">edit</i>
            <span>${_esc(_t('common.edit'))}</span>
          </button>
          <button class="albedu-btn albedu-btn-danger albedu-btn-sm" data-action="delete" data-id="${_esc(q.id)}" type="button">
            <i class="material-symbols-outlined">delete</i>
            <span>${_esc(_t('common.delete'))}</span>
          </button>
          <button class="albedu-btn albedu-btn-ghost albedu-btn-sm" data-action="add-to-asm" data-id="${_esc(q.id)}" type="button" title="${_esc(_t('question_bank.add_to_assessment'))}">
            <i class="material-symbols-outlined">add</i>
            <span>+ Asesmen</span>
          </button>
        </footer>
      </article>
    `;
  }

  // ─── Modal (Create / Edit) ──────────────────────────────────────────────
  function _ensureModal() {
    if (_dom.modalOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'qb-modal-overlay';
    overlay.setAttribute('hidden', '');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(15,23,42,.55)',
      'padding:20px',
      'opacity:0',
      'transition:opacity .2s ease',
      'pointer-events:none',
    ].join(';');

    overlay.innerHTML = `
      <div class="qb-modal" role="dialog" aria-modal="true" aria-labelledby="qb-modal-title"
           style="background:var(--albedu-surface,#fff);border-radius:14px;border:1px solid var(--albedu-border,#e2e8f0);box-shadow:0 20px 50px rgba(15,23,42,.25);width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;">
        <header style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--albedu-border,#e2e8f0);">
          <div>
            <h2 id="qb-modal-title" style="font-size:17px;font-weight:700;margin:0;color:var(--albedu-heading,#0f172a);">Tambah Soal</h2>
            <p id="qb-modal-subtitle" style="font-size:13px;color:var(--albedu-body,#64748b);margin:4px 0 0;"></p>
          </div>
          <button id="qb-modal-close" type="button" aria-label="Tutup"
                  style="background:transparent;border:none;cursor:pointer;color:var(--albedu-body,#64748b);padding:6px;border-radius:6px;">
            <i class="material-symbols-outlined">close</i>
          </button>
        </header>
        <form id="qb-modal-form" style="padding:22px;overflow-y:auto;flex:1;">
          <div class="albedu-field" style="margin-bottom:14px;">
            <label style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tipe Soal <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap;">
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer;">
                <input type="radio" name="qb-type" value="PG" /> PG (Pilihan Ganda)
              </label>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer;">
                <input type="radio" name="qb-type" value="esai" /> Esai
              </label>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div class="albedu-field">
              <label for="qb-f-subject" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Mata Pelajaran <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
              <input id="qb-f-subject" type="text" class="albedu-input" list="qb-subject-list" placeholder="cth: Matematika"
                     style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
              <datalist id="qb-subject-list">
                ${PRESET_SUBJECTS.map((s) => `<option value="${_esc(s)}">`).join('')}
              </datalist>
            </div>
            <div class="albedu-field">
              <label for="qb-f-topic" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Topik</label>
              <input id="qb-f-topic" type="text" class="albedu-input" placeholder="cth: Aljabar"
                     style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
            </div>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-difficulty" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tingkat Kesulitan</label>
            <select id="qb-f-difficulty"
                    style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;background:var(--albedu-surface,#fff);width:100%;box-sizing:border-box;">
              <option value="">— Tidak ditentukan —</option>
              <option value="easy">${_esc(_t('question_bank.difficulty_easy'))}</option>
              <option value="medium">${_esc(_t('question_bank.difficulty_medium'))}</option>
              <option value="hard">${_esc(_t('question_bank.difficulty_hard'))}</option>
            </select>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-question" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Pertanyaan <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <textarea id="qb-f-question" class="albedu-textarea" placeholder="Tulis pertanyaan di sini..."
                      style="min-height:90px;padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;"></textarea>
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Minimal ${MIN_QUESTION_LEN} karakter.</span>
          </div>

          <div id="qb-f-pilihan-wrap" class="albedu-field" style="margin-top:14px;" hidden>
            <label style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Pilihan Jawaban <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <div style="display:grid;gap:8px;margin-top:6px;">
              ${OPTION_KEYS.map((k) => `
                <div style="display:flex;align-items:center;gap:8px;">
                  <label data-letter="${k}" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--albedu-primary,#2563eb);color:#fff;font-weight:700;font-size:13px;cursor:pointer;flex-shrink:0;user-select:none;position:relative;">
                    <input type="radio" name="qb-jawaban" value="${k}" style="position:absolute;opacity:0;pointer-events:none;" />
                    ${k}
                  </label>
                  <input type="text" data-pilihan="${k}" placeholder="Teks pilihan ${k}"
                         style="flex:1;padding:9px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:8px;font-size:14px;" />
                </div>
              `).join('')}
            </div>
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Klik huruf untuk menandai jawaban benar.</span>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-tags" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tags</label>
            <input id="qb-f-tags" type="text" class="albedu-input" placeholder="cth: aljabar, persamaan"
                   style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Pisahkan dengan koma.</span>
          </div>
        </form>
        <footer style="display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--albedu-border,#e2e8f0);">
          <button id="qb-modal-cancel" type="button" class="albedu-btn albedu-btn-secondary albedu-btn-sm">Batal</button>
          <button id="qb-modal-save" type="button" class="albedu-btn albedu-btn-primary albedu-btn-sm">
            <i class="material-symbols-outlined">check</i>
            <span>Simpan</span>
          </button>
        </footer>
      </div>
    `;

    document.body.appendChild(overlay);

    // Cache modal references
    _dom.modalOverlay     = overlay;
    _dom.modalTitle       = overlay.querySelector('#qb-modal-title');
    _dom.modalSubtitle    = overlay.querySelector('#qb-modal-subtitle');
    _dom.modalForm        = overlay.querySelector('#qb-modal-form');
    _dom.modalClose       = overlay.querySelector('#qb-modal-close');
    _dom.modalCancel      = overlay.querySelector('#qb-modal-cancel');
    _dom.modalSave        = overlay.querySelector('#qb-modal-save');
    _dom.modalTypePG      = overlay.querySelector('input[name="qb-type"][value="PG"]');
    _dom.modalTypeEsai    = overlay.querySelector('input[name="qb-type"][value="esai"]');
    _dom.modalSubject     = overlay.querySelector('#qb-f-subject');
    _dom.modalTopic       = overlay.querySelector('#qb-f-topic');
    _dom.modalDifficulty  = overlay.querySelector('#qb-f-difficulty');
    _dom.modalQuestion    = overlay.querySelector('#qb-f-question');
    _dom.modalPilihanWrap = overlay.querySelector('#qb-f-pilihan-wrap');
    _dom.modalTags        = overlay.querySelector('#qb-f-tags');

    // Wire modal events
    _dom.modalClose.addEventListener('click', _closeModal);
    _dom.modalCancel.addEventListener('click', _closeModal);
    _dom.modalSave.addEventListener('click', _onSave);
    _dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === _dom.modalOverlay) _closeModal();
    });
    _dom.modalTypePG.addEventListener('change', () => _togglePilihan(true));
    _dom.modalTypeEsai.addEventListener('change', () => _togglePilihan(false));

    // Pilihan radio — clicking the letter circle selects it
    _dom.modalPilihanWrap.querySelectorAll('label[data-letter]').forEach((label) => {
      label.addEventListener('click', () => {
        const input = label.querySelector('input[type="radio"]');
        if (input) input.checked = true;
      });
    });
  }

  function _togglePilihan(show) {
    if (_dom.modalPilihanWrap) _dom.modalPilihanWrap.hidden = !show;
  }

  function _openModal(questionId) {
    _ensureModal();
    if (!_dom.modalOverlay) return;

    _dom.modalForm.reset();
    _state.editingId = questionId || null;

    if (questionId) {
      // EDIT mode
      const q = _state.questions.find((x) => x.id === questionId);
      if (!q) {
        if (window.notify && window.notify.error) {
          window.notify.error('Tidak Ditemukan', 'Soal tidak ditemukan.');
        }
        return;
      }
      _dom.modalTitle.textContent = 'Edit Soal';
      _dom.modalSubtitle.textContent =
        (q.subject || '—') + ' • ' + (q.type === 'PG' ? 'Pilihan Ganda' : 'Esai');

      if (q.type === 'PG') _dom.modalTypePG.checked = true;
      else                  _dom.modalTypeEsai.checked = true;
      _togglePilihan(q.type === 'PG');

      _dom.modalSubject.value    = q.subject || '';
      _dom.modalTopic.value      = q.topic || '';
      _dom.modalDifficulty.value = q.difficulty || '';
      _dom.modalQuestion.value   = q.question || '';
      _dom.modalTags.value       = q.tags.join(', ');

      if (q.type === 'PG' && q.pilihan) {
        for (const k of OPTION_KEYS) {
          const input = _dom.modalPilihanWrap.querySelector(
            'input[data-pilihan="' + k + '"]'
          );
          if (input) input.value = q.pilihan[k] || '';
        }
        if (q.jawaban_benar) {
          const radio = _dom.modalPilihanWrap.querySelector(
            'input[name="qb-jawaban"][value="' + q.jawaban_benar + '"]'
          );
          if (radio) radio.checked = true;
        }
      }
    } else {
      // CREATE mode
      _dom.modalTitle.textContent = 'Tambah Soal';
      _dom.modalSubtitle.textContent = 'Buat soal baru untuk bank soal Anda';
      _dom.modalTypePG.checked = true;
      _togglePilihan(true);
    }

    _state.modalOpen = true;
    _dom.modalOverlay.hidden = false;
    requestAnimationFrame(() => {
      _dom.modalOverlay.style.opacity = '1';
      _dom.modalOverlay.style.pointerEvents = 'auto';
    });
    setTimeout(() => {
      const first = _dom.modalForm.querySelector('input, textarea, select');
      if (first) first.focus();
    }, 100);
  }

  function _closeModal() {
    if (!_dom.modalOverlay) return;
    _dom.modalOverlay.style.opacity = '0';
    _dom.modalOverlay.style.pointerEvents = 'none';
    setTimeout(() => {
      _dom.modalOverlay.hidden = true;
      _state.modalOpen = false;
      _state.editingId = null;
    }, 200);
  }

  function _readForm() {
    const typeEl = _dom.modalForm.querySelector('input[name="qb-type"]:checked');
    const type = typeEl ? typeEl.value : '';
    const subject    = (_dom.modalSubject.value || '').trim();
    const topic      = (_dom.modalTopic.value || '').trim() || null;
    const difficulty = (_dom.modalDifficulty.value || '') || null;
    const question   = (_dom.modalQuestion.value || '').trim();
    const tags       = _parseTags(_dom.modalTags.value);

    let pilihan = null;
    let jawaban = null;
    if (type === 'PG') {
      pilihan = {};
      for (const k of OPTION_KEYS) {
        const input = _dom.modalPilihanWrap.querySelector(
          'input[data-pilihan="' + k + '"]'
        );
        pilihan[k] = (input && input.value || '').trim();
      }
      const jbEl = _dom.modalForm.querySelector('input[name="qb-jawaban"]:checked');
      jawaban = jbEl ? jbEl.value : '';
    }

    return { type, subject, topic, difficulty, question, tags, pilihan, jawaban };
  }

  function _validateForm(data) {
    const errors = [];
    if (!VALID_TYPES.includes(data.type)) {
      errors.push('Tipe soal harus dipilih.');
    }
    if (!data.question || data.question.length < MIN_QUESTION_LEN) {
      errors.push('Pertanyaan minimal ' + MIN_QUESTION_LEN + ' karakter.');
    }
    if (!data.subject) errors.push('Mata pelajaran harus diisi.');
    if (data.difficulty && !VALID_DIFFICULTIES.includes(data.difficulty)) {
      errors.push('Tingkat kesulitan tidak valid.');
    }
    if (data.type === 'PG') {
      if (!data.pilihan) {
        errors.push('Pilihan harus diisi.');
      } else {
        for (const k of OPTION_KEYS) {
          if (!data.pilihan[k]) errors.push('Pilihan ' + k + ' harus diisi.');
        }
      }
      if (!data.jawaban || !OPTION_KEYS.includes(data.jawaban)) {
        errors.push('Jawaban benar harus dipilih.');
      }
    }
    return errors;
  }

  async function _onSave() {
    if (!_dom.modalSave || _dom.modalSave.disabled) return;

    const data = _readForm();
    const errors = _validateForm(data);
    if (errors.length > 0) {
      if (window.notify && window.notify.error) {
        window.notify.error('Validasi Gagal', errors.join('\n'));
      }
      return;
    }

    const db = window.firebaseDb;
    if (!db || !_state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Error', 'Sesi tidak siap. Coba muat ulang halaman.');
      }
      return;
    }

    // Lock save button + show loading state
    const original = _dom.modalSave.innerHTML;
    _dom.modalSave.disabled = true;
    _dom.modalSave.innerHTML =
      '<i class="material-symbols-outlined">hourglass_top</i><span>Menyimpan…</span>';

    try {
      // Build payload — pilihan with uppercase {A,B,C,D} per schema.
      // NOTE: the Firestore shim will translate these keys to lowercase
      // before sending to Postgres. _normalizePilihan() on read brings
      // them back to uppercase. Functionally consistent.
      const payload = {
        owner_id: _state.user.uid,
        subject: data.subject,
        topic: data.topic,
        difficulty: data.difficulty,
        type: data.type,
        question: data.question,
        pilihan: data.type === 'PG' ? data.pilihan : null,
        jawaban_benar: data.type === 'PG' ? data.jawaban : null,
        media: {},
        tags: data.tags,
        updated_at: db.FieldValue.serverTimestamp(),
      };

      if (_state.editingId) {
        // UPDATE — don't touch created_at
        await db.collection(COLLECTION).doc(_state.editingId).update(payload);
        if (window.notify && window.notify.success) {
          window.notify.success('Tersimpan', 'Soal berhasil diperbarui.');
        }
      } else {
        // CREATE — include created_at
        payload.created_at = db.FieldValue.serverTimestamp();
        const newId = _uuid();
        await db.collection(COLLECTION).doc(newId).set(payload);
        if (window.notify && window.notify.success) {
          window.notify.success('Tersimpan', 'Soal baru berhasil ditambahkan.');
        }
      }

      _closeModal();
      await _loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] save:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Gagal Menyimpan',
          (err && err.message) || 'Terjadi kesalahan saat menyimpan soal.'
        );
      }
    } finally {
      _dom.modalSave.disabled = false;
      _dom.modalSave.innerHTML = original;
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────────
  function _confirmDelete(id) {
    const q = _state.questions.find((x) => x.id === id);
    if (!q) return;
    const preview = _truncate(q.question, 80);

    // Preferred: hold-to-confirm (2s) for destructive action
    if (window.notify && typeof window.notify.holdConfirmAsync === 'function') {
      window.notify.holdConfirmAsync({
        title: 'Hapus Soal',
        message: 'Tahan tombol untuk menghapus: "' + preview + '"',
        intent: 'danger',
        holdDuration: HOLD_CONFIRM_MS,
        onAsyncConfirm: async () => { await _doDelete(id); },
        onCancel: function () { /* noop */ },
      });
      return;
    }
    // Fallback: regular confirm dialog
    if (window.notify && typeof window.notify.confirm === 'function') {
      window.notify.confirm({
        title: 'Hapus Soal',
        message: 'Yakin hapus soal: "' + preview + '"? Tindakan ini tidak dapat dibatalkan.',
        intent: 'danger',
        onYes: function () { _doDelete(id); },
      });
      return;
    }
    // Last resort: native confirm
    if (window.confirm('Hapus soal: "' + preview + '"?')) _doDelete(id);
  }

  async function _doDelete(id) {
    const db = window.firebaseDb;
    if (!db) return;
    try {
      await db.collection(COLLECTION).doc(id).delete();
      if (window.notify && window.notify.success) {
        window.notify.success('Terhapus', 'Soal berhasil dihapus.');
      }
      await _loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] delete:', err);
      if (window.notify && window.notify.error) {
        window.notify.error('Gagal Hapus', (err && err.message) || 'Tidak dapat menghapus soal.');
      }
    }
  }

  // ─── Import JSON ────────────────────────────────────────────────────────
  async function _importJson(event) {
    const file = event.target.files && event.target.files[0];
    // Reset input so same file can be re-selected
    event.target.value = '';
    if (!file) return;

    const db = window.firebaseDb;
    if (!db || !_state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Error', 'Sesi tidak siap. Coba muat ulang halaman.');
      }
      return;
    }

    // Parse JSON
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (err) {
      console.error('[QuestionBank] import parse:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Import Gagal',
          'File JSON tidak valid: ' + ((err && err.message) || 'parse error')
        );
      }
      return;
    }

    // Accept either an array of questions or { questions: [...] }
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null);
    if (!arr) {
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Import Gagal',
          'JSON harus berupa array soal atau { questions: [...] }.'
        );
      }
      return;
    }

    // Validate each entry; collect valid payloads
    let imported = 0;
    let skipped = 0;
    const validPayloads = [];
    const now = db.FieldValue.serverTimestamp();
    const owner = _state.user.uid;

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const result = _validateImportItem(item);
      if (!result.valid) {
        skipped++;
        console.warn('[QuestionBank] import skip #' + (i + 1) + ':', result.reason, item);
        continue;
      }
      validPayloads.push(_buildImportPayload(result.normalized, owner, now));
    }

    if (validPayloads.length === 0) {
      if (window.notify && window.notify.warning) {
        window.notify.warning(
          'Import Kosong',
          'Tidak ada soal valid. ' + skipped + ' entri dilewati.'
        );
      }
      return;
    }

    // Batch insert via Firestore shim
    try {
      const batch = db.batch();
      for (const payload of validPayloads) {
        const newId = _uuid();
        const ref = db.collection(COLLECTION).doc(newId);
        batch.set(ref, payload);
        imported++;
      }
      await batch.commit();

      const msg = skipped > 0
        ? 'Berhasil import ' + imported + ' soal, ' + skipped + ' dilewati.'
        : 'Berhasil import ' + imported + ' soal.';
      if (window.notify && window.notify.success) {
        window.notify.success('Import Berhasil', msg);
      }
      await _loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] import commit:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Import Gagal',
          (err && err.message) || 'Terjadi kesalahan saat import.'
        );
      }
    }
  }

  function _validateImportItem(item) {
    if (!item || typeof item !== 'object') {
      return { valid: false, reason: 'Bukan objek' };
    }
    const type = _normalizeType(item.type);
    if (!type) return { valid: false, reason: 'Tipe tidak valid' };

    const question = String(item.question || '').trim();
    if (question.length < MIN_QUESTION_LEN) {
      return {
        valid: false,
        reason: 'Pertanyaan kurang dari ' + MIN_QUESTION_LEN + ' karakter',
      };
    }

    const subject = String(item.subject || '').trim();
    if (!subject) return { valid: false, reason: 'Subject kosong' };

    let pilihan = null;
    let jawaban = null;
    if (type === 'PG') {
      const p = item.pilihan || item.options;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return { valid: false, reason: 'PG: pilihan tidak ada atau bukan objek' };
      }
      pilihan = {};
      for (const k of OPTION_KEYS) {
        const v = p[k] != null ? p[k] : (p[k.toLowerCase()] != null ? p[k.toLowerCase()] : p[k.toUpperCase()]);
        if (!v || !String(v).trim()) {
          return { valid: false, reason: 'PG: pilihan ' + k + ' kosong' };
        }
        pilihan[k] = String(v).trim();
      }
      const jb = item.jawaban_benar || item.answer || item.jawaban;
      const jbNorm = _normalizeJawaban(jb);
      if (!jbNorm) {
        return { valid: false, reason: 'PG: jawaban benar tidak valid' };
      }
      jawaban = jbNorm;
    }

    const difficulty = _normalizeDifficulty(item.difficulty);
    const topic = item.topic ? String(item.topic).trim() : null;
    const tags = _parseTags(item.tags);
    const media = (item.media && typeof item.media === 'object' && !Array.isArray(item.media))
      ? item.media : {};

    return {
      valid: true,
      normalized: {
        type, subject, topic, difficulty, question,
        pilihan, jawaban_benar: jawaban, tags, media,
      },
    };
  }

  function _buildImportPayload(n, owner, ts) {
    return {
      owner_id: owner,
      subject: n.subject,
      topic: n.topic,
      difficulty: n.difficulty,
      type: n.type,
      question: n.question,
      pilihan: n.pilihan,
      jawaban_benar: n.jawaban_benar,
      media: n.media,
      tags: n.tags,
      usage_count: 0,
      created_at: ts,
      updated_at: ts,
    };
  }

  // ─── Export JSON ────────────────────────────────────────────────────────
  async function _exportJson() {
    const db = window.firebaseDb;
    if (!db || !_state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Error', 'Sesi tidak siap. Coba muat ulang halaman.');
      }
      return;
    }

    try {
      // Fresh fetch — ignore current filter, get all owned questions
      const snap = await db.collection(COLLECTION)
        .where('owner_id', '==', _state.user.uid)
        .orderBy('created_at', 'desc')
        .get();

      const arr = (snap.docs || []).map((d) => {
        const data = d.data() || {};
        const type = data.type === 'PG' ? 'PG' : 'esai';
        const pilihan = type === 'PG' ? _normalizePilihan(data.pilihan) : null;
        const jawaban = type === 'PG' ? _normalizeJawaban(data.jawaban_benar) : null;
        return {
          type,
          subject: data.subject || null,
          topic: data.topic || null,
          difficulty: _normalizeDifficulty(data.difficulty) || null,
          question: data.question || null,
          // Export in canonical {A,B,C,D} format regardless of DB storage
          pilihan,
          jawaban_benar: jawaban,
          media: (data.media && typeof data.media === 'object' && !Array.isArray(data.media))
            ? data.media : {},
          tags: Array.isArray(data.tags) ? data.tags : [],
          usage_count: Number(data.usage_count) || 0,
          created_at: data.created_at || data.createdAt || null,
          updated_at: data.updated_at || data.updatedAt || null,
        };
      });

      if (arr.length === 0) {
        if (window.notify && window.notify.warning) {
          window.notify.warning('Export Kosong', 'Belum ada soal untuk diexport.');
        }
        return;
      }

      const json = JSON.stringify(arr, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'albedu-question-bank-export-' + date + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (window.notify && window.notify.success) {
        window.notify.success('Export Berhasil', arr.length + ' soal berhasil diexport.');
      }
    } catch (err) {
      console.error('[QuestionBank] export:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Export Gagal',
          (err && err.message) || 'Terjadi kesalahan saat export.'
        );
      }
    }
  }

  // ─── Add to Assessment (stub — Phase 8) ─────────────────────────────────
  function _addToAssessment(_id) {
    if (window.notify && window.notify.info) {
      window.notify.info(
        'Segera Hadir',
        'Fitur tambah ke asesmen akan tersedia di versi mendatang.'
      );
    }
  }

  // ─── Init ───────────────────────────────────────────────────────────────
  async function init() {
    console.info('[QuestionBank] v1.0.0 init');
    _cacheDom();
    if (!_dom.grid) {
      console.warn('[QuestionBank] required DOM (#qb-grid) missing — abort init');
      return;
    }
    _wireEvents();

    // Show empty state while we wait for auth (initial render)
    _dom.grid.hidden = true;
    _dom.grid.innerHTML = '';
    if (_dom.empty)     _dom.empty.hidden = false;
    if (_dom.noResults) _dom.noResults.hidden = true;

    const ok = await _waitForFirebase(AUTH_WAIT_TIMEOUT_MS);
    if (!ok) {
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Koneksi Gagal',
          'Tidak dapat terhubung ke server. Coba muat ulang halaman.'
        );
      }
      return;
    }

    const user = await _waitForAuth(AUTH_WAIT_TIMEOUT_MS);
    if (!user) {
      if (window.notify && window.notify.error) {
        window.notify.error(
          'Sesi Habis',
          'Silakan login kembali untuk mengakses bank soal.'
        );
      }
      return;
    }
    _state.user = user;

    await _loadQuestions();
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  const QuestionBank = {
    init,
    refresh: _loadQuestions,
  };

  window.QuestionBank = QuestionBank;
  document.addEventListener('DOMContentLoaded', function () { init(); });
})();
