// =============================================================================
// exam-token-attempt — Server-side rate limiting for exam token entry
// =============================================================================
//
// BUGFIX (D): Previously, the token-entry rate limit lived entirely in
// localStorage (exam_token_attempts / exam_token_cooldown). A user could
// bypass it instantly by clearing localStorage or opening an incognito tab.
//
// This Edge Function moves rate limiting server-side so it cannot be bypassed.
// The client (ujian/ujian.js) calls this endpoint BEFORE doing the Firestore
// lookup. If the server says "rate limited", the client shows the cooldown UI
// and does NOT proceed.
//
// Rate limits (per IP, per hour):
//   - 10 attempts per IP (covers shared-school-network scenarios)
//   - Optional device_id tracking for tighter per-device limits
//
// The client-side localStorage cooldown is RETAINED as instant UX feedback
// (countdown timer) but is no longer the source of truth.
//
// Reuses the existing `registration_attempts` table with fingerprint =
// 'exam_token_attempt' so no new migration is needed.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// BUGFIX CORS: Warn at module load if ALLOWED_ORIGINS is not set. Without it,
// every browser request is CORS-blocked with no visible server-side error —
// the function returns 200 on OPTIONS but with empty CORS headers, so the
// browser rejects the preflight. This log makes the misconfiguration detectable.
if (ALLOWED_ORIGINS.length === 0) {
  console.error(
    "[exam-token-attempt] ALLOWED_ORIGINS env var is not set or is empty. " +
    "All browser CORS requests will be rejected. " +
    "Set ALLOWED_ORIGINS in Supabase secrets (comma-separated origin URLs), e.g.:\n" +
    '  supabase secrets set ALLOWED_ORIGINS=https://albedu-id.github.io,https://your-custom-domain.com'
  );
} else {
  console.log("[exam-token-attempt] ALLOWED_ORIGINS configured:", ALLOWED_ORIGINS);
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_IP = 10; // 10 attempts per IP per hour
const RATE_LIMIT_MAX_DEVICE = 10; // 10 attempts per device per hour
const ATTEMPT_FINGERPRINT = "exam_token_attempt";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = origin === "" || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) {
    // BUGFIX CORS: Log every blocked origin so misconfigured deployments are
    // visible in Function logs rather than silently failing on the client.
    // This is the #1 cause of "CORS policy: Response to preflight request
    // doesn't pass access control check" errors.
    if (origin !== "") {
      console.warn(
        "[exam-token-attempt] CORS blocked for origin:", origin,
        "— not in ALLOWED_ORIGINS:", ALLOWED_ORIGINS,
        "\n  Fix: supabase secrets set ALLOWED_ORIGINS=" + origin + ",<other-origins>"
      );
    }
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function getClientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    null;
}

serve(async (req: Request) => {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "method_not_allowed" }, 405, headers);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[exam-token-attempt] missing Supabase env vars");
      return json({ success: false, error: "server_error" }, 500, headers);
    }

    const body = await req.json().catch(() => ({}));
    const deviceId = body.deviceId ? String(body.deviceId) : null;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers.get("user-agent");
    const ipKey = ipAddress ? `exam_ip:${ipAddress}` : null;

    if (!ipKey && !deviceId) {
      return json(
        { success: false, error: "missing_verification" },
        400,
        headers,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    // ── IP-based rate limit (unbypassable — client cannot change their IP) ──
    let ipAttempts = 0;
    if (ipKey) {
      const { count, error: ipErr } = await supabase
        .from("registration_attempts")
        .select("*", { count: "exact", head: true })
        .eq("ip_address", ipKey)
        .eq("fingerprint", ATTEMPT_FINGERPRINT)
        .gte("created_at", windowStart);

      if (ipErr) {
        console.error("[exam-token-attempt] IP count query failed:", ipErr.message);
        return json({ success: false, error: "server_error" }, 500, headers);
      }
      ipAttempts = count ?? 0;

      if (ipAttempts >= RATE_LIMIT_MAX_IP) {
        const retryAfterSec = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
        return json({
          success: false,
          error: "rate_limit_exceeded",
          retryAfter: retryAfterSec,
          attempts: ipAttempts,
          maxAttempts: RATE_LIMIT_MAX_IP,
          scope: "ip",
        }, 429, headers);
      }
    }

    // ── Device-based rate limit (additional layer if deviceId is provided) ──
    let deviceAttempts = 0;
    if (deviceId) {
      const { count, error: devErr } = await supabase
        .from("registration_attempts")
        .select("*", { count: "exact", head: true })
        .eq("device_id", deviceId)
        .eq("fingerprint", ATTEMPT_FINGERPRINT)
        .gte("created_at", windowStart);

      if (devErr) {
        console.error("[exam-token-attempt] device count query failed:", devErr.message);
        return json({ success: false, error: "server_error" }, 500, headers);
      }
      deviceAttempts = count ?? 0;

      if (deviceAttempts >= RATE_LIMIT_MAX_DEVICE) {
        const retryAfterSec = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
        return json({
          success: false,
          error: "rate_limit_exceeded",
          retryAfter: retryAfterSec,
          attempts: deviceAttempts,
          maxAttempts: RATE_LIMIT_MAX_DEVICE,
          scope: "device",
        }, 429, headers);
      }
    }

    // ── Record the attempt ──────────────────────────────────────────────────
    const { error: insertErr } = await supabase
      .from("registration_attempts")
      .insert({
        ip_address: ipKey,
        fingerprint: ATTEMPT_FINGERPRINT,
        device_id: deviceId,
        user_agent: userAgent,
        email: null,
      });

    if (insertErr) {
      console.error("[exam-token-attempt] insert failed:", insertErr.message);
      // Non-fatal — we already verified the count is under limit.
      // Don't block the user because of a logging failure.
    }

    // ── Return success with current counts ──────────────────────────────────
    return json({
      success: true,
      allowed: true,
      attempts: Math.max(ipAttempts, deviceAttempts) + 1,
      maxAttempts: RATE_LIMIT_MAX_IP,
    }, 200, headers);
  } catch (err) {
    console.error("[exam-token-attempt] unhandled exception:", err);
    return json({ success: false, error: "server_error" }, 500, headers);
  }
});
