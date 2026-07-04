// =============================================================================
// user-helpers.js — Pure utility functions for auth user data
// =============================================================================
//
// Extracted from auth.js (v2.0.0 restructure) for separation of concerns.
//
// Purpose:
//   Houses pure (side-effect-free) helper functions for auth user data:
//   - Avatar URL generation
//   - HTML escaping (XSS prevention)
//   - Profile completeness validation
//   - User document normalization (Firestore + Supabase compat)
//   - Preflight session retrieval
//
// Dependencies:
//   - NONE (pure functions, only constants)
//
// Public API:
//   - window.AuthHelpers — {
//       buildAvatarUrl, escapeHTML, isProfileComplete,
//       makeProfileState, normalizeUserDoc, getUserPreflight,
//       USER_PREFLIGHT_KEY, USER_PREFLIGHT_TTL_MS,
//       PROFILE_FETCH_TIMEOUT_MS, AUTH_STATE_TIMEOUT_MS,
//       REDIRECT_DELAY_MS, LOGOUT_REDIRECT_DELAY_MS,
//       LOGIN_NOTICE_REDIRECT_DELAY_MS, PAGE_404_REDIRECT_DELAY_MS,
//       isDev
//     }
//
// Load order: MUST be loaded BEFORE main.js (defer attribute preserves order).
//
// v2.1.3 FIX: Wrapped in IIFE. Previously, top-level `const` and `function`
// declarations (isDev, PROFILE_FETCH_TIMEOUT_MS, escapeHTML, etc.) leaked
// into the global lexical environment, causing
// `SyntaxError: Identifier 'X' has already been declared` when main.js
// tried `const X = window.AuthHelpers.X;` for each of these names.
// The IIFE scopes them locally; only `window.AuthHelpers` leaks to the
// global scope (which is the intended API).
// =============================================================================

(function () {

// ── Timing constants (extracted from auth.js) ────────────────────────────────
// BUGFIX N: Gate verbose [AuthRedirect] logs behind isDev so production
// consoles stay clean. Previously every redirect logged full path info,
// role, and timing — noisy and a minor info-leak in prod.
const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const PROFILE_FETCH_TIMEOUT_MS = 8_000;
const AUTH_STATE_TIMEOUT_MS    = 10_000;
const REDIRECT_DELAY_MS        = 300;
const LOGOUT_REDIRECT_DELAY_MS = 500;
const LOGIN_NOTICE_REDIRECT_DELAY_MS = 1_800;
const PAGE_404_REDIRECT_DELAY_MS     = 5_000;  // 404: "kembali ke halaman sebelumnya" setelah 5 detik

const USER_PREFLIGHT_KEY = 'albedu_user_auth_preflight';
const USER_PREFLIGHT_TTL_MS = 15 * 60 * 1000;

// ── Avatar ────────────────────────────────────────────────────────────────────
// WHY ui-avatars instead of DiceBear: albyte-upload-api has a cleanup bot that
// deletes uploaded images, and DiceBear CDN had rollback issues. ui-avatars.com
// is deterministic, stable, returns initials SVG — no bot cleanup risk.
function buildAvatarUrl(seed) {
    const raw      = (seed || 'U').split('@')[0].replace(/[._\-]/g, ' ');
    const words    = raw.trim().split(/\s+/);
    const initials = words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : raw.slice(0, 2).toUpperCase();
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=2563eb&color=ffffff&size=128&bold=true&format=svg`;
}

// ── Escape helper ─────────────────────────────────────────────────────────────
// Satu sumber kebenaran — dipakai panel.js, ProfileEditorPanel.js, dll.
function escapeHTML(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Profile helpers ───────────────────────────────────────────────────────────
function isProfileComplete(data) {
    if (!data) return false;
    // Support avatar_url (current schema, since migration
    // 20260701_002_alter_users_snake_case.sql renamed foto_profil → avatar_url),
    // plus the legacy snake_case/camelCase aliases for backward compat with any
    // caller still passing the pre-migration shape.
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

    // avatar_url is the current DB column (renamed from foto_profil by
    // migration 20260701_002_alter_users_snake_case.sql). Keep all three key
    // shapes in sync so isProfileComplete() and any legacy display code
    // (panel.js, navigasi.js, ui.js, profile editor, etc.) work regardless of
    // which field name they read.
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

// ── Expose to window for backward compat & cross-script access ────────────────
// main.js reads these via window.AuthHelpers.*
window.AuthHelpers = {
    buildAvatarUrl,
    escapeHTML,
    isProfileComplete,
    makeProfileState,
    normalizeUserDoc,
    getUserPreflight,
    // Constants also exposed (main.js reads them)
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
