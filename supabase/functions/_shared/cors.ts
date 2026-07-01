// =============================================================================
// _shared/cors.ts — CORS handler with origin whitelist
// =============================================================================
// AlbEdu v1.0.0: albedu-id → albytehq (owner rename)
// Legacy origin kept for backward compat (old bookmarks, cached URLs)

import { handleError } from './error.ts';

const ALLOWED_ORIGINS = new Set([
  'https://albytehq.github.io',
  'https://albytehq.github.io',       // legacy backward compat
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
