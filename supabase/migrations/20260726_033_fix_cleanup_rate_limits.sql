-- ============================================================================
-- Migration 033: Fix cleanup_rate_limits() SQL function
-- ============================================================================
-- ALB-SEC-013 (MEDIUM, CVSS 4.0): cleanup_rate_limits() had UNION ALL that
-- produced 2 rows when there were deletions (count + the "0" branch). Also
-- only cleaned rate_limit_heartbeats, not rate_limit_submits.
--
-- This migration drops the broken function and re-creates with correct logic.
-- ============================================================================

DROP FUNCTION IF EXISTS public.cleanup_rate_limits();

CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted_hb AS (
    DELETE FROM public.rate_limit_heartbeats
    WHERE expires_at IS NOT NULL AND expires_at < now()
    RETURNING 1
  ),
  deleted_submit AS (
    DELETE FROM public.rate_limit_submits
    WHERE expires_at IS NOT NULL AND expires_at < now()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM deleted_hb) + (SELECT count(*) FROM deleted_submit);
$$;

REVOKE ALL ON FUNCTION public.cleanup_rate_limits FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits TO service_role;

COMMENT ON FUNCTION public.cleanup_rate_limits IS
  'Cleans expired rows from rate_limit_heartbeats + rate_limit_submits. Returns total deleted count. Fixed in migration 033 — original had UNION ALL producing 2 rows.';

DO $$
BEGIN
  RAISE NOTICE 'Migration 033 complete: cleanup_rate_limits() fixed — returns single INT, cleans both tables';
END $$;
