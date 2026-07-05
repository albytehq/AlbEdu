/**
 * AlbEdu Asset Storage Worker  (v6.0 — v1.0.0 enterprise migration)
 *
 * CHANGES dari v5.1:
 *   - REFACTOR: sweepExpiredAssessments (was sweepExpiredExams) — query `assessments`
 *     table instead of legacy `ujian`. Uses normalized ac_* columns instead of
 *     access_control JSONB blob.
 *   - UPDATE: ALLOWED_ORIGINS — albedu-id.github.io → albytehq.github.io
 *     (owner renamed GitHub username)
 *   - UPDATE: Worker URL — https://edu.albyte-inc.workers.dev (new)
 *   - ADD: /api/health endpoint for uptime monitoring
 *   - KEEP: all v5.1 fixes (rate limit GC, parallel sweep, GitHub PUT timeout, magic bytes)
 *
 * Decision ref: docs/MIGRATION-DECISIONS.md §24-25 (GitHub rename + Worker URL)
 *
 * DEPLOY: Copy this file to Cloudflare Workers dashboard (or wrangler deploy).
 *         Set env vars: GITHUB_TOKEN, GITHUB_USERNAME=albytehq, SUPABASE_URL,
 *         SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, AUTH_TOKEN (optional)
 *         Cron trigger: every 15 minutes (was every hour)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const REPO_PREFIX    = 'assets-';
const REPO_COUNT     = 20;
const REPO_START     = 1;
const BRANCH         = 'main';
const MAX_FILE_SIZE  = 10 * 1024 * 1024;
const ALLOWED_MIMES  = new Set(['image/jpeg', 'image/png', 'image/webp']);

const EXPIRY_GRACE_MS = 60 * 60 * 1000; // 1 jam

const CONFIG_CACHE_MAX_AGE = 3600;

const RATE_LIMIT_MAX    = 20;
const RATE_LIMIT_WINDOW = 60_000;

const GITHUB_PUT_TIMEOUT_MS = 25_000;

// v1.0.0: Updated origins — albedu-id → albytehq (owner rename)
const ALLOWED_ORIGINS = new Set([
  'https://albytehq.github.io',       // NEW: albytehq (was albedu-id)
  'https://albedu-id.github.io',      // KEEP for backward compat (legacy URLs)
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
]);

const _rateLimitStore = new Map();
let _rateLimitGcCounter = 0;
const _RATE_LIMIT_GC_INTERVAL = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged from v5.1)
// ─────────────────────────────────────────────────────────────────────────────

function getExtension(filename, mime) {
  if (filename && filename.includes('.')) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext.length <= 5) return ext;
  }
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  return map[mime] || 'jpg';
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    return res;
  }
}

const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
  'image/webp': null,
};

function validateMagicBytes(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  if (mime === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (mime === 'image/png')  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (mime === 'image/webp') {
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    return riff && webp;
  }
  return false;
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (++_rateLimitGcCounter >= _RATE_LIMIT_GC_INTERVAL) {
    _rateLimitGcCounter = 0;
    for (const [key, entry] of _rateLimitStore) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW) _rateLimitStore.delete(key);
    }
  }
  const entry = _rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    _rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function corsHeaders(origin, forConfig = false) {
  const allowOrigin = (forConfig && origin && ALLOWED_ORIGINS.has(origin))
    ? origin
    : (forConfig ? 'null' : '*');
  return {
    'Access-Control-Allow-Origin':  allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function checkAuth(request, env) {
  if (!env.AUTH_TOKEN) return;
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) throw new Error('Unauthorized');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function debugCheckEnv(env) {
  const required = ['GITHUB_TOKEN', 'GITHUB_USERNAME', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
  const missing  = required.filter(k => !env[k]);
  if (missing.length) console.error('[worker] Missing env vars:', missing.join(', '));
}

function getShardRepo(hash) {
  const idx = (parseInt(hash.slice(0, 2), 16) % REPO_COUNT) + REPO_START;
  return `${REPO_PREFIX}${idx}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase REST helper
// ─────────────────────────────────────────────────────────────────────────────

async function supabaseRequest(path, env, options = {}) {
  const { method = 'GET', body, headers: extraHeaders } = options;
  const headers = {
    apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Supabase error (${res.status}): ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      const origin   = request.headers.get('Origin');
      const url      = new URL(request.url);
      const isConfig = url.pathname === '/api/supabase-config';
      return new Response(null, { status: 204, headers: corsHeaders(origin, isConfig) });
    }

    const url = new URL(request.url);
    try {
      if (request.method === 'GET'  && url.pathname === '/api/supabase-config') return handleSupabaseConfig(request, env);
      if (request.method === 'GET'  && url.pathname === '/api/health')           return handleHealth(env);
      if (request.method === 'POST' && url.pathname === '/upload')              return await handleUpload(request, env);
      if (request.method === 'POST' && url.pathname === '/release')             return await handleRelease(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      const status = err.message === 'Unauthorized'       ? 401
                   : err.message === 'Too Many Requests'  ? 429
                   : 500;
      return json({ error: err.message || 'Internal error' }, status);
    }
  },

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/supabase-config
// ─────────────────────────────────────────────────────────────────────────────

function handleSupabaseConfig(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error('[config] SUPABASE_URL atau SUPABASE_ANON_KEY tidak di-set');
    return json({ error: 'Server configuration error' }, 500);
  }

  const origin = request.headers.get('Origin') || '';

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    console.warn('[config] Blocked request from unknown origin:', origin);
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, true) },
    });
  }

  return new Response(
    JSON.stringify({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY }),
    {
      status: 200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': `public, max-age=${CONFIG_CACHE_MAX_AGE}`,
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders(origin, true),
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health — NEW v6.0 — uptime monitoring endpoint
// ─────────────────────────────────────────────────────────────────────────────

function handleHealth(env) {
  return json({
    status: 'ok',
    version: '6.0.0',
    timestamp: new Date().toISOString(),
    supabase_configured: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
    github_configured: !!(env.GITHUB_TOKEN && env.GITHUB_USERNAME),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /upload (unchanged from v5.1)
// ─────────────────────────────────────────────────────────────────────────────

async function handleUpload(request, env) {
  try {
    return await _handleUploadInner(request, env);
  } catch (err) {
    console.error('[handleUpload] Unhandled exception:', err?.message);
    return json({ error: String(err), message: err?.message ?? 'unknown' }, 500);
  }
}

async function _handleUploadInner(request, env) {
  debugCheckEnv(env);
  checkAuth(request, env);

  const ip = request.headers.get('CF-Connecting-IP')
          || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
          || 'unknown';

  if (!checkRateLimit(ip)) {
    return json({ error: 'Too many upload requests. Try again in a minute.' }, 429, {
      'Retry-After': '60',
    });
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  let formData;
  try { formData = await request.formData(); }
  catch (err) { return json({ error: 'Invalid form data' }, 400); }

  const file = formData.get('file');
  if (!file || typeof file === 'string') return json({ error: 'No file uploaded' }, 400);

  if (!ALLOWED_MIMES.has(file.type)) {
    return json({ error: 'Only JPEG, PNG, WebP images are allowed' }, 400);
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_FILE_SIZE) {
    return json({ error: 'File too large (max 10 MB)' }, 413);
  }

  if (!validateMagicBytes(buffer, file.type)) {
    console.warn('[upload] Magic bytes mismatch — possible MIME spoof, IP:', ip);
    return json({ error: 'File content does not match declared type' }, 400);
  }

  const hash = await sha256Hex(buffer);

  const existing = await supabaseRequest(
    `assets_manifest?hash=eq.${hash}&select=cdn_url,repo,path`, env);
  if (existing?.length > 0) {
    return json({ hash, cdn_url: existing[0].cdn_url, repo: existing[0].repo, path: existing[0].path }, 200);
  }

  const repo   = getShardRepo(hash);
  const ext    = getExtension(file.name, file.type);
  const folder = hash.slice(0, 2);
  const path   = `${folder}/${hash}.${ext}`;
  const base64 = arrayBufferToBase64(buffer);

  const githubUrl = `https://api.github.com/repos/${env.GITHUB_USERNAME}/${repo}/contents/${path}`;

  // Check if file already exists — if so, get its SHA for update
  let existingSha = null;
  try {
    const checkRes = await fetchWithRetry(githubUrl, {
      method: 'GET',
      headers: {
        Authorization:  `token ${env.GITHUB_TOKEN}`,
        Accept:         'application/vnd.github.v3+json',
        'User-Agent':   'AlbEdu-Worker/6.0',
      },
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      existingSha = existing?.sha || null;
    }
  } catch (e) {
    // 404 = file doesn't exist yet, that's OK
  }

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), GITHUB_PUT_TIMEOUT_MS);

  let githubRes;
  try {
    const bodyObj = {
      message: `upload ${hash.slice(0, 8)}.${ext}`,
      content: base64,
      branch: BRANCH,
    };
    // If file exists, include SHA for update (otherwise GitHub returns 422)
    if (existingSha) {
      bodyObj.sha = existingSha;
    }

    githubRes = await fetchWithRetry(githubUrl, {
      method: 'PUT',
      signal: controller.signal,
      headers: {
        Authorization:  `token ${env.GITHUB_TOKEN}`,
        Accept:         'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent':   'AlbEdu-Worker/6.0',
      },
      body: JSON.stringify(bodyObj),
    });
  } finally {
    clearTimeout(abortTimer);
  }

  if (!githubRes.ok) {
    const err = await githubRes.text().catch(() => '');
    throw new Error(`GitHub upload failed (${githubRes.status}): ${err}`);
  }

  const cdnUrl = `https://cdn.jsdelivr.net/gh/${env.GITHUB_USERNAME}/${repo}@${BRANCH}/${path}`;
  const now    = new Date().toISOString();

  const expectedPrefix = `https://cdn.jsdelivr.net/gh/${env.GITHUB_USERNAME}/`;
  if (!cdnUrl.startsWith(expectedPrefix)) {
    throw new Error('CDN URL validation failed — possible config tampering');
  }

  await supabaseRequest('assets_manifest', env, {
    method: 'POST',
    body:   [{ hash, repo, path, cdn_url: cdnUrl, ref_count: 1, pending_delete: false, created_at: now, last_seen: now }],
    headers: { Prefer: 'return=minimal' },
  });

  return json({ hash, cdn_url: cdnUrl, repo, path }, 201,
    { 'Cache-Control': 'public, max-age=31536000, immutable' });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /release (unchanged from v5.1)
// ─────────────────────────────────────────────────────────────────────────────

async function handleRelease(request, env) {
  try {
    return await _handleReleaseInner(request, env);
  } catch (err) {
    console.error('[handleRelease] Unhandled exception:', err?.message);
    return json({ error: err?.message ?? 'unknown' }, 500);
  }
}

async function _handleReleaseInner(request, env) {
  checkAuth(request, env);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { hash } = body;
  if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    return json({ error: 'Missing or invalid hash (expected 64-char hex SHA-256)' }, 400);
  }

  return await _releaseByHash(hash, env);
}

async function _releaseByHash(hash, env) {
  const rows = await supabaseRequest(
    `assets_manifest?hash=eq.${hash}&select=ref_count`, env);
  if (!rows?.length) return json({ error: 'Hash not found' }, 404);

  const newRef  = rows[0].ref_count - 1;
  const pending = newRef <= 0;

  await supabaseRequest(`assets_manifest?hash=eq.${hash}`, env, {
    method: 'PATCH',
    body:   { ref_count: newRef, pending_delete: pending, last_seen: new Date().toISOString() },
  });

  return json({ success: true, ref_count: newRef, pending_delete: pending });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron: sweep expired assessments (v6.0 — REFACTORED for assessments table)
// ─────────────────────────────────────────────────────────────────────────────

async function sweepExpiredAssessments(env) {
  const result = { swept: 0, deleted: 0, failed: 0, imagesReleased: 0 };

  // v6.0: Query assessments table with normalized columns
  const rows = await supabaseRequest(
    'assessments?select=id,access_code,ac_manual_status,ac_end,ac_remaining_time,ac_scheduled_start,ac_scheduled_end,access_mode,sections&status=eq.active',
    env
  );

  if (!rows?.length) {
    console.log('[sweep] No active assessments found');
    return result;
  }

  result.swept = rows.length;
  const now    = Date.now();

  const expired = rows.filter(row => _isAssessmentExpired(row, now));
  console.log(`[sweep] ${rows.length} assessments checked, ${expired.length} expired`);

  if (!expired.length) return result;

  const outcomes = await Promise.allSettled(
    expired.map(row => _deleteExpiredAssessment(row, env))
  );

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === 'fulfilled') {
      result.deleted++;
      result.imagesReleased += o.value ?? 0;
    } else {
      console.error(`[sweep] Failed to delete assessment ${expired[i].access_code}:`, o.reason?.message);
      result.failed++;
    }
  }

  return result;
}

async function _deleteExpiredAssessment(row, env) {
  const released = await _releaseAssessmentImages(row, env);
  await supabaseRequest(`assessments?id=eq.${encodeURIComponent(row.id)}`, env, {
    method: 'DELETE',
  });
  console.log(`[sweep] Deleted assessment ${row.access_code} (${released} images released)`);
  return released;
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
  return (now - finishedAt.getTime()) >= EXPIRY_GRACE_MS;
}

async function _releaseAssessmentImages(row, env) {
  const sections = Array.isArray(row.sections) ? row.sections : [];
  const hashes   = [];

  for (const section of sections) {
    const questions = Array.isArray(section?.questions) ? section.questions : [];
    for (const q of questions) {
      const gambar = Array.isArray(q?.media?.gambar) ? q.media.gambar : [];
      for (const img of gambar) {
        if (img && typeof img === 'object' && img.hash) {
          hashes.push(img.hash);
        }
      }
    }
  }

  if (!hashes.length) return 0;

  let released = 0;
  for (const hash of hashes) {
    try {
      await _releaseByHash(hash, env);
      released++;
    } catch (err) {
      console.warn(`[sweep] Failed to release image hash ${hash.slice(0, 8)}...:`, err?.message);
    }
  }

  return released;
}

function _coerceDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'string') { const d = new Date(val); return isNaN(d) ? null : d; }
  if (typeof val === 'object') {
    if (typeof val.toDate   === 'function') return val.toDate();
    if (typeof val.seconds  === 'number')   return new Date(val.seconds * 1000);
  }
  return null;
}
