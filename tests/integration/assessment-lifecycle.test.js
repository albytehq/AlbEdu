// tests/integration/assessment-lifecycle.test.js
// Tests assessment-lifecycle EF — start → pause → resume → finish

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('assessment-lifecycle EF', () => {
  let admin;
  let assessmentId;

  beforeAll(async () => {
    admin = await createTestUser('admin');

    // Create an assessment owned by this admin (so lifecycle works)
    const svc = serviceClient();
    const { data: assessment, error } = await svc.from('assessments')
      .insert({
        access_code: String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
        created_by: admin.id,
        created_by_email: admin.email,
        title: 'Lifecycle Test Assessment (vitest)',
        subject: 'Test Subject',
        duration_minutes: 30,
        access_mode: 'manual',
        sections: [{
          id: 1,
          name: 'Section 1',
          type_question: 'PG',
          questions: [{
            idq: 1,
            pertanyaan: 'Test question?',
            pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' },
            jawaban_benar: 'A',
            skor: 100,
          }],
        }],
        status: 'active',
        ac_manual_status: 'closed',
      })
      .select('id,access_code')
      .single();
    expect(error).toBeNull();
    assessmentId = assessment.id;
  });

  afterAll(async () => {
    const svc = serviceClient();
    if (assessmentId) {
      // Cleanup: delete assessment (cascade deletes sessions, submissions)
      await svc.from('assessments').delete().eq('id', assessmentId);
    }
    await cleanupTestUser(admin.id);
  });

  it('rejects invalid action (400)', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'invalid_action',
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-existent assessment (404)', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: '00000000-0000-0000-0000-000000000000',
      action: 'start',
    });
    expect(res.status).toBe(404);
  });

  it('starts a closed assessment → ac_manual_status=open, ac_end set', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'start',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.ac_manual_status).toBe('open');
    expect(res.data.data.ac_end).toBeTruthy();

    // Verify DB
    const svc = serviceClient();
    const { data: after } = await svc.from('assessments')
      .select('ac_manual_status,ac_end,ac_remaining_time')
      .eq('id', assessmentId)
      .maybeSingle();
    expect(after.ac_manual_status).toBe('open');
    expect(after.ac_end).toBeTruthy();
    expect(after.ac_remaining_time).toBeNull();
  });

  it('rejects double-start (409 conflict)', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'start',
    });
    expect(res.status).toBe(409);
  });

  it('pauses a running assessment → ac_manual_status=closed, ac_remaining_time set', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'pause',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.ac_manual_status).toBe('closed');
    expect(res.data.data.ac_remaining_time).toBeGreaterThan(0);

    // Verify DB
    const svc = serviceClient();
    const { data: after } = await svc.from('assessments')
      .select('ac_manual_status,ac_end,ac_remaining_time')
      .eq('id', assessmentId)
      .maybeSingle();
    expect(after.ac_manual_status).toBe('closed');
    expect(after.ac_end).toBeNull();
    expect(after.ac_remaining_time).toBeGreaterThan(0);
  });

  it('resumes a paused assessment → ac_manual_status=open, ac_end recalculated', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'resume',
    });

    expect(res.status).toBe(200);
    expect(res.data.data.ac_manual_status).toBe('open');
    expect(res.data.data.ac_end).toBeTruthy();
  });

  it('finishes a running assessment → ac_manual_status=finished', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'finish',
    });

    expect(res.status).toBe(200);
    expect(res.data.data.ac_manual_status).toBe('finished');

    // Verify DB
    const svc = serviceClient();
    const { data: after } = await svc.from('assessments')
      .select('ac_manual_status,ac_end,ac_remaining_time')
      .eq('id', assessmentId)
      .maybeSingle();
    expect(after.ac_manual_status).toBe('finished');
    expect(after.ac_remaining_time).toBeNull();
  });

  it('finish is idempotent — re-finish returns 200 with idempotent=true', async () => {
    const res = await invokeEF('assessment-lifecycle', admin.jwt, {
      assessment_id: assessmentId,
      action: 'finish',
    });
    expect(res.status).toBe(200);
    expect(res.data.data.idempotent).toBe(true);
  });
});
