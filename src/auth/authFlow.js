// =============================================================================
// auth/authFlow.js — Shared authentication flow utilities
// =============================================================================
//
// Satu modul untuk semua flow autentikasi:
//   - User Login (peserta + admin via Google)
//   - User Registration
//   - Admin Registration
// =============================================================================

import { TIMING_CONFIG } from './constants.js';
import { getErrorMessage, logAuthError, LOADING_LABELS } from './errorMapper.js';

/**
 * Tunggu hingga Supabase siap.
 * @returns {Promise<void>}
 */
export async function waitForSupabaseReady(timeout = TIMING_CONFIG.SUPABASE_READY_TIMEOUT_MS) {
    // Cek cepat: Supabase sudah siap dan (jika ada) Auth juga siap
    if (window.sb && window.__firebaseReady) {
        // Auth opsional — hanya tunggu jika memang ada (halaman login user)
        if (typeof window.Auth?.authLogin === 'function' || !document.getElementById('userLoginBtn')) {
            return;
        }
    }

    // Delegasi ke window.waitForSupabase jika tersedia (didefinisikan di SupabaseApi.js)
    if (window.waitForSupabase) {
        await window.waitForSupabase();
    } else {
        // Fallback: tunggu event 'supabase-ready' dari SupabaseApi.js
        if (!window.sb || !window.__firebaseReady) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('Koneksi ke server timeout. Periksa internet dan coba lagi.'));
                }, timeout);

                document.addEventListener('supabase-ready', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });

                document.addEventListener('firebase-error', (event) => {
                    clearTimeout(timer);
                    reject(new Error(event.detail?.error || 'Gagal terhubung ke server.'));
                }, { once: true });
            });
        }
    }

    // Hanya tunggu window.Auth jika halaman ini memang butuhnya (index.html / login.html)
    // Di halaman lain (register-admin, ujian) window.Auth tidak dimuat — skip.
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

/**
 * Helper untuk update UI loading state secara konsisten.
 * @param {HTMLElement|null} button - Button element
 * @param {HTMLElement|null} textElement - Text element dalam button
 * @param {boolean} isLoading - Apakah sedang loading
 * @param {string} [label] - Label custom (opsional)
 */
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

/**
 * Helper untuk menampilkan pesan error/konsisten.
 * @param {HTMLElement|null} messageEl - Element untuk menampilkan pesan
 * @param {string} message - Pesan yang ditampilkan
 * @param {boolean} [isError=true] - Apakah ini error (false = info/success)
 */
export function showMessage(messageEl, message, isError = true) {
    if (!messageEl) return;
    
    messageEl.textContent = message || '';
    messageEl.hidden = !message;
    
    // Reset classes
    messageEl.classList.remove('info-message');
    if (!isError) {
        messageEl.classList.add('info-message');
    }
    
    if (window.Security?.setText) {
        window.Security.setText(messageEl, message || '');
    }
}

/**
 * Clear pesan error.
 * @param {HTMLElement|null} messageEl
 */
export function clearMessage(messageEl) {
    if (!messageEl) return;
    
    messageEl.textContent = '';
    messageEl.hidden = true;
    messageEl.classList.remove('info-message');
}

/**
 * Handle error dalam auth flow dengan logging dan user-friendly message.
 * @param {Object} options
 * @param {string} options.flow - 'user-login' | 'admin-register' | dll
 * @param {Error} options.error - Error object
 * @param {string} [options.backendCode] - Kode error dari backend
 * @param {Function} [options.onShowMessage] - Callback untuk menampilkan pesan
 * @param {Function} [options.onResetUI] - Callback untuk reset UI setelah error
 */
export function handleAuthError({ 
    flow, 
    error, 
    backendCode = null,
    onShowMessage = null,
    onResetUI = null,
}) {
    // Log untuk debugging/analytics
    logAuthError({
        flow,
        error,
        backendCode,
    });
    
    // Dapatkan pesan yang user-friendly
    const friendlyMessage = getErrorMessage(backendCode || error.message);
    
    // Tampilkan ke user
    if (onShowMessage) {
        onShowMessage(friendlyMessage);
    }
    
    // Reset UI jika ada callback
    if (onResetUI) {
        onResetUI();
    }
    
    return friendlyMessage;
}

/**
 * Validasi input form registrasi admin.
 * @param {HTMLInputElement} emailInput
 * @param {HTMLInputElement} passwordInput
 * @param {HTMLInputElement} confirmInput
 * @param {Function} getTurnstileTokenFn
 * @returns {string} Pesan error kosong jika valid
 */
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

/**
 * Google login provider setup.
 * @returns {Promise<Object>} Provider yang sudah dikonfigurasi
 */
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

/**
 * Execute Google sign-in popup.
 * @param {Object} provider - Auth provider
 * @returns {Promise<Object>} Result dari signInWithPopup
 */
export async function signInWithGoogle(provider) {
    if (!window.firebaseAuth?.signInWithPopup) {
        throw new Error('Sistem login Google belum siap.');
    }
    
    return await window.firebaseAuth.signInWithPopup(provider);
}