// _shared/audit.ts — Fire-and-forget audit logging helper.
// log_audit() is SECURITY DEFINER and bypasses RLS; failures are swallowed
// so they cannot affect the main request flow.

import type { Env } from './types.ts';

interface AuditParams {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, any>;
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function logAudit(env: Env, params: AuditParams): void {
  const body = {
    p_action: params.action,
    p_target_type: params.targetType ?? null,
    p_target_id: params.targetId ?? null,
    p_metadata: params.metadata ?? {},
    p_actor_id: params.actorId ?? null,
    p_actor_email: params.actorEmail ?? null,
    p_actor_role: params.actorRole ?? null,
    p_ip_address: params.ipAddress ?? null,
    p_user_agent: params.userAgent ?? null,
  };

  fetch(`${env.SUPABASE_URL}/rest/v1/rpc/log_audit`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.error('[audit] logAudit failed:', err?.message || err);
  });
}

export function getClientIP(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export function getUserAgent(req: Request): string {
  return req.headers.get('User-Agent') || 'unknown';
}
