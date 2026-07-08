// take-assessment.js — slim orchestrator for the peserta assessment runtime.
//
// The actual logic lives in 5 split modules under src/pages/take-assessment/:
//   utils.js     — pure utilities (sanitizers, waiters, shuffle, parse)
//   fetch.js     — data fetch + access check + theme
//   identity.js  — identity form phase
//   exam.js      — exam runtime (rendering, answers, timer, security, lifecycle)
//   submit.js    — submit flow + result rendering
//
// This file defines the shared `_internal` namespace (state/dom/constants/t),
// the public `init()` boot sequence, the phase/loading helpers, and the
// `window.ExamLogic` shim used by Heartbeat.js. It MUST load last.

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const constants = {
    SUBMIT_UNLOCK_SECONDS: 600,
    TIMER_WARNING_SECONDS: 300,
    TIMER_CRITICAL_SECONDS: 60,
    DRAFT_SYNC_DEBOUNCE_MS: 800,
    SUBMIT_MAX_RETRIES: 3,
    SUBMIT_RETRY_BASE_MS: 1500,
    SANITIZE_ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li',
      'span', 'sub', 'sup', 'u', 's', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'mark', 'br'],
  };

  const state = {
    phase: 'loading',
    assessment: null,
    session: null,
    identity: null,
    soalPages: [],
    shuffledPages: {},
    activePageIdx: 0,
    jawaban: {},
    violations: 0,
    startTime: null,
    endTime: null,
    timerInterval: null,
    submitLocked: true,
    isSubmitting: false,
    isExpired: false,
    sessionNonce: null,
    _draftSyncTimer: null,
    _redirected: false,
  };

  // Populated by _cacheDOM.
  const dom = {};

  // The split modules created window.TakeAssessment and added their functions.
  // We attach _internal (state/dom/constants/t) + the orchestrator functions here.
  const TakeAssessment = window.TakeAssessment || {};
  window.TakeAssessment = TakeAssessment;
  TakeAssessment._internal = { state, dom, constants, t };

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
    const iconHolder = dom.closedIcon.querySelector('[data-albedu-icon]');
    if (iconHolder) {
      const iconName = kind === 'danger' ? 'error' : kind === 'success' ? 'task-alt' : 'lock';
      window.AlbEdu?.setIcon?.(iconHolder, iconName);
    }
    _setPhase('closed');
  }

  Object.assign(TakeAssessment, {
    _setPhase,
    _setLoadingStatus,
    _setLoadingTitle,
    _showClosed,

    async init() {
      _cacheDOM();

      _setLoadingStatus(t('assessment.loading_auth', null, 'Memuat autentikasi...'));

      // Wait for auth + notify (parallel)
      await Promise.all([
        TakeAssessment._waitForAuth(),
        TakeAssessment._waitForQNotify(3000),
      ]);

      // UU PDP consent gate
      _setLoadingStatus(t('assessment.loading_consent', null, 'Memeriksa persetujuan...'));
      try {
        const consentOk = await window.Consent?.check?.();
        if (consentOk === false) return;
      } catch (err) {
        console.warn('[take] consent check failed (fail-safe):', err);
      }

      const token = TakeAssessment._getUrlParam('token') || sessionStorage.getItem('assessment_token');
      const sessionId = sessionStorage.getItem('assessment_session_id');

      if (!token || !sessionId) {
        _showClosed(
          t('assessment.closed_no_session_title', null, 'Token atau sesi tidak ditemukan.'),
          t('assessment.closed_no_session_msg', null, 'Silakan masuk kembali melalui halaman asesmen.'),
          'danger'
        );
        return;
      }

      _setLoadingStatus(t('assessment.loading_assessment', null, 'Mengambil data asesmen...'));

      const assessment = await TakeAssessment._fetchAssessment(token);
      if (!assessment) {
        _showClosed(
          t('assessment.closed_invalid_token_title', null, 'Kode akses tidak valid.'),
          t('assessment.closed_invalid_token_msg', null, 'Asesmen tidak ditemukan atau telah diarsipkan.'),
          'danger'
        );
        return;
      }
      state.assessment = assessment;

      TakeAssessment._applyTheme(assessment.theme_config);

      _setLoadingStatus(t('assessment.loading_starting', null, 'Memulihkan sesi...'));
      const session = await TakeAssessment._fetchSession(sessionId);
      if (!session) {
        _showClosed(
          t('assessment.closed_no_session_title', null, 'Sesi tidak ditemukan.'),
          t('assessment.closed_session_ended_msg', null, 'Sesi telah kedaluwarsa. Silakan masuk kembali.'),
          'danger'
        );
        return;
      }
      state.session = session;

      if (session.status === 'blocked') {
        TakeAssessment._handleBlocked(session.blocked_reason || 'Diblokir oleh admin');
        return;
      }

      if (session.status === 'submitted') {
        TakeAssessment._handleSubmitted();
        return;
      }

      TakeAssessment._restoreDraft(session);

      const access = TakeAssessment._checkAccess(assessment);
      if (!access.allowed) {
        _showClosed(
          access.title || t('assessment.closed_default_title', null, 'Asesmen Tidak Tersedia'),
          access.message,
          access.kind || 'warning'
        );
        return;
      }

      state.soalPages = TakeAssessment._parseSections(assessment.sections || []);

      if (state.soalPages.length === 0) {
        _showClosed(
          t('assessment.closed_no_questions_title', null, 'Soal tidak tersedia.'),
          t('assessment.closed_no_questions_msg', null, 'Asesmen ini belum memiliki soal. Hubungi admin.'),
          'danger'
        );
        return;
      }

      if (state.identity && state.identity._display_name) {
        TakeAssessment._startExam(state.identity, { isResume: true });
      } else {
        TakeAssessment._renderIdentity(assessment);
      }

      TakeAssessment._wireGlobalEvents();
    },

    // Exposed for Heartbeat.js (it reads window.ExamLogic.getState).
    _ExamLogicCompat: {
      getState: () => ({
        jawaban: { ...state.jawaban },
        activePageIdx: state.activePageIdx,
        soalPages: state.soalPages,
        violations: state.violations,
      }),
    },
  });

  // Heartbeat.js shim
  window.ExamLogic = TakeAssessment._ExamLogicCompat;
  if (typeof ExamGuardian !== 'undefined' && !window.ExamGuardian) {
    window.ExamGuardian = ExamGuardian;
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TakeAssessment.init());
  } else {
    TakeAssessment.init();
  }
})();
