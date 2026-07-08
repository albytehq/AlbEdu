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

function specificError(
  code: string,
  headers: Record<string, string>,
  status = 400,
) {
  return json(
    { success: false, error: code },
    status,
    headers,
  );
}

function genericError(headers: Record<string, string>, status = 400) {
  return specificError("user_completion_failed", headers, status);
}

function bearerToken(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
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
      console.error("[user-auth-complete] missing Supabase env vars");
      return genericError(headers, 500);
    }

    const token = bearerToken(req);
    if (!token) return specificError("invalid_token", headers, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error: userErr } = await supabase.auth.getUser(
      token,
    );
    if (userErr || !authData?.user?.id) {
      console.error(
        "[user-auth-complete] getUser failed:",
        userErr?.message,
      );
      return specificError("invalid_token", headers, 401);
    }

    const body = await req.json().catch(() => ({}));
    const preflightId = String(body.preflightId || "");
    const deviceId = body.deviceId ? String(body.deviceId) : null;
    const browserHash = body.browserHash ? String(body.browserHash) : null;
    const deviceInfo = body.deviceInfo && typeof body.deviceInfo === "object"
      ? body.deviceInfo
      : null;

    if (!preflightId || !deviceId) {
      return json({ success: false, error: "missing_preflight" }, 400, headers);
    }

    const preflightWindow = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: attempt, error: attemptErr } = await supabase
      .from("registration_attempts")
      .select("id, device_id, browser_hash, created_at")
      .eq("id", preflightId)
      .gte("created_at", preflightWindow)
      .maybeSingle();

    if (attemptErr || !attempt || attempt.device_id !== deviceId) {
      console.warn("[user-auth-complete] invalid preflight", {
        preflightId,
        hasAttempt: !!attempt,
        error: attemptErr?.message,
      });
      return specificError("missing_preflight", headers, 403);
    }

    if (
      attempt.browser_hash && browserHash &&
      attempt.browser_hash !== browserHash
    ) {
      return specificError("security_mismatch", headers, 403);
    }

    const user = authData.user;

    const { data: existingUser, error: existingErr } = await supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (existingErr) {
      console.error(
        "[user-auth-complete] users lookup failed:",
        existingErr.message,
      );
      return genericError(headers, 500);
    }

    if (!existingUser) {
      const { data: verifiedCount, error: countErr } = await supabase.rpc(
        "count_verified_users_by_device",
        { target_device_id: deviceId },
      );

      if (countErr) {
        console.error(
          "[user-auth-complete] device verified count failed:",
          countErr.message,
        );
        return genericError(headers, 500);
      }

      if ((verifiedCount ?? 0) >= 2) {
        return json(
          { success: false, error: "device_limit_reached" },
          403,
          headers,
        );
      }

    // foto_profil / profil_lengkap were renamed to avatar_url / profile_complete
    // by migration 20260701_002_alter_users_snake_case.sql. Inserting the old
    // column name causes every new peserta's first Google login to fail with
    // a Postgres "column does not exist" error (caught below as a generic 500).
    // Use the current schema.
    const { error: insertUserErr } = await supabase.from("users").insert({
        id: user.id,
        email: user.email ?? "",
        peran: "peserta",
        profile_complete: false,
      });

      if (insertUserErr) {
        console.error(
          "[user-auth-complete] users insert failed:",
          insertUserErr.message,
        );
        return genericError(headers, 500);
      }
    } else if (existingUser.peran !== "peserta") {
      return json({ success: true, user: existingUser }, 200, headers);
    }

    const { data: existingDevice, error: deviceLookupErr } = await supabase
      .from("user_devices")
      .select("id")
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .maybeSingle();

    if (deviceLookupErr) {
      console.error(
        "[user-auth-complete] device lookup failed:",
        deviceLookupErr.message,
      );
      return genericError(headers, 500);
    }

    if (existingDevice?.id) {
      const { error: updateDeviceErr } = await supabase
        .from("user_devices")
        .update({
          browser_hash: browserHash,
          device_info: deviceInfo,
          last_seen: new Date().toISOString(),
        })
        .eq("id", existingDevice.id);

      if (updateDeviceErr) {
        console.error(
          "[user-auth-complete] device update failed:",
          updateDeviceErr.message,
        );
      }
    } else {
      const { error: insertDeviceErr } = await supabase.from("user_devices")
        .insert({
          user_id: user.id,
          device_id: deviceId,
          browser_hash: browserHash,
          device_info: deviceInfo,
        });

      if (insertDeviceErr) {
        console.error(
          "[user-auth-complete] device insert failed:",
          insertDeviceErr.message,
        );
      }
    }

    const { data: profile, error: profileErr } = await supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileErr) {
      console.error(
        "[user-auth-complete] profile reload failed:",
        profileErr.message,
      );
      return genericError(headers, 500);
    }

    return json({ success: true, user: profile }, 200, headers);
  } catch (err) {
    console.error("[user-auth-complete] unhandled exception:", err);
    return genericError(headers, 500);
  }
});
