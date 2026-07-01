// =============================================================================
// assessment-lifecycle/index.ts — Start/pause/resume/finish assessment
// =============================================================================
// POST /functions/v1/assessment-lifecycle
// Headers: Authorization: Bearer <admin_token>
// Body: { assessment_id: string, action: 'start'|'pause'|'resume'|'finish' }
// =============================================================================

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAdmin, verifyAssessmentOwnership } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkLifecycleRate } from '../_shared/rate-limit.ts';
import type { Env, Assessment } from '../_shared/types.ts';

interface LifecycleBody {
  assessment_id?: string;
  action?: 'start' | 'pause' | 'resume' | 'finish';
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const admin = await requireAdmin(req, env);

  let body: LifecycleBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.assessment_id || typeof body.assessment_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'assessment_id is required');
  }

  const action = body.action;
  if (!action || !['start', 'pause', 'resume', 'finish'].includes(action)) {
    throw new HTTPError(400, 'VALIDATION_ERROR', "action must be 'start', 'pause', 'resume', or 'finish'");
  }

  // Rate limit
  const rateLimit = checkLifecycleRate(admin.id, body.assessment_id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many lifecycle operations', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }

  // Verify admin owns the assessment
  await verifyAssessmentOwnership(env, body.assessment_id, admin.id);

  const db = new SupabaseDB(env);

  // Fetch assessment (with lock-like behavior via conditional update)
  const assessment = await db.selectOne<Assessment>(
    'assessments',
    `id,access_code,duration_minutes,access_mode,ac_manual_status,ac_end,ac_remaining_time,ac_scheduled_start,ac_scheduled_end,status&id=eq.${body.assessment_id}`
  );

  if (!assessment) {
    throw new HTTPError(404, 'NOT_FOUND', 'Assessment not found');
  }

  if (assessment.status === 'archived') {
    throw new HTTPError(409, 'ASSESSMENT_NOT_ACTIVE', 'Assessment is archived');
  }

  const now = new Date();
  let updateData: any = {};
  let auditAction = '';
  let auditMetadata: any = {};

  switch (action) {
    case 'start': {
      // Validate: must be closed (not running, not paused)
      if (assessment.ac_manual_status === 'open') {
        throw new HTTPError(409, 'CONFLICT', 'Assessment is already running');
      }
      if (assessment.ac_manual_status === 'finished') {
        throw new HTTPError(409, 'CONFLICT', 'Assessment is already finished');
      }
      if (assessment.ac_remaining_time !== null && assessment.ac_remaining_time > 0) {
        throw new HTTPError(409, 'CONFLICT', 'Assessment is paused. Use resume instead.');
      }

      const endTime = new Date(now.getTime() + assessment.duration_minutes * 60_000);
      updateData = {
        ac_manual_status: 'open',
        ac_end: endTime.toISOString(),
        ac_override: true,
        ac_remaining_time: null,
      };
      auditAction = 'START_ASSESSMENT';
      auditMetadata = { end_at: endTime.toISOString() };
      break;
    }

    case 'pause': {
      // Validate: must be running (open + ac_end in future)
      if (assessment.ac_manual_status !== 'open') {
        throw new HTTPError(409, 'CONFLICT', 'Assessment is not running');
      }
      if (!assessment.ac_end) {
        throw new HTTPError(409, 'CONFLICT', 'Assessment has no end time set');
      }

      const remainingMs = new Date(assessment.ac_end).getTime() - now.getTime();
      if (remainingMs <= 0) {
        // Already expired — finish instead
        updateData = {
          ac_manual_status: 'finished',
          ac_end: now.toISOString(),
          ac_remaining_time: null,
        };
        auditAction = 'FINISH_ASSESSMENT';
        auditMetadata = { reason: 'auto-finish on pause (already expired)' };
      } else {
        const remainingSeconds = Math.floor(remainingMs / 1000);
        updateData = {
          ac_manual_status: 'closed',
          ac_end: null,
          ac_remaining_time: remainingSeconds,
        };
        auditAction = 'PAUSE_ASSESSMENT';
        auditMetadata = { remaining_seconds: remainingSeconds };
      }
      break;
    }

    case 'resume': {
      // Validate: must be paused (closed + has remaining_time)
      if (assessment.ac_manual_status !== 'closed') {
        throw new HTTPError(409, 'CONFLICT', 'Assessment is not paused');
      }
      if (!assessment.ac_remaining_time || assessment.ac_remaining_time <= 0) {
        throw new HTTPError(409, 'CONFLICT', 'Assessment has no remaining time');
      }

      const endTime = new Date(now.getTime() + assessment.ac_remaining_time * 1000);
      updateData = {
        ac_manual_status: 'open',
        ac_end: endTime.toISOString(),
        ac_remaining_time: null,
      };
      auditAction = 'RESUME_ASSESSMENT';
      auditMetadata = { end_at: endTime.toISOString(), resumed_from_seconds: assessment.ac_remaining_time };
      break;
    }

    case 'finish': {
      // Validate: must be running or paused
      if (assessment.ac_manual_status === 'finished') {
        // Idempotent
        return successResponse({
          assessment_id: body.assessment_id,
          status: 'finished',
          idempotent: true,
        });
      }
      updateData = {
        ac_manual_status: 'finished',
        ac_end: now.toISOString(),
        ac_remaining_time: null,
      };
      auditAction = 'FINISH_ASSESSMENT';
      auditMetadata = {};
      break;
    }
  }

  // Atomic conditional update — prevents race condition between 2 admins
  const expectedStatus = assessment.ac_manual_status;
  const { updated } = await db.updateIf(
    'assessments',
    `id=eq.${body.assessment_id} AND ac_manual_status=eq.${expectedStatus}`,
    updateData
  );

  if (updated === 0) {
    // Status changed mid-request (race condition)
    throw new HTTPError(409, 'CONFLICT', 'Assessment state changed. Refresh and try again.');
  }

  // Audit log
  logAudit(env, {
    action: auditAction,
    targetType: 'assessment',
    targetId: body.assessment_id,
    metadata: {
      access_code: assessment.access_code,
      ...auditMetadata,
    },
    actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  return successResponse({
    assessment_id: body.assessment_id,
    action,
    ac_manual_status: updateData.ac_manual_status,
    ac_end: updateData.ac_end || null,
    ac_remaining_time: updateData.ac_remaining_time ?? null,
    timestamp: now.toISOString(),
  });
});
