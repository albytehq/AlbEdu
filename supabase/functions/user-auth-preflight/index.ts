import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = origin === "" || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function genericError(headers: Record<string, string>, status = 400) {
  return json(
    { success: false, error: "user_preflight_failed" },
    status,
    headers,
  );
}

async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) {
    console.error("[user-auth-preflight] TURNSTILE_SECRET_KEY not set");
    return false;
  }

  const formData = new FormData();
  formData.set("secret", secret);
  formData.set("response", token);
  if (remoteIp) formData.set("remoteip", remoteIp);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData,
      },
    );
    if (!res.ok) return false;
    const payload = await res.json();
    return payload.success === true;
  } catch (err) {
    console.error("[user-auth-preflight] Turnstile verify failed:", err);
    return false;
  }
}

serve(async (req) => {
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
      console.error("[user-auth-preflight] missing Supabase env vars");
      return genericError(headers, 500);
    }

    const body = await req.json().catch(() => ({}));
    const turnstileToken = String(body.turnstileToken || "");
    const deviceId = body.deviceId ? String(body.deviceId) : null;
    const browserHash = body.browserHash ? String(body.browserHash) : null;
    const ipAddress = req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      null;
    const userIpKey = ipAddress ? `user:${ipAddress}` : null;
    const userAgent = req.headers.get("user-agent");

    if (!turnstileToken || !deviceId) {
      return json(
        { success: false, error: "missing_verification" },
        400,
        headers,
      );
    }

    // Rate-limit pre-checks run BEFORE Turnstile verification and before
    // the registration_attempts INSERT. The original ordering consumed a
    // valid Turnstile token and INSERTed a row before realising the request
    // was already over the rate limit — every failed attempt that passed
    // Turnstile advanced the counter toward 429, even when the frontend
    // already had a cached preflight. Page reload + rapid re-click could
    // exhaust the 10-attempt device window and trigger 429s that looked
    // like a hard block.
    //
    // Fix: read-only pre-check on both the device and IP counters BEFORE
    // touching Turnstile. Only proceed to the expensive Turnstile call and
    // INSERT when the request is within limits.

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Pre-check: device attempt count (read-only, no INSERT yet).
    const { count: preCheckDevice, error: preCheckDeviceErr } = await supabase
      .from("registration_attempts")
      .select("*", { count: "exact", head: true })
      .eq("device_id", deviceId)
      .gte("created_at", windowStart);

    if (preCheckDeviceErr) {
      console.error(
        "[user-auth-preflight] pre-check device query failed:",
        preCheckDeviceErr.message,
      );
      return genericError(headers, 500);
    }

    // Threshold 9 leaves headroom for the INSERT that follows a successful check.
    if ((preCheckDevice ?? 0) >= 9) {
      return json(
        { success: false, error: "rate_limit_exceeded" },
        429,
        headers,
      );
    }

    // Pre-check: IP attempt count (read-only).
    if (userIpKey) {
      const { count: preCheckIp, error: preCheckIpErr } = await supabase
        .from("registration_attempts")
        .select("*", { count: "exact", head: true })
        .eq("ip_address", userIpKey)
        .gte("created_at", windowStart);

      if (preCheckIpErr) {
        console.error(
          "[user-auth-preflight] pre-check IP query failed:",
          preCheckIpErr.message,
        );
        return genericError(headers, 500);
      }

      if ((preCheckIp ?? 0) > 120) {
        return json(
          { success: false, error: "rate_limit_exceeded" },
          429,
          headers,
        );
      }
    }

    // Turnstile verification — only reached when the request is within rate limits.
    const turnstileOk = await verifyTurnstile(turnstileToken, ipAddress);
    if (!turnstileOk) {
      // Do NOT insert an attempt row for a failed Turnstile check. The client
      // cannot retry without solving a new challenge, so this failure does
      // not represent a legitimate attempt and should not count toward the
      // rate-limit quota.
      return json({ success: false, error: "turnstile_failed" }, 403, headers);
    }

    // Record the attempt — only after both rate-limit pre-checks and Turnstile pass.
    const { data: attempt, error: insertErr } = await supabase
      .from("registration_attempts")
      .insert({
        ip_address: userIpKey,
        fingerprint: "user_google_preflight",
        device_id: deviceId,
        browser_hash: browserHash,
        user_agent: userAgent,
        email: `user:${deviceId}`,
      })
      .select("id")
      .single();

    if (insertErr || !attempt?.id) {
      console.error(
        "[user-auth-preflight] attempt insert failed:",
        insertErr?.message,
      );
      return genericError(headers, 500);
    }

    // Post-insert checks use the count that NOW includes the row we just
    // inserted, giving the correct inclusive total. Final safety net against
    // a race condition (two concurrent requests both passing the pre-check).

    const { count: deviceAttempts, error: deviceErr } = await supabase
      .from("registration_attempts")
      .select("*", { count: "exact", head: true })
      .eq("device_id", deviceId)
      .gte("created_at", windowStart);

    if (deviceErr) {
      console.error(
        "[user-auth-preflight] device attempt query failed:",
        deviceErr.message,
      );
      return genericError(headers, 500);
    }
    if ((deviceAttempts ?? 0) > 10) {
      return json(
        { success: false, error: "rate_limit_exceeded" },
        429,
        headers,
      );
    }

    // Device account-limit check is intentionally NOT enforced in preflight.
    //
    // Preflight runs BEFORE the user authenticates with Google, so it cannot
    // distinguish between a login (sign in to an existing account) and a
    // registration (create a new account). When the device already had 2
    // verified accounts, every attempt — even a legitimate login by an
    // existing user — was blocked with "device_limit_reached", which is
    // incorrect.
    //
    // The device-limit enforcement now lives exclusively in
    // user-auth-complete, which runs AFTER Google OAuth and can correctly
    // check `if (!existingUser)` before applying the limit. Existing users
    // can always log in, while new registrations on devices that already
    // have ≥ 2 accounts are still properly blocked.

    return json({ success: true, preflightId: attempt.id }, 200, headers);
  } catch (err) {
    console.error("[user-auth-preflight] unhandled exception:", err);
    return genericError(headers, 500);
  }
});
