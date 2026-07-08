// auth/turnstile.js — Cloudflare Turnstile helper
//
// Single implementation shared by:
//   - User login (index.html & login.html)
//   - Admin registration (register-admin.html)
//
// Turnstile size only accepts "normal", "compact", or "flexible". Don't use
// "invisible" — it's not a valid size value. appearance: 'execute' is the
// invisible-render option and is different from size.
// render() auto-triggers the challenge — DON'T call execute() after render().
// For re-challenge of an existing widget, call reset() only.

import { AUTH_CONFIG, TIMING_CONFIG } from './constants.js';

let _activeWidgetId = null;
let _prewarmedToken = null;     // cached token from pre-warm render
let _prewarmedAt = 0;           // timestamp of pre-warm token

// Cloudflare tokens are valid for 300s (5 min); we use 240s to leave buffer
// for backend validation.
const TOKEN_FRESHNESS_MS = 240_000;

const MAX_ERROR_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

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

export function getTurnstileToken(widgetId = null) {
    // Try the hidden input first (form-submit fallback)
    const responseInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (responseInput?.value) {
        return responseInput.value;
    }

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

export async function renderTurnstile(container, options = {}) {
    await waitForTurnstileReady();
    return _renderWithRetry(container, options);
}

// Render widget with auto-retry on error-callback. Handles transient
// Cloudflare PAT DNS failures (brunhild.challenges.cloudflare.com
// ERR_NAME_NOT_RESOLVED) — Cloudflare usually falls back to a compute-bound
// challenge on retry.
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
                    setTimeout(() => {
                        try { window.turnstile.remove(widgetId); } catch (_) {}
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
        // render() auto-triggers execute — don't call execute() here.
    });
}

// Get a fresh Turnstile token.
//   - If widget exists → reset() (reset auto-re-challenges)
//   - If not → render() new (render auto-challenges)
//
// Always returns {widgetId, token} with a non-null token string. Rejects
// with a clear error if the token can't be obtained within the timeout.
export async function getFreshTurnstileToken(container, isFirstRender = false, existingWidgetId = null) {
    await waitForTurnstileReady();

    // Use pre-warmed token if still fresh — no need to re-challenge.
    if (_prewarmedToken && (Date.now() - _prewarmedAt) < TOKEN_FRESHNESS_MS) {
        const cached = _prewarmedToken;
        _prewarmedToken = null;  // consume — tokens are single-use
        return { widgetId: _activeWidgetId, token: cached };
    }

    const widgetId = existingWidgetId || _activeWidgetId;

    // Check if a token is already available from a previous render — skip
    // the re-render if the token is still fresh.
    if (widgetId && !isFirstRender) {
        const existingToken = getTurnstileToken(widgetId);
        if (existingToken) {
            return { widgetId, token: existingToken };
        }
    }

    // Widget exists → reset() (auto re-challenges).
    if (!isFirstRender && widgetId) {
        return new Promise((resolve, reject) => {
            const POLL_INTERVAL_MS = 200;
            const TIMEOUT_MS = 45_000;

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
                _activeWidgetId = null;
                reject(new Error('Timeout menunggu token Turnstile. Widget mungkin perlu di-render ulang.'));
            }, TIMEOUT_MS);

            // reset() triggers a new challenge — don't call execute().
            try {
                window.turnstile.reset(widgetId);
            } catch (err) {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                _activeWidgetId = null;
                reject(new Error('Widget Turnstile tidak valid. Silakan muat ulang halaman.'));
            }
        });
    }

    // Render a new widget — render() auto-challenges.
    if (!container) {
        container = document.getElementById('userTurnstile');
    }

    if (!container) {
        return Promise.reject(new Error('Container Turnstile tidak ditemukan di DOM.'));
    }

    // Clean any stale widget so we don't end up with duplicates.
    if (_activeWidgetId) {
        try { window.turnstile.remove(_activeWidgetId); } catch (_) {}
        _activeWidgetId = null;
    }
    container.innerHTML = '';

    return _renderWithRetry(container);
}

// Pre-warm: render the widget on page load so the token is already cached
// when the user clicks login. Call this as soon as the page is interactive.
export async function prerenderTurnstile(container) {
    if (!container) {
        container = document.getElementById('userTurnstile');
    }
    if (!container) return null;

    try {
        await waitForTurnstileReady();
    } catch (_) {
        return null;  // Turnstile script didn't load — user sees error on click
    }

    // Don't pre-warm twice
    if (_activeWidgetId && _prewarmedToken) {
        return { widgetId: _activeWidgetId, token: _prewarmedToken };
    }

    try {
        return await _renderWithRetry(container);
    } catch (_) {
        return null;  // silent fail — getFreshTurnstileToken retries on demand
    }
}

// Reset module state (for logout / cleanup).
export function clearTurnstileState() {
    if (_activeWidgetId) {
        try { window.turnstile?.remove?.(_activeWidgetId); } catch (_) {}
    }
    _activeWidgetId = null;
    _prewarmedToken = null;
    _prewarmedAt = 0;
}
