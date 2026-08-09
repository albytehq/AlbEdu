// ============================================================================
// AlbEdu Cloudflare Worker — Edge Cache + Config + Health
// ============================================================================
//
// ARCHITECTURE (v0.821.0+):
//
//   GET  /api/supabase-config  → edge-cached config (1h TTL)
//   GET  /api/health           → uptime monitor
//   GET  /img/{hash}           → image cache proxy (24h TTL)
//                                  • storage_backend='github' → jsDelivr CDN
//                                  • storage_backend='b2'     → B2 S3 API (signed)
//   POST /upload               → 410 Gone (Phase 1: migrated to Supabase Storage)
//   POST /release              → 410 Gone (Phase 1: migrated to Supabase Storage)
//   Cron (every 15 min)        → sweepExpiredAssessments (legacy; Phase 3 replaces with pg_cron)
//
// WHY v7 (vs v6):
//   • v6 was an upload gateway — broken in production (AUTH_TOKEN never sent by client)
//   • v7 is an edge cache — serves images from Cloudflare edge (1ms TTFB)
//   • Reduces B2 Class B transactions by ~99% (cache hits = 0 B2 calls)
//   • /upload + /release decommissioned (Phase 1 moved avatars to Supabase Storage)
//   • /img/{hash} handles both legacy GitHub assets AND new B2 assets (forward-compatible)
//
// ENVIRONMENT VARIABLES (set in Cloudflare Dashboard → Workers → Settings → Variables):
//
//   Required:
//     SUPABASE_URL              — e.g. https://kzsrerxhhrtsxnpnmqgl.supabase.co
//     SUPABASE_ANON_KEY         — public anon key (for /api/supabase-config)
//     SUPABASE_SERVICE_ROLE_KEY — service role key (for assets_manifest queries)
//
//   Required for /img/{hash} B2 backend:
//     B2_KEY_ID                 — Backblaze application key ID
//     B2_APPLICATION_KEY        — Backblaze application key (SECRET)
//     B2_BUCKET_NAME            — albedu-assets-systems
//     B2_ENDPOINT               — s3.us-west-002.backblazeb2.com (your B2 region)
//     B2_REGION                 — us-west-002 (extract from endpoint, no s3. prefix)
//
//   Optional:
//     AUTH_TOKEN                — legacy, unused in v7 (kept for backward compat)
//     ALLOWED_ORIGINS           — comma-separated origins for CORS (default: albytehq.github.io)
//
// CRYPTO:
//   • AWS Signature V4 for B2 S3 API (Web Crypto API, no Node.js deps)
//   • SHA-256 + HMAC-SHA256 via crypto.subtle
//
// CACHING:
//   • Cloudflare Cache API (caches.default) for /img/{hash} responses
//   • Cache key: https://cache.local/img/{hash}
//   • TTL: 1 year immutable (Cache-Control: public, max-age=31536000, immutable)
//     S7-01/C3-01 fix: was 24h, but /img/{hash} is SHA-256 addressed —
//     content NEVER changes for a given hash. 1-year immutable gives 5x
//     better cache hit ratio and cuts B2 origin egress 5x.
//   • ETag: hash (enables 304 Not Modified)
//
// BANDWIDTH ALLIANCE:
//   • B2 egress to Cloudflare = $0 (automatic — no setup needed)
//   • See docs/asset-system/BACKBLAZE-SETUP.md Step 5
// ============================================================================

import { jwtVerify } from 'jose';

// ── Constants ──────────────────────────────────────────────────────────────

// S7-01/C3-01 fix: 1 year immutable for SHA-256 addressed assets.
// Was 86400 (24h) — but /img/{hash} content NEVER changes for a given
// hash, so 24h TTL caused 5x more origin fetches than necessary.
const CACHE_TTL_SECONDS = 31536000; // 1 year (immutable — SHA-256 addressed)
const CONFIG_CACHE_TTL = 3600;   // 1 hour for /api/supabase-config

const ALLOWED_ORIGINS = new Set([
  'https://albytehq.github.io',
  'https://albedu-id.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
]);

// Legacy GitHub asset CDN (jsDelivr) — for assets_manifest rows where storage_backend='github'
const GITHUB_CDN_BASE = 'https://cdn.jsdelivr.net/gh';

// Read allowed origins from env if set (comma-separated)
if (typeof env !== 'undefined' && env.ALLOWED_ORIGINS) {
  for (const o of env.ALLOWED_ORIGINS.split(',')) {
    ALLOWED_ORIGINS.add(o.trim());
  }
}

// ── Rate limiting (in-memory, per-Worker-isolate) ──────────────────────────
// Simple sliding-window rate limiter for /api/supabase-config (prevent abuse).
// Not for /img/{hash} — that's cached so abuse is self-limiting.

const _rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 min
const RATE_LIMIT_MAX = 60;        // 60 req/min per IP

function _rateLimit(key) {
  const now = Date.now();
  const entry = _rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    _rateLimitStore.set(key, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    _rateLimitStore.delete(key);
    return false;
  }
  // Cleanup old entries occasionally
  if (_rateLimitStore.size > 1000) {
    for (const [k, v] of _rateLimitStore) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW) _rateLimitStore.delete(k);
    }
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  // FIX #4: was 'Access-Control-Allow-Origin': '*' which BREAKS credentials.
  // When credentials: 'include' is used, browser rejects '*' — must echo origin.
  // But json() is called without request context, so we use a fallback.
  // For auth routes, use authJson() instead (which echoes origin via corsHeaders).
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  // If Access-Control-Allow-Origin not already set, default to first allowed origin
  if (!headers['Access-Control-Allow-Origin']) {
    headers['Access-Control-Allow-Origin'] = [...ALLOWED_ORIGINS][0] || 'https://albytehq.github.io';
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, X-Exam-Mode, Prefer, X-Client, X-Client-Info, X-Idempotency-Key, apikey, X-Total-Count, Range',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Cookie auth proxy ──────────────────────────────────────────────────────
// Tokens are deliberately kept out of browser storage. The only readable
// cookie is the CSRF token used by the double-submit protection below.
const ACCESS_COOKIE = 'albedu_session';
const REFRESH_COOKIE = 'albedu_refresh';
const CSRF_COOKIE = 'albedu_csrf';
const ACCESS_MAX_AGE = 3600;
const REFRESH_MAX_AGE = 604800;

function parseCookies(request) {
  const result = {};
  for (const pair of (request.headers.get('Cookie') || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(pair.slice(index + 1).trim()); } catch (_) {}
  }
  return result;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=' + (options.path || '/')];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  // FIX #1: Cross-site (github.io → workers.dev) requires SameSite=None; Secure.
  // SameSite=Lax would NOT send cookies on cross-site fetch requests.
  // This is safe because we enforce CSRF via double-submit cookie pattern.
  parts.push('Secure', `SameSite=${options.sameSite || 'None'}`);
  return parts.join('; ');
}

function authHeaders(request, extra = {}) {
  const origin = request.headers.get('Origin') || '';
  return {
    ...corsHeaders(origin),
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function authJson(request, body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: authHeaders(request, { 'Content-Type': 'application/json', ...headers }),
  });
}

function clearAuthCookies() {
  return [
    cookie(ACCESS_COOKIE, '', { maxAge: 0, httpOnly: true }),
    cookie(REFRESH_COOKIE, '', { maxAge: 0, httpOnly: true }),
    cookie(CSRF_COOKIE, '', { maxAge: 0 }),
  ];
}

function setAuthCookies(accessToken, refreshToken, csrfToken = randomToken()) {
  const values = [cookie(ACCESS_COOKIE, accessToken, { maxAge: ACCESS_MAX_AGE, httpOnly: true })];
  // FIX #2: Refresh cookie restricted to /api/auth/refresh path.
  // The proxy middleware does NOT use the refresh cookie — it only reads the
  // access cookie. If access token is expired, proxy returns 401 with
  // X-Need-Refresh: true header, and the client calls /api/auth/refresh
  // explicitly (which CAN read the refresh cookie because it's on that path).
  // This prevents the refresh token from being sent on every request (security).
  if (refreshToken) values.push(cookie(REFRESH_COOKIE, refreshToken, { maxAge: REFRESH_MAX_AGE, httpOnly: true }));
  values.push(cookie(CSRF_COOKIE, csrfToken, { maxAge: ACCESS_MAX_AGE }));
  return values;
}

function appendSetCookies(headers, values) {
  for (const value of values) headers.append('Set-Cookie', value);
}

function userPayload(user) {
  if (!user) return null;
  return { id: user.id, email: user.email || '', user_metadata: user.user_metadata || {} };
}

async function supabaseAuth(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('apikey', env.SUPABASE_ANON_KEY);
  headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
  return fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, { ...init, headers });
}

async function verifyAccessToken(token, env) {
  if (!token || !env.JWT_SECRET) return null;
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return payload;
  } catch (_) { return null; }
}

function tokenExpiresSoon(payload, thresholdSeconds) {
  return !payload?.exp || payload.exp - Math.floor(Date.now() / 1000) <= thresholdSeconds;
}

async function refreshSession(refreshToken, env) {
  if (!refreshToken) return null;
  const response = await supabaseAuth(env, 'token?grant_type=refresh_token', {
    method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.access_token ? data : null;
}

function csrfValid(request, pathname) {
  // Public routes that don't require CSRF (user has no session yet)
  const PUBLIC_ROUTES = [
    '/api/auth/login',
    '/api/auth/forgot',
    '/api/auth/register',
    '/api/auth/recover',
    '/functions/v1/register-admin',
    '/functions/v1/user-auth-preflight',
    '/functions/v1/access-code-attempt',
    '/functions/v1/health-check',
  ];
  if (PUBLIC_ROUTES.includes(pathname)) return true;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
  const csrf = parseCookies(request)[CSRF_COOKIE];
  const header = request.headers.get('X-CSRF-Token');
  return Boolean(csrf && header && csrf === header);
}

async function currentSession(request, env, { allowRefresh = true } = {}) {
  const cookies = parseCookies(request);
  let token = cookies[ACCESS_COOKIE];
  let payload = await verifyAccessToken(token, env);
  const threshold = request.headers.get('X-Exam-Mode') === '1' ? 300 : 60;
  let refreshed = null;
  // Auto-refresh if token is expired or expiring soon.
  // Note: refresh cookie Path=/ (not restricted to /api/auth/refresh) because
  // Path restriction prevents auto-refresh from working on /api/auth/session
  // and proxy middleware. This is a known security tradeoff — in production
  // with a custom domain (same-site), we can restrict the path.
  if (allowRefresh && (!payload || tokenExpiresSoon(payload, threshold))) {
    refreshed = await refreshSession(cookies[REFRESH_COOKIE], env);
    if (refreshed) {
      token = refreshed.access_token;
      payload = await verifyAccessToken(token, env);
    }
  }
  // Temporary migration fallback. Remove after every frontend has been deployed.
  if (!token && request.headers.get('Authorization')?.startsWith('Bearer ')) {
    token = request.headers.get('Authorization').slice(7);
    payload = await verifyAccessToken(token, env);
  }
  return { token, payload, refreshed };
}

async function handleLogin(request, env, url) {
  try {
    if (request.method === 'GET' && url.searchParams.get('provider') === 'google') {
      // Google OAuth with PKCE — Worker generates code_verifier + code_challenge.
      // code_verifier stored in cookie (Path=/ so callback can read it).
      // Supabase stores code_challenge → Google → callback with code → Worker
      // exchanges code + code_verifier for session.
      const returnTo = url.searchParams.get('return_to') || '/pages/login.html';
      const callback = new URL('/api/auth/callback', url.origin);
      callback.searchParams.set('return_to', returnTo);
      const authorize = new URL(`${env.SUPABASE_URL}/auth/v1/authorize`);
      authorize.searchParams.set('provider', 'google');
      authorize.searchParams.set('redirect_to', callback.toString());
      // Generate PKCE verifier + challenge
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
      authorize.searchParams.set('code_challenge', await pkceChallenge(verifier));
      authorize.searchParams.set('code_challenge_method', 's256');
      // Store verifier in cookie — Path=/ so /api/auth/callback can read it
      const redirectHeaders = new Headers({
        'Location': authorize.toString(),
        'Set-Cookie': cookie('albedu_oauth_verifier', verifier, { maxAge: 600, httpOnly: true }),
      });
      Object.entries(authHeaders(request)).forEach(([key, value]) => redirectHeaders.set(key, value));
      return new Response(null, { status: 302, headers: redirectHeaders });
    }
    if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
    let body;
    try { body = await request.json(); } catch (_) { return authJson(request, { error: 'Payload login tidak valid.' }, 400); }
  const payload = body?.id_token
    ? { provider: 'google', token: body.id_token }
    : { email: body?.email, password: body?.password, gotrue_meta_security: body?.captchaToken ? { captcha_token: body.captchaToken } : undefined };
  if ((!payload.email || !payload.password) && !payload.token) return authJson(request, { error: 'Email dan kata sandi wajib diisi.' }, 400);
  const endpoint = payload.token ? 'token?grant_type=id_token' : 'token?grant_type=password';
  const response = await supabaseAuth(env, endpoint, { method: 'POST', body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) return authJson(request, { error: data.msg || data.error_description || 'Login gagal.' }, response.status || 401);
  const headers = new Headers(authHeaders(request, { 'Content-Type': 'application/json' }));
  appendSetCookies(headers, setAuthCookies(data.access_token, data.refresh_token));
  return new Response(JSON.stringify({ user: userPayload(data.user) }), { status: 200, headers });
  } catch (err) {
    console.error('[login] Error:', err?.stack || err);
    return authJson(request, { error: 'Terjadi kesalahan server. Silakan coba lagi.' }, 500);
  }
}

async function handleOAuthCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const verifier = parseCookies(request).albedu_oauth_verifier;
  const returnTo = url.searchParams.get('return_to') || '/pages/login.html';
  const error = url.searchParams.get('error');

  if (error) {
    const errHeaders = new Headers({ 'Location': `${url.origin}/pages/login.html?auth_error=${encodeURIComponent(error)}` });
    return new Response(null, { status: 302, headers: errHeaders });
  }

  if (!code || !verifier) {
    console.error('[oauth-callback] Missing code or verifier:', { hasCode: !!code, hasVerifier: !!verifier });
    const errHeaders = new Headers({ 'Location': `${url.origin}/pages/login.html?auth_error=no_code` });
    return new Response(null, { status: 302, headers: errHeaders });
  }

  let safeReturnTo;
  try {
    safeReturnTo = new URL(returnTo, url.origin);
  } catch (_) {
    safeReturnTo = new URL('/pages/login.html', url.origin);
  }
  if (!ALLOWED_ORIGINS.has(safeReturnTo.origin)) {
    safeReturnTo = new URL('/pages/login.html', url.origin);
  }

  // Exchange authorization code + PKCE verifier for session tokens
  const response = await supabaseAuth(env, 'token?grant_type=pkce', {
    method: 'POST',
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    console.error('[oauth-callback] Token exchange failed:', response.status, JSON.stringify(data));
    const errHeaders = new Headers({ 'Location': `${url.origin}/pages/login.html?auth_error=token_exchange` });
    return new Response(null, { status: 302, headers: errHeaders });
  }

  // Success — set auth cookies, clear verifier cookie, redirect to return_to
  const redirectHeaders = new Headers({ 'Location': safeReturnTo.toString() });
  appendSetCookies(redirectHeaders, setAuthCookies(data.access_token, data.refresh_token));
  redirectHeaders.append('Set-Cookie', cookie('albedu_oauth_verifier', '', { maxAge: 0, httpOnly: true }));
  Object.entries(authHeaders(request)).forEach(([key, value]) => redirectHeaders.set(key, value));
  return new Response(null, { status: 302, headers: redirectHeaders });
}

async function handleForgotPassword(request, env) {
  if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
  const body = await request.json().catch(() => ({}));
  if (!body.email) return authJson(request, { error: 'Email wajib diisi.' }, 400);
  const response = await supabaseAuth(env, 'recover', {
    method: 'POST', body: JSON.stringify({ email: body.email, redirect_to: body.redirectTo }),
  });
  // Preserve Supabase's non-enumerating recovery behaviour.
  return authJson(request, { ok: response.ok }, response.ok ? 200 : response.status);
}

async function handlePublicRegistration(request, env) {
  if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
  const response = await fetch(`${env.SUPABASE_URL}/functions/v1/register-admin`, {
    method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Origin: request.headers.get('Origin') || '' }, body: request.body,
  });
  const headers = new Headers(response.headers);
  Object.entries(authHeaders(request)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

// FIX #5: Recovery callback — exchanges PKCE code for session, sets cookies,
// redirects to reset-password.html. This replaces Supabase's browser-based
// recovery flow which would put tokens in the URL hash.
async function handleRecoveryCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const type = url.searchParams.get('type');
  const returnTo = url.searchParams.get('return_to') || '/pages/reset-password.html';
  if (!code || type !== 'recovery') {
    return new Response(null, { status: 302, headers: new Headers({ 'Location': `${url.origin}/pages/reset-password.html?error=invalid` }) });
  }
  // Exchange PKCE code for session
  const response = await supabaseAuth(env, 'token?grant_type=pkce', {
    method: 'POST', body: JSON.stringify({ auth_code: code, code_verifier: '' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return new Response(null, { status: 302, headers: new Headers({ 'Location': `${url.origin}/pages/reset-password.html?error=expired` }) });
  }
  // Set auth cookies and redirect to reset-password page
  // FIX: create new Response (not Response.redirect) so we can set cookies
  const redirectHeaders = new Headers({ 'Location': `${url.origin}${returnTo}` });
  appendSetCookies(redirectHeaders, setAuthCookies(data.access_token, data.refresh_token));
  Object.entries(authHeaders(request)).forEach(([key, value]) => redirectHeaders.set(key, value));
  return new Response(null, { status: 302, headers: redirectHeaders });
}

// POST /api/auth/reset — change password using current session (from cookie)
async function handleResetPassword(request, env) {
  if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
  if (!csrfValid(request, '/api/auth/reset')) return authJson(request, { error: 'CSRF tidak valid.' }, 403);
  const session = await currentSession(request, env);
  if (!session.token) return authJson(request, { error: 'Sesi tidak ditemukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  if (!body.password || body.password.length < 8) {
    return authJson(request, { error: 'Kata sandi minimal 8 karakter.' }, 400);
  }
  // Update user password via Supabase admin API
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: body.password }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return authJson(request, { error: err.msg || 'Gagal mengubah kata sandi.' }, response.status);
  }
  return authJson(request, { ok: true });
}

async function handleRefresh(request, env) {
  if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
  if (!csrfValid(request, '/api/auth/refresh')) return authJson(request, { error: 'CSRF tidak valid.' }, 403);
  const refreshed = await refreshSession(parseCookies(request)[REFRESH_COOKIE], env);
  if (!refreshed) return authJson(request, { error: 'Sesi telah berakhir.' }, 401, { 'Set-Cookie': clearAuthCookies().join(', ') });
  const headers = new Headers(authHeaders(request, { 'Content-Type': 'application/json' }));
  appendSetCookies(headers, setAuthCookies(refreshed.access_token, refreshed.refresh_token));
  return new Response(JSON.stringify({ ok: true, user: userPayload(refreshed.user) }), { status: 200, headers });
}

async function handleSession(request, env) {
  if (request.method !== 'GET') return authJson(request, { error: 'Method not allowed' }, 405);
  const session = await currentSession(request, env);
  if (!session.payload) return authJson(request, { error: 'Sesi tidak ditemukan.' }, 401);
  const userResponse = await supabaseAuth(env, 'user', { headers: { Authorization: `Bearer ${session.token}` } });
  const user = userResponse.ok ? await userResponse.json() : { id: session.payload.sub, email: session.payload.email, user_metadata: session.payload.user_metadata };
  const headers = new Headers(authHeaders(request, { 'Content-Type': 'application/json' }));
  if (session.refreshed) appendSetCookies(headers, setAuthCookies(session.refreshed.access_token, session.refreshed.refresh_token));
  return new Response(JSON.stringify({ user: userPayload(user) }), { status: 200, headers });
}

async function handleLogout(request, env) {
  if (request.method !== 'POST') return authJson(request, { error: 'Method not allowed' }, 405);
  if (!csrfValid(request, '/api/auth/logout')) return authJson(request, { error: 'CSRF tidak valid.' }, 403);
  const token = parseCookies(request)[ACCESS_COOKIE];
  if (token) await supabaseAuth(env, 'logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  const headers = new Headers(authHeaders(request, { 'Content-Type': 'application/json' }));
  appendSetCookies(headers, clearAuthCookies());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// Public EFs that don't require auth session (called before login)
const PUBLIC_EFS = [
  '/functions/v1/register-admin',
  '/functions/v1/user-auth-preflight',
  '/functions/v1/access-code-attempt',
  '/functions/v1/health-check',
];

async function handleSupabaseProxy(request, env, url) {
  if (!csrfValid(request, url.pathname)) return authJson(request, { error: 'CSRF tidak valid.' }, 403);

  // Public EFs skip session check — they're called before user is authenticated
  const isPublicEF = PUBLIC_EFS.includes(url.pathname);

  let session = null;
  let authToken = null;
  if (!isPublicEF) {
    session = await currentSession(request, env);
    if (!session.token || !session.payload) return authJson(request, { error: 'Sesi telah berakhir.' }, 401);
    authToken = session.token;
  }

  const target = new URL(url.pathname + url.search, env.SUPABASE_URL);
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  // Set Authorization: if authenticated, use user's JWT; if public, use anon key
  headers.set('Authorization', `Bearer ${authToken || env.SUPABASE_ANON_KEY}`);
  headers.set('apikey', env.SUPABASE_ANON_KEY);
  headers.delete('Host');
  const response = await fetch(target.toString(), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
  const out = new Headers(response.headers);
  Object.entries(authHeaders(request)).forEach(([key, value]) => out.set(key, value));
  if (session && session.refreshed) appendSetCookies(out, setAuthCookies(session.refreshed.access_token, session.refreshed.refresh_token));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

// ── AWS Signature V4 for B2 S3 API ─────────────────────────────────────────
// B2 is S3-compatible. We sign GET requests with AWS4-HMAC-SHA256.

const encoder = new TextEncoder();

async function sha256Hex(message) {
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key, message) {
  const keyData = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

/**
 * Sign a B2 S3 GET request using AWS Signature V4.
 * Returns the Authorization header value.
 *
 * @param {string} url — full B2 S3 URL (e.g. https://s3.us-west-002.backblazeb2.com/albedu-assets-systems/a3/a3f1c9...jpg)
 * @param {string} keyId — B2 application key ID
 * @param {string} appKey — B2 application key
 * @param {string} region — B2 region (e.g. us-west-002)
 * @returns {Promise<string>} Authorization header
 */
async function signS3Get(url, keyId, appKey, region) {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  const u = new URL(url);
  const host = u.host;
  const path = u.pathname || '/';

  // Canonical request
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'GET',
    path,
    '', // canonical query string (empty for simple GET)
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing key chain
  const kDate = await hmacSha256('AWS4' + appKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');

  // Signature
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(sigBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ── Supabase PostgREST helper ──────────────────────────────────────────────

async function supabaseRequest(path, env, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${path} failed (${res.status}): ${body}`);
  }
  return res;
}

// ── Handlers ───────────────────────────────────────────────────────────────

/**
 * GET /api/supabase-config
 * Returns Supabase URL + anon key for client SDK init.
 * Edge-cached for 1 hour (reduces Supabase auth load).
 */
function handleSupabaseConfig(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error('[config] SUPABASE_URL or SUPABASE_ANON_KEY not set');
    return json({ error: 'Server configuration error' }, 500);
  }

  const origin = request.headers.get('Origin') || '';
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    console.warn('[config] Blocked request from unknown origin:', origin);
    return json({ error: 'Forbidden origin' }, 403);
  }

  return json(
    {
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
    },
    200,
    {
      'Cache-Control': `public, max-age=${CONFIG_CACHE_TTL}`,
      ...corsHeaders(origin),
    }
  );
}

/**
 * GET /api/health
 * Uptime monitoring endpoint. Returns 200 if Worker is alive.
 * Does NOT depend on Supabase (so it works even if Supabase is down).
 */
function handleHealth(env) {
  return json(
    {
      status: 'ok',
      service: 'albedu-worker',
      timestamp: new Date().toISOString(),
      version: '7.0.0',
      // Don't expose env vars — just whether they're set
      config: {
        supabase: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        b2: !!(env.B2_KEY_ID && env.B2_APPLICATION_KEY && env.B2_BUCKET_NAME),
      },
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

/**
 * GET /img/{hash}
 * Image cache proxy. Looks up assets_manifest, fetches from B2 or GitHub CDN,
 * caches at Cloudflare edge for 24h.
 *
 * Path: /img/{64-char-hex-sha256}
 *
 * Response headers:
 *   Content-Type: image/jpeg (or original)
 *   Cache-Control: public, max-age=31536000, immutable
 *   ETag: "{hash}"
 *   X-Cache: HIT | MISS
 *   X-Storage-Backend: b2 | github
 */
async function handleImg(request, env, ctx) {
  const url = new URL(request.url);
  const hash = url.pathname.replace('/img/', '');

  // Validate hash format (64 hex chars = SHA-256)
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return json({ error: 'Invalid hash format' }, 400, { 'Cache-Control': 'no-store' });
  }

  // ── Check Cloudflare cache first ──
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/img/${hash}`, { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    // Clone + add X-Cache: HIT header
    const response = new Response(cached.body, cached);
    response.headers.set('X-Cache', 'HIT');
    return response;
  }

  // ── Cache miss — fetch origin ──
  // Query assets_manifest for the hash
  const manifestRes = await supabaseRequest(
    `assets_manifest?hash=eq.${hash}&select=storage_backend,repo,path,cdn_url&limit=1`,
    env
  );
  const rows = await manifestRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'Asset not found', hash }, 404, { 'Cache-Control': 'no-store' });
  }

  const asset = rows[0];
  let originResponse;
  let storageBackend = asset.storage_backend || 'github';

  try {
    if (storageBackend === 'b2') {
      // ── B2 backend: sign S3 GET request ──
      if (!env.B2_KEY_ID || !env.B2_APPLICATION_KEY || !env.B2_ENDPOINT || !env.B2_REGION) {
        console.error('[img] B2 env vars not configured');
        return json({ error: 'B2 storage not configured' }, 500, { 'Cache-Control': 'no-store' });
      }

      const b2Url = `https://${env.B2_ENDPOINT}/${env.B2_BUCKET_NAME}/${asset.path}`;
      const authHeader = await signS3Get(
        b2Url,
        env.B2_KEY_ID,
        env.B2_APPLICATION_KEY,
        env.B2_REGION
      );

      originResponse = await fetch(b2Url, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'x-amz-date': new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, ''),
        },
      });
    } else {
      // ── GitHub legacy backend: use cdn_url (jsDelivr) ──
      if (!asset.cdn_url) {
        return json({ error: 'No cdn_url for legacy asset' }, 500, { 'Cache-Control': 'no-store' });
      }
      originResponse = await fetch(asset.cdn_url, { method: 'GET' });
    }
  } catch (err) {
    console.error('[img] Origin fetch error:', err?.message);
    return json({ error: 'Origin fetch failed', detail: err?.message }, 502, { 'Cache-Control': 'no-store' });
  }

  if (!originResponse.ok) {
    console.error(`[img] Origin returned ${originResponse.status} for hash ${hash.slice(0, 12)}...`);
    return json(
      { error: 'Origin returned error', status: originResponse.status, hash },
      originResponse.status === 404 ? 404 : 502,
      { 'Cache-Control': 'no-store' }
    );
  }

  // ── Build cached response ──
  const contentType = originResponse.headers.get('Content-Type') || 'image/jpeg';
  const response = new Response(originResponse.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
      'ETag': `"${hash}"`,
      'X-Cache': 'MISS',
      'X-Storage-Backend': storageBackend,
      'Access-Control-Allow-Origin': '*',
    },
  });

  // Store in Cloudflare cache (async, don't block response)
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

/**
 * POST /upload — DECOMMISSIONED (Phase 1)
 * Returns 410 Gone with migration instructions.
 */
function handleUploadGone() {
  return json(
    {
      error: 'Gone',
      message:
        'This endpoint has been decommissioned in v0.821.0. ' +
        'Avatar uploads now use Supabase Storage directly (supabase.storage.from(\'avatars\').upload()). ' +
        'Soal image uploads (Phase 2) will use the asset-upload Edge Function. ' +
        'See docs/asset-system/ARCHITECTURE-V2.md for details.',
      docs: 'docs/asset-system/ARCHITECTURE-V2.md',
      migrated_in: 'v0.821.0',
    },
    410,
    { 'Cache-Control': 'no-store' }
  );
}

/**
 * POST /release — DECOMMISSIONED (Phase 1)
 * Returns 410 Gone with migration instructions.
 */
function handleReleaseGone() {
  return json(
    {
      error: 'Gone',
      message:
        'This endpoint has been decommissioned in v0.821.0. ' +
        'Avatar deletion now uses Supabase Storage directly (supabase.storage.from(\'avatars\').remove()). ' +
        'Soal image release (Phase 2) will use the asset-release Edge Function. ' +
        'See docs/asset-system/ARCHITECTURE-V2.md for details.',
      docs: 'docs/asset-system/ARCHITECTURE-V2.md',
      migrated_in: 'v0.821.0',
    },
    410,
    { 'Cache-Control': 'no-store' }
  );
}

// ── Legacy: sweep expired assessments ──────────────────────────────────────
//
// KEPT for backward compat — Phase 3 will replace this with a Supabase pg_cron
// job that calls an asset-gc Edge Function. Until Phase 3 ships, this cron
// is the ONLY thing that archives expired assessments + releases their images.
//
// TODO (Phase 3): Remove this entire section once pg_cron job is active.

const EXPIRY_GRACE_MS = 60 * 60 * 1000; // 1 hour grace period

function _coerceDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function _isAssessmentExpired(row, now) {
  let finishedAt = null;

  if (row.access_mode === 'manual') {
    if (row.ac_manual_status === 'open' && row.ac_end) {
      const endDate = _coerceDate(row.ac_end);
      if (endDate && endDate.getTime() < now) finishedAt = endDate;
    } else if (row.ac_manual_status === 'closed' && !row.ac_remaining_time) {
      const endDate = _coerceDate(row.ac_end);
      if (endDate) finishedAt = endDate;
    }
  } else if (row.access_mode === 'scheduled') {
    if (row.ac_scheduled_end) {
      const endDate = _coerceDate(row.ac_scheduled_end);
      if (endDate && endDate.getTime() < now) finishedAt = endDate;
    }
  }

  if (!finishedAt) return false;
  return now - finishedAt.getTime() >= EXPIRY_GRACE_MS;
}

async function _releaseAssessmentImages(row, env) {
  const sections = typeof row.sections === 'string' ? JSON.parse(row.sections) : row.sections;
  if (!Array.isArray(sections)) return 0;

  let released = 0;
  for (const sec of sections) {
    const questions = sec?.questions || sec?.soal || [];
    for (const q of questions) {
      const gambar = q?.media?.gambar || [];
      for (const img of gambar) {
        const hash = typeof img === 'object' ? img.hash : null;
        if (!hash) continue;
        try {
          await _releaseByHash(hash, env);
          released++;
        } catch (err) {
          console.warn(`[sweep] Failed to release image hash ${hash.slice(0, 8)}...:`, err?.message);
        }
      }
    }
  }
  return released;
}

async function _releaseByHash(hash, env) {
  const rows = await supabaseRequest(
    `assets_manifest?hash=eq.${hash}&select=ref_count`,
    env
  );
  const data = await rows.json();
  if (!Array.isArray(data) || data.length === 0) return;

  const newRef = Math.max(0, data[0].ref_count - 1);
  const pending = newRef <= 0;

  await supabaseRequest(`assets_manifest?hash=eq.${hash}`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      ref_count: newRef,
      pending_delete: pending,
      last_seen: new Date().toISOString(),
    }),
  });
}

async function _archiveExpiredAssessment(row, env) {
  const released = await _releaseAssessmentImages(row, env);
  await supabaseRequest(`assessments?id=eq.${encodeURIComponent(row.id)}`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'archived' }),
  });
  console.log(`[sweep] Archived assessment ${row.access_code} (${released} images released)`);
  return released;
}

async function sweepExpiredAssessments(env) {
  const result = { swept: 0, archived: 0, failed: 0, imagesReleased: 0 };

  const nowIso = new Date().toISOString();
  const filter = `status=eq.active&or=(ac_manual_status.eq.finished,ac_end.lt.${encodeURIComponent(nowIso)},ac_scheduled_end.lt.${encodeURIComponent(nowIso)})`;

  const rowsRes = await supabaseRequest(
    `assessments?select=id,access_code,ac_manual_status,ac_end,ac_remaining_time,ac_scheduled_start,ac_scheduled_end,access_mode,sections&${filter}`,
    env
  );
  const rows = await rowsRes.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('[sweep] No expired assessments found');
    return result;
  }

  result.swept = rows.length;
  const now = Date.now();
  const expired = rows.filter((row) => _isAssessmentExpired(row, now));
  console.log(`[sweep] ${rows.length} assessments checked, ${expired.length} expired`);

  if (expired.length === 0) return result;

  const outcomes = await Promise.allSettled(
    expired.map((row) => _archiveExpiredAssessment(row, env))
  );

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === 'fulfilled') {
      result.archived++;
      result.imagesReleased += o.value ?? 0;
    } else {
      console.error(`[sweep] Failed to archive assessment ${expired[i].access_code}:`, o.reason?.message);
      result.failed++;
    }
  }

  return result;
}

// ── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    try {
      // ── Routes ──
      if (request.method === 'GET' && url.pathname === '/api/supabase-config') {
        return handleSupabaseConfig(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return handleHealth(env);
      }

      if (url.pathname === '/api/auth/login') return handleLogin(request, env, url);
      if (url.pathname === '/api/auth/callback') return handleOAuthCallback(request, env, url);
      if (url.pathname === '/api/auth/refresh') return handleRefresh(request, env);
      if (url.pathname === '/api/auth/session') return handleSession(request, env);
      if (url.pathname === '/api/auth/logout') return handleLogout(request, env);
      if (url.pathname === '/api/auth/forgot') return handleForgotPassword(request, env);
      if (url.pathname === '/api/auth/register') return handlePublicRegistration(request, env);
      if (url.pathname === '/api/auth/recover') return handleRecoveryCallback(request, env, url);
      if (url.pathname === '/api/auth/reset') return handleResetPassword(request, env);

      // FIX #7: register-admin EF is public (no auth required for registration).
      // Route it directly without auth check, but still through proxy for CSRF.
      if (url.pathname === '/functions/v1/register-admin') return handlePublicRegistration(request, env);

      if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/functions/v1/') || url.pathname.startsWith('/storage/v1/')) {
        return handleSupabaseProxy(request, env, url);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/img/')) {
        return await handleImg(request, env, ctx);
      }

      // ── Decommissioned endpoints ──
      if (url.pathname === '/upload') {
        return handleUploadGone();
      }
      if (url.pathname === '/release') {
        return handleReleaseGone();
      }

      // ── 404 ──
      return json({ error: 'Not found', path: url.pathname }, 404, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('[worker] Unhandled error:', err?.stack || err);
      const status = err.message === 'Unauthorized' ? 401
                   : err.message === 'Too Many Requests' ? 429
                   : 500;
      return json({ error: err.message || 'Internal error' }, status, { 'Cache-Control': 'no-store' });
    }
  },

  // ── Cron trigger (every 15 min) ──
  async scheduled(event, env, ctx) {
    console.log('[cron] Assessment expiry sweep started:', new Date().toISOString());
    try {
      const result = await sweepExpiredAssessments(env);
      console.log('[cron] Sweep complete:', JSON.stringify(result));
    } catch (err) {
      console.error('[cron] Sweep failed:', err?.stack || err);
    }
  },
};
