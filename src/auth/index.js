// auth/index.js — barrel re-exports for the auth feature
//
// main.js stays as a classic <script> (uses window globals for back-compat
// with older code that reads window.Auth directly). The other modules here
// are ESM.

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

// errors.js and user-helpers.js are classic scripts that expose via window.
export const CompletionErrorClass = window.CompletionError;
export const AuthHelpers = window.AuthHelpers;
export const Auth = window.Auth;
