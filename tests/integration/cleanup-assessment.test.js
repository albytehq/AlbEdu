// tests/integration/cleanup-assessment.test.js
// Tests cleanup-assessment EF — archive

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('cleanup-assessment EF', () => {
  let admin;
  let assessmentId;

  beforeAll(async () => {
    admin = await createTestUser('admin');

    // Create an assessment owned by this admin
    const svc = serviceClient();
    const { data: assessment, error } = await svc.from('assessments')
      .insert({
        access_code: String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
        created_by: admin.id,
        created_by_email: admin.email,
        title: 'Cleanup Test Assessment (vitest)',
        subject: 'Test',
        duration_minutes: 30,
        access_mode: 'manual',
        sections: [],
        status: 'active',
        ac_manual_status: 'finished',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    assessmentId = assessment.id;
  });

  afterAll(async () => {
    const svc = serviceClient();
    if (assessmentId) {
      await svc.from('assessments').delete().eq('id', assessmentId);
    }
    await cleanupTestUser(admin.id);
  });

  it('rejects non-existent assessment (404)', async () => {
    const res = await invokeEF('cleanup-assessment', admin.jwt, {
      assessment_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('archives an assessment → status=archived', async () => {
    const res = await invokeEF('cleanup-assessment', admin.jwt, {
      assessment_id: assessmentId,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.status).toBe('archived');
    expect(res.data.data.archived_by).toBe(admin.email);

    // Verify DB
    const svc = serviceClient();
    const { data: after } = await svc.from('assessments')
      .select('status')
      .eq('id', assessmentId)
      .maybeSingle();
    expect(after.status).toBe('archived');
  });

  it('is idempotent — re-archive returns 200 with idempotent=true', async () => {
    const res = await invokeEF('cleanup-assessment', admin.jwt, {
      assessment_id: assessmentId,
    });
    expect(res.status).toBe(200);
    expect(res.data.data.idempotent).toBe(true);
  });
});
