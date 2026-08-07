-- ============================================================================
-- Migration 034: Heartbeat rate-limit trigger (server-side, Free Plan)
-- ============================================================================
-- Phase 3: heartbeat moved off EF to direct PostgREST PATCH.
-- Need server-side rate limiting since there's no EF to enforce it.
--
-- This trigger fires BEFORE UPDATE OF last_heartbeat_at on
-- assessment_sessions. It checks rate_limit_heartbeats table for recent
-- entries. If >4 in last 60s, raises exception (caught by client JS).
--
-- IMPORTANT: Only fires for authenticated (peserta) users, NOT service_role.
-- Block-check SELECTs do NOT trigger this (only UPDATE OF last_heartbeat_at).
-- Admin writes (block, submit, etc.) don't touch last_heartbeat_at.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_heartbeat_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent_count int;
BEGIN
  -- Only rate-limit UPDATEs from authenticated (peserta) users
  -- service_role bypasses (admin/EF writes)
  IF auth.role() = 'authenticated' THEN
    SELECT count(*)::int INTO v_recent_count
    FROM public.rate_limit_heartbeats
    WHERE session_id = NEW.id
      AND created_at > now() - interval '60 seconds';

    -- Allow 4 full heartbeats per minute (60s interval = 1/min, 4x safety margin)
    IF v_recent_count >= 4 THEN
      RAISE EXCEPTION 'heartbeat_rate_limited' USING ERRCODE = '42901';
    END IF;

    INSERT INTO public.rate_limit_heartbeats (session_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assessment_sessions_heartbeat_ratelimit ON public.assessment_sessions;
CREATE TRIGGER assessment_sessions_heartbeat_ratelimit
  BEFORE UPDATE OF last_heartbeat_at ON public.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_heartbeat_rate_limit();

COMMENT ON FUNCTION public.enforce_heartbeat_rate_limit IS
  'Server-side rate limit for heartbeat. 4 full heartbeats/min per session. Only fires for authenticated users (peserta), not service_role. Phase 3: replaces EF-based rate limiting.';

COMMENT ON TRIGGER assessment_sessions_heartbeat_ratelimit ON public.assessment_sessions IS
  'Fires BEFORE UPDATE OF last_heartbeat_at. Does NOT fire on SELECT (block-check poll) or on admin writes that don''t touch last_heartbeat_at.';

DO $$
BEGIN
  RAISE NOTICE 'Migration 034 complete:';
  RAISE NOTICE '  Function: enforce_heartbeat_rate_limit()';
  RAISE NOTICE '  Trigger: assessment_sessions_heartbeat_ratelimit';
  RAISE NOTICE '  Rate: 4 heartbeats/min per session (authenticated only)';
  RAISE NOTICE '  Block-check SELECTs do NOT trigger this';
END $$;
