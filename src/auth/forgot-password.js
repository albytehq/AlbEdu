// forgot-password.js — password reset request flow
//
// Flow: FORM → LOADING → SUCCESS (60s cooldown, resend button) or ERROR
// (rate-limit / network / SMTP). On "user not found" / "email not confirmed"
// we still show SUCCESS for anti-enumeration (see shouldSuppressForgotPasswordError
// in errorMapper.js).
//
// Persisted state in sessionStorage survives page refresh so a successful
// request doesn't fake-success on reload.

import {
    getForgotPasswordErrorMessage,
    shouldSuppressForgotPasswordError,
    isRateLimitError,
    logAuthError,
    LOADING_LABELS,
    waitForSupabaseReady,
} from './index.js';

const t = (key, vars, fallback) => fallback;

const form            = document.getElementById('forgotPasswordForm');
const emailInput      = document.getElementById('email');
const resetBtn        = document.getElementById('resetBtn');
const messageEl       = document.getElementById('forgotMessage');
const formContent     = document.getElementById('formContent');
const successContent  = document.getElementById('successContent');
const successDesc     = document.getElementById('successDesc');
const resendTimer     = document.getElementById('resendTimer');
const resendCountdown = document.getElementById('resendCountdown');
const resendBtn       = document.getElementById('resendBtn');
const backToLogin     = document.getElementById('backToLogin');

const RESEND_COOLDOWN_MS   = 60_000;  // 60 detik antar request reset
const STORAGE_KEY_TS       = 'albedu_reset_requested_at';
const STORAGE_KEY_STATUS   = 'albedu_reset_last_status';       // 'success' | 'failed' | ''
const STORAGE_KEY_EMAIL    = 'albedu_reset_last_email';

const BTN_TEXT_DEFAULT  = t('auth.forgot.submit', null, 'Kirim Link Reset');
const BTN_TEXT_LOADING  = LOADING_LABELS.sending_reset_email;

let _currentState      = 'form';   // 'form' | 'loading' | 'success'
let isSubmitting       = false;
let resendTimerId      = null;
let _cooldownEndsAt    = 0;

const btnTextEl = resetBtn?.querySelector('.btn-text');

function showFormState() {
    _currentState = 'form';
    if (formContent)    formContent.classList.remove('hidden');
    if (successContent) successContent.classList.remove('visible');
    if (btnTextEl) btnTextEl.textContent = BTN_TEXT_DEFAULT;
    if (resetBtn)  resetBtn.disabled = false;
    _applyCooldownToPrimaryButton();
}

function showSuccessState(email) {
    _currentState = 'success';
    if (formContent)    formContent.classList.add('hidden');
    if (successContent) successContent.classList.add('visible');
    clearMessage();

    if (successDesc && email) {
        const masked = maskEmail(email);
        successDesc.textContent =
            `Link reset kata sandi telah dikirim ke ${masked}. Silakan periksa inbox dan folder spam Anda.`;
    }

    startResendCooldown();
}

// Cooldown sync between the primary form button and the resend button so
// they always show the same countdown.
function _setCooldown(endsAt) {
    _cooldownEndsAt = endsAt;
    try {
        sessionStorage.setItem(STORAGE_KEY_TS, String(endsAt));
    } catch (_) {}
}

function _applyCooldownToPrimaryButton() {
    if (_currentState !== 'form') return;
    if (!resetBtn || !btnTextEl) return;

    const remaining = Math.max(0, Math.ceil((_cooldownEndsAt - Date.now()) / 1000));
    if (remaining > 0) {
        resetBtn.disabled = true;
        btnTextEl.textContent = `Tunggu ${remaining}s`;
    } else {
        resetBtn.disabled = false;
        btnTextEl.textContent = BTN_TEXT_DEFAULT;
    }
}

function startResendCooldown() {
    const remaining0 = Math.max(0, Math.ceil((_cooldownEndsAt - Date.now()) / 1000));

    if (remaining0 <= 0) {
        showResendButton();
        return;
    }

    if (resendTimer)      resendTimer.hidden = false;
    if (resendBtn)        resendBtn.hidden = true;
    if (resendCountdown)  resendCountdown.textContent = remaining0;

    let remaining = remaining0;
    clearInterval(resendTimerId);
    resendTimerId = setInterval(() => {
        remaining -= 1;
        if (resendCountdown) resendCountdown.textContent = remaining;

        if (remaining <= 0) {
            clearInterval(resendTimerId);
            resendTimerId = null;
            showResendButton();
        }
    }, 1000);
}

function showResendButton() {
    if (resendTimer) resendTimer.hidden = true;
    if (resendBtn)   resendBtn.hidden = false;
    if (resendBtn)   resendBtn.disabled = false;
}

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

function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
    return `${visible}***@${domain}`;
}

function setLoading(loading) {
    if (!resetBtn) return;
    resetBtn.disabled = loading;
    resetBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loading) {
        resetBtn.classList.add('loading');
        if (btnTextEl) btnTextEl.textContent = BTN_TEXT_LOADING;
        _currentState = 'loading';
    } else {
        resetBtn.classList.remove('loading');
        if (_currentState === 'loading') _currentState = 'form';
        _applyCooldownToPrimaryButton();
    }
}

function validateEmail() {
    const email = emailInput?.value?.trim() || '';
    if (!email) {
        return t('auth.forgot.email_required', null, 'Masukkan email Anda.');
    }
    if (!emailInput?.validity?.valid) {
        return t('auth.forgot.email_invalid', null, 'Masukkan format email yang valid.');
    }
    return '';
}

function _persistSuccessStatus(email) {
    try {
        sessionStorage.setItem(STORAGE_KEY_STATUS, 'success');
        sessionStorage.setItem(STORAGE_KEY_EMAIL, email);
    } catch (_) {}
}

function _persistFailedStatus() {
    try {
        sessionStorage.setItem(STORAGE_KEY_STATUS, 'failed');
    } catch (_) {}
}

function _clearPersistedStatus() {
    try {
        sessionStorage.removeItem(STORAGE_KEY_STATUS);
        sessionStorage.removeItem(STORAGE_KEY_EMAIL);
        sessionStorage.removeItem(STORAGE_KEY_TS);
    } catch (_) {}
}

function _getPersistedStatus() {
    try {
        return {
            status: sessionStorage.getItem(STORAGE_KEY_STATUS) || '',
            email:  sessionStorage.getItem(STORAGE_KEY_EMAIL) || '',
            ts:     parseInt(sessionStorage.getItem(STORAGE_KEY_TS) || '0', 10),
        };
    } catch (_) {
        return { status: '', email: '', ts: 0 };
    }
}

async function handleSubmit(event) {
    event.preventDefault();
    clearMessage();

    if (isSubmitting) return;

    if (_cooldownEndsAt > Date.now()) {
        const remaining = Math.ceil((_cooldownEndsAt - Date.now()) / 1000);
        showMessage(`Tunggu ${remaining} detik sebelum mencoba lagi.`);
        return;
    }

    const validationError = validateEmail();
    if (validationError) {
        showMessage(validationError);
        return;
    }

    isSubmitting = true;
    setLoading(true);

    const email = emailInput.value.trim();

    try {
        await waitForSupabaseReady();

        if (!window.AlbEdu?.supabase?.client?.auth?.resetPasswordForEmail) {
            throw new Error('Sistem autentikasi belum siap. Silakan muat ulang halaman.');
        }

        // Build redirect URL dynamically from current origin. Validate that
        // it's same-origin to prevent open-redirect abuse.
        const redirectPath = window.location.pathname.replace(/forgot-password\.html.*/, 'reset-password.html');
        const redirectTo = `${window.location.origin}${redirectPath}`;
        if (!redirectTo.startsWith(window.location.origin)) {
            throw new Error('Konfigurasi redirect tidak valid.');
        }

        const { error } = await window.AlbEdu?.supabase?.client.auth.resetPasswordForEmail(email, {
            redirectTo,
        });

        if (error) {
            // Two categories:
            //   A. SUPPRESS (anti-enumeration): "user not found", "email not
            //      confirmed" → still show success state so attackers can't
            //      probe registered emails.
            //   B. SHOW: rate limit, network, SMTP, redirect misconfig — show
            //      the real error so the user knows the email wasn't sent.
            const shouldSuppress = shouldSuppressForgotPasswordError(error);

            if (shouldSuppress) {
                console.warn('[ForgotPassword] suppressed error for anti-enumeration:',
                    error.message || error.code);
                _persistSuccessStatus(email);
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                setLoading(false);
                showSuccessState(email);
                return;
            }

            const errorCode = error.message || error.code || 'unknown_error';
            const friendlyMessage = getForgotPasswordErrorMessage(errorCode);

            logAuthError({
                flow: 'forgot-password',
                error,
                backendCode: errorCode,
            });

            setLoading(false);
            showMessage(friendlyMessage);

            if (isRateLimitError(errorCode)) {
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                _persistFailedStatus();
                _applyCooldownToPrimaryButton();
            } else {
                // Non-rate-limit error: user can retry immediately, but
                // persist failed status so refresh doesn't fake-success.
                _persistFailedStatus();
                _cooldownEndsAt = 0;
                try { sessionStorage.removeItem(STORAGE_KEY_TS); } catch (_) {}
            }
            return;
        }

        _persistSuccessStatus(email);
        _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
        setLoading(false);
        showSuccessState(email);

    } catch (err) {
        // Catch block: fetch() network errors, client-side validation errors,
        // or anything Supabase SDK didn't already wrap.
        logAuthError({
            flow: 'forgot-password',
            error: err,
            backendCode: err.message,
        });

        setLoading(false);

        const friendly = getForgotPasswordErrorMessage(err.message || 'unknown_error');
        showMessage(friendly);

        if (isRateLimitError(err.message || '')) {
            _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
            _applyCooldownToPrimaryButton();
        }

        _persistFailedStatus();
    } finally {
        isSubmitting = false;
        if (_currentState === 'loading') {
            setLoading(false);
        }
    }
}

async function handleResend() {
    if (isSubmitting) return;

    if (_cooldownEndsAt > Date.now()) {
        const remaining = Math.ceil((_cooldownEndsAt - Date.now()) / 1000);
        showMessage(`Tunggu ${remaining} detik sebelum mencoba lagi.`);
        return;
    }

    clearMessage();

    const email = emailInput?.value?.trim();
    if (!email || !emailInput?.validity?.valid) {
        showFormState();
        showMessage(t('auth.forgot.email_invalid', null, 'Masukkan email yang valid terlebih dahulu.'));
        return;
    }

    isSubmitting = true;
    if (resendBtn) resendBtn.disabled = true;

    try {
        await waitForSupabaseReady();

        const redirectPath = window.location.pathname.replace(/forgot-password\.html.*/, 'reset-password.html');
        const redirectTo = `${window.location.origin}${redirectPath}`;
        if (!redirectTo.startsWith(window.location.origin)) {
            showMessage('Konfigurasi redirect tidak valid.');
            return;
        }

        const { error } = await window.AlbEdu?.supabase?.client.auth.resetPasswordForEmail(email, {
            redirectTo,
        });

        if (error) {
            const shouldSuppress = shouldSuppressForgotPasswordError(error);

            if (shouldSuppress) {
                console.warn('[ForgotPassword] resend suppressed error for anti-enumeration:',
                    error.message || error.code);
                _persistSuccessStatus(email);
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                startResendCooldown();
                return;
            }

            const errorCode = error.message || error.code || 'unknown_error';
            const friendlyMessage = getForgotPasswordErrorMessage(errorCode);

            logAuthError({
                flow: 'forgot-password-resend',
                error,
                backendCode: errorCode,
            });

            showMessage(friendlyMessage);

            if (isRateLimitError(errorCode)) {
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                _persistFailedStatus();
                startResendCooldown();
            } else {
                _persistFailedStatus();
                if (resendBtn) resendBtn.disabled = false;
            }
            return;
        }

        _persistSuccessStatus(email);
        _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
        startResendCooldown();

    } catch (err) {
        logAuthError({
            flow: 'forgot-password-resend',
            error: err,
            backendCode: err.message,
        });

        const friendly = getForgotPasswordErrorMessage(err.message || 'unknown_error');
        showMessage(friendly);

        if (isRateLimitError(err.message || '')) {
            _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
            startResendCooldown();
        } else {
            if (resendBtn) resendBtn.disabled = false;
        }

        _persistFailedStatus();
    } finally {
        isSubmitting = false;
    }
}

// If a session already exists on this page, sign it out (best-effort) so
// the recovery flow has a clean slate. DON'T sign out if the URL has a
// recovery marker — that means the user just clicked the email link and
// is mid-flow.
async function checkExistingSession() {
    const hasRecoveryMarker =
        window.location.hash.includes('type=recovery') ||
        window.location.search.includes('type=recovery') ||
        window.location.search.includes('code=');

    if (hasRecoveryMarker) {
        return;
    }

    try {
        await waitForSupabaseReady();
        const { data } = await window.AlbEdu?.supabase?.client.auth.getSession();
        if (data?.session) {
            try {
                await window.AlbEdu?.supabase?.client.auth.signOut();
            } catch (signOutErr) {
                console.warn('[ForgotPassword] signOut failed (non-fatal):', signOutErr?.message);
            }
        }
    } catch (_) {
        // Ignore — lanjutkan ke form
    }
}

// Pre-fill email from sessionStorage (link from login page).
try {
    const savedEmail = sessionStorage.getItem('albedu_forgot_email');
    if (savedEmail && emailInput) {
        emailInput.value = savedEmail;
        sessionStorage.removeItem('albedu_forgot_email');
    }
} catch (_) {}

// Restore state based on persisted status. Previously the init block always
// called showSuccess() if a cooldown timestamp existed in sessionStorage —
// but that timestamp was set even when the request FAILED (rate-limit). Now
// we check the persisted status: only show success if the previous request
// actually succeeded.
//
// Decision matrix:
//   status='success' + cooldown active → resume success state
//   status='success' + cooldown over   → form (user can request again)
//   status='failed'  + cooldown active → form with disabled button
//   status='failed'  + cooldown over   → normal form
//   status=''        (fresh)           → normal form
(async function initRestoreState() {
    const { status, email, ts } = _getPersistedStatus();
    const now = Date.now();

    // ts is "started at" (when the last request was submitted, success or
    // fail). Cooldown ends at ts + RESEND_COOLDOWN_MS.
    if (ts > 0) {
        const endsAt = ts + RESEND_COOLDOWN_MS;
        _cooldownEndsAt = endsAt > now ? endsAt : 0;
    } else {
        _cooldownEndsAt = 0;
    }

    if (status === 'success' && _cooldownEndsAt > now) {
        if (email && emailInput && !emailInput.value) {
            emailInput.value = email;
        }
        showSuccessState(email || emailInput?.value?.trim() || '');
        return;
    }

    showFormState();

    if (_cooldownEndsAt > now) {
        _applyCooldownToPrimaryButton();
        const tickId = setInterval(() => {
            _applyCooldownToPrimaryButton();
            if (_cooldownEndsAt <= Date.now()) {
                clearInterval(tickId);
            }
        }, 1000);
    } else {
        try { sessionStorage.removeItem(STORAGE_KEY_TS); } catch (_) {}
    }
})();

form?.addEventListener('submit', handleSubmit);
resendBtn?.addEventListener('click', handleResend);

checkExistingSession();
