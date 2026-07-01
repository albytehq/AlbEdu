// =============================================================================
// cleanup-assessment/index.ts — Archive assessment with pre-delete check
// =============================================================================
// POST /functions/v1/cleanup-assessment
// Headers: Authorization: Bearer <admin_token>
// Body: { assessment_id: string, force?: boolean }
// =============================================================================

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAdmin, verifyAssessmentOwnership } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import type { Env } from '../_shared/types.ts';

interface CleanupBody {
  assessment_id?: string;
  force?: boolean;
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const admin = await requireAdmin(req, env);

  let body: CleanupBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.assessment_id || typeof body.assessment_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'assessment_id is required');
  }

  await verifyAssessmentOwnership(env, body.assessment_id, admin.id);

  const db = new SupabaseDB(env);

  // Check for active sessions (peserta currently taking the assessment)
  const activeSessions = await db.select<{ count: number }[]>(
    'assessment_sessions',
    `id&assessment_id=eq.${body.assessment_id}&status=eq.active`
  );

  // Actually use count endpoint
  const countRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/assessment_sessions?assessment_id=eq.${body.assessment_id}&status=eq.active&select=id&limit=100`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0',
      },
    }
  );

  let activeCount = 0;
  if (countRes.ok) {
    const range = countRes.headers.get('content-range') || '';
    const match = range.match(/\/(\d+)/);
    if (match) activeCount = parseInt(match[1], 10);
  }

  if (activeCount > 0 && !body.force) {
    throw new HTTPError(409, 'CONFLICT', 'Assessment has active participants', {
      active_count: activeCount,
      hint: 'Wait for participants to finish, or set force=true to archive anyway',
    });
  }

  // Soft delete (archive)
  const { updated } = await db.updateIf(
    'assessments',
    `id=eq.${body.assessment_id} AND status=neq.archived`,
    { status: 'archived' }
  );

  if (updated === 0) {
    // Already archived — idempotent
    return successResponse({
      assessment_id: body.assessment_id,
      status: 'archived',
      idempotent: true,
    });
  }

  // Audit log
  logAudit(env, {
    action: 'ARCHIVE_ASSESSMENT',
    targetType: 'assessment',
    targetId: body.assessment_id,
    metadata: {
      active_participants_at_archive: activeCount,
      forced: !!body.force,
    },
    actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  return successResponse({
    assessment_id: body.assessment_id,
    status: 'archived',
    archived_at: new Date().toISOString(),
    archived_by: admin.email,
  });
});
