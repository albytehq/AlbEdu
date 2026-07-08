// auth/user-helpers.js — pure helpers for auth user data
//
// IIFE-scoped because main.js re-aliases each of these at module scope
// (`const escapeHTML = window.AuthHelpers.escapeHTML`). Without the IIFE the
// bare `function escapeHTML` declaration collides with that alias.

(function () {

const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const PROFILE_FETCH_TIMEOUT_MS = 8_000;
const AUTH_STATE_TIMEOUT_MS    = 10_000;
const REDIRECT_DELAY_MS        = 300;
const LOGOUT_REDIRECT_DELAY_MS = 500;
const LOGIN_NOTICE_REDIRECT_DELAY_MS = 1_800;
const PAGE_404_REDIRECT_DELAY_MS     = 5_000;

const USER_PREFLIGHT_KEY = 'albedu_user_auth_preflight';
const USER_PREFLIGHT_TTL_MS = 15 * 60 * 1000;

// ui-avatars instead of DiceBear: albyte-upload-api has a cleanup bot that
// nukes uploaded images, and the DiceBear CDN had rollback issues.
// ui-avatars.com is deterministic and serves an initials SVG — no bot risk.
function buildAvatarUrl(seed) {
    const raw      = (seed || 'U').split('@')[0].replace(/[._\-]/g, ' ');
    const words    = raw.trim().split(/\s+/);
    const initials = words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : raw.slice(0, 2).toUpperCase();
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=2563eb&color=ffffff&size=128&bold=true&format=svg`;
}

// Single source for escaping — shared with panel.js, editor-panel.js, etc.
function escapeHTML(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isProfileComplete(data) {
    if (!data) return false;
    // avatar_url is the current column name (renamed from foto_profil by
    // migration 20260701_002_alter_users_snake_case.sql). Keep all three
    // shapes readable so legacy callers don't break.
    const foto = data.avatar_url || data.foto_profil || data.fotoProfil || '';
    return typeof data.nama === 'string' && data.nama.trim().length > 0
        && typeof foto       === 'string' && foto.trim().length > 0;
}

function makeProfileState(isComplete) {
    return { isProfileComplete: isComplete, isLoading: false, hasChanges: false };
}

function normalizeUserDoc(data, userId) {
    data.nama  = data.nama  || '';
    data.peran = data.peran || 'peserta';

    // Sync all three key shapes (avatar_url / foto_profil / fotoProfil) so
    // isProfileComplete() and any legacy display code (panel.js, navigasi.js,
    // ui.js, profile editor) keep working regardless of which they read.
    const existingFoto = data.avatar_url || data.foto_profil || data.fotoProfil || '';
    const resolvedFoto = existingFoto || buildAvatarUrl(data.email || userId);

    data.avatar_url   = resolvedFoto;
    data.foto_profil  = resolvedFoto;
    data.fotoProfil   = resolvedFoto;

    return data;
}

function getUserPreflight() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(USER_PREFLIGHT_KEY) || 'null');
        if (!parsed?.preflightId || !parsed?.deviceId || !parsed?.createdAt) return null;
        if (Date.now() - parsed.createdAt > USER_PREFLIGHT_TTL_MS) {
            sessionStorage.removeItem(USER_PREFLIGHT_KEY);
            return null;
        }
        return parsed;
    } catch (_) {
        return null;
    }
}

window.AuthHelpers = {
    buildAvatarUrl,
    escapeHTML,
    isProfileComplete,
    makeProfileState,
    normalizeUserDoc,
    getUserPreflight,
    USER_PREFLIGHT_KEY,
    USER_PREFLIGHT_TTL_MS,
    PROFILE_FETCH_TIMEOUT_MS,
    AUTH_STATE_TIMEOUT_MS,
    REDIRECT_DELAY_MS,
    LOGOUT_REDIRECT_DELAY_MS,
    LOGIN_NOTICE_REDIRECT_DELAY_MS,
    PAGE_404_REDIRECT_DELAY_MS,
    isDev,
};

})();
