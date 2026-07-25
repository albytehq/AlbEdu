// tests/integration/health-check.test.js
// Tests health-check EF — DB warm-keeper

import { describe, it, expect } from 'vitest';
import { invokeEF } from './_helpers.js';

describe('health-check EF', () => {
  it('returns 200 with db=healthy', async () => {
    // health-check is verify_jwt=false, so we pass null JWT
    const res = await invokeEF('health-check', null, {});

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.db).toBe('healthy');
    expect(res.data.has_url).toBe(true);
    expect(res.data.has_key).toBe(true);
    expect(res.data.has_secret).toBe(true);
    expect(res.data.latency_ms).toBeGreaterThan(0);
    expect(res.data.latency_ms).toBeLessThan(3000);  // should be <3s
    expect(res.data.time).toBeTruthy();
  });

  it('responds in under 3s (DB warm-keeper requirement)', async () => {
    const start = Date.now();
    await invokeEF('health-check', null, {});
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(3000);
  });
});
