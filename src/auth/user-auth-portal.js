// =============================================================================
// UserAuthPortal.js — Unified Google + email/password login page behaviour
// =============================================================================
//
// Satu modul yang melayani KEDUA halaman auth:
//   - index.html (landing page peserta)  → tombol #userLoginBtn / #userLoginBtn2
//   - login.html (admin login page)      → tombol #userLoginBtn + form #emailLoginForm
//
// FLOW (SAMA untuk admin & peserta — FIX BUG #1, #2, #3, #4):
//   1. Klik "Masuk dengan Google"
//   2. waitForSupabaseReady()
//   3. executePreflightFlow() — butuh container #userTurnstile + Turnstile token
//      + DeviceFingerprint → simpan ke sessionStorage[albedu_user_auth_preflight]
//   4. window.Auth.authLogin() → Google OAuth redirect
//   5. onAuthStateChanged di auth.js → _syncUserDocument → _createUserDocViaServer
//      (baca preflight → invoke Supabase Function user-auth-complete)
//   6. Sukses → redirect ke dashboard sesuai role (admin/peserta)
//      Gagal (CompletionError) → dispatch 'auth-completion-error' → reset UI
//
// Email/password form (hanya di login.html) tetap didukung sebagai alternatif
// admin login — TIDAK melalui preflight (langsung signInWithPassword).
// =============================================================================

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

// ── Step labels untuk animasi Google button ──────────────────────────────────
const AUTH_STEPS = {
    idle:       'Masuk dengan Google',
    loading:    'Memuat...',
    turnstile:  'Memeriksa keamanan...',
    preflight:  'Memverifikasi perangkat...',
    connecting: 'Menghubungkan ke Google...',
    success:    'Berhasil!',
    failed:     'Gagal!',
};

// ── Element references (null-safe; halaman mungkin tidak punya semuanya) ─────
// Tombol Google di index.html: #userLoginBtn (hero) + #userLoginBtn2 (CTA bottom)
// Tombol Google di login.html: #userLoginBtn (single, biasanya dipakai ulang)
const btn1     = document.getElementById('userLoginBtn');
const btn1Text = document.getElementById('userLoginText');
const btn2     = document.getElementById('userLoginBtn2');
const btn2Text = document.getElementById('userLoginText2');

// Form email/password (hanya di login.html)
const form           = document.getElementById('emailLoginForm');
const emailInput     = document.getElementById('email');
const passwordInput  = document.getElementById('password');
const emailButton    = document.getElementById('emailLoginBtn');
const errorEl        = document.getElementById('errorMessage')
    ?? document.getElementById('portalMessage');  // index.html pakai #portalMessage
const card           = document.querySelector('.login-card');
const yearEl         = document.getElementById('currentYear')
    ?? document.getElementById('footerYear');

if (yearEl) yearEl.textContent = new Date().getFullYear();

// ── State ────────────────────────────────────────────────────────────────────
let _authInProgress = false;
let _dotTimer = null;

// ===========================================================================
// Helpers — Google button UI
// ===========================================================================

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

// ===========================================================================
// Helpers — error display & email form
// ===========================================================================

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

// ===========================================================================
// Main Google auth handler — UNIFIED untuk admin & peserta
// ===========================================================================

async function handleGoogleLogin() {
    // Double-click guard
    if (_authInProgress) return;
    _authInProgress = true;

    clearError();

    let preflightData;
    try {
        // Step 1: Tunggu Supabase siap dulu — ini async, tidak boleh skip
        setAuthStep('loading');
        await waitForSupabaseReady();

        // Step 2: Turnstile verification (visual feedback only)
        setAuthStep('turnstile');
        await new Promise(r => setTimeout(r, 300));

        // Step 3: Preflight validation (Turnstile + device check) — WAJIB
        // untuk SEMUA halaman (admin & peserta). FIX BUG #1: sebelumnya
        // login.html skip preflight → _createUserDocViaServer throw error
        // dan user di-signOut diam-diam tanpa pesan.
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

        // Auto-reset setelah 3 detik agar user bisa baca pesan error
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

    // Step 4: Connecting to Google
    setAuthStep('connecting');

    try {
        // auth.js pakai redirect mode — await ini resolve dengan null saat
        // browser mulai redirect ke Google. Setelah kembali, onAuthStateChanged
        // yang menangani sisanya. Kita TIDAK reset loading di sini; biarkan
        // listener 'auth-ready' / 'auth-completion-error' yang reset.
        await window.Auth.authLogin();

        // Step 5: Sukses — set state success. auth.js akan handle redirect
        // via onAuthStateChanged. Tombol tetap di state success sampai
        // redirect selesai.
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

        // Auto-reset setelah 2.5 detik
        setTimeout(() => {
            _authInProgress = false;
            setAuthStep('idle');
        }, 2500);
    }
}

// ===========================================================================
// Email/password form (hanya di login.html) — alternatif admin login
// ===========================================================================

form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const validationMessage = validateEmailLogin();
    if (validationMessage) {
        showError(validationMessage);
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
            email: emailInput.value.trim(),
            password: passwordInput.value,
        });

        if (error) throw error;
        // No manual redirect here. auth.js will receive the auth state change and route by role.
    } catch (err) {
        window.UI?.hideAuthLoading?.();
        setEmailLoading(false);

        logAuthError({
            flow: 'admin-login',
            error: err,
            backendCode: err.code || err.message,
        });

        const errorCode = err.code || err.message || '';
        const friendlyMessage = getLoginErrorMessage(errorCode);
        showError(friendlyMessage);
    }
});

// ===========================================================================
// Event listeners — Google buttons (semua tombol Google pakai ID userLoginBtn*)
// ===========================================================================

btn1?.addEventListener('click', handleGoogleLogin);
btn2?.addEventListener('click', handleGoogleLogin);

// ===========================================================================
// "Lupa Kata Sandi?" link — pre-fill email ke sessionStorage
// ===========================================================================

const forgotLink = document.getElementById('forgotPasswordLink');
forgotLink?.addEventListener('click', () => {
    const email = emailInput?.value?.trim();
    if (email && emailInput?.validity?.valid) {
        try {
            sessionStorage.setItem('albedu_forgot_email', email);
        } catch (_) {}
    }
});

// ===========================================================================
// Completion error listener — FIX BUG #2
// auth.js dispatches 'auth-completion-error' when user-auth-complete
// returns an error (e.g. device_limit_reached, invalid_token).
//
// Sebelumnya hanya halaman peserta (index.html) yang dengarkan event ini.
// Halaman admin (login.html) TIDAK punya listener → user di login.html nggak
// lihat pesan error kalau CompletionError terjadi. Sekarang UserAuthPortal.js
// (unified) dengarkan event ini di SEMUA halaman.
// ===========================================================================

document.addEventListener('auth-completion-error', (e) => {
    const { backendCode, message } = e.detail || {};

    stopDotAnimation();
    setAuthStep('failed');

    // message is already user-friendly (mapped by CompletionError in auth.js)
    showError(message || getErrorMessage(backendCode || 'unknown_error'));

    logAuthError({
        flow: 'user-auth-complete',
        error: new CompletionError(backendCode || 'unknown_error'),
        backendCode,
    });

    // Auto-reset after 5s — give user time to read the specific error
    setTimeout(() => {
        _authInProgress = false;
        setAuthStep('idle');
    }, 5000);
});

// ===========================================================================
// FIX BUG #3 — auth-ready listener dengan role null (sign-out akibat error)
// Saat _handleAuthStateChange di auth.js signOut user karena CompletionError,
// ia dispatch 'auth-ready' dengan role=null. Tanpa listener ini, tombol Google
// tetap di state loading/connecting dan tidak pernah reset ke idle.
// ===========================================================================

document.addEventListener('auth-ready', (e) => {
    const role = e.detail?.role;
    if (!role) {
        // User di-signOut (baik karena error completion, email belum verifikasi,
        // atau signOut manual). Reset UI Google button ke idle.
        stopDotAnimation();
        window.UI?.hideAuthLoading?.();

        // Hanya reset kalau tidak sedang dalam redirect sukses (role=null bisa
        // juga terjadi sesaat sebelum user=null di-handle — gunakan timer
        // kecil agar tidak mengganggu success state.
        setTimeout(() => {
            if (_authInProgress) {
                _authInProgress = false;
                setAuthStep('idle');
            }
        }, 100);
    } else {
        // Role didapat → login sukses. Pastikan button di state success.
        stopDotAnimation();
        setAuthStep('success');
    }
});
