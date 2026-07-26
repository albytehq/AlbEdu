// tests/integration/submit-assessment.test.js
// Tests submit-assessment EF — server-side scoring, idempotency, validation

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  postgrest,
  serviceClient,
  CORRECT_ANSWERS,
  WRONG_ANSWERS,
} from './_helpers.js';

describe('submit-assessment EF', () => {
  let peserta1, peserta2;
  let session1, session2;
  let assessmentId;

  beforeAll(async () => {
    peserta1 = await createTestUser('peserta');
    peserta2 = await createTestUser('peserta');

    // Create an assessment owned by peserta1 (test purposes — submit-assessment
    // doesn't check ownership, just needs valid FK)
    const svc = serviceClient();
    const { data: assessment, error } = await svc.from('assessments')
      .insert({
        access_code: String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
        created_by: peserta1.id,
        created_by_email: peserta1.email,
        title: 'Submit Test Assessment',
        subject: 'Test',
        duration_minutes: 30,
        access_mode: 'manual',
        sections: [{
          id: 1,
          name: 'Bagian 1',
          type_question: 'PG',
          questions: [
            { idq: 1, pertanyaan: 'q1?', pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' }, jawaban_benar: 'D', skor: 34 },
            { idq: 2, pertanyaan: 'q2?', pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' }, jawaban_benar: 'B', skor: 33 },
            { idq: 3, pertanyaan: 'q3?', pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' }, jawaban_benar: 'C', skor: 33 },
          ],
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
    const admin = serviceClient();
    if (assessmentId) {
      // Deleting assessment cascades to sessions + submissions
      await admin.from('assessments').delete().eq('id', assessmentId);
    }
    await cleanupTestUser(peserta1.id);
    await cleanupTestUser(peserta2.id);
  });

  async function createSession(peserta) {
    const res = await postgrest(
      'POST',
      'assessment_sessions',
      peserta.jwt,
      {
        assessment_id: assessmentId,
        user_id: peserta.id,
        status: 'active',
        identity_snapshot: { nama: 'Vitest Tester' },
        user_email: peserta.email,
        started_at: new Date().toISOString(),
        attempt_number: 1,
      }
    );
    if (!res.ok) throw new Error(`session create failed: ${JSON.stringify(res.data)}`);
    return res.data[0].id;
  }

  it('rejects invalid session_id (404)', async () => {
    const res = await invokeEF('submit-assessment', peserta1.jwt, {
      session_id: '00000000-0000-0000-0000-000000000000',
      answers: CORRECT_ANSWERS,
      duration_seconds: 60,
    });
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe('NOT_FOUND');
  });

  it('rejects missing session_id (400)', async () => {
    const res = await invokeEF('submit-assessment', peserta1.jwt, {
      answers: CORRECT_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid section key format (400 — ALB-SEC-018)', async () => {
    const res = await invokeEF('submit-assessment', peserta1.jwt, {
      session_id: '00000000-0000-0000-0000-000000000000',
      answers: { 'evil_section': { '1': 'A' } },
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('VALIDATION_ERROR');
    expect(res.data.error.message).toContain('Invalid answer section key');
  });

  it('scores CORRECT answers → score=100, correct=3/3', async () => {
    session1 = await createSession(peserta1);

    const res = await invokeEF('submit-assessment', peserta1.jwt, {
      session_id: session1,
      answers: CORRECT_ANSWERS,
      duration_seconds: 300,
      violation_count: 0,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.score).toBe(100);
    expect(res.data.data.correct_count).toBe(3);
    expect(res.data.data.total_count).toBe(3);
  });

  it('updates session status to "submitted" after submit', async () => {
    const admin = serviceClient();
    const { data } = await admin.from('assessment_sessions')
      .select('status,submitted_at')
      .eq('id', session1)
      .maybeSingle();
    expect(data.status).toBe('submitted');
    expect(data.submitted_at).toBeTruthy();
  });

  it('is idempotent — re-submit returns existing submission, no duplicate', async () => {
    const admin = serviceClient();
    const before = await admin.from('submissions')
      .select('id', { count: 'exact' })
      .eq('session_id', session1);
    const countBefore = before.count;

    const res = await invokeEF('submit-assessment', peserta1.jwt, {
      session_id: session1,
      answers: CORRECT_ANSWERS,
      duration_seconds: 300,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.score).toBe(100);

    const after = await admin.from('submissions')
      .select('id', { count: 'exact' })
      .eq('session_id', session1);
    expect(after.count).toBe(countBefore);
  });

  it('scores WRONG answers → score=0, correct=0/3', async () => {
    session2 = await createSession(peserta2);

    const res = await invokeEF('submit-assessment', peserta2.jwt, {
      session_id: session2,
      answers: WRONG_ANSWERS,
      duration_seconds: 600,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.score).toBe(0);
    expect(res.data.data.correct_count).toBe(0);
    expect(res.data.data.total_count).toBe(3);
  });
});
