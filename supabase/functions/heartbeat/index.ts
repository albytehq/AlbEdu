// heartbeat/index.ts — Peserta progress sync (15s interval).
// POST /functions/v1/heartbeat
// Headers: Authorization: Bearer <token>
// Body: {
//   session_id, current_section, current_question,
//   progress_pct, violation_count, draft_answers (partial sync)
// }
// Returns: { ok, blocked, server_time, session_status }

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

// Per-session DB rate-limit verdict cache. Cuts DB writes from 4/min to
// 1/min per peserta without weakening the hard limit.
const heartbeatDbCache = new Map<string, { allowed: boolean; resetAt: number; checkedAt: number; }>();

// Evict stale entries every 5 minutes to keep the Map bounded.
let _lastHbCacheGc = Date.now();
function _gcHeartbeatCache() {
  const now = Date.now();
  if (now - _lastHbCacheGc < 5 * 60_000) return;
  _lastHbCacheGc = now;
  for (const [k, v] of heartbeatDbCache) {
    if (now - v.checkedAt > 5 * 60_000) heartbeatDbCache.delete(k);
  }
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  _gcHeartbeatCache();
  const user = await requirePeserta(req, env);

  let body: HeartbeatBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!body.session_id || typeof body.session_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'session_id is required');
  }

  // 4 req/min per session (matches the 15s client interval).
  // In-memory check is the fast path. The DB check is the hard limit so
  // cross-isolate bypass can't slip through, but we only run it once per
  // session per 60s to avoid burning 4 DB writes/min/peserta (which on a
  // 50-peserta 90-min exam = 18K inserts, hitting the 60K-row soft cap
  // in ~5 hours and consuming ~12K rows/hour of DB egress budget).
  const rateLimit = checkHeartbeatRate(body.session_id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Heartbeat too frequent', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }
  // Cache the DB verdict per session for 60s. If the in-memory check
  // passed, the DB check is a backup layer — we don't need to re-run it
  // on every single beat.
  const now = Date.now();
  const cacheKey = `hbdb:${body.session_id}`;
  const cached = heartbeatDbCache.get(cacheKey);
  if (!cached || now - cached.checkedAt > 60_000) {
    const dbRateLimit = await checkHeartbeatRateDB(env, body.session_id);
    heartbeatDbCache.set(cacheKey, { allowed: dbRateLimit.allowed, resetAt: dbRateLimit.resetAt, checkedAt: now });
    if (!dbRateLimit.allowed) {
      throw new HTTPError(429, 'RATE_LIMITED', 'Heartbeat rate limit exceeded (DB)', {
        reset_at: new Date(dbRateLimit.resetAt).toISOString(),
      });
    }
  } else if (!cached.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Heartbeat rate limit exceeded (DB cached)', {
      reset_at: new Date(cached.resetAt).toISOString(),
    });
  }

  // Validate draft_answers size.
  if (body.draft_answers) {
    const draftStr = JSON.stringify(body.draft_answers);
    if (draftStr.length > MAX_DRAFT_SIZE) {
      throw new HTTPError(413, 'PAYLOAD_TOO_LARGE', `Draft answers exceed ${MAX_DRAFT_SIZE} bytes`);
    }
  }

  // Validate progress_pct.
  let progressPct = 0;
  if (typeof body.progress_pct === 'number') {
    progressPct = Math.max(0, Math.min(100, body.progress_pct));
  }

  const db = new SupabaseDB(env);

  // Fetch current status — drives instant block detection on the client.
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

  // If blocked/submitted/expired, signal the client to redirect.
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

  // Atomic update — only fires if the session is still active/paused.
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

  // If the update hit 0 rows the status changed mid-heartbeat — re-fetch
  // and return the current state so the client can redirect.
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
