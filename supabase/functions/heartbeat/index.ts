// =============================================================================
// heartbeat/index.ts — Peserta progress sync (15s interval)
// =============================================================================
// POST /functions/v1/heartbeat
//
// Headers: Authorization: Bearer <token>
// Body: {
//   session_id: string,
//   current_section: number,
//   current_question: number,
//   progress_pct: number,
//   violation_count: number,
//   draft_answers: object  // partial sync
// }
//
// Returns: { ok, blocked, server_time, session_status }
// =============================================================================

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requirePeserta } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkHeartbeatRate, checkHeartbeatRateDB } from '../_shared/rate-limit.ts';
import type { Env, AssessmentSession } from '../_shared/types.ts';

interface HeartbeatBody {
  session_id?: string;
  current_section?: number;
  current_question?: number;
  progress_pct?: number;
  violation_count?: number;
  draft_answers?: Record<string, any>;
}

const MAX_DRAFT_SIZE = 100_000;  // 100KB
const BLOCKED_STATUSES = new Set(['blocked', 'submitted', 'expired']);

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const user = await requirePeserta(req, env);

  let body: HeartbeatBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.session_id || typeof body.session_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'session_id is required');
  }

  // Rate limit: 4 req/min per session (15s interval)
  // [v2.0 Hardening] In-memory soft limit + DB-based hard limit (cross-isolate)
  const rateLimit = checkHeartbeatRate(body.session_id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Heartbeat too frequent', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }
  // DB-based hard limit — catches cross-isolate bypass
  const dbRateLimit = await checkHeartbeatRateDB(env, body.session_id);
  if (!dbRateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Heartbeat rate limit exceeded (DB)', {
      reset_at: new Date(dbRateLimit.resetAt).toISOString(),
    });
  }

  // Validate draft_answers size
  if (body.draft_answers) {
    const draftStr = JSON.stringify(body.draft_answers);
    if (draftStr.length > MAX_DRAFT_SIZE) {
      throw new HTTPError(413, 'PAYLOAD_TOO_LARGE', `Draft answers exceed ${MAX_DRAFT_SIZE} bytes`);
    }
  }

  // Validate progress_pct
  let progressPct = 0;
  if (typeof body.progress_pct === 'number') {
    progressPct = Math.max(0, Math.min(100, body.progress_pct));
  }

  const db = new SupabaseDB(env);

  // Fetch session (with current status — critical for instant block detection)
  const session = await db.selectOne<AssessmentSession>(
    'assessment_sessions',
    `id,user_id,status,blocked_reason,attempt_number,violation_count&id=eq.${body.session_id}`
  );

  if (!session) {
    throw new HTTPError(404, 'NOT_FOUND', 'Session not found');
  }

  if (session.user_id !== user.id) {
    throw new HTTPError(403, 'FORBIDDEN', 'Session does not belong to authenticated user');
  }

  // Check if blocked/submitted/expired — return signal to client
  if (BLOCKED_STATUSES.has(session.status)) {
    return successResponse({
      ok: false,
      blocked: session.status === 'blocked',
      submitted: session.status === 'submitted',
      expired: session.status === 'expired',
      session_status: session.status,
      blocked_reason: session.blocked_reason || null,
      server_time: new Date().toISOString(),
    });
  }

  // Update session (atomic — only if still active/paused)
  const updateData: any = {
    last_heartbeat_at: new Date().toISOString(),
    current_section: typeof body.current_section === 'number' ? body.current_section : 0,
    current_question: typeof body.current_question === 'number' ? body.current_question : 0,
    progress_pct: progressPct,
  };

  if (typeof body.violation_count === 'number') {
    updateData.violation_count = Math.max(0, body.violation_count);
  }

  if (body.draft_answers && typeof body.draft_answers === 'object') {
    updateData.draft_answers = body.draft_answers;
  }

  const { updated } = await db.updateIf(
    'assessment_sessions',
    `id=eq.${body.session_id} AND status=in.(active,paused,disconnected)`,
    updateData
  );

  // If update failed (status changed mid-heartbeat), re-fetch and return current state
  if (updated === 0) {
    const freshSession = await db.selectOne<AssessmentSession>(
      'assessment_sessions',
      `id,status,blocked_reason&id=eq.${body.session_id}`
    );

    if (freshSession && BLOCKED_STATUSES.has(freshSession.status)) {
      return successResponse({
        ok: false,
        blocked: freshSession.status === 'blocked',
        submitted: freshSession.status === 'submitted',
        expired: freshSession.status === 'expired',
        session_status: freshSession.status,
        blocked_reason: freshSession.blocked_reason || null,
        server_time: new Date().toISOString(),
      });
    }
  }

  return successResponse({
    ok: true,
    blocked: false,
    session_status: session.status,
    server_time: new Date().toISOString(),
    attempt_number: session.attempt_number,
  });
});
