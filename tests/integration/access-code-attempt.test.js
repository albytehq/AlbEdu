// tests/integration/access-code-attempt.test.js
// Tests access-code-attempt EF — rate limiting, exponential backoff

import { describe, it, expect } from 'vitest';
import { invokeEF } from './_helpers.js';

describe('access-code-attempt EF', () => {
  const ts = Date.now();

  it('allows first attempt (200) with form_open_ms >= 1000', async () => {
    const res = await invokeEF('access-code-attempt', null, {
      device_id: `vitest-${ts}`,
      fingerprint_hash: `fp-${ts}`,
      form_open_ms: 2000,  // > 1000ms = human speed
    }, { origin: globalThis.ORIGIN });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.allowed).toBe(true);
    expect(res.data.data.attempts_remaining).toBeLessThanOrEqual(5);
  });

  it('rejects form_open_ms < 1000 (bot speed — 429)', async () => {
    const res = await invokeEF('access-code-attempt', null, {
      device_id: `vitest-fast-${ts}`,
      fingerprint_hash: `fp-fast-${ts}`,
      form_open_ms: 500,  // < 1000ms = bot
    }, { origin: globalThis.ORIGIN });

    expect(res.status).toBe(429);
    expect(res.data.error.code).toBe('TOO_FAST');
  });

  it('URL-encodes IP in PostgREST filter (ALB-SEC-011 regression test)', async () => {
    // This test passes as long as EF doesn't crash with 500.
    // Pre-fix, this would crash because IP filter wasn't URL-encoded.
    const res = await invokeEF('access-code-attempt', null, {
      device_id: `vitest-enc-${ts}`,
      form_open_ms: 2000,
    }, { origin: globalThis.ORIGIN });

    // Should NOT be 500 (Internal Error)
    expect(res.status).not.toBe(500);
  });
});
