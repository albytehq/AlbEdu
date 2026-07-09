// dsr-handler/index.ts — Data Subject Request handler (UU PDP).
// POST /functions/v1/dsr-handler
// Headers: Authorization: Bearer <token>
// Body: { request_type: 'access'|'correct'|'delete'|'portability', details?: object }
//
// v0.819.0: For 'delete' requests, also cascade-delete the user's avatar
// from Supabase Storage `avatars` bucket (UU PDP right-to-be-forgotten).
// Previously, only the users table row was soft-deleted — the avatar file
// remained in Storage, violating UU PDP Article 16 (right to erasure).

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

  // ── v0.819.0: Cascade avatar deletion for 'delete' requests ──────────────
  // UU PDP Article 16 (right to erasure) requires ALL personal data to be
  // deleted, including avatar files in Storage. Previously, only the users
  // table row was soft-deleted (deleted_at = now()), leaving the avatar
  // file orphaned in Storage.
  //
  // We delete the avatar IMMEDIATELY (not waiting for admin approval) because:
  //   1. The user explicitly requested deletion — intent is clear
  //   2. Avatars are non-critical (display picture) — no audit trail dependency
  //   3. Admin can still see the DSR record + audit_logs entry for forensics
  //
  // The user row is NOT soft-deleted here — that happens after admin approval.
  // We only delete the avatar file (the user can re-upload if DSR is rejected).
  let avatarDeleted = 0;
  let avatarDeleteError: string | null = null;

  if (body.request_type === 'delete') {
    try {
      // List all files in user's avatar folder
      const listRes = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/list/avatars`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prefix: user.id + '/',
            limit: 100,
          }),
        }
      );

      if (listRes.ok) {
        const fileList = await listRes.json() as Array<{ name: string }>;
        if (Array.isArray(fileList) && fileList.length > 0) {
          // Build paths for bulk delete
          const paths = fileList.map((f) => `${user.id}/${f.name}`);

          // Bulk delete via Storage API
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

          if (delRes.ok) {
            avatarDeleted = paths.length;
          } else {
            avatarDeleteError = `Storage delete failed: HTTP ${delRes.status}`;
            console.error('[dsr-handler] Avatar delete failed:', avatarDeleteError);
          }
        }
      }
    } catch (err) {
      avatarDeleteError = err instanceof Error ? err.message : String(err);
      console.error('[dsr-handler] Avatar cascade error:', avatarDeleteError);
      // Don't fail the DSR request — admin will be notified to manually delete
    }
  }

  // Audit log.
  logAudit(env, {
    action: 'DSR_REQUEST',
    targetType: 'data_subject_request',
    targetId: dsr?.id || null,
    metadata: {
      request_type: body.request_type,
      details: body.details || {},
      avatar_deleted: avatarDeleted,
      avatar_delete_error: avatarDeleteError,
    },
    actorId: user.id, actorEmail: user.email, actorRole: user.role,
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  // Separate audit log entry for avatar deletion (for compliance reporting)
  if (body.request_type === 'delete' && avatarDeleted > 0) {
    logAudit(env, {
      action: 'DSR_AVATAR_DELETE',
      targetType: 'storage_object',
      targetId: `avatars/${user.id}/`,
      metadata: {
        files_deleted: avatarDeleted,
        dsr_id: dsr?.id,
      },
      actorId: user.id, actorEmail: user.email, actorRole: user.role,
      ipAddress: getClientIP(req), userAgent: getUserAgent(req),
    });
  }

  return successResponse({
    dsr_id: dsr?.id,
    request_type: body.request_type,
    status: 'pending',
    created_at: new Date().toISOString(),
    avatar_deleted: avatarDeleted,
    avatar_delete_error: avatarDeleteError,
    message: 'Request submitted. Admin will review within 30 days (UU PDP Article 13).'
      + (avatarDeleted > 0 ? ` Avatar files deleted immediately (${avatarDeleted}).` : ''),
  });
});
