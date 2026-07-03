// =============================================================================
// _shared/turnstile.ts — Cloudflare Turnstile verification (hardened)
// =============================================================================
// If TURNSTILE_SECRET_KEY env is not set, verification is SKIPPED (dev mode).
// In production, set the secret key via Supabase Dashboard → Edge Functions → Secrets.
//
// HARDENING (Phase 4):
//   - Network errors during siteverify now FAIL CLOSED in production
//     (env.TURNSTILE_SECRET_KEY is set). The previous "fail open on network
//     error" behavior allowed an attacker to bypass Turnstile by simply
//     dropping the network connection.
//   - Token validation enforces sane length bounds (10–2048 chars) to
//     reject obvious garbage before hitting Cloudflare.
//   - Verification timeout (5s) prevents hanging on a stalled Cloudflare
//     response — better to fail closed than to hang.
//   - Error messages do NOT leak Cloudflare error codes to the client.
//     They are logged server-side only.
// =============================================================================

import { HTTPError } from './error.ts';
import type { Env } from './types.ts';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;
const MIN_TOKEN_LEN = 10;
const MAX_TOKEN_LEN = 2048;

export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteIP?: string
): Promise<void> {
  // Dev mode: skip if no secret key. In production, the secret MUST be set.
  // If a production function reaches this branch without a secret, that is
  // a deployment error — we fail closed to avoid silent bypass.
  if (!env.TURNSTILE_SECRET_KEY) {
    // Heuristic: if SUPABASE_URL is set (production), fail closed.
    // If only dev env vars are present, allow skip.
    if (env.SUPABASE_URL && env.SUPABASE_URL.includes('supabase.co')) {
      console.error('[turnstile] PRODUCTION env detected but TURNSTILE_SECRET_KEY missing — failing closed');
      throw new HTTPError(500, 'TURNSTILE_NOT_CONFIGURED', 'Anti-abuse protection not configured');
    }
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification (dev mode)');
    return;
  }

  if (!token || typeof token !== 'string' || token.length < MIN_TOKEN_LEN) {
    throw new HTTPError(400, 'TURNSTILE_FAILED', 'Anti-abuse verification required');
  }
  if (token.length > MAX_TOKEN_LEN) {
    throw new HTTPError(400, 'TURNSTILE_FAILED', 'Anti-abuse token invalid');
  }

  const body = new URLSearchParams();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (remoteIP) body.append('remoteip', remoteIP);

  // Race the fetch against a timeout — if Cloudflare is slow/unreachable,
  // fail closed instead of hanging the request.
  let res: Response;
  try {
    res = await Promise.race([
      fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('turnstile_timeout')), TURNSTILE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // Fail CLOSED — do not allow bypass by network failure
    console.error('[turnstile] network/timeout error — failing closed:', err);
    throw new HTTPError(503, 'TURNSTILE_UNAVAILABLE', 'Anti-abuse verification unavailable. Please retry.');
  }

  if (!res.ok) {
    console.error('[turnstile] Cloudflare API error:', res.status);
    throw new HTTPError(503, 'TURNSTILE_UNAVAILABLE', 'Anti-abuse verification unavailable. Please retry.');
  }

  const data = await res.json();
  if (!data.success) {
    // Log error codes server-side for debugging. Do NOT send to client.
    console.warn('[turnstile] verification failed:', data['error-codes']);
    throw new HTTPError(400, 'TURNSTILE_FAILED', 'Anti-abuse verification failed. Please retry.');
  }
}
