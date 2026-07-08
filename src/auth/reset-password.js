// reset-password.js — password reset completion flow (POST link click)
//
// NEVER auto-redirect to admin/index.html from this page — the user is here
// because they clicked a reset link, and they should land on login.html
// after we update the password.

import {
    getResetPasswordErrorMessage,
    getErrorMessage,
    logAuthError,
    LOADING_LABELS,
    waitForSupabaseReady,
} from './index.js';

const t = (key, vars, fallback) => fallback;

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

const REDIRECT_SECONDS         = 3;
const LOGIN_URL                = 'login.html';
const BTN_TEXT_DEFAULT         = 'Simpan Kata Sandi Baru';
const BTN_TEXT_LOADING         = LOADING_LABELS.resetting_password;
const RECOVERY_DETECT_RETRIES  = 3;
const RECOVERY_DETECT_RETRY_MS = 800;
const SIGNOUT_TIMEOUT_MS       = 4_000;

let isSubmitting   = false;
let _redirectTimerId = null;

const btnTextEl = resetBtn?.querySelector('.btn-text');

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
    if (errorTitle)    errorTitle.textContent = title || t('auth.reset.error_title', null, 'Link Tidak Valid');
    if (errorDesc)     errorDesc.textContent  = desc  || t('auth.reset.error_desc', null, 'Link reset kata sandi sudah kadaluarsa atau tidak valid. Silakan minta link reset baru.');
}

function showSuccessState() {
    if (formContent)   formContent.classList.add('hidden');
    if (errorState)    errorState.classList.remove('visible');
    if (successState)  successState.classList.add('visible');
    startRedirectCountdown();
}

// Supabase JS SDK persists auth state in localStorage under keys shaped like:
//   sb-<project-ref>-auth-token
// plus optional per-provider OAuth state keys. After signOut() these SHOULD
// be gone, but in some edge cases (signOut timeout, network failure, certain
// browser privacy modes) stale entries persist — and that's the root cause
// of the auto-login bug. Manually scrub those keys as a fallback.
function _clearSupabaseStorage() {
    try {
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

function validateForm() {
    const newPassword = newPasswordInput?.value || '';
    const confirmPassword = confirmInput?.value || '';

    if (!newPassword) {
        return t('auth.reset.password_required', null, 'Masukkan kata sandi baru.');
    }
    if (newPassword.length < 8) {
        return t('auth.reset.password_too_short', null, 'Kata sandi minimal 8 karakter.');
    }
    if (!confirmPassword) {
        return t('auth.reset.confirm_required', null, 'Konfirmasi kata sandi Anda.');
    }
    if (newPassword !== confirmPassword) {
        return t('auth.reset.password_mismatch', null, 'Kata sandi dan konfirmasi tidak sama.');
    }

    return '';
}

// Supabase returns errors in the URL in several formats:
//
//   Implicit flow (legacy):
//     #error=access_denied&error_code=otp_expired&error_description=...
//
//   PKCE flow (default since Supabase JS v2.39):
//     ?error=access_denied&error_code=otp_expired&error_description=...
//     or:
//     #error=access_denied&error_code=otp_expired&error_description=...
//
// Parse BOTH locations (hash + query) for full compatibility.
function _parseSupabaseErrorFromUrl() {
    const locations = [window.location.hash, window.location.search];

    for (const loc of locations) {
        if (!loc || !(loc.startsWith('#') || loc.startsWith('?'))) continue;
        const params = new URLSearchParams(loc.slice(1)); // strip '#' or '?'
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

    // Clean hash & query so the user doesn't bookmark a URL with errors in it.
    if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
    }

    const friendlyMessage = getResetPasswordErrorMessage(errorCode || errorDescription || '');
    const title = _getErrorTitle(errorCode);

    showErrorState(title, friendlyMessage);
}

function _getErrorTitle(errorCode) {
    if (!errorCode) return t('auth.reset.error_title', null, 'Link Tidak Valid');
    const lower = errorCode.toLowerCase();
    if (lower.includes('expired')) return t('auth.reset.link_expired', null, 'Link Sudah Kadaluarsa');
    if (lower.includes('invalid')) return t('auth.reset.error_title', null, 'Link Tidak Valid');
    if (lower.includes('access_denied')) return 'Akses Ditolak';
    return t('auth.reset.error_title', null, 'Link Tidak Valid');
}

// Check both hash AND query string for recovery markers (PKCE + implicit flow).
function _hasRecoveryMarker() {
    const hash  = window.location.hash  || '';
    const query = window.location.search || '';
    if (hash.includes('type=recovery') || hash.includes('access_token')) return true;
    if (query.includes('type=recovery') || query.includes('code='))      return true;
    return false;
}

async function _tryGetSessionWithRetry() {
    for (let attempt = 1; attempt <= RECOVERY_DETECT_RETRIES; attempt++) {
        try {
            const { data, error } = await window.AlbEdu?.supabase?.client.auth.getSession();
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
        if (attempt < RECOVERY_DETECT_RETRIES) {
            await new Promise(r => setTimeout(r, RECOVERY_DETECT_RETRY_MS));
        }
    }
    return { session: null, error: null };
}

// Detect recovery session (PKCE-aware).
//
//   1. Capture recovery marker from URL IMMEDIATELY (before Supabase
//      auto-exchange cleans the URL). Marker can be in:
//        - Hash (legacy implicit): #access_token=xxx&type=recovery
//        - Query (PKCE, default since Supabase JS v2.39): ?code=xxx&type=recovery
//   2. If Supabase returned an error in URL, show the appropriate error.
//   3. Wait for Supabase, then probe getSession() up to RECOVERY_DETECT_RETRIES
//      times. Supabase's auto-detection is asynchronous.
//   4. If URL had a recovery marker but no session is established after all
//      retries, the link is invalid/expired → show clear error.
//   5. If a session exists and URL had a recovery marker → show the form.
//   6. If a session exists but NO recovery marker (user navigated here
//      directly while logged in) → sign out and show "Link Diperlukan".
async function detectRecoverySession() {
    // Capture recovery marker ONCE at function entry — BEFORE Supabase SDK
    // has a chance to exchange the code and clean the URL. Critical for
    // PKCE flow where ?code= is removed after auto-exchange.
    const hadRecoveryMarkerAtLoad = _hasRecoveryMarker();

    try {
        const urlErr = _parseSupabaseErrorFromUrl();
        if (urlErr) {
            handleUrlError(urlErr);
            return;
        }

        await waitForSupabaseReady();

        if (!hadRecoveryMarkerAtLoad) {
            const initialProbe = await window.AlbEdu?.supabase?.client.auth.getSession();
            if (initialProbe.data?.session) {
                try {
                    await window.AlbEdu?.supabase?.client.auth.signOut();
                    await new Promise(r => setTimeout(r, 300));
                } catch (signOutErr) {
                    console.warn('[ResetPassword] pre-detection signOut failed:', signOutErr?.message);
                }
            }
        }

        // Probe for session. If URL had a recovery marker, retry a few
        // times because Supabase's async hash/code consumption may lag.
        const { session, error } = await _tryGetSessionWithRetry();

        if (error) {
            const friendly = getResetPasswordErrorMessage(error.message || error.code || '');
            showErrorState('Link Tidak Valid', friendly);
            return;
        }

        if (!session) {
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

        if (hadRecoveryMarkerAtLoad) {
            showFormState();
            return;
        }

        // Session exists but NO recovery marker at load — treat as invalid
        // direct access. Sign out so we don't leave a dangling session.
        try {
            await window.AlbEdu?.supabase?.client.auth.signOut();
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

async function handleSubmit(event) {
    event.preventDefault();
    clearMessage();

    if (isSubmitting) return;

    const validationError = validateForm();
    if (validationError) {
        showMessage(validationError);
        return;
    }

    isSubmitting = true;
    setLoading(true);

    try {
        await waitForSupabaseReady();

        if (!window.AlbEdu?.supabase?.client?.auth?.updateUser) {
            throw new Error('Sistem autentikasi belum siap. Silakan muat ulang halaman.');
        }

        // Re-check session right before updateUser — session may have
        // expired between detect & submit (race condition).
        const { data: sessionCheck } = await window.AlbEdu?.supabase?.client.auth.getSession();
        if (!sessionCheck?.session) {
            showErrorState(
                'Link Kadaluarsa',
                getResetPasswordErrorMessage('session_missing')
            );
            return;
        }

        const newPassword = newPasswordInput.value;

        const { error } = await window.AlbEdu?.supabase?.client.auth.updateUser({
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

            // Token/session-expired errors go to errorState (user needs a
            // new link); password-validation errors stay on the form.
            const lower = errorCode.toLowerCase();
            if (lower.includes('expired') ||
                lower.includes('token') ||
                lower.includes('session') ||
                lower.includes('user not found')) {
                showErrorState(_getErrorTitle(lower), friendlyMessage);
            } else {
                showMessage(friendlyMessage);
            }
            return;
        }

        // Success — sign out the recovery session so it can't be reused.
        // Timeout-bounded: if Supabase is slow/unreachable we still proceed
        // and clear local storage manually.
        try {
            await Promise.race([
                window.AlbEdu?.supabase?.client.auth.signOut(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('signOut timeout')), SIGNOUT_TIMEOUT_MS)
                ),
            ]);
        } catch (signOutErr) {
            console.warn('[ResetPassword] signOut failed (non-fatal):', signOutErr?.message);
            _clearSupabaseStorage();
        }

        // Always scrub local storage — signOut() sometimes leaves stale
        // entries on certain browsers.
        _clearSupabaseStorage();

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

function startRedirectCountdown() {
    let remaining = REDIRECT_SECONDS;

    if (countdownNum) countdownNum.textContent = remaining;

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
            if (redirectNotice) redirectNotice.textContent = t('auth.register_success.redirecting', null, 'Mengarahkan…');
            window.location.replace(LOGIN_URL);
        }
    }, 1000);

    loginNowBtn?.addEventListener('click', () => {
        if (_redirectTimerId) {
            clearInterval(_redirectTimerId);
            _redirectTimerId = null;
        }
        if (redirectNotice) redirectNotice.hidden = true;
    });
}

form?.addEventListener('submit', handleSubmit);
newPasswordInput?.addEventListener('input', updateStrengthIndicator);
setupToggleVisibility();

if (formContent) formContent.classList.add('hidden');

detectRecoverySession();
