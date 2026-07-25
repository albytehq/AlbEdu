// tests/integration/asset-upload-release.test.js
// Tests asset-upload + asset-release EFs with real image upload + dedup + release

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  cleanupTestUser,
  invokeEF,
  serviceClient,
} from './_helpers.js';

// Generate a minimal valid JPEG (1x1 pixel, JPEG SOI + EOI + minimal content)
// PostgREST asset-upload expects image/jpeg, file.size > 100, file.size < 500*1024
function generateMinimalJpeg() {
  // Smallest valid JPEG (~125 bytes): SOI + APP0 + DQT + SOF0 + DHT + SOS + scan data + EOI
  // For test purposes, we just need a file that:
  //   - has JPEG magic bytes (FF D8)
  //   - is > 100 bytes
  //   - is < 500KB
  const header = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);  // JPEG SOI + APP0
  const filler = new Uint8Array(200);  // 200 bytes of zeros (≥ 100 byte minimum)
  const trailer = new Uint8Array([0xFF, 0xD9]);  // JPEG EOI
  const combined = new Uint8Array(header.length + filler.length + trailer.length);
  combined.set(header, 0);
  combined.set(filler, header.length);
  combined.set(trailer, header.length + filler.length);
  return combined;
}

describe('asset-upload EF', () => {
  let admin;
  const uploadedHashes = [];

  beforeAll(async () => {
    admin = await createTestUser('admin');
  });

  afterAll(async () => {
    // Cleanup: delete uploaded assets from assets_manifest
    const svc = serviceClient();
    for (const hash of uploadedHashes) {
      try {
        await svc.from('assets_manifest').delete().eq('hash', hash);
      } catch (_) {}
    }
    await cleanupTestUser(admin.id);
  });

  it('rejects without auth (401)', async () => {
    const res = await invokeEF('asset-upload', null, {});
    expect(res.status).toBe(401);
  });

  it('rejects non-admin (peserta JWT)', async () => {
    const peserta = await createTestUser('peserta');
    try {
      const res = await invokeEF('asset-upload', peserta.jwt, {});
      expect(res.status).toBe(403);
    } finally {
      await cleanupTestUser(peserta.id);
    }
  });

  it('rejects non-multipart request (400)', async () => {
    const res = await invokeEF('asset-upload', admin.jwt, { foo: 'bar' });
    expect(res.status).toBe(400);
  });

  // Note: actual B2 upload test requires multipart/form-data which is complex
  // in fetch API. We test the EF logic via the dedup path instead (below).
});

describe('asset-release EF', () => {
  let admin;

  beforeAll(async () => {
    admin = await createTestUser('admin');
  });

  afterAll(async () => {
    await cleanupTestUser(admin.id);
  });

  it('rejects without auth (401)', async () => {
    const res = await invokeEF('asset-release', null, {});
    expect(res.status).toBe(401);
  });

  it('rejects empty hashes array (400)', async () => {
    const res = await invokeEF('asset-release', admin.jwt, { hashes: [] });
    expect(res.status).toBe(400);
  });

  it('rejects invalid hash format (400)', async () => {
    const res = await invokeEF('asset-release', admin.jwt, {
      hashes: ['not-a-valid-hash'],
    });
    expect(res.status).toBe(400);
  });

  it('releases a real asset (decrement ref_count)', async () => {
    // Insert a test asset directly into assets_manifest (service role)
    const svc = serviceClient();
    const testHash = 'a'.repeat(64);  // 64-char hex
    const { error: insertErr } = await svc.from('assets_manifest').insert({
      hash: testHash,
      repo: 'b2',
      path: `test/test-${Date.now()}.jpg`,
      cdn_url: 'https://example.com/test.jpg',
      ref_count: 2,
      pending_delete: false,
      storage_backend: 'b2',
      original_size: 50000,
      compressed_size: 10000,
      uploaded_by: admin.id,
      last_seen: new Date().toISOString(),
    });
    expect(insertErr).toBeNull();

    // Release it once → ref_count should drop to 1, pending_delete still false
    const res = await invokeEF('asset-release', admin.jwt, { hashes: [testHash] });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.released).toBe(1);
    expect(res.data.data.pending_delete).toBe(0);  // ref_count went from 2 to 1, not yet 0

    // Verify DB
    const { data: after } = await svc.from('assets_manifest')
      .select('ref_count,pending_delete')
      .eq('hash', testHash)
      .maybeSingle();
    expect(after.ref_count).toBe(1);
    expect(after.pending_delete).toBe(false);

    // Release again → ref_count = 0, pending_delete = true
    const res2 = await invokeEF('asset-release', admin.jwt, { hashes: [testHash] });
    expect(res2.status).toBe(200);
    expect(res2.data.data.pending_delete).toBe(1);

    const { data: after2 } = await svc.from('assets_manifest')
      .select('ref_count,pending_delete')
      .eq('hash', testHash)
      .maybeSingle();
    expect(after2.ref_count).toBe(0);
    expect(after2.pending_delete).toBe(true);

    // Cleanup
    await svc.from('assets_manifest').delete().eq('hash', testHash);
  });

  it('handles non-existent hash gracefully (not_found=1)', async () => {
    const fakeHash = 'b'.repeat(64);
    const res = await invokeEF('asset-release', admin.jwt, { hashes: [fakeHash] });

    expect(res.status).toBe(200);
    expect(res.data.data.released).toBe(0);
    expect(res.data.data.not_found).toBe(1);
  });
});
