// asset-upload/index.ts — Upload assessment images to BackBlaze B2.
//
// POST /functions/v1/asset-upload
// Headers: Authorization: Bearer <admin-JWT>
// Body: multipart/form-data with "file" field (compressed JPEG, ≤500 KB)
//
// Flow:
//   1. Verify JWT + role=admin
//   2. Rate limit: 20 uploads/minute per admin
//   3. Parse multipart form data
//   4. Validate: size ≤500 KB, MIME = image/jpeg
//   5. Compute SHA-256 hash
//   6. Check assets_manifest for existing hash (dedup)
//      → If found: increment ref_count, return existing cdn_url
//   7. If new: upload to B2 via S3 PUT (path: {hash[0:2]}/{hash}.jpg)
//   8. INSERT into assets_manifest
//   9. Log to audit_logs
//   10. Return { hash, cdn_url, original_size, compressed_size }
//
// v0.821.0: Phase 2 — assessment image upload via B2

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { b2PutObject, isB2Configured } from '../_shared/b2.ts';
import type { Env } from '../_shared/types.ts';

const MAX_UPLOAD_SIZE = 500 * 1024;  // 500 KB (post-compression, client should compress)
const ALLOWED_MIME = ['image/jpeg'];

export default handler(async (req: Request, env: Env, _ctx: any) => {
  // ── 1. Auth: admin only ──
  const admin = await requireAdmin(req, env);

  // ── 2. Validate B2 configured ──
  if (!isB2Configured(env)) {
    throw new HTTPError(500, 'INTERNAL_ERROR',
      'B2 storage not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_ENDPOINT, B2_REGION in Supabase secrets.');
  }

  // ── 3. Parse multipart form data ──
  const formData = await req.formData().catch(() => null);
  if (!formData) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'Expected multipart/form-data');
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'Missing "file" field in form data');
  }

  // ── 4. Validate file ──
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new HTTPError(413, 'PAYLOAD_TOO_LARGE',
      `File too large (${file.size} bytes). Max ${MAX_UPLOAD_SIZE} bytes (500 KB). Compress with Magic Compress™ before uploading.`);
  }

  if (file.size < 1024) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'File too small (minimum 1 KB)');
  }

  // MIME check — be strict (client should send JPEG after Magic Compress™)
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.includes(contentType)) {
    throw new HTTPError(415, 'VALIDATION_ERROR',
      `Unsupported MIME type: ${contentType}. Expected image/jpeg (Magic Compress™ converts all formats to JPEG).`);
  }

  // ── 5. Read file bytes + compute SHA-256 ──
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const originalSize = parseInt(formData.get('original_size') as string) || file.size;
  const compressedSize = file.size;
  const qualityUsed = parseFloat(formData.get('quality_used') as string) || null;

  const db = new SupabaseDB(env);

  // ── 6. Dedup check ──
  const existing = await db.selectOne<any>(
    'assets_manifest',
    `hash,cdn_url,ref_count,pending_delete&hash=eq.${hash}`
  );

  if (existing) {
    // Asset already exists — increment ref_count, clear pending_delete
    const newRef = (existing.ref_count || 0) + 1;
    await db.update(
      'assets_manifest',
      `hash=eq.${hash}`,
      {
        ref_count: newRef,
        pending_delete: false,
        last_seen: new Date().toISOString(),
      }
    );

    logAudit(env, {
      action: 'ASSET_UPLOAD_DEDUP',
      targetType: 'asset',
      targetId: hash,
      metadata: {
        original_size: originalSize,
        compressed_size: compressedSize,
        ref_count_after: newRef,
        dedup: true,
      },
      actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
      ipAddress: getClientIP(req), userAgent: getUserAgent(req),
    });

    return successResponse({
      hash,
      cdn_url: existing.cdn_url,
      original_size: originalSize,
      compressed_size: compressedSize,
      dedup: true,
      ref_count: newRef,
    });
  }

  // ── 7. Upload to B2 ──
  const b2Path = `${hash.slice(0, 2)}/${hash}.jpg`;
  const bucket = env.B2_BUCKET_NAME;
  const cdnUrl = `${env.CF_WORKER_URL || 'https://edu.albyte-inc.workers.dev'}/img/${hash}`;

  try {
    await b2PutObject(b2Path, fileBytes, 'image/jpeg', env);
  } catch (err) {
    console.error('[asset-upload] B2 upload failed:', err.message);
    throw new HTTPError(502, 'INTERNAL_ERROR', `B2 upload failed: ${err.message}`);
  }

  // ── 8. INSERT into assets_manifest ──
  await db.insert('assets_manifest', {
    hash,
    repo: 'b2',
    path: b2Path,
    cdn_url: cdnUrl,
    ref_count: 1,
    pending_delete: false,
    storage_backend: 'b2',
    original_size: originalSize,
    compressed_size: compressedSize,
    compression_ratio: compressedSize / originalSize,
    quality_used: qualityUsed,
    uploaded_by: admin.id,
    created_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  });

  // ── 9. Audit log ──
  logAudit(env, {
    action: 'ASSET_UPLOAD',
    targetType: 'asset',
    targetId: hash,
    metadata: {
      original_size: originalSize,
      compressed_size: compressedSize,
      compression_ratio: +(compressedSize / originalSize).toFixed(4),
      quality_used: qualityUsed,
      b2_path: b2Path,
      dedup: false,
    },
    actorId: admin.id, actorEmail: admin.email, actorRole: 'admin',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  // ── 10. Return ──
  return successResponse({
    hash,
    cdn_url: cdnUrl,
    original_size: originalSize,
    compressed_size: compressedSize,
    compression_ratio: +(compressedSize / originalSize).toFixed(4),
    quality_used: qualityUsed,
    dedup: false,
    ref_count: 1,
  });
});
