// =============================================================================
// errors.js — CompletionError class & error message mapping
// =============================================================================
//
// Extracted from auth.js (v2.0.0 restructure) for separation of concerns.
//
// Purpose:
//   Custom error class for user-auth-complete (POST Google OAuth) flow.
//   Mirrors PreflightError pattern — separates backendCode from userMessage
//   so the UI can display specific Indonesian messages instead of generic ones.
//
// Dependencies: NONE (pure self-contained module)
//
// Public API:
//   - window.CompletionError  — Error class
//   - window.AuthErrors       — { CompletionError, COMPLETION_MESSAGES }
//
// Load order: MUST be loaded BEFORE main.js (defer attribute preserves order).
//
// v2.1.3 FIX: Wrapped in IIFE. Previously, top-level `class CompletionError`
// and `const COMPLETION_MESSAGES` leaked into the global lexical environment,
// causing `SyntaxError: Identifier 'CompletionError' has already been declared`
// when main.js tried `const CompletionError = window.CompletionError;`.
// The IIFE scopes them locally; only `window.CompletionError` and
// `window.AuthErrors` leak to the global scope (which is the intended API).
// =============================================================================

(function () {

const COMPLETION_MESSAGES = {
    device_limit_reached:
        'Perangkat ini telah mencapai batas maksimum akun yang diperbolehkan. Jika ini adalah perangkat sekolah atau perangkat bersama, hubungi administrator.',
    invalid_token:
        'Sesi keamanan tidak valid. Silakan ulangi proses.',
    missing_preflight:
        'Data sesi login tidak ditemukan. Silakan coba login kembali.',
    security_mismatch:
        'Terjadi perubahan perangkat selama proses login. Silakan coba login kembali dari awal.',
    rate_limit_exceeded:
        'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    user_completion_failed:
        'Gagal menyelesaikan login. Silakan coba lagi.',
    unauthorized:
        'Anda tidak memiliki izin untuk melakukan tindakan ini.',
    unknown_error:
        'Terjadi kesalahan yang tidak diketahui. Silakan coba lagi.',
};

class CompletionError extends Error {
    constructor(backendCode, userMessage) {
        const message = userMessage || COMPLETION_MESSAGES[backendCode] || COMPLETION_MESSAGES.unknown_error;
        super(message);
        this.name = 'CompletionError';
        this.backendCode = backendCode;
    }
}

// ── Expose to window for backward compat & cross-script access ────────────────
// main.js (and other classic scripts) reads CompletionError via window global.
// ESM modules can also import from window if needed.
window.CompletionError = CompletionError;
window.AuthErrors = { CompletionError, COMPLETION_MESSAGES };

})();
