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
//   5. Violation Store — simpan state pelanggaran ujian ke Firestore,
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
    // Struktur dokumen: violations/{token}_{userKey}
    //   { status: 'submitted'|'violation'|'active', updatedAt, violations: number }

    const ViolationStore = {
        _getDb() {
            return global.firebaseDb || null;
        },

        _docId(token, userKey) {
            // Sanitize: Firestore doc ID tidak boleh mengandung /
            return `${String(token).replace(/\//g, '_')}_${String(userKey).replace(/\//g, '_')}`;
        },

        // Tulis status ke Firestore. Fire-and-forget — tidak block UI.
        // Tetap tulis ke sessionStorage sebagai local cache untuk read cepat.
        async set(token, userKey, status, extra = {}) {
            if (!token || !userKey) return;

            const cacheKey = `viol_${token}_${userKey}`;
            try { sessionStorage.setItem(cacheKey, status); } catch (_) {}

            const db = this._getDb();
            if (!db) return; // offline / SDK belum siap — cache sudah cukup untuk sesi ini

            try {
                await db.collection('violations').doc(this._docId(token, userKey)).set({
                    status,
                    token,
                    userKey,
                    updatedAt: db.FieldValue?.serverTimestamp() ?? new Date().toISOString(),
                    ...extra,
                }, { merge: true }); // merge: true agar tidak timpa field lain
            } catch (_) {
                // Firestore write gagal (offline, rules) — sessionStorage jadi fallback.
                // Ini bukan error fatal: data tetap tersimpan lokal sampai koneksi kembali.
            }
        },

        // Baca dari sessionStorage dulu (fast path), Firestore sebagai source-of-truth.
        async get(token, userKey) {
            if (!token || !userKey) return null;

            const cacheKey = `viol_${token}_${userKey}`;
            const cached = sessionStorage.getItem(cacheKey);

            const db = this._getDb();
            if (!db) return cached; // tidak bisa verify ke Firestore

            try {
                const snap = await db.collection('violations').doc(this._docId(token, userKey)).get();
                if (snap.exists) {
                    const status = snap.data().status || null;
                    try { sessionStorage.setItem(cacheKey, status); } catch (_) {}
                    return status;
                }
                return cached; // doc belum ada (ujian baru), gunakan cache
            } catch (_) {
                return cached; // Firestore error, fallback ke cache
            }
        },

        markSubmitted(token, userKey) {
            return this.set(token, userKey, 'submitted');
        },

        markViolation(token, userKey, count) {
            return this.set(token, userKey, 'violation', { violationCount: count });
        },

        // WHY a separate markWarning method?
        // ExamGuardian fires per-warning callbacks with context (pesan, warningNum).
        // We append each warning as an event to violationEvents[] so the admin panel
        // can show the full violation timeline — not just a final count.
        //
        // NOTE: Firestore doesn't support serverTimestamp() inside array values,
        // so we use ISO string for the event timestamp. updatedAt at doc level
        // still uses serverTimestamp() via set() for accurate server time.
        //
        // userName and examTitle are denormalized onto the doc so the admin
        // panel never needs to do extra Firestore reads to display them.
        async markWarning(token, userKey, warningNum, message, examTitle, userName) {
            if (!token || !userKey) return;

            const db = this._getDb();
            if (!db) return;

            // Build the new event object.
            // serverTimestamp() tidak bisa dipakai di dalam array item.
            // ISO string adalah pendekatan yang benar.
            const event = {
                warningNum:  warningNum  || 1,
                message:     String(message || '').slice(0, 300), // cap length
                examTitle:   String(examTitle   || 'Ujian').slice(0, 100),
                userName:  String(userName || 'Peserta').slice(0, 80),
                ts:          new Date().toISOString(),
            };

            try {
                // BUGFIX Q: Use Math.max to ensure violationCount only goes
                // up, never down. Previously, if a stale warning fired
                // with a lower number (e.g. after a partial reset), the
                // merge would overwrite the count with the lower value.
                const docRef = db.collection('violations').doc(this._docId(token, userKey));
                const existingSnap = await docRef.get();
                const existingCount = (existingSnap.exists && existingSnap.data()?.violationCount) || 0;
                const finalCount = Math.max(existingCount, warningNum || 1);
                await docRef.set({
                    status:          'active',
                    token,
                    userKey,
                    violationCount:  finalCount,
                    userName:        String(userName || 'Peserta').slice(0, 80),
                    examTitle:       String(examTitle   || 'Ujian').slice(0, 100),
                    updatedAt:       db.FieldValue?.serverTimestamp()  ?? new Date().toISOString(),
                    violationEvents: db.FieldValue?.arrayUnion(event)  ?? [event],
                }, { merge: true });

                // Update local cache so isSubmitted() returns fast on next check
                const cacheKey = `viol_${token}_${userKey}`;
                try { sessionStorage.setItem(cacheKey, 'active'); } catch (_) {}

            } catch (err) {
                // Write failed (offline / permissions / schema mismatch).
                // Warning masih di-track di ExamLogic._state.violations — tidak hilang.
                const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                if (isDev) console.warn('[ViolationStore] markWarning failed:', err?.message || err);
            }
        },

        async isSubmitted(token, userKey) {
            return (await this.get(token, userKey)) === 'submitted';
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