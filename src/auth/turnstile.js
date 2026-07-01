// =============================================================================
// auth/turnstile.js — Helper untuk Cloudflare Turnstile
// =============================================================================
//
// Satu implementasi Turnstile yang dipakai bersama oleh:
//   - User Login (index.html & login.html)
//   - User Registration (akan datang)
//   - Admin Registration (register-admin.html)
//
// PENTING:
//   - Turnstile size HANYA menerima: "normal", "compact", "flexible"
//   - JANGAN gunakan "invisible" — itu BUKAN nilai yang valid!
//   - render() otomatis men-trigger challenge — JANGAN panggil execute() setelah render()
//   - Untuk re-challenge widget yang sudah ada, gunakan reset() saja
// =============================================================================

import { AUTH_CONFIG, TIMING_CONFIG } from './constants.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _activeWidgetId = null;

/**
 * Menunggu hingga Turnstile script siap digunakan.
 * @param {number} [timeout] - Timeout dalam ms (default: 10 detik)
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

/**
 * Reset widget Turnstile untuk challenge baru.
 * Reset otomatis men-trigger challenge baru — TIDAK perlu execute().
 * @param {string|null} [widgetId] - ID widget Turnstile
 */
export function resetTurnstile(widgetId = null) {
    const id = widgetId || _activeWidgetId;
    if (id && window.turnstile?.reset) {
        window.turnstile.reset(id);
    }
}

/**
 * Execute challenge Turnstile baru.
 * DEPRECATED: Jangan gunakan ini. render() dan reset() sudah auto-execute.
 * Fungsi ini hanya disimpan untuk kompatibilitas backward.
 * @param {string|null} [widgetId] - ID widget Turnstile
 */
export function executeTurnstile(widgetId = null) {
    // NO-OP: render() dan reset() sudah otomatis men-trigger challenge.
    // Memanggil execute() setelah render()/reset() menyebabkan error:
    // "Call to execute() on a widget that is already executing"
    console.warn('[Turnstile] executeTurnstile() dipanggil tapi NO-OP. Gunakan resetTurnstile() untuk re-challenge.');
}

/**
 * Render widget Turnstile dengan callback yang terjanjikan.
 * @param {HTMLElement} container - Elemen container untuk widget
 * @param {Object} options - Opsi tambahan (callback, error-callback, dll)
 * @returns {Promise<{widgetId: string, token: string}>}
 */
export async function renderTurnstile(container, options = {}) {
    await waitForTurnstileReady();

    return new Promise((resolve, reject) => {
        const widgetId = window.turnstile.render(container, {
            sitekey: AUTH_CONFIG.TURNSTILE_SITE_KEY,
            size: 'compact',  // HANYA "normal", "compact", atau "flexible" — BUKAN "invisible"!
            callback: (token) => {
                resolve({ widgetId, token });
            },
            'error-callback': () => {
                reject(new Error('Verifikasi Turnstile gagal.'));
            },
            'expired-callback': () => {
                reject(new Error('Verifikasi Turnstile kadaluarsa.'));
            },
            ...options,
        });

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
            const TIMEOUT_MS = 30_000;

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

    return new Promise((resolve, reject) => {
        const newWidgetId = window.turnstile.render(container, {
            sitekey: AUTH_CONFIG.TURNSTILE_SITE_KEY,
            size: 'compact',  // HANYA "normal", "compact", atau "flexible"
            callback: (token) => {
                resolve({ widgetId: newWidgetId, token });
            },
            'error-callback': (errorCode) => {
                reject(new Error(`Verifikasi Turnstile gagal (${errorCode || 'unknown'}).`));
            },
            'expired-callback': () => {
                reject(new Error('Verifikasi Turnstile kadaluarsa. Silakan coba lagi.'));
            },
        });

        if (!newWidgetId) {
            reject(new Error('Turnstile gagal diinisialisasi. Silakan muat ulang halaman.'));
            return;
        }

        _activeWidgetId = newWidgetId;
        // render() otomatis trigger execute — JANGAN panggil execute()!
    });
}
