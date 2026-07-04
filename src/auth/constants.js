// =============================================================================
// auth/constants.js — Konstanta dan konfigurasi autentikasi
// =============================================================================

export const AUTH_CONFIG = {
    TURNSTILE_SITE_KEY: '0x4AAAAAADtSMQt5KNMPWBzW',
    PREFLIGHT_KEY: 'albedu_user_auth_preflight',
    PREFLIGHT_TTL_MS: 15 * 60 * 1000, // 15 menit
};

export const TIMING_CONFIG = {
    PROFILE_FETCH_TIMEOUT_MS: 8_000,
    AUTH_STATE_TIMEOUT_MS: 10_000,
    REDIRECT_DELAY_MS: 300,
    LOGOUT_REDIRECT_DELAY_MS: 500,
    LOGIN_NOTICE_REDIRECT_DELAY_MS: 1_800,
    TURNSTILE_READY_TIMEOUT_MS: 30_000,  // was 10s — bumped for slow networks/DNS
    SUPABASE_READY_TIMEOUT_MS: 15_000,
};

export const RATE_LIMITS = {
    DEVICE_ATTEMPTS_WINDOW_MS: 60 * 60 * 1000, // 1 jam
    DEVICE_MAX_ATTEMPTS: 10,
    IP_MAX_ATTEMPTS: 120,
    ADMIN_DEVICE_MAX_ACCOUNTS: 2,
};