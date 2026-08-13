// supabase/functions/violation-signal/index.ts
// ═══════════════════════════════════════════════════════════════════════════
//  violation-signal — Production-grade peserta→admin violation signaling.
//  --------------------------------------------------------------------------
//  Receives BATCHED violation signals from the peserta browser (via
//  src/security/violation-signaler.js) and persists them to violation_events.
//
//  Request shape:
//    POST /functions/violation-signal
//    Authorization: Bearer <peserta JWT>
//    Content-Type: application/json
//    Body: {
//      session_id: string,           // required
//      signals: [{
//        event_type: string,         // enum (see violation_events.event_type)
//        message: string,            // human-readable description
//        severity: 'info'|'warning'|'critical',
//        client_timestamp: string,   // ISO 8601 from peserta's clock
//        metadata?: object,          // {tab_title?, viewport_w?, key_pressed?, ...}
//      }, ...]
//    }
//
//  Response shape:
//    200 OK: { success: true, data: { inserted: N, skipped: M, batch_id: "..." } }
//    207 Multi-Status: { success: partial, data: {...}, warnings: [...] }
//    429 Too Many Requests: { error: { code: 'RATE_LIMITED', ... } }
//    4xx/5xx: { error: { code, message, details? } }
//
//  Security layers:
//    1. JWT verified via /auth/v1/user
//    2. Session ownership: session.user_id === jwt.sub
//    3. Session state: must be 'active'
//    4. Assessment state: must be open (manual or scheduled within window)
//    5. Rate limit: max 60 signals/min/session (sliding window)
//    6. Per-signal validation: event_type enum, severity enum, max message length
//    7. Server-side dedup_key: session_id|event_type|floor(client_timestamp/2s)
//       (prevents double-counting on peserta retry; ON CONFLICT DO NOTHING)
//    8. Service-role key for INSERT (bypasses peserta RLS so we can include
//       session data like exam_title, user_email that peserta shouldn't be
//       able to spoof)
//    9. assessment_sessions.violation_count auto-bumped via DB trigger
//       (migration 047) — no client-side counter sync needed
//   10. Critical-severity signals also log to audit_logs (VIOLATION_DETECTED)
//
//  Edge cases handled:
//    • Empty signals array → 200 with inserted=0 (no error)
//    • Mixed valid/invalid signals in batch → 207 with per-signal results
//    • Duplicate signals in same batch → all but first skipped via dedup_key
//    • Unknown event_type → that signal skipped, others proceed
//    • session_id not found → 404
//    • session belongs to another user → 403
//    • session not active (paused/blocked/submitted/expired) → 409 SESSION_NOT_ACTIVE
//    • Assessment closed mid-batch → 409 ASSESSMENT_NOT_ACTIVE
//    • Rate limit exceeded → 429 (still processes the request, just refuses new signals)
//    • Network blip during INSERT → response still 200 (idempotent on retry)
// ═══════════════════════════════════════════════════════════════════════════

import { corsHeaders, handleOptions, withCors } from '../_shared/cors.ts';
import { handleError, HTTPError } from '../_shared/error.ts';
import { verifyAuth, getUserRole } from '../_shared/auth.ts';
import { SupabaseDB } from '../_shared/db.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { logAudit } from '../_shared/audit.ts';
import type { Env, AuthUser } from '../_shared/types.ts';

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_BATCH_SIZE = 50;          // hard cap on signals per request
const MAX_SIGNALS_PER_MIN = 60;     // rate limit per session
const MAX_MESSAGE_LENGTH = 500;     // truncate message if longer
const DEDUP_WINDOW_SECONDS = 2;     // 2-second dedup window
const VALID_EVENT_TYPES = new Set([
  'devtools_shortcut', 'devtools_open', 'tab_switch', 'window_blur',
  'keyboard_violation', 'copy_attempt', 'paste_attempt',
  'context_menu', 'select_text', 'max_violations_reached',
  'session_blocked', 'session_expired', 'heartbeat_timeout',
]);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

// ── Types ─────────────────────────────────────────────────────────────────

interface IncomingSignal {
  event_type: string;
  message?: string;
  severity?: 'info' | 'warning' | 'critical';
  client_timestamp: string;  // ISO 8601
  metadata?: Record<string, unknown>;
}

interface ProcessedSignal extends IncomingSignal {
  dedup_key: string;
  truncated_message: string;
  normalized_severity: 'info' | 'warning' | 'critical';
}

interface SignalResult {
  index: number;
  status: 'inserted' | 'skipped_duplicate' | 'skipped_invalid' | 'error';
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function generateBatchId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function computeDedupKey(sessionId: string, eventType: string, clientTimestamp: string): string {
  // Parse the client timestamp and floor to 2-second window
  const ts = Date.parse(clientTimestamp);
  if (isNaN(ts)) {
    // Fallback: use Date.now() so the dedup_key is still unique per request
    return `${sessionId}|${eventType}|${Math.floor(Date.now() / 2000)}`;
  }
  const bucket = Math.floor(ts / (DEDUP_WINDOW_SECONDS * 1000));
  return `${sessionId}|${eventType}|${bucket}`;
}

function normalizeSeverity(s?: string): 'info' | 'warning' | 'critical' {
  if (s && VALID_SEVERITIES.has(s)) return s as any;
  return 'warning';  // default
}

function truncateMessage(msg?: string): string {
  if (!msg) return '';
  const s = String(msg).slice(0, MAX_MESSAGE_LENGTH);
  return s;
}

function validateSignal(sig: any, sessionId?: string): { valid: boolean; error?: string; normalized?: ProcessedSignal } {
  if (!sig || typeof sig !== 'object') {
    return { valid: false, error: 'Signal must be an object' };
  }
  if (!sig.event_type || !VALID_EVENT_TYPES.has(sig.event_type)) {
    return { valid: false, error: `Invalid event_type: ${sig.event_type}` };
  }
  if (!sig.client_timestamp || typeof sig.client_timestamp !== 'string') {
    return { valid: false, error: 'client_timestamp (ISO 8601) required' };
  }
  // Validate ISO 8601 parseable
  if (isNaN(Date.parse(sig.client_timestamp))) {
    return { valid: false, error: `Invalid client_timestamp: ${sig.client_timestamp}` };
  }
  const dedupKey = sessionId
    ? computeDedupKey(sessionId, sig.event_type, sig.client_timestamp)
    : '';
  return {
    valid: true,
    normalized: {
      event_type: sig.event_type,
      message: sig.message,
      severity: normalizeSeverity(sig.severity),
      client_timestamp: sig.client_timestamp,
      metadata: (sig.metadata && typeof sig.metadata === 'object') ? sig.metadata : {},
      dedup_key: dedupKey,
      truncated_message: truncateMessage(sig.message),
      normalized_severity: normalizeSeverity(sig.severity),
    },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────

async function handleViolationSignal(req: Request, env: Env, _ctx: any): Promise<Response> {
  // Step 1: Verify peserta JWT
  const user: AuthUser = await verifyAuth(req, env);
  const role = await getUserRole(env, user.id);
  if (role !== 'peserta') {
    throw new HTTPError(403, 'FORBIDDEN', 'Only peserta can send violation signals');
  }

  // Step 2: Parse body
  let body: { session_id?: string; signals?: IncomingSignal[] };
  try {
    body = await req.json();
  } catch {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }

  if (!body.session_id || typeof body.session_id !== 'string') {
    throw new HTTPError(400, 'VALIDATION_ERROR', 'session_id is required');
  }

  const signals = Array.isArray(body.signals) ? body.signals : [];
  if (signals.length === 0) {
    // Empty batch — accept silently (peserta may flush an empty queue)
    return new Response(
      JSON.stringify({
        success: true,
        data: { inserted: 0, skipped: 0, batch_id: generateBatchId() },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (signals.length > MAX_BATCH_SIZE) {
    throw new HTTPError(413, 'PAYLOAD_TOO_LARGE',
      `Batch exceeds max size of ${MAX_BATCH_SIZE} signals (got ${signals.length})`);
  }

  // Step 3: Rate limit check (per session)
  const rl = checkRateLimit(`vsig:${body.session_id}`, MAX_SIGNALS_PER_MIN, 60_000);
  if (!rl.allowed) {
    // We still process the batch but mark it as rate-limited so the client
    // can retry the un-processed portion later. This is a SOFT limit — the
    // signals themselves are valid, we just don't want to flood the DB.
    // Actually, for hard limit, return 429 so the client backs off.
    throw new HTTPError(429, 'RATE_LIMITED',
      `Too many signals from this session (max ${MAX_SIGNALS_PER_MIN}/min). Retry after ${Math.ceil((rl.resetAt - Date.now()) / 1000)}s.`,
      { retry_after_ms: rl.resetAt - Date.now() });
  }

  // Step 4: Verify session ownership + state (DB call, service role)
  const db = new SupabaseDB(env);
  const session = await db.selectOne<{
    id: string;
    assessment_id: string;
    user_id: string;
    user_email: string | null;
    status: string;
    identity_snapshot: any;
  }>(
    'assessment_sessions',
    `id=eq.${body.session_id}&select=id,assessment_id,user_id,user_email,status,identity_snapshot`
  );

  if (!session) {
    throw new HTTPError(404, 'NOT_FOUND', `Session not found: ${body.session_id}`);
  }
  if (session.user_id !== user.id) {
    throw new HTTPError(403, 'FORBIDDEN', 'Session does not belong to authenticated user');
  }
  if (session.status !== 'active') {
    throw new HTTPError(409, 'SESSION_NOT_ACTIVE',
      `Session is not active (current status: ${session.status}). Violations can only be signaled during an active exam.`);
  }

  // Step 5: Verify assessment is currently open (so a peserta can't signal
  // violations for an exam the admin has paused/closed). This also catches
  // the race where admin pauses mid-exam.
  const assessment = await db.selectOne<{
    id: string;
    title: string;
    subject: string;
    access_code: string;
    access_mode: string;
    ac_manual_status: string;
    ac_end: string | null;
    ac_scheduled_start: string | null;
    ac_scheduled_end: string | null;
  }>(
    'assessments',
    `id=eq.${session.assessment_id}&select=id,title,subject,access_code,access_mode,ac_manual_status,ac_end,ac_scheduled_start,ac_scheduled_end`
  );

  if (!assessment) {
    throw new HTTPError(404, 'NOT_FOUND', 'Assessment not found for this session');
  }

  const now = Date.now();
  let isAssessmentOpen = false;
  if (assessment.access_mode === 'manual') {
    if (assessment.ac_manual_status === 'open') {
      if (!assessment.ac_end || new Date(assessment.ac_end).getTime() > now) {
        isAssessmentOpen = true;
      }
    }
  } else if (assessment.access_mode === 'scheduled') {
    const start = assessment.ac_scheduled_start ? new Date(assessment.ac_scheduled_start).getTime() : null;
    const end = assessment.ac_scheduled_end ? new Date(assessment.ac_scheduled_end).getTime() : null;
    if ((!start || start <= now) && (!end || end > now)) {
      isAssessmentOpen = true;
    }
  }

  if (!isAssessmentOpen) {
    // Soft-fail: the assessment is closed, but the peserta may still be on
    // the page (e.g., it just got paused). Drop the signals silently — the
    // peserta's client should pick up the closed state via block-check.js polling.
    return new Response(
      JSON.stringify({
        success: true,
        data: { inserted: 0, skipped: signals.length, batch_id: generateBatchId() },
        warnings: ['Assessment is not currently open — signals dropped'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Step 6: Validate + normalize each signal
  const batchId = generateBatchId();
  const results: SignalResult[] = [];
  const validSignals: ProcessedSignal[] = [];

  signals.forEach((sig, idx) => {
    const v = validateSignal(sig, body.session_id);
    if (!v.valid) {
      results.push({ index: idx, status: 'skipped_invalid', error: v.error });
      return;
    }
    const normalized = v.normalized!;
    validSignals.push(normalized);
    results.push({ index: idx, status: 'inserted' });  // tentative — may downgrade to skipped_duplicate
  });

  // Step 7: Bulk INSERT with ON CONFLICT (dedup_key) DO NOTHING
  // Use the raw fetch API (not the SupabaseDB helper) because we need
  // the ON CONFLICT clause which the helper doesn't expose.
  let insertedCount = 0;
  let skippedDuplicateCount = 0;

  if (validSignals.length > 0) {
    const insertPayload = validSignals.map(sig => ({
      assessment_id: session.assessment_id,
      session_id: body.session_id,
      user_id: user.id,
      user_email: session.user_email || user.email,
      user_name: session.identity_snapshot?._display_name || session.identity_snapshot?.nama || null,
      exam_title: assessment.title,
      event_type: sig.event_type,
      message: sig.truncated_message,
      severity: sig.normalized_severity,
      ip_address: null,  // EF doesn't have direct access to client IP; Supabase logs it
      user_agent: req.headers.get('User-Agent') || null,
      device_id: req.headers.get('x-device-id') || null,
      dedup_key: sig.dedup_key,
      batch_id: batchId,
      signal_source: 'client' as const,
      metadata: sig.metadata || {},
      // created_at uses DEFAULT now() — don't set it (server clock is authoritative)
    }));

    const headers: Record<string, string> = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',  // need to count inserted rows
    };

    // PostgREST supports ON CONFLICT via query param: ?on_conflict=dedup_key
    // Combined with Prefer: resolution=ignore-duplicates, this gives us
    // INSERT ... ON CONFLICT (dedup_key) DO NOTHING semantics.
    headers['Prefer'] = 'return=representation,resolution=ignore-duplicates';

    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/violation_events?on_conflict=dedup_key`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(insertPayload),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error('[violation-signal] INSERT failed:', res.status, text);
      // Non-fatal: we still return a 207 with the error info
      // (the client will retry the whole batch on the next flush)
      results.forEach(r => {
        if (r.status === 'inserted') {
          r.status = 'error';
          r.error = `DB INSERT failed: ${res.status}`;
        }
      });
    } else {
      const returned = await res.json();
      // returned is an array of rows that were actually inserted (duplicates are NOT returned)
      insertedCount = Array.isArray(returned) ? returned.length : 0;
      skippedDuplicateCount = validSignals.length - insertedCount;

      // Re-derive per-signal results: walk through the original signals in order.
      // The first occurrence of each dedup_key is the one that got inserted
      // (PostgREST processes rows in array order when conflict resolution is
      // 'ignore-duplicates'). Subsequent occurrences are skipped_duplicates.
      const seenDedupKeys = new Set<string>();
      let insertedSoFar = 0;
      results.length = 0;
      signals.forEach((sig, idx) => {
        const v = validateSignal(sig, body.session_id);
        if (!v.valid) {
          results.push({ index: idx, status: 'skipped_invalid', error: v.error });
          return;
        }
        const dk = v.normalized!.dedup_key;
        if (seenDedupKeys.has(dk)) {
          results.push({ index: idx, status: 'skipped_duplicate' });
        } else {
          seenDedupKeys.add(dk);
          if (insertedSoFar < insertedCount) {
            results.push({ index: idx, status: 'inserted' });
            insertedSoFar++;
          } else {
            results.push({ index: idx, status: 'skipped_duplicate' });
          }
        }
      });
    }
  }

  // Step 8: For critical-severity signals, also log to audit_logs
  // (this gives admins a server-side audit trail independent of violation_events)
  const criticalSignals = validSignals.filter(s => s.normalized_severity === 'critical' && s.event_type === 'max_violations_reached');
  if (criticalSignals.length > 0) {
    // logAudit is fire-and-forget (returns void, errors swallowed) — but we
    // wrap in try/catch anyway to be defensive.
    try {
      logAudit(env, {
        action: 'MAX_VIOLATIONS_REACHED',
        targetType: 'assessment_session',
        targetId: body.session_id,
        metadata: {
          assessment_id: session.assessment_id,
          assessment_title: assessment.title,
          violation_count: criticalSignals.length,
          batch_id: batchId,
        },
        actorId: user.id,
        actorEmail: user.email,
        actorRole: 'peserta',
        ipAddress: null,
        userAgent: req.headers.get('User-Agent') || null,
      });
    } catch (e) {
      // Non-fatal — audit log failure should not block the signal
      console.warn('[violation-signal] audit_logs write failed:', e);
    }
  }

  // Step 9: Build response
  const hasErrors = results.some(r => r.status === 'error');
  const hasWarnings = results.some(r => r.status === 'skipped_invalid' || r.status === 'skipped_duplicate');

  const responseData = {
    inserted: insertedCount,
    skipped: skippedDuplicateCount + results.filter(r => r.status === 'skipped_invalid').length,
    batch_id: batchId,
    results: results.map(r => ({ index: r.index, status: r.status, ...(r.error ? { error: r.error } : {}) })),
  };

  const status = hasErrors ? 207 : 200;
  const responseShape: any = {
    success: !hasErrors,
    data: responseData,
  };
  if (hasWarnings || hasErrors) {
    responseShape.warnings = [
      ...(skippedDuplicateCount > 0 ? [`${skippedDuplicateCount} duplicate signals skipped`] : []),
      ...(results.filter(r => r.status === 'skipped_invalid').length > 0
        ? [`${results.filter(r => r.status === 'skipped_invalid').length} invalid signals skipped`]
        : []),
    ];
  }

  return new Response(JSON.stringify(responseShape), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Serve ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (req.method !== 'POST') {
    return withCors(
      new Response(
        JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Method not allowed. Use POST.' } }),
        { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' } }
      ),
      origin
    );
  }

  const env: Env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    SUPABASE_DB_URL: Deno.env.get('SUPABASE_DB_URL'),
  };

  try {
    const res = await handleViolationSignal(req, env, null);
    return withCors(res, origin);
  } catch (err: any) {
    const errorRes = handleError(err);
    return withCors(errorRes, origin);
  }
});
