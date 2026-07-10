// asset-release/index.ts — Release assessment images (decrement ref_count).
//
// POST /functions/v1/asset-release
// Headers: Authorization: Bearer <admin-JWT>
// Body: { hashes: ["hash1", "hash2", ...] }
//
// Flow:
//   1. Verify JWT (admin or peserta — both can release images they uploaded)
//   2. Validate: hashes array, max 50 per call
//   3. For each hash:
//      a. UPDATE assets_manifest SET ref_count = GREATEST(0, ref_count - 1)
//      b. If new ref_count == 0: SET pending_delete = true
//   4. Log to audit_logs
//   5. Return { released: N, pending_delete: M }
//
// Called from:
//   - soal-card.js (delete question with images)
//   - create-assessment.js (delete section with questions)
//   - wizard-controller.js (cancel wizard — release draft images)
//
// v0.821.0: Phase 2

import { handler } from '../_shared/cors.ts';
import { HTTPError, successResponse } from '../_shared/error.ts';
import { requireAnyRole } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import type { Env } from '../_shared/types.ts';

const MAX_HASHES_PER_CALL = 50;

interface ReleaseBody {
  hashes?: string[];
}

export default handler(async (req: Request, env: Env, _ctx: any) => {
  const user = await requireAnyRole(req, env);

  let body: ReleaseBody;
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!Array.isArray(body.hashes) || body.hashes.length === 0) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'hashes must be a non-empty array');
  }

  if (body.hashes.length > MAX_HASHES_PER_CALL) {
    throw new HTTPError(400, 'VALIDATION_ERROR',
      `Too many hashes (${body.hashes.length}). Max ${MAX_HASHES_PER_CALL} per call.`);
  }

  // Validate hash format (64 hex chars = SHA-256)
  for (const h of body.hashes) {
    if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) {
      throw new HTTPError(400, 'VALIDATION_ERROR', `Invalid hash format: ${h?.slice(0, 20)}...`);
    }
  }

  const db = new SupabaseDB(env);
  let released = 0;
  let pendingDelete = 0;
  let notFound = 0;
  const results: { hash: string; status: string; ref_count?: number }[] = [];

  for (const hash of body.hashes) {
    // Fetch current ref_count
    const row = await db.selectOne<any>(
      'assets_manifest',
      `hash,ref_count,pending_delete&hash=eq.${hash}`
    );

    if (!row) {
      notFound++;
      results.push({ hash, status: 'not_found' });
      continue;
    }

    // Decrement with GREATEST(0, ...) clamp — prevents negative ref_count
    const newRef = Math.max(0, (row.ref_count || 0) - 1);
    const shouldPending = newRef === 0;

    await db.update(
      'assets_manifest',
      `hash=eq.${hash}`,
      {
        ref_count: newRef,
        pending_delete: shouldPending,
        last_seen: new Date().toISOString(),
      }
    );

    released++;
    if (shouldPending) pendingDelete++;

    results.push({
      hash,
      status: 'released',
      ref_count: newRef,
    });
  }

  // Audit log
  logAudit(env, {
    action: 'ASSET_RELEASE',
    targetType: 'asset',
    targetId: body.hashes.join(',').slice(0, 255), // truncate for target_id
    metadata: {
      count: body.hashes.length,
      released,
      pending_delete: pendingDelete,
      not_found: notFound,
      hashes: body.hashes,
    },
    actorId: user.id, actorEmail: user.email, actorRole: user.role || 'unknown',
    ipAddress: getClientIP(req), userAgent: getUserAgent(req),
  });

  return successResponse({
    released,
    pending_delete: pendingDelete,
    not_found: notFound,
    total: body.hashes.length,
    results,
  });
});
