// =============================================================================
// question-bank/utils.js — Pure utilities + auth waiters
// =============================================================================
// Part of the question-bank split. Pure functions + auth/platform waiters.
// No state/dom access (except constants via _internal).
// Load order: MUST load before question-bank.js (the orchestrator).
// =============================================================================

(function () {
  'use strict';

  const _internal = window.QuestionBank = window.QuestionBank || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;

  // ── i18n helper ─────────────────────────────────────────────────────────
  function _t(key, params) {
    try {
      if (window.i18n && typeof window.i18n.t === 'function') {
        const result = window.i18n.t(key, params);
        return result !== undefined ? result : key;
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
    return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  }

  function _normalizeType(t) {
    if (!t) return '';
    const lower = String(t).toLowerCase();
    const VALID_TYPES = I.constants.VALID_TYPES || ['PG', 'esai'];
    if (lower === 'pg' || lower === 'pilihan ganda') return 'PG';
    if (lower === 'esai' || lower === 'essay' || lower === 'esei') return 'esai';
    return VALID_TYPES.includes(t) ? t : '';
  }

  function _normalizeDifficulty(d) {
    if (!d) return null;
    const lower = String(d).toLowerCase();
    const VALID_DIFFICULTIES = I.constants.VALID_DIFFICULTIES || ['easy', 'medium', 'hard'];
    return VALID_DIFFICULTIES.includes(lower) ? lower : null;
  }

  function _normalizePilihan(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const OPTION_KEYS = I.constants.OPTION_KEYS || ['A', 'B', 'C', 'D'];
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
    const OPTION_KEYS = I.constants.OPTION_KEYS || ['A', 'B', 'C', 'D'];
    return OPTION_KEYS.includes(upper) ? upper : null;
  }

  // ── Platform + Auth waiters ─────────────────────────────────────────────
  async function _waitForPlatform(timeout) {
    if (window.AlbEdu?.supabase?.isReady?.()) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(false); }, timeout);
      function cleanup() {
        clearTimeout(t);
        document.removeEventListener('albedu:platform-ready', onReady);
        document.removeEventListener('albedu:platform-error', onError);
      }
      function onReady() { cleanup(); resolve(true); }
      function onError() { cleanup(); resolve(false); }
      document.addEventListener('albedu:platform-ready', onReady, { once: true });
      document.addEventListener('albedu:platform-error', onError, { once: true });
    });
  }

  async function _waitForAuth(timeout) {
    const auth = window.AlbEdu?.supabase?.auth;
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
        unsub = auth && typeof auth.onAuthStateChange === 'function'
          ? auth.onAuthStateChange((u) => { if (u) done(u); })
          : null;
      } catch (_) { /* noop */ }

      poll = setInterval(() => {
        if (window.AlbEdu?.supabase?.auth?.currentUser) {
          done(window.AlbEdu.supabase.auth.currentUser);
        }
      }, 200);
    });
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _t, _esc, _truncate, _uuid,
    _parseTags, _normalizeType, _normalizeDifficulty,
    _normalizePilihan, _normalizeJawaban,
    _waitForPlatform, _waitForAuth,
  });
})();
