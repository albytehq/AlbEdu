// =============================================================================
// ForgotPassword.js — Production-grade password reset request flow v2.0
// =============================================================================
//
// STATE MACHINE:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │                                                                 │
//   │   [INIT] ──► [FORM] ──submit──► [LOADING] ──┐                  │
//   │                ▲                            │                  │
//   │                │                            ▼                  │
//   │                │     ┌─── [SUCCESS] ◄─── 200 OK                │
//   │                │     │                                            │
//   │                │     │      (cooldown 60s, show resend btn)     │
//   │                │     │                                            │
//   │                │     └─── [ERROR] ◄── rate-limit / network      │
//   │                │                       (show msg, no cooldown   │
//   │                │                        unless rate-limit)      │
//   │                │                                            │
//   │                └──── user clicks "edit email" ─────────────    │
//   │                                                                 │
//   └─────────────────────────────────────────────────────────────────┘
//
// FIXES vs v1:
//   - Bug #1 (rate-limit shows "Terjadi kesalahan"): pakai
//     getForgotPasswordErrorMessage() yang mengenali semua pattern rate-limit
//     Supabase (over_email_send_rate_limit, "For security purposes...",
//     "Email rate limit exceeded", HTTP 429, dll).
//
//   - Bug #2 (refresh halaman = fake success): persist status 'success' atau
//     'failed' di sessionStorage. Saat reload, hanya tampilkan success state
//     jika request SEBELUMNYA berhasil. Kalau failed, kembali ke form.
//
//   - Bug #3 (cooldown tidak sinkron antara tombol primary & resend):
//     saat di state success, tombol primary juga disable dengan countdown
//     yang sama.
//
//   - Bug #4 (race condition dengan checkExistingSession): init sekarang
//     sequential, bukan paralel. checkExistingSession tidak signOut kalau
//     ada recovery marker (sedang dalam flow reset).
//
//   - Bug #5 (state confusion): tiga state eksplisit — FORM, SUCCESS,
//     LOADING. Tidak ada lagi keadaan ambiguous.
//
// ANTI-ENUMERATION:
//   Untuk error yang menunjukkan email TIDAK ADA di sistem (user not found,
//   email not confirmed), tetap tampilkan success state supaya attacker
//   tidak bisa menebak email mana yang terdaftar. Lihat
//   shouldSuppressForgotPasswordError() di errorMapper.js.
// =============================================================================

import {
    getForgotPasswordErrorMessage,
    shouldSuppressForgotPasswordError,
    isRateLimitError,
    logAuthError,
    LOADING_LABELS,
    waitForSupabaseReady,
} from './index.js';

// v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
const t = (key, vars, fallback) => {
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
        const v = window.i18n.t(key, vars);
        return v !== undefined ? v : fallback;
    }
    return fallback;
};

// ── DOM references ──────────────────────────────────────────────────────────
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

// ── Constants ───────────────────────────────────────────────────────────────
const RESEND_COOLDOWN_MS   = 60_000;  // 60 detik antar request reset
// Storage keys — gunakan prefix 'albedu_' untuk namespace konsisten
const STORAGE_KEY_TS       = 'albedu_reset_requested_at';     // timestamp request terakhir
const STORAGE_KEY_STATUS   = 'albedu_reset_last_status';       // 'success' | 'failed' | ''
const STORAGE_KEY_EMAIL    = 'albedu_reset_last_email';        // email yang dipakai (untuk display masked)

const BTN_TEXT_DEFAULT  = t('auth.forgot.submit', null, 'Kirim Link Reset');
const BTN_TEXT_LOADING  = LOADING_LABELS.sending_reset_email;

// ── State ───────────────────────────────────────────────────────────────────
// _currentState melacak mode UI saat ini: 'form' | 'loading' | 'success'
let _currentState      = 'form';
let isSubmitting       = false;
let resendTimerId      = null;
// Simpan timestamp cooldown yang sedang aktif — dipakai tombol primary & resend
let _cooldownEndsAt    = 0;

// ── DOM: button text reference ──────────────────────────────────────────────
const btnTextEl = resetBtn?.querySelector('.btn-text');

// =============================================================================
// UI state transitions
// =============================================================================

/**
 * Pindah ke state FORM. Semua elemen lain disembunyikan.
 * Tombol primary di-enable (kecuali sedang cooldown).
 */
function showFormState() {
    _currentState = 'form';
    if (formContent)    formContent.classList.remove('hidden');
    if (successContent) successContent.classList.remove('visible');
    // Reset button text
    if (btnTextEl) btnTextEl.textContent = BTN_TEXT_DEFAULT;
    if (resetBtn)  resetBtn.disabled = false;
    // Apply cooldown jika ada
    _applyCooldownToPrimaryButton();
}

/**
 * Pindah ke state SUCCESS (anti-enumeration: tampil meski email tidak ada).
 * Sembunyikan form, tampilkan success card.
 * Mulai countdown tombol resend.
 */
function showSuccessState(email) {
    _currentState = 'success';
    if (formContent)    formContent.classList.add('hidden');
    if (successContent) successContent.classList.add('visible');
    // Sembunyikan pesan error jika ada
    clearMessage();

    // Tampilkan email yang dituju (masked untuk privacy)
    if (successDesc && email) {
        const masked = maskEmail(email);
        successDesc.textContent =
            `Link reset kata sandi telah dikirim ke ${masked}. Silakan periksa inbox dan folder spam Anda.`;
    }

    // Mulai countdown tombol resend
    startResendCooldown();
}

// =============================================================================
// Cooldown management — sinkron antara tombol primary (form) & tombol resend (success)
// =============================================================================

/**
 * Set cooldown timestamp & persist ke sessionStorage.
 * @param {number} endsAt - epoch ms ketika cooldown berakhir
 */
function _setCooldown(endsAt) {
    _cooldownEndsAt = endsAt;
    try {
        sessionStorage.setItem(STORAGE_KEY_TS, String(endsAt));
    } catch (_) {}
}

/**
 * Apply cooldown ke tombol primary (#resetBtn) di state FORM.
 * Saat cooldown aktif, tombol disable + label countdown.
 * Saat habis, tombol enable + label default.
 */
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

/**
 * Mulai countdown untuk tombol resend (state SUCCESS) + sinkron tombol primary.
 *
 * Baca timestamp dari _cooldownEndsAt (yang sudah di-set sebelumnya oleh _setCooldown).
 * Setiap detik, update UI countdown. Saat habis, tampilkan tombol resend.
 */
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

// =============================================================================
// Message helpers
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

/**
 * Mask email untuk privacy: "n***@sekolah.sch.id"
 */
function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
    return `${visible}***@${domain}`;
}

// =============================================================================
// Loading state
// =============================================================================

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
        // Kembali ke state yang sesuai (form kalau bukan success)
        if (_currentState === 'loading') _currentState = 'form';
        _applyCooldownToPrimaryButton();
    }
}

// =============================================================================
// Validation
// =============================================================================

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

// =============================================================================
// Storage helpers
// =============================================================================

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

// =============================================================================
// Submit handler
// =============================================================================

async function handleSubmit(event) {
    event.preventDefault();
    clearMessage();

    if (isSubmitting) return;

    // Double-guard: jika sedang cooldown, jangan proses
    if (_cooldownEndsAt > Date.now()) {
        const remaining = Math.ceil((_cooldownEndsAt - Date.now()) / 1000);
        showMessage(`Tunggu ${remaining} detik sebelum mencoba lagi.`);
        return;
    }

    // Client-side validation
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

        // Build redirect URL dynamically dari origin saat ini
        // Validasi: redirectTo HARUS same-origin untuk mencegah open redirect
        const redirectPath = window.location.pathname.replace(/forgot-password\.html.*/, 'reset-password.html');
        const redirectTo = `${window.location.origin}${redirectPath}`;
        if (!redirectTo.startsWith(window.location.origin)) {
            throw new Error('Konfigurasi redirect tidak valid.');
        }

        const { error } = await window.AlbEdu?.supabase?.client.auth.resetPasswordForEmail(email, {
            redirectTo,
        });

        if (error) {
            // ── Kategorisasi error ────────────────────────────────────────────
            //
            // Dua kategori:
            //   A. SUPPRESS (anti-enumeration): "user not found", "email not
            //      confirmed" → tetap tampilkan success state seolah email
            //      terkirim. Mencegah attacker menebak email terdaftar.
            //
            //   B. SHOW ERROR: rate limit, network, SMTP, redirect misconfig
            //      → tampilkan pesan error ASLI ke user.
            const shouldSuppress = shouldSuppressForgotPasswordError(error);

            if (shouldSuppress) {
                console.warn('[ForgotPassword] suppressed error for anti-enumeration:',
                    error.message || error.code);
                // Persist success status & email (untuk recovery saat refresh)
                _persistSuccessStatus(email);
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                // Reset loading state dulu sebelum show success (tombol ada di
                // formContent yang akan di-hidden, tapi DOM state harus konsisten)
                setLoading(false);
                showSuccessState(email);
                return;
            }

            // Kategori B: tampilkan error asli ke user
            const errorCode = error.message || error.code || 'unknown_error';
            const friendlyMessage = getForgotPasswordErrorMessage(errorCode);

            logAuthError({
                flow: 'forgot-password',
                error,
                backendCode: errorCode,
            });

            // Pastikan state kembali ke form (bukan loading)
            setLoading(false);
            showMessage(friendlyMessage);

            // Untuk rate-limit: set cooldown + persist failed status
            // (supaya refresh tidak fake-success)
            if (isRateLimitError(errorCode)) {
                _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
                _persistFailedStatus();
                // Disable tombol primary + tampilkan countdown
                _applyCooldownToPrimaryButton();
            } else {
                // Error non-rate-limit: user boleh coba lagi, TANPA cooldown
                // tapi status tetap 'failed' supaya refresh tidak fake-success
                _persistFailedStatus();
                _cooldownEndsAt = 0;
                try { sessionStorage.removeItem(STORAGE_KEY_TS); } catch (_) {}
            }
            return;
        }

        // Berhasil — persist success status + mulai cooldown
        _persistSuccessStatus(email);
        _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
        setLoading(false);  // reset tombol ke state idle (meski di-hidden oleh success card)
        showSuccessState(email);

    } catch (err) {
        // Catch block: error dari fetch() (network), error validasi client,
        // atau error yang tidak ditangani oleh Supabase SDK.
        logAuthError({
            flow: 'forgot-password',
            error: err,
            backendCode: err.message,
        });

        setLoading(false);

        // Tampilkan error yang spesifik via mapper
        const friendly = getForgotPasswordErrorMessage(err.message || 'unknown_error');
        showMessage(friendly);

        // Untuk rate-limit yang throw (jarang tapi mungkin): set cooldown
        if (isRateLimitError(err.message || '')) {
            _setCooldown(Date.now() + RESEND_COOLDOWN_MS);
            _applyCooldownToPrimaryButton();
        }

        // Persist failed status supaya refresh tidak fake-success
        _persistFailedStatus();
    } finally {
        isSubmitting = false;
        // Jangan setLoading(false) di sini kalau sudah di-handle di atas
        if (_currentState === 'loading') {
            setLoading(false);
        }
    }
}

// =============================================================================
// Resend handler — mirrors handleSubmit tapi untuk tombol resend (state SUCCESS)
// =============================================================================

async function handleResend() {
    if (isSubmitting) return;

    // Cek cooldown — tombol resend harusnya sudah disabled, tapi double-guard
    if (_cooldownEndsAt > Date.now()) {
        const remaining = Math.ceil((_cooldownEndsAt - Date.now()) / 1000);
        showMessage(`Tunggu ${remaining} detik sebelum mencoba lagi.`);
        return;
    }

    clearMessage();

    const email = emailInput?.value?.trim();
    if (!email || !emailInput?.validity?.valid) {
        // Email tidak valid — kembali ke form state
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
                // Non-rate-limit: user bisa coba lagi tanpa cooldown,
                // tapi tetap persist failed status
                _persistFailedStatus();
                if (resendBtn) resendBtn.disabled = false;
            }
            return;
        }

        // Berhasil — persist + cooldown
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

        // Untuk rate-limit: set cooldown
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

// =============================================================================
// Check if user already logged in
// =============================================================================

// Production-grade behavior:
//   - NEVER auto-redirect to admin panel from this page.
//   - If a session exists, sign it out (best-effort) so the recovery flow
//     has a clean slate. But DON'T sign out if URL has recovery marker —
//     that means user is in the middle of a recovery flow.
async function checkExistingSession() {
    // Jangan signOut kalau URL punya recovery marker — artinya user baru
    // saja klik link dari email dan redirect ke sini (kasus edge: redirect
    // misconfigured ke forgot-password.html).
    const hasRecoveryMarker =
        window.location.hash.includes('type=recovery') ||
        window.location.search.includes('type=recovery') ||
        window.location.search.includes('code=');

    if (hasRecoveryMarker) {
        // User datang dari email link — biarkan session-nya, jangan signOut.
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

// =============================================================================
// Init
// =============================================================================

// ── Pre-fill email dari sessionStorage (link dari login page) ───────────────
try {
    const savedEmail = sessionStorage.getItem('albedu_forgot_email');
    if (savedEmail && emailInput) {
        emailInput.value = savedEmail;
        sessionStorage.removeItem('albedu_forgot_email');
    }
} catch (_) {}

// ── Restore state berdasarkan persisted status ──────────────────────────────
// FIX BUG #2: Sebelumnya, init block selalu showSuccess() kalau ada timestamp
// cooldown di sessionStorage — padahal timestamp itu di-set WALAUPUN request
// gagal (rate-limit). Sekarang: cek status persisted. Hanya showSuccess()
// kalau request sebelumnya benar-benar BERHASIL.
//
// State machine:
//   - status='success' + cooldown masih aktif → tampilkan success state (resume)
//   - status='success' + cooldown sudah habis → tampilkan form (user bisa minta lagi)
//   - status='failed' + cooldown masih aktif → tampilkan form dengan tombol disabled
//   - status='failed' + cooldown sudah habis → tampilkan form normal
//   - status='' (fresh) → tampilkan form normal
//
// Selalu juga jalankan countdown tick untuk tombol primary (state form).

(async function initRestoreState() {
    const { status, email, ts } = _getPersistedStatus();
    const now = Date.now();

    // Hitung _cooldownEndsAt dari timestamp persisted.
    // ts adalah "started at" (kapan request terakhir di-submit, baik sukses maupun gagal).
    // Cooldown berakhir di ts + RESEND_COOLDOWN_MS.
    if (ts > 0) {
        const endsAt = ts + RESEND_COOLDOWN_MS;
        _cooldownEndsAt = endsAt > now ? endsAt : 0;
    } else {
        _cooldownEndsAt = 0;
    }

    // Decision matrix:
    //   status='success' + cooldown aktif → resume success state
    //   status='success' + cooldown habis → form (user boleh minta lagi)
    //   status='failed'  + cooldown aktif → form + tombol disabled
    //   status='failed'  + cooldown habis → form normal
    //   status=''        (fresh)          → form normal
    if (status === 'success' && _cooldownEndsAt > now) {
        // Resume success state — pre-fill email kalau ada
        if (email && emailInput && !emailInput.value) {
            emailInput.value = email;
        }
        showSuccessState(email || emailInput?.value?.trim() || '');
        return;
    }

    // Untuk semua kasus lain: tampilkan form state.
    showFormState();

    // Jika cooldown masih aktif, mulai tick untuk update label tombol primary
    // setiap detik (countdown "Tunggu 60s... Tunggu 59s...").
    if (_cooldownEndsAt > now) {
        _applyCooldownToPrimaryButton();
        const tickId = setInterval(() => {
            _applyCooldownToPrimaryButton();
            if (_cooldownEndsAt <= Date.now()) {
                clearInterval(tickId);
            }
        }, 1000);
    } else {
        // Cooldown sudah habis — clear timestamp biar tidak mengganggu sesi berikutnya
        try { sessionStorage.removeItem(STORAGE_KEY_TS); } catch (_) {}
    }
})();

// ── Attach event listeners ──────────────────────────────────────────────────
form?.addEventListener('submit', handleSubmit);
resendBtn?.addEventListener('click', handleResend);

// ── Check existing session (sequential, setelah state restored) ─────────────
checkExistingSession();
