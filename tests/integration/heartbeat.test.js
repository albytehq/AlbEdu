// tests/integration/heartbeat.test.js
// Tests heartbeat EF — block detection, status transitions

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('heartbeat EF', () => {
  let peserta;
  let sessionId;
  let assessmentId;

  beforeAll(async () => {
    peserta = await createTestUser('peserta');

    // Create assessment owned by admin (any admin) — heartbeat doesn't check
    // ownership but needs valid assessment_id for FK
    const svc = serviceClient();
    const { data: assessment, error } = await svc.from('assessments')
      .insert({
        access_code: String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
        created_by: peserta.id,  // peserta is the "creator" for test purposes
        created_by_email: peserta.email,
        title: 'HB Test Assessment',
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
      // Deleting assessment cascades to sessions
      await svc.from('assessments').delete().eq('id', assessmentId);
    }
    await cleanupTestUser(peserta.id);
  });

  it('rejects missing session_id (400)', async () => {
    const res = await invokeEF('heartbeat', peserta.jwt, {});
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-existent session (404)', async () => {
    const res = await invokeEF('heartbeat', peserta.jwt, {
      session_id: '00000000-0000-0000-0000-000000000000',
      current_section: 0,
      current_question: 1,
      progress_pct: 50,
    });
    expect(res.status).toBe(404);
  });

  it('returns ok=true on active session + updates last_heartbeat_at', async () => {
    const svc = serviceClient();
    const { data: sessionData, error } = await svc.from('assessment_sessions')
      .insert({
        assessment_id: assessmentId,
        user_id: peserta.id,
        status: 'active',
        identity_snapshot: { nama: 'HB Tester' },
        user_email: peserta.email,
        started_at: new Date().toISOString(),
        attempt_number: 1,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    sessionId = sessionData.id;

    const before = await svc.from('assessment_sessions')
      .select('last_heartbeat_at,current_question,progress_pct')
      .eq('id', sessionId)
      .maybeSingle();
    const initialHb = before.data.last_heartbeat_at;

    await new Promise(r => setTimeout(r, 1100));

    const res = await invokeEF('heartbeat', peserta.jwt, {
      session_id: sessionId,
      current_section: 0,
      current_question: 2,
      progress_pct: 67,
      draft_answers: { section_0: { '1': 'D' } },
      violation_count: 0,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.ok).toBe(true);
    expect(res.data.data.blocked).toBe(false);

    const after = await svc.from('assessment_sessions')
      .select('last_heartbeat_at,current_question,progress_pct,draft_answers')
      .eq('id', sessionId)
      .maybeSingle();

    expect(after.data.last_heartbeat_at).not.toBe(initialHb);
    expect(after.data.current_question).toBe(2);
    expect(Number(after.data.progress_pct)).toBe(67);
    expect(after.data.draft_answers.section_0['1']).toBe('D');
  });
});
