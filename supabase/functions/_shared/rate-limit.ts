// =============================================================================
// _shared/rate-limit.ts — In-memory rate limiter (per Edge Function isolate)
// =============================================================================
// NOTE: In-memory = per-isolate. Multiple isolates may have separate counters.
// For accurate rate limiting across isolates, use DB-based counting (see
// registration_attempts table pattern in register-admin).
//
// This is suitable for soft rate limits (heartbeat) where slight overage is OK.
// For hard rate limits (auth, token entry), use DB-based counting.
// =============================================================================

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

  // Periodic GC — clean expired entries
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

// Heartbeat: 4 req/min per session (15s interval = 4/min)
export function checkHeartbeatRate(sessionId: string) {
  return checkRateLimit(`hb:${sessionId}`, 4, 60_000);
}

// Submit: 1 req/min per session (idempotency + anti-spam)
export function checkSubmitRate(sessionId: string) {
  return checkRateLimit(`submit:${sessionId}`, 2, 60_000);  // allow 1 retry
}

// Block: 10 req/min per admin (bulk block UI)
export function checkBlockRate(adminId: string) {
  return checkRateLimit(`block:${adminId}`, 10, 60_000);
}

// Lifecycle: 10 req/min per admin per assessment
export function checkLifecycleRate(adminId: string, assessmentId: string) {
  return checkRateLimit(`life:${adminId}:${assessmentId}`, 10, 60_000);
}

// Data export: 3 req/hour per user (heavy operation)
export function checkExportRate(userId: string) {
  return checkRateLimit(`export:${userId}`, 3, 3_600_000);
}

// DSR: 5 req/hour per user
export function checkDSRRate(userId: string) {
  return checkRateLimit(`dsr:${userId}`, 5, 3_600_000);
}
