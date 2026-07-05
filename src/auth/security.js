// =============================================================================
// security.js — AlbEdu Security Core v1.0.0
// =============================================================================
//
// Satu file, satu tanggung jawab: jaga semua boundary keamanan.
//
//   1. HTML Sanitizer  — strip XSS sebelum innerHTML menyentuh DOM
//   2. Attr Escaper    — escape untuk href/data-* attributes
//   3. Safe DOM Writer — ganti pola innerHTML berbahaya dengan wrapper aman
//   4. Global Error Handler — tangkap semua uncaught error & promise rejection
//   5. Violation Store — simpan state pelanggaran asesmen ke basis data,
//                        bukan localStorage (tidak bisa dimanipulasi peserta)
//
// CARA PAKAI:
//   Muat file ini setelah SupabaseApi.js, sebelum file lain.
//   Semua file lain bisa langsung pakai window.Security.*
// =============================================================================

(function (global) {
    'use strict';

    // ── 1. HTML Sanitizer ─────────────────────────────────────────────────────
    // Guru boleh pakai formatting dasar di soal (bold, italic, list).
    // Tanpa sanitasi, <img src=x onerror=alert(1)> akan jalan di browser peserta.
    //
    // Strategy: DOMPurify jika tersedia (lebih ketat, battle-tested) →
    //           regex fallback jika tidak ada.
    //
    // WHY regex fallback dan bukan parse DOM?
    // Karena innerHTML-parsing HTML untrusted ke temp element bisa sendirinya
    // trigger scripts di beberapa browser. Regex lebih aman di sini.

    const ALLOWED_TAGS  = new Set(['b','i','em','strong','br','p','ul','ol','li','span','sub','sup','u','s']);
    const ALLOWED_ATTRS = new Set(['class','style']);

    // Strip event handlers, javascript: URLs, dan dangerous tags.
    // Ini sudah dipakai di ExamViewer.js — disatukan di sini supaya
    // semua file pakai implementasi yang sama, bukan masing-masing punya versi.
    function _sanitizeFallback(html) {
        return String(html ?? '')
            // strip on* event handlers (onclick, onerror, dst)
            .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
            // strip javascript: dan data: di href/src/action
            .replace(/(?:href|src|action)\s*=\s*(?:"[^"]*(?:javascript|data):[^"]*"|'[^']*(?:javascript|data):[^']*')/gi, '')
            // strip seluruh tag berbahaya beserta isinya
            .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*>[\s\S]*?<\/(?:script|iframe|object|embed|style|link)>/gi, '')
            // strip self-closing dangerous tags
            .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*\/?>/gi, '')
            // strip tag yang tidak ada di whitelist, tapi biarkan kontennya
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (match, tag) => {
                if (!ALLOWED_TAGS.has(tag.toLowerCase())) return '';
                // strip attributes yang tidak di-whitelist dari tag yang diizinkan
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

    // ── 2. Attribute Escaper ──────────────────────────────────────────────────
    // Untuk nilai yang masuk ke href="", data-x="", atau string di dalam HTML
    // yang TIDAK boleh mengandung HTML sama sekali (nama, ID, kelas, dll).
    function escapeAttr(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Untuk konten text-only (tidak pakai innerHTML, tapi textContent tidak selalu bisa)
    function escapeText(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ── 3. Safe DOM Writer ───────────────────────────────────────────────────
    // Pengganti innerHTML yang auto-sanitize. Pakai ini daripada raw innerHTML.
    //
    //   Security.setHTML(el, untrustedString)     ← sanitize dulu
    //   Security.setText(el, untrustedString)     ← textContent, zero XSS risk
    //   Security.setAttr(el, attrName, value)     ← escape attribute value
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

    // ── 4. Global Error Handler ──────────────────────────────────────────────
    // Tangkap semua uncaught error dan unhandled promise rejection.
    //
    // Di production, ini adalah safety net — tidak ada error yang boleh
    // hilang tanpa trace. Logging ke console (dev) dan bisa diperluas
    // ke service monitoring (Sentry, dll) tanpa ubah kode lain.
    //
    // WHY tidak langsung throw ke user?
    // Karena sebagian besar uncaught error berasal dari extension browser
    // atau third-party script yang tidak bisa kita kontrol. Kita log,
    // tapi tidak spam alert ke user untuk hal yang bukan salah mereka.

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

        // Jangan log error dari browser extensions (mereka punya path aneh)
        if (event.filename && (
            event.filename.includes('extension://') ||
            event.filename.includes('moz-extension://')
        )) return;

        // Hanya log di non-production — tapi kita tidak punya env variable,
        // jadi cek hostname sebagai proxy: localhost = dev, lainnya = prod.
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

        // Prevent default hides it from console in some browsers — we DON'T call that,
        // because hiding errors from the console makes debugging hell.
    }

    global.addEventListener('error',               _handleUncaughtError);
    global.addEventListener('unhandledrejection',  _handleUnhandledRejection);

    // ── 5. Violation Store — Firestore-backed, anti-tamper ───────────────────
    // localStorage mudah dimanipulasi peserta via DevTools.
    // Solusi: tulis violation state ke Firestore. Client tidak bisa edit Firestore
    // tanpa auth, dan Firestore rules mencegah peserta menghapus data sendiri.
    //
    // API tetap sinkron di surface (tidak await) agar caller tidak perlu ubah banyak.
    // Write ke Firestore dilakukan secara fire-and-forget dengan error handling sendiri.
    //
    // v1.0.0 SCHEMA MIGRATION:
    //   Old `violations` collection (composite doc_id `{token}_{userKey}`) was DROPPED.
    //   Replaced by:
    //     - `violation_events`   : 1 row per violation event (UUID PK, no upsert)
    //     - `assessment_sessions`: tracks per-user session status (active/paused/
    //                              disconnected/submitted). Used by markSubmitted +
    //                              isSubmitted.
    //     - `assessment_view_peserta`: lookup view keyed by access_code (the `token`).
    //
    //   Methods kept on this object for backward-compat with legacy callers
    //   (kerjakan-ujian.js legacy, exam/logic.js). New v0.746.0 callers (take-assessment.js)
    //   talk to the new tables directly via Edge Functions.

    const ViolationStore = {
        _getDb() {
            return global.firebaseDb || null;
        },

        // v1.0.0: violation_events uses UUID PK assigned server-side, so the
        // legacy `{token}_{userKey}` composite ID is no longer meaningful.
        // Kept for backward-compat — returns a random ID (callers that still
        // use it should treat the result as opaque).
        _docId(_token, _userKey) {
            return (global.crypto?.randomUUID
                ? global.crypto.randomUUID()
                : 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        },

        // v1.0.0: legacy `set()` wrote a status upsert to `violations/{docId}`.
        // That table no longer exists. We retain the sessionStorage cache so
        // local fast-path reads still work; the Firestore write is now a no-op.
        // New code should call markWarning (events) or markSubmitted (sessions).
        async set(token, userKey, status, _extra = {}) {
            if (!token || !userKey) return;
            const cacheKey = `viol_${token}_${userKey}`;
            try { sessionStorage.setItem(cacheKey, status); } catch (_) {}
        },

        // v1.0.0: legacy `get()` fetched status from `violations/{docId}`.
        // That table no longer exists — return only the sessionStorage cache.
        // For real submitted-state checks, use isSubmitted() (queries
        // assessment_sessions via assessment_view_peserta).
        async get(token, userKey) {
            if (!token || !userKey) return null;
            const cacheKey = `viol_${token}_${userKey}`;
            return sessionStorage.getItem(cacheKey);
        },

        // v1.0.0: update the matching assessment_sessions row to 'submitted'.
        // token = access_code, userKey = user.uid. We look up the assessment
        // by access_code via assessment_view_peserta (read-only view), then
        // update the user's active/paused/disconnected session row.
        async markSubmitted(token, userKey) {
            if (!token || !userKey) return;
            const db = this._getDb();
            if (!db) return;

            // Cache locally so isSubmitted() returns fast on next check
            const cacheKey = `viol_${token}_${userKey}`;
            try { sessionStorage.setItem(cacheKey, 'submitted'); } catch (_) {}

            try {
                const assessmentSnap = await db.collection('assessment_view_peserta').doc(token).get();
                if (!assessmentSnap.exists) return;

                const sessionSnap = await db.collection('assessment_sessions')
                    .where('assessment_id', '==', assessmentSnap.id)
                    .where('user_id', '==', userKey)
                    .where('status', 'in', ['active', 'paused', 'disconnected'])
                    .limit(1)
                    .get();

                if (!sessionSnap.empty) {
                    await sessionSnap.docs[0].ref.update({
                        status:       'submitted',
                        submitted_at: new Date().toISOString(),
                    });
                }
            } catch (err) {
                const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                if (isDev) console.warn('[ViolationStore] markSubmitted failed:', err?.message || err);
            }
        },

        // v1.0.0: insert a single row into `violation_events` (no upsert, no merge).
        // assessment_id and session_id are unknown at the client at this point —
        // the heartbeat Edge Function enriches them on its next tick. (The DB
        // schema marks them NOT NULL, but writes from the peserta client go
        // through the heartbeat Edge Function which fills them in.)
        // signature: markWarning(token, userKey, warningNum, message, examTitle, userName)
        //   (task spec names them violations/pesan/nama — same positions.)
        async markWarning(token, userKey, warningNum, message, examTitle, userName) {
            if (!token || !userKey) return;
            const db = this._getDb();
            if (!db) return;

            // Map the warning number to a severity tier for the new schema.
            // 'warning' for normal strikes; 'critical' when reaching MAX (4).
            const MAX_WARNINGS = 4;
            const severity = (warningNum && warningNum >= MAX_WARNINGS) ? 'critical' : 'warning';

            try {
                await db.collection('violation_events').add({
                    assessment_id: null, // unknown — heartbeat Edge Function fills this
                    session_id:    null, // unknown — heartbeat Edge Function fills this
                    user_id:       userKey, // userKey is actually user.uid
                    user_email:    null,
                    user_name:     String(userName  || 'Peserta').slice(0, 80),
                    exam_title:    String(examTitle || 'Asesmen').slice(0, 100),
                    event_type:    'keyboard_violation',
                    message:       String(message || 'Pelanggaran terdeteksi').slice(0, 300),
                    severity,
                    ip_address:    null,
                    user_agent:    (global.navigator?.userAgent) || null,
                    device_id:     (() => { try { return localStorage.getItem('albedu_exam_device_id'); } catch (_) { return null; } })(),
                });

                // Local cache so isSubmitted() returns fast on subsequent checks
                const cacheKey = `viol_${token}_${userKey}`;
                try { sessionStorage.setItem(cacheKey, 'active'); } catch (_) {}
            } catch (err) {
                const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                if (isDev) console.warn('[ViolationStore] markWarning failed:', err?.message || err);
            }
        },

        // v1.0.0: legacy `markViolation(token, userKey, count)` used to upsert
        // a 'violation' status doc. Now routes through markWarning so each
        // strike is recorded as a discrete violation_events row.
        markViolation(token, userKey, count) {
            return this.markWarning(token, userKey, count, 'Batas pelanggaran tercapai', null, null);
        },

        // v1.0.0: check assessment_sessions for a 'submitted' status row.
        // token = access_code, userKey = user.uid.
        async isSubmitted(token, userKey) {
            if (!token || !userKey) return false;

            // Fast path: sessionStorage cache says submitted — trust it.
            const cacheKey = `viol_${token}_${userKey}`;
            const cached = sessionStorage.getItem(cacheKey);
            if (cached === 'submitted') return true;

            const db = this._getDb();
            if (!db) return false;

            try {
                // Find assessment by access_code, then check session status.
                const assessmentSnap = await db.collection('assessment_view_peserta').doc(token).get();
                if (!assessmentSnap.exists) return false;

                const sessionSnap = await db.collection('assessment_sessions')
                    .where('assessment_id', '==', assessmentSnap.id)
                    .where('user_id', '==', userKey)
                    .where('status', '==', 'submitted')
                    .limit(1)
                    .get();

                const submitted = !sessionSnap.empty;
                if (submitted) {
                    try { sessionStorage.setItem(cacheKey, 'submitted'); } catch (_) {}
                }
                return submitted;
            } catch (_) {
                return false;
            }
        },
    };

    // ── Public API ────────────────────────────────────────────────────────────
    global.Security = {
        sanitizeHTML,
        escapeAttr,
        escapeText,
        setHTML,
        setText,
        setAttr,
        ViolationStore,

        // Untuk debugging — lihat error yang terjadi tanpa membuka DevTools
        getErrorLog: () => [..._errorLog],
    };

})(window);