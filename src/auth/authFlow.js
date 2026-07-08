// auth/authFlow.js — shared auth flow helpers

import { TIMING_CONFIG } from './constants.js';
import { getErrorMessage, logAuthError, LOADING_LABELS } from './errorMapper.js';

// Wait for the native AlbEdu.supabase.ready promise (resolves on
// 'albedu:platform-ready'). If the page also needs window.Auth (login pages),
// poll for it — register-admin and exam pages don't load it.
export async function waitForSupabaseReady(timeout = TIMING_CONFIG.SUPABASE_READY_TIMEOUT_MS) {
    if (window.AlbEdu?.supabase?.isReady?.()) {
        if (typeof window.Auth?.authLogin === 'function' || !document.getElementById('userLoginBtn')) {
            return;
        }
    }

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Koneksi ke server timeout. Periksa internet dan coba lagi.'));
        }, timeout);

        document.addEventListener('albedu:platform-ready', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });

        document.addEventListener('albedu:platform-error', (event) => {
            clearTimeout(timer);
            reject(new Error(event?.detail?.message || 'Gagal terhubung ke server.'));
        }, { once: true });
    });

    const needsAuth = typeof window.Auth?.authLogin === 'function'
        || document.getElementById('userLoginBtn') !== null;

    if (needsAuth && typeof window.Auth?.authLogin !== 'function') {
        await new Promise((resolve, reject) => {
            const deadline = Date.now() + 8_000;
            const check = setInterval(() => {
                if (typeof window.Auth?.authLogin === 'function') {
                    clearInterval(check);
                    resolve();
                } else if (Date.now() > deadline) {
                    clearInterval(check);
                    reject(new Error('Modul autentikasi belum siap. Coba muat ulang halaman.'));
                }
            }, 100);
        });
    }
}

export function setLoadingState(button, textElement, isLoading, label = null) {
    if (button) {
        button.disabled = isLoading;
        button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    }

    if (textElement) {
        if (label) {
            textElement.textContent = label;
        } else {
            textElement.textContent = isLoading
                ? LOADING_LABELS.processing_login
                : 'Masuk dengan Google';
        }
    }
}

export function showMessage(messageEl, message, isError = true) {
    if (!messageEl) return;

    messageEl.textContent = message || '';
    messageEl.hidden = !message;

    messageEl.classList.remove('info-message');
    if (!isError) {
        messageEl.classList.add('info-message');
    }

    if (window.Security?.setText) {
        window.Security.setText(messageEl, message || '');
    }
}

export function clearMessage(messageEl) {
    if (!messageEl) return;

    messageEl.textContent = '';
    messageEl.hidden = true;
    messageEl.classList.remove('info-message');
}

export function handleAuthError({
    flow,
    error,
    backendCode = null,
    onShowMessage = null,
    onResetUI = null,
}) {
    logAuthError({ flow, error, backendCode });

    const friendlyMessage = getErrorMessage(backendCode || error.message);

    if (onShowMessage) onShowMessage(friendlyMessage);
    if (onResetUI) onResetUI();

    return friendlyMessage;
}

export function validateAdminRegistration(emailInput, passwordInput, confirmInput, getTurnstileTokenFn) {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;

    if (!email || !emailInput.validity.valid) {
        return 'Masukkan email yang valid.';
    }

    if (password.length < 8) {
        return 'Password minimal 8 karakter.';
    }

    if (password !== confirmPassword) {
        return 'Password dan konfirmasi password harus sama.';
    }

    const turnstileToken = getTurnstileTokenFn();
    if (!turnstileToken) {
        return 'Verifikasi keamanan belum selesai.';
    }

    return '';
}

export async function setupGoogleProvider() {
    const GoogleAuthProvider = window.firebase?.auth?.GoogleAuthProvider;
    if (!GoogleAuthProvider) {
        throw new Error('GoogleAuthProvider tidak tersedia');
    }

    const provider = new GoogleAuthProvider();
    provider.addScope?.('profile');
    provider.addScope?.('email');

    return provider;
}

// Supabase native OAuth — the `_provider` argument is ignored (config is
// server-side) and kept only so callers that pass one don't break.
export async function signInWithGoogle(_provider) {
    const auth = window.AlbEdu?.supabase?.auth;
    if (!auth?.signInWithGoogle) {
        throw new Error('Sistem login Google belum siap.');
    }
    return await auth.signInWithGoogle();
}
