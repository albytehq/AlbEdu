// =============================================================================
// question-bank.js — Orchestrator for the Question Bank admin page
// =============================================================================
// This is the SLIM orchestrator. The actual logic lives in 5 split modules
// under src/pages/question-bank/:
//
//   utils.js   — pure utilities + auth waiters
//   data.js    — load, normalize, filter, delete, export
//   render.js  — DOM cache, event wiring, card rendering
//   modal.js   — create/edit modal (form, validation, save, delete confirm)
//   import.js  — JSON import + add-to-assessment stub
//
// This file defines:
//   1. window.QuestionBank._internal = { state, dom, constants, t }
//   2. The public init() method (boot sequence)
//   3. The public API: { init, refresh }
//
// Load order (in admin/question-bank.html):
//   <script defer src="../../src/pages/question-bank/utils.js"></script>
//   <script defer src="../../src/pages/question-bank/data.js"></script>
//   <script defer src="../../src/pages/question-bank/render.js"></script>
//   <script defer src="../../src/pages/question-bank/modal.js"></script>
//   <script defer src="../../src/pages/question-bank/import.js"></script>
//   <script defer src="../../src/pages/question-bank.js"></script>  ← THIS FILE (last)
// =============================================================================

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  // ── Constants ───────────────────────────────────────────────────────────
  const constants = {
    COLLECTION: 'question_bank',
    SEARCH_DEBOUNCE_MS: 240,
    HOLD_CONFIRM_MS: 2000,
    MIN_QUESTION_LEN: 3,
    VALID_TYPES: ['PG', 'esai'],
    VALID_DIFFICULTIES: ['easy', 'medium', 'hard'],
    OPTION_KEYS: ['A', 'B', 'C', 'D'],
    AUTH_WAIT_TIMEOUT_MS: 10_000,
    PRESET_SUBJECTS: [
      'Matematika', 'Bahasa Indonesia', 'Bahasa Inggris',
      'IPA Terpadu', 'IPS Terpadu', 'PPKn',
    ],
  };

  // ── Shared state ────────────────────────────────────────────────────────
  const state = {
    user: null,
    questions: [],
    filtered: [],
    subjects: [],
    tags: [],
    search: '',
    filterSubject: '',
    filterDifficulty: '',
    filterTags: [],
    editingId: null,
    modalOpen: false,
  };

  // ── DOM refs (populated by render.js _cacheDom) ─────────────────────────
  const dom = {};

  // ── Initialize the namespace ────────────────────────────────────────────
  const QuestionBank = window.QuestionBank || {};
  window.QuestionBank = QuestionBank;
  QuestionBank._internal = { state, dom, constants, t, _searchTimer: null, _tagFilterTimer: null };

  // ── Init (boot sequence) ────────────────────────────────────────────────
  async function init() {
    console.info('[QuestionBank] v1.0.0 init');
    QuestionBank._cacheDom();
    if (!dom.grid) {
      console.warn('[QuestionBank] required DOM (#qb-grid) missing — abort init');
      return;
    }
    QuestionBank._wireEvents();

    // Show empty state while we wait for auth
    dom.grid.hidden = true;
    dom.grid.innerHTML = '';
    if (dom.empty)     dom.empty.hidden = false;
    if (dom.noResults) dom.noResults.hidden = true;

    const ok = await QuestionBank._waitForPlatform(constants.AUTH_WAIT_TIMEOUT_MS);
    if (!ok) {
      if (window.notify && window.notify.error) {
        window.notify.error('Koneksi Gagal', 'Tidak dapat terhubung ke server. Coba muat ulang halaman.');
      }
      return;
    }

    const user = await QuestionBank._waitForAuth(constants.AUTH_WAIT_TIMEOUT_MS);
    if (!user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Sesi Habis', 'Silakan login kembali untuk mengakses bank soal.');
      }
      return;
    }
    state.user = user;

    await QuestionBank._loadQuestions();
  }

  // ── Public API ──────────────────────────────────────────────────────────
  QuestionBank.init = init;
  QuestionBank.refresh = () => QuestionBank._loadQuestions();

  // ── Boot ────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
