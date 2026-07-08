// auth/errorMapper.js — backend error code → user-friendly Indonesian message
//
// Single source of truth for auth error strings. Don't hardcode Indonesian
// messages in the calling files — call getErrorMessage / getForgotPasswordErrorMessage
// / getResetPasswordErrorMessage here.
//
// Keys here must match the strings the backend sends in the `error` field
// of its JSON response. Don't pass user-friendly messages as input to
// getErrorMessage() — they won't match and you'll get the generic fallback.

export const ERROR_MESSAGES = {
    // Device & Rate Limiting
    device_limit_reached:
        'Perangkat ini telah mencapai batas maksimum akun yang diperbolehkan. Jika ini adalah perangkat sekolah atau perangkat bersama, hubungi administrator.',

    rate_limit_exceeded:
        'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',

    too_many_requests:
        'Terlalu banyak percobaan. Silakan coba lagi nanti.',

    // Turnstile / Security Verification
    turnstile_failed:
        'Verifikasi keamanan gagal. Sistem akan mencoba ulang secara otomatis — jika masalah berlanjut, muat ulang halaman.',

    turnstile_expired:
        'Verifikasi keamanan kadaluarsa. Silakan coba lagi.',

    turnstile_network_error:
        'Tidak dapat terhubung ke layanan verifikasi Cloudflare. ' +
        'Periksa koneksi internet, nonaktifkan VPN/proxy, atau coba jaringan lain. ' +
        'Jika masalah berlanjut, ganti DNS ke 1.1.1.1 atau 8.8.8.8.',

    missing_verification:
        'Verifikasi keamanan tidak dapat diselesaikan. ' +
        'Pastikan widget verifikasi terlihat di halaman, tunggu hingga selesai, lalu coba lagi. ' +
        'Jika widget tidak muncul, muat ulang halaman.',

    // Auth & Session
    invalid_token:
        'Sesi keamanan tidak valid. Silakan ulangi proses.',

    expired_token:
        'Sesi login telah kadaluarsa. Silakan coba login kembali.',

    unauthorized:
        'Anda tidak memiliki izin untuk melakukan tindakan ini.',

    invalid_credentials:
        'Email atau kata sandi yang Anda masukkan tidak valid. Silakan periksa kembali dan coba lagi.',

    email_not_confirmed:
        'Akun Anda belum diverifikasi. Silakan periksa email Anda dan klik tautan verifikasi sebelum login.',

    weak_password:
        'Kata sandi terlalu lemah. Harap gunakan kata sandi yang lebih kuat.',

    // Registration
    account_exists:
        'Email ini sudah terdaftar. Silakan login atau gunakan email lain.',

    email_invalid:
        'Masukkan email yang valid.',

    password_too_short:
        'Password minimal 8 karakter.',

    password_mismatch:
        'Password dan konfirmasi password harus sama.',

    // Password Reset
    reset_email_sent:
        'Jika email terdaftar, link reset kata sandi telah dikirim ke inbox Anda. Silakan periksa email.',

    reset_link_expired:
        'Link reset kata sandi sudah kadaluarsa. Silakan minta link baru.',

    reset_invalid_token:
        'Link reset tidak valid. Silakan minta link reset baru.',

    reset_failed:
        'Gagal mengubah kata sandi. Silakan coba lagi.',

    reset_rate_limited:
        'Terlalu banyak permintaan reset. Silakan tunggu beberapa menit sebelum mencoba lagi.',

    // Security Mismatch
    security_mismatch:
        'Terjadi perubahan perangkat selama proses login. Silakan coba login kembali dari awal.',

    // System Errors
    risk_check_unavailable:
        'Sistem sedang sibuk. Coba lagi beberapa saat.',

    user_preflight_failed:
        'Gagal mempersiapkan login. Silakan coba lagi.',

    user_completion_failed:
        'Gagal menyelesaikan login. Silakan coba lagi.',

    missing_preflight:
        'Data sesi login tidak ditemukan. Silakan coba login kembali.',

    method_not_allowed:
        'Metode tidak didukung.',

    // Thrown client-side by preflight.js when window.AlbEdu.supabase.rpc
    // isn't ready yet (platform bootstrap still in progress / failed silently).
    platform_not_ready:
        'Sistem belum siap. Tunggu beberapa detik lalu coba lagi. Jika masalah berlanjut, muat ulang halaman.',

    network_error:
        'Koneksi ke server gagal. Periksa koneksi internet Anda dan coba lagi.',

    // Generic fallback
    unknown_error:
        'Terjadi kesalahan yang tidak diketahui. Silakan coba lagi.',
};

export const LOGIN_ERROR_MESSAGES = {
    'Invalid login credentials': 'Email atau kata sandi yang Anda masukkan tidak valid. Silakan periksa kembali dan coba lagi.',
    'Email not confirmed': 'Akun Anda belum diverifikasi. Silakan periksa email Anda dan klik tautan verifikasi sebelum login.',
    'rate_limit_exceeded': 'Terlalu banyak request login. Mohon tunggu beberapa menit untuk mencoba lagi.',
    'expired_token': 'Sesi login telah kadaluarsa. Silakan coba login kembali.',
    'weak_password': 'Kata sandi terlalu lemah. Harap hubungi administrator untuk reset kata sandi.',
};

// Forgot-password errors split into two categories:
//
//   1. SHOW to user — rate limit, network, redirect misconfig, SMTP.
//      These need a real message so the user knows the email wasn't sent.
//
//   2. SUPPRESS (anti-enumeration) — "user not found", "email not confirmed".
//      For these we still show the success state so attackers can't probe
//      which emails are registered. See shouldSuppressForgotPasswordError().
//
// Supabase Auth returns rate-limit errors in several formats:
//   - HTTP 429 + body: { code: 'over_email_send_rate_limit', message: 'For security purposes...' }
//   - HTTP 429 + body: { code: 'rate_limit_exceeded', message: 'Too many requests...' }
//   - JS SDK throw TypeError: 'Failed to fetch' (network down / CORS)
//   - JS SDK throw AuthError: { message: 'Email rate limit exceeded', status: 429 }
export const FORGOT_PASSWORD_ERROR_MESSAGES = {
    // Rate limiting — Supabase has several variations.
    'over_email_send_rate_limit':
        'Terlalu banyak permintaan reset kata sandi. Silakan tunggu 30 detik hingga 1 menit sebelum mencoba lagi.',
    'rate_limit_exceeded':
        'Terlalu banyak permintaan reset. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    'email rate limit exceeded':
        'Terlalu banyak permintaan reset. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    'too many requests':
        'Terlalu banyak permintaan reset. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    'for security purposes, you can only request this':
        'Untuk keamanan, permintaan reset dibatasi. Silakan tunggu 30 detik hingga 1 menit sebelum mencoba lagi.',
    'you can only request this once':
        'Untuk keamanan, permintaan reset dibatasi. Silakan tunggu beberapa saat sebelum mencoba lagi.',
    '429':
        'Terlalu banyak permintaan reset. Silakan tunggu beberapa menit sebelum mencoba lagi.',

    // Network / koneksi. 'Failed to fetch' is the classic fetch() error for:
    //   internet down, DNS failure, CORS block, SSL cert error, project paused.
    'failed to fetch':
        'Koneksi ke server gagal. Periksa internet Anda dan coba lagi beberapa saat.',
    'networkerror':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
    'network request failed':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
    'load failed':
        'Koneksi ke server gagal dimuat. Periksa internet Anda dan coba lagi.',
    'internet disconnected':
        'Internet Anda terputus. Silakan sambungkan kembali dan coba lagi.',

    // Konfigurasi redirect. Fires when reset-password.html isn't whitelisted
    // in Supabase Dashboard → Authentication → URL Configuration.
    'redirect to provided site url is not allowed':
        'Konfigurasi redirect belum disetujui. Hubungi administrator untuk menambahkan URL ini ke daftar redirect yang diizinkan.',
    'invalid redirect':
        'Konfigurasi redirect tidak valid. Hubungi administrator.',
    'redirect url mismatch':
        'Konfigurasi redirect tidak valid. Hubungi administrator.',

    // Email service / SMTP. Free tier has tight rate limits; Pro can use
    // custom SMTP.
    'error sending email':
        'Layanan email sedang bermasalah. Silakan coba lagi beberapa saat.',
    'smtp':
        'Layanan email sedang bermasalah. Silakan coba lagi beberapa saat.',
    'email_provider':
        'Layanan email sedang bermasalah. Silakan coba lagi beberapa saat.',
    'email not sent':
        'Email gagal dikirim. Silakan coba lagi beberapa saat.',
    'email_send_failed':
        'Email gagal dikirim. Silakan coba lagi beberapa saat.',

    // SDK / client-side errors
    'supabase not ready':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
    'auth not available':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
    'sistem autentikasi belum siap':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
};

// Anti-enumeration: only errors that signal "email/user doesn't exist" get
// suppressed. Rate-limit, network, and SMTP errors MUST be shown — otherwise
// the user thinks the email was sent when it wasn't.
const _FORGOT_PASSWORD_SUPPRESS_PATTERNS = [
    'user not found',
    'user not registered',
    'email not confirmed',   // user exists but unverified — still suppress
    'email not verified',
    'no user found',
    'invalid email',         // technically a client-side validation miss
];

export function shouldSuppressForgotPasswordError(error) {
    const msg = String(error?.message || error?.code || '').toLowerCase();
    if (!msg) return false;
    return _FORGOT_PASSWORD_SUPPRESS_PATTERNS.some(pattern => msg.includes(pattern));
}

export function getForgotPasswordErrorMessage(errorCodeOrMessage) {
    if (!errorCodeOrMessage || typeof errorCodeOrMessage !== 'string') {
        return ERROR_MESSAGES.unknown_error;
    }

    const lower = errorCodeOrMessage.toLowerCase();

    // Exact match first (fastest)
    if (FORGOT_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage]) {
        return FORGOT_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage];
    }
    if (FORGOT_PASSWORD_ERROR_MESSAGES[lower]) {
        return FORGOT_PASSWORD_ERROR_MESSAGES[lower];
    }

    // Partial match — order matters: most specific to most general so
    // 'over_email_send_rate_limit' wins over 'rate_limit_exceeded'.
    for (const [key, message] of Object.entries(FORGOT_PASSWORD_ERROR_MESSAGES)) {
        if (lower.includes(key.toLowerCase())) {
            return message;
        }
    }

    if (ERROR_MESSAGES[errorCodeOrMessage]) {
        return ERROR_MESSAGES[errorCodeOrMessage];
    }

    return ERROR_MESSAGES.unknown_error;
}

// ForgotPassword.js uses this to decide whether the resend button needs
// cooldown. Rate-limit → mandatory cooldown. Other errors → user can retry
// immediately.
export function isRateLimitError(errorCodeOrMessage) {
    if (!errorCodeOrMessage || typeof errorCodeOrMessage !== 'string') return false;
    const lower = errorCodeOrMessage.toLowerCase();
    const RATE_LIMIT_PATTERNS = [
        'rate_limit',
        'rate limit',
        'too many requests',
        'over_email_send_rate_limit',
        'email rate limit',
        '429',
        'for security purposes, you can only request',
    ];
    return RATE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

// Reset-password errors — POST the link click from email.
export const RESET_PASSWORD_ERROR_MESSAGES = {
    // Token / link errors
    'otp_expired':
        'Link reset kata sandi sudah kedaluarsa. Link hanya berlaku 24 jam — silakan minta link reset baru.',
    'invalid_otp':
        'Link reset kata sandi tidak valid atau sudah pernah digunakan. Satu link hanya bisa dipakai satu kali.',
    'access_denied':
        'Akses ditolak. Link reset tidak dapat digunakan — kemungkinan sudah kadaluarsa atau sudah dipakai.',
    'token_expired':
        'Sesi reset sudah kadaluarsa. Silakan minta link reset baru.',
    'token_invalid':
        'Link reset tidak valid. Silakan minta link reset baru.',
    'session_missing':
        'Sesi reset tidak ditemukan. Silakan buka link reset dari email Anda.',
    'session_not_found':
        'Sesi reset tidak ditemukan. Silakan buka link reset dari email Anda.',
    'no_session':
        'Sesi reset tidak ditemukan. Silakan buka link reset dari email Anda.',

    // Password validation
    'same password':
        'Kata sandi baru tidak boleh sama dengan kata sandi lama. Silakan gunakan kata sandi yang berbeda.',
    'password_too_short':
        'Kata sandi minimal 8 karakter.',
    'weak password':
        'Kata sandi terlalu lemah. Gunakan kombinasi huruf besar, huruf kecil, angka, dan simbol.',
    'weak_password':
        'Kata sandi terlalu lemah. Gunakan kombinasi huruf besar, huruf kecil, angka, dan simbol.',
    'password_strength':
        'Kata sandi terlalu lemah. Gunakan kombinasi huruf besar, huruf kecil, angka, dan simbol.',

    // User not found — rare, but possible if user is deleted between email
    // send and link click.
    'user not found':
        'Akun tidak ditemukan. Kemungkinan akun sudah dihapus. Hubungi administrator.',
    'user not registered':
        'Akun tidak ditemukan. Kemungkinan akun sudah dihapus. Hubungi administrator.',

    // Network
    'failed to fetch':
        'Koneksi ke server gagal. Periksa internet Anda dan coba lagi.',
    'networkerror':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
    'network request failed':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
};

export function getResetPasswordErrorMessage(errorCodeOrMessage) {
    if (!errorCodeOrMessage || typeof errorCodeOrMessage !== 'string') {
        return ERROR_MESSAGES.reset_failed;
    }

    const lower = errorCodeOrMessage.toLowerCase();

    if (RESET_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage]) {
        return RESET_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage];
    }
    if (RESET_PASSWORD_ERROR_MESSAGES[lower]) {
        return RESET_PASSWORD_ERROR_MESSAGES[lower];
    }

    for (const [key, message] of Object.entries(RESET_PASSWORD_ERROR_MESSAGES)) {
        if (lower.includes(key.toLowerCase())) {
            return message;
        }
    }

    if (ERROR_MESSAGES[errorCodeOrMessage]) {
        return ERROR_MESSAGES[errorCodeOrMessage];
    }

    return ERROR_MESSAGES.reset_failed;
}

export const ADMIN_REGISTER_ERROR_MESSAGES = {
    'Email tidak valid.': 'Masukkan email yang valid.',
    'Password minimal 8 karakter.': 'Password minimal 8 karakter.',
    'Verifikasi Turnstile wajib diisi.': 'Verifikasi keamanan belum selesai.',
    'Verifikasi Turnstile gagal.': 'Verifikasi keamanan gagal.',
    'Terlalu banyak percobaan. Silakan coba lagi nanti.': 'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    'Perangkat ini sudah mencapai batas maksimum 2 akun admin AlbEdu. Silakan gunakan akun admin yang sudah ada.':
        'Perangkat ini telah mencapai batas maksimum akun yang diperbolehkan.',
    'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.':
        'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
};

export const LOADING_LABELS = {
    preparing: 'Menyiapkan...',
    verifying_security: 'Memverifikasi keamanan...',
    checking_data: 'Memeriksa data...',
    connecting_google: 'Menghubungkan ke Google...',
    processing_login: 'Memproses login...',
    processing_registration: 'Memproses pendaftaran...',
    sending_reset_email: 'Mengirim link reset...',
    resetting_password: 'Menyimpan kata sandi baru...',
    redirecting: 'Mengalihkan...',
    success: 'Berhasil.',
};

// All Indonesian strings ERROR_MESSAGES produces — used to detect when an
// input is already a final message (not a backend code that needs mapping).
const _knownUserFriendlyMessages = new Set(Object.values(ERROR_MESSAGES));

// Module-level Set so we don't allocate one per getErrorMessage() call.
const _safeServerMessages = new Set([
    'Email tidak valid.',
    'Password minimal 8 karakter.',
    'Verifikasi Turnstile wajib diisi.',
    'Verifikasi Turnstile gagal.',
    'Terlalu banyak percobaan. Silakan coba lagi nanti.',
    'Perangkat ini sudah mencapai batas maksimum 2 akun admin AlbEdu. Silakan gunakan akun admin yang sudah ada.',
    'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    // Backend error codes that are also safe to display directly.
    // register-admin sends "device_limit_reached" as the error code.
    'device_limit_reached',
    'rate_limit_exceeded',
]);

// Returns the user-friendly message for a backend error code.
//
// Pass the BACKEND error code, not an already-translated message —
// already-translated messages won't match the map and fall through to the
// generic fallback.
export function getErrorMessage(errorCode, fallback = ERROR_MESSAGES.unknown_error) {
    if (!errorCode || typeof errorCode !== 'string') {
        return fallback;
    }

    // Guard against double-mapping: if input is already one of our own
    // user-friendly strings (for example err.message was set by a previous
    // getErrorMessage() call), return it as-is.
    if (_knownUserFriendlyMessages.has(errorCode)) {
        return errorCode;
    }

    if (ERROR_MESSAGES[errorCode]) {
        return ERROR_MESSAGES[errorCode];
    }

    // Partial match (case-insensitive) so 'RATE_LIMIT_EXCEEDED' and
    // 'Device limit reached' still match.
    const lowerCode = errorCode.toLowerCase();
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
        if (lowerCode.includes(key.toLowerCase())) {
            return message;
        }
    }

    if (_safeServerMessages.has(errorCode)) {
        return errorCode;
    }

    return fallback;
}

export function getLoginErrorMessage(errorCode) {
    return getErrorMessage(errorCode, LOGIN_ERROR_MESSAGES['Invalid login credentials'] || ERROR_MESSAGES.unknown_error);
}

export function getAdminRegisterErrorMessage(errorCode) {
    return getErrorMessage(errorCode, ERROR_MESSAGES.unknown_error);
}

export function logAuthError({ flow, error, backendCode, context = {} }) {
    const errorObj = error instanceof Error ? error : new Error(String(error));

    console.error('[AuthError]', {
        flow,
        timestamp: new Date().toISOString(),
        userAgent: navigator?.userAgent || 'unknown',
        backendError: backendCode || null,
        errorMessage: errorObj.message,
        errorStack: errorObj.stack,
        ...context,
    });
}
