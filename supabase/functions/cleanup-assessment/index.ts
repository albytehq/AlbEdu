// cleanup-assessment/index.ts — Archive assessment with pre-delete active-participant check.
// POST /functions/v1/cleanup-assessment
// Headers: Authorization: Bearer <admin_token>
// Body: { assessment_id: string, force?: boolean }
// v0.821.2: Converted from `export default handler(...)` to `serve()` pattern
// because the handler() wrapper causes the deployed EF to hang on POST
// (regression in current Supabase Deno runtime). Same fix as asset-upload v0.821.1.


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, withCors } from '../_shared/cors.ts';
import { HTTPError, handleError, successResponse } from '../_shared/error.ts';
import { requireAdmin, verifyAssessmentOwnership } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import type { Env } from '../_shared/types.ts';

interface CleanupBody {
  assessment_id?: string;
  force?: boolean;
}

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

  let body: CleanupBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.assessment_id || typeof body.assessment_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'assessment_id is required');
  }

  await verifyAssessmentOwnership(env, body.assessment_id, admin.id);

  const db = new SupabaseDB(env);

  // Use the PostgREST count endpoint to check for active participants.
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

  // Soft delete (archive).
  const { updated } = await db.updateIf(
    'assessments',
    `id=eq.${body.assessment_id} AND status=neq.archived`,
    { status: 'archived' }
  );

  if (updated === 0) {
    // Already archived — idempotent.
    return successResponse({
      assessment_id: body.assessment_id,
      status: 'archived',
      idempotent: true,
    });
  }

  // Audit log.
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
}
