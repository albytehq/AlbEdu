// =============================================================================
// data-export/index.ts — DSR self-service data export (UU PDP compliance)
// =============================================================================
// POST /functions/v1/data-export
// Headers: Authorization: Bearer <token>
// Returns: JSON of all user's personal data
// =============================================================================

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAnyRole } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkExportRate } from '../_shared/rate-limit.ts';
import type { Env } from '../_shared/types.ts';

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const user = await requireAnyRole(req, env);

  // Rate limit: 3 exports/hour (heavy operation)
  const rateLimit = checkExportRate(user.id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many export requests. Try again later.', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }

  const db = new SupabaseDB(env);

  // Collect all user data in parallel
  const [profile, submissions, violations, auditLogs, consents, dsrs] = await Promise.all([
    // Profile
    db.selectOne('users',
      `id,email,nama,peran,locale,created_at,updated_at,consent_at,deleted_at&id=eq.${user.id}`
    ),

    // Submissions (last 100)
    db.select('submissions',
      `id,assessment_id,score,max_score,correct_count,total_count,started_at,submitted_at,duration_seconds,attempt_number&user_id=eq.${user.id}&order=submitted_at.desc&limit=100`
    ),

    // Violation events (last 90 days per Q10 retention)
    db.select('violation_events',
      `id,event_type,message,severity,created_at&user_id=eq.${user.id}&order=created_at.desc&limit=500`
    ),

    // Audit logs (own, last 1 year)
    db.select('audit_logs',
      `action,target_type,target_id,created_at&actor_id=eq.${user.id}&order=created_at.desc&limit=1000`
    ),

    // Consents
    db.select('consents',
      `consent_type,version,granted,granted_at,revoked_at&user_id=eq.${user.id}&order=granted_at.desc`
    ),

    // DSR requests
    db.select('data_subject_requests',
      `request_type,status,created_at,resolved_at,resolution_notes&user_id=eq.${user.id}&order=created_at.desc`
    ),
  ]);

  // Audit log
  logAudit(env, {
    action: 'DATA_EXPORT',
    targetType: 'user',
    targetId: user.id,
    metadata: {
      submissions_count: submissions?.length || 0,
      violations_count: violations?.length || 0,
      audit_logs_count: auditLogs?.length || 0,
    },
    actorId: user.id, actorEmail: user.email, actorRole: user.role,
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  const exportData = {
    exported_at: new Date().toISOString(),
    user: profile,
    submissions: submissions || [],
    violations: violations || [],
    audit_logs: auditLogs || [],
    consents: consents || [],
    data_subject_requests: dsrs || [],
    retention_policy: {
      submissions: '3 years',
      violations: '90 days',
      audit_logs: '1 year',
      consents: 'forever (immutable history)',
    },
  };

  return successResponse(exportData);
});
