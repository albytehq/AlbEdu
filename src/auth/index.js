// =============================================================================
// src/auth/index.js — Public exports for auth feature (barrel)
// =============================================================================
//
// v2.0.0 restructure: Expanded to include all auth submodules.
//
// Re-exports:
//   - constants.js     → AUTH_CONFIG, TIMING_CONFIG, RATE_LIMITS
//   - errorMapper.js   → error message utilities
//   - turnstile.js     → Cloudflare Turnstile utilities
//   - preflight.js     → PreflightError + preflight flow
//   - authFlow.js      → auth flow helpers
//   - errors.js        → CompletionError (via window.CompletionError for classic scripts)
//   - user-helpers.js  → buildAvatarUrl, escapeHTML, isProfileComplete, etc.
//
// main.js is loaded via classic <script> tag (not ESM) because it uses window globals
// for backward compat with existing classic scripts.
// =============================================================================

// Existing ESM exports
export { AUTH_CONFIG, TIMING_CONFIG, RATE_LIMITS } from './constants.js';
export {
    ERROR_MESSAGES,
    LOGIN_ERROR_MESSAGES,
    FORGOT_PASSWORD_ERROR_MESSAGES,
    RESET_PASSWORD_ERROR_MESSAGES,
    ADMIN_REGISTER_ERROR_MESSAGES,
    LOADING_LABELS,
    getErrorMessage,
    getLoginErrorMessage,
    getForgotPasswordErrorMessage,
    getResetPasswordErrorMessage,
    shouldSuppressForgotPasswordError,
    isRateLimitError,
    getAdminRegisterErrorMessage,
    logAuthError
} from './errorMapper.js';
export {
    waitForTurnstileReady,
    getTurnstileToken,
    resetTurnstile,
    executeTurnstile,
    renderTurnstile,
    getFreshTurnstileToken,
    prerenderTurnstile,
    clearTurnstileState
} from './turnstile.js';
export {
    PreflightError,
    CompletionError,
    getStoredPreflight,
    storePreflight,
    clearPreflight,
    getDeviceFingerprint,
    runPreflightValidation,
    executePreflightFlow
} from './preflight.js';
export {
    waitForSupabaseReady,
    setLoadingState,
    showMessage,
    clearMessage,
    handleAuthError,
    validateAdminRegistration,
    setupGoogleProvider,
    signInWithGoogle
} from './authFlow.js';

// v2.0.0: Re-export from extracted modules via window globals
// (errors.js & user-helpers.js are classic scripts that expose to window)
export const CompletionErrorClass = window.CompletionError;
export const AuthHelpers = window.AuthHelpers;
export const Auth = window.Auth;
