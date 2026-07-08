// dsr-handler/index.ts — Data Subject Request handler (UU PDP).
// POST /functions/v1/dsr-handler
// Headers: Authorization: Bearer <token>
// Body: { request_type: 'access'|'correct'|'delete'|'portability', details?: object }

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAnyRole } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkDSRRate } from '../_shared/rate-limit.ts';
import type { Env } from '../_shared/types.ts';

const VALID_TYPES = new Set(['access', 'correct', 'delete', 'portability']);

interface DSRBody {
  request_type?: string;
  details?: Record<string, any>;
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const user = await requireAnyRole(req, env);

  let body: DSRBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.request_type || !VALID_TYPES.has(body.request_type)) {
    throw new HTTPError(400, 'VALIDATION_ERROR',
      `request_type must be one of: ${[...VALID_TYPES].join(', ')}`);
  }

  // Rate limit: 5 DSR/hour.
  const rateLimit = checkDSRRate(user.id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many DSR requests', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }

  const db = new SupabaseDB(env);

  // Check for existing pending DSR of same type.
  const existing = await db.selectOne<any>(
    'data_subject_requests',
    `id,status&user_id=eq.${user.id}&request_type=eq.${body.request_type}&status=eq.pending`
  );

  if (existing) {
    return successResponse({
      dsr_id: existing.id,
      status: 'pending',
      message: 'You already have a pending request of this type',
      idempotent: true,
    });
  }

  // Insert DSR.
  const dsr = await db.insert<any>(
    'data_subject_requests',
    {
      user_id: user.id,
      request_type: body.request_type,
      details: body.details || {},
      status: 'pending',
      ip_address: getClientIP(req),
      user_agent: getUserAgent(req),
    },
    { returnRepresentation: true }
  );

  // Audit log.
  logAudit(env, {
    action: 'DSR_REQUEST',
    targetType: 'data_subject_request',
    targetId: dsr?.id || null,
    metadata: {
      request_type: body.request_type,
      details: body.details || {},
    },
    actorId: user.id, actorEmail: user.email, actorRole: user.role,
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  return successResponse({
    dsr_id: dsr?.id,
    request_type: body.request_type,
    status: 'pending',
    created_at: new Date().toISOString(),
    message: 'Request submitted. Admin will review within 30 days (UU PDP Article 13).',
  });
});
