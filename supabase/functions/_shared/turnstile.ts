// =============================================================================
// _shared/turnstile.ts — Cloudflare Turnstile verification
// =============================================================================
// If TURNSTILE_SECRET_KEY env is not set, verification is SKIPPED (dev mode).
// In production, set the secret key via Supabase Dashboard → Edge Functions → Secrets.
// =============================================================================

import { HTTPError } from './error.ts';
import type { Env } from './types.ts';

export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteIP?: string
): Promise<void> {
  // Dev mode: skip if no secret key
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification (dev mode)');
    return;
  }

  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new HTTPError(400, 'TURNSTILE_FAILED', 'Turnstile token missing or invalid');
  }

  const body = new URLSearchParams();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (remoteIP) body.append('remoteip', remoteIP);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      console.error('[turnstile] Cloudflare API error:', res.status);
      throw new HTTPError(500, 'INTERNAL_ERROR', 'Turnstile verification service unavailable');
    }

    const data = await res.json();
    if (!data.success) {
      console.warn('[turnstile] Verification failed:', data['error-codes']);
      throw new HTTPError(400, 'TURNSTILE_FAILED', 'Turnstile verification failed');
    }
  } catch (err) {
    if (err instanceof HTTPError) throw err;
    console.error('[turnstile] Network error:', err);
    // Fail open on network error (don't block legitimate users)
    // But fail closed if explicitly invalid token
    throw new HTTPError(500, 'INTERNAL_ERROR', 'Turnstile verification network error');
  }
}
