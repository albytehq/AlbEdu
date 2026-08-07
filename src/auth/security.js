// auth/security.js — AlbEdu Security Core (HTML sanitizer, attr escaper,
// safe DOM writer, global error handler).
//
// Load this after supabase-client.js and before other UI code. Everything
// else just calls window.Security.*.

(function (global) {
    'use strict';

    // HTML Sanitizer
    // Guru boleh pakai formatting dasar di soal (bold, italic, list). Tanpa
    // sanitasi, <img src=x onerror=alert(1)> akan jalan di browser peserta.
    //
    // Strategy: DOMPurify if available (stricter, more aggressive allowlist) → regex
    // fallback otherwise.
    //
    // WHY regex fallback and not parse-DOM? Because parsing untrusted HTML
    // into a temp element can itself trigger scripts in some browsers. Regex
    // is safer here.
    const ALLOWED_TAGS  = new Set(['b','i','em','strong','br','p','ul','ol','li','span','sub','sup','u','s']);
    const ALLOWED_ATTRS = new Set(['class','style']);

    // Strip event handlers, javascript: URLs, and dangerous tags. Already
    // used by ExamViewer.js — unified here so every file shares the same
    // implementation instead of each carrying its own version.
    function _sanitizeFallback(html) {
        return String(html ?? '')
            .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
            .replace(/(?:href|src|action)\s*=\s*(?:"[^"]*(?:javascript|data):[^"]*"|'[^']*(?:javascript|data):[^']*')/gi, '')
            .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*>[\s\S]*?<\/(?:script|iframe|object|embed|style|link)>/gi, '')
            .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*\/?>/gi, '')
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (match, tag) => {
                if (!ALLOWED_TAGS.has(tag.toLowerCase())) return '';
                const safe = match.replace(/\s+(\w[\w-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g, (attr, name) => {
                    return ALLOWED_ATTRS.has(name.toLowerCase()) ? attr : '';
                });
                return safe;
            });
    }

    const sanitizeHTML = (typeof DOMPurify !== 'undefined')
        ? (html) => DOMPurify.sanitize(html, {
            ALLOWED_TAGS:    [...ALLOWED_TAGS],
            ALLOWED_ATTR:    [...ALLOWED_ATTRS],
            ALLOW_DATA_ATTR: false,
            FORCE_BODY:      false,
        })
        : _sanitizeFallback;

    // Attribute Escaper
    // For values that go into href="", data-x="", or any HTML where NO markup
    // should survive (names, IDs, classes).
    function escapeAttr(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeText(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Safe DOM Writer
    // Replacements for raw innerHTML. Use these instead.
    //   Security.setHTML(el, untrustedString)  ← sanitize first
    //   Security.setText(el, untrustedString)  ← textContent, zero XSS risk
    //   Security.setAttr(el, attrName, value)  ← escape attribute value
    function setHTML(element, html) {
        if (!element) return;
        element.innerHTML = sanitizeHTML(html);
    }

    function setText(element, text) {
        if (!element) return;
        element.textContent = String(text ?? '');
    }

    function setAttr(element, attrName, value) {
        if (!element) return;
        element.setAttribute(attrName, escapeAttr(value));
    }

    // Global Error Handler
    // Catch all uncaught errors and unhandled promise rejections. In
    // production this is a safety net — no error should vanish without a
    // trace. Logs to console in dev; can be wired to a monitoring service
    // (Sentry, etc.) without touching other files.
    //
    // WHY not surface to the user? Most uncaught errors come from browser
    // extensions or third-party scripts we don't control. We log them but
    // don't spam users with alerts about things that aren't their fault.
    const _errorLog = [];
    const MAX_ERROR_LOG = 50; // cegah memory leak kalau error storm terjadi

    function _recordError(type, message, source) {
        if (_errorLog.length >= MAX_ERROR_LOG) _errorLog.shift();
        _errorLog.push({ type, message, source, ts: Date.now() });
    }

    function _handleUncaughtError(event) {
        const msg    = event.message || 'Unknown error';
        const source = event.filename ? `${event.filename}:${event.lineno}` : 'unknown';

        _recordError('uncaught', msg, source);

        // Don't log errors from browser extensions (they have weird paths).
        if (event.filename && (
            event.filename.includes('extension://') ||
            event.filename.includes('moz-extension://')
        )) return;

        const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (isDev) {
            // eslint-disable-next-line no-console
            console.error('[Security] Uncaught error:', msg, 'at', source);
        }
    }

    function _handleUnhandledRejection(event) {
        const reason = event.reason;
        const msg    = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');

        _recordError('unhandledRejection', msg, 'promise');

        const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (isDev) {
            // eslint-disable-next-line no-console
            console.error('[Security] Unhandled rejection:', msg);
        }

        // Don't call event.preventDefault() — hiding errors from the console
        // makes debugging hell.
    }

    global.addEventListener('error',               _handleUncaughtError);
    global.addEventListener('unhandledrejection',  _handleUnhandledRejection);

    // ViolationStore (Firestore-backed anti-tamper violation tracker) was
    // removed. It referenced global.firebaseDb which no longer exists
    // post-Supabase migration, so every method was a silent no-op.
    // AntiCheat / Heartbeat now own all violation reporting via Edge
    // Functions + the violation_events table — see src/security/anti-cheat.js
    // and src/security/heartbeat.js. No callers in the codebase referenced
    // ViolationStore, so removal is safe.

    global.Security = {
        sanitizeHTML,
        escapeAttr,
        escapeText,
        setHTML,
        setText,
        setAttr,

        // For debugging — see recent errors without opening DevTools.
        getErrorLog: () => [..._errorLog],
    };

})(window);
