-- ============================================================================
-- Migration 025: Revoke SECURITY DEFINER functions from PUBLIC
-- ============================================================================
--
-- BACKGROUND:
--   SEC-B-C2 CRITICAL: Several SECURITY DEFINER functions were callable by
--   any authenticated user (or even anon). The most dangerous was log_audit()
--   — a peserta could insert fake audit entries, framing other users for
--   violations they didn't commit.
--
--   This migration REVOKEs public access and GRANTs execute to service_role
--   only, mirroring the pattern already used by count_verified_users_by_device
--   (migration 018).
--
--   Functions locked down:
--     • log_audit()                    — fake audit entries
--     • count_active_sessions_for_user() — session count manipulation
--     • count_submissions_for_user()    — submission count manipulation
--     • submit_assessment_atomic()      — submit as another user
--     • cleanup_rate_limits()           — rate limit manipulation
--
-- PART OF: docs/security/SECURITY-ROADMAP.md Phase S0 #2
-- ============================================================================

-- ── 1. log_audit — used by Edge Functions to log mutations ────────────────
REVOKE ALL ON FUNCTION public.log_audit FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.log_audit TO service_role;

-- ── 2. count_active_sessions_for_user ──────────────────────────────────────
REVOKE ALL ON FUNCTION public.count_active_sessions_for_user FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.count_active_sessions_for_user TO service_role;

-- ── 3. count_submissions_for_user ──────────────────────────────────────────
REVOKE ALL ON FUNCTION public.count_submissions_for_user FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.count_submissions_for_user TO service_role;

-- ── 4. submit_assessment_atomic ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.submit_assessment_atomic FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_assessment_atomic TO service_role;

-- ── 5. cleanup_rate_limits ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.cleanup_rate_limits FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits TO service_role;

-- ── Verification ───────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Migration 025 complete:';
  RAISE NOTICE '  5 SECURITY DEFINER functions revoked from PUBLIC/authenticated';
  RAISE NOTICE '  Granted EXECUTE to service_role only';
  RAISE NOTICE '  ';
  RAISE NOTICE '  Peserta can no longer call log_audit() or other privileged RPCs.';
  RAISE NOTICE '  Edge Functions (service_role) still work normally.';
END $$;
