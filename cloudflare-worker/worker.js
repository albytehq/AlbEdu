// ============================================================================
// AlbEdu Cloudflare Worker — Edge Cache + Config + Health
// ============================================================================
//
// ARCHITECTURE (v0.820.0+):
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
//   • TTL: 24h (Cache-Control: public, max-age=86400)
//   • ETag: hash (enables 304 Not Modified)
//
// BANDWIDTH ALLIANCE:
//   • B2 egress to Cloudflare = $0 (automatic — no setup needed)
//   • See docs/asset-system/BACKBLAZE-SETUP.md Step 5
// ============================================================================

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 86400; // 24 hours
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
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
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
 *   Cache-Control: public, max-age=86400
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
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
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
        'This endpoint has been decommissioned in v0.819.0. ' +
        'Avatar uploads now use Supabase Storage directly (supabase.storage.from(\'avatars\').upload()). ' +
        'Soal image uploads (Phase 2) will use the asset-upload Edge Function. ' +
        'See docs/asset-system/ARCHITECTURE-V2.md for details.',
      docs: 'docs/asset-system/ARCHITECTURE-V2.md',
      migrated_in: 'v0.819.0',
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
        'This endpoint has been decommissioned in v0.819.0. ' +
        'Avatar deletion now uses Supabase Storage directly (supabase.storage.from(\'avatars\').remove()). ' +
        'Soal image release (Phase 2) will use the asset-release Edge Function. ' +
        'See docs/asset-system/ARCHITECTURE-V2.md for details.',
      docs: 'docs/asset-system/ARCHITECTURE-V2.md',
      migrated_in: 'v0.819.0',
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
