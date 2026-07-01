// =============================================================================
// _shared/audit.ts — Audit logging helper (non-blocking, fire-and-forget)
// =============================================================================
// All state-changing Edge Function operations MUST log to audit_logs.
// Uses log_audit() RPC function (SECURITY DEFINER, bypasses RLS).
// Non-blocking: failures don't affect main request flow.
// =============================================================================

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
  // Fire-and-forget — don't await, don't throw
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
    // Non-blocking: log error but don't fail request
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
