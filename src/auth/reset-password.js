// =============================================================================
// ResetPassword.js — Production-grade password reset completion flow v2.0
// =============================================================================
//
// STATE MACHINE:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │                                                                 │
//   │   [INIT] ──detectRecoverySession──►  ┌── [FORM] (valid session)│
//   │                                       │                          │
//   │                                       ├── [ERROR] (no session)  │
//   │                                       │                          │
//   │                                       └── [ERROR] (hash error)  │
//   │                                                                  │
//   │   [FORM] ──submit──► [LOADING] ──┐                               │
//   │                                  ├── [SUCCESS] (200 OK)          │
//   │                                  └── [FORM] + error msg          │
//   │                                                                  │
//   └─────────────────────────────────────────────────────────────────┘
//
// FIXES vs v1:
//   - Pakai getResetPasswordErrorMessage() untuk semua error dari updateUser().
//   - Cek recovery marker dari hash DAN query string (PKCE + implicit flow).
//   - Capture marker SEKALI di awal (sebelum Supabase clean URL).
//   - Defense-in-depth storage cleanup setelah success.
//   - SignOut timeout-bounded (4s) supaya UI tidak hang.
//   - Cek `error_description` di hash untuk error Supabase PKCE.
//
// CRITICAL: this function must NEVER auto-redirect to admin/index.html.
// =============================================================================

import {
    getResetPasswordErrorMessage,
    getErrorMessage,
    logAuthError,
    LOADING_LABELS,
    waitForSupabaseReady,
} from './index.js';

// ── DOM references ──────────────────────────────────────────────────────────
const form             = document.getElementById('resetPasswordForm');
const newPasswordInput = document.getElementById('newPassword');
const confirmInput     = document.getElementById('confirmPassword');
const resetBtn         = document.getElementById('resetBtn');
const messageEl        = document.getElementById('resetMessage');
const formContent      = document.getElementById('formContent');
const errorState       = document.getElementById('errorState');
const errorTitle       = document.getElementById('errorTitle');
const errorDesc        = document.getElementById('errorDesc');
const successState     = document.getElementById('successState');
const loginNowBtn      = document.getElementById('loginNowBtn');
const redirectNotice   = document.getElementById('redirectNotice');
const countdownNum     = document.getElementById('countdownNum');
const countdownBar     = document.getElementById('countdownBar');
const strengthWrap     = document.getElementById('passwordStrength');
const strengthText     = document.getElementById('strengthText');

// ── Constants ───────────────────────────────────────────────────────────────
const REDIRECT_SECONDS         = 3;
const LOGIN_URL                = 'login.html';
const BTN_TEXT_DEFAULT         = 'Simpan Kata Sandi Baru';
const BTN_TEXT_LOADING         = LOADING_LABELS.resetting_password;
const RECOVERY_DETECT_RETRIES  = 3;
const RECOVERY_DETECT_RETRY_MS = 800;
const SIGNOUT_TIMEOUT_MS       = 4_000;

// ── State ───────────────────────────────────────────────────────────────────
let isSubmitting   = false;
let _redirectTimerId = null;

// ── DOM: button text reference ──────────────────────────────────────────────
const btnTextEl = resetBtn?.querySelector('.btn-text');

// =============================================================================
// UI helpers
// =============================================================================

function showMessage(text, type = 'error') {
    if (!messageEl) return;
    messageEl.textContent = text || '';
    messageEl.hidden = !text;
    messageEl.className = `message message-${type}`;
    if (text) {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageEl.focus();
    }
}

function clearMessage() {
    if (!messageEl) return;
    messageEl.textContent = '';
    messageEl.hidden = true;
    messageEl.className = 'message message-error';
}

function setLoading(loading) {
    if (!resetBtn) return;
    resetBtn.disabled = loading;
    resetBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loading) {
        resetBtn.classList.add('loading');
        if (btnTextEl) btnTextEl.textContent = BTN_TEXT_LOADING;
    } else {
        resetBtn.classList.remove('loading');
        if (btnTextEl) btnTextEl.textContent = BTN_TEXT_DEFAULT;
    }
}

function showFormState() {
    if (formContent)   formContent.classList.remove('hidden');
    if (errorState)    errorState.classList.remove('visible');
    if (successState)  successState.classList.remove('visible');
}

function showErrorState(title, desc) {
    if (formContent)   formContent.classList.add('hidden');
    if (errorState)    errorState.classList.add('visible');
    if (successState)  successState.classList.remove('visible');
    if (errorTitle)    errorTitle.textContent = title || 'Link Tidak Valid';
    if (errorDesc)     errorDesc.textContent  = desc  || 'Link reset kata sandi sudah kadaluarsa atau tidak valid. Silakan minta link reset baru.';
}

function showSuccessState() {
    if (formContent)   formContent.classList.add('hidden');
    if (errorState)    errorState.classList.remove('visible');
    if (successState)  successState.classList.add('visible');
    startRedirectCountdown();
}

// =============================================================================
// Defense-in-depth storage cleanup
// =============================================================================

// Supabase JS SDK persists auth state in localStorage under keys shaped like:
//   sb-<project-ref>-auth-token
// plus optional per-provider OAuth state keys. After signOut() these SHOULD be
// gone, but in some edge cases (signOut timeout, network failure, certain
// browser privacy modes) stale entries persist — and that's the root cause of
// the auto-login bug. This function manually scrubs those keys as a fallback.
function _clearSupabaseStorage() {
    try {
        // Remove Supabase auth-token entries (sb-<ref>-auth-token)
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('sb-') && key.includes('auth-token'))) {
                toRemove.push(key);
            }
        }
        toRemove.forEach(k => {
            try { localStorage.removeItem(k); } catch (_) {}
        });

        // Also clear any AlbEdu-specific auth markers in sessionStorage
        const sessionKeys = [
            'albedu_user_auth_preflight',
            'albedu_forgot_email',
            'albedu_reset_requested_at',
            'albedu_reset_last_status',
            'albedu_reset_last_email',
        ];
        sessionKeys.forEach(k => {
            try { sessionStorage.removeItem(k); } catch (_) {}
        });
    } catch (_) {
        // Storage may be disabled (private mode) — best-effort only.
    }
}

// =============================================================================
// Password strength
// =============================================================================

function evaluateStrength(password) {
    if (!password) return { level: '', label: '' };

    let score = 0;
    if (password.length >= 8)  score += 1;
    if (password.length >= 12) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;

    if (score <= 2) return { level: 'strength-weak',  label: 'Lemah' };
    if (score <= 3) return { level: 'strength-fair',  label: 'Cukup' };
    if (score <= 4) return { level: 'strength-good',  label: 'Baik' };
    return              { level: 'strength-strong', label: 'Kuat' };
}

function updateStrengthIndicator() {
    if (!newPasswordInput || !strengthWrap || !strengthText) return;

    const password = newPasswordInput.value;
    if (!password) {
        strengthWrap.hidden = true;
        strengthText.hidden = true;
        strengthWrap.className = 'password-strength';
        return;
    }

    const { level, label } = evaluateStrength(password);
    strengthWrap.hidden = false;
    strengthText.hidden = false;
    strengthWrap.className = `password-strength ${level}`;
    strengthText.textContent = label;
}

// =============================================================================
// Toggle visibility
// =============================================================================

function setupToggleVisibility() {
    document.querySelectorAll('.toggle-visibility').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const input = document.getElementById(targetId);
            if (!input) return;

            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';

            const eyeIcon = btn.querySelector('.icon-eye');
            const eyeOffIcon = btn.querySelector('.icon-eye-off');
            if (eyeIcon) eyeIcon.style.display = isPassword ? 'none' : 'block';
            if (eyeOffIcon) eyeOffIcon.style.display = isPassword ? 'block' : 'none';

            btn.setAttribute('aria-label', isPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
        });
    });
}

// =============================================================================
// Form validation
// =============================================================================

function validateForm() {
    const newPassword = newPasswordInput?.value || '';
    const confirmPassword = confirmInput?.value || '';

    if (!newPassword) {
        return 'Masukkan kata sandi baru.';
    }
    if (newPassword.length < 8) {
        return 'Kata sandi minimal 8 karakter.';
    }
    if (!confirmPassword) {
        return 'Konfirmasi kata sandi Anda.';
    }
    if (newPassword !== confirmPassword) {
        return 'Kata sandi dan konfirmasi tidak sama.';
    }

    return '';
}

// =============================================================================
// Parse URL errors dari Supabase
// =============================================================================

// Supabase me-return error di URL dengan beberapa format:
//
//   Implicit flow (lama):
//     #error=access_denied&error_code=otp_expired&error_description=...
//
//   PKCE flow (default sejak Supabase JS v2.39):
//     ?error=access_denied&error_code=otp_expired&error_description=...
//     atau:
//     #error=access_denied&error_code=otp_expired&error_description=...
//
// Kita parse KEDUA lokasi (hash + query) untuk kompatibilitas penuh.
function _parseSupabaseErrorFromUrl() {
    const locations = [window.location.hash, window.location.search];

    for (const loc of locations) {
        if (!loc || !(loc.startsWith('#') || loc.startsWith('?'))) continue;
        const params = new URLSearchParams(loc.slice(1)); // buang '#' atau '?'
        const error = params.get('error');
        const errorCode = params.get('error_code');
        const errorDescription = params.get('error_description');
        if (error) {
            return { error, errorCode, errorDescription };
        }
    }
    return null;
}

function handleUrlError(urlErr) {
    const { errorCode, errorDescription } = urlErr;

    logAuthError({
        flow: 'reset-password-detect',
        error: new Error(errorDescription || errorCode || 'unknown url error'),
        backendCode: errorCode,
    });

    // Bersihkan hash & query dari URL supaya user gak bookmark URL berisi error
    if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
    }

    // Map errorCode ke pesan user-friendly
    const friendlyMessage = getResetPasswordErrorMessage(errorCode || errorDescription || '');
    const title = _getErrorTitle(errorCode);

    showErrorState(title, friendlyMessage);
}

function _getErrorTitle(errorCode) {
    if (!errorCode) return 'Link Tidak Valid';
    const lower = errorCode.toLowerCase();
    if (lower.includes('expired')) return 'Link Sudah Kadaluarsa';
    if (lower.includes('invalid')) return 'Link Tidak Valid';
    if (lower.includes('access_denied')) return 'Akses Ditolak';
    return 'Link Tidak Valid';
}

// =============================================================================
// Detect recovery session (PKCE-aware)
// =============================================================================

// Check both hash AND query string for recovery markers (PKCE + implicit flow).
function _hasRecoveryMarker() {
    const hash  = window.location.hash  || '';
    const query = window.location.search || '';
    // Implicit flow markers (in hash)
    if (hash.includes('type=recovery') || hash.includes('access_token')) return true;
    // PKCE flow markers (in query string)
    if (query.includes('type=recovery') || query.includes('code='))      return true;
    return false;
}

async function _tryGetSessionWithRetry() {
    for (let attempt = 1; attempt <= RECOVERY_DETECT_RETRIES; attempt++) {
        try {
            const { data, error } = await window.sb.auth.getSession();
            if (error) {
                console.warn(`[ResetPassword] getSession attempt ${attempt} error:`, error.message);
                return { session: null, error };
            }
            if (data?.session) {
                return { session: data.session, error: null };
            }
        } catch (err) {
            console.warn(`[ResetPassword] getSession attempt ${attempt} threw:`, err?.message);
        }
        // Wait before next probe (skip wait after last attempt)
        if (attempt < RECOVERY_DETECT_RETRIES) {
            await new Promise(r => setTimeout(r, RECOVERY_DETECT_RETRY_MS));
        }
    }
    return { session: null, error: null };
}

/**
 * Detect recovery session.
 *
 * Production-grade recovery detection (PKCE-aware):
 *   1. Capture recovery marker from URL IMMEDIATELY (before Supabase
 *      auto-exchange cleans the URL). Marker can be in:
 *        - Hash fragment (legacy implicit flow): #access_token=xxx&type=recovery
 *        - Query string (PKCE flow, default since Supabase JS v2.39):
 *          ?code=xxx&type=recovery
 *   2. If Supabase returned an error in URL, show the appropriate error.
 *   3. Wait for Supabase, then probe getSession() up to RECOVERY_DETECT_RETRIES
 *      times. Supabase's auto-detection is asynchronous.
 *   4. If the URL had a recovery marker but no session is established after
 *      all retries, the link is invalid/expired → show clear error.
 *   5. If a session exists and the URL had a recovery marker → show the form.
 *   6. If a session exists but NO recovery marker (user navigated here
 *      directly while logged in) → sign out and show "Link Diperlukan".
 */
async function detectRecoverySession() {
    // STEP 0: Capture recovery marker ONCE at function entry — BEFORE Supabase
    // SDK has a chance to exchange the code and clean the URL. This is critical
    // for PKCE flow where ?code= is removed after auto-exchange.
    const hadRecoveryMarkerAtLoad = _hasRecoveryMarker();

    try {
        // STEP 1: Check URL for Supabase error markers FIRST.
        // URL is available immediately on page load, no need to wait for SDK.
        const urlErr = _parseSupabaseErrorFromUrl();
        if (urlErr) {
            handleUrlError(urlErr);
            return;
        }

        // STEP 2: Wait for Supabase SDK to be ready.
        await waitForSupabaseReady();

        // STEP 3: If a non-recovery session already exists AND the user did
        // NOT come from a recovery link, sign out to give the recovery flow a
        // clean slate.
        if (!hadRecoveryMarkerAtLoad) {
            const initialProbe = await window.sb.auth.getSession();
            if (initialProbe.data?.session) {
                try {
                    await window.sb.auth.signOut();
                    await new Promise(r => setTimeout(r, 300));
                } catch (signOutErr) {
                    console.warn('[ResetPassword] pre-detection signOut failed:', signOutErr?.message);
                }
            }
        }

        // STEP 4: Probe for session. If URL had a recovery marker, retry
        // a few times because Supabase's async hash/code consumption may lag.
        const { session, error } = await _tryGetSessionWithRetry();

        if (error) {
            const friendly = getResetPasswordErrorMessage(error.message || error.code || '');
            showErrorState('Link Tidak Valid', friendly);
            return;
        }

        if (!session) {
            // No session established. If the URL had a recovery marker at
            // load, the link is invalid/expired. Otherwise the user navigated
            // here directly without a reset link.
            if (hadRecoveryMarkerAtLoad) {
                showErrorState(
                    'Link Sudah Kadaluarsa',
                    getResetPasswordErrorMessage('otp_expired')
                );
            } else {
                showErrorState(
                    'Link Diperlukan',
                    'Halaman ini hanya bisa diakses melalui link reset kata sandi yang dikirim ke email Anda. Silakan minta link reset baru.'
                );
            }
            return;
        }

        // STEP 5: We have a session. If the URL had a recovery marker at
        // load (either hash for implicit flow or ?code= for PKCE), this is
        // a legitimate recovery flow — show the form.
        if (hadRecoveryMarkerAtLoad) {
            showFormState();
            return;
        }

        // Session exists but NO recovery marker at load — treat as invalid
        // direct access. Sign out so we don't leave a dangling session.
        try {
            await window.sb.auth.signOut();
        } catch (_) {}
        showErrorState(
            'Link Diperlukan',
            'Halaman ini hanya bisa diakses melalui link reset kata sandi yang dikirim ke email Anda. Silakan minta link reset baru.'
        );

    } catch (err) {
        console.error('[ResetPassword] detection failed:', err);
        logAuthError({
            flow: 'reset-password-detect',
            error: err,
            backendCode: err.message,
        });
        showErrorState(
            'Terjadi Kesalahan',
            'Tidak dapat memverifikasi link reset. Silakan muat ulang halaman atau minta link reset baru.'
        );
    }
}

// =============================================================================
// Submit handler
// =============================================================================

async function handleSubmit(event) {
    event.preventDefault();
    clearMessage();

    if (isSubmitting) return;

    // Client-side validation
    const validationError = validateForm();
    if (validationError) {
        showMessage(validationError);
        return;
    }

    isSubmitting = true;
    setLoading(true);

    try {
        await waitForSupabaseReady();

        if (!window.sb?.auth?.updateUser) {
            throw new Error('Sistem autentikasi belum siap. Silakan muat ulang halaman.');
        }

        // Cek session sekali lagi sebelum updateUser — session mungkin sudah
        // expired antara detect & submit (race condition).
        const { data: sessionCheck } = await window.sb.auth.getSession();
        if (!sessionCheck?.session) {
            showErrorState(
                'Link Kadaluarsa',
                getResetPasswordErrorMessage('session_missing')
            );
            return;
        }

        const newPassword = newPasswordInput.value;

        const { error } = await window.sb.auth.updateUser({
            password: newPassword,
        });

        if (error) {
            const errorCode = error.message || error.code || 'unknown_error';
            const friendlyMessage = getResetPasswordErrorMessage(errorCode);

            logAuthError({
                flow: 'reset-password',
                error,
                backendCode: errorCode,
            });

            // Tampilkan pesan error
            // Untuk error yang berhubungan dengan token/session expired,
            // tampilkan error state (bukan form message) karena user perlu
            // minta link baru.
            const lower = errorCode.toLowerCase();
            if (lower.includes('expired') ||
                lower.includes('token') ||
                lower.includes('session') ||
                lower.includes('user not found')) {
                showErrorState(_getErrorTitle(lower), friendlyMessage);
            } else {
                // Error validasi password (weak, same, dll) → tampilkan di form
                showMessage(friendlyMessage);
            }
            return;
        }

        // ── Success ─────────────────────────────────────────────────────
        // Sign out the recovery session so it can't be reused.
        // Use a timeout-bounded signOut: if Supabase is slow/unreachable,
        // we still proceed and clear local storage manually.
        try {
            await Promise.race([
                window.sb.auth.signOut(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('signOut timeout')), SIGNOUT_TIMEOUT_MS)
                ),
            ]);
        } catch (signOutErr) {
            console.warn('[ResetPassword] signOut failed (non-fatal):', signOutErr?.message);
            _clearSupabaseStorage();
        }

        // Always clear local storage as defense-in-depth — signOut()
        // sometimes leaves stale entries in localStorage on certain browsers.
        _clearSupabaseStorage();

        // Bersihkan hash & query dari URL untuk keamanan
        if (window.history?.replaceState) {
            window.history.replaceState(null, '', window.location.pathname);
        }

        showSuccessState();

    } catch (err) {
        logAuthError({
            flow: 'reset-password',
            error: err,
            backendCode: err.message,
        });

        // Untuk network error & error lain yang throw (bukan return),
        // tampilkan pesan spesifik via mapper
        const friendly = getResetPasswordErrorMessage(err.message || 'unknown_error');

        if (err.message?.includes('belum siap')) {
            showMessage(err.message);
        } else if (err.message?.includes('Failed to fetch') ||
                   err.message?.includes('NetworkError') ||
                   err.message?.includes('network')) {
            showMessage(friendly);
        } else {
            showMessage(friendly);
        }
    } finally {
        isSubmitting = false;
        setLoading(false);
    }
}

// =============================================================================
// Redirect countdown
// =============================================================================

function startRedirectCountdown() {
    let remaining = REDIRECT_SECONDS;

    if (countdownNum) countdownNum.textContent = remaining;

    // Animate countdown bar
    if (countdownBar) {
        countdownBar.style.transform = 'scaleX(1)';
        countdownBar.style.transition = `transform ${REDIRECT_SECONDS}s linear`;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                countdownBar.style.transform = 'scaleX(0)';
            });
        });
    }

    if (_redirectTimerId) clearInterval(_redirectTimerId);
    _redirectTimerId = setInterval(() => {
        remaining -= 1;
        if (countdownNum) countdownNum.textContent = remaining;

        if (remaining <= 0) {
            clearInterval(_redirectTimerId);
            _redirectTimerId = null;
            if (redirectNotice) redirectNotice.textContent = 'Mengarahkan…';
            window.location.replace(LOGIN_URL);
        }
    }, 1000);

    // Cancel timer jika user klik login manual
    loginNowBtn?.addEventListener('click', () => {
        if (_redirectTimerId) {
            clearInterval(_redirectTimerId);
            _redirectTimerId = null;
        }
        if (redirectNotice) redirectNotice.hidden = true;
    });
}

// =============================================================================
// Init
// =============================================================================

form?.addEventListener('submit', handleSubmit);
newPasswordInput?.addEventListener('input', updateStrengthIndicator);
setupToggleVisibility();

// Sembunyikan form sampai recovery session terdeteksi
if (formContent) formContent.classList.add('hidden');

// Deteksi recovery session
detectRecoverySession();
