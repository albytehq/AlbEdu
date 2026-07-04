// AdminOnboarding — public administrator registration form handler.
// Refactored: Menggunakan shared auth utilities untuk konsistensi error handling.

// Import shared utilities
import { 
    getAdminRegisterErrorMessage,
    logAuthError,
    LOADING_LABELS,
    validateAdminRegistration as validateRegistration,
    waitForSupabaseReady,
    getTurnstileToken as getSharedTurnstileToken,
    resetTurnstile as resetSharedTurnstile,
} from './index.js';

    const t = (key, vars, fallback) => fallback;

    const form           = document.getElementById('adminRegisterForm');
    const emailInput     = document.getElementById('email');
    const passwordInput  = document.getElementById('password');
    const confirmInput   = document.getElementById('confirmPassword');
    const button         = document.getElementById('registerBtn');
    const messageEl      = document.getElementById('registerMessage');
    // FIX BUG-04: Password strength indicator elements ada di HTML tapi tidak di-wire up.
    const strengthWrap   = document.getElementById('passwordStrength');
    const strengthText   = document.getElementById('strengthText');

    const GENERIC_ERROR = t('auth.register.generic_error', null, 'Pendaftaran gagal. Silakan coba lagi.');

    // Safe messages yang boleh ditampilkan langsung dari server
    const SAFE_SERVER_MESSAGES = new Set([
        'Email tidak valid.',
        'Password minimal 8 karakter.',
        'Verifikasi Turnstile wajib diisi.',
        'Verifikasi Turnstile gagal.',
        'Terlalu banyak percobaan. Silakan coba lagi nanti.',
        'Perangkat ini sudah mencapai batas maksimum 2 akun admin AlbEdu. Silakan gunakan akun admin yang sudah ada.',
        'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    ]);

    function showError(message) {
        if (!messageEl) return;
        messageEl.textContent = message;
        messageEl.hidden = false;
        messageEl.focus();
    }

    function clearError() {
        if (!messageEl) return;
        messageEl.textContent = '';
        messageEl.hidden = true;
    }

    function setLoading(isLoading) {
        button.disabled = isLoading;
        button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        button.textContent = isLoading ? LOADING_LABELS.processing_registration : t('auth.register.submit', null, 'Daftar Administrator');
    }

    function getTurnstileToken() {
        // Gunakan shared utility, fallback ke cara lama jika tidak tersedia
        return getSharedTurnstileToken() || (() => {
            const responseInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (responseInput?.value) return responseInput.value;
            if (window.turnstile?.getResponse) return window.turnstile.getResponse();
            return '';
        })();
    }

    function resetTurnstile() {
        // Gunakan shared utility
        resetSharedTurnstile();
    }

    // FIX BUG-04: Password strength evaluation — HTML sudah punya strength bars
    // tapi JS tidak menghubungkannya. Sama seperti di ResetPassword.js.
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
        if (!passwordInput || !strengthWrap || !strengthText) return;
        const password = passwordInput.value;
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

    // Wire up password strength indicator
    passwordInput?.addEventListener('input', updateStrengthIndicator);

    function validate() {
        // Gunakan shared validation utility
        return validateRegistration(emailInput, passwordInput, confirmInput, getTurnstileToken);
    }

    // Normalize server error messages — only pass through the explicit safe set.
    // Everything else (DB errors, internal messages, unexpected text) collapses
    // to the generic string so users never see implementation details.
    function normalizeServerError(serverMessage) {
        if (typeof serverMessage === 'string' && SAFE_SERVER_MESSAGES.has(serverMessage)) {
            return serverMessage;
        }
        return GENERIC_ERROR;
    }

    function getBackendErrorMessage(errorCodeOrMessage) {
        // Gunakan shared error mapper sebagai primary, fallback ke logic lama
        const mappedMessage = getAdminRegisterErrorMessage(errorCodeOrMessage);
        if (mappedMessage !== GENERIC_ERROR) {
            return mappedMessage;
        }
        return normalizeServerError(errorCodeOrMessage);
    }

    async function getFunctionErrorDetails(fnError) {
        if (!fnError?.context?.json) {
            return { backendBody: null, backendErrorCode: null };
        }
        try {
            const backendBody = await fnError.context.json();
            return {
                backendBody,
                backendErrorCode: typeof backendBody?.error === 'string' ? backendBody.error : null,
            };
        } catch (_) {
            return { backendBody: null, backendErrorCode: null };
        }
    }

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearError();

        const validationMessage = validate();
        if (validationMessage) {
            showError(validationMessage);
            return;
        }

        setLoading(true);

        try {
            // Phase 2.2 Fix 1: Use Supabase Functions client with automatic auth header.
            // Wait for Supabase client to be ready.
            await waitForSupabaseReady();

            // Phase 1 Anti-Abuse: Collect device fingerprint (shadow mode)
            const fingerprintData = window.DeviceFingerprint 
                ? window.DeviceFingerprint.getFingerprint() 
                : { device_id: null, browser_hash: null, device_info: null };

            // Call Edge Function anonymously (no auth header required for public registration)
            let { data: payload, error: fnError } = await window.AlbEdu?.supabase?.client.functions.invoke('register-admin', {
                headers: {
                    // Explicitly no Authorization header for public endpoint
                },
                body: {
                    email:          emailInput.value.trim(),
                    password:       passwordInput.value,
                    turnstileToken: getTurnstileToken(),
                    deviceId:       fingerprintData.device_id || null,
                    browserHash:    fingerprintData.browser_hash || null,
                    deviceInfo:     fingerprintData.device_info || null,
                },
            });

            if (fnError) {
                const { backendBody, backendErrorCode } = await (async () => {
                    if (!fnError?.context?.json) {
                        return { backendBody: null, backendErrorCode: null };
                    }
                    try {
                        const backendBody = await fnError.context.json();
                        return {
                            backendBody,
                            backendErrorCode: typeof backendBody?.error === 'string' ? backendBody.error : null,
                        };
                    } catch (_) {
                        return { backendBody: null, backendErrorCode: null };
                    }
                })();

                // Log error untuk analytics
                logAuthError({
                    flow: 'admin-register',
                    error: new Error(fnError.message || 'Registration failed'),
                    backendCode: backendErrorCode || fnError.message,
                    context: { email: emailInput.value.trim() },
                });

                throw new Error(getBackendErrorMessage(backendErrorCode || fnError.message));
            }

            if (!payload?.success) {
                // Log error untuk analytics
                logAuthError({
                    flow: 'admin-register',
                    error: new Error(payload?.error || 'Registration failed'),
                    backendCode: payload?.error,
                    context: { email: emailInput.value.trim() },
                });

                throw new Error(getBackendErrorMessage(payload?.error));
            }

            window.location.assign('register-success.html');
        } catch (err) {
            // err.message is already normalized if it came from the block above.
            // For network errors (fetch threw), use the generic fallback.
            const msg = (err instanceof Error && SAFE_SERVER_MESSAGES.has(err.message))
                ? err.message
                : (err instanceof Error && err.message ? normalizeServerError(err.message) : GENERIC_ERROR);

            showError(msg);
            resetTurnstile();
            setLoading(false);
        }
    });
