// =============================================================================
// take-assessment.js — AlbEdu v1.0.0 Phase 4 — Peserta assessment runtime
// =============================================================================
// Page controller for `pages/assessment/take.html`.
//
// Lifecycle:
//   1. LOADING — wait for auth, fetch assessment by token, fetch session by id,
//      restore draft answers from server (cross-device resume), apply theme.
//   2. IDENTITY — peserta fills identity form (manual fields OR daftar picker).
//      On submit → snapshot saved to session, exam phase starts.
//   3. EXAM — render shuffled questions (mulberry32 PRNG, stable per session),
//      countdown timer from server `ac_end`, heartbeat + block-listener +
//      ExamGuardian anti-cheat. Submit locked until ≤600s remaining.
//   4. RESULT — server re-scores PG, returns score + grading_detail. Render.
//
// Edge cases (20) — see /docs. Handled inline (search "EDGE #N"):
//   1  Refresh → restore from server draft
//   2  Close browser → restore from server
//   3  Switch device → restore from server (seed = session.started_at)
//   4  Lose internet → local draft, sync when online (Heartbeat)
//   5  Regain internet → Heartbeat resumes
//   6  Submit offline → retry 3×, then show retry UI
//   7  Submit fail → retry, don't lose answers
//   8  Double-click submit → idempotent (isSubmitting flag)
//   9  Time expired → 30s grace server-side, client auto-submit on sisa=0
//   10 Submit after blocked → can't (Heartbeat onBlocked → redirect)
//   11 DevTools open → violation (ExamGuardian — preserved)
//   12 Tab switch → violation (ExamGuardian, 800ms debounce)
//   13 Copy/right-click → blocked silent (ExamGuardian)
//   14 4 violations → reset + reshuffle (ExamGuardian onMaxViolation)
//   15 Blocked by admin → instant redirect (BlockListener + Heartbeat)
//   16 Timer 0 → auto-submit
//   17 Disconnected → reconnect, restore (Heartbeat backoff)
//   18 Submit before 10-min → "Submit unlock dalam X menit" tooltip
//   19 Mobile → responsive (CSS handles, but JS touches ≥44px targets)
//   20 Screen reader → ARIA labels, semantic HTML
// =============================================================================

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const SUBMIT_UNLOCK_SECONDS = 600;        // 10 minutes
  const TIMER_WARNING_SECONDS = 300;        // 5 min  → yellow
  const TIMER_CRITICAL_SECONDS = 60;        // 1 min  → red pulse
  const DRAFT_SYNC_DEBOUNCE_MS = 800;       // local → server sync delay
  const SUBMIT_MAX_RETRIES = 3;
  const SUBMIT_RETRY_BASE_MS = 1500;
  const SANITIZE_ALLOWED_TAGS = ['b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li',
    'span', 'sub', 'sup', 'u', 's', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'mark', 'br'];

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    phase: 'loading',                // 'loading' | 'identity' | 'exam' | 'result'
    assessment: null,                // assessment_view_peserta row
    session: null,                   // assessment_sessions row
    identity: null,                  // { _mode, _display_name, ...fields }
    soalPages: [],                   // [{ pageKey, label, typeQuestion, questions[] }]
    shuffledPages: {},               // { [pageKey]: questions[] }
    activePageIdx: 0,
    jawaban: {},                     // { 'section_0__1': 'A' | 'esai...' }
    violations: 0,
    startTime: null,                 // ms epoch (client-side, for duration_seconds)
    endTime: null,
    timerInterval: null,
    submitLocked: true,
    isSubmitting: false,             // idempotency guard (EDGE #8)
    isExpired: false,                // EDGE #9 / #16
    sessionNonce: null,              // sessionStorage-backed
    _draftSyncTimer: null,
    _redirected: false,              // EDGE #15 (block-listener idempotent)
  };

  // ── DOM refs (populated in init) ─────────────────────────────────────────
  const dom = {};

  // ── Public API ───────────────────────────────────────────────────────────
  const TakeAssessment = {

    async init() {
      _cacheDOM();

      // EDGE #2/#3: bfcache bust already in HTML. Here we just boot.
      _setLoadingStatus('Memuat autentikasi...');

      // Wait for auth + QNotify (parallel)
      await Promise.all([
        _waitForAuth(),
        _waitForQNotify(3000),
      ]);

      // UU PDP consent gate (must run before showing any peserta data)
      _setLoadingStatus('Memeriksa persetujuan...');
      try {
        const consentOk = await window.Consent?.check?.();
        if (consentOk === false) return; // consent rejected → user logged out
      } catch (err) {
        console.warn('[take] consent check failed (fail-safe):', err);
      }

      // Read URL token + session id (set by assessment-entry.js)
      const token = _getUrlParam('token') || sessionStorage.getItem('assessment_token');
      const sessionId = sessionStorage.getItem('assessment_session_id');

      if (!token || !sessionId) {
        _showClosed('Token atau sesi tidak ditemukan.',
          'Silakan masuk kembali melalui halaman asesmen.', 'danger');
        return;
      }

      _setLoadingStatus('Mengambil data asesmen...');

      // Fetch assessment (peserta view — strips admin fields)
      const assessment = await _fetchAssessment(token);
      if (!assessment) {
        _showClosed('Kode akses tidak valid.',
          'Asesmen tidak ditemukan atau telah diarsipkan.', 'danger');
        return;
      }
      state.assessment = assessment;

      // Apply theme ASAP so identity form looks right
      _applyTheme(assessment.theme_config);

      // Fetch session
      _setLoadingStatus('Memulihkan sesi...');
      const session = await _fetchSession(sessionId);
      if (!session) {
        _showClosed('Sesi tidak ditemukan.',
          'Sesi telah kedaluwarsa. Silakan masuk kembali.', 'danger');
        return;
      }
      state.session = session;

      // EDGE #15: already blocked → instant redirect
      if (session.status === 'blocked') {
        _handleBlocked(session.blocked_reason || 'Diblokir oleh admin');
        return;
      }

      // Already submitted → redirect to submitted.html
      if (session.status === 'submitted') {
        _handleSubmitted();
        return;
      }

      // EDGE #1/#2/#3: restore draft + identity from server
      _restoreDraft(session);

      // Check assessment access status (open / closed / paused / scheduled)
      const access = _checkAccess(assessment);
      if (!access.allowed) {
        _showClosed(access.title || 'Asesmen Tidak Tersedia', access.message, access.kind || 'warning');
        return;
      }

      // Build soalPages from sections
      state.soalPages = _parseSections(assessment.sections || []);

      if (state.soalPages.length === 0) {
        _showClosed('Soal tidak tersedia.',
          'Asesmen ini belum memiliki soal. Hubungi admin.', 'danger');
        return;
      }

      // Phase routing
      if (state.identity && state.identity._display_name) {
        // Identity already filled → resume exam
        _startExam(state.identity, { isResume: true });
      } else {
        _renderIdentity(assessment);
      }

      // Wire global event handlers
      _wireGlobalEvents();
    },

    // Exposed for Heartbeat.js compatibility (it reads window.ExamLogic.getState)
    _ExamLogicCompat: {
      getState: () => ({
        jawaban: { ...state.jawaban },
        activePageIdx: state.activePageIdx,
        soalPages: state.soalPages,
        violations: state.violations,
      }),
    },
  };

  // Expose to window
  window.TakeAssessment = TakeAssessment;
  // Heartbeat.js reads window.ExamLogic.getState() — provide a shim
  window.ExamLogic = TakeAssessment._ExamLogicCompat;
  // ExamGuardian is a top-level `const` in guardian.js (script-scope). Re-expose
  // on window so logic.js's `window.ExamGuardian` check passes.
  if (typeof ExamGuardian !== 'undefined' && !window.ExamGuardian) {
    window.ExamGuardian = ExamGuardian;
  }

  // =========================================================================
  // DOM & UTILITIES
  // =========================================================================

  function _cacheDOM() {
    dom.loadingScreen = document.getElementById('loading-screen');
    dom.loadingText   = document.getElementById('loading-text');
    dom.loadingStatus = document.getElementById('loading-status');
    dom.closedScreen  = document.getElementById('closed-screen');
    dom.closedIcon    = document.getElementById('closed-icon');
    dom.closedTitle   = document.getElementById('closed-title');
    dom.closedMessage = document.getElementById('closed-message');
    dom.closedRetry   = document.getElementById('closed-retry-btn');
    dom.identityPhase = document.getElementById('identity-phase');
    dom.identityMount = document.getElementById('identity-mount');
    dom.identityTitle = document.getElementById('identity-title');
    dom.identitySubj  = document.getElementById('identity-subject');
    dom.identityChips = document.getElementById('identity-chips');
    dom.identityNote  = document.getElementById('identity-note');
    dom.examPhase     = document.getElementById('exam-phase');
    dom.examSubject   = document.getElementById('exam-subject');
    dom.examTitle     = document.getElementById('exam-title');
    dom.examUserText  = document.getElementById('exam-user-text');
    dom.examTimer     = document.getElementById('exam-timer');
    dom.timerDisplay  = document.getElementById('timer-display');
    dom.progressFill  = document.getElementById('progress-fill');
    dom.pageTabs      = document.getElementById('page-tabs');
    dom.pageTitle     = document.getElementById('page-title');
    dom.pageCount     = document.getElementById('page-count');
    dom.questionList  = document.getElementById('question-list');
    dom.btnPrev       = document.getElementById('btn-prev');
    dom.btnNext       = document.getElementById('btn-next');
    dom.btnSubmit     = document.getElementById('btn-submit');
    dom.navProgress   = document.getElementById('nav-progress');
    dom.resultPhase   = document.getElementById('result-phase');
    dom.pauseBanner   = document.getElementById('pause-banner');
    dom.pauseText     = document.getElementById('pause-text');
    dom.closedRetry?.addEventListener('click', () => window.location.reload());
  }

  function _setPhase(phase) {
    state.phase = phase;
    dom.loadingScreen.hidden = phase !== 'loading';
    dom.closedScreen.hidden  = phase !== 'closed';
    dom.identityPhase.hidden = phase !== 'identity';
    dom.examPhase.hidden     = phase !== 'exam';
    dom.resultPhase.hidden   = phase !== 'result';
    if (phase !== 'loading') {
      dom.loadingScreen.classList.add('fading');
      setTimeout(() => { dom.loadingScreen.style.display = 'none'; }, 240);
    }
  }

  function _setLoadingStatus(text) {
    if (dom.loadingStatus) dom.loadingStatus.textContent = text;
  }

  function _setLoadingTitle(text) {
    if (dom.loadingText) dom.loadingText.textContent = text;
  }

  function _showClosed(title, message, kind) {
    dom.closedTitle.textContent = title;
    dom.closedMessage.textContent = message;
    dom.closedIcon.className = 'status-icon' + (kind === 'danger' ? ' danger' : kind === 'success' ? ' success' : '');
    const iconEl = dom.closedIcon.querySelector('.material-symbols-outlined');
    if (iconEl) {
      iconEl.textContent = kind === 'danger' ? 'error' : kind === 'success' ? 'check_circle' : 'lock';
    }
    _setPhase('closed');
  }

  function _getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function _t(key, fallback) {
    if (typeof window.t === 'function') {
      const v = window.t(key);
      return v === key ? (fallback || key) : v;
    }
    return fallback || key;
  }

  // ── HTML Sanitizer (subset of ExamViewer.sanitize) ──────────────────────
  function _sanitizeHTML(html) {
    if (html == null) return '';
    const str = String(html);
    if (typeof window.DOMPurify !== 'undefined') {
      try {
        return window.DOMPurify.sanitize(str, {
          ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS,
          ALLOWED_ATTR: ['class', 'style', 'lang', 'dir'],
          ALLOW_DATA_ATTR: false,
        });
      } catch (_) { /* fall through */ }
    }
    // Regex fallback
    return str
      .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      .replace(/(?:href|src|action)\s*=\s*(?:"[^"]*(?:javascript|data):[^"]*"|'[^']*(?:javascript|data):[^']*')/gi, '')
      .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*>[\s\S]*?<\/(?:script|iframe|object|embed|style|link)>/gi, '')
      .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*\/?>/gi, '')
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (m, tag) =>
        SANITIZE_ALLOWED_TAGS.includes(tag.toLowerCase()) ? m : '');
  }

  function _escAttr(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Waiters ─────────────────────────────────────────────────────────────
  function _waitForAuth() {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        if (window.firebaseAuth?.currentUser) return resolve();
        if (window.Auth?.authReady === false && attempts < 100) {
          setTimeout(check, 100);
        } else if (attempts >= 100) {
          console.warn('[take] auth timeout — redirecting to login');
          window.location.href = '../login.html';
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  function _waitForQNotify(maxMs) {
    return new Promise((resolve) => {
      if (window.QNotify) return resolve();
      let elapsed = 0;
      const tick = 100;
      const id = setInterval(() => {
        elapsed += tick;
        if (window.QNotify || elapsed >= maxMs) {
          clearInterval(id);
          resolve();
        }
      }, tick);
      window.addEventListener('qnotify-ready', () => {
        clearInterval(id);
        resolve();
      }, { once: true });
    });
  }

  function _waitForThemeSystem(maxMs = 3000) {
    return new Promise((resolve) => {
      if (window.ThemeSystem) return resolve();
      let elapsed = 0;
      const id = setInterval(() => {
        elapsed += 100;
        if (window.ThemeSystem || elapsed >= maxMs) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    });
  }

  // =========================================================================
  // FETCH (server-side data)
  // =========================================================================

  async function _fetchAssessment(token) {
    const db = window.firebaseDb;
    if (!db) return null;
    try {
      // assessment_view_peserta is keyed by access_code (6-digit token)
      const snap = await db.collection('assessment_view_peserta').doc(token).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (err) {
      console.error('[take] fetchAssessment error:', err);
      return null;
    }
  }

  async function _fetchSession(sessionId) {
    const db = window.firebaseDb;
    if (!db) return null;
    try {
      const snap = await db.collection('assessment_sessions').doc(sessionId).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (err) {
      console.error('[take] fetchSession error:', err);
      return null;
    }
  }

  // EDGE #1/#2/#3: restore draft + identity from server
  function _restoreDraft(session) {
    if (!session) return;

    // Restore identity snapshot
    if (session.identity_snapshot && typeof session.identity_snapshot === 'object'
        && (session.identity_snapshot._display_name || session.identity_snapshot.nama)) {
      state.identity = { ...session.identity_snapshot };
    }

    // Restore draft answers
    if (session.draft_answers && typeof session.draft_answers === 'object') {
      // Could be either { "section_0__1": "A" } (our format) or
      // { "section_0": { "1": "A" } } (server submit format). Normalize.
      const draft = session.draft_answers;
      const normalized = {};
      for (const key of Object.keys(draft)) {
        const val = draft[key];
        if (val && typeof val === 'object') {
          // Nested format: { "section_0": { "1": "A" } }
          for (const idq of Object.keys(val)) {
            normalized[`${key}__${idq}`] = val[idq];
          }
        } else {
          // Flat format: { "section_0__1": "A" }
          normalized[key] = val;
        }
      }
      state.jawaban = { ...state.jawaban, ...normalized };
    }

    // Restore violation count
    if (typeof session.violation_count === 'number') {
      state.violations = session.violation_count;
    }
  }

  // =========================================================================
  // ACCESS CHECK
  // =========================================================================

  function _checkAccess(assessment) {
    const now = Date.now();

    if (assessment.status !== 'active') {
      return {
        allowed: false,
        title: 'Asesmen Tidak Tersedia',
        message: 'Asesmen telah diarsipkan atau tidak aktif.',
        kind: 'danger',
      };
    }

    if (assessment.access_mode === 'manual') {
      if (assessment.ac_manual_status === 'closed') {
        // Could be paused or not-yet-open
        if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
          return { allowed: false, title: 'Asesmen Selesai',
            message: 'Asesmen ini telah berakhir.', kind: 'danger' };
        }
        return { allowed: false, title: 'Asesmen Belum Dibuka',
          message: 'Tunggu admin membuka asesmen, lalu muat ulang halaman.',
          kind: 'warning' };
      }
      if (assessment.ac_manual_status === 'finished') {
        return { allowed: false, title: 'Asesmen Selesai',
          message: 'Asesmen ini telah berakhir.', kind: 'danger' };
      }
      // 'open' — verify ac_end not yet passed
      if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
        return { allowed: false, title: 'Asesmen Selesai',
          message: 'Waktu asesmen telah berakhir.', kind: 'danger' };
      }
    } else if (assessment.access_mode === 'scheduled') {
      const start = assessment.ac_scheduled_start ? new Date(assessment.ac_scheduled_start).getTime() : null;
      const end   = assessment.ac_scheduled_end ? new Date(assessment.ac_scheduled_end).getTime() : null;
      if (start && now < start) {
        const startStr = new Date(start).toLocaleString('id-ID', {
          day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
        });
        return { allowed: false, title: 'Asesmen Belum Dimulai',
          message: `Asesmen dimulai pada ${startStr}.`, kind: 'warning' };
      }
      if (end && now > end) {
        return { allowed: false, title: 'Asesmen Selesai',
          message: 'Waktu asesmen telah berakhir.', kind: 'danger' };
      }
    }

    return { allowed: true };
  }

  // =========================================================================
  // THEME
  // =========================================================================

  function _applyTheme(themeConfig) {
    if (!themeConfig || typeof themeConfig !== 'object') return;
    _waitForThemeSystem().then(() => {
      try {
        // theme_config shape: { primary, font, mode, preset } OR
        // legacy { TW, HJ, CU } — handle both
        const cfg = {
          primary: themeConfig.primary || (themeConfig.TW && themeConfig.TW !== 'default' ? themeConfig.TW : undefined),
          font: themeConfig.font || 'Plus Jakarta Sans',
          mode: themeConfig.mode || 'auto',
          preset: themeConfig.preset || 'default',
        };
        if (window.ThemeSystem?.apply) {
          window.ThemeSystem.apply(cfg);
        }
      } catch (err) {
        console.warn('[take] theme apply failed:', err);
      }
    });
  }

  // =========================================================================
  // IDENTITY PHASE
  // =========================================================================

  async function _renderIdentity(assessment) {
    _setPhase('identity');

    // Banner
    dom.identitySubj.textContent = assessment.subject || 'Asesmen';
    dom.identityTitle.textContent = assessment.title || 'Asesmen';

    // Chips
    const chips = [];
    chips.push(`<span class="identity-banner__chip"><i class="material-symbols-outlined">schedule</i> ${_escAttr(assessment.duration_minutes || 0)} menit</span>`);
    if (assessment.identity_mode === 'daftar') {
      const label = assessment.identity_config?.daftar_label ||
                    assessment.identity_config?.daftar_tipe || 'Daftar Nama';
      chips.push(`<span class="identity-banner__chip"><i class="material-symbols-outlined">format_list_bulleted</i> ${_escAttr(label)}</span>`);
    } else {
      chips.push(`<span class="identity-banner__chip"><i class="material-symbols-outlined">keyboard</i> Form Manual</span>`);
    }
    dom.identityChips.innerHTML = chips.join('');

    // Note
    if (assessment.note_enabled && assessment.note_text) {
      dom.identityNote.hidden = false;
      dom.identityNote.innerHTML = _sanitizeHTML(assessment.note_text);
    } else {
      dom.identityNote.hidden = true;
    }

    // Render form via IdentityProvider (async — daftar mode may fetch from DB)
    if (window.IdentityProvider?.render) {
      try {
        await window.IdentityProvider.render(
          dom.identityMount,
          assessment,
          (identity) => _onIdentitySubmit(identity),
          null // no cancel — peserta must complete identity
        );
      } catch (err) {
        console.error('[take] IdentityProvider.render failed:', err);
        window.notify?.error('Gagal', 'Tidak bisa memuat form identitas. Muat ulang halaman.');
      }
    } else {
      // Fallback: minimal manual form (shouldn't happen — provider.js always loaded)
      dom.identityMount.innerHTML = `
        <div class="albedu-field">
          <label for="fallback-nama">Nama Lengkap <span class="albedu-required">*</span></label>
          <input id="fallback-nama" type="text" class="albedu-input" maxlength="80" placeholder="Masukkan nama lengkap" />
        </div>
        <button class="albedu-btn albedu-btn-primary" id="fallback-submit" type="button">Mulai Asesmen</button>
      `;
      document.getElementById('fallback-submit').addEventListener('click', () => {
        const nama = document.getElementById('fallback-nama').value.trim();
        if (!nama) return window.notify?.warning('Validasi', 'Nama wajib diisi');
        _onIdentitySubmit({ _mode: 'manual', _display_name: nama, nama });
      });
    }
  }

  async function _onIdentitySubmit(identity) {
    // Validate
    if (window.IdentityProvider?.validate) {
      const cfg = window.IdentityProvider.getIdentityConfig(state.assessment);
      const errors = window.IdentityProvider.validate(cfg, identity);
      if (errors.length > 0) {
        window.notify?.error('Validasi Gagal', errors[0]);
        return;
      }
    }

    // Sanitize display name (EDGE: peserta could enter arbitrary name)
    if (identity._display_name) {
      identity._display_name = String(identity._display_name).slice(0, 80).trim();
    }
    if (identity.nama) {
      identity.nama = String(identity.nama).slice(0, 80).trim();
    }

    state.identity = identity;

    // Persist identity snapshot to server (so refresh restores to exam phase)
    try {
      const db = window.firebaseDb;
      if (db) {
        await db.collection('assessment_sessions').doc(state.session.id).update({
          identity_snapshot: identity,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[take] persist identity failed (will retry via heartbeat):', err);
    }

    _startExam(identity, { isResume: false });
  }

  // =========================================================================
  // EXAM PHASE
  // =========================================================================

  function _startExam(identity, options = {}) {
    const isResume = options?.isResume === true;

    // Compute shuffle seed (stable per session — survives refresh + cross-device)
    const seed = _computeSeed(state.session);
    state.sessionNonce = seed;
    state.shuffledPages = _shufflePages(state.soalPages, seed);

    state.startTime = state.startTime || Date.now();
    state.activePageIdx = state.activePageIdx || 0;

    _setPhase('exam');

    // Header
    dom.examSubject.textContent = state.assessment.subject || 'Asesmen';
    dom.examTitle.textContent = state.assessment.title || 'Asesmen';
    const displayName = identity?._display_name || identity?.nama || 'Peserta';
    const subLabel = identity?.tab_nama || identity?.kelas ||
                     (identity?._mode === 'manual' ? 'Peserta' : '');
    dom.examUserText.innerHTML = `${_escAttr(displayName)}${subLabel ? ' — ' + _escAttr(subLabel) : ''}`;

    // Page tabs (only if multiple sections)
    _renderPageTabs();

    // Render current page
    _renderQuestion(state.activePageIdx);

    // Start timer (countdown from server ac_end)
    _startTimer(state.assessment);

    // Wire nav buttons
    _wireNavButtons();

    // Start security modules
    _startSecurity();

    // Update submit lock state (EDGE #18: locked until ≤600s)
    _updateSubmitLockState();

    // beforeunload guard (EDGE #2: don't lose answers on close)
    window.addEventListener('beforeunload', _beforeUnloadGuard);

    // popstate trap (prevent peserta from leaving via Back button)
    if (!isResume) {
      history.pushState({ albEduExamActive: true }, '', location.href);
    }
    window.addEventListener('popstate', _popstateTrap);

    console.info('[take] exam started. resume=', isResume, 'seed=', seed,
      'questions=', state.soalPages.reduce((s, p) => s + (p.questions?.length || 0), 0));
  }

  function _renderPageTabs() {
    if (state.soalPages.length <= 1) {
      dom.pageTabs.innerHTML = '';
      dom.pageTabs.hidden = true;
      return;
    }
    dom.pageTabs.hidden = false;
    dom.pageTabs.innerHTML = state.soalPages.map((p, idx) => `
      <button class="page-tab ${idx === state.activePageIdx ? 'active' : ''}"
              type="button"
              role="tab"
              aria-selected="${idx === state.activePageIdx}"
              data-page-idx="${idx}">
        ${_escAttr(p.label)}
      </button>
    `).join('');
    dom.pageTabs.querySelectorAll('.page-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.pageIdx, 10);
        if (idx !== state.activePageIdx) {
          state.activePageIdx = idx;
          _renderQuestion(idx);
          _renderPageTabs();
        }
      });
    });
  }

  // _renderQuestion(idx) — render current page (section) with all its questions
  function _renderQuestion(idx) {
    const page = state.soalPages[idx];
    if (!page) return;

    dom.pageTitle.textContent = page.label;
    dom.pageCount.textContent = `${page.questions.length} Soal`;

    const shuffled = state.shuffledPages[page.pageKey] || page.questions;
    const totalAll = state.soalPages.reduce((s, p) => s + (p.questions?.length || 0), 0);
    const answeredAll = Object.values(state.jawaban).filter(Boolean).length;

    dom.questionList.innerHTML = shuffled.map((q, i) => _buildQuestionCard(q, i, page)).join('');

    // Wire option clicks (event delegation — single listener)
    if (dom.questionList._delegatedAbort) dom.questionList._delegatedAbort.abort();
    dom.questionList._delegatedAbort = new AbortController();
    dom.questionList.addEventListener('click', (e) => {
      const opt = e.target.closest('.option-item');
      if (!opt) return;
      const pageKey = opt.dataset.pagekey;
      const idq = opt.dataset.idq;
      const key = opt.dataset.key;
      if (!pageKey || !idq) return;
      const wasSelected = opt.classList.contains('selected');
      // Clear siblings
      dom.questionList.querySelectorAll(`.option-item[data-idq="${idq}"][data-pagekey="${pageKey}"]`)
        .forEach(o => o.classList.remove('selected'));
      if (!wasSelected) {
        opt.classList.add('selected');
        _saveAnswer(pageKey, parseInt(idq, 10), key);
      } else {
        _saveAnswer(pageKey, parseInt(idq, 10), null);
      }
      _updateQuestionAnsweredState(pageKey, idq, !wasSelected);
      _updateProgress();
    }, { signal: dom.questionList._delegatedAbort.signal });

    // Wire esai textareas
    dom.questionList.querySelectorAll('textarea.esai-textarea').forEach(ta => {
      const pageKey = ta.dataset.pagekey;
      const idq = ta.dataset.idq;
      ta.addEventListener('input', _debounceEsai(pageKey, parseInt(idq, 10), ta));
    });

    // Wire image preview (open in new tab — simple)
    dom.questionList.querySelectorAll('img[data-zoom]').forEach(img => {
      img.addEventListener('click', () => {
        const src = img.dataset.zoom || img.src;
        if (src) window.open(src, '_blank', 'noopener,noreferrer');
      });
    });

    // Render math (KaTeX) + apply RTL class
    _renderMath(dom.questionList);

    _updateProgress();
    _updateNavButtons();
  }

  function _buildQuestionCard(q, displayIdx, page) {
    const pageKey = page.pageKey;
    const jawaban = state.jawaban[`${pageKey}__${q.idq}`];
    const isAnswered = !!jawaban;
    const qText = _sanitizeHTML(q.pertanyaan || '');
    const mediaHTML = _buildMediaHTML(q);

    let bodyHTML = '';
    if (page.typeQuestion === 'esai') {
      bodyHTML = `
        <textarea class="esai-textarea"
                  data-pagekey="${_escAttr(pageKey)}"
                  data-idq="${_escAttr(q.idq)}"
                  placeholder="Tulis jawaban Anda di sini..."
                  aria-label="Jawaban esai untuk soal ${displayIdx + 1}"
                  maxlength="5000">${_escAttr(jawaban || '')}</textarea>
        <div class="question-points">Esai — dinilai manual oleh guru</div>
      `;
    } else {
      // PG — render A/B/C/D
      const pilihan = Array.isArray(q.pilihan) ? q.pilihan : [];
      const keys = ['A', 'B', 'C', 'D', 'E'];
      bodyHTML = `
        <div class="option-list" role="radiogroup" aria-label="Pilihan jawaban soal ${displayIdx + 1}">
          ${pilihan.slice(0, 5).map((opt, i) => {
            const key = keys[i];
            const sel = jawaban === key ? 'selected' : '';
            return `
              <div class="option-item ${sel}"
                   role="radio"
                   aria-checked="${jawaban === key}"
                   tabindex="0"
                   data-pagekey="${_escAttr(pageKey)}"
                   data-idq="${_escAttr(q.idq)}"
                   data-key="${_escAttr(key)}">
                <div class="option-radio" aria-hidden="true"></div>
                <div class="option-key">${_escAttr(key)}</div>
                <div class="option-label">${_sanitizeHTML(opt)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    return `
      <article class="exam-question-card ${isAnswered ? 'answered' : ''}"
               data-pagekey="${_escAttr(pageKey)}"
               data-idq="${_escAttr(q.idq)}">
        <div class="question-num" aria-label="Soal nomor ${displayIdx + 1}">${displayIdx + 1}</div>
        <div class="question-text">${qText}</div>
        ${mediaHTML}
        ${bodyHTML}
      </article>
    `;
  }

  function _buildMediaHTML(q) {
    if (!q.media) return '';
    const parts = [];
    const video = q.media.video;
    const images = Array.isArray(q.media.gambar) ? q.media.gambar : [];

    // Video (YouTube embed)
    if (video?.enabled) {
      let embedSrc = '';
      if (video.videoId) {
        embedSrc = `https://www.youtube.com/embed/${encodeURIComponent(video.videoId)}?rel=0&modestbranding=1`;
      } else if (video.src) {
        const yt = String(video.src).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
        if (yt) embedSrc = `https://www.youtube.com/embed/${encodeURIComponent(yt[1])}?rel=0&modestbranding=1`;
      }
      if (embedSrc) {
        parts.push(`
          <div class="media-video">
            <iframe src="${_escAttr(embedSrc)}" loading="lazy"
                    allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                    title="Video soal"></iframe>
          </div>
        `);
      }
    }

    // Images
    if (images.length > 0) {
      const urls = images.map(img => {
        if (typeof img === 'string') return img;
        if (img && typeof img === 'object' && img.url) return img.url;
        return '';
      }).filter(Boolean);
      if (urls.length > 0) {
        parts.push(urls.map(u =>
          `<img src="${_escAttr(u)}" data-zoom="${_escAttr(u)}" alt="Gambar soal" loading="lazy" />`
        ).join(''));
      }
    }

    return parts.length > 0 ? `<div class="question-media">${parts.join('')}</div>` : '';
  }

  function _updateQuestionAnsweredState(pageKey, idq, answered) {
    const card = dom.questionList.querySelector(
      `.exam-question-card[data-pagekey="${pageKey}"][data-idq="${idq}"]`);
    if (card) card.classList.toggle('answered', answered);
  }

  // =========================================================================
  // ANSWER SAVE (local + debounced server sync)
  // =========================================================================

  function _saveAnswer(pageKey, idq, answer) {
    const key = `${pageKey}__${idq}`;
    if (answer === null || answer === undefined || answer === '') {
      delete state.jawaban[key];
    } else {
      state.jawaban[key] = answer;
    }
    _scheduleDraftSync();
  }

  function _debounceEsai(pageKey, idq, ta) {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        _saveAnswer(pageKey, idq, ta.value);
      }, 400);
    };
  }

  function _scheduleDraftSync() {
    // Local: save to localStorage immediately (so offline close still recovers)
    _saveLocalDraft();

    // Server: debounce (Heartbeat will pick up latest state every 15s anyway,
    // but we trigger an immediate sync for fast feedback)
    if (state._draftSyncTimer) clearTimeout(state._draftSyncTimer);
    state._draftSyncTimer = setTimeout(() => {
      state._draftSyncTimer = null;
      window.Heartbeat?.syncNow?.();
    }, DRAFT_SYNC_DEBOUNCE_MS);
  }

  function _saveLocalDraft() {
    try {
      const token = sessionStorage.getItem('assessment_token') || 'unknown';
      const userKey = window.firebaseAuth?.currentUser?.uid || 'anon';
      const key = `albedu_take_draft_${token}_${userKey}`;
      localStorage.setItem(key, JSON.stringify({
        jawaban: state.jawaban,
        identity: state.identity,
        savedAt: Date.now(),
      }));
    } catch (_) { /* localStorage might be full on low-end devices — silent */ }
  }

  function _clearLocalDraft() {
    try {
      const token = sessionStorage.getItem('assessment_token') || 'unknown';
      const userKey = window.firebaseAuth?.currentUser?.uid || 'anon';
      const key = `albedu_take_draft_${token}_${userKey}`;
      localStorage.removeItem(key);
    } catch (_) {}
  }

  // =========================================================================
  // NAVIGATION
  // =========================================================================

  function _wireNavButtons() {
    dom.btnPrev.addEventListener('click', () => {
      if (state.activePageIdx > 0) {
        state.activePageIdx--;
        _renderQuestion(state.activePageIdx);
        _renderPageTabs();
        dom.examPhase.querySelector('.exam-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    dom.btnNext.addEventListener('click', () => {
      if (state.activePageIdx < state.soalPages.length - 1) {
        state.activePageIdx++;
        _renderQuestion(state.activePageIdx);
        _renderPageTabs();
        dom.examPhase.querySelector('.exam-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    dom.btnSubmit.addEventListener('click', () => {
      if (dom.btnSubmit.disabled) return;
      _submitExam();
    });
  }

  function _updateNavButtons() {
    const isLast = state.activePageIdx === state.soalPages.length - 1;
    dom.btnPrev.disabled = state.activePageIdx === 0;
    dom.btnNext.disabled = isLast;
    dom.btnNext.hidden = isLast;
    dom.btnSubmit.hidden = !isLast;
  }

  function _updateProgress() {
    const total = state.soalPages.reduce((s, p) => s + (p.questions?.length || 0), 0);
    const answered = Object.values(state.jawaban).filter(Boolean).length;
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    dom.progressFill.style.width = `${pct}%`;
    if (dom.navProgress) dom.navProgress.textContent = `${answered}/${total}`;
  }

  // =========================================================================
  // TIMER (countdown from server ac_end)
  // =========================================================================

  function _startTimer(assessment) {
    _stopTimer();

    let endMs = null;
    if (assessment.access_mode === 'scheduled' && assessment.ac_scheduled_end) {
      endMs = new Date(assessment.ac_scheduled_end).getTime();
    } else if (assessment.ac_end) {
      endMs = new Date(assessment.ac_end).getTime();
    }

    if (!endMs || isNaN(endMs)) {
      // Fallback: countdown from session.started_at + duration_minutes
      const startMs = state.session?.started_at
        ? new Date(state.session.started_at).getTime()
        : Date.now();
      const durMs = (assessment.duration_minutes || 90) * 60 * 1000;
      endMs = startMs + durMs;
      console.warn('[take] ac_end missing — falling back to duration_minutes');
    }

    const tick = () => {
      const sisa = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
      _updateTimerDisplay(sisa);

      // EDGE #18: unlock submit when sisa ≤ 600
      if (sisa <= SUBMIT_UNLOCK_SECONDS && state.submitLocked) {
        state.submitLocked = false;
        _updateSubmitLockState();
      }

      // EDGE #9 / #16: timer 0 → auto-submit (server handles 30s grace)
      if (sisa <= 0 && !state.isExpired && state.phase === 'exam') {
        state.isExpired = true;
        _stopTimer();
        _handleExpired();
      }
    };
    tick();
    state.timerInterval = setInterval(tick, 1000);
  }

  function _stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function _updateTimerDisplay(sisa) {
    const m = Math.floor(sisa / 60);
    const s = sisa % 60;
    dom.timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    dom.examTimer.classList.remove('warning', 'critical');
    if (sisa <= TIMER_CRITICAL_SECONDS) dom.examTimer.classList.add('critical');
    else if (sisa <= TIMER_WARNING_SECONDS) dom.examTimer.classList.add('warning');
  }

  function _updateSubmitLockState() {
    if (state.phase !== 'exam') return;
    const btn = dom.btnSubmit;
    if (state.submitLocked) {
      btn.disabled = true;
      btn.classList.add('nav-btn--submit-locked');
      const sisa = _getCurrentSisa();
      const mins = Math.max(0, Math.ceil((SUBMIT_UNLOCK_SECONDS - sisa) / 60));
      btn.title = `Submit terkunci. Buka dalam ${Math.max(1, mins)} menit (10 menit terakhir)`;
    } else {
      btn.disabled = false;
      btn.classList.remove('nav-btn--submit-locked');
      btn.title = 'Kumpulkan asesmen';
    }
  }

  function _getCurrentSisa() {
    // Re-compute current sisa for tooltip
    const assessment = state.assessment;
    let endMs = null;
    if (assessment?.access_mode === 'scheduled' && assessment.ac_scheduled_end) {
      endMs = new Date(assessment.ac_scheduled_end).getTime();
    } else if (assessment?.ac_end) {
      endMs = new Date(assessment.ac_end).getTime();
    }
    if (!endMs) return SUBMIT_UNLOCK_SECONDS + 1;
    return Math.max(0, Math.floor((endMs - Date.now()) / 1000));
  }

  // =========================================================================
  // SECURITY MODULES INTEGRATION
  // =========================================================================

  function _startSecurity() {
    // v1.0.0 Phase 5: Use AntiCheat orchestrator (coordinates all modules)
    if (window.AntiCheat?.start) {
      window.AntiCheat.start(state.session.id, {
        onViolation: (v) => {
          state.violations = window.AntiCheat.getTotalViolations();
          window.notify?.warning(
            `Peringatan ${state.violations}/4`,
            v.message || 'Pelanggaran terdeteksi',
            4000
          );
        },
        onMaxViolations: () => _handleMaxViolations(),
        onBlocked:  (reason) => _handleBlocked(reason),
        onSubmitted: () => _handleSubmitted(),
        onExpired:  () => _handleExpired(),
      });
    } else {
      // Fallback: individual modules (if AntiCheat not loaded)
      console.warn('[take-assessment] AntiCheat not available, using individual modules');

      if (window.Heartbeat?.start) {
        window.Heartbeat.start(state.session.id, {
          onBlocked:  (reason) => _handleBlocked(reason),
          onSubmitted: () => _handleSubmitted(),
          onExpired:  () => _handleExpired(),
        });
      }
      if (window.BlockListener?.start) {
        window.BlockListener.start(state.session.id, (reason) => _handleBlocked(reason));
      }
      if (window.ExamGuardian?.activate) {
        window.ExamGuardian.onViolation?.(({ pesan, ke, maks }) => {
          state.violations = ke;
          window.notify?.warning(`Peringatan ${ke}/${maks}`, pesan, 4000);
        });
        window.ExamGuardian.onMaxViolation?.(() => _handleMaxViolations());
        window.ExamGuardian.activate();
      }
    }
  }

  function _stopSecurity() {
    if (window.AntiCheat?.stop) {
      window.AntiCheat.stop();
    } else {
      window.Heartbeat?.stop?.();
      window.BlockListener?.stop?.();
      window.ExamGuardian?.deactivate?.();
    }
  }

  // v1.0.0 Phase 5: Pause anti-cheat during submit dialog (prevent false positive)
  function _pauseSecurity() {
    if (window.AntiCheat?.pause) {
      window.AntiCheat.pause();
    } else {
      window.ExamGuardian?.deactivate?.();
    }
  }

  function _resumeSecurity() {
    if (window.AntiCheat?.resume) {
      window.AntiCheat.resume();
    } else {
      window.ExamGuardian?.activate?.();
    }
  }

  // EDGE #14: 4 violations → reset + reshuffle (v1.0.0: combined Guardian + DevTools)
  async function _handleMaxViolations() {
    window.notify?.error('Pelanggaran Maksimal',
      'Soal akan diacak ulang. Jawaban sebelumnya direset.', 5000);

    // Stop security while we reset
    _stopSecurity();

    // Reset state
    state.jawaban = {};
    state.activePageIdx = 0;
    state.violations = 0;
    state.startTime = Date.now();
    state.submitLocked = true;

    // v1.0.0 Phase 5: Reset AntiCheat violation counts
    if (window.AntiCheat?.reset) {
      window.AntiCheat.reset();
    }

    // Clear local draft (old answers don't apply to new shuffle)
    _clearLocalDraft();

    // Update server with reset
    try {
      const db = window.firebaseDb;
      if (db) {
        await db.collection('assessment_sessions').doc(state.session.id).update({
          draft_answers: {},
          violation_count: 0,
          current_section: 0,
          current_question: 0,
          progress_pct: 0,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[take] reset sync failed:', err);
    }

    // Re-shuffle with new seed (mix in Date.now() to ensure different order)
    const newSeed = ((_computeSeed(state.session) ^ Date.now()) >>> 0);
    state.sessionNonce = newSeed;
    state.shuffledPages = _shufflePages(state.soalPages, newSeed);

    // Restart exam with new shuffle
    _renderPageTabs();
    _renderQuestion(0);
    _updateProgress();
    _updateSubmitLockState();
    _startSecurity();
  }

  // =========================================================================
  // BLOCKED / SUBMITTED / EXPIRED HANDLERS
  // =========================================================================

  function _handleBlocked(reason) {
    if (state._redirected) return;
    state._redirected = true;
    _stopSecurity();
    _stopTimer();
    const reasonEnc = encodeURIComponent(reason || 'Diblokir oleh admin');
    window.location.replace(`blocked.html?reason=${reasonEnc}`);
  }

  function _handleSubmitted() {
    if (state._redirected) return;
    state._redirected = true;
    _stopSecurity();
    _stopTimer();
    window.location.replace('submitted.html');
  }

  // EDGE #9 / #16: timer expired → auto-submit (server allows 30s grace)
  function _handleExpired() {
    if (state.isSubmitting || state.phase === 'result') return;
    window.notify?.warning('Waktu Habis',
      'Waktu asesmen telah berakhir. Jawaban akan dikumpulkan otomatis.', 3000);
    // Don't confirm — just submit
    _submitExam({ skipConfirm: true, isAuto: true });
  }

  // =========================================================================
  // SUBMIT FLOW
  // =========================================================================

  async function _submitExam(opts = {}) {
    const skipConfirm = opts.skipConfirm === true;
    const isAuto = opts.isAuto === true;

    // EDGE #8: double-click submit → idempotent
    if (state.isSubmitting) return;
    if (state.phase === 'result') return;

    // EDGE #18: still locked?
    if (state.submitLocked && !isAuto) {
      const sisa = _getCurrentSisa();
      const mins = Math.max(1, Math.ceil((SUBMIT_UNLOCK_SECONDS - sisa) / 60));
      window.notify?.info('Submit Terkunci',
        `Submit terbuka dalam ${mins} menit (10 menit terakhir).`);
      return;
    }

    // Confirm (unless auto-submit on expiry)
    if (!skipConfirm) {
      const confirmed = await _confirmSubmit();
      if (!confirmed) return;
    }

    state.isSubmitting = true;
    state.endTime = Date.now();

    // v1.0.0 Phase 5: Pause anti-cheat before submit (prevent false positive during dialog/redirect)
    _pauseSecurity();

    // Stop heartbeat (we'll do final submit directly)
    window.Heartbeat?.stop?.();

    // Flush pending draft sync
    if (state._draftSyncTimer) {
      clearTimeout(state._draftSyncTimer);
      state._draftSyncTimer = null;
    }
    _saveLocalDraft();

    // Build answers payload (server format: { section_N: { idq: answer } })
    const answers = _buildAnswersPayload();
    const duration_seconds = state.startTime
      ? Math.floor((state.endTime - state.startTime) / 1000)
      : 0;

    // Submit with retry (EDGE #6, #7: network fail → retry, don't lose answers)
    let attempts = 0;
    while (attempts < SUBMIT_MAX_RETRIES) {
      try {
        const user = window.firebaseAuth?.currentUser;
        if (!user) throw new Error('Not authenticated');
        const token = await user.getIdToken();

        const res = await fetch('https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/submit-assessment', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            session_id: state.session.id,
            answers,
            duration_seconds,
            violation_count: state.violations,
          }),
        });

        if (!res.ok) {
          let errBody = {};
          try { errBody = await res.json(); } catch (_) {}
          const code = errBody.code || '';
          const msg = errBody.message || `HTTP ${res.status}`;

          // EDGE #15: blocked mid-submit
          if (res.status === 409 && code === 'SESSION_BLOCKED') {
            state.isSubmitting = false;
            _handleBlocked(msg);
            return;
          }
          // Idempotent: already submitted → render result
          if (res.status === 200 && errBody?.data?.idempotent) {
            _renderResult(errBody.data);
            _clearLocalDraft();
            state.phase = 'result';
            state.isSubmitting = false;
            return;
          }
          // 429 rate limited → wait longer
          if (res.status === 429) {
            throw new Error('Terlalu banyak percobaan. Tunggu sebentar.');
          }
          throw new Error(msg);
        }

        const data = await res.json();
        const result = data.data || data;

        // Render result phase
        _renderResult(result);
        _clearLocalDraft();
        state.phase = 'result';
        state.isSubmitting = false;
        return;
      } catch (err) {
        attempts++;
        console.warn(`[take] submit attempt ${attempts} failed:`, err);

        if (attempts >= SUBMIT_MAX_RETRIES) {
          // EDGE #6/#7: show retry UI, don't lose answers
          state.isSubmitting = false;
          _resumeSecurity(); // v1.0.0 Phase 5: re-enable anti-cheat
          window.Heartbeat?.start?.(state.session.id, {
            onBlocked: (r) => _handleBlocked(r),
            onSubmitted: () => _handleSubmitted(),
            onExpired: () => _handleExpired(),
          });
          _showSubmitRetryError(err);
          return;
        }
        // Wait with backoff
        await new Promise(r => setTimeout(r, SUBMIT_RETRY_BASE_MS * attempts));
      }
    }
  }

  function _confirmSubmit() {
    return new Promise((resolve) => {
      // Hold-to-confirm: button requires 2s hold (spec: "confirm dialog (hold 2s)")
      // We'll use QNotify confirm dialog instead for accessibility.
      if (window.notify?.confirm) {
        window.notify.confirm({
          title: 'Kumpulkan Asesmen?',
          message: 'Pastikan semua jawaban sudah terisi. Anda tidak bisa mengubah jawaban setelah dikumpulkan.',
          intent: 'primary',
          confirmText: 'Ya, Kumpulkan',
          cancelText: 'Batal',
          onYes: () => resolve(true),
          onNo: () => resolve(false),
          onClose: () => resolve(false),
        });
      } else {
        resolve(confirm('Kumpulkan asesmen? Tindakan ini tidak dapat dibatalkan.'));
      }
    });
  }

  function _buildAnswersPayload() {
    // Convert flat jawaban { "section_0__1": "A" } → server format { "section_0": { "1": "A" } }
    const out = {};
    state.soalPages.forEach(page => {
      const pageKey = page.pageKey;
      out[pageKey] = {};
      page.questions.forEach(q => {
        const ans = state.jawaban[`${pageKey}__${q.idq}`];
        if (ans !== undefined && ans !== null && ans !== '') {
          out[pageKey][String(q.idq)] = ans;
        }
      });
    });
    return out;
  }

  function _showSubmitRetryError(err) {
    if (window.notify?.error) {
      window.notify.error('Gagal Mengumpulkan',
        `${err.message || 'Kesalahan jaringan'}. Jawaban Anda tetap tersimpan. Coba lagi dengan tombol Kumpulkan.`, 8000);
    }
    // Re-enable submit button so peserta can retry
    if (dom.btnSubmit) {
      dom.btnSubmit.disabled = false;
      dom.btnSubmit.classList.remove('nav-btn--submit-locked');
    }
  }

  // =========================================================================
  // RESULT RENDER
  // =========================================================================

  function _renderResult(result) {
    _stopSecurity();
    _stopTimer();
    window.removeEventListener('beforeunload', _beforeUnloadGuard);
    window.removeEventListener('popstate', _popstateTrap);

    _setPhase('result');

    const score = result.score ?? 0;
    const maxScore = result.max_score ?? 100;
    const correct = result.correct_count ?? 0;
    const total = result.total_count ?? 0;
    const wrong = total - correct - _countEmpty();
    const empty = _countEmpty();
    const durSec = result.duration_seconds ?? 0;

    document.getElementById('result-score').textContent = score;
    document.getElementById('result-score-max').textContent = `/${maxScore}`;

    // Stats
    const stats = document.getElementById('result-stats');
    stats.innerHTML = `
      <div class="result-stat result-stat--benar">
        <div class="result-stat__num">${correct}</div>
        <div class="result-stat__label">Benar</div>
      </div>
      <div class="result-stat result-stat--salah">
        <div class="result-stat__num">${Math.max(0, total - correct - empty)}</div>
        <div class="result-stat__label">Salah</div>
      </div>
      <div class="result-stat result-stat--kosong">
        <div class="result-stat__num">${empty}</div>
        <div class="result-stat__label">Kosong</div>
      </div>
      <div class="result-stat">
        <div class="result-stat__num">${_formatDuration(durSec)}</div>
        <div class="result-stat__label">Durasi</div>
      </div>
    `;

    // Detail per section
    const detailEl = document.getElementById('result-detail');
    const gradingDetail = Array.isArray(result.grading_detail) ? result.grading_detail : [];

    // Group by section
    const bySection = {};
    gradingDetail.forEach(item => {
      const key = `section_${item.section_idx}`;
      if (!bySection[key]) bySection[key] = { name: item.section_name || `Bagian ${item.section_idx + 1}`, items: [] };
      bySection[key].items.push(item);
    });

    // Fallback: if no grading_detail (e.g. idempotent response), build from local state
    if (gradingDetail.length === 0) {
      state.soalPages.forEach((page, idx) => {
        const key = page.pageKey;
        bySection[key] = { name: page.label, items: page.questions.map(q => ({
          section_idx: idx,
          section_name: page.label,
          idq: q.idq,
          type: page.typeQuestion,
          peserta_answer: state.jawaban[`${key}__${q.idq}`] || null,
          jawaban_benar: q.jawaban_benar || null,
          is_correct: false,
          status: 'kosong',
          points: 0,
          max_points: q.skor || 0,
        })) };
      });
    }

    detailEl.innerHTML = Object.values(bySection).map(sec => `
      <div class="result-section">
        <h2 class="result-section__title">${_escAttr(sec.name)}</h2>
        ${sec.items.map((item, i) => _renderResultItem(item, i)).join('')}
      </div>
    `).join('');

    // Wire back-to-login button
    const backBtn = document.getElementById('btn-back-login');
    if (backBtn) {
      backBtn.onclick = () => {
        // Logout peserta → redirect to login
        if (window.Auth?.authLogout) {
          window.Auth.authLogout({ skipConfirm: true });
        } else {
          window.location.href = '../login.html';
        }
      };
    }

    // Render math in detail
    _renderMath(detailEl);
  }

  function _renderResultItem(item, idx) {
    const status = item.status || (item.is_correct ? 'benar' : 'salah');
    const statusLabel = { benar: 'Benar', salah: 'Salah', kosong: 'Kosong' }[status] || status;
    const q = _findQuestion(item.section_idx, item.idq);
    const qText = q ? _sanitizeHTML(q.pertanyaan || '') : `(soal ${item.idq})`;

    let metaHTML = '';
    if (item.type === 'PG') {
      metaHTML = `
        <div><strong>Jawaban Anda:</strong> ${item.peserta_answer ? _escAttr(item.peserta_answer) : '<em>(kosong)</em>'}</div>
        <div><strong>Kunci:</strong> ${item.jawaban_benar ? _escAttr(item.jawaban_benar) : '<em>(esai)</em>'}</div>
      `;
    } else {
      metaHTML = `
        <div><strong>Jawaban Anda:</strong> ${item.peserta_answer ? _escAttr(String(item.peserta_answer).slice(0, 200)) : '<em>(kosong)</em>'}</div>
        <div><em>Esai dinilai manual oleh guru</em></div>
      `;
    }

    return `
      <div class="result-item">
        <div class="result-item__head">
          <span class="result-item__num">${idx + 1}</span>
          <span class="result-item__status ${status}">${statusLabel}</span>
        </div>
        <div class="result-item__q">${qText}</div>
        <div class="result-item__meta">${metaHTML}</div>
      </div>
    `;
  }

  function _findQuestion(sectionIdx, idq) {
    const page = state.soalPages[sectionIdx];
    if (!page) return null;
    return page.questions.find(q => q.idq === idq) || null;
  }

  function _countEmpty() {
    let total = 0, answered = 0;
    state.soalPages.forEach(p => {
      p.questions.forEach(q => {
        total++;
        if (state.jawaban[`${p.pageKey}__${q.idq}`]) answered++;
      });
    });
    return total - answered;
  }

  function _formatDuration(sec) {
    if (!sec || sec < 0) return '0m';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}j ${m % 60}m`;
    }
    return `${m}m ${s}s`;
  }

  // =========================================================================
  // SHUFFLE (mulberry32 PRNG — stable per session)
  // =========================================================================

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function _shuffleFisherYates(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Seed: stable per session (uses server-set started_at + session.id hash)
  // → survives refresh (same session) AND cross-device resume (same session)
  function _computeSeed(session) {
    if (!session) return (Date.now() >>> 0);
    const startedAt = session.started_at ? new Date(session.started_at).getTime() : 0;
    const idHash = String(session.id || '').split('').reduce((acc, c) =>
      (acc * 31 + c.charCodeAt(0)) | 0, 0);
    return ((startedAt ^ idHash) >>> 0);
  }

  function _shufflePages(pages, seed) {
    const rng = mulberry32(seed);
    const out = {};
    pages.forEach(({ pageKey, questions }) => {
      // Shuffle question ORDER only — pilihan A/B/C/D tidak disentuh
      out[pageKey] = _shuffleFisherYates(questions, rng);
    });
    return out;
  }

  // =========================================================================
  // PARSE SECTIONS → soalPages
  // =========================================================================

  function _parseSections(sections) {
    if (!Array.isArray(sections)) return [];
    return sections.map((sec, idx) => {
      const pageKey = `section_${idx}`;
      const questions = Array.isArray(sec.questions) ? sec.questions : [];
      return {
        pageKey,
        label: sec.name || `Bagian ${idx + 1}`,
        typeQuestion: sec.type_question || 'PG',
        questions,
      };
    }).filter(p => p.questions.length > 0);
  }

  // =========================================================================
  // GLOBAL EVENT HANDLERS
  // =========================================================================

  function _wireGlobalEvents() {
    // Online/offline (EDGE #4, #5)
    window.addEventListener('online', () => {
      window.notify?.success('Kembali Online', 'Menyinkronkan jawaban...');
      window.Heartbeat?.syncNow?.();
    });
    window.addEventListener('offline', () => {
      window.notify?.warning('Offline', 'Jawaban disimpan lokal. Akan disinkronkan saat online.');
    });

    // Keyboard shortcuts (accessibility)
    document.addEventListener('keydown', (e) => {
      if (state.phase !== 'exam') return;
      // Alt+Left / Alt+Right for nav
      if (e.altKey && e.key === 'ArrowLeft' && !dom.btnPrev.disabled) {
        e.preventDefault();
        dom.btnPrev.click();
      } else if (e.altKey && e.key === 'ArrowRight' && !dom.btnNext.disabled) {
        e.preventDefault();
        dom.btnNext.click();
      }
    });

    // Page visibility — Heartbeat handles online/offline; ExamGuardian handles tab-switch violation
  }

  function _beforeUnloadGuard(e) {
    // EDGE #2: flush pending draft save before close
    if (state._draftSyncTimer) {
      clearTimeout(state._draftSyncTimer);
      state._draftSyncTimer = null;
      _saveLocalDraft();
    }
    if (state.phase === 'exam') {
      // Best-effort sync (may not complete — that's why Heartbeat runs every 15s)
      try { window.Heartbeat?.syncNow?.(); } catch (_) {}
      e.preventDefault();
      e.returnValue = 'Asesmen belum selesai. Yakin ingin meninggalkan halaman?';
      return e.returnValue;
    }
  }

  function _popstateTrap(e) {
    if (state.phase === 'exam') {
      history.pushState({ albEduExamActive: true }, '', location.href);
      window.notify?.warning('Tidak Dapat Kembali',
        'Selesaikan atau kumpulkan asesmen terlebih dahulu.', 3000);
    }
  }

  // =========================================================================
  // MATH RENDER (KaTeX)
  // =========================================================================

  function _renderMath(container) {
    try {
      if (typeof window.renderMathIn === 'function') {
        window.renderMathIn(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      } else if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(container);
      }
    } catch (err) {
      console.warn('[take] math render failed:', err);
    }
  }

  // =========================================================================
  // BOOT
  // =========================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TakeAssessment.init());
  } else {
    TakeAssessment.init();
  }
})();
