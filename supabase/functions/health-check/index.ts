// health-check — used by external uptime monitors (UptimeRobot etc.) to
// keep the Free Plan database warm. Must actually query the DB so a
// paused database is detectable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export default async (_req: Request, env: any, _ctx: any) => {
  const started = Date.now();
  const body: Record<string, unknown> = {
    ok: true,
    time: new Date().toISOString(),
    has_url: !!env.SUPABASE_URL,
    has_key: !!env.SUPABASE_ANON_KEY,
    has_secret: !!env.SUPABASE_SERVICE_ROLE_KEY,
    db: "unknown",
    latency_ms: 0,
  };

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    body.ok = false;
    body.db = "misconfigured";
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3s timeout — a paused DB cold-starts in ~30-60s; we don't want to
  // wait that long, we just want to know "is it reachable right now".
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      global: { fetch: (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal }) },
    });
    const { error } = await sb.from("users").select("id").limit(1).maybeSingle();
    clearTimeout(timer);
    if (error) {
      body.ok = false;
      body.db = "error";
      body.error = error.message;
    } else {
      body.db = "healthy";
    }
  } catch (err: any) {
    body.ok = false;
    body.db = "unreachable";
    body.error = err?.name === "AbortError" ? "timeout" : (err?.message || "unknown");
  }

  body.latency_ms = Date.now() - started;
  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
};
