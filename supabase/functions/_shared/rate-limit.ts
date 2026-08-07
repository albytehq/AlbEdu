// _shared/rate-limit.ts — In-memory rate limiter (per Edge Function isolate).
// Per-isolate counters are fine for soft limits (heartbeat) where slight
// overage is acceptable. For hard limits (auth, token entry) pair with the
// DB-based counters — see checkHeartbeatRateDB / checkSubmitRateDB below
// and the registration_attempts table used by register-admin.

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const _store = new Map<string, RateLimitEntry>();
let _gcCounter = 0;
const GC_INTERVAL = 100;

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();

  // Periodic GC: clean expired entries.
  if (++_gcCounter >= GC_INTERVAL) {
    _gcCounter = 0;
    for (const [k, entry] of _store) {
      if (now - entry.windowStart > windowMs) _store.delete(k);
    }
  }

  const entry = _store.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    _store.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.windowStart + windowMs };
}

// Heartbeat: 4 req/min per session (matches the 15s client interval).
// Soft limit (in-memory) + hard limit (DB) so cross-isolate bypass can't slip through.
export function checkHeartbeatRate(sessionId: string) {
  return checkRateLimit(`hb:${sessionId}`, 4, 60_000);
}

export async function checkHeartbeatRateDB(env: Env, sessionId: string) {
  const windowMs = 60_000;
  const maxRequests = 4;
  const since = new Date(Date.now() - windowMs).toISOString();

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rate_limit_heartbeats?session_id=eq.${sessionId}&created_at=gte.${since}&select=id&limit=${maxRequests + 1}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const rows = res.ok ? await res.json() : [];
  if (rows.length >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: Date.now() + windowMs };
  }

  // Insert attempt record (non-fatal if it fails).
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rate_limit_heartbeats`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch (_) { /* non-fatal */ }

  return { allowed: true, remaining: maxRequests - rows.length - 1, resetAt: Date.now() + windowMs };
}

// Submit: 1 req/min per session (idempotency + anti-spam).
export function checkSubmitRate(sessionId: string) {
  return checkRateLimit(`submit:${sessionId}`, 2, 60_000);  // allow 1 retry
}

export async function checkSubmitRateDB(env: Env, sessionId: string) {
  const windowMs = 60_000;
  const maxRequests = 2;
  const since = new Date(Date.now() - windowMs).toISOString();

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rate_limit_submits?session_id=eq.${sessionId}&created_at=gte.${since}&select=id&limit=${maxRequests + 1}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const rows = res.ok ? await res.json() : [];
  if (rows.length >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: Date.now() + windowMs };
  }

  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rate_limit_submits`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch (_) { /* non-fatal */ }

  return { allowed: true, remaining: maxRequests - rows.length - 1, resetAt: Date.now() + windowMs };
}

// Block: 10 req/min per admin (bulk block UI).
export function checkBlockRate(adminId: string) {
  return checkRateLimit(`block:${adminId}`, 10, 60_000);
}

// Lifecycle: 10 req/min per admin per assessment.
export function checkLifecycleRate(adminId: string, assessmentId: string) {
  return checkRateLimit(`life:${adminId}:${assessmentId}`, 10, 60_000);
}

// Data export: 3 req/hour per user (heavy operation).
export function checkExportRate(userId: string) {
  return checkRateLimit(`export:${userId}`, 3, 3_600_000);
}

// DSR: 5 req/hour per user.
export function checkDSRRate(userId: string) {
  return checkRateLimit(`dsr:${userId}`, 5, 3_600_000);
}
