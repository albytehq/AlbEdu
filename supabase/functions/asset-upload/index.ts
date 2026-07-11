// asset-upload/index.ts — Upload assessment images to BackBlaze B2.
//
// v0.821.1: Converted from `export default handler(...)` to `serve()` pattern
// because the handler() wrapper causes the deployed EF to hang on OPTIONS
// (CORS preflight). The serve() pattern is used by the 3 working auth EFs.
//
// POST /functions/v1/asset-upload
// Headers: Authorization: Bearer <admin-JWT>, apikey: <anon-key>
// Body: multipart/form-data with "file" field (compressed JPEG, ≤500 KB)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, withCors, corsHeaders } from '../_shared/cors.ts';
import { handleError, HTTPError, successResponse } from '../_shared/error.ts';
import { requireAdmin } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import { b2PutObject, isB2Configured } from '../_shared/b2.ts';
import type { Env } from '../_shared/types.ts';

const MAX_UPLOAD_SIZE = 500 * 1024;
const ALLOWED_MIME = ['image/jpeg'];

serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const env = Deno.env.toObject() as unknown as Env;

  if (req.method === 'OPTIONS') return handleOptions(req);

  try {
    const res = await logic(req, env);
    return withCors(res, origin);
  } catch (err) {
    return withCors(handleError(err), origin);
  }
});

async function logic(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // 1. Auth
  const admin = await requireAdmin(req, env);

  // 2. B2 config check
  if (!isB2Configured(env)) {
    throw new HTTPError(500, 'INTERNAL_ERROR', 'B2 storage not configured.');
  }

  // 3. Parse multipart
  const formData = await req.formData().catch(() => null);
  if (!formData) throw new HTTPError(400, 'VALIDATION_ERROR', 'Expected multipart/form-data');

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'Missing "file" field');
  }

  // 4. Validate
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new HTTPError(413, 'PAYLOAD_TOO_LARGE', `File too large (${file.size}). Max 500KB.`);
  }
  if (file.size < 100) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'File too small');
  }

  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.includes(contentType)) {
    throw new HTTPError(415, 'VALIDATION_ERROR', `Unsupported MIME: ${contentType}. Expected image/jpeg.`);
  }

  // 5. Hash
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBytes);
  const hash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

  const originalSize = parseInt(formData.get('original_size') as string) || file.size;
  const compressedSize = file.size;
  const qualityUsed = parseFloat(formData.get('quality_used') as string) || null;

  const db = new SupabaseDB(env);

  // 6. Dedup
  const existing = await db.selectOne<any>('assets_manifest', `hash,cdn_url,ref_count,pending_delete&hash=eq.${hash}`);
  if (existing) {
    const newRef = (existing.ref_count || 0) + 1;
    await db.update('assets_manifest', `hash=eq.${hash}`, { ref_count: newRef, pending_delete: false, last_seen: new Date().toISOString() });
    logAudit(env, { action: 'ASSET_UPLOAD_DEDUP', targetType: 'asset', targetId: hash, metadata: { dedup: true, ref_count_after: newRef }, actorId: admin.id, actorEmail: admin.email, actorRole: 'admin', ipAddress: getClientIP(req), userAgent: getUserAgent(req) });
    return successResponse({ hash, cdn_url: existing.cdn_url, original_size: originalSize, compressed_size: compressedSize, dedup: true, ref_count: newRef });
  }

  // 7. Upload to B2
  const b2Path = `${hash.slice(0, 2)}/${hash}.jpg`;
  const cdnUrl = `${env.CF_WORKER_URL || 'https://edu.albyte-inc.workers.dev'}/img/${hash}`;
  try {
    await b2PutObject(b2Path, fileBytes, 'image/jpeg', env);
  } catch (err) {
    throw new HTTPError(502, 'INTERNAL_ERROR', `B2 upload failed: ${err.message}`);
  }

  // 8. INSERT manifest
  await db.insert('assets_manifest', {
    hash, repo: 'b2', path: b2Path, cdn_url: cdnUrl, ref_count: 1, pending_delete: false,
    storage_backend: 'b2', original_size: originalSize, compressed_size: compressedSize,
    compression_ratio: compressedSize / originalSize, quality_used: qualityUsed,
    uploaded_by: admin.id, created_at: new Date().toISOString(), last_seen: new Date().toISOString(),
  });

  // 9. Audit
  logAudit(env, { action: 'ASSET_UPLOAD', targetType: 'asset', targetId: hash, metadata: { original_size: originalSize, compressed_size: compressedSize, compression_ratio: +(compressedSize / originalSize).toFixed(4), quality_used: qualityUsed, b2_path: b2Path, dedup: false }, actorId: admin.id, actorEmail: admin.email, actorRole: 'admin', ipAddress: getClientIP(req), userAgent: getUserAgent(req) });

  return successResponse({ hash, cdn_url: cdnUrl, original_size: originalSize, compressed_size: compressedSize, compression_ratio: +(compressedSize / originalSize).toFixed(4), quality_used: qualityUsed, dedup: false, ref_count: 1 });
}
