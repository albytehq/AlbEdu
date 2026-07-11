// asset-release/index.ts — Release assessment images (decrement ref_count).
//
// v0.821.1: Converted to serve() pattern (fixes OPTIONS hang).
//
// POST /functions/v1/asset-release
// Headers: Authorization: Bearer <JWT>, apikey: <anon-key>
// Body: { hashes: ["hash1", "hash2", ...] }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, withCors } from '../_shared/cors.ts';
import { handleError, HTTPError, successResponse } from '../_shared/error.ts';
import { requireAnyRole } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { logAudit, getClientIP, getUserAgent } from '../_shared/audit.ts';
import type { Env } from '../_shared/types.ts';

const MAX_HASHES_PER_CALL = 50;

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

  const user = await requireAnyRole(req, env);

  let body: { hashes?: string[] };
  try { body = await req.json(); }
  catch { throw new HTTPError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }

  if (!Array.isArray(body.hashes) || body.hashes.length === 0) {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'hashes must be a non-empty array');
  }
  if (body.hashes.length > MAX_HASHES_PER_CALL) {
    throw new HTTPError(400, 'VALIDATION_ERROR', `Too many hashes. Max ${MAX_HASHES_PER_CALL}.`);
  }
  for (const h of body.hashes) {
    if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) {
      throw new HTTPError(400, 'VALIDATION_ERROR', `Invalid hash format`);
    }
  }

  const db = new SupabaseDB(env);
  let released = 0, pendingDelete = 0, notFound = 0;

  for (const hash of body.hashes) {
    const row = await db.selectOne<any>('assets_manifest', `hash,ref_count,pending_delete&hash=eq.${hash}`);
    if (!row) { notFound++; continue; }
    const newRef = Math.max(0, (row.ref_count || 0) - 1);
    const shouldPending = newRef === 0;
    await db.update('assets_manifest', `hash=eq.${hash}`, { ref_count: newRef, pending_delete: shouldPending, last_seen: new Date().toISOString() });
    released++;
    if (shouldPending) pendingDelete++;
  }

  logAudit(env, { action: 'ASSET_RELEASE', targetType: 'asset', targetId: body.hashes.join(',').slice(0, 255), metadata: { count: body.hashes.length, released, pending_delete: pendingDelete, not_found: notFound }, actorId: user.id, actorEmail: user.email, actorRole: user.role || 'unknown', ipAddress: getClientIP(req), userAgent: getUserAgent(req) });

  return successResponse({ released, pending_delete: pendingDelete, not_found: notFound, total: body.hashes.length });
}
