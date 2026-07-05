// =============================================================================
// _shared/cors.ts — CORS handler with origin whitelist
// =============================================================================
// AlbEdu v1.0.0: albedu-id → albytehq (owner rename)
//
// v1.1.0 FIX: this used to hardcode a 6-origin whitelist baked into the
// source (github.io + a handful of localhost ports). Every other Edge
// Function in this project (user-auth-complete, register-admin,
// user-auth-preflight) reads its allowed origins from the ALLOWED_ORIGINS
// env var instead — this module was the odd one out. Any deployment whose
// real origin (production domain, a different dev port, a preview URL)
// wasn't in the hardcoded list would get silently CORS-blocked here, with
// no visible error beyond a generic "failed to fetch" in the browser.
//
// Fix: read ALLOWED_ORIGINS from the environment, same as the other
// functions, with the old hardcoded list kept ONLY as a fallback for
// deployments that haven't set the env var yet.
// Set it in Supabase: Project Settings → Edge Functions → Secrets:
//   ALLOWED_ORIGINS=https://your-domain.com,http://localhost:5500,...

import { handleError } from './error.ts';

const FALLBACK_ORIGINS = new Set([
  'https://albytehq.github.io',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
]);

const ENV_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (ENV_ORIGINS.length === 0) {
  console.warn(
    '[cors] ALLOWED_ORIGINS env var is not set — falling back to the ' +
    'hardcoded default list. Set ALLOWED_ORIGINS in your Edge Function ' +
    'secrets to your real domain(s) or every request from an origin not ' +
    'in the fallback list will be silently CORS-blocked.'
  );
}

const ALLOWED_ORIGINS = ENV_ORIGINS.length > 0 ? new Set(ENV_ORIGINS) : FALLBACK_ORIGINS;

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client, x-client-info, apikey',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function handleOptions(req: Request): Response {
  const origin = req.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Helper: wrap an async handler with CORS + error handling
export function handler(
  fn: (req: Request, env: any, ctx: any) => Promise<Response>
): (req: Request, env: any, ctx: any) => Promise<Response> {
  return async (req: Request, env: any, ctx: any) => {
    const origin = req.headers.get('Origin');

    if (req.method === 'OPTIONS') {
      return handleOptions(req);
    }

    try {
      const res = await fn(req, env, ctx);
      return withCors(res, origin);
    } catch (err: any) {
      // handleError imported at top of file (ES module, not require)
      const errorRes = handleError(err);
      return withCors(errorRes, origin);
    }
  };
}
