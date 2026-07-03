// =============================================================================
// take-assessment/utils.js — Pure utilities for the assessment runtime
// =============================================================================
// Part of the take-assessment split (see README.md in this directory).
//
// This file contains ONLY pure functions — no state/dom access, no side effects.
// They access shared state via window.TakeAssessment._internal when needed
// (constants only).
//
// Load order: MUST load before take-assessment.js (the orchestrator).
// =============================================================================

(function () {
  'use strict';

  const _internal = window.TakeAssessment = window.TakeAssessment || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;

  // ── HTML Sanitizer (subset of ExamViewer.sanitize) ──────────────────────
  function _sanitizeHTML(html) {
    if (html == null) return '';
    const str = String(html);
    const SANITIZE_ALLOWED_TAGS = I.constants.SANITIZE_ALLOWED_TAGS || [
      'b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li',
      'span', 'sub', 'sup', 'u', 's', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'mark', 'br'
    ];
    if (typeof window.DOMPurify !== 'undefined') {
      try {
        return window.DOMPurify.sanitize(str, {
          ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS,
          ALLOWED_ATTR: ['class', 'style', 'lang', 'dir'],
          ALLOW_DATA_ATTR: false,
        });
      } catch (_) { /* fall through */ }
    }
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

  function _getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function _t(key, fallback) {
    if (typeof I.t === 'function') return I.t(key, null, fallback);
    if (typeof window.t === 'function') {
      const v = window.t(key);
      return v === key ? (fallback || key) : v;
    }
    return fallback || key;
  }

  // ── Waiters ─────────────────────────────────────────────────────────────
  function _waitForAuth() {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        if (window.AlbEdu?.supabase?.auth?.currentUser) return resolve();
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
      if (window.QNotify || window.AlbEdu?.notify) return resolve();
      let elapsed = 0;
      const tick = 100;
      const id = setInterval(() => {
        elapsed += tick;
        if (window.QNotify || window.AlbEdu?.notify || elapsed >= maxMs) {
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

  // ── Shuffle (mulberry32 PRNG — stable per session) ──────────────────────
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
      out[pageKey] = _shuffleFisherYates(questions, rng);
    });
    return out;
  }

  // ── Parse sections → soalPages ──────────────────────────────────────────
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

  // ── Misc helpers ────────────────────────────────────────────────────────
  function _formatDuration(sec) {
    if (sec == null || sec < 0) return '-';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}j ${m % 60}m`;
    return `${m}m ${s}s`;
  }

  function _findQuestion(sectionIdx, idq) {
    const page = I.state.soalPages?.[sectionIdx];
    if (!page) return null;
    return page.questions.find(q => String(q.idq) === String(idq)) || null;
  }

  function _countEmpty() {
    let empty = 0;
    I.state.soalPages?.forEach((page) => {
      page.questions.forEach((q) => {
        const key = `${page.pageKey}__${q.idq}`;
        const ans = I.state.jawaban?.[key];
        if (ans == null || ans === '') empty++;
      });
    });
    return empty;
  }

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

  // ── Expose all utilities on the namespace ───────────────────────────────
  Object.assign(_internal, {
    _sanitizeHTML,
    _escAttr,
    _getUrlParam,
    _t,
    _waitForAuth,
    _waitForQNotify,
    _waitForThemeSystem,
    mulberry32,
    _shuffleFisherYates,
    _computeSeed,
    _shufflePages,
    _parseSections,
    _formatDuration,
    _findQuestion,
    _countEmpty,
    _renderMath,
  });
})();
