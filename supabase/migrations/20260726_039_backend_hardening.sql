-- ============================================================================
-- Migration 039: Backend hardening — revoke SECURITY DEFINER from anon + dedup
-- ============================================================================
-- Issues found in B5-B7 backend audit. All applied individually via API.
-- ============================================================================

-- 1. Revoke EXECUTE from anon on peran_user (keep authenticated for RLS)
REVOKE EXECUTE ON FUNCTION public.peran_user() FROM anon;

-- 2. Revoke EXECUTE from anon + authenticated on log_audit (service_role only)
REVOKE EXECUTE ON FUNCTION public.log_audit(
  text, text, text, jsonb, uuid, text, text, text, text
) FROM anon, authenticated;

-- 3. Revoke EXECUTE from anon + authenticated on cleanup_rate_limits
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM anon, authenticated;

-- 4. Revoke EXECUTE from anon + authenticated on submit_assessment_atomic
--    (used dynamic DO block in production due to timestamptz type name issue)
DO $$
DECLARE fn_oid oid; arg_str text;
BEGIN
  SELECT oid, pg_get_function_identity_arguments(oid) INTO fn_oid, arg_str
  FROM pg_proc WHERE proname = 'submit_assessment_atomic'
  AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.submit_assessment_atomic(' || arg_str || ') FROM anon, authenticated';
  END IF;
END $$;

-- 5. Drop duplicate trigger on users (trg_users_updated = users_updated_at)
DROP TRIGGER IF EXISTS trg_users_updated ON public.users;

-- 6. Drop duplicate trigger on daftar_nama (trg_daftar_nama_updated = trg_daftar_nama_updated_at)
DROP TRIGGER IF EXISTS trg_daftar_nama_updated ON public.daftar_nama;

-- 7. Drop redundant RLS policies
DROP POLICY IF EXISTS "assets_manifest_service_role_only" ON public.assets_manifest;
DROP POLICY IF EXISTS "audit_admin_read" ON public.audit_logs;
DROP POLICY IF EXISTS "Users can read own devices" ON public.user_devices;
