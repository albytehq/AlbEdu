// tests/integration/dsr-handler.test.js
// Tests dsr-handler EF — UU PDP compliance

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

describe('dsr-handler EF', () => {
  let peserta;
  let dsrIds = [];

  beforeAll(async () => {
    peserta = await createTestUser('peserta');
  });

  afterAll(async () => {
    const admin = serviceClient();
    for (const id of dsrIds) {
      await admin.from('data_subject_requests').delete().eq('id', id);
    }
    await cleanupTestUser(peserta.id);
  });

  it('rejects invalid request_type (400)', async () => {
    const res = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'invalid_type',
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates access request (200) and returns dsr_id', async () => {
    const res = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'access',
      details: { reason: 'vitest smoke' },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.dsr_id).toBeTruthy();
    expect(res.data.data.status).toBe('pending');
    dsrIds.push(res.data.data.dsr_id);
  });

  it('is idempotent — second access request returns existing pending DSR', async () => {
    const res1 = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'access',
    });
    const res2 = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'access',
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res2.data.data.idempotent).toBe(true);
    expect(res1.data.data.dsr_id).toBe(res2.data.data.dsr_id);
    dsrIds.push(res1.data.data.dsr_id);
  });

  it('creates separate DSRs for different request types', async () => {
    const access = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'access',
    });
    const portability = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'portability',
    });

    expect(access.status).toBe(200);
    expect(portability.status).toBe(200);
    expect(access.data.data.dsr_id).not.toBe(portability.data.data.dsr_id);
    dsrIds.push(access.data.data.dsr_id, portability.data.data.dsr_id);
  });

  it('creates delete request with cascade avatar deletion attempt', async () => {
    const res = await invokeEF('dsr-handler', peserta.jwt, {
      request_type: 'delete',
      details: { reason: 'GDPR-style smoke test' },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.request_type).toBe('delete');
    // avatar_deleted field should be present (0 if no avatar)
    expect(res.data.data).toHaveProperty('avatar_deleted');
    dsrIds.push(res.data.data.dsr_id);
  });
});
