// user-auth-portal.js — unified Google + email/password login page behaviour
//
// Single module serving BOTH auth pages:
//   - index.html (peserta landing) → #userLoginBtn / #userLoginBtn2
//   - login.html (admin login)     → #userLoginBtn + #emailLoginForm
//
// Flow (same for admin & peserta):
//   1. Click "Masuk dengan Google"
//   2. waitForSupabaseReady()
//   3. executePreflightFlow() — needs #userTurnstile container + Turnstile
//      token + DeviceFingerprint → stored in sessionStorage under
//      albedu_user_auth_preflight
//   4. window.Auth.authLogin() → Google OAuth redirect
//   5. onAuthStateChanged in auth/main.js → _syncUserDocument →
//      _createUserDocViaServer (reads preflight → invokes user-auth-complete)
//   6. Success → redirect to dashboard by role (admin/peserta)
//      Failure (CompletionError) → dispatch 'auth-completion-error' → reset UI
//
// The email/password form (login.html only) bypasses preflight and goes
// straight to signInWithPassword.

import {
    getErrorMessage,
    getLoginErrorMessage,
    logAuthError,
    LOADING_LABELS,
    waitForSupabaseReady,
    PreflightError,
    CompletionError,
    getStoredPreflight,
    clearPreflight,
    executePreflightFlow,
} from './index.js';
import { prerenderTurnstile } from './turnstile.js';

const AUTH_STEPS = {
    idle:       'Masuk dengan Google',
    loading:    'Memuat...',
    turnstile:  'Memeriksa keamanan...',
    preflight:  'Memverifikasi perangkat...',
    connecting: 'Menghubungkan ke Google...',
    success:    'Berhasil!',
    failed:     'Gagal!',
};

// null-safe — pages may not have all of these elements
const btn1     = document.getElementById('userLoginBtn');
const btn1Text = document.getElementById('userLoginText');
const btn2     = document.getElementById('userLoginBtn2');
const btn2Text = document.getElementById('userLoginText2');

const form           = document.getElementById('emailLoginForm');
const emailInput     = document.getElementById('email');
const passwordInput  = document.getElementById('password');
const emailButton    = document.getElementById('emailLoginBtn');
const errorEl        = document.getElementById('errorMessage')
    ?? document.getElementById('portalMessage');  // index.html uses #portalMessage
const card           = document.querySelector('.login-card');
const yearEl         = document.getElementById('currentYear')
    ?? document.getElementById('footerYear');

if (yearEl) yearEl.textContent = new Date().getFullYear();

let _authInProgress = false;
let _dotTimer = null;

function getAllButtonTexts() {
    const texts = [];
    if (btn1Text) texts.push(btn1Text);
    if (btn2Text) texts.push(btn2Text);
    return texts;
}

function getAllButtons() {
    const buttons = [];
    if (btn1) buttons.push(btn1);
    if (btn2) buttons.push(btn2);
    return buttons;
}

function setAllButtonText(text) {
    getAllButtonTexts().forEach(el => { el.textContent = text; });
}

function setAllButtonState(isAuthenticating, step = '') {
    getAllButtons().forEach(btn => {
        btn.disabled = isAuthenticating;
        btn.setAttribute('aria-busy', isAuthenticating ? 'true' : 'false');
        btn.classList.toggle('authenticating', isAuthenticating);
        btn.classList.remove('auth-success', 'auth-failed');
        if (step === 'success') btn.classList.add('auth-success');
        if (step === 'failed')  btn.classList.add('auth-failed');
    });
}

function startDotAnimation(baseText) {
    stopDotAnimation();
    let dotCount = 0;
    _dotTimer = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        getAllButtonTexts().forEach(el => {
            el.textContent = baseText + dots;
        });
    }, 400);
}

function stopDotAnimation() {
    if (_dotTimer) {
        clearInterval(_dotTimer);
        _dotTimer = null;
    }
}

function setAuthStep(step) {
    stopDotAnimation();

    switch (step) {
        case 'idle':
            setAllButtonState(false);
            setAllButtonText(AUTH_STEPS.idle);
            break;

        case 'loading':
            setAllButtonState(true);
            setAllButtonText(AUTH_STEPS.loading);
            startDotAnimation('Memuat');
            break;

        case 'turnstile':
            setAllButtonState(true);
            setAllButtonText(AUTH_STEPS.turnstile);
            startDotAnimation('Memeriksa keamanan');
            break;

        case 'preflight':
            setAllButtonState(true);
            setAllButtonText(AUTH_STEPS.preflight);
            startDotAnimation('Memverifikasi perangkat');
            break;

        case 'connecting':
            setAllButtonState(true);
            setAllButtonText(AUTH_STEPS.connecting);
            startDotAnimation('Menghubungkan ke Google');
            break;

        case 'success':
            setAllButtonState(true, 'success');
            setAllButtonText(AUTH_STEPS.success);
            break;

        case 'failed':
            setAllButtonState(true, 'failed');
            setAllButtonText(AUTH_STEPS.failed);
            break;
    }
}

function showError(message) {
    if (!errorEl) return;
    if (window.Security?.setText) {
        window.Security.setText(errorEl, message);
    } else {
        errorEl.textContent = message;
    }
    errorEl.hidden = false;
    errorEl.focus();
}

function clearError() {
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
    errorEl.classList?.remove('info-message');
}

function setEmailLoading(isLoading) {
    if (!emailButton) return;
    emailButton.disabled = isLoading;
    emailButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    emailButton.textContent = isLoading ? LOADING_LABELS.processing_login : 'Masuk';
    card?.classList.toggle('processing', isLoading);
}

function validateEmailLogin() {
    if (!emailInput || !passwordInput) {
        return 'Form login tidak tersedia di halaman ini.';
    }
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !emailInput.validity.valid) {
        return 'Masukkan email yang valid.';
    }

    if (!password) {
        return 'Masukkan password.';
    }

    return '';
}

async function handleGoogleLogin() {
    if (_authInProgress) return;
    _authInProgress = true;

    clearError();

    let preflightData;
    try {
        setAuthStep('loading');
        await waitForSupabaseReady();

        setAuthStep('turnstile');
        await new Promise(r => setTimeout(r, 300));

        // Preflight is REQUIRED on every page (admin & peserta). Skipping
        // it on login.html previously caused _createUserDocViaServer to
        // throw and silently sign out the user with no message.
        setAuthStep('preflight');
        preflightData = await executePreflightFlow();

    } catch (err) {
        stopDotAnimation();
        setAuthStep('failed');

        const userMessage = err instanceof PreflightError
            ? err.message
            : getErrorMessage(err?.message || 'unknown_error');

        showError(userMessage);
        logAuthError({
            flow: 'user-preflight',
            error: err,
            backendCode: err instanceof PreflightError ? err.backendCode : err?.message,
        });

        setTimeout(() => {
            _authInProgress = false;
            setAuthStep('idle');
        }, 3000);
        return;
    }

    if (!preflightData?.preflightId || !preflightData?.deviceId) {
        setAuthStep('failed');
        showError(getErrorMessage('missing_preflight'));
        clearPreflight();

        setTimeout(() => {
            _authInProgress = false;
            setAuthStep('idle');
        }, 2500);
        return;
    }

    setAuthStep('connecting');

    try {
        // auth/main.js uses redirect mode — this resolves with null when
        // the browser starts the Google redirect. After return,
        // onAuthStateChanged handles the rest. We DON'T reset loading here;
        // the 'auth-ready' / 'auth-completion-error' listener does it.
        await window.Auth.authLogin();

        setAuthStep('success');
    } catch (err) {
        setAuthStep('failed');

        window.UI?.hideAuthLoading?.();

        const isRedirectArtifact = err.message?.includes('null') || err.message?.includes('undefined');
        if (!isRedirectArtifact) {
            logAuthError({
                flow: 'user-login-google',
                error: err,
                backendCode: err.code || err.message,
            });
            const errorCode = err.code || err.message || '';
            showError(getErrorMessage(errorCode));
        }

        setTimeout(() => {
            _authInProgress = false;
            setAuthStep('idle');
        }, 2500);
    }
}

form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const validationMessage = validateEmailLogin();
    if (validationMessage) {
        showError(validationMessage);
        return;
    }

    // v0.821.0: Per-account rate limiting (SEC-A-C2)
    // Client-side defense-in-depth. Server-side (Supabase Auth) has its own limits.
    const email = emailInput.value.trim().toLowerCase();
    const rateCheck = _checkLoginRateLimit(email);
    if (rateCheck.locked) {
        showError(`Terlalu banyak percobaan gagal. Coba lagi dalam ${rateCheck.minutesLeft} menit.`);
        return;
    }

    // v0.821.0: Get Turnstile token (SEC-A-C2 — brute-force protection)
    // The visible Turnstile widget is in the form. Get its token.
    // If Supabase Auth has CAPTCHA enabled in dashboard, it will verify this server-side.
    let captchaToken = null;
    try {
        // turnstile global is loaded via <script> in login.html
        if (typeof turnstile !== 'undefined') {
            // Find the visible Turnstile widget in the form
            const widget = form.querySelector('.cf-turnstile');
            if (widget) {
                // Try getResponse with widget ID (if explicitly rendered)
                // or without (if auto-rendered via data-sitekey)
                const widgetId = widget._turnstileWidgetId;
                captchaToken = widgetId
                    ? turnstile.getResponse(widgetId)
                    : turnstile.getResponse();
            }
        }
    } catch (e) {
        console.warn('[auth] Turnstile token retrieval failed:', e.message);
    }

    if (!captchaToken) {
        showError('Verifikasi keamanan belum selesai. Selesaikan CAPTCHA lalu coba lagi.');
        return;
    }

    setEmailLoading(true);
    window.UI?.showAuthLoading?.(LOADING_LABELS.processing_login);

    try {
        await waitForSupabaseReady();
        const client = window.AlbEdu?.supabase?.client;
        if (!client?.auth?.signInWithPassword) {
            throw new Error('Supabase auth belum tersedia.');
        }

        const { error } = await client.auth.signInWithPassword({
            email: email,
            password: passwordInput.value,
            options: {
                captchaToken: captchaToken,
            },
        });

        if (error) throw error;

        // v0.821.0: Reset failed attempt counter on success
        _clearLoginAttempts(email);

        // No manual redirect here. auth/main.js will receive the auth state
        // change and route by role.
    } catch (err) {
        window.UI?.hideAuthLoading?.();
        setEmailLoading(false);

        // v0.821.0: Track failed attempt (SEC-A-C2)
        const failResult = _recordLoginFailure(email);
        if (failResult.locked) {
            showError(`Login gagal. Akun dikunci sementara — coba lagi dalam ${failResult.minutesLeft} menit.`);
        } else {
            const attemptsLeft = failResult.attemptsLeft;
            const errorMsg = getLoginErrorMessage(err.code || err.message || '');
            if (attemptsLeft > 0 && attemptsLeft <= 2) {
                showError(`${errorMsg} (${attemptsLeft} percobaan tersisa sebelum dikunci.)`);
            } else {
                showError(errorMsg);
            }
        }

        // Reset Turnstile widget so user can verify again
        try {
            if (typeof turnstile !== 'undefined') {
                const widget = form.querySelector('.cf-turnstile');
                const widgetId = widget?._turnstileWidgetId;
                if (widgetId) turnstile.reset(widgetId);
                else turnstile.reset();
            }
        } catch (_) {}

        logAuthError({
            flow: 'admin-login',
            error: err,
            backendCode: err.code || err.message,
        });
    }
});

// ── v0.821.0: Client-side per-account rate limiting (SEC-A-C2) ──────────────
// Tracks failed login attempts per email in localStorage.
// After MAX_FAILED_ATTEMPTS, locks the account for LOCKOUT_MINUTES.
// This is defense-in-depth — server-side (Supabase Auth) has its own limits.
// Client-side can be bypassed (clear localStorage), but it stops casual brute-force.

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 min rolling window

function _loginAttemptKey(email) {
    // Hash email to avoid storing raw email in localStorage key
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
        hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
    }
    return `albedu_login_attempts_${Math.abs(hash).toString(36)}`;
}

function _checkLoginRateLimit(email) {
    try {
        const data = JSON.parse(localStorage.getItem(_loginAttemptKey(email)) || '{}');
        if (data.lockedUntil && Date.now() < data.lockedUntil) {
            const minutesLeft = Math.ceil((data.lockedUntil - Date.now()) / 60000);
            return { locked: true, minutesLeft };
        }
        return { locked: false };
    } catch {
        return { locked: false };
    }
}

function _recordLoginFailure(email) {
    try {
        const key = _loginAttemptKey(email);
        const now = Date.now();
        const data = JSON.parse(localStorage.getItem(key) || '{}');

        // Reset if window expired
        if (data.firstAttemptAt && now - data.firstAttemptAt > ATTEMPT_WINDOW_MS) {
            data.count = 0;
            data.firstAttemptAt = now;
        }
        if (!data.firstAttemptAt) data.firstAttemptAt = now;

        data.count = (data.count || 0) + 1;

        if (data.count >= MAX_FAILED_ATTEMPTS) {
            data.lockedUntil = now + LOCKOUT_MINUTES * 60000;
            localStorage.setItem(key, JSON.stringify(data));
            return { locked: true, minutesLeft: LOCKOUT_MINUTES };
        }

        localStorage.setItem(key, JSON.stringify(data));
        return { locked: false, attemptsLeft: MAX_FAILED_ATTEMPTS - data.count };
    } catch {
        return { locked: false, attemptsLeft: MAX_FAILED_ATTEMPTS };
    }
}

function _clearLoginAttempts(email) {
    try {
        localStorage.removeItem(_loginAttemptKey(email));
    } catch {}
}

btn1?.addEventListener('click', handleGoogleLogin);
btn2?.addEventListener('click', handleGoogleLogin);

const forgotLink = document.getElementById('forgotPasswordLink');
forgotLink?.addEventListener('click', () => {
    const email = emailInput?.value?.trim();
    if (email && emailInput?.validity?.valid) {
        try {
            sessionStorage.setItem('albedu_forgot_email', email);
        } catch (_) {}
    }
});

// auth/main.js dispatches 'auth-completion-error' when user-auth-complete
// returns an error (device_limit_reached, invalid_token, etc).
//
// Previously only index.html (peserta) listened for this event. login.html
// (admin) didn't, so admin users saw no error message on CompletionError.
// This unified listener covers both.
document.addEventListener('auth-completion-error', (e) => {
    const { backendCode, message } = e.detail || {};

    stopDotAnimation();
    setAuthStep('failed');

    showError(message || getErrorMessage(backendCode || 'unknown_error'));

    logAuthError({
        flow: 'user-auth-complete',
        error: new CompletionError(backendCode || 'unknown_error'),
        backendCode,
    });

    setTimeout(() => {
        _authInProgress = false;
        setAuthStep('idle');
    }, 5000);
});

// When _handleAuthStateChange in auth/main.js signOuts the user because of
// a CompletionError, it dispatches 'auth-ready' with role=null. Without
// this listener, the Google button stays in loading/connecting state and
// never resets to idle.
document.addEventListener('auth-ready', (e) => {
    const role = e.detail?.role;
    if (!role) {
        // User signed out (completion error, unverified email, or manual
        // signOut). Reset the Google button to idle.
        stopDotAnimation();
        window.UI?.hideAuthLoading?.();

        // role=null can also fire momentarily before user=null is handled.
        // Tiny delay so we don't interrupt a successful-redirect state.
        setTimeout(() => {
            if (_authInProgress) {
                _authInProgress = false;
                setAuthStep('idle');
            }
        }, 100);
    } else {
        // Role obtained → login succeeded. Keep the button in success state
        // until the redirect happens (1.8s delay) so the user doesn't see
        // a flash of idle before navigating away.
        stopDotAnimation();
        setAuthStep('success');
        _authInProgress = false;
    }
});

// OAuth CALLBACK DETECTION
//
// After Google OAuth redirect, the page reloads. The button is back in idle
// state and there's NO UI feedback while _handleAuthStateChange runs.
// The user sees a static login page for ~50ms–8s (depending on network and
// whether the user row already exists) before being redirected — looks like
// "pilih akun Google, terus gak terjadi apa-apa".
//
// Detect OAuth callback params in the URL (?code= for PKCE flow) and show
// the auth loading overlay IMMEDIATELY on page load. Overlay stays visible
// until:
//   - 'auth-ready' fires with a role → redirect (overlay auto-hides via
//     UI.afterLogin / UI.hideAuthLoading)
//   - 'auth-completion-error' fires → showError + reset UI (listener above
//     already calls window.UI?.hideAuthLoading?.())
//   - 30s safety net fires → show timeout error so user isn't stuck forever
(function _detectOAuthCallback() {
    try {
        // Supabase PKCE flow appends ?code=... to the redirect URL.
        // detectSessionInUrl: true (in supabase-client.js) will consume this
        // and strip it after exchanging for a session, but there's a window
        // where the param is still visible.
        //
        // error_description= is what Supabase appends when the OAuth exchange
        // itself fails (redirect URL mismatch, denied consent, etc.).
        const url = window.location.href;
        const hasOAuthCode = url.includes('code=') || url.includes('error_description=');

        if (!hasOAuthCode) return;

        _authInProgress = true;

        window.UI?.showAuthLoading?.('Menyelesaikan login Google...');

        // Also put the Google button into "connecting" state in case the
        // overlay is slow to render or the user looks at the button.
        setAuthStep('connecting');

        // Safety net: if auth-ready never fires within 30s (Supabase config
        // fetch failed, network died, Edge Function hung), hide the overlay
        // and show an error so the user isn't stuck staring at a spinner.
        setTimeout(() => {
            if (_authInProgress) {
                _authInProgress = false;
                stopDotAnimation();
                window.UI?.hideAuthLoading?.();
                setAuthStep('idle');
                showError('Login Google membutuhkan waktu terlalu lama. Coba muat ulang halaman dan coba lagi.');
            }
        }, 30_000);
    } catch (_) {
        // Best-effort detection — don't break the page if URL parsing fails.
    }
})();

// Pre-warm Turnstile: render the widget as soon as the page is interactive
// so the challenge runs in the BACKGROUND. By the time the user clicks
// "Masuk dengan Google", the token is already cached — no on-demand delay.
//
// Critical for peserta on slow networks where Cloudflare PAT DNS resolution
// can take 5-15s. Pre-warming hides this latency behind the user's reading
// time.
//
// Silent fail: if Turnstile script hasn't loaded yet, prerenderTurnstile()
// retries internally. If pre-warm fails entirely, getFreshTurnstileToken()
// retries on click — pre-warm is best-effort, not required.
const _startPrewarm = () => {
    try {
        prerenderTurnstile().catch(() => {});
    } catch (_) {}
};

if ('requestIdleCallback' in window) {
    window.requestIdleCallback(_startPrewarm, { timeout: 2000 });
} else {
    setTimeout(_startPrewarm, 500);
}
