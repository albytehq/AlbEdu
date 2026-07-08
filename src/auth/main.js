// auth/main.js — AlbEdu auth bootstrap + window.Auth public API
//
// Dependencies (load order — all `defer` so order preserved):
//   1. errors.js        → window.CompletionError, window.AuthErrors
//   2. user-helpers.js  → window.AuthHelpers
//   3. main.js          → window.Auth (this file)
//
// Boot sequence:
//   1. supabase-client.js inits Supabase, dispatches albedu:platform-ready
//   2. this file listens for that event, then attaches onAuthStateChange
//   3. Supabase fires handler → fetch user data → update UI

// Re-aliased from errors.js (loaded before this file).
const CompletionError = window.CompletionError;

const AUTH_CONFIG = {
    // BASE_PATH resolved once at load, environment-agnostic.
    //
    // Walk up past known app subfolders so /pages/login.html, /admin/index.html,
    // and /AlbEdu/pages/login.html all resolve to the right base.
    //
    // Examples:
    //   localhost:5500/login.html              → '/'
    //   localhost:5500/ujian/index.html        → '/'
    //   localhost:5500/pages/login.html        → '/'
    //   vercel.app/AlbEdu/login.html           → '/AlbEdu/'
    //   vercel.app/AlbEdu/admin/index.html     → '/AlbEdu/'
    //   github.io/AlbEdu/pages/login.html      → '/AlbEdu/'
    BASE_PATH: (function () {
        const p    = window.location.pathname;
        const base = p.substring(0, p.lastIndexOf('/') + 1);

        // Walk up past known app subfolders. No 'guru/' — that role was
        // removed. List order matters: longer paths must come first so they
        // match before the shorter parent path eats the check.
        //
        // `/pages/admin/pages/` and `/admin/pages/` are kept for backward
        // compat with old bookmarked URLs that point to the pre-flatten
        // structure — they hit root 404.html, which still needs to derive
        // BASE_PATH correctly so its redirect links resolve. Harmless on
        // live pages (no admin page lives there anymore) and free at runtime.
        //
        // `/pages/` is on the list because /pages/login.html previously
        // returned BASE_PATH='/pages/' instead of '/', causing pathForRole()
        // to produce /pages/pages/admin/index.html — a doubled segment → 404
        // after login. The bug was latent because most testing happened from
        // root index.html (BASE_PATH already '/'), not from /pages/login.html.
        const APP_SUBFOLDERS = ['/pages/admin/pages/', '/pages/assessment/', '/pages/admin/', '/pages/ujian/', '/pages/', '/admin/pages/', '/ujian/', '/admin/'];

        for (const sub of APP_SUBFOLDERS) {
            const idx = base.indexOf(sub);
            if (idx !== -1) return base.substring(0, idx + 1);
        }

        return base || '/';
    })(),

    // Root landing page served by static host when path ends with '/'.
    // Empty string keeps BASE_PATH intact and lets the server resolve index.html.
    LANDING_PAGE: '',

    // Login page lives at /pages/login.html, not /login.html. Before this
    // fix, loginUrl() returned /login.html → 404. Any auth-state-change to
    // user=null (token refresh, network blip, race condition) redirected
    // users to a 404 instead of the real login page — appearing as
    // "dikeluarkan saat mau masuk".
    LOGIN_PAGE: 'pages/login.html',

    // Maps role → absolute path from BASE_PATH. 'guru' is intentionally
    // absent (role removed). Unknown roles fall back to login so they can
    // never accidentally reach a protected page.
    pathForRole(role) {
        const map = {
            peserta: 'pages/assessment/index.html',
            admin: 'pages/admin/index.html',
        };
        if (!(role in map)) {
            console.warn('[AuthRedirect] unknown role:', role, '— redirecting to login');
            return this.loginUrl();
        }
        return this.BASE_PATH + map[role];
    },

    // Public landing page URL (root index.html). Per the routing contract
    // (rule-url-albedu.md §4), logout lands here, NOT on login.html.
    //
    // BASE_PATH returns the PARENT folder of the current page. For pages
    // inside /pages/ (login, admin, ujian), BASE_PATH ends with '/pages/'.
    // The landing page lives one level above /pages/, so strip the trailing
    // 'pages/' to reach it. Without this fix logout went to '/AlbEdu/pages/'
    // which has no index.html → 404 on GitHub Pages.
    landingUrl() {
        let root = this.BASE_PATH;
        if (root.endsWith('pages/')) {
            root = root.slice(0, -'pages/'.length);
        }
        return root + this.LANDING_PAGE;
    },

    loginUrl() {
        return this.BASE_PATH + this.LOGIN_PAGE;
    },
};

// Re-aliased from user-helpers.js (loaded before this file).
const _isDev                       = window.AuthHelpers.isDev;

const _t = (key, vars, fallback) => fallback;
const PROFILE_FETCH_TIMEOUT_MS     = window.AuthHelpers.PROFILE_FETCH_TIMEOUT_MS;
const AUTH_STATE_TIMEOUT_MS        = window.AuthHelpers.AUTH_STATE_TIMEOUT_MS;
const REDIRECT_DELAY_MS            = window.AuthHelpers.REDIRECT_DELAY_MS;
const LOGOUT_REDIRECT_DELAY_MS     = window.AuthHelpers.LOGOUT_REDIRECT_DELAY_MS;
const LOGIN_NOTICE_REDIRECT_DELAY_MS = window.AuthHelpers.LOGIN_NOTICE_REDIRECT_DELAY_MS;
const PAGE_404_REDIRECT_DELAY_MS   = window.AuthHelpers.PAGE_404_REDIRECT_DELAY_MS;
const USER_PREFLIGHT_KEY           = window.AuthHelpers.USER_PREFLIGHT_KEY;
const USER_PREFLIGHT_TTL_MS        = window.AuthHelpers.USER_PREFLIGHT_TTL_MS;

// Native Supabase platform accessors — no Firebase-shaped globals.
function _getAuth() {
    const auth = window.AlbEdu?.supabase?.auth;
    if (!auth) throw new Error('[Auth] AlbEdu.supabase.auth not ready — await AlbEdu.supabase.ready');
    return auth;
}

function _getRepo() {
    const repo = window.AlbEdu?.repository;
    if (!repo) throw new Error('[Auth] AlbEdu.repository not ready — await AlbEdu.supabase.ready');
    return repo;
}

function _getSbClient() {
    const client = window.AlbEdu?.supabase?.client;
    if (!client) throw new Error('[Auth] AlbEdu.supabase.client not ready');
    return client;
}

let _currentUser         = null;
let _userRole            = null;
let _userData            = null;
let _authReady           = false;
let _profileState        = null;
let _stopProfileListener = null;
let _initialized         = false;
let _authStateTimer      = null;

// Re-aliased from user-helpers.js.
const _buildAvatarUrl    = window.AuthHelpers.buildAvatarUrl;
const escapeHTML         = window.AuthHelpers.escapeHTML;
const _isProfileComplete = window.AuthHelpers.isProfileComplete;
const _makeProfileState  = window.AuthHelpers.makeProfileState;
const _normalizeUserDoc  = window.AuthHelpers.normalizeUserDoc;
const _getUserPreflight  = window.AuthHelpers.getUserPreflight;

// _getCurrentPage() — environment-agnostic page identifier.
//
// WHY filename-only, not full pathname: full pathname depends on deployment
// prefix (/, /AlbEdu/, /AlbEdu-main/, ...). Filename doesn't. 'login.html'
// is always 'login.html' whether on localhost or Vercel — makes every
// downstream check portable for free.
//
// WHY strip query string: Supabase OAuth appends ?code=... after redirect.
// Without stripping, 'login.html?code=xyz' wouldn't match 'login.html' and
// the redirect guard would silently skip the post-login redirect.
function _getCurrentPage() {
    return window.location.pathname
        .split('/')
        .pop()          // last path segment = filename
        .split('?')[0]; // strip query string
}

// _navigateTo() — single redirect primitive for auth flows.
//
// WHY replace() not href: replace() removes the current entry from browser
// history. A user forced off a protected page can't press Back to return.
// href() leaves the protected URL in history — that's a security UX bug.
//
// WHY pathname guard before redirecting: prevents redirect loops when
// onAuthStateChanged re-fires with the same state (Supabase does this on
// token refresh). Without it we'd call replace() on the same URL infinitely,
// burning setTimeout slots.
function _navigateTo(path, reason, delay = REDIRECT_DELAY_MS) {
    const cur = window.location.pathname;

    // Treat trailing slash as equivalent (/ujian/index.html == /ujian/index.html/)
    if (cur.replace(/\/$/, '') === path.replace(/\/$/, '')) return;

    if (_isDev) console.info('[AuthRedirect]', reason || 'redirect', '\n  from:', cur, '\n  to:  ', path);

    setTimeout(() => {
        window.location.replace(path);
    }, delay);
}

// Route scope helper — folder-based, environment-agnostic. Mirrors the
// logic in byteward.js _getRouteScope() so both files classify pages the
// same way. Prevents /admin/index.html from being mis-identified as a
// "login page" just because its filename is 'index.html'.
//
// Previously this only checked the FIRST path segment against {ujian, admin}.
// For /pages/admin/index.html, firstSegment is 'pages' (not 'admin'), so
// scope was mis-returned as 'public'. That caused _isLoginPage() to return
// TRUE for /pages/admin/index.html (because 'index.html' is in
// _PUBLIC_ENTRY_FILES and scope==='public'), which then triggered spurious
// "already logged in" redirects and access-check confusion. Now mirrors
// byteward.js exactly: checks second segment when firstSegment is 'pages'.
function _getRouteScope() {
    const basePath = AUTH_CONFIG.BASE_PATH;
    const pathname = window.location.pathname.split('?')[0];

    const relative = pathname.startsWith(basePath)
        ? pathname.slice(basePath.length)
        : pathname.replace(/^\//, '');

    const firstSegment = relative.split('/')[0];

    const FOLDER_SCOPE = {
        ujian: 'ujian',
        admin: 'admin',
        assessment: 'ujian',  // /pages/assessment/ → peserta scope (was /ujian/)
    };

    let scope = FOLDER_SCOPE[firstSegment] ?? 'public';

    // For /pages/admin/, /pages/assessment/, /pages/ujian/ paths,
    // firstSegment is 'pages' — check second segment for the real scope.
    if (firstSegment === 'pages') {
        const secondSegment = relative.split('/')[1] ?? '';
        if (secondSegment === 'admin') scope = 'admin';
        else if (secondSegment === 'assessment') scope = 'ujian';
        else if (secondSegment === 'ujian') scope = 'ujian';
        else scope = 'public'; // /pages/login.html, /pages/privacy-policy.html, etc.
    }

    return scope;
}

// Root-level HTML files where an authenticated user should be redirected
// to their dashboard. These are "login-type" public entry pages — a logged-in
// user has no business staying here.
//
// Only applies when _getRouteScope() === 'public' (root level). Inside
// /admin/ or /ujian/ the same filename (like index.html) is a protected
// dashboard page and must NOT be treated as a login page.
//
// forgot-password.html, reset-password.html, register-success.html are
// intentionally EXCLUDED — they have their own auth flows and should NOT
// redirect logged-in users to the dashboard mid-flow.
const _PUBLIC_ENTRY_FILES = new Set([
    'login.html',
    'index.html',
    'register-admin.html',
]);

// 404 page at root level — special handling: instead of redirecting to
// dashboard, show "kamu akan diarahkan ke halaman sebelumnya" and
// navigate back after 5 seconds.
function _is404Page() {
    return _getCurrentPage() === '404.html' && _getRouteScope() === 'public';
}

// "Login page" = a public entry page where a logged-in user should be
// automatically redirected to their dashboard. Does NOT include 404.html
// (which has its own redirect behavior) or auth-flow pages like
// forgot-password/reset-password.
function _isLoginPage() {
    const page  = _getCurrentPage();
    const scope = _getRouteScope();

    // Root URL with no filename (https://albytehq.github.io/AlbEdu/).
    // Server serves index.html by default — it's a public entry page.
    // _getCurrentPage() returns '' for bare directory URLs.
    if (page === '' && scope === 'public') return true;

    // Known public entry files at root level only.
    // Inside /admin/ or /ujian/ these same filenames are protected pages.
    if (_PUBLIC_ENTRY_FILES.has(page) && scope === 'public') return true;

    return false;
}

// "Public page" = any page that does NOT require authentication.
// Includes login pages AND 404.  Unauthenticated users should NOT be
// redirected away from these pages.
function _isPublicPage() {
    return _isLoginPage() || _is404Page();
}

// "Inside app" = any authenticated page (everything that is NOT a public page).
// Used to decide whether an unauthenticated user should be redirected to login.
function _isInsideApp() {
    if (_isPublicPage()) return false;

    const page  = _getCurrentPage();
    const scope = _getRouteScope();

    // /admin/ or /ujian/ with no filename (like /admin/ → serves index.html)
    // is inside the app even though _getCurrentPage() returns ''.
    if (page === '' && (scope === 'admin' || scope === 'ujian')) return true;

    return page !== '';
}

function _redirectToLogin() {
    if (_isPublicPage()) return;
    _navigateTo(AUTH_CONFIG.loginUrl(), 'unauthenticated → login');
}

function _redirectForRole(role, delay = REDIRECT_DELAY_MS) {
    _navigateTo(AUTH_CONFIG.pathForRole(role), `role=${role} -> dashboard`, delay);
}

function _announceAlreadyLoggedIn(role) {
    const msg   = _t('auth.already_logged_in_msg', null, 'Kamu sudah login, kamu akan diarahkan ke halaman sesuai role anda.');
    const title = _t('auth.already_logged_in_title', null, 'Sudah login');

    try {
        if (window.notify?.info) {
            window.notify.info(title, msg, LOGIN_NOTICE_REDIRECT_DELAY_MS);
            return;
        }
        if (window.QNotify?.notify?.info) {
            window.QNotify.notify.info(title, msg, LOGIN_NOTICE_REDIRECT_DELAY_MS);
            return;
        }
    } catch (_) {}

    const errorEl = document.getElementById('errorMessage');
    if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
        errorEl.classList?.add('info-message');
    }

    const welcome = document.querySelector('.welcome-message p');
    if (welcome) welcome.textContent = msg;

    if (_isDev) console.info('[AuthRedirect]', msg, { role });
}

// 404 page: logged-in user gets a different notification —
// "Kamu akan diarahkan ke halaman sebelumnya" — then navigate back
// after 5 seconds instead of redirecting to the dashboard.
function _handle404Redirect() {
    const msg   = _t('auth.404_redirect_msg', null, 'Halaman tidak ditemukan. Kamu akan diarahkan ke halaman sebelumnya dalam 5 detik.');
    const title = _t('error.404_title', null, 'Halaman Tidak Ditemukan');

    try {
        if (window.notify?.info) {
            window.notify.info(title, msg, PAGE_404_REDIRECT_DELAY_MS);
        } else if (window.QNotify?.notify?.info) {
            window.QNotify.notify.info(title, msg, PAGE_404_REDIRECT_DELAY_MS);
        }
    } catch (_) {}

    if (_isDev) console.info('[AuthRedirect] 404 — redirecting back in', PAGE_404_REDIRECT_DELAY_MS, 'ms');

    setTimeout(() => {
        if (window.history.length > 1) {
            window.history.back();
        } else {
            const role = _userRole || 'admin';
            window.location.replace(AUTH_CONFIG.pathForRole(role));
        }
    }, PAGE_404_REDIRECT_DELAY_MS);
}

// _createUserDocViaServer(userId)
//
// WHY this exists: after Google OAuth redirect, Supabase creates a row in
// `auth.users` but NOT in the public `users` table. The public row (with
// `peran`, `nama`, etc.) is created by the `user-auth-complete` Edge Function,
// which:
//   1. Verifies the preflightId (anti-abuse: must come from a valid preflight)
//   2. Verifies the deviceId matches the preflight (anti-session-hijack)
//   3. Verifies the browserHash matches (anti-device-spoof)
//   4. Checks the device limit (max 2 accounts per device)
//   5. Inserts the user row with peran='peserta' if it doesn't exist
//   6. Upserts the user_devices row
//   7. Returns the full user profile
//
// Reads preflight from sessionStorage, gets the current access token, then
// invokes `user-auth-complete` with the Bearer header + preflight payload.
// Throws CompletionError with the backend's error code on failure.

async function _extractFunctionErrorCode(fnError) {
    // Supabase SDK wraps non-2xx responses in FunctionsHttpError.
    // The actual error code from our Edge Function is in error.context (a Response).
    if (fnError?.context && typeof fnError.context.json === 'function') {
        try {
            const body = await fnError.context.json();
            if (body?.error && typeof body.error === 'string') return body.error;
        } catch (_) {}
    }
    if (fnError?.context && typeof fnError.context.text === 'function') {
        try {
            const text = await fnError.context.text();
            const parsed = JSON.parse(text);
            if (parsed?.error && typeof parsed.error === 'string') return parsed.error;
        } catch (_) {}
    }
    // HTTP status fallback
    if (fnError?.status === 403) return 'device_limit_reached';
    if (fnError?.status === 429) return 'rate_limit_exceeded';
    if (fnError?.status === 401) return 'invalid_token';
    return fnError?.message || 'user_completion_failed';
}

async function _createUserDocViaServer(userId) {
    // Read preflight created by executePreflightFlow() in preflight.js.
    // Stored under USER_PREFLIGHT_KEY; getUserPreflight() validates TTL (15 min)
    // and shape.
    const preflight = _getUserPreflight();
    if (!preflight?.preflightId || !preflight?.deviceId) {
        throw new CompletionError('missing_preflight');
    }

    // The Edge Function requires a Bearer token to identify the user.
    // AlbEdu.supabase.auth.getSession() returns the current session from storage.
    let session;
    try {
        const result = await _getSbClient().auth.getSession();
        session = result?.data?.session;
    } catch (err) {
        console.error('[Auth] getSession failed:', err?.message || err);
        throw new CompletionError('invalid_token');
    }

    if (!session?.access_token) {
        throw new CompletionError('invalid_token');
    }

    // Defensive: ensure the session user ID matches the userId we're provisioning.
    // Guards against a stale session after signOut but before redirect.
    if (session.user?.id && session.user.id !== userId) {
        console.error('[Auth] session user ID mismatch:', session.user.id, 'vs', userId);
        throw new CompletionError('invalid_token');
    }

    const { data, error: fnError } = await _getSbClient().functions.invoke('user-auth-complete', {
        headers: {
            Authorization: `Bearer ${session.access_token}`,
        },
        body: {
            preflightId:  preflight.preflightId,
            deviceId:     preflight.deviceId,
            browserHash:  preflight.browserHash || null,
            deviceInfo:   preflight.deviceInfo  || null,
        },
    });

    if (fnError) {
        const backendCode = await _extractFunctionErrorCode(fnError);
        console.error('[Auth] user-auth-complete failed:', backendCode, fnError?.message || fnError);
        throw new CompletionError(backendCode);
    }

    if (!data?.success) {
        const backendCode = data?.error || 'user_completion_failed';
        console.error('[Auth] user-auth-complete returned error:', backendCode);
        throw new CompletionError(backendCode);
    }

    // Preflight is single-use — clear it so a subsequent login (after
    // logout, for example) requires a fresh Turnstile challenge + device check.
    try { sessionStorage.removeItem(USER_PREFLIGHT_KEY); } catch (_) {}

    if (!data.user) {
        // Server returned success: true but no user object — should never happen.
        console.error('[Auth] user-auth-complete returned success but no user object');
        throw new CompletionError('user_completion_failed');
    }

    return data.user;
}

// _syncUserDocument(userId)
//
// WHY this is more than just a Realtime subscribe:
//   The previous implementation ONLY subscribed to a Supabase Realtime
//   channel and waited for a postgres_changes event. Realtime channels only
//   fire on DB CHANGES (INSERT/UPDATE/DELETE) — they do NOT do an initial
//   fetch. So for both new AND existing users, no event ever fired
//   initially, and the code waited 8 seconds (PROFILE_FETCH_TIMEOUT_MS)
//   for the fallback timer to kick in.
//
//   From the user's perspective, after returning from Google OAuth:
//     - Page reloads → button is in idle state (no UI feedback)
//     - 8 seconds of silence (the "pilih akun Google, terus gak terjadi apa-apa" bug)
//     - Only then does the Edge Function fire and (maybe) redirect to dashboard
//
// Fix:
//   1. Do an INITIAL FETCH immediately via repo.getDoc('users', userId).
//      - If row exists → apply snapshot + resolve (~50ms instead of 8000ms).
//      - If row doesn't exist → call _createUserDocViaServer immediately.
//      - On error → fall back to _createUserDocViaServer (server is the
//        source of truth anyway).
//   2. STILL subscribe to Realtime for FUTURE changes (profile edits, role
//      changes from another tab, etc.) — but don't rely on it for initial load.
//   3. Keep a safety-net timer in case the initial fetch hangs (network stall).
function _syncUserDocument(userId) {
    _stopProfileListener?.();
    _stopProfileListener = null;

    return new Promise((resolve, reject) => {
        let settled  = false;
        let creating = false; // guard: only one _createUserDocViaServer call

        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            fn(value);
        };

        // Safety net: if the initial fetch + Edge Function call together take
        // longer than PROFILE_FETCH_TIMEOUT_MS * 2 (network stall, for example),
        // reject so the outer catch block can dispatch auth-completion-error
        // instead of leaving the user staring at a silent page forever.
        const safetyTimer = setTimeout(() => {
            if (!settled) {
                settle(reject, new CompletionError('user_completion_failed'));
            }
        }, PROFILE_FETCH_TIMEOUT_MS * 2);

        const _initialFetch = async () => {
            try {
                const repo = window.AlbEdu?.repository;
                if (!repo) {
                    settle(reject, new Error('[Auth] repository not ready'));
                    return;
                }
                const snap = await repo.getDoc('users', userId);
                if (snap?.exists) {
                    _applyUserSnapshot(snap.data(), userId);
                    settle(resolve, _userData);
                    return;
                }
                if (!creating) {
                    creating = true;
                    const fresh = await _createUserDoc(userId);
                    settle(resolve, fresh);
                }
            } catch (err) {
                // Initial fetch failed (network/RLS/timeout). Fall back to
                // the Edge Function, which can both fetch AND create
                // server-side using the service role key (bypasses RLS).
                if (!creating) {
                    creating = true;
                    try {
                        const doc = await _createUserDocViaServer(userId);
                        _applyUserSnapshot(doc, userId);
                        settle(resolve, _userData);
                    } catch (e) {
                        settle(reject, e);
                    }
                }
            }
        };

        // Subscribe to FUTURE changes (profile edits, role changes from
        // another tab, etc.). NOT used for the initial fetch — _initialFetch()
        // handles that synchronously.
        const _attachRealtime = () => {
            const repo = window.AlbEdu?.repository;
            if (!repo) return;
            const channelName = `auth:user-profile:${userId}`;
            try {
                const unsub = repo.subscribe(
                    channelName,
                    'users',
                    async () => {
                        try {
                            const snap = await repo.getDoc('users', userId);
                            if (snap?.exists) {
                                _applyUserSnapshot(snap.data(), userId);
                            }
                        } catch (_) { /* non-critical — realtime update */ }
                    },
                    `id=eq.${userId}`
                );
                _stopProfileListener = unsub;
            } catch (_) {
                // Realtime subscription is best-effort — don't fail the whole
                // sync just because the channel couldn't be established.
            }
        };

        _initialFetch();
        _attachRealtime();
    });
}

function _applyUserSnapshot(rawData, userId) {
    const data    = _normalizeUserDoc(rawData, userId);
    _userData     = data;
    _userRole     = data.peran;
    _profileState = _makeProfileState(_isProfileComplete(data));
}

async function _createUserDoc(userId) {
    const doc = await _createUserDocViaServer(userId);
    _applyUserSnapshot(doc, userId);
    return doc;
}

async function authLogin() {
    // Native Supabase Google OAuth — signInWithGoogle uses redirect mode.
    // onAuthStateChange fires when the user returns from Google.
    try {
        const result = await _getAuth().signInWithGoogle();
        return result?.user ?? null;
    } catch (err) {
        throw new Error(err.message || 'Login Google gagal.');
    }
}

// authLogout() is the SINGLE ENTRY POINT for signOut + redirect. All callers
// (navigasi.js, panel.js, ui.js, ujian/index.html) just call authLogout() and
// do NOT handle redirect themselves. This eliminates:
//   - double-redirect race conditions
//   - hardcoded '../login.html' paths that break from subfolders
//   - inconsistent confirmation dialogs
//
// Also: guard against concurrent logout (double-click, race), full cleanup
// of listeners / intervals / Realtime channels / sensitive sessionStorage,
// resilient if signOut() fails (still cleans up client-side and redirects),
// and role-agnostic (works identically for admin and peserta).
let _logoutInProgress = false;

function _confirmLogout() {
    const msg = _t('auth.logout_confirm_msg', null, 'Anda akan log out. Yakin?');
    const confirm = window.notify?.confirm || window.QNotify?.dialog?.confirm;

    if (typeof confirm === 'function') {
        return new Promise(resolve => {
            let settled = false;
            const done = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            confirm({
                title: 'Log out',
                message: msg,
                icon: 'warning',
                intent: 'warning',
                onYes: () => done(true),
                onNo: () => done(false),
                onClose: () => done(false),
            });
        });
    }

    return window.UI?.confirm ? window.UI.confirm(msg) : Promise.resolve(window.confirm(msg));
}

/**
 * Perform a full, safe logout.
 *
 * @param {Object}  options
 * @param {boolean} options.skipConfirm  — skip the confirmation dialog (for auto-logout / session-expiry)
 * @param {boolean} options.skipRedirect — skip the redirect after logout (for testing or custom flow)
 * @returns {Promise<boolean>} true if logout completed, false if cancelled or already in progress
 */
async function authLogout(options = {}) {
    if (_logoutInProgress) {
        console.info('[Auth] logout already in progress — skipping');
        return false;
    }
    _logoutInProgress = true;

    try {
        if (!options.skipConfirm) {
            const confirmed = await _confirmLogout();
            if (!confirmed) {
                _logoutInProgress = false;
                return false;
            }
        }

        _stopProfileListener?.();
        _stopProfileListener = null;

        clearTimeout(_authStateTimer);
        _authStateTimer = null;

        // Tell UI to tear down before session is gone — gives UI components
        // a chance to clean up intervals, DOM, etc.
        document.dispatchEvent(new CustomEvent('auth-logout-started'));

        // Stop Supabase Realtime channels so ghost listeners don't fire
        // after the session is cleared.
        try {
            window.AlbEdu?.supabase?.realtime?.unsubscribeAll?.();
        } catch (_) { /* non-critical */ }

        try { sessionStorage.removeItem(USER_PREFLIGHT_KEY); } catch (_) {}
        // Clear any exam-in-progress data that shouldn't persist across sessions
        try {
            const keysToRemove = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && (key.startsWith('albedu_') || key.startsWith('exam_'))) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(k => sessionStorage.removeItem(k));
        } catch (_) {}

        // Reset module state immediately — even if signOut() hangs, the
        // client-side state is already clean. No stale data can leak to
        // other tabs.
        _currentUser  = null;
        _userRole     = null;
        _userData     = null;
        _profileState = null;
        _authReady    = true;

        try {
            await _getAuth().signOut();
        } catch (signOutErr) {
            // signOut may fail if session is already expired or network is down.
            // Not fatal — client state is already cleaned up above. Log but
            // don't throw; the user still gets redirected.
            console.warn('[Auth] signOut() failed (non-fatal):', signOutErr?.message || signOutErr);
        }

        // Notify byteward.js and other listeners that auth state changed.
        document.dispatchEvent(new CustomEvent('auth-ready', { detail: { role: null } }));

        try { window.UI?.afterLogout?.(); } catch (_) {}

        // Per the routing contract (rule-url-albedu.md §4): logout destination
        // is the PUBLIC LANDING PAGE (root index.html), NOT the login page.
        // Users see the landing content after logout and can choose to log
        // in again from there.
        //   Unauthenticated redirects from protected pages (in
        //   _handleAuthStateChange and byteward.checkPageAccess) still use
        //   _redirectToLogin() → loginUrl().
        if (!options.skipRedirect) {
            const landingPath = AUTH_CONFIG.landingUrl();
            if (_isDev) console.info('[AuthRedirect] logout complete →', landingPath);
            window.location.replace(landingPath);
        }

        return true;

    } catch (err) {
        // Unexpected error — still try to clean up and redirect so the user
        // isn't stuck on a broken page.
        console.error('[Auth] logout error:', err?.message || err);

        _currentUser  = null;
        _userRole     = null;
        _userData     = null;
        _profileState = null;

        try { window.UI?.afterLogout?.(); } catch (_) {}

        if (!options.skipRedirect) {
            setTimeout(() => {
                window.location.replace(AUTH_CONFIG.landingUrl());
            }, LOGOUT_REDIRECT_DELAY_MS);
        }

        return false;
    } finally {
        _logoutInProgress = false;
    }
}

async function _handleAuthStateChange(user) {
    clearTimeout(_authStateTimer);
    _authStateTimer = setTimeout(() => {
        _authReady = true;
        window.UI?.hideAuthLoading?.();
    }, AUTH_STATE_TIMEOUT_MS);

    try {
        if (user) {
            // Email verification gate.
            //
            // Previously this read `user._supabaseUser?.email_confirmed_at`,
            // a field that belonged to the OLD Firebase-shaped shim that has
            // since been replaced by the native platform layer. The current
            // AuthService._toUser() doesn't set `_supabaseUser` at all — it
            // exposes the raw Supabase user under `user.raw` and ALREADY
            // computes `user.emailVerified` at the top level. Reading the
            // stale `_supabaseUser` path meant `isVerified` was undefined
            // → always falsy, so EVERY Google login (verified or not) was
            // force-signed-out here with no error shown to the user — this
            // is exactly the "pilih akun Google, terus gak terjadi apa-apa"
            // bug: the callback silently signs out and returns before any
            // UI feedback or redirect happens.
            const isVerified = user.emailVerified === true
                || user.raw?.email_confirmed_at != null;

            if (!isVerified) {
                // Force sign-out so the unverified session is cleared from
                // local storage. The resulting user=null callback handles
                // the redirect.
                console.warn('[Auth] unverified email — session rejected for user', user.id);
                _stopProfileListener?.();
                _stopProfileListener = null;
                await _getAuth().signOut();
                // Previously this returned with zero user-facing feedback —
                // the login button just sat there forever with no explanation.
                // Dispatch the same event user-auth-portal.js already listens
                // for so the UI shows a real message instead of "nothing happens".
                document.dispatchEvent(new CustomEvent('auth-completion-error', {
                    detail: {
                        backendCode: 'email_not_confirmed',
                        message: _t(
                            'auth.email_not_verified_msg',
                            null,
                            'Email akun Google ini belum terverifikasi. Silakan verifikasi email Anda terlebih dahulu, lalu coba login kembali.'
                        ),
                    },
                }));
                return;
            }

            _currentUser = user;
            // `user.uid` is a Firebase-shaped field name that never existed
            // on the native Supabase AuthService user object (_toUser() in
            // supabase-client.js only sets `.id`). Previously this meant
            // _syncUserDocument(undefined) ran on every login — the realtime
            // subscribe filter became `id=eq.undefined` (never matches), it
            // fell through to _createUserDocViaServer(undefined), whose
            // session-match guard then threw CompletionError
            // ('invalid_token') because `session.user.id !== undefined`.
            // Combined with the email-verification bug above, this is the
            // actual cause of "pilih akun Google, terus gak terjadi apa-apa"
            // — the whole chain failed silently after a real, successful
            // Google sign-in.
            await _syncUserDocument(user.id);
            _authReady = true;
            // 'auth-ready' fires AFTER role is confirmed — byteward listens
            // to this, not 'albedu:platform-ready' (which fires before async
            // role fetch completes).
            document.dispatchEvent(new CustomEvent('auth-ready', { detail: { role: _userRole } }));

            if (_isLoginPage()) {
                // Authed user landed on login → send to their dashboard.
                // Double-check at +1s: Supabase OAuth redirect can cause this
                // callback to fire before the browser finishes URL cleanup,
                // so pathname might not reflect the final destination yet.
                _announceAlreadyLoggedIn(_userRole);
                _redirectForRole(_userRole, LOGIN_NOTICE_REDIRECT_DELAY_MS);
                setTimeout(() => {
                    if (_isLoginPage() && _userRole) _redirectForRole(_userRole);
                }, LOGIN_NOTICE_REDIRECT_DELAY_MS + 700);
            } else if (_is404Page()) {
                // Authed user on 404 → notify and go back to previous page
                // instead of redirecting to dashboard.
                _handle404Redirect();
            } else {
                window.UI?.afterLogin?.();
            }
        } else {
            _currentUser  = null;
            _userRole     = null;
            _userData     = null;
            _profileState = null;
            _authReady    = true;
            document.dispatchEvent(new CustomEvent('auth-ready', { detail: { role: null } }));

            if (_isInsideApp()) {
                // Unauthenticated on a protected page → send to login.
                // Skip redirect if authLogout() is already handling it
                // (prevents double-redirect race condition).
                if (!_logoutInProgress) {
                    setTimeout(_redirectToLogin, LOGOUT_REDIRECT_DELAY_MS);
                }
            } else {
                window.UI?.afterLogout?.();
            }
        }
    } catch (_err) {
        console.error('[Auth] auth state handling failed:', _err?.message || _err);

        // If the error is a CompletionError (device_limit_reached, for example),
        // dispatch a custom event so the login page UI can display the
        // specific user-friendly message instead of a generic redirect.
        if (_err instanceof CompletionError) {
            document.dispatchEvent(new CustomEvent('auth-completion-error', {
                detail: {
                    backendCode: _err.backendCode,
                    message: _err.message,
                },
            }));
        }

        if (user && !_userData) {
            _stopProfileListener?.();
            _stopProfileListener = null;
            _currentUser  = null;
            _userRole     = null;
            _profileState = null;
            try { await _getAuth().signOut(); } catch (_) {}
            document.dispatchEvent(new CustomEvent('auth-ready', { detail: { role: null } }));
            if (_isInsideApp()) setTimeout(_redirectToLogin, LOGOUT_REDIRECT_DELAY_MS);
        }
        _authReady = true;
    } finally {
        clearTimeout(_authStateTimer);
        _authStateTimer = null;
        window.UI?.hideAuthLoading?.();
    }
}

function _initializeSystem() {
    if (_initialized) return;
    _initialized = true;

    if (!window.AlbEdu?.supabase?.auth) {
        window.UI?.hideAuthLoading?.();
        return;
    }

    try {
        // Native auth state subscription. Callback signature:
        // (user, event) => void. We only use user here.
        _getAuth().onAuthStateChange((user) => _handleAuthStateChange(user));

        // Safety net: if the platform layer resolved the session from cache
        // before this listener registered, _handleAuthStateChange may have
        // already fired and the user is sitting on the login page with a
        // valid session. Force-check after 1.5s to catch that race.
        setTimeout(() => {
            const user = _getAuth().currentUser;
            if (user && _isLoginPage() && _userRole) {
                if (_isDev) console.info('[AuthRedirect] safety-net: user on login page with active session');
                _announceAlreadyLoggedIn(_userRole);
                _redirectForRole(_userRole, LOGIN_NOTICE_REDIRECT_DELAY_MS);
            }
        }, 1_500);

    } catch (_err) {
        _authReady = true;
        window.UI?.hideAuthLoading?.();
    }
}

function debugByteWard() {
    /* eslint-disable no-console */
    console.group('ByteWard Auth');
    console.table({
        'BASE_PATH':        AUTH_CONFIG.BASE_PATH,
        'current page':     _getCurrentPage(),
        'full path':        window.location.pathname,
        'is login page':    _isLoginPage(),
        'is public page':   _isPublicPage(),
        'in app scope':     _isInsideApp(),
        'user email':       _currentUser?.email   ?? '—',
        'role':             _userRole             ?? '—',
        'auth ready':       _authReady,
        'profile complete': _profileState?.isProfileComplete ?? false,
        'listener active':  !!_stopProfileListener,
    });
    console.groupEnd();
    /* eslint-enable no-console */
}

window.Auth = {
    authLogin,
    authLogout,
    confirmLogout: _confirmLogout,
    debugByteWard,
    escapeHTML,
    redirectToLogin:          _redirectToLogin,
    isLoginPage:              _isLoginPage,
    isPublicPage:             _isPublicPage,
    isWithinAppScope:         _isInsideApp,
    getCurrentPage:           _getCurrentPage,
    navigateTo:               _navigateTo,
    getBasePath:              () => AUTH_CONFIG.BASE_PATH,
    getLandingPath:           () => AUTH_CONFIG.landingUrl(),
    getRoleRedirectPath:      (role) => AUTH_CONFIG.pathForRole(role),
    checkProfileCompleteness: _isProfileComplete,
    generateDefaultAvatar:    _buildAvatarUrl,
    setUserData(data) {
        _userData = data;
        if (_profileState) _profileState.isProfileComplete = _isProfileComplete(data);
    },
    fetchUserData:    (uid) => _syncUserDocument(uid),
    createUserData:   _createUserDoc,
    initializeSystem: _initializeSystem,
};

Object.defineProperties(window.Auth, {
    currentUser:  { get: () => _currentUser,  set: (v) => { _currentUser = v; }  },
    userRole:     { get: () => _userRole,      set: (v) => { _userRole = v; }     },
    userData:     { get: () => _userData,      set: (v) => { _userData = v; }     },
    profileState: { get: () => _profileState,  set: (v) => { _profileState = v; } },
    authReady:    { get: () => _authReady,     set: (v) => { _authReady = v; }    },
});

// Bootstrap — listen for native platform-ready (replaces the legacy
// firebase-ready / firebase-error events).
document.addEventListener('DOMContentLoaded', () => {
    if (window.AlbEdu?.supabase?.isReady?.()) {
        _initializeSystem();
    } else {
        document.addEventListener('albedu:platform-ready', _initializeSystem,             { once: true });
        document.addEventListener('albedu:platform-error', () => window.UI?.hideAuthLoading?.(), { once: true });
    }
});
