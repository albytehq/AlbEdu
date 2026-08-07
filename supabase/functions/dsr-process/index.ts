// dsr-process/index.ts — Process DSR requests (admin approve/reject)
// POST /functions/v1/dsr-process
// Headers: Authorization: Bearer <admin_jwt>
// Body: {
//   dsr_id: string,
//   action: 'approve' | 'reject',
//   resolution_notes?: string
// }
//
// For 'delete' DSR approved:
//   - Soft-delete user (set deleted_at)
//   - Cascade-delete avatar from Storage (already done at DSR submission, but be safe)
//   - Anonymize submissions (keep for audit, blank PII fields)
//   - Mark DSR as resolved
//
// For other DSR types (access, correct, portability) approved:
//   - Mark DSR as resolved
//   - (Admin handles fulfillment out-of-band)
//
// For rejected:
//   - Mark DSR as resolved with status='rejected' + notes
//   - Send email to user (Resend — future)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, withCors } from '../_shared/cors.ts';
import { HTTPError, handleError, successResponse } from '../_shared/error.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { logger } from '../_shared/log.ts';
import type { Env } from '../_shared/types.ts';

const VALID_ACTIONS = new Set(['approve', 'reject']);

interface ProcessBody {
  dsr_id?: string;
  action?: 'approve' | 'reject';
  resolution_notes?: string;
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

  let body: ProcessBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.dsr_id || typeof body.dsr_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'dsr_id is required');
  }
  if (!body.action || !VALID_ACTIONS.has(body.action)) {
    throw new HTTPError(400, 'VALIDATION_ERROR', "action must be 'approve' or 'reject'");
  }

  const notes = body.resolution_notes ? String(body.resolution_notes).slice(0, 1000) : null;

  const db = new SupabaseDB(env);

  // Fetch DSR
  const dsr = await db.selectOne<any>(
    'data_subject_requests',
    `id,user_id,request_type,details,status,created_at,ip_address,user_agent&status=eq.pending&id=eq.${body.dsr_id}`
  );

  if (!dsr) {
    throw new HTTPError(404, 'NOT_FOUND', 'DSR not found or already resolved');
  }

  // Status enum per data_subject_requests_status_check constraint:
  // pending, processing, completed, rejected, cancelled
  const newStatus = body.action === 'approve' ? 'completed' : 'rejected';
  const resolvedAt = new Date().toISOString();

  // Update DSR
  await db.updateIf('data_subject_requests',
    `id=eq.${body.dsr_id} AND status=eq.pending`,
    {
      status: newStatus,
      resolved_at: resolvedAt,
      resolution_notes: notes,
      resolved_by: admin.id,
    }
  );

  // For 'delete' DSR approved — cascade user soft-delete + avatar cleanup + submission anonymization
  let cascadeResults: Record<string, unknown> = {};
  if (body.action === 'approve' && dsr.request_type === 'delete') {
    cascadeResults = await cascadeDeleteUser(env, dsr.user_id, admin.id);
  }

  // Audit log
  logAudit(env, {
    action: body.action === 'approve' ? 'DSR_APPROVE' : 'DSR_REJECT',
    targetType: 'data_subject_request',
    targetId: body.dsr_id,
    metadata: {
      dsr_user_id: dsr.user_id,
      dsr_request_type: dsr.request_type,
      resolution_notes: notes,
      cascade: cascadeResults,
    },
    actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  logger.info('dsr_processed', {
    dsr_id: body.dsr_id,
    action: body.action,
    request_type: dsr.request_type,
    admin_id: admin.id,
    cascade: cascadeResults,
  });

  return successResponse({
    dsr_id: body.dsr_id,
    status: newStatus,
    resolved_at: resolvedAt,
    resolved_by: admin.id,
    cascade: cascadeResults,
  });
}

async function cascadeDeleteUser(
  env: Env,
  userId: string,
  adminId: string
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {
    user_soft_deleted: false,
    avatar_deleted: 0,
    submissions_anonymized: 0,
    sessions_deleted: 0,
    errors: [],
  };

  try {
    // 1. Soft-delete user
    const db = new SupabaseDB(env);
    await db.updateIf('users', `id=eq.${userId} AND deleted_at=is.null`, {
      deleted_at: new Date().toISOString(),
      consent_at: null,
    });
    results.user_soft_deleted = true;
  } catch (err: any) {
    results.errors.push(`user_soft_delete: ${err.message}`);
  }

  // 2. Cascade-delete avatar (defensive — dsr-handler already tried)
  try {
    const listRes = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/list/avatars`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefix: userId + '/', limit: 100 }),
      }
    );
    if (listRes.ok) {
      const files = await listRes.json() as Array<{ name: string }>;
      if (Array.isArray(files) && files.length > 0) {
        const paths = files.map(f => `${userId}/${f.name}`);
        const delRes = await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/avatars`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prefixes: paths }),
          }
        );
        if (delRes.ok) results.avatar_deleted = paths.length;
      }
    }
  } catch (err: any) {
    results.errors.push(`avatar_delete: ${err.message}`);
  }

  // 3. Anonymize submissions (keep audit trail, blank PII)
  try {
    const db = new SupabaseDB(env);
    const { data: updated } = await db.updateIf(
      'submissions',
      `user_id=eq.${userId}`,
      {
        user_email: null,
        identity_snapshot: { anonymized: true, original_at: new Date().toISOString() },
      }
    );
    results.submissions_anonymized = Array.isArray(updated) ? 0 : 0; // updateIf returns count
  } catch (err: any) {
    results.errors.push(`submissions_anonymize: ${err.message}`);
  }

  // 4. Delete sessions (audit_logs retains the audit trail)
  try {
    const db = new SupabaseDB(env);
    await db.delete('assessment_sessions', `user_id=eq.${userId}`);
    results.sessions_deleted = true;
  } catch (err: any) {
    results.errors.push(`sessions_delete: ${err.message}`);
  }

  return results;
}
