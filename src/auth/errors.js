// auth/errors.js — CompletionError class for user-auth-complete flow
//
// IIFE-scoped because main.js also re-aliases CompletionError at module scope;
// without the IIFE the bare `class` declaration collides with that alias on
// browsers that don't tolerate redeclaration of the same lexical name.

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

window.CompletionError = CompletionError;
window.AuthErrors = { CompletionError, COMPLETION_MESSAGES };

})();
