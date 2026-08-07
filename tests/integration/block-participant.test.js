// tests/integration/block-participant.test.js
// Tests block-participant EF with real session — block delivery

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('block-participant EF', () => {
  let admin, peserta;
  let sessionId;
  let assessmentId;

  beforeAll(async () => {
    admin = await createTestUser('admin');
    peserta = await createTestUser('peserta');

    // Create an assessment OWNED by this admin (so block-participant's
    // verifyAssessmentOwnership check passes)
    const svc = serviceClient();
    const { data: assessment, error } = await svc.from('assessments')
      .insert({
        access_code: String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
        created_by: admin.id,
        created_by_email: admin.email,
        title: 'Block Test Assessment (vitest)',
        subject: 'Test',
        duration_minutes: 30,
        access_mode: 'manual',
        sections: [{
          id: 1,
          name: 'S1',
          type_question: 'PG',
          questions: [{ idq: 1, pertanyaan: 'q?', pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' }, jawaban_benar: 'A', skor: 100 }],
        }],
        status: 'active',
        ac_manual_status: 'open',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    assessmentId = assessment.id;
  });

  afterAll(async () => {
    const svc = serviceClient();
    if (assessmentId) {
      // Deleting assessment cascades to sessions + submissions
      await svc.from('assessments').delete().eq('id', assessmentId);
    }
    await cleanupTestUser(peserta.id);
    await cleanupTestUser(admin.id);
  });

  it('rejects non-existent session (404)', async () => {
    const res = await invokeEF('block-participant', admin.jwt, {
      session_id: '00000000-0000-0000-0000-000000000000',
      reason: 'test',
    });
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe('NOT_FOUND');
  });

  it('rejects missing session_id (400)', async () => {
    const res = await invokeEF('block-participant', admin.jwt, {
      reason: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('blocks active session → status=blocked, blocked_by=admin.id', async () => {
    const svc = serviceClient();
    const { data: session, error } = await svc.from('assessment_sessions')
      .insert({
        assessment_id: assessmentId,
        user_id: peserta.id,
        status: 'active',
        identity_snapshot: { nama: 'Block Test' },
        user_email: peserta.email,
        started_at: new Date().toISOString(),
        attempt_number: 1,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    sessionId = session.id;

    const res = await invokeEF('block-participant', admin.jwt, {
      session_id: sessionId,
      reason: 'smoke test — cheating detected',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.session_id).toBe(sessionId);
    expect(res.data.data.status).toBe('blocked');
    expect(res.data.data.blocked_by).toBe(admin.id);
    expect(res.data.data.reason).toContain('smoke test');

    // Verify DB state
    const { data: after } = await svc.from('assessment_sessions')
      .select('status,blocked_at,blocked_by,blocked_reason')
      .eq('id', sessionId)
      .maybeSingle();
    expect(after.status).toBe('blocked');
    expect(after.blocked_at).toBeTruthy();
    expect(after.blocked_by).toBe(admin.id);
    expect(after.blocked_reason).toContain('smoke test');
  });

  it('is idempotent — re-blocking blocked session returns 200 with idempotent=true', async () => {
    const res = await invokeEF('block-participant', admin.jwt, {
      session_id: sessionId,
      reason: 're-block test',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.idempotent).toBe(true);
  });

  it('cannot block already-submitted session (409)', async () => {
    const svc = serviceClient();
    const { data: sub, error } = await svc.from('assessment_sessions')
      .insert({
        assessment_id: assessmentId,
        user_id: peserta.id,
        status: 'submitted',
        identity_snapshot: { nama: 'Submit Block Test' },
        user_email: peserta.email,
        started_at: new Date().toISOString(),
        submitted_at: new Date().toISOString(),
        attempt_number: 2,
      })
      .select('id')
      .single();
    expect(error).toBeNull();

    const res = await invokeEF('block-participant', admin.jwt, {
      session_id: sub.id,
      reason: 'try block submitted',
    });

    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('SESSION_ALREADY_SUBMITTED');
  });
});
