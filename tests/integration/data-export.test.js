// tests/integration/data-export.test.js
// Tests data-export EF — UU PDP portability

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('data-export EF', () => {
  let peserta;

  beforeAll(async () => {
    peserta = await createTestUser('peserta');
  });

  afterAll(async () => {
    await cleanupTestUser(peserta.id);
  });

  it('returns full data export (200)', async () => {
    const res = await invokeEF('data-export', peserta.jwt, {});

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toHaveProperty('exported_at');
    expect(res.data.data).toHaveProperty('user');
    expect(res.data.data).toHaveProperty('submissions');
    expect(res.data.data).toHaveProperty('violations');
    expect(res.data.data).toHaveProperty('audit_logs');
    expect(res.data.data).toHaveProperty('consents');
    expect(res.data.data).toHaveProperty('data_subject_requests');
    expect(res.data.data).toHaveProperty('retention_policy');
  });

  it('exports user profile with correct id', async () => {
    const res = await invokeEF('data-export', peserta.jwt, {});
    expect(res.data.data.user.id).toBe(peserta.id);
    expect(res.data.data.user.email).toBe(peserta.email);
    expect(res.data.data.user.peran).toBe('peserta');
  });

  it('retention_policy documents 90-day violations + 1-year audit_logs', async () => {
    const res = await invokeEF('data-export', peserta.jwt, {});
    expect(res.data.data.retention_policy.violations).toBe('90 days');
    expect(res.data.data.retention_policy.audit_logs).toBe('1 year');
    expect(res.data.data.retention_policy.submissions).toBe('3 years');
  });
});
