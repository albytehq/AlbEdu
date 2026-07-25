// tests/integration/heartbeat.test.js
// Tests heartbeat EF — block detection, status transitions

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
  TEST_ASSESSMENT_ID,
} from './_helpers.js';

describe('heartbeat EF', () => {
  let peserta;
  let sessionId;

  beforeAll(async () => {
    peserta = await createTestUser('peserta');
  });

  afterAll(async () => {
    const admin = serviceClient();
    if (sessionId) {
      await admin.from('assessment_sessions').delete().eq('id', sessionId);
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
    // Create session via PostgREST (RLS allows peserta to insert own)
    const admin = serviceClient();
    const { data: sessionData, error } = await admin.from('assessment_sessions')
      .insert({
        assessment_id: TEST_ASSESSMENT_ID,
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

    // Get initial heartbeat_at
    const before = await admin.from('assessment_sessions')
      .select('last_heartbeat_at,current_question,progress_pct')
      .eq('id', sessionId)
      .maybeSingle();
    const initialHb = before.data.last_heartbeat_at;

    // Wait 1.1s to ensure timestamp differs
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

    // Verify session was updated
    const after = await admin.from('assessment_sessions')
      .select('last_heartbeat_at,current_question,progress_pct,draft_answers')
      .eq('id', sessionId)
      .maybeSingle();

    expect(after.data.last_heartbeat_at).not.toBe(initialHb);
    expect(after.data.current_question).toBe(2);
    // progress_pct is numeric(5,2) — PostgREST may return as number or string
    expect(Number(after.data.progress_pct)).toBe(67);
    expect(after.data.draft_answers.section_0['1']).toBe('D');
  });
});
