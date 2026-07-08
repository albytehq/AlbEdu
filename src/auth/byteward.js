// byteward.js — AlbEdu route scope authorization & access control
//
// Auth logic lives in auth/main.js — this file only enforces which folder
// scopes each role can reach, runs the 404 / access-denied handlers, and
// auto-enforces on page load via the 'auth-ready' event.
//
// IIFE-scoped because the route primitives (_getCurrentPage, _getRouteScope,
// _isLoginPage, etc.) are also declared in main.js. Without the IIFE those
// top-level function declarations collide on browsers that reject lexical
// redeclaration.

(function () {
'use strict';

const _t = (key, vars, fallback) => fallback;

const APP_CONFIG = {
    // Delegate to window.Auth so we don't hardcode '/AlbEdu/' here — that
    // assumption broke localhost testing before.
    get BASE_PATH() {
        return window.Auth?.getBasePath?.() ?? '/';
    },

    APP_VERSION: '0.4.0',

    // 'index.html' is ambiguous — it appears in /ujian/, /admin/, and the
    // app root. Folder scope is unambiguous at any deployment prefix.
    SCOPE_POLICY: {
        peserta: ['ujian', 'public'],  // 'ujian' = /pages/assessment/ + /ujian/ (legacy)
    },
};

function _getCurrentPage() {
    return window.location.pathname
        .split('/')
        .pop()
        .split('?')[0];
}

// replace() (not href) so a user bounced off a protected page can't press
// Back to return to it. Same reasoning as auth/main.js.
function _navigateTo(path, reason) {
    const cur = window.location.pathname;
    if (cur.replace(/\/$/, '') === path.replace(/\/$/, '')) return;
    console.info('[AuthRedirect]', reason || 'byteward redirect', '\n  from:', cur, '\n  to:  ', path);
    window.location.replace(path);
}

function _isLoginPage() {
    if (window.Auth?.isLoginPage) return window.Auth.isLoginPage();
    const page = _getCurrentPage();
    if (page === 'login.html') return true;
    if (page === 'index.html' || page === '') {
        // index.html is a login page only at root scope. Inside /admin/ or
        // /ujian/ it's a protected dashboard.
        return _getRouteScope() === 'public';
    }
    return false;
}

function _isPublicPage() {
    if (window.Auth?.isPublicPage) return window.Auth.isPublicPage();
    if (_isLoginPage()) return true;
    return _getCurrentPage() === '404.html' && _getRouteScope() === 'public';
}

function _isWithinApp() {
    if (_isPublicPage()) return false;
    const page  = _getCurrentPage();
    const scope = _getRouteScope();
    if (page === '' && (scope === 'admin' || scope === 'ujian')) return true;
    return page !== '';
}

// Map the current URL to a named authorization scope.
//
// WHY folder-based, not filename-based: filenames collide across roles
// ('index.html' exists in /ujian/, /admin/, and root). Folder name is the
// unambiguous discriminator and works identically on localhost, Vercel, and
// any subfolder deployment because we strip BASE_PATH before inspecting.
//
// Examples (BASE_PATH = '/'):
//   /login.html                 → 'public'
//   /404.html                   → 'public'
//   /ujian/index.html           → 'ujian'
//   /admin/index.html           → 'admin'
//
// Examples (BASE_PATH = '/AlbEdu/'):
//   /AlbEdu/login.html          → 'public'
//   /AlbEdu/ujian/index.html    → 'ujian'
//   /AlbEdu/admin/index.html    → 'admin'
function _getRouteScope() {
    const basePath = window.Auth?.getBasePath?.() ?? '/';
    const pathname = window.location.pathname.split('?')[0];

    const relative = pathname.startsWith(basePath)
        ? pathname.slice(basePath.length)
        : pathname.replace(/^\//, '');

    const firstSegment = relative.split('/')[0];

    // /pages/admin/ and /pages/assessment/ paths: firstSegment is 'pages',
    // so check the second segment for the real scope.
    const FOLDER_SCOPE = {
        ujian: 'ujian',
        admin: 'admin',
        assessment: 'ujian',  // /pages/assessment/ → peserta scope (was /ujian/)
    };

    let scope = FOLDER_SCOPE[firstSegment] ?? 'public';
    if (firstSegment === 'pages') {
        const secondSegment = relative.split('/')[1] ?? '';
        if (secondSegment === 'admin') scope = 'admin';
        else if (secondSegment === 'assessment') scope = 'ujian';
        else scope = 'public';
    }

    const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isDev) {
        console.debug('[ByteWard] _getRouteScope:', { basePath, pathname, relative, firstSegment, scope });
    }

    return scope;
}

// Called by individual pages after auth has settled. Returns true if access
// is allowed, false if a redirect was triggered.
function checkPageAccess() {
    const auth = window.Auth;

    // Auth still loading — let the auth state settle. Page will call again
    // (or auth will redirect) once ready.
    if (!auth || !auth.authReady) return true;

    if (!auth?.currentUser) {
        if (_isWithinApp()) {
            console.info('[AuthRedirect] checkPageAccess: no user on protected page → login');
            const bp = auth?.getBasePath?.() ?? '/';
            const loginUrl = auth?.loginUrl?.() ?? (bp + 'pages/login.html');
            _navigateTo(loginUrl, 'no session → login');
        }
        return false;
    }

    if (_isLoginPage()) {
        const role = auth.userRole;
        if (role) {
            console.info('[AuthRedirect] checkPageAccess: authed user on login page → dashboard');
            _navigateTo(auth.getRoleRedirectPath(role), `authed on login → ${role} dashboard`);
        }
        return true;
    }

    // Authed user on 404 — auth.js handles the "go back" notification.
    if (_isPublicPage()) return true;

    const role = auth.userRole;

    if (role === 'admin') return true;

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

function handle404Page() {
    const auth     = window.Auth;
    const basePath = auth?.getBasePath?.() ?? '/';
    const loginUrl = auth?.loginUrl?.() ?? (basePath + 'pages/login.html');

    if (!auth?.currentUser) {
        _navigateTo(loginUrl, '404 + no session → login');
    } else {
        const role = auth.userRole || 'peserta';
        _navigateTo(
            auth.getRoleRedirectPath?.(role) ?? loginUrl,
            `404 + role=${role} → dashboard`
        );
    }
}

// Build the 403 page manually — no innerHTML on untrusted data, zero XSS risk.
function _showAccessDenied() {
    document.querySelectorAll('script').forEach(s => {
        if (!s.src?.includes('security') && !s.src?.includes('byteward')) s.remove();
    });

    const auth     = window.Auth;
    const role     = auth?.userRole;
    const basePath = auth?.getBasePath?.() ?? '/';
    const loginUrl = auth?.loginUrl?.() ?? (basePath + 'pages/login.html');
    const dashPath = role
        ? (auth?.getRoleRedirectPath?.(role) ?? loginUrl)
        : loginUrl;

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
    h2.textContent = _t('byteward.access_denied_title', null, 'Akses Ditolak');

    const p = document.createElement('p');
    Object.assign(p.style, { fontSize: '0.95rem', maxWidth: '380px', color: '#64748b', margin: '0' });
    p.textContent = _t('byteward.access_denied_msg', null, 'Anda tidak memiliki izin untuk mengakses halaman ini.');

    const a = document.createElement('a');
    a.href = dashPath;
    Object.assign(a.style, {
        marginTop: '8px', padding: '10px 24px',
        background: '#2563eb', color: 'white',
        textDecoration: 'none', borderRadius: '8px',
        fontWeight: '600', fontSize: '0.9rem',
    });
    a.textContent = _t('byteward.back_to_dashboard', null, 'Kembali ke Dashboard');

    wrap.append(h1, h2, p, a);
    document.body.replaceChildren(wrap);
}

window.ByteWard = {
    APP_CONFIG,
    checkPageAccess,
    handle404Page,
    showAccessDenied: _showAccessDenied,

    getCurrentPage: _getCurrentPage,
    getRouteScope:  _getRouteScope,
    navigateTo:     _navigateTo,

    // Legacy passthroughs so callers that imported ByteWard keep working.
    // Implemented as getters so they always reflect the current window.Auth
    // even if Auth loaded after ByteWard.
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

// WHY 'auth-ready' dan bukan 'albedu:platform-ready':
//   'albedu:platform-ready' fires when the Supabase SDK finishes init —
//   role has NOT been fetched yet.
//   'auth-ready' fires from auth/main.js AFTER _syncUserDocument() finishes,
//   so Auth.userRole is guaranteed to be set. Using 'albedu:platform-ready'
//   here caused role=(none) because byteward ran checkPageAccess() before
//   the async profile fetch completed.
//
// Fast-path: if Auth.authReady is already true (hot reload / cached module),
// enforce immediately without waiting for the event.
(function _autoEnforce() {
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
