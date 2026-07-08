// submit-assessment/index.ts — Server-side scoring Edge Function.
// POST /functions/v1/submit-assessment
// Headers: Authorization: Bearer <supabase_access_token>
// Body: {
//   session_id, answers: { section_0: { "1": "A", ... }, ... },
//   duration_seconds, violation_count
// }
// Returns: { score, correct_count, total_count, grading_detail }
//
// The client's answers payload is validated against the stored assessment
// sections and RE-Scored server-side — never trust a client-sent score.
// Double-submit is caught by the UNIQUE constraint on submissions.session_id.

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requirePeserta } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { checkSubmitRate, checkSubmitRateDB } from '../_shared/rate-limit.ts';
import type { Env, Assessment, AssessmentSession, Section } from '../_shared/types.ts';

interface SubmitBody {
  session_id?: string;
  answers?: Record<string, Record<string, string>>;
  duration_seconds?: number;
  violation_count?: number;
}

const GRACE_PERIOD_SECONDS = 30;
const MAX_ANSWERS_SIZE = 100_000;

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const user = await requirePeserta(req, env);

  // Parse + validate body.
  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body');
  }

  if (!body.session_id || typeof body.session_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'session_id is required');
  }
  if (!body.answers || typeof body.answers !== 'object') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'answers object is required');
  }

  const answersStr = JSON.stringify(body.answers);
  if (answersStr.length > MAX_ANSWERS_SIZE) {
    throw new HTTPError(413, 'PAYLOAD_TOO_LARGE', `Answers payload exceeds ${MAX_ANSWERS_SIZE} bytes`);
  }

  // Rate limit — in-memory soft + DB-based hard (cross-isolate).
  const rateLimit = checkSubmitRate(body.session_id);
  if (!rateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Too many submit attempts. Wait before retrying.', {
      reset_at: new Date(rateLimit.resetAt).toISOString(),
    });
  }
  const dbRateLimit = await checkSubmitRateDB(env, body.session_id);
  if (!dbRateLimit.allowed) {
    throw new HTTPError(429, 'RATE_LIMITED', 'Submit rate limit exceeded (DB)', {
      reset_at: new Date(dbRateLimit.resetAt).toISOString(),
    });
  }

  const db = new SupabaseDB(env);

  // Fetch session.
  const session = await db.selectOne<AssessmentSession>(
    'assessment_sessions',
    `id,assessment_id,user_id,user_email,identity_snapshot,status,started_at,attempt_number&id=eq.${body.session_id}`
  );

  if (!session) {
    throw new HTTPError(404, 'NOT_FOUND', 'Session not found');
  }

  // Ownership check.
  if (session.user_id !== user.id) {
    throw new HTTPError(403, 'FORBIDDEN', 'Session does not belong to authenticated user');
  }

  // State check.
  if (session.status === 'submitted') {
    const existing = await db.selectOne<any>(
      'submissions',
      `id,score,max_score,correct_count,total_count,grading_detail,duration_seconds,submitted_at&session_id=eq.${body.session_id}`
    );
    if (existing) {
      return successResponse({ ...existing, idempotent: true, message: 'Assessment already submitted' });
    }
  }

  if (session.status === 'blocked') {
    throw new HTTPError(409, 'SESSION_BLOCKED', 'Session is blocked. Cannot submit.');
  }
  // expired / disconnected → allow submit (grace)

  // Fetch assessment.
  const assessment = await db.selectOne<Assessment>(
    'assessments',
    `id,access_code,title,subject,sections,total_score,status,access_mode,ac_end,ac_manual_status,ac_scheduled_end,allow_retake&id=eq.${session.assessment_id}`
  );

  if (!assessment) {
    throw new HTTPError(404, 'NOT_FOUND', 'Assessment not found');
  }

  if (assessment.status === 'archived') {
    throw new HTTPError(409, 'ASSESSMENT_NOT_ACTIVE', 'Assessment has been archived');
  }

  // Time expiry check (with grace).
  const now = Date.now();
  let isTimeExpired = false;
  if (assessment.access_mode === 'manual' && assessment.ac_end) {
    if (new Date(assessment.ac_end).getTime() + GRACE_PERIOD_SECONDS * 1000 < now) {
      isTimeExpired = true;
    }
  } else if (assessment.access_mode === 'scheduled' && assessment.ac_scheduled_end) {
    if (new Date(assessment.ac_scheduled_end).getTime() + GRACE_PERIOD_SECONDS * 1000 < now) {
      isTimeExpired = true;
    }
  }

  // Server-side scoring.
  const sections: Section[] = Array.isArray(assessment.sections) ? assessment.sections : [];
  const gradingDetail: any[] = [];
  let correctCount = 0;
  let totalCount = 0;

  sections.forEach((section, sectionIdx) => {
    if (!section || !Array.isArray(section.questions)) return;
    section.questions.forEach((q) => {
      totalCount++;
      const sectionKey = `section_${sectionIdx}`;
      const pesertaAnswer = body.answers?.[sectionKey]?.[String(q.idq)];
      let isCorrect = false;
      let status: 'benar' | 'salah' | 'kosong' = 'kosong';

      if (section.type_question === 'PG') {
        if (pesertaAnswer && ['A', 'B', 'C', 'D'].includes(pesertaAnswer)) {
          if (pesertaAnswer === q.jawaban_benar) {
            isCorrect = true;
            status = 'benar';
            correctCount++;
          } else {
            status = 'salah';
          }
        }
      } else {
        status = 'kosong';
      }

      gradingDetail.push({
        section_idx: sectionIdx,
        section_name: section.name,
        idq: q.idq,
        type: section.type_question,
        peserta_answer: pesertaAnswer || null,
        jawaban_benar: q.jawaban_benar || null,
        is_correct: isCorrect,
        status,
        points: isCorrect ? q.skor : 0,
        max_points: q.skor,
      });
    });
  });

  const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const durationSeconds = typeof body.duration_seconds === 'number' && body.duration_seconds > 0
    ? Math.min(body.duration_seconds, assessment.duration_minutes * 60 + 300)
    : null;

  // Atomic insert + update.
  try {
    await db.insert('submissions', {
      assessment_id: session.assessment_id,
      session_id: session.id,
      user_id: session.user_id,
      identity_snapshot: session.identity_snapshot || {},
      user_email: session.user_email,
      answers: body.answers,
      score,
      max_score: assessment.total_score,
      correct_count: correctCount,
      total_count: totalCount,
      grading_detail: gradingDetail,
      started_at: session.started_at,
      submitted_at: new Date().toISOString(),
      duration_seconds: durationSeconds,
      attempt_number: session.attempt_number,
    });
  } catch (err: any) {
    if (err instanceof HTTPError && err.code === 'CONFLICT') {
      const existing = await db.selectOne<any>(
        'submissions',
        `id,score,max_score,correct_count,total_count,grading_detail,submitted_at&session_id=eq.${body.session_id}`
      );
      if (existing) return successResponse({ ...existing, idempotent: true });
    }
    throw err;
  }

  await db.updateIf('assessment_sessions',
    `id=eq.${session.id} AND status=eq.active`,
    { status: 'submitted', submitted_at: new Date().toISOString() }
  );

  // Audit log.
  logAudit(env, {
    action: 'SUBMIT_ASSESSMENT',
    targetType: 'assessment',
    targetId: session.assessment_id,
    metadata: {
      session_id: session.id,
      access_code: assessment.access_code,
      score, correct_count: correctCount, total_count: totalCount,
      duration_seconds: durationSeconds,
      attempt_number: session.attempt_number,
      time_expired: isTimeExpired,
      violation_count: body.violation_count || 0,
    },
    actorId: user.id, actorEmail: user.email, actorRole: 'peserta',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  return successResponse({
    session_id: session.id,
    assessment_id: session.assessment_id,
    access_code: assessment.access_code,
    score,
    max_score: assessment.total_score,
    correct_count: correctCount,
    total_count: totalCount,
    grading_detail: gradingDetail,
    duration_seconds: durationSeconds,
    submitted_at: new Date().toISOString(),
    attempt_number: session.attempt_number,
    time_expired: isTimeExpired,
  });
});
