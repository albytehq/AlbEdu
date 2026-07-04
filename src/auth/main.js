// =============================================================================
// main.js — ByteWard Auth v0.9.1 (orchestrator)
// =============================================================================
//
// v2.0.0 restructure: Pure helpers & error classes extracted to:
//   - errors.js       → CompletionError + COMPLETION_MESSAGES
//   - user-helpers.js → buildAvatarUrl, escapeHTML, isProfileComplete,
//                       makeProfileState, normalizeUserDoc, getUserPreflight,
//                       timing constants, isDev
//
// This file remains the ORCHESTRATOR: state, sync, login/logout, init,
// and exposes window.Auth public API.
//
// Dependencies (load order — all `defer` so order preserved):
//   1. errors.js        → window.CompletionError, window.AuthErrors
//   2. user-helpers.js  → window.AuthHelpers
//   3. main.js          → window.Auth (this file)
//
// Satu tanggung jawab: kelola siklus hidup auth dan expose
// window.Auth sebagai public API yang bisa dipercaya file lain.
//
// Urutan boot yang benar:
//   1. supabase-client.js init Supabase, dispatch albedu:platform-ready
//   2. auth.js (file ini) dengar event itu lalu pasang onAuthStateChanged
//   3. Supabase panggil handler → fetch data user → update UI
//
// CHANGES v0.9.1 — Unified User Auth Flow:
//   - RENAME student-auth-* → user-auth-* (function names, sessionStorage keys,
//     identifiers, error codes)
//   - UNIFIED PATH: baik admin (login.html) maupun peserta (index.html) menjalankan
//     preflight + completion flow yang SAMA. Tidak ada lagi skip-preflight untuk admin.
//   - FIX BUG #1: _createUserDocViaServer sekarang selalu butuh preflight valid —
//     di login.html preflight dijalankan oleh UserAuthPortal.js sebelum Google OAuth.
//   - FIX BUG #3: auth state change ke null (sign-out akibat error completion)
//     sekarang dispatch 'auth-completion-error' + reset UI loading via event.
//
// CHANGES v0.9.0 — Routing & Security Normalization:
//   - HAPUS semua referensi hardcoded '/AlbEdu/' — tidak lagi ada di file ini
//   - HAPUS role 'guru' — AlbEdu hanya punya 'admin' dan 'peserta'
//   - TAMBAH _getCurrentPage() — filename-based, environment-agnostic
//   - TAMBAH _navigateTo()    — wrapper replace() dengan guard & [AuthRedirect] log
//   - GANTI semua window.location.href (auth redirect) → window.location.replace()
//   - BASE_PATH subfolder-walker tidak lagi referensikan '/guru/'
//   - pathForRole() fallback ke loginUrl() untuk role tidak dikenal
//   - v2.1: TAMBAH landingUrl() — logout sekarang redirect ke landing page
//     (root index.html), BUKAN login.html. Lihat rule-url-albedu.md §4.
//   - v2.1.1: DEFINE _createUserDocViaServer() — sebelumnya dipanggil di 3 tempat
//     tapi TIDAK PERNAH didefinisikan. Akibatnya: setiap login user baru gagal
//     diam-diam (ReferenceError → caught → force signOut). Function ini invoke
//     Edge Function 'user-auth-complete' dengan Bearer token + preflight data.
// =============================================================================

// ── CompletionError (from errors.js) ──────────────────────────────────────────
// Loaded via errors.js (deferred, runs before this file).
// Re-aliased locally for clean code style.
const CompletionError = window.CompletionError;

// ── Route map ─────────────────────────────────────────────────────────────────
const AUTH_CONFIG = {
    // BASE_PATH: resolved sekali saat load, environment-agnostic.
    //
    // Strategy: ambil pathname sekarang, strip segment terakhir, lalu walk up
    // jika kita ada di dalam subfolder yang dikenal (ujian/ atau admin/).
    //
    // Contoh resolusi:
    //   localhost:5500/login.html              → '/'
    //   localhost:5500/ujian/index.html        → '/'
    //   localhost:5500/pages/login.html        → '/'         (v0.742.2 fix)
    //   vercel.app/AlbEdu/login.html           → '/AlbEdu/'
    //   vercel.app/AlbEdu/admin/index.html     → '/AlbEdu/'
    //   vercel.app/AlbEdu/admin/x.html         → '/AlbEdu/'  (v0.742.0+ structure)
    //   github.io/AlbEdu/pages/login.html      → '/AlbEdu/'
    BASE_PATH: (function () {
        const p    = window.location.pathname;
        const base = p.substring(0, p.lastIndexOf('/') + 1);

        // Walk up past known app subfolders — no 'guru/' (role removed).
        // List order matters: longer paths must come first so they match before
        // the shorter parent path eats the check.
        //
        // v0.742.0: `/pages/admin/pages/` and `/admin/pages/` are KEPT for
        // backward compatibility — old bookmarked URLs that point to the
        // pre-flatten structure will hit the root 404.html, and that page
        // still needs to derive BASE_PATH correctly so its redirect links
        // resolve. The patterns are harmless on live pages (no admin page
        // lives there anymore) and cost nothing at runtime.
        //
        // v0.742.2 FIX: Added `/pages/` to the list. Previously, when a user
        // was on `/pages/login.html` (or any other page directly under
        // `/pages/`), BASE_PATH returned `/pages/` instead of `/`. This
        // caused pathForRole() to produce `/pages/pages/admin/index.html`
        // — a doubled `/pages/` segment → 404 after login. The bug was
        // latent because most testing happened from the root index.html
        // (which already had BASE_PATH = '/'), not from /pages/login.html.
        const APP_SUBFOLDERS = ['/pages/admin/pages/', '/pages/assessment/', '/pages/admin/', '/pages/ujian/', '/pages/', '/admin/pages/', '/ujian/', '/admin/'];

        for (const sub of APP_SUBFOLDERS) {
            const idx = base.indexOf(sub);
            if (idx !== -1) return base.substring(0, idx + 1);
        }

        return base || '/';
    })(),

    // Root landing page — served by static host when path ends with '/'
    // (e.g. https://albytehq.github.io/AlbEdu/ → index.html).
    // Empty string keeps BASE_PATH intact and lets the server resolve index.html.
    LANDING_PAGE: '',

    // v0.742.3 FIX: Login page lives at /pages/login.html, not /login.html.
    // Previously this was 'login.html', so loginUrl() returned '/login.html'
    // → 404. Any auth-state-change to user=null (token refresh, network blip,
    // race condition) redirected the user to a 404 instead of the real login
    // page — appearing as "dikeluarkan saat mau masuk".
    LOGIN_PAGE: 'pages/login.html',

    // Maps role → absolute path from BASE_PATH.
    // 'guru' intentionally absent — that role is removed.
    // Unknown roles get login URL so they can never accidentally reach a protected page.
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

    // Public landing page URL (root index.html).
    // Used by authLogout() per AlbEdu v2.1 routing contract —
    // see rule-url-albedu.md §4 (Logout destination).
    //
    // v2.1.7 FIX: BASE_PATH returns the PARENT folder of the current page.
    // For pages inside /pages/ (login, admin, ujian), BASE_PATH ends with
    // '/pages/'. But the landing page (index.html) lives at the APP ROOT
    // (one level above /pages/). Strip the trailing 'pages/' to reach it.
    // Without this fix, logout navigated to '/AlbEdu/pages/' which has no
    // index.html → 404 on GitHub Pages instead of showing the landing page.
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

// ── Timing constants & helpers (from user-helpers.js) ─────────────────────────
// Loaded via user-helpers.js (deferred, runs before this file).
// Re-aliased locally for clean code style.
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

// ── Native Supabase platform accessors ───────────────────────────────────────
// All access goes through window.AlbEdu — no Firebase-shaped globals.
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

// ── Module state ──────────────────────────────────────────────────────────────
let _currentUser         = null;
let _userRole            = null;
let _userData            = null;
let _authReady           = false;
let _profileState        = null;
let _stopProfileListener = null;
let _initialized         = false;
let _authStateTimer      = null;

// ── Helpers (from user-helpers.js) ────────────────────────────────────────────
// Loaded via user-helpers.js (deferred, runs before this file).
// Aliased with underscore prefix to preserve internal call style.
const _buildAvatarUrl    = window.AuthHelpers.buildAvatarUrl;
const escapeHTML         = window.AuthHelpers.escapeHTML;
const _isProfileComplete = window.AuthHelpers.isProfileComplete;
const _makeProfileState  = window.AuthHelpers.makeProfileState;
const _normalizeUserDoc  = window.AuthHelpers.normalizeUserDoc;
const _getUserPreflight  = window.AuthHelpers.getUserPreflight;

// ── Route primitives ──────────────────────────────────────────────────────────

// _getCurrentPage() — environment-agnostic page identifier.
//
// WHY filename-only, not full pathname:
//   Full pathname depends on deployment prefix (/, /AlbEdu/, /AlbEdu-main/, ...).
//   Filename doesn't. 'login.html' is always 'login.html' whether on localhost
//   or Vercel. This makes every downstream check portable for free.
//
// WHY strip query string:
//   Supabase OAuth appends ?code=... after redirect. Without stripping,
//   'login.html?code=xyz' would not match 'login.html' and the redirect
//   guard would silently skip the post-login redirect.
function _getCurrentPage() {
    return window.location.pathname
        .split('/')
        .pop()          // last path segment = filename
        .split('?')[0]; // strip query string
}

// _navigateTo() — the single redirect primitive for auth flows.
//
// WHY replace() not href:
//   replace() removes the current entry from browser history. A user who was
//   forced off a protected page cannot press Back to return. href() leaves
//   the protected URL in history — that's a security UX bug.
//
// WHY pathname guard before redirecting:
//   Prevents redirect loops when onAuthStateChanged re-fires with the same
//   state (Supabase does this on token refresh). Without it we'd call replace()
//   on the same URL infinitely, burning setTimeout slots.
function _navigateTo(path, reason, delay = REDIRECT_DELAY_MS) {
    const cur = window.location.pathname;

    // Treat trailing slash as equivalent (/ujian/index.html == /ujian/index.html/)
    if (cur.replace(/\/$/, '') === path.replace(/\/$/, '')) return;

    // [AuthRedirect] stays on during migration phase — easy to grep out later.
    if (_isDev) console.info('[AuthRedirect]', reason || 'redirect', '\n  from:', cur, '\n  to:  ', path);

    setTimeout(() => {
        window.location.replace(path);
    }, delay);
}

// ── Page classification ───────────────────────────────────────────────────────

// Route scope helper — folder-based, environment-agnostic.
// Mirrors byteward.js _getRouteScope() logic so both files classify pages
// the same way.  This prevents /admin/index.html from being mis-identified
// as a "login page" just because its filename is 'index.html'.
//
// v0.742.3 FIX: Previously this only checked the FIRST path segment against
// { ujian, admin }. For /pages/admin/index.html, firstSegment is 'pages'
// (not 'admin'), so scope was mis-returned as 'public'. This caused
// _isLoginPage() to return TRUE for /pages/admin/index.html (because
// 'index.html' is in _PUBLIC_ENTRY_FILES and scope==='public'), which
// then triggered spurious "already logged in" redirects and access-check
// confusion. Now mirrors byteward.js exactly: checks second segment when
// firstSegment is 'pages'.
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
// to their dashboard.  These are "login-type" public entry pages — a logged-in
// user has no business staying here.
//
// IMPORTANT: only applies when _getRouteScope() === 'public' (root level).
// Inside /admin/ or /ujian/ the same filename (e.g. index.html) is a
// protected dashboard page and must NOT be treated as a login page.
//
// NOTE: forgot-password.html, reset-password.html, register-success.html
// are intentionally EXCLUDED — they have their own auth flows and should
// NOT redirect logged-in users to the dashboard mid-flow.
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
// automatically redirected to their dashboard.
//
// This does NOT include 404.html (which has its own redirect behavior)
// or auth-flow pages like forgot-password/reset-password.
function _isLoginPage() {
    const page  = _getCurrentPage();
    const scope = _getRouteScope();

    // Root URL with no filename (e.g. https://albytehq.github.io/AlbEdu/)
    // The server serves index.html by default — it's a public entry page.
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

    // /admin/ or /ujian/ with no filename (e.g. /admin/ → serves index.html)
    // is inside the app even though _getCurrentPage() returns ''.
    if (page === '' && (scope === 'admin' || scope === 'ujian')) return true;

    // Any non-empty filename that isn't a public page is inside the app.
    return page !== '';
}

// ── Auth redirects ────────────────────────────────────────────────────────────
function _redirectToLogin() {
    // If the user is already on a public page, don't redirect —
    // they're already at the right place.
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
        // If there's a previous page in history, go back.
        // Otherwise, fall back to the user's dashboard.
        if (window.history.length > 1) {
            window.history.back();
        } else {
            const role = _userRole || 'admin';
            window.location.replace(AUTH_CONFIG.pathForRole(role));
        }
    }, PAGE_404_REDIRECT_DELAY_MS);
}

// ── Server-side user provisioning via Supabase Edge Function ─────────────────
//
// _createUserDocViaServer(userId)
//
// WHY this exists:
//   After Google OAuth redirect, Supabase creates a row in `auth.users` but NOT
//   in the public `users` table. The public row (with `peran`, `nama`, etc.)
//   is created by the `user-auth-complete` Edge Function, which:
//     1. Verifies the preflightId (anti-abuse: must come from a valid preflight)
//     2. Verifies the deviceId matches the preflight (anti-session-hijack)
//     3. Verifies the browserHash matches (anti-device-spoof)
//     4. Checks the device limit (max 2 accounts per device)
//     5. Inserts the user row with peran='peserta' if it doesn't exist
//     6. Upserts the user_devices row
//     7. Returns the full user profile
//
// CRITICAL: This function was referenced in 3 places (lines 402, 464, and the
// header comment) but was NEVER DEFINED before v2.1.1. The result: every new
// user login failed silently — `_syncUserDocument` would call `_createUserDoc`
// → `_createUserDocViaServer` (undefined) → ReferenceError → caught by the
// outer try/catch → user force-signed-out with no error message.
//
// v2.1.1 FIX: Implemented the function. It mirrors the pattern in
// `src/auth/admin-onboarding.js` for `register-admin` and `src/auth/preflight.js`
// for `user-auth-preflight` — both of which correctly use AlbEdu.supabase.rpc.invoke.
//
// Flow:
//   1. Read preflight from sessionStorage (must be valid — created by executePreflightFlow)
//   2. Get current Supabase access token from `window.AlbEdu?.supabase?.client.auth.getSession()`
//   3. Invoke `user-auth-complete` Edge Function with:
//        headers: { Authorization: Bearer <token> }  (server checks this)
//        body: { preflightId, deviceId, browserHash, deviceInfo }
//   4. On error: extract backendCode, throw CompletionError with mapped message
//   5. On success: return the user profile (data.user)
//
// Returns: Promise<{ id, email, peran, nama, foto_profil, ... }>
// Throws: CompletionError with backendCode (device_limit_reached, missing_preflight, etc.)

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
    // ── 1. Read preflight from sessionStorage ──────────────────────────────
    // The preflight is created by executePreflightFlow() in preflight.js and
    // stored under AUTH_CONFIG.PREFLIGHT_KEY (= 'albedu_user_auth_preflight').
    // getUserPreflight() validates TTL (15 min) and shape.
    const preflight = _getUserPreflight();
    if (!preflight?.preflightId || !preflight?.deviceId) {
        throw new CompletionError('missing_preflight');
    }

    // ── 2. Get current Supabase session for the access token ──────────────
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
    // This guards against a stale session after signOut but before redirect.
    if (session.user?.id && session.user.id !== userId) {
        console.error('[Auth] session user ID mismatch:', session.user.id, 'vs', userId);
        throw new CompletionError('invalid_token');
    }

    // ── 3. Invoke the user-auth-complete Edge Function ────────────────────
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

    // ── 4. Handle function error ──────────────────────────────────────────
    if (fnError) {
        const backendCode = await _extractFunctionErrorCode(fnError);
        console.error('[Auth] user-auth-complete failed:', backendCode, fnError?.message || fnError);
        throw new CompletionError(backendCode);
    }

    // ── 5. Handle application-level error (success: false) ────────────────
    if (!data?.success) {
        const backendCode = data?.error || 'user_completion_failed';
        console.error('[Auth] user-auth-complete returned error:', backendCode);
        throw new CompletionError(backendCode);
    }

    // ── 6. Success — clear preflight and return the user profile ──────────
    // Preflight is single-use — clear it so a subsequent login (e.g. after
    // logout) requires a fresh Turnstile challenge + device check.
    try { sessionStorage.removeItem(USER_PREFLIGHT_KEY); } catch (_) {}

    if (!data.user) {
        // Server returned success: true but no user object — should never happen.
        console.error('[Auth] user-auth-complete returned success but no user object');
        throw new CompletionError('user_completion_failed');
    }

    return data.user;
}

// ── Supabase/Firestore: sync user document ────────────────────────────────────
//
// FIX (this audit): The previous implementation ONLY subscribed to a Supabase
// Realtime channel and waited for a postgres_changes event. But Realtime
// channels only fire on DB CHANGES (INSERT/UPDATE/DELETE) — they do NOT do
// an initial fetch. So for both new AND existing users, no event ever fired
// initially, and the code waited 8 seconds (PROFILE_FETCH_TIMEOUT_MS) for
// the fallback timer to kick in.
//
// From the user's perspective, after returning from Google OAuth:
//   - Page reloads → button is in idle state (no UI feedback)
//   - 8 seconds of silence (the "pilih akun Google, terus gak terjadi apa-apa" bug)
//   - Only then does the Edge Function fire and (maybe) redirect to dashboard
//
// FIX STRATEGY:
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
        // longer than PROFILE_FETCH_TIMEOUT_MS (8s) — e.g. network stall —
        // reject so the outer catch block can dispatch auth-completion-error
        // instead of leaving the user staring at a silent page forever.
        const safetyTimer = setTimeout(() => {
            if (!settled) {
                settle(reject, new CompletionError('user_completion_failed'));
            }
        }, PROFILE_FETCH_TIMEOUT_MS * 2);

        // Main path: immediate initial fetch.
        const _initialFetch = async () => {
            try {
                const repo = window.AlbEdu?.repository;
                if (!repo) {
                    settle(reject, new Error('[Auth] repository not ready'));
                    return;
                }
                const snap = await repo.getDoc('users', userId);
                if (snap?.exists) {
                    // Existing user — apply and resolve immediately.
                    _applyUserSnapshot(snap.data(), userId);
                    settle(resolve, _userData);
                    return;
                }
                // Row doesn't exist — provision via Edge Function.
                if (!creating) {
                    creating = true;
                    const fresh = await _createUserDoc(userId);
                    settle(resolve, fresh);
                }
            } catch (err) {
                // Initial fetch failed (network/RLS/timeout). Fall back to the
                // Edge Function, which can both fetch AND create server-side
                // using the service role key (bypasses RLS).
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
        // another tab, etc.). This is NOT used for the initial fetch —
        // _initialFetch() handles that synchronously.
        const _attachRealtime = () => {
            const repo = window.AlbEdu?.repository;
            if (!repo) return;
            const channelName = `auth:user-profile:${userId}`;
            try {
                const unsub = repo.subscribe(
                    channelName,
                    'users',
                    async () => {
                        // Re-fetch on any change to the user's row.
                        // Don't settle here — initial load is already handled.
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

        // Kick off both: immediate fetch (resolves the promise) and realtime
        // subscription (keeps _userData fresh on future changes).
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

// ── Login / Logout ────────────────────────────────────────────────────────────
async function authLogin() {
    // Native Supabase Google OAuth — uses signInWithGoogle redirect.
    // The legacy GoogleAuthProvider stub is no longer needed.
    try {
        const result = await _getAuth().signInWithGoogle();
        // signInWithGoogle uses redirect mode — no immediate return value.
        // onAuthStateChange fires when the user returns from Google.
        return result?.user ?? null;
    } catch (err) {
        throw new Error(err.message || 'Login Google gagal.');
    }
}

// ── Logout System (production-grade) ──────────────────────────────────────────
//
// Design principles:
//   1. SINGLE ENTRY POINT — authLogout() is the ONLY place that does signOut + redirect.
//      All callers (navigasi.js, panel.js, ui.js, ujian/index.html) just call
//      authLogout() and do NOT handle redirect themselves. This eliminates:
//        - double-redirect race conditions
//        - hardcoded '../login.html' paths that break from subfolders
//        - inconsistent confirmation dialogs
//   2. GUARD — prevents concurrent logout attempts (double-click, race conditions).
//   3. FULL CLEANUP — stops listeners, clears intervals, tears down UI state,
//      removes Supabase Realtime channels, and clears sensitive sessionStorage.
//   4. RESILIENT — if signOut() fails, still cleans up client-side and redirects.
//   5. ROLE-AGNOSTIC — works identically for admin and peserta.
//
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
    // ── Guard: prevent concurrent logout ────────────────────────────────────
    if (_logoutInProgress) {
        console.info('[Auth] logout already in progress — skipping');
        return false;
    }
    _logoutInProgress = true;

    try {
        // ── Step 1: Confirmation dialog ─────────────────────────────────────
        if (!options.skipConfirm) {
            const confirmed = await _confirmLogout();
            if (!confirmed) {
                _logoutInProgress = false;
                return false;
            }
        }

        // ── Step 2: Stop Firestore/Supabase profile listener ────────────────
        _stopProfileListener?.();
        _stopProfileListener = null;

        // ── Step 3: Clear auth state timer ──────────────────────────────────
        clearTimeout(_authStateTimer);
        _authStateTimer = null;

        // ── Step 4: Notify UI to tear down before session is gone ────────────
        //    This gives UI components a chance to clean up intervals, DOM, etc.
        document.dispatchEvent(new CustomEvent('auth-logout-started'));

        // ── Step 5: Stop Supabase Realtime channels ─────────────────────────
        //    Prevent ghost listeners from firing after session is cleared.
        //    Uses the native platform layer's unsubscribeAll() — replaces the
        //    old window.firebaseDb._channels iteration.
        try {
            window.AlbEdu?.supabase?.realtime?.unsubscribeAll?.();
        } catch (_) { /* non-critical */ }

        // ── Step 6: Clear sensitive session data ─────────────────────────────
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

        // ── Step 7: Reset module state immediately ───────────────────────────
        //    This ensures that even if signOut() hangs, the client-side state
        //    is already clean. No stale data can leak to other tabs.
        _currentUser  = null;
        _userRole     = null;
        _userData     = null;
        _profileState = null;
        _authReady    = true;

        // ── Step 8: Supabase signOut ─────────────────────────────────────────
        try {
            await _getAuth().signOut();
        } catch (signOutErr) {
            // signOut may fail if session is already expired or network is down.
            // This is NOT fatal — we already cleaned up client state above.
            // Log but don't throw; the user still gets redirected.
            console.warn('[Auth] signOut() failed (non-fatal):', signOutErr?.message || signOutErr);
        }

        // ── Step 9: Dispatch auth-ready with null role ───────────────────────
        //    This notifies byteward.js and other listeners that auth state changed.
        document.dispatchEvent(new CustomEvent('auth-ready', { detail: { role: null } }));

        // ── Step 10: UI cleanup hook ─────────────────────────────────────────
        try { window.UI?.afterLogout?.(); } catch (_) {}

        // ── Step 11: Redirect to landing page ────────────────────────────────
        // Per AlbEdu v2.1 routing contract (rule-url-albedu.md §4):
        //   logout destination is the PUBLIC LANDING PAGE (root index.html),
        //   NOT the login page. Users see the marketing/landing content after
        //   logout and can choose to log in again from there.
        //   Unauthenticated redirects from protected pages (in _handleAuthStateChange
        //   and byteward.checkPageAccess) still use _redirectToLogin() → loginUrl().
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

// ── Auth state handler ────────────────────────────────────────────────────────
async function _handleAuthStateChange(user) {
    clearTimeout(_authStateTimer);
    _authStateTimer = setTimeout(() => {
        _authReady = true;
        window.UI?.hideAuthLoading?.();
    }, AUTH_STATE_TIMEOUT_MS);

    try {
        if (user) {
            // ── Patch A: Email Verification Gate ──────────────────────────────
            // BUG FOUND (this audit): this used to read `user._supabaseUser
            // ?.email_confirmed_at`, a field that belonged to the OLD Firebase-
            // shaped shim (SupabaseApi.js / _toFirebaseUser) that has since been
            // replaced by the native platform layer in supabase-client.js.
            // The current AuthService._toUser() does NOT set `_supabaseUser` at
            // all — it exposes the raw Supabase user under `user.raw`, and
            // ALREADY computes `user.emailVerified` at the top level. Reading
            // the stale `_supabaseUser` path meant `isVerified` was undefined
            // → always falsy, so EVERY Google login (verified or not) was
            // force-signed-out here with no error shown to the user — this is
            // exactly the "pilih akun Google, terus gak terjadi apa-apa" bug:
            // the callback silently signs out and returns before any UI
            // feedback or redirect happens.
            const isVerified = user.emailVerified === true
                || user.raw?.email_confirmed_at != null;

            if (!isVerified) {
                // Force sign-out so the unverified session is cleared from local
                // storage. The resulting user=null callback handles the redirect.
                console.warn('[Auth] Patch A: unverified email — session rejected for', user.email);
                _stopProfileListener?.();
                _stopProfileListener = null;
                await _getAuth().signOut();
                // Previously this returned with zero user-facing feedback — the
                // login button just sat there forever with no explanation.
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
            // ── End Patch A ───────────────────────────────────────────────────

            _currentUser = user;
            // BUG FOUND (this audit): `user.uid` is a Firebase-shaped field name
            // that never existed on the native Supabase AuthService user object
            // (_toUser() in supabase-client.js only sets `.id`). This meant
            // _syncUserDocument(undefined) ran on every single login — the
            // realtime subscribe filter became `id=eq.undefined` (never
            // matches), it fell through to _createUserDocViaServer(undefined),
            // whose defensive session-match guard then threw CompletionError
            // ('invalid_token') because `session.user.id !== undefined`.
            // Combined with Patch A above, this is the actual cause of
            // "pilih akun Google, terus gak terjadi apa-apa" — the whole
            // chain failed silently after a real, successful Google sign-in.
            await _syncUserDocument(user.id);
            _authReady = true;
            // 'auth-ready' fires AFTER role is confirmed — byteward listens to this,
            // not 'albedu:platform-ready' (which fires before async role fetch completes).
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

        // If the error is a CompletionError (e.g. device_limit_reached),
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

// ── Init ──────────────────────────────────────────────────────────────────────
function _initializeSystem() {
    if (_initialized) return;
    _initialized = true;

    // Native Supabase platform layer check — replaces the old window.firebaseAuth guard.
    // The platform layer (AlbEdu.supabase) is initialized by src/platform/supabase-client.js
    // and dispatches 'albedu:platform-ready' when ready.
    if (!window.AlbEdu?.supabase?.auth) {
        window.UI?.hideAuthLoading?.();
        return;
    }

    try {
        // Native auth state subscription — replaces onAuthStateChanged.
        // Callback signature: (user, event) => void. We only use user here.
        _getAuth().onAuthStateChange((user) => _handleAuthStateChange(user));

        // Safety net: if the platform layer resolved the session from cache before
        // this listener registered, _handleAuthStateChange may have already fired
        // and the user is sitting on the login page with a valid session.
        // Force-check after 1.5s to catch that race.
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

// ── Debug (DevTools only) ─────────────────────────────────────────────────────
function debugByteWard() {
    /* eslint-disable no-console */
    console.group('ByteWard Auth v0.9.0');
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

// ── Public API ────────────────────────────────────────────────────────────────
window.Auth = {
    authLogin,
    authLogout,
    confirmLogout: _confirmLogout,
    debugByteWard,
    escapeHTML,
    // Routing
    redirectToLogin:          _redirectToLogin,
    isLoginPage:              _isLoginPage,
    isPublicPage:             _isPublicPage,
    isWithinAppScope:         _isInsideApp,
    getCurrentPage:           _getCurrentPage,
    navigateTo:               _navigateTo,
    getBasePath:              () => AUTH_CONFIG.BASE_PATH,
    getLandingPath:           () => AUTH_CONFIG.landingUrl(),
    getRoleRedirectPath:      (role) => AUTH_CONFIG.pathForRole(role),
    // Profile
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Migrated from firebase-ready / firebase-error events to the native
// albedu:platform-ready / albedu:platform-error events.
document.addEventListener('DOMContentLoaded', () => {
    if (window.AlbEdu?.supabase?.isReady?.()) {
        _initializeSystem();
    } else {
        document.addEventListener('albedu:platform-ready', _initializeSystem,             { once: true });
        document.addEventListener('albedu:platform-error', () => window.UI?.hideAuthLoading?.(), { once: true });
    }
});