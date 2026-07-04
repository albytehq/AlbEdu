// =============================================================================
// auth/errorMapper.js — Pemetaan error backend ke pesan user-friendly
// =============================================================================
//
// Satu sumber kebenaran untuk semua pesan error autentikasi.
// Tidak ada lagi hardcoded string yang tersebar di berbagai file.
// =============================================================================

/**
 * Peta kode error backend ke pesan yang ramah untuk pengguna.
 * Semua flow (login user, registrasi user, registrasi admin) 
 * menggunakan mapping yang sama.
 * 
 * IMPORTANT: Kunci (key) di sini HARUS sesuai dengan string yang dikirim
 * oleh backend di field `error` pada JSON response.
 * JANGAN pernah mem-pass pesan user-friendly sebagai input ke getErrorMessage()
 * karena akan gagal dicocokkan.
 */
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
    
    missing_verification:
        'Verifikasi keamanan belum selesai. Silakan tunggu hingga verifikasi selesai.',
    
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
    
    // Registration Specific
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

    network_error:
        'Koneksi ke server gagal. Periksa koneksi internet Anda dan coba lagi.',

    // Generic fallback
    unknown_error:
        'Terjadi kesalahan yang tidak diketahui. Silakan coba lagi.',
};

/**
 * Pesan error khusus untuk flow login (admin/peserta dengan email+password)
 */
export const LOGIN_ERROR_MESSAGES = {
    'Invalid login credentials': 'Email atau kata sandi yang Anda masukkan tidak valid. Silakan periksa kembali dan coba lagi.',
    'Email not confirmed': 'Akun Anda belum diverifikasi. Silakan periksa email Anda dan klik tautan verifikasi sebelum login.',
    'rate_limit_exceeded': 'Terlalu banyak request login. Mohon tunggu beberapa menit untuk mencoba lagi.',
    'expired_token': 'Sesi login telah kadaluarsa. Silakan coba login kembali.',
    'weak_password': 'Kata sandi terlalu lemah. Harap hubungi administrator untuk reset kata sandi.',
};

/**
 * Pesan error khusus untuk flow forgot-password (request reset link).
 *
 * Dibagi menjadi dua kategori:
 *   1. Error yang HARUS ditampilkan ke user (tidak boleh di-suppress):
 *      - Rate limit / too many requests
 *      - Network error
 *      - Konfigurasi redirect tidak valid
 *      - SMTP / email service mati
 *
 *   2. Error yang TIDAK ditampilkan (anti-enumeration):
 *      - User not found (email tidak terdaftar)
 *      - Email not confirmed
 *      Untuk kategori ini, frontend tetap tampilkan success state.
 *
 * Kunci (key) di map ini adalah pattern string yang akan dicocokkan dengan
 * error.message atau error.code dari Supabase (case-insensitive, partial match).
 *
 * SUMBER ERROR: Supabase Auth API merespons dengan beberapa format:
 *   - HTTP 429 + body: { code: 'over_email_send_rate_limit', message: 'For security purposes...' }
 *   - HTTP 429 + body: { code: 'rate_limit_exceeded', message: 'Too many requests...' }
 *   - JS SDK throw TypeError: 'Failed to fetch' (network down / CORS)
 *   - JS SDK throw AuthError: { message: 'Email rate limit exceeded', status: 429 }
 *
 * Mapping ini mencakup SEMUA variasi yang pernah ditemui di produksi.
 */
export const FORGOT_PASSWORD_ERROR_MESSAGES = {
    // ── Rate limiting — Supabase punya banyak variasi pesan ────────────────
    // Paling umum di Supabase Auth v2:
    //   code: 'over_email_send_rate_limit'
    //   message: 'For security purposes, you can only request this after 30 seconds'
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

    // ── Network / koneksi ────────────────────────────────────────────────
    // 'Failed to fetch' adalah error klasik dari fetch() saat:
    //   - Internet down
    //   - DNS resolution gagal
    //   - CORS block
    //   - SSL cert error
    //   - Supabase project unreachable (deleted / paused)
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

    // ── Konfigurasi redirect ─────────────────────────────────────────────
    // Terjadi kalau URL `reset-password.html` belum di-whitelist di
    // Supabase Dashboard → Authentication → URL Configuration
    'redirect to provided site url is not allowed':
        'Konfigurasi redirect belum disetujui. Hubungi administrator untuk menambahkan URL ini ke daftar redirect yang diizinkan.',
    'invalid redirect':
        'Konfigurasi redirect tidak valid. Hubungi administrator.',
    'redirect url mismatch':
        'Konfigurasi redirect tidak valid. Hubungi administrator.',

    // ── Email service / SMTP ─────────────────────────────────────────────
    // Supabase free tier pakai built-in email dengan rate limit ketat.
    // Pro plan bisa pakai custom SMTP.
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

    // ── SDK / client-side errors ─────────────────────────────────────────
    'supabase not ready':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
    'auth not available':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
    'sistem autentikasi belum siap':
        'Sistem autentikasi belum siap. Silakan muat ulang halaman.',
};

/**
 * Pattern error yang HARUS di-suppress untuk anti-enumeration.
 * Jika error.message atau error.code match salah satu pattern ini,
 * frontend tetap tampilkan success state (seolah email terkirim)
 * supaya attacker tidak bisa menebak email mana yang terdaftar.
 *
 * PENTING: HANYA error yang mengindikasikan email/user TIDAK ADA yang
 * boleh di-suppress. Error rate-limit, network, SMTP TIDAK boleh di-
 * suppress karena user perlu tahu kalau emailnya NGGAK terkirim.
 */
const _FORGOT_PASSWORD_SUPPRESS_PATTERNS = [
    'user not found',
    'user not registered',
    'email not confirmed',   // user ada tapi belum verifikasi email — tetap suppress
    'email not verified',
    'no user found',
    'invalid email',         // format email salah — tapi ini sebenarnya validasi client-side
];

/**
 * Cek apakah error forgot-password harus di-suppress (anti-enumeration)
 * atau ditampilkan ke user.
 *
 * @param {Error|Object} error - Error object dari Supabase
 * @returns {boolean} true jika error harus di-suppress (tampilkan success)
 */
export function shouldSuppressForgotPasswordError(error) {
    const msg = String(error?.message || error?.code || '').toLowerCase();
    if (!msg) return false;
    return _FORGOT_PASSWORD_SUPPRESS_PATTERNS.some(pattern => msg.includes(pattern));
}

/**
 * Dapatkan pesan error user-friendly untuk flow forgot-password.
 *
 * @param {string} errorCodeOrMessage - error.message atau error.code dari Supabase
 * @returns {string} Pesan yang aman untuk ditampilkan ke pengguna
 */
export function getForgotPasswordErrorMessage(errorCodeOrMessage) {
    if (!errorCodeOrMessage || typeof errorCodeOrMessage !== 'string') {
        return ERROR_MESSAGES.unknown_error;
    }

    const lower = errorCodeOrMessage.toLowerCase();

    // Cek exact match dulu (paling cepat)
    if (FORGOT_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage]) {
        return FORGOT_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage];
    }
    if (FORGOT_PASSWORD_ERROR_MESSAGES[lower]) {
        return FORGOT_PASSWORD_ERROR_MESSAGES[lower];
    }

    // Cek partial match (case-insensitive) — urutan penting: dari paling
    // spesifik ke paling umum. Misal 'over_email_send_rate_limit' harus match
    // SEBELUM 'rate_limit_exceeded' supaya pesan yang lebih spesifik yang dipakai.
    for (const [key, message] of Object.entries(FORGOT_PASSWORD_ERROR_MESSAGES)) {
        if (lower.includes(key.toLowerCase())) {
            return message;
        }
    }

    // Fallback ke ERROR_MESSAGES umum
    if (ERROR_MESSAGES[errorCodeOrMessage]) {
        return ERROR_MESSAGES[errorCodeOrMessage];
    }

    return ERROR_MESSAGES.unknown_error;
}

/**
 * Deteksi apakah error adalah rate-limit (untuk keperluan UI cooldown).
 *
 * Dipakai oleh ForgotPassword.js untuk memutuskan: setelah error ini, apakah
 * tombol resend harus di-cooldown, atau user boleh langsung coba lagi.
 * Untuk rate-limit: WAJIB cooldown supaya user nggak spam.
 * Untuk error lain (network, dll): boleh coba lagi langsung.
 *
 * @param {string} errorCodeOrMessage - error.message atau error.code dari Supabase
 * @returns {boolean}
 */
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

// ============================================================================
// Pesan error khusus untuk flow reset-password (POST reset link dari email)
// ============================================================================

export const RESET_PASSWORD_ERROR_MESSAGES = {
    // ── Token / link errors ──────────────────────────────────────────────
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

    // ── Password validation errors ──────────────────────────────────────
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

    // ── User not found (rare, but possible kalau user di-delete antara
    //    kirim email dan klik link) ──────────────────────────────────────
    'user not found':
        'Akun tidak ditemukan. Kemungkinan akun sudah dihapus. Hubungi administrator.',
    'user not registered':
        'Akun tidak ditemukan. Kemungkinan akun sudah dihapus. Hubungi administrator.',

    // ── Network ──────────────────────────────────────────────────────────
    'failed to fetch':
        'Koneksi ke server gagal. Periksa internet Anda dan coba lagi.',
    'networkerror':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
    'network request failed':
        'Koneksi ke server terputus. Periksa internet Anda dan coba lagi.',
};

/**
 * Dapatkan pesan error user-friendly untuk flow reset-password (form input password baru).
 *
 * @param {string} errorCodeOrMessage - error.message atau error.code dari Supabase
 * @returns {string} Pesan yang aman untuk ditampilkan ke pengguna
 */
export function getResetPasswordErrorMessage(errorCodeOrMessage) {
    if (!errorCodeOrMessage || typeof errorCodeOrMessage !== 'string') {
        return ERROR_MESSAGES.reset_failed;
    }

    const lower = errorCodeOrMessage.toLowerCase();

    // Exact match
    if (RESET_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage]) {
        return RESET_PASSWORD_ERROR_MESSAGES[errorCodeOrMessage];
    }
    if (RESET_PASSWORD_ERROR_MESSAGES[lower]) {
        return RESET_PASSWORD_ERROR_MESSAGES[lower];
    }

    // Partial match
    for (const [key, message] of Object.entries(RESET_PASSWORD_ERROR_MESSAGES)) {
        if (lower.includes(key.toLowerCase())) {
            return message;
        }
    }

    // Fallback ke ERROR_MESSAGES umum
    if (ERROR_MESSAGES[errorCodeOrMessage]) {
        return ERROR_MESSAGES[errorCodeOrMessage];
    }

    return ERROR_MESSAGES.reset_failed;
}

/**
 * Pesan error khusus untuk flow registrasi admin
 */
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

/**
 * Label status loading yang konsisten di semua flow
 */
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

/**
 * Set berisi semua pesan user-friendly yang dihasilkan oleh ERROR_MESSAGES.
 * Digunakan untuk mendeteksi apakah sebuah string sudah merupakan pesan final
 * (bukan error code backend yang perlu di-map lagi).
 */
const _knownUserFriendlyMessages = new Set(Object.values(ERROR_MESSAGES));

// FIX BUG-07: safeMessages Set dipindah ke module-level supaya tidak
// di-recreate setiap kali getErrorMessage() dipanggil. Sebelumnya
// new Set() dibuat di dalam fungsi → GC pressure pada high-traffic.
const _safeServerMessages = new Set([
    'Email tidak valid.',
    'Password minimal 8 karakter.',
    'Verifikasi Turnstile wajib diisi.',
    'Verifikasi Turnstile gagal.',
    'Terlalu banyak percobaan. Silakan coba lagi nanti.',
    'Perangkat ini sudah mencapai batas maksimum 2 akun admin AlbEdu. Silakan gunakan akun admin yang sudah ada.',
    'Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi.',
    // FIX BUG-09: Tambahkan error code dari backend yang juga safe untuk ditampilkan.
    // Edge function register-admin mengirim "device_limit_reached" sebagai error code.
    'device_limit_reached',
    'rate_limit_exceeded',
]);

/**
 * Mendapatkan pesan error yang ramah untuk pengguna berdasarkan kode error.
 * 
 * IMPORTANT: Parameter errorCode HARUS berupa kode error dari backend
 * (contoh: 'device_limit_reached', 'rate_limit_exceeded').
 * JANGAN mem-pass pesan user-friendly yang sudah di-map sebagai input,
 * karena akan gagal dicocokkan dan menghasilkan fallback 'unknown_error'.
 * 
 * @param {string} errorCode - Kode error dari backend
 * @param {string} [fallback] - Pesan fallback jika kode tidak dikenali
 * @returns {string} Pesan yang aman untuk ditampilkan ke pengguna
 */
export function getErrorMessage(errorCode, fallback = ERROR_MESSAGES.unknown_error) {
    if (!errorCode || typeof errorCode !== 'string') {
        return fallback;
    }

    // v2.0.0: i18n lookup FIRST — try `auth.err.{errorCode}` key.
    // Falls back to ERROR_MESSAGES map if i18n key not found or i18n not loaded.
    if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
        const i18nKey = `auth.err.${errorCode}`;
        const i18nMsg = window.i18n.t(i18nKey);
        if (i18nMsg !== undefined) return i18nMsg;
    }

    // GUARD: Jika input sudah merupakan pesan user-friendly yang kita hasilkan
    // sendiri, jangan map ulang — kembalikan langsung. Ini mencegah
    // double-mapping ketika err.message sudah berisi pesan Indonesia
    // dari getErrorMessage() sebelumnya.
    if (_knownUserFriendlyMessages.has(errorCode)) {
        return errorCode;
    }

    // Cek exact match dulu (paling cepat dan paling akurat)
    if (ERROR_MESSAGES[errorCode]) {
        return ERROR_MESSAGES[errorCode];
    }

    // Cek partial match (case-insensitive) untuk fleksibilitas.
    // Misalnya: 'RATE_LIMIT_EXCEEDED' atau 'Device limit reached' tetap match.
    const lowerCode = errorCode.toLowerCase();
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
        if (lowerCode.includes(key.toLowerCase())) {
            // v2.0.0: try i18n for partial match too
            if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function') {
                const i18nMsg = window.i18n.t(`auth.err.${key}`);
                if (i18nMsg !== undefined) return i18nMsg;
            }
            return message;
        }
    }
    
    // Cek apakah ini adalah pesan yang sudah aman (dari SAFE_SERVER_MESSAGES)
    // yang dikirim langsung oleh backend admin-registration.
    // FIX BUG-07: Gunakan module-level _safeServerMessages, bukan bikin Set baru.
    if (_safeServerMessages.has(errorCode)) {
        return errorCode;
    }
    
    return fallback;
}

/**
 * Mendapatkan pesan error khusus untuk flow login
 * @param {string} errorCode 
 * @returns {string}
 */
export function getLoginErrorMessage(errorCode) {
    return getErrorMessage(errorCode, LOGIN_ERROR_MESSAGES['Invalid login credentials'] || ERROR_MESSAGES.unknown_error);
}

/**
 * Mendapatkan pesan error khusus untuk registrasi admin
 * @param {string} errorCode
 * @returns {string}
 */
export function getAdminRegisterErrorMessage(errorCode) {
    return getErrorMessage(errorCode, ERROR_MESSAGES.unknown_error);
}

/**
 * Log error secara terstruktur untuk analytics/debugging.
 * Tidak menampilkan detail internal ke pengguna.
 * @param {Object} options
 * @param {string} options.flow - 'user-login' | 'user-register' | 'admin-register'
 * @param {Error|string} options.error - Error object atau pesan
 * @param {string} [options.backendCode] - Kode error dari backend
 * @param {Object} [options.context] - Konteks tambahan (deviceId, userAgent, dll)
 */
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