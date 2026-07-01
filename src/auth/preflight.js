// =============================================================================
// auth/preflight.js — User preflight validation for device & security checks
// =============================================================================

import { AUTH_CONFIG, TIMING_CONFIG, RATE_LIMITS } from './constants.js';
import { getTurnstileToken, getFreshTurnstileToken } from './turnstile.js';
import { getErrorMessage } from './errorMapper.js';

// ── PreflightError class ─────────────────────────────────────────────────────
// Custom error yang memisahkan backendCode dari userMessage.
// Ini mencegah double-mapping: komponen UI cukup cek instanceof PreflightError,
// lalu langsung tampilkan err.message (sudah user-friendly).
// err.backendCode digunakan hanya untuk logging.

export class PreflightError extends Error {
    /**
     * @param {string} backendCode - Kode error dari backend (e.g. 'device_limit_reached')
     * @param {string} [userMessage] - Pesan user-friendly. Jika tidak diberikan,
     *   akan di-map otomatis dari backendCode via getErrorMessage().
     */
    constructor(backendCode, userMessage) {
        // Selalu map ke user-friendly message — TIDAK pernah expose raw backendCode ke user.
        // getErrorMessage() dijamin mengembalikan string Indonesia yang aman.
        const message = userMessage || getErrorMessage(backendCode);
        super(message);
        this.name = 'PreflightError';
        this.backendCode = backendCode;
    }
}

// ── CompletionError class ────────────────────────────────────────────────────
// Custom error untuk user-auth-complete (POST Google OAuth).
// Struktur identik dengan PreflightError — memisahkan backendCode dari
// userMessage supaya UI cukup cek instanceof lalu tampilkan err.message.

export class CompletionError extends Error {
    /**
     * @param {string} backendCode - Kode error dari backend (e.g. 'device_limit_reached', 'invalid_token')
     * @param {string} [userMessage] - Pesan user-friendly. Jika tidak diberikan,
     *   akan di-map otomatis dari backendCode via getErrorMessage().
     */
    constructor(backendCode, userMessage) {
        const message = userMessage || getErrorMessage(backendCode);
        super(message);
        this.name = 'CompletionError';
        this.backendCode = backendCode;
    }
}

// ── Storage helpers ──────────────────────────────────────────────────────────

export function getStoredPreflight() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(AUTH_CONFIG.PREFLIGHT_KEY) || 'null');
        if (!parsed?.preflightId || !parsed?.deviceId || !parsed?.createdAt) return null;
        if (Date.now() - parsed.createdAt > AUTH_CONFIG.PREFLIGHT_TTL_MS) {
            sessionStorage.removeItem(AUTH_CONFIG.PREFLIGHT_KEY);
            return null;
        }
        return parsed;
    } catch (_) {
        return null;
    }
}

export function storePreflight(data) {
    try {
        sessionStorage.setItem(AUTH_CONFIG.PREFLIGHT_KEY, JSON.stringify({
            ...data,
            createdAt: Date.now(),
        }));
    } catch (_) {}
}

export function clearPreflight() {
    try {
        sessionStorage.removeItem(AUTH_CONFIG.PREFLIGHT_KEY);
    } catch (_) {}
}

// ── Device fingerprint ───────────────────────────────────────────────────────
//
// Mengembalikan object lengkap: { deviceId, browserHash, deviceInfo }
// agar bisa disimpan ke session storage dan dikirim ke user-auth-complete.
//
// DeviceFingerprint.getFingerprint() adalah API yang benar — BUKAN .get().
// .get() tidak ada di DeviceFingerprint.js dan akan return undefined secara silent.

export async function getDeviceFingerprint() {
    if (typeof window.DeviceFingerprint?.getFingerprint === 'function') {
        const fp = window.DeviceFingerprint.getFingerprint();
        return {
            deviceId:   fp.device_id   || null,
            browserHash: fp.browser_hash || null,
            deviceInfo:  fp.device_info  || null,
        };
    }

    // Fallback: canvas-based ID jika DeviceFingerprint.js belum load
    // Tidak menghasilkan browser_hash atau device_info — hanya deviceId darurat.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('AlbEdu-fp', 2, 2);
    const dataUrl = canvas.toDataURL();
    let hash = 0;
    for (let i = 0; i < dataUrl.length; i++) {
        const char = dataUrl.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return {
        deviceId:    String(Math.abs(hash)),
        browserHash: null,
        deviceInfo:  null,
    };
}

// ── Extract backend error code from FunctionsHttpError ───────────────────────
// Supabase SDK wraps non-2xx responses in FunctionsHttpError.
// The actual error code from our Edge Function is in error.context (a Response).
// We need to parse the JSON body to get the `error` field.

export async function extractBackendErrorCode(error) {
    // 1. Try to parse error.context (Supabase FunctionsHttpError)
    if (error?.context && typeof error.context.json === 'function') {
        try {
            const body = await error.context.json();
            if (body?.error) return body.error;
        } catch (_) {}
    }

    // 2. Try error.context.text() fallback
    if (error?.context && typeof error.context.text === 'function') {
        try {
            const text = await error.context.text();
            const parsed = JSON.parse(text);
            if (parsed?.error) return parsed.error;
        } catch (_) {}
    }

    // 3. Fallback: detect from HTTP status
    if (error?.status === 403) return 'device_limit_reached';
    if (error?.status === 429) return 'rate_limit_exceeded';
    if (error?.status === 401) return 'unauthorized';

    // 4. Last resort: use error.message
    return error?.message || 'unknown_error';
}

// ── Client-side throttle ─────────────────────────────────────────────────────

let lastPreflightAt = 0;
const PREFLIGHT_THROTTLE_MS = 5000; // 5 detik

// ── Run preflight validation ─────────────────────────────────────────────────

export async function runPreflightValidation(turnstileToken) {
    // Terima string langsung atau object {token, widgetId} dari getFreshTurnstileToken
    const token = typeof turnstileToken === 'string' ? turnstileToken : turnstileToken?.token;

    // Ambil fingerprint lengkap: deviceId + browserHash + deviceInfo
    const fp = await getDeviceFingerprint();
    const { deviceId, browserHash, deviceInfo } = fp;

    if (!token) {
        throw new PreflightError('missing_verification');
    }

    if (!deviceId) {
        throw new PreflightError('risk_check_unavailable');
    }

    // Client-side throttle
    const now = Date.now();
    if (now - lastPreflightAt < PREFLIGHT_THROTTLE_MS) {
        throw new PreflightError('rate_limit_exceeded');
    }
    lastPreflightAt = now;

    const { data, error } = await window.sb.functions.invoke('user-auth-preflight', {
        body: {
            turnstileToken: token,
            deviceId,
            browserHash: browserHash || null,
            // deviceInfo tidak dipakai oleh preflight backend, tapi dikirim
            // agar tersedia jika backend diperluas ke depannya
        },
    });

    if (error) {
        const backendCode = await extractBackendErrorCode(error);
        throw new PreflightError(backendCode);
    }

    if (!data?.preflightId) {
        throw new PreflightError('user_preflight_failed');
    }

    // Kembalikan semua data yang dibutuhkan oleh user-auth-complete
    return {
        preflightId: data.preflightId,
        deviceId,
        browserHash: browserHash || null,
        deviceInfo:  deviceInfo  || null,
    };
}

// ── Execute full preflight flow ──────────────────────────────────────────────
//
// Alur:
//   1. Cek cache session dulu — jika valid, skip semua langkah mahal.
//   2. Minta token Turnstile fresh dengan container eksplisit.
//   3. Kirim ke backend untuk validasi device + rate-limit.
//   4. Jika backend kembalikan turnstile_failed (403), coba SEKALI lagi
//      dengan token baru — Cloudflare kadang butuh re-challenge setelah
//      idle lama atau jika iframe sempat di-render di luar viewport.
//   5. Simpan hasil ke sessionStorage agar login kedua dalam sesi sama
//      tidak perlu ulang challenge.

export async function executePreflightFlow() {
    // 1. Gunakan cache jika masih valid
    const stored = getStoredPreflight();
    if (stored) return stored;

    // Ambil container Turnstile — wajib ada di DOM
    const container = document.getElementById('userTurnstile');
    if (!container) {
        throw new PreflightError('risk_check_unavailable',
            'Komponen verifikasi keamanan tidak ditemukan. Silakan muat ulang halaman.');
    }

    // 2. Dapatkan token fresh (render atau reset widget)
    let tokenResult;
    try {
        tokenResult = await getFreshTurnstileToken(container);
    } catch (err) {
        throw new PreflightError('missing_verification');
    }

    const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
    if (!token) {
        throw new PreflightError('missing_verification');
    }

    // 3. Coba preflight pertama
    try {
        const result = await runPreflightValidation(token);
        storePreflight({
            preflightId: result.preflightId,
            deviceId:    result.deviceId,
            browserHash: result.browserHash || null,
            deviceInfo:  result.deviceInfo  || null,
        });
        return getStoredPreflight();
    } catch (err) {
        // 4. Jika turnstile_failed → minta token baru dan coba sekali lagi
        if (err instanceof PreflightError && err.backendCode === 'turnstile_failed') {
            let retryTokenResult;
            try {
                retryTokenResult = await getFreshTurnstileToken(container, false);
            } catch (_) {
                throw err;
            }

            const retryToken = typeof retryTokenResult === 'string'
                ? retryTokenResult
                : retryTokenResult?.token;

            if (!retryToken) throw err;

            const retryResult = await runPreflightValidation(retryToken);
            storePreflight({
                preflightId: retryResult.preflightId,
                deviceId:    retryResult.deviceId,
                browserHash: retryResult.browserHash || null,
                deviceInfo:  retryResult.deviceInfo  || null,
            });
            return getStoredPreflight();
        }

        throw err;
    }
}