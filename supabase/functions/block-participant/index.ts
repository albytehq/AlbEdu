// block-participant/index.ts — Instant peserta block via Realtime.
// POST /functions/v1/block-participant
// Headers: Authorization: Bearer <admin_token>
// Body: { session_id: string, reason: string }
// Atomic update session.status='blocked'; peserta subscribed to the session
// row receives the UPDATE via Supabase Realtime postgres_changes.
// v0.821.2: Converted from `export default handler(...)` to `serve()` pattern
// because the handler() wrapper causes the deployed EF to hang on POST
// (regression in current Supabase Deno runtime). Same fix as asset-upload v0.821.1.


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, withCors } from '../_shared/cors.ts';
import { HTTPError, handleError, successResponse } from '../_shared/error.ts';
import { requireAdmin, verifyAssessmentOwnership } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkBlockRate } from '../_shared/rate-limit.ts';
import type { Env, AssessmentSession } from '../_shared/types.ts';

interface BlockBody {
  session_id?: string;
  reason?: string;
}

const MAX_REASON_LENGTH = 500;

serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const env = Deno.env.toObject() as unknown as Env;

  if (req.method === 'OPTIONS') return handleOptions(req);

  try {
    const res = await logic(req, env);
    return withCors(res, origin);
  } catch (err) {
    return withCors(handleError(err), origin);
  }
});

async function logic(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);

  let body: BlockBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.session_id || typeof body.session_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'session_id is required');
  }

  // Rate limit: 10 blocks/min per admin.
  const rateLimit = checkBlockRate(admin.id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many block operations', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }

  // Truncate reason.
  const reason = body.reason
    ? body.reason.slice(0, MAX_REASON_LENGTH)
    : 'Blocked by admin';

  const db = new SupabaseDB(env);

  // Fetch session to get assessment_id for ownership check.
  const session = await db.selectOne<AssessmentSession>(
    'assessment_sessions',
    `id,assessment_id,user_id,user_email,status&id=eq.${body.session_id}`
  );

  if (!session) {
    throw new HTTPError(404, 'NOT_FOUND', 'Session not found');
  }

  // Verify admin owns the assessment.
  await verifyAssessmentOwnership(env, session.assessment_id, admin.id);

  // Idempotent: if already blocked, return success.
  if (session.status === 'blocked') {
    return successResponse({
      session_id: session.id,
      status: 'blocked',
      message: 'Session already blocked',
      idempotent: true,
    });
  }

  // Cannot block already-submitted session.
  if (session.status === 'submitted') {
    throw new HTTPError(409, 'SESSION_ALREADY_SUBMITTED', 'Cannot block a submitted session');
  }

  // Atomic update — only if not blocked/submitted.
  const { updated } = await db.updateIf(
    'assessment_sessions',
    `id=eq.${body.session_id} AND status=in.(active,paused,disconnected,expired)`,
    {
      status: 'blocked',
      blocked_at: new Date().toISOString(),
      blocked_by: admin.id,
      blocked_reason: reason,
    }
  );

  if (updated === 0) {
    // Status changed mid-request — re-fetch.
    const fresh = await db.selectOne<AssessmentSession>(
      'assessment_sessions',
      `id,status&id=eq.${body.session_id}`
    );
    if (fresh?.status === 'blocked') {
      return successResponse({ session_id: session.id, status: 'blocked', idempotent: true });
    }
    throw new HTTPError(409, 'CONFLICT', `Cannot block session in status: ${fresh?.status || 'unknown'}`);
  }

  // Audit log.
  logAudit(env, {
    action: 'BLOCK_PARTICIPANT',
    targetType: 'session',
    targetId: session.id,
    metadata: {
      assessment_id: session.assessment_id,
      user_id: session.user_id,
      user_email: session.user_email,
      reason,
    },
    actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  // Realtime: peserta subscribed to the session row receives the UPDATE
  // automatically via postgres_changes — no explicit broadcast needed.

  return successResponse({
    session_id: session.id,
    status: 'blocked',
    blocked_at: new Date().toISOString(),
    blocked_by: admin.id,
    reason,
  });
}
