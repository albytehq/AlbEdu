// =============================================================================
// auth/turnstile.js — Helper untuk Cloudflare Turnstile (v2 — peserta-friendly)
// =============================================================================
//
// v2.0 CHANGES (peserta-friendly — reduce DNS/network failures):
//   - appearance: 'execute' → invisible challenge, no UI friction
//   - Auto-retry on error-callback (up to 3 attempts with 1s delay)
//     Handles transient Cloudflare PAT DNS failures (brunhild.challenges.cloudflare.com
//     ERR_NAME_NOT_RESOLVED) — Cloudflare usually falls back to compute-bound
//     challenge on retry.
//   - Pre-warm API: prerenderTurnstile() renders widget on page load so token
//     is ready by the time user clicks login (no on-demand delay).
//   - waitForTurnstileReady timeout bumped from 10s → 30s (slow networks)
//   - getFreshTurnstileToken timeout bumped from 30s → 45s
//
// Satu implementasi Turnstile yang dipakai bersama oleh:
//   - User Login (index.html & login.html)
//   - User Registration (akan datang)
//   - Admin Registration (register-admin.html)
//
// PENTING:
//   - Turnstile size HANYA menerima: "normal", "compact", "flexible"
//   - JANGAN gunakan "invisible" — itu BUKAN nilai yang valid!
//   - appearance: 'execute' (invisible render) is valid and different from size.
//   - render() otomatis men-trigger challenge — JANGAN panggil execute() setelah render()
//   - Untuk re-challenge widget yang sudah ada, gunakan reset() saja
// =============================================================================

import { AUTH_CONFIG, TIMING_CONFIG } from './constants.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _activeWidgetId = null;
let _prewarmedToken = null;     // cached token from pre-warm render
let _prewarmedAt = 0;           // timestamp of pre-warm token

// Token freshness window — Cloudflare tokens are valid for 300s (5 min),
// but we use 240s (4 min) to leave buffer for backend validation.
const TOKEN_FRESHNESS_MS = 240_000;

// Retry config for transient Cloudflare PAT failures
const MAX_ERROR_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

/**
 * Menunggu hingga Turnstile script siap digunakan.
 * @param {number} [timeout] - Timeout dalam ms (default: 30 detik, was 10s)
 * @returns {Promise<void>}
 */
export function waitForTurnstileReady(timeout = TIMING_CONFIG.TURNSTILE_READY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        if (window.turnstile?.render) {
            return resolve();
        }

        const started = Date.now();
        const timer = setInterval(() => {
            if (window.turnstile?.render) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeout) {
                clearInterval(timer);
                reject(new Error('Verifikasi keamanan belum siap.'));
            }
        }, 100);
    });
}

/**
 * Mendapatkan token Turnstile dari widget.
 * @param {string|null} [widgetId] - ID widget Turnstile (opsional)
 * @returns {string|null} Token atau null jika tidak tersedia
 */
export function getTurnstileToken(widgetId = null) {
    // Coba ambil dari hidden input (fallback untuk form submit)
    const responseInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (responseInput?.value) {
        return responseInput.value;
    }

    // Coba ambil via API Turnstile
    if (window.turnstile?.getResponse) {
        return window.turnstile.getResponse(widgetId) || '';
    }

    return '';
}

export function resetTurnstile(widgetId = null) {
    const id = widgetId || _activeWidgetId;
    if (!id || !window.turnstile?.reset) return;
    try {
        window.turnstile.reset(id);
    } catch (_) {}
}

export function executeTurnstile(widgetId = null) {
    const id = widgetId || _activeWidgetId;
    if (!id || !window.turnstile?.execute) return;
    try {
        window.turnstile.execute(id);
    } catch (_) {}
}

/**
 * Render widget Turnstile ke container.
 * @param {HTMLElement} container - Element DOM untuk widget
 * @param {Object} [options] - Override options untuk window.turnstile.render
 * @returns {Promise<{widgetId: string, token: string}>}
 */
export async function renderTurnstile(container, options = {}) {
    await waitForTurnstileReady();

    return _renderWithRetry(container, options);
}

/**
 * Internal: render widget with auto-retry on error-callback.
 * Handles transient Cloudflare PAT DNS failures.
 *
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {number} [attempt] - current attempt (1-indexed)
 * @returns {Promise<{widgetId: string, token: string}>}
 */
function _renderWithRetry(container, options = {}, attempt = 1) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const widgetId = window.turnstile.render(container, {
            sitekey: AUTH_CONFIG.TURNSTILE_SITE_KEY,
            size: 'compact',
            appearance: 'execute',  // invisible challenge — no UI friction
            callback: (token) => {
                if (settled) return;
                settled = true;
                _prewarmedToken = token;
                _prewarmedAt = Date.now();
                resolve({ widgetId, token });
            },
            'error-callback': (errorCode) => {
                if (settled) return;
                if (attempt < MAX_ERROR_RETRIES) {
                    // Retry — Cloudflare usually falls back to compute-bound
                    // challenge after PAT DNS failure.
                    setTimeout(() => {
                        try { window.turnstile.remove(widgetId); } catch (_) {}
                        // Re-render with same options, increment attempt
                        resolve(_renderWithRetry(container, options, attempt + 1));
                    }, RETRY_DELAY_MS);
                    return;
                }
                settled = true;
                reject(new Error(`Verifikasi Turnstile gagal (${errorCode || 'unknown'}).`));
            },
            'expired-callback': () => {
                if (settled) return;
                settled = true;
                reject(new Error('Verifikasi Turnstile kadaluarsa.'));
            },
            ...options,
        });

        if (!widgetId) {
            reject(new Error('Turnstile gagal diinisialisasi. Silakan muat ulang halaman.'));
            return;
        }

        _activeWidgetId = widgetId;
        // render() otomatis trigger execute — JANGAN panggil execute() di sini!
    });
}

/**
 * Dapatkan token Turnstile baru.
 * Jika widget sudah ada → reset() untuk re-challenge (reset auto-execute).
 * Jika belum ada → render() baru (render auto-execute).
 *
 * PENTING: Selalu return {widgetId, token} — token adalah string, bukan null/undefined.
 * Jika token tidak bisa didapatkan dalam timeout, reject dengan error yang jelas.
 *
 * @param {HTMLElement} [container] - Container element (wajib untuk render pertama)
 * @param {boolean} [isFirstRender] - Apakah ini render pertama?
 * @param {string|null} [existingWidgetId] - Widget ID yang sudah ada (diabaikan, pakai module state)
 * @returns {Promise<{widgetId: string|null, token: string}>}
 */
export async function getFreshTurnstileToken(container, isFirstRender = false, existingWidgetId = null) {
    await waitForTurnstileReady();

    // 0. Check pre-warmed token first (cached from page-load pre-render).
    // If still fresh, use it — no need to re-challenge.
    if (_prewarmedToken && (Date.now() - _prewarmedAt) < TOKEN_FRESHNESS_MS) {
        const cached = _prewarmedToken;
        _prewarmedToken = null;  // consume — tokens are single-use
        return { widgetId: _activeWidgetId, token: cached };
    }

    const widgetId = existingWidgetId || _activeWidgetId;

    // Coba cek apakah token sudah tersedia dari widget sebelumnya
    // (menghindari re-render yang tidak perlu jika token masih fresh)
    if (widgetId && !isFirstRender) {
        const existingToken = getTurnstileToken(widgetId);
        if (existingToken) {
            return { widgetId, token: existingToken };
        }
    }

    // Jika widget sudah ada, cukup reset — reset() otomatis re-execute challenge
    if (!isFirstRender && widgetId) {
        return new Promise((resolve, reject) => {
            const POLL_INTERVAL_MS = 200;
            const TIMEOUT_MS = 45_000;  // was 30s — bumped for slow networks

            const checkInterval = setInterval(() => {
                const token = getTurnstileToken(widgetId);
                if (token) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    resolve({ widgetId, token });
                }
            }, POLL_INTERVAL_MS);

            const timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                // Widget mungkin sudah stale — hapus state dan biarkan caller fallback ke render
                _activeWidgetId = null;
                reject(new Error('Timeout menunggu token Turnstile. Widget mungkin perlu di-render ulang.'));
            }, TIMEOUT_MS);

            // Reset men-trigger challenge baru — JANGAN panggil execute()!
            try {
                window.turnstile.reset(widgetId);
            } catch (err) {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                // Widget tidak valid lagi — hapus state
                _activeWidgetId = null;
                reject(new Error('Widget Turnstile tidak valid. Silakan muat ulang halaman.'));
            }
        });
    }

    // Render widget baru — render() otomatis execute challenge
    if (!container) {
        // Fallback: cari container yang sudah ada di DOM
        container = document.getElementById('userTurnstile');
    }

    if (!container) {
        return Promise.reject(new Error('Container Turnstile tidak ditemukan di DOM.'));
    }

    // Bersihkan konten lama agar tidak ada widget duplikat
    if (_activeWidgetId) {
        try { window.turnstile.remove(_activeWidgetId); } catch (_) {}
        _activeWidgetId = null;
    }
    container.innerHTML = '';

    return _renderWithRetry(container);
}

/**
 * Pre-warm: render Turnstile widget on page load.
 * Call this as soon as the page is interactive — the widget will start its
 * challenge in the background, so by the time the user clicks "Login",
 * the token is already cached and ready (no on-demand delay, no UI surprise).
 *
 * @param {HTMLElement} [container] - Container element (default: #userTurnstile)
 * @returns {Promise<{widgetId: string, token: string}|null>} - null if container missing or Turnstile not ready
 */
export async function prerenderTurnstile(container) {
    if (!container) {
        container = document.getElementById('userTurnstile');
    }
    if (!container) return null;

    try {
        await waitForTurnstileReady();
    } catch (_) {
        return null;  // Turnstile script didn't load — user will see error on click
    }

    // Don't pre-warm twice
    if (_activeWidgetId && _prewarmedToken) {
        return { widgetId: _activeWidgetId, token: _prewarmedToken };
    }

    try {
        return await _renderWithRetry(container);
    } catch (_) {
        return null;  // silent fail — caller (getFreshTurnstileToken) will retry on demand
    }
}

/**
 * Reset module state (for logout / cleanup).
 */
export function clearTurnstileState() {
    if (_activeWidgetId) {
        try { window.turnstile?.remove?.(_activeWidgetId); } catch (_) {}
    }
    _activeWidgetId = null;
    _prewarmedToken = null;
    _prewarmedAt = 0;
}
