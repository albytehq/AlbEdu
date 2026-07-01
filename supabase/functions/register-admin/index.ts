import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RiskResult = {
  allowed: boolean;
  reason?: string;
};

// Locked to the known deployment origins.
// "*" is never sent — unknown origins get no CORS header and the browser blocks them.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Patch D: ALLOWED_ORIGINS startup validation ────────────────────────────
// Deno Edge Functions have no dedicated startup hook, so we validate once on
// the first cold-start invocation. An empty list means every browser request
// will be CORS-blocked with no visible error — this log makes that detectable.
if (ALLOWED_ORIGINS.length === 0) {
  console.error(
    "[register-admin] Patch D: ALLOWED_ORIGINS env var is not set or is empty. " +
    "All browser CORS requests will be rejected. " +
    "Set ALLOWED_ORIGINS in Supabase secrets (comma-separated origin URLs)."
  );
}
// ── End Patch D startup ────────────────────────────────────────────────────

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  // Supabase local dev and CLI don't send an Origin — allow those internal calls.
  const allowed = origin === "" || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) {
    // Patch D: log every blocked origin so misconfigured deployments are visible
    // in Function logs rather than silently failing on the client.
    if (origin !== "") {
      console.warn(
        "[register-admin] Patch D: CORS blocked for origin:", origin,
        "— not in ALLOWED_ORIGINS:", ALLOWED_ORIGINS
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

// Uniform error response — every failure returns the same shape and the same
// generic message to the client. Specific reasons are logged server-side only
// so attackers can't enumerate valid emails or learn internal state.
function json(body: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function genericError(corsHeaders: Record<string, string>, status = 400) {
  // Always return the same client-facing message regardless of internal reason.
  return json({ success: false, error: "Pendaftaran gagal. Silakan coba lagi." }, status, corsHeaders);
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function verifyTurnstile(token: string, remoteIp: string | null): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) {
    console.error("[register-admin] TURNSTILE_SECRET_KEY not set");
    return false;
  }

  const formData = new FormData();
  formData.set("secret", secret);
  formData.set("response", token);
  if (remoteIp) formData.set("remoteip", remoteIp);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: formData }
    );
    if (!res.ok) return false;
    const payload = await res.json();
    return payload.success === true;
  } catch {
    return false;
  }
}

// Real risk evaluation — checks recent attempts from the same IP and email
// within the last hour before allowing a new registration to proceed.
// Limits: 5 attempts per IP, 3 per email — generous enough for legitimate
// use, tight enough to slow down automated abuse.
// Phase 1: deviceId and browserHash are accepted but NOT used for blocking yet.
async function evaluateRegistrationRisk(
  supabase: ReturnType<typeof createClient>,
  input: {
    email: string;
    ipAddress: string | null;
    userAgent: string | null;
    fingerprint: string | null;
    deviceId?: string | null;
    browserHash?: string | null;
  }
): Promise<RiskResult> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last 1 hour

  try {
    // Per-IP check — broad signal for bot traffic on shared infra
    if (input.ipAddress) {
      const { count: ipCount, error: ipErr } = await supabase
        .from("registration_attempts")
        .select("*", { count: "exact", head: true })
        .eq("ip_address", input.ipAddress)
        .gte("created_at", windowStart);

      if (ipErr) {
        console.error("[register-admin] risk ip query failed:", ipErr.message);
      } else if ((ipCount ?? 0) >= 5) {
        console.warn("[register-admin] risk: IP limit reached", { ip: input.ipAddress, count: ipCount });
        return { allowed: false, reason: "Terlalu banyak percobaan. Silakan coba lagi nanti." };
      }
    }

    // Per-email check — catches targeted re-registration attempts
    const { count: emailCount, error: emailErr } = await supabase
      .from("registration_attempts")
      .select("*", { count: "exact", head: true })
      .eq("email", input.email)
      .gte("created_at", windowStart);

    if (emailErr) {
      console.error("[register-admin] risk email query failed:", emailErr.message);
    } else if ((emailCount ?? 0) >= 3) {
      console.warn("[register-admin] risk: email limit reached", { email: input.email, count: emailCount });
      return { allowed: false, reason: "Terlalu banyak percobaan. Silakan coba lagi nanti." };
    }

    // Phase 1: Log device_id and browser_hash for shadow analysis (no blocking)
    if (input.deviceId) {
      if (_DEBUG) console.log("[register-admin] Phase 1: device_id collected (shadow):", input.deviceId);
    }
    if (input.browserHash) {
      if (_DEBUG) console.log("[register-admin] Phase 1: browser_hash collected (shadow):", input.browserHash);
    }

    return { allowed: true };
  } catch (err) {
    // ── Patch B: Fail-Closed Risk Engine ──────────────────────────────────
    // Original code returned { allowed: true } here — a DB error or malformed
    // fingerprint causing a cast exception would silently bypass all rate gates.
    // Fail closed instead: if we can't evaluate risk, we can't allow the request.
    // A transient DB outage blocks registrations, but createUser would also fail
    // moments later anyway, so no legitimate registration is lost.
    console.error("[register-admin] Patch B: risk evaluation exception — failing closed:", err);
    return { allowed: false, reason: "risk_check_unavailable" };
    // ── End Patch B ────────────────────────────────────────────────────────
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed." }, 405, corsHeaders);
  }

  // ── Patch C: Worker Secret Gate ─────────────────────────────────────────
  // Prevents direct calls to the Edge Function URL that bypass the
  // hosting-layer proxy (Vercel middleware / Cloudflare Worker).
  // Gate is opt-in: inactive until REGISTER_WORKER_SECRET is set in Supabase
  // secrets, so existing deployments are unaffected during the rollout window.
  // The proxy must inject x-worker-secret server-side — never from the browser.
  const workerSecret = Deno.env.get("REGISTER_WORKER_SECRET");
  if (workerSecret) {
    const provided = req.headers.get("x-worker-secret") ?? "";
    if (provided !== workerSecret) {
      console.warn("[register-admin] Patch C: missing or invalid worker secret — request blocked");
      return genericError(corsHeaders, 401);
    }
  }
  // ── End Patch C ──────────────────────────────────────────────────────────

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[register-admin] missing env vars");
      return genericError(corsHeaders, 500);
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const turnstileToken = String(body.turnstileToken || "");
    // Phase 1 Anti-Abuse: Accept device fingerprint fields (shadow collection)
    const deviceId = body.deviceId ? String(body.deviceId) : null;
    const browserHash = body.browserHash ? String(body.browserHash) : null;
    const deviceInfo = body.deviceInfo && typeof body.deviceInfo === 'object' ? body.deviceInfo : null;
    // Legacy fingerprint field retained for backward compatibility
    const legacyFingerprint = body.fingerprint ? String(body.fingerprint) : null;
    const ipAddress =
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      null;
    const userAgent = req.headers.get("user-agent");

    // Input validation — return specific messages only for client-side
    // format errors (not account-existence errors, to prevent enumeration).
    if (!isValidEmail(email)) {
      return json({ success: false, error: "Email tidak valid." }, 400, corsHeaders);
    }
    if (password.length < 8) {
      return json({ success: false, error: "Password minimal 8 karakter." }, 400, corsHeaders);
    }
    if (!turnstileToken) {
      return json({ success: false, error: "Verifikasi Turnstile wajib diisi." }, 400, corsHeaders);
    }

    const turnstileOk = await verifyTurnstile(turnstileToken, ipAddress);
    if (!turnstileOk) {
      return json({ success: false, error: "Verifikasi Turnstile gagal." }, 403, corsHeaders);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Record attempt BEFORE risk check so the attempt itself is counted
    // even if we ultimately block it.
    // Phase 1 Anti-Abuse: Store device_id and browser_hash (shadow collection)
    await supabase.from("registration_attempts").insert({
      ip_address: ipAddress,
      fingerprint: legacyFingerprint,
      device_id: deviceId,
      browser_hash: browserHash,
      user_agent: userAgent,
      email,
    });

    const risk = await evaluateRegistrationRisk(supabase, {
      email,
      ipAddress,
      userAgent,
      fingerprint: legacyFingerprint,
      deviceId,
      browserHash,
    });

    if (!risk.allowed) {
      // Normalize: return generic message to client, log specific reason server-side
      console.warn("[register-admin] blocked by risk evaluation:", risk.reason);
      // Return the specific reason for known rate-limit cases so frontend can show appropriate message
      if (risk.reason?.includes("Terlalu banyak percobaan")) {
        return json({ success: false, error: "rate_limit_exceeded", reason: "Terlalu banyak percobaan. Silakan tunggu beberapa menit sebelum mencoba lagi." }, 429, corsHeaders);
      }
      return genericError(corsHeaders, 429);
    }

    // ── MAX ACCOUNT = 2 ENFORCEMENT (VERIFIED ONLY) ────────────────────────
    // Count VERIFIED admin accounts for this device_id.
    // VERIFIED means auth.users.email_confirmed_at IS NOT NULL.
    // If count >= 2, reject registration with HTTP 429.
    // BUGFIX E: All DEBUG console.log lines below are gated behind the
    // DEBUG env var to prevent log spam and internal-state leakage in
    // production. Set DEBUG=1 in Supabase secrets to re-enable.
    const _DEBUG = !!Deno.env.get("DEBUG");
    if (deviceId) {
      if (_DEBUG) console.log("[register-admin] DEBUG: Checking device limit for device_id:", deviceId);
      
      // Step 1: Fetch all user_ids associated with this device_id from user_devices
      const { data: deviceRecords, error: fetchError } = await supabase
        .from("user_devices")
        .select("user_id")
        .eq("device_id", deviceId);

      if (_DEBUG) console.log("[register-admin] device lookup", {
        deviceId,
        records_found: deviceRecords?.length ?? 0
      });

      if (fetchError) {
        console.error("[register-admin] device limit check failed:", fetchError.message);
        // BUGFIX F: Fail CLOSED (previously failed open). A DB error here
        // could mean a transient glitch OR a deliberate attempt to bypass
        // the device limit by causing the lookup to error. Failing open
        // lets a 3rd account slip through. Failing closed blocks
        // registration until the DB is healthy -- legitimate users can
        // retry in a few seconds.
        return json(
          { success: false, error: "risk_check_unavailable" },
          500,
          corsHeaders,
        );
      } else if (deviceRecords && deviceRecords.length > 0) {
        if (_DEBUG) console.log("[register-admin] DEBUG: Found", deviceRecords.length, "existing user(s) for this device");
        
        // Step 2: Extract unique user IDs to avoid double counting
        const userIds = [...new Set(deviceRecords.map((r) => r.user_id))];
        if (_DEBUG) console.log("[register-admin] DEBUG: Unique user IDs:", userIds);

        // Step 3: Count how many of these users are VERIFIED in auth.users
        const { data: verifiedCount, error: countError } = await supabase.rpc(
          "count_verified_admins_by_device",
          { target_device_id: deviceId }
        );

        if (countError) {
          console.error("[register-admin] verified count check failed:", countError.message);
          console.error("[register-admin] DEBUG: Auth users count query failed");
        } else {
          if (_DEBUG) console.log("[register-admin] DEBUG: Verified account count for this device:", verifiedCount ?? 0);
          if (_DEBUG) console.log("[register-admin] verified account count", {
            deviceId,
            verifiedCount
          });
          
          if ((verifiedCount ?? 0) >= 2) {
            console.warn("[register-admin] device limit reached", {
              deviceId,
              verifiedCount
            });
            console.warn("[register-admin] device limit reached", { 
              device_id: deviceId, 
              verified_count: verifiedCount,
              action: "blocking_registration"
            });
            return json({ success: false, error: "device_limit_reached" }, 403, corsHeaders);
          } else {
            if (_DEBUG) console.log("[register-admin] DEBUG: Device limit not reached, allowing registration");
          }
        }
      } else {
        if (_DEBUG) console.log("[register-admin] DEBUG: No existing users found for this device_id - first registration");
      }
    }
    // ── END MAX ACCOUNT = 2 ENFORCEMENT ────────────────────────────────────

    // email_confirm: false means Supabase creates the account but marks
    // email_confirmed_at as null. The user cannot log in until they click
    // the confirmation link — Supabase enforces this at the signIn level when
    // "Confirm email" is enabled in project Auth settings (required).
    const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });

    if (createError) {
      // Log internal detail for debugging
      console.error("[register-admin] createUser error:", createError.message);
      console.error("[register-admin] DEBUG: createUser failed with status:", createError.status);
      
      // Categorize the error for better debugging
      const errorMsg = createError.message || '';
      if (errorMsg.includes("User already registered") || errorMsg.includes("duplicate")) {
        console.error("[register-admin] DEBUG: Duplicate email registration attempt detected");
      } else if (errorMsg.includes("Weak password") || errorMsg.includes("password")) {
        console.error("[register-admin] DEBUG: Password policy violation");
      } else if (errorMsg.includes("Invalid email")) {
        console.error("[register-admin] DEBUG: Invalid email format at Supabase level");
      }
      
      // Return generic message to prevent email enumeration
      return genericError(corsHeaders);
    }

    const userId = createdUser.user?.id;
    if (!userId) {
      console.error("[register-admin] createUser returned no id");
      return genericError(corsHeaders, 500);
    }

    // ── Patch A: Email Verification Gate (server side) ───────────────────
    // If email_confirmed_at is already set, Supabase's "Confirm email" project
    // setting is OFF — the account is live and loginable immediately without
    // clicking any link. This is a misconfiguration that breaks the security
    // model. Abort, delete the dangling account, and alert ops via logs.
    const confirmedAt = createdUser.user?.email_confirmed_at;
    if (confirmedAt) {
      console.error(
        "[register-admin] Patch A: CRITICAL — email_confirmed_at is set immediately after createUser. " +
        "Supabase 'Confirm email' project setting appears to be OFF. " +
        "Aborting registration and deleting account to prevent unverified admin login."
      );
      await supabase.auth.admin.deleteUser(userId);
      return genericError(corsHeaders, 500);
    }
    // ── End Patch A ───────────────────────────────────────────────────────

    const { error: profileError } = await supabase.from("users").insert({
      id: userId,
      email,
      peran: "admin",
      profil_lengkap: false,
    });

    if (profileError) {
      console.error("[register-admin] profile insert error:", profileError.message);
      await supabase.auth.admin.deleteUser(userId);
      return genericError(corsHeaders, 500);
    }

    // Phase 1 Anti-Abuse: Log device to user_devices table (shadow collection)
    // NO enforcement yet — just recording the device association
    if (deviceId) {
      const { error: deviceError } = await supabase.from("user_devices").insert({
        user_id: userId,
        device_id: deviceId,
        browser_hash: browserHash,
        device_info: deviceInfo,
      });

      if (deviceError) {
        // Non-fatal: log but don't block registration
        console.error("[register-admin] user_devices insert error (non-fatal):", deviceError.message);
      } else {
        if (_DEBUG) console.log("[register-admin] Phase 1: device logged to user_devices (shadow)");
      }
    }

    // BUGFIX P (clarification): createUser with email_confirm:false does NOT
    // auto-send the confirmation email in Supabase -- it only creates the
    // auth.users row. We must explicitly call resend({ type: "signup" })
    // to trigger the verification email. If Supabase changes this default
    // behavior in the future (e.g. auto-send on createUser), users would
    // receive duplicate emails -- remove this call at that point.
    const { error: emailError } = await supabase.auth.resend({
      type: "signup",
      email,
    });

    if (emailError) {
      console.error("[register-admin] resend email error:", emailError.message);
      await supabase.from("users").delete().eq("id", userId);
      await supabase.auth.admin.deleteUser(userId);
      return genericError(corsHeaders, 500);
    }

    return json({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error("[register-admin] unhandled exception:", err);
    // Return more specific error messages for debugging while keeping them user-friendly
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    
    // Debug logging with categorized error types
    if (errorMessage.includes("email_confirmed_at")) {
      console.error("[register-admin] DEBUG: Email confirmation gate triggered");
    } else if (errorMessage.includes("User already registered")) {
      console.error("[register-admin] DEBUG: Duplicate email registration attempt");
    } else if (errorMessage.includes("Weak password")) {
      console.error("[register-admin] DEBUG: Password does not meet security requirements");
    } else if (errorMessage.includes("Invalid email")) {
      console.error("[register-admin] DEBUG: Email format validation failed at DB level");
    } else if (errorMessage.includes("rate limit") || errorMessage.includes("too many")) {
      console.error("[register-admin] DEBUG: Rate limiting triggered");
    } else if (errorMessage.includes("fetch failed") || errorMessage.includes("network")) {
      console.error("[register-admin] DEBUG: Network/fetch error - possible Supabase connectivity issue");
      console.error("[register-admin] DEBUG: SUPABASE_URL:", Deno.env.get("SUPABASE_URL") ? "set" : "missing");
      console.error("[register-admin] DEBUG: Service role key:", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ? "set" : "missing");
    } else if (errorMessage.includes("JWT") || errorMessage.includes("token")) {
      console.error("[register-admin] DEBUG: JWT/Token authentication error");
    } else if (errorMessage.includes("permission") || errorMessage.includes("unauthorized") || errorMessage.includes("401")) {
      console.error("[register-admin] DEBUG: Permission/authorization error - check service role key validity");
    } else if (errorMessage.includes("duplicate") || errorMessage.includes("unique constraint")) {
      console.error("[register-admin] DEBUG: Database unique constraint violation");
    } else if (errorMessage.includes("foreign key")) {
      console.error("[register-admin] DEBUG: Foreign key constraint violation - check related tables exist");
    } else {
      console.error("[register-admin] DEBUG: Unknown error type -", errorMessage);
    }
    
    // Log full stack trace for critical errors (only in production logs, not exposed to client)
    if (errorStack) {
      console.error("[register-admin] DEBUG: Full stack trace:", errorStack);
    }
    
    // Log request context for better debugging
    console.error("[register-admin] DEBUG: Request context - timestamp:", new Date().toISOString());
    console.error("[register-admin] DEBUG: Request context - environment:", Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "local/dev");
    
    return genericError(corsHeaders, 500);
  }
});
