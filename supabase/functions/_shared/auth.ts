// =============================================================================
// _shared/auth.ts — JWT verification + role + ownership checks
// =============================================================================
// Uses Supabase Auth getUser endpoint to verify JWT.
// Extracts user_id + email. Role fetched from users table (via service role).
// =============================================================================

import { HTTPError } from './error.ts';
import type { AuthUser, Env } from './types.ts';

// Cache user role lookups for 60s (reduces DB hits on rapid heartbeats)
const _roleCache = new Map<string, { role: string; expires: number }>();
const ROLE_CACHE_TTL_MS = 60_000;

export async function verifyAuth(req: Request, env: Env): Promise<AuthUser> {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new HTTPError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
  }
  const token = auth.slice(7); // 'Bearer '.length === 7
  if (!token || token.length < 10) {
    throw new HTTPError(401, 'UNAUTHORIZED', 'Invalid token format');
  }

  // Verify JWT via Supabase auth endpoint
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HTTPError(401, 'UNAUTHORIZED', 'Invalid or expired session');
    }
    throw new HTTPError(500, 'INTERNAL_ERROR', 'Auth service unavailable');
  }

  const user = await res.json();
  if (!user?.id) {
    throw new HTTPError(401, 'UNAUTHORIZED', 'Invalid user object from auth');
  }

  return {
    id: user.id,
    email: user.email || '',
  };
}

export async function getUserRole(env: Env, userId: string): Promise<'admin' | 'peserta' | null> {
  // Check cache
  const cached = _roleCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.role as 'admin' | 'peserta' | null;
  }

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=peran,deleted_at`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    console.error('[auth] getUserRole DB error:', res.status);
    return null;
  }

  const rows = await res.json();
  if (!rows?.length) return null;

  const user = rows[0];
  if (user.deleted_at) return null; // soft-deleted

  const role = user.peran as 'admin' | 'peserta' | null;

  // Cache
  _roleCache.set(userId, { role: role || 'null', expires: Date.now() + ROLE_CACHE_TTL_MS });

  return role;
}

export async function requireAdmin(req: Request, env: Env): Promise<AuthUser> {
  const user = await verifyAuth(req, env);
  const role = await getUserRole(env, user.id);
  if (role !== 'admin') {
    throw new HTTPError(403, 'FORBIDDEN', 'Admin access required');
  }
  user.role = 'admin';
  return user;
}

export async function requirePeserta(req: Request, env: Env): Promise<AuthUser> {
  const user = await verifyAuth(req, env);
  const role = await getUserRole(env, user.id);
  if (role !== 'peserta') {
    throw new HTTPError(403, 'FORBIDDEN', 'Peserta access required');
  }
  user.role = 'peserta';
  return user;
}

export async function requireAnyRole(req: Request, env: Env): Promise<AuthUser> {
  const user = await verifyAuth(req, env);
  const role = await getUserRole(env, user.id);
  if (!role) {
    throw new HTTPError(403, 'FORBIDDEN', 'Account not found or deleted');
  }
  user.role = role;
  return user;
}

// Verify admin owns the assessment (Q2: collaborative — admin can READ all, but EDIT/DELETE only own)
export async function verifyAssessmentOwnership(
  env: Env,
  assessmentId: string,
  adminId: string
): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/assessments?id=eq.${assessmentId}&select=created_by`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    throw new HTTPError(500, 'INTERNAL_ERROR', 'Failed to verify assessment ownership');
  }

  const rows = await res.json();
  if (!rows?.length) {
    throw new HTTPError(404, 'NOT_FOUND', 'Assessment not found');
  }

  if (rows[0].created_by !== adminId) {
    throw new HTTPError(403, 'FORBIDDEN', 'You do not own this assessment');
  }
}
