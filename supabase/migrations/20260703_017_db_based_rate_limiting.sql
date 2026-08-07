-- 20260703_017_db_based_rate_limiting.sql
-- Migrate heartbeat + submit rate limiting from in-memory (per-isolate)
-- to DB-based (cross-isolate accurate).
--
-- Tables:
--   rate_limit_heartbeats  — 4 req/min per session (15s interval = 4/min)
--   rate_limit_submits     — 2 req/min per session (allow 1 retry)
--
-- Both tables use INSERT + time-window COUNT (same pattern as
-- registration_attempts in access-code-attempt Edge Function).

-- Heartbeat rate limit table
CREATE TABLE IF NOT EXISTS public.rate_limit_heartbeats (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid NOT NULL,
    created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rl_hb_session_time
    ON public.rate_limit_heartbeats(session_id, created_at DESC);

-- RLS: only authenticated users can insert (Edge Function uses service role)
ALTER TABLE public.rate_limit_heartbeats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rl_hb_anon_deny" ON public.rate_limit_heartbeats
    FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "rl_hb_auth_insert" ON public.rate_limit_heartbeats
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "rl_hb_auth_read_own" ON public.rate_limit_heartbeats
    FOR SELECT TO authenticated
    USING (session_id IN (
        SELECT id FROM public.assessment_sessions WHERE user_id = auth.uid()
    ));

-- Submit rate limit table
CREATE TABLE IF NOT EXISTS public.rate_limit_submits (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid NOT NULL,
    created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rl_submit_session_time
    ON public.rate_limit_submits(session_id, created_at DESC);

ALTER TABLE public.rate_limit_submits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rl_submit_anon_deny" ON public.rate_limit_submits
    FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "rl_submit_auth_insert" ON public.rate_limit_submits
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "rl_submit_auth_read_own" ON public.rate_limit_submits
    FOR SELECT TO authenticated
    USING (session_id IN (
        SELECT id FROM public.assessment_sessions WHERE user_id = auth.uid()
    ));

-- Auto-cleanup: pg_cron deletes entries older than 1 hour.
-- Old entries are useless for rate limiting.
SELECT cron.schedule(
    'cleanup-rate-limit-tables',
    '0 * * * *',  -- every hour
    $$
    DELETE FROM public.rate_limit_heartbeats WHERE created_at < now() - interval '1 hour';
    DELETE FROM public.rate_limit_submits WHERE created_at < now() - interval '1 hour';
    $$
);

COMMENT ON TABLE public.rate_limit_heartbeats IS 'DB-based rate limiting for heartbeat Edge Function. 4 req/min per session.';
COMMENT ON TABLE public.rate_limit_submits IS 'DB-based rate limiting for submit-assessment Edge Function. 2 req/min per session.';
