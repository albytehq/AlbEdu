// =============================================================================
// byteward.js — AlbEdu Routing & Access Control v0.4.0
// =============================================================================
//
// Satu tanggung jawab: route scope authorization, access check, 404 handler,
// access-denied page. Auth logic ada di auth.js — tidak direplikasi di sini.
//
// DEPENDS ON: auth.js (window.Auth must exist before ByteWard is used).
//
// CHANGES v0.4.0 — Scope-Based Authorization:
//   - HAPUS ROLE_WHITELIST (filename-based) — menyebabkan bug: 'index.html'
//     cocok untuk /ujian/index.html DAN /admin/index.html sekaligus
//   - TAMBAH _getRouteScope() — folder-based, environment-agnostic
//     '/ujian/...' → 'ujian' | '/admin/...' → 'admin' | '/login.html' → 'public'
//   - GANTI whitelist check dengan scope policy di checkPageAccess()
//     peserta: scope === 'ujian' || scope === 'public'
//     admin: allow all
//   - TAMBAH [ByteWard] migration logs untuk debugging
//   - Semua primitif lain (navigateTo, getCurrentPage, dll) tidak berubah
//
// v2.1.3 FIX: Wrapped entire file in IIFE. Previously, top-level `function
// _getCurrentPage`, `_navigateTo`, `_getRouteScope`, `_isLoginPage`,
// `_isPublicPage` leaked into the global lexical environment, conflicting
// with the SAME functions declared in main.js →
// `SyntaxError: Identifier '_getCurrentPage' has already been declared`.
// The IIFE scopes them locally; `window.ByteWard` is the only global.
// =============================================================================

(function () {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const APP_CONFIG = {
    // BASE_PATH sekarang selalu diambil dari window.Auth untuk konsistensi.
    // Tidak ada hardcode '/AlbEdu/' di sini — itu yang menyebabkan bug di localhost.
    get BASE_PATH() {
        return window.Auth?.getBasePath?.() ?? '/';
    },

    APP_VERSION: '0.4.0',

    // SCOPE_POLICY: maps role → set of allowed route scopes.
    //
    // WHY scopes, not filenames:
    //   'index.html' is ambiguous — it matches /ujian/index.html AND
    //   /admin/index.html. Folder scope is unambiguous at any deployment prefix.
    //
    // Scope values mirror _getRouteScope() output:
    //   'ujian'  → any page inside /ujian/ folder
    //   'public' → login.html, 404.html, root index.html
    //   'admin'  → handled by early-exit in checkPageAccess(); not listed here.
    SCOPE_POLICY: {
        peserta: ['ujian', 'public'],  // 'ujian' scope = /pages/assessment/ + /ujian/ (legacy)
    },
};

// ── Route primitives ──────────────────────────────────────────────────────────

// _getCurrentPage(): filename only, query string stripped.
// Mirrors auth.js _getCurrentPage() — same logic, same portability.
// Defined here so byteward.js can operate even before window.Auth is fully
// initialized (e.g. during the whitelist check itself).
function _getCurrentPage() {
    return window.location.pathname
        .split('/')
        .pop()
        .split('?')[0];
}

// _navigateTo(): single redirect primitive — replace() not href.
// WHY replace(): see auth.js _navigateTo() comment. Same reasoning applies here.
function _navigateTo(path, reason) {
    const cur = window.location.pathname;
    if (cur.replace(/\/$/, '') === path.replace(/\/$/, '')) return;
    console.info('[AuthRedirect]', reason || 'byteward redirect', '\n  from:', cur, '\n  to:  ', path);
    window.location.replace(path);
}

// Login page check — delegates to auth.js when available, falls back to
// a simplified scope-aware check if auth.js hasn't loaded yet.
function _isLoginPage() {
    if (window.Auth?.isLoginPage) return window.Auth.isLoginPage();
    // Fallback: login.html at root level only.
    const page = _getCurrentPage();
    if (page === 'login.html') return true;
    if (page === 'index.html' || page === '') {
        // index.html / bare URL is a login page only at root (scope = public).
        // Inside /admin/ or /ujian/ it's a protected dashboard.
        return _getRouteScope() === 'public';
    }
    return false;
}

// "Public page" — pages where unauthenticated users should NOT be redirected.
// Includes login pages and 404.  Delegates to auth.js when available.
function _isPublicPage() {
    if (window.Auth?.isPublicPage) return window.Auth.isPublicPage();
    if (_isLoginPage()) return true;
    return _getCurrentPage() === '404.html' && _getRouteScope() === 'public';
}

// "Within app scope" — any page that is NOT public and requires authentication.
function _isWithinApp() {
    if (_isPublicPage()) return false;
    const page  = _getCurrentPage();
    const scope = _getRouteScope();
    if (page === '' && (scope === 'admin' || scope === 'ujian')) return true;
    return page !== '';
}

// _getRouteScope() — maps the current URL to a named authorization scope.
//
// WHY folder-based instead of filename-based:
//   Filenames are ambiguous across roles: 'index.html' appears in /ujian/,
//   /admin/, and the app root — they must NOT be treated as equivalent.
//   Folder name is the unambiguous discriminator, and it works identically
//   on localhost:5500, Live Server, Vercel, and any subfolder deployment
//   because we strip BASE_PATH before inspecting path segments.
//
// Algorithm:
//   1. Strip BASE_PATH prefix from pathname (handles /AlbEdu/ on Vercel, / on localhost).
//   2. Take the first remaining path segment (the immediate subfolder after root).
//   3. Map known folders to their scope label.
//   4. Anything left over (root-level files like login.html, 404.html) → 'public'.
//
// Examples (localhost, BASE_PATH = '/'):
//   /login.html                 → 'public'
//   /404.html                   → 'public'
//   /ujian/index.html           → 'ujian'
//   /ujian/kerjakan-ujian.html  → 'ujian'
//   /admin/index.html           → 'admin'
//   /admin/pages/buat-ujian.html → 'admin'
//
// Examples (Vercel, BASE_PATH = '/AlbEdu/'):
//   /AlbEdu/login.html          → 'public'
//   /AlbEdu/ujian/index.html    → 'ujian'
//   /AlbEdu/admin/index.html    → 'admin'
function _getRouteScope() {
    const basePath = window.Auth?.getBasePath?.() ?? '/';
    const pathname = window.location.pathname.split('?')[0];

    // Strip the BASE_PATH prefix to get the app-relative path.
    // e.g. '/AlbEdu/ujian/index.html' → 'ujian/index.html'
    //      '/ujian/index.html'        → 'ujian/index.html'
    const relative = pathname.startsWith(basePath)
        ? pathname.slice(basePath.length)
        : pathname.replace(/^\//, '');

    // First segment is the folder (e.g. 'ujian', 'admin').
    // If the path has no slash, it's a root-level file → public.
    const firstSegment = relative.split('/')[0];

    // Known folder → scope map.
    // v0.741.5: paths changed from /ujian/ and /admin/ to /pages/assessment/ and /pages/admin/
    // Support both old and new path structures for backward compat.
    // 'public' is the catch-all for root-level pages.
    const FOLDER_SCOPE = {
        ujian: 'ujian',
        admin: 'admin',
        assessment: 'ujian',  // /pages/assessment/ → peserta scope (was /ujian/)
    };

    // For /pages/admin/ and /pages/assessment/ paths, firstSegment is 'pages'
    // Check second segment for admin/assessment
    let scope = FOLDER_SCOPE[firstSegment] ?? 'public';
    if (firstSegment === 'pages') {
        const secondSegment = relative.split('/')[1] ?? '';
        if (secondSegment === 'admin') scope = 'admin';
        else if (secondSegment === 'assessment') scope = 'ujian'; // peserta scope
        else scope = 'public'; // /pages/login.html, /pages/privacy-policy.html, etc.
    }

    // FIX BUG-08: Hanya log debug di development, bukan production.
    const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isDev) {
        console.debug('[ByteWard] _getRouteScope:', { basePath, pathname, relative, firstSegment, scope });
    }

    return scope;
}

// ── Access Check ──────────────────────────────────────────────────────────────
//
// Called by individual pages (admin/index.html, ujian/index.html, etc.)
// after auth has settled. Returns true if access is allowed, false if not.
function checkPageAccess() {
    const auth = window.Auth;

    // Auth still loading — don't redirect yet, let the auth state settle.
    // The page will call us again (or auth will redirect) once ready.
    if (!auth || !auth.authReady) return true;

    // No user → send to login if on a protected page.
    if (!auth.currentUser) {
        if (_isWithinApp()) {
            console.info('[AuthRedirect] checkPageAccess: no user on protected page → login');
            _navigateTo(auth.getBasePath() + 'login.html', 'no session → login');
        }
        return false;
    }

    // Authed user on login page → send to their dashboard.
    if (_isLoginPage()) {
        const role = auth.userRole;
        if (role) {
            console.info('[AuthRedirect] checkPageAccess: authed user on login page → dashboard');
            _navigateTo(auth.getRoleRedirectPath(role), `authed on login → ${role} dashboard`);
        }
        return true;
    }

    // Authed user on 404 page — auth.js handles the "go back" notification.
    // Don't redirect to dashboard from here; let _handle404Redirect() do it.
    if (_isPublicPage()) return true;

    const role = auth.userRole;

    // Admin gets unconditional access to every route.
    if (role === 'admin') return true;

    // Scope-based authorization for all other roles.
    //
    // _getRouteScope() tells us which folder-level zone this page belongs to.
    // We check that against SCOPE_POLICY[role] — a small list of allowed zones.
    //
    // WHY not filename whitelist: 'index.html' matches both /ujian/index.html
    // and /admin/index.html. Scope is unambiguous.
    const scope          = _getRouteScope();
    const allowedScopes  = APP_CONFIG.SCOPE_POLICY[role] || [];
    const ok             = allowedScopes.includes(scope);

    console.info('[ByteWard] access check:', { role, scope, allowedScopes, ok });

    if (!ok) {
        console.warn('[ByteWard] DENIED — role', role, 'scope', scope, 'not in', allowedScopes);
        _showAccessDenied();
        return false;
    }

    return true;
}

// ── 404 Handler ───────────────────────────────────────────────────────────────
function handle404Page() {
    const auth     = window.Auth;
    const basePath = auth?.getBasePath?.() ?? '/';

    if (!auth?.currentUser) {
        _navigateTo(basePath + 'login.html', '404 + no session → login');
    } else {
        const role = auth.userRole || 'peserta';
        _navigateTo(
            auth.getRoleRedirectPath?.(role) ?? basePath + 'login.html',
            `404 + role=${role} → dashboard`
        );
    }
}

// ── Access Denied Page (403) ──────────────────────────────────────────────────
// Builds DOM manually — zero innerHTML on untrusted data, zero XSS risk.
function _showAccessDenied() {
    // Kill any non-essential scripts so they can't interfere with the denial page.
    document.querySelectorAll('script').forEach(s => {
        if (!s.src?.includes('security') && !s.src?.includes('byteward')) s.remove();
    });

    // Back link goes to the role's dashboard, or login if role is unknown.
    const auth     = window.Auth;
    const role     = auth?.userRole;
    const basePath = auth?.getBasePath?.() ?? '/';
    const dashPath = role
        ? (auth?.getRoleRedirectPath?.(role) ?? basePath + 'login.html')
        : basePath + 'login.html';

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        position: 'fixed', inset: '0', background: '#f8fafc',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'center',
        fontFamily: 'system-ui,-apple-system,sans-serif',
        textAlign: 'center', padding: '20px', zIndex: '99999', gap: '12px',
    });
    wrap.setAttribute('role', 'main');
    wrap.setAttribute('aria-labelledby', 'denied-title');

    const h1 = document.createElement('h1');
    h1.id = 'denied-title';
    Object.assign(h1.style, { fontSize: '3rem', fontWeight: '700', color: '#dc2626', margin: '0' });
    h1.textContent = '403';

    const h2 = document.createElement('h2');
    Object.assign(h2.style, { fontSize: '1.25rem', fontWeight: '600', color: '#1e293b', margin: '0' });
    h2.textContent = 'Akses Ditolak';

    const p = document.createElement('p');
    Object.assign(p.style, { fontSize: '0.95rem', maxWidth: '380px', color: '#64748b', margin: '0' });
    p.textContent = 'Anda tidak memiliki izin untuk mengakses halaman ini.';

    const a = document.createElement('a');
    a.href = dashPath;
    Object.assign(a.style, {
        marginTop: '8px', padding: '10px 24px',
        background: '#2563eb', color: 'white',
        textDecoration: 'none', borderRadius: '8px',
        fontWeight: '600', fontSize: '0.9rem',
    });
    a.textContent = 'Kembali ke Dashboard';

    wrap.append(h1, h2, p, a);
    document.body.replaceChildren(wrap);
}

// ── Public API ────────────────────────────────────────────────────────────────
window.ByteWard = {
    APP_CONFIG,
    checkPageAccess,
    handle404Page,
    showAccessDenied: _showAccessDenied,

    // Convenience passthrough — callers that import ByteWard get these for free
    getCurrentPage: _getCurrentPage,
    getRouteScope:  _getRouteScope,
    navigateTo:     _navigateTo,

    // Deprecated shims — delegate to window.Auth so old callers keep working.
    // These are intentionally left as getters so they always reflect the
    // current state of window.Auth even if Auth loaded after ByteWard.
    get isLoginPage()         { return window.Auth?.isLoginPage        ?? _isLoginPage; },
    get isPublicPage()        { return window.Auth?.isPublicPage       ?? _isPublicPage; },
    get isWithinAppScope()    { return window.Auth?.isWithinAppScope   ?? _isWithinApp; },
    get redirectToLogin()     { return window.Auth?.redirectToLogin; },
    get redirectBasedOnRole() {
        return () => {
            const role = window.Auth?.userRole;
            if (role) _navigateTo(window.Auth.getRoleRedirectPath(role), `redirectBasedOnRole → ${role}`);
        };
    },
};

// ── Auto-enforcement bootstrap ────────────────────────────────────────────────
//
// WHY 'auth-ready' dan bukan 'firebase-ready':
//   'firebase-ready' = Supabase SDK selesai init — role BELUM di-fetch.
//   'auth-ready'     = di-dispatch auth.js SETELAH _syncUserDocument() selesai,
//                      jadi Auth.userRole dijamin sudah terisi.
//   Pakai 'firebase-ready' menyebabkan role=(none) karena byteward
//   memanggil checkPageAccess() sebelum async profile fetch dari Supabase
//   selesai — itulah yang muncul di console tadi.
//
// Fast-path: kalau Auth.authReady sudah true sebelum byteward.js load
//   (misalnya hot reload / module cached), langsung enforce tanpa tunggu event.

(function _autoEnforce() {
    // Skip auth enforcement on public pages (login, index root, 404).
    // These pages handle their own redirect logic via auth.js.
    if (_isPublicPage()) return;

    function _enforce() {
        console.info('[ByteWard] auto-enforce: scope=', _getRouteScope(), 'role=', window.Auth?.userRole ?? '(none)');
        checkPageAccess();
    }

    if (window.Auth?.authReady) {
        _enforce();
    } else {
        document.addEventListener('auth-ready', _enforce, { once: true });
    }
})();

})();