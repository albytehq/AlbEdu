// access-code-attempt/index.ts — Rate limit + anti-bot gate for access code entry.
// POST /functions/v1/access-code-attempt
// Body: { device_id?, fingerprint_hash?, form_open_ms? }
// Turnstile is intentionally not used here; the gate is a tight rate limit
// (5/IP/hour, 5/device/hour) + exponential backoff + client-side honeypot/
// timing checks (see assessment-entry.js) + a device fingerprint hash.

import { handler } from '../_shared/cors.ts';
import { successResponse } from '../_shared/error.ts';
import { HTTPError } from '../_shared/error.ts';
import { getClientIP } from '../_shared/audit.ts';
import { SupabaseDB } from '../_shared/db.ts';
import type { Env } from '../_shared/types.ts';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Exponential backoff: after N attempts, the next attempt must wait this many
// seconds. Curve: 0 / 5 / 30 / 300 / 3600.
const BACKOFF_SECONDS = [0, 5, 30, 300, 3600];

interface AttemptBody {
  device_id?: string;
  fingerprint_hash?: string;
  form_open_ms?: number;
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  let body: AttemptBody;
  try { body = await req.json(); }
  catch { body = {}; }

  const ip = getClientIP(req);
  const deviceId = body.device_id || 'unknown';
  const fingerprintHash = body.fingerprint_hash || 'unknown';
  const formOpenMs = body.form_open_ms || 0;

  // Server-side timing check: reject if the form was open < 1000ms (bot speed).
  if (formOpenMs > 0 && formOpenMs < 1000) {
    throw new HTTPError(429, 'TOO_FAST', 'Request too fast. Try again.', {
      retry_after: 5,
    });
  }

  const db = new SupabaseDB(env);

  // Count IP attempts in the last hour.
  const ipCountRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/registration_attempts?ip_address=eq.exam_ip:${ip}&fingerprint=eq.exam_token_attempt&created_at=gte.${new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()}&select=id,created_at&limit=${RATE_LIMIT_MAX + 1}&order=created_at.desc`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const ipAttempts = ipCountRes.ok ? await ipCountRes.json() : [];

  // Apply rate limit + exponential backoff.
  if (ipAttempts.length >= RATE_LIMIT_MAX) {
    // Hard-block this IP for the rest of the hour.
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many attempts from this IP. Try again later.', {
      scope: 'ip',
      attempts: ipAttempts.length,
      max_attempts: RATE_LIMIT_MAX,
      retry_after: 3600,
    });
  }

  // Exponential backoff: check time since last attempt.
  if (ipAttempts.length > 0 && ipAttempts.length <= BACKOFF_SECONDS.length) {
    const lastAttempt = new Date(ipAttempts[0].created_at);
    const secondsSinceLast = (Date.now() - lastAttempt.getTime()) / 1000;
    const requiredWait = BACKOFF_SECONDS[ipAttempts.length - 1];

    if (secondsSinceLast < requiredWait) {
      const retryAfter = Math.ceil(requiredWait - secondsSinceLast);
      throw new HTTPError(429, 'BACKOFF', `Please wait ${retryAfter} seconds before trying again.`, {
        retry_after: retryAfter,
        scope: 'backoff',
        attempt_number: ipAttempts.length,
      });
    }
  }

  // Count device attempts in the last hour.
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
        retry_after: 3600,
      });
    }
  }

  // Insert the attempt record (non-fatal if the insert fails).
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
