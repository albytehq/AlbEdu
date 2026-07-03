// =============================================================================
// access-code-attempt/index.ts — Rate limit + Turnstile for access code entry
// =============================================================================
// POST /functions/v1/access-code-attempt
// Body: { device_id?: string, turnstile_token?: string }
//
// Replaces: exam-token-attempt (v0.2.0)
// Changes:
//   - Added Turnstile verification (§4.5: 6-digit code + Turnstile)
//   - Rate limit unchanged: 10/IP/hour, 10/device/hour
//   - Records to registration_attempts table
// =============================================================================

import { handler } from '../_shared/cors.ts';
import { successResponse } from '../_shared/error.ts';
import { HTTPError } from '../_shared/error.ts';
import { verifyTurnstile } from '../_shared/turnstile.ts';
import { getClientIP } from '../_shared/audit.ts';
import { SupabaseDB } from '../_shared/db.ts';
import type { Env } from '../_shared/types.ts';

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface AttemptBody {
  device_id?: string;
  turnstile_token?: string;
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  let body: AttemptBody;
  try { body = await req.json(); }
  catch { body = {}; }

  const ip = getClientIP(req);
  const deviceId = body.device_id || 'unknown';

  // 1. Verify Turnstile — HARDENED: token is REQUIRED in production.
  // The previous behavior (skip if missing) allowed attackers to bypass
  // Turnstile entirely by simply omitting the field.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!body.turnstile_token) {
      throw new HTTPError(400, 'TURNSTILE_REQUIRED', 'Anti-abuse verification required');
    }
    await verifyTurnstile(env, body.turnstile_token, ip);
  } else if (env.SUPABASE_URL?.includes('supabase.co')) {
    // Production without configured secret — fail closed (also enforced in turnstile.ts)
    throw new HTTPError(500, 'TURNSTILE_NOT_CONFIGURED', 'Anti-abuse protection not configured');
  }

  const db = new SupabaseDB(env);

  // 2. Count IP attempts in last hour
  const ipCountRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/registration_attempts?ip_address=eq.exam_ip:${ip}&fingerprint=eq.exam_token_attempt&created_at=gte.${new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()}&select=id&limit=${RATE_LIMIT_MAX + 1}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const ipAttempts = ipCountRes.ok ? await ipCountRes.json() : [];

  if (ipAttempts.length >= RATE_LIMIT_MAX) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many attempts from this IP. Try again later.', {
      scope: 'ip',
      attempts: ipAttempts.length,
      max_attempts: RATE_LIMIT_MAX,
      retry_after_seconds: 3600,
    });
  }

  // 3. Count device attempts in last hour
  if (deviceId !== 'unknown') {
    const deviceCountRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/registration_attempts?device_id=eq.${encodeURIComponent(deviceId)}&fingerprint=eq.exam_token_attempt&created_at=gte.${new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()}&select=id&limit=${RATE_LIMIT_MAX + 1}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const deviceAttempts = deviceCountRes.ok ? await deviceCountRes.json() : [];

    if (deviceAttempts.length >= RATE_LIMIT_MAX) {
      throw new HTTPError(429, 'RATE_LIMITED', 'Too many attempts from this device. Try again later.', {
        scope: 'device',
        attempts: deviceAttempts.length,
        max_attempts: RATE_LIMIT_MAX,
        retry_after_seconds: 3600,
      });
    }
  }

  // 4. Insert attempt record (non-fatal if fails)
  try {
    await db.insert('registration_attempts', {
      ip_address: `exam_ip:${ip}`,
      fingerprint: 'exam_token_attempt',
      device_id: deviceId,
      user_agent: req.headers.get('User-Agent') || null,
    });
  } catch (err) {
    console.warn('[access-code-attempt] Failed to log attempt (non-fatal):', err);
  }

  return successResponse({
    allowed: true,
    attempts_remaining: RATE_LIMIT_MAX - ipAttempts.length,
    max_attempts: RATE_LIMIT_MAX,
    window_seconds: 3600,
  });
});
