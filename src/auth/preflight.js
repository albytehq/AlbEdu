// auth/preflight.js — user preflight validation (Turnstile + device check)

import { AUTH_CONFIG, TIMING_CONFIG, RATE_LIMITS } from './constants.js';
import { getTurnstileToken, getFreshTurnstileToken } from './turnstile.js';
import { getErrorMessage } from './errorMapper.js';

// Custom error that separates backendCode from userMessage. Prevents
// double-mapping — UI just checks instanceof PreflightError and displays
// err.message (already user-friendly). backendCode is for logging only.
export class PreflightError extends Error {
    constructor(backendCode, userMessage) {
        // Always map to user-friendly message — never expose raw backendCode.
        const message = userMessage || getErrorMessage(backendCode);
        super(message);
        this.name = 'PreflightError';
        this.backendCode = backendCode;
    }
}

// Mirror of PreflightError for the user-auth-complete (post-Google-OAuth)
// step. Same shape so UI treats both the same way.
export class CompletionError extends Error {
    constructor(backendCode, userMessage) {
        const message = userMessage || getErrorMessage(backendCode);
        super(message);
        this.name = 'CompletionError';
        this.backendCode = backendCode;
    }
}

// Storage helpers

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

// Returns { deviceId, browserHash, deviceInfo } for storage + sending to
// user-auth-complete.
//
// DeviceFingerprint.getFingerprint() is the correct API — NOT .get().
// .get() doesn't exist on DeviceFingerprint.js and would silently return
// undefined.
export async function getDeviceFingerprint() {
    if (typeof window.DeviceFingerprint?.getFingerprint === 'function') {
        const fp = window.DeviceFingerprint.getFingerprint();
        return {
            deviceId:   fp.device_id   || null,
            browserHash: fp.browser_hash || null,
            deviceInfo:  fp.device_info  || null,
        };
    }

    // Canvas-based fallback if DeviceFingerprint.js hasn't loaded yet.
    // Only produces a deviceId — no browser_hash or device_info.
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

// Supabase SDK wraps non-2xx responses in FunctionsHttpError. The actual
// error code from our Edge Function is in error.context (a Response object).
// Parse the JSON body to pull out the `error` field.

export async function extractBackendErrorCode(error) {
    if (error?.context && typeof error.context.json === 'function') {
        try {
            const body = await error.context.json();
            if (body?.error) return body.error;
        } catch (_) {}
    }

    if (error?.context && typeof error.context.text === 'function') {
        try {
            const text = await error.context.text();
            const parsed = JSON.parse(text);
            if (parsed?.error) return parsed.error;
        } catch (_) {}
    }

    if (error?.status === 403) return 'device_limit_reached';
    if (error?.status === 429) return 'rate_limit_exceeded';
    if (error?.status === 401) return 'unauthorized';

    // Network / CORS detection — must run BEFORE the error.message fallback.
    // When the SDK can't even send the request (CORS preflight blocked, DNS
    // failure, offline), error.context is undefined and error.message is a
    // generic English string like "Failed to send a request to the Edge
    // Function".
    const msg = (error?.message || '').toLowerCase();
    if (
        msg.includes('failed to send a request') ||
        msg.includes('failed to fetch') ||
        msg.includes('network request failed') ||
        msg.includes('cors') ||
        msg.includes('load failed') ||
        (error?.name === 'TypeError' && msg.includes('fetch'))
    ) {
        return 'network_error';
    }

    return error?.message || 'unknown_error';
}

// Client-side throttle (5s) — prevents the same client from spamming
// preflight back-to-back if the user double-clicks.
let lastPreflightAt = 0;
const PREFLIGHT_THROTTLE_MS = 5000;

export async function runPreflightValidation(turnstileToken) {
    // Accept either a raw string or {token, widgetId} from getFreshTurnstileToken.
    const token = typeof turnstileToken === 'string' ? turnstileToken : turnstileToken?.token;

    const fp = await getDeviceFingerprint();
    const { deviceId, browserHash, deviceInfo } = fp;

    if (!token) {
        throw new PreflightError('missing_verification');
    }

    if (!deviceId) {
        throw new PreflightError('risk_check_unavailable');
    }

    const now = Date.now();
    if (now - lastPreflightAt < PREFLIGHT_THROTTLE_MS) {
        throw new PreflightError('rate_limit_exceeded');
    }
    lastPreflightAt = now;

    const rpc = window.AlbEdu?.supabase?.rpc;
    if (!rpc) throw new PreflightError('platform_not_ready');

    // rpc.invoke(name, body, opts) — the second arg is the raw JSON payload
    // forwarded directly to client.functions.invoke(name, { body }). DO NOT
    // wrap it as `{ body: {...} }` here — that double-wraps the actual HTTP
    // body, the edge function reads body.turnstileToken as undefined, and
    // every request gets a 400 "missing_verification" even though the token
    // is valid on the client.
    const { data, error } = await rpc.invoke('user-auth-preflight', {
        turnstileToken: token,
        deviceId,
        browserHash: browserHash || null,
        // deviceInfo isn't used by the preflight backend today — sent for
        // forward-compat if the backend grows richer validation.
    });

    if (error) {
        const backendCode = await extractBackendErrorCode(error);
        throw new PreflightError(backendCode);
    }

    if (!data?.preflightId) {
        throw new PreflightError('user_preflight_failed');
    }

    return {
        preflightId: data.preflightId,
        deviceId,
        browserHash: browserHash || null,
        deviceInfo:  deviceInfo  || null,
    };
}

// Full preflight flow:
//   1. Use cached result if still valid (skip the expensive steps).
//   2. Get a fresh Turnstile token with an explicit container.
//   3. Send to backend for device + rate-limit check.
//   4. If backend says turnstile_failed (403), retry ONCE with a new token —
//      Cloudflare sometimes needs a re-challenge after long idle or if the
//      iframe rendered off-viewport.
//   5. Cache result so a second login in the same session skips the challenge.
export async function executePreflightFlow() {
    const stored = getStoredPreflight();
    if (stored) return stored;

    const container = document.getElementById('userTurnstile');
    if (!container) {
        throw new PreflightError('risk_check_unavailable',
            'Komponen verifikasi keamanan tidak ditemukan. Silakan muat ulang halaman.');
    }

    let tokenResult;
    try {
        tokenResult = await getFreshTurnstileToken(container);
    } catch (err) {
        // Distinguish network/DNS failures (Turnstile can't reach Cloudflare)
        // from other failures. Network failures need a different message so
        // the user knows to change DNS / disable VPN / try another network.
        const msg = (err?.message || '').toLowerCase();
        const isNetworkError =
            msg.includes('timeout') ||
            msg.includes('gagal') ||
            msg.includes('failed') ||
            msg.includes('kadaluarsa') === false && msg.includes('verifikasi');
        if (msg.includes('kadaluarsa')) {
            throw new PreflightError('turnstile_expired');
        }
        throw new PreflightError(isNetworkError ? 'turnstile_network_error' : 'missing_verification');
    }

    const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
    if (!token) {
        throw new PreflightError('missing_verification');
    }

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
        // turnstile_failed → re-challenge and retry once.
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
