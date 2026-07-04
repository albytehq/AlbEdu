-- =============================================================================
-- 20260704_018_ensure_device_verified_count_fns.sql
-- AlbEdu v1.0.0 — Auth audit fix
-- =============================================================================
-- register-admin/index.ts and user-auth-complete/index.ts both call:
--   supabase.rpc("count_verified_admins_by_device", { target_device_id })
--   supabase.rpc("count_verified_users_by_device",  { target_device_id })
--
-- Neither function is defined anywhere in the migrations/ folder. The
-- supabase/README.md RPC table lists both as "Legacy, kept for ..." — same
-- phrasing used for tables (user_devices, registration_attempts) that predate
-- this migration set and already exist live. It's possible these functions
-- were created directly via the SQL editor and simply never captured here.
--
-- This migration is idempotent (CREATE OR REPLACE) so it is safe to run
-- whether or not the functions already exist in the live database — it will
-- not break anything if they're already present with the same behavior, and
-- it closes the gap if they were never actually created (which would cause
-- EVERY new user/admin registration to fail with a 500, since both edge
-- functions treat an RPC error as fail-closed).
--
-- Definition:
--   "Verified" = the account has confirmed its email (auth.users.email_confirmed_at
--   IS NOT NULL). Counts DISTINCT users linked to the given device_id via
--   user_devices, filtered by public.users.peran.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.count_verified_users_by_device(target_device_id text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT ud.user_id)::integer
  FROM public.user_devices ud
  JOIN public.users u        ON u.id = ud.user_id
  JOIN auth.users au         ON au.id = ud.user_id
  WHERE ud.device_id = target_device_id
    AND u.peran = 'peserta'
    AND au.email_confirmed_at IS NOT NULL
    AND u.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.count_verified_admins_by_device(target_device_id text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT ud.user_id)::integer
  FROM public.user_devices ud
  JOIN public.users u        ON u.id = ud.user_id
  JOIN auth.users au         ON au.id = ud.user_id
  WHERE ud.device_id = target_device_id
    AND u.peran = 'admin'
    AND au.email_confirmed_at IS NOT NULL
    AND u.deleted_at IS NULL;
$$;

-- Only the service role calls these (edge functions use SUPABASE_SERVICE_ROLE_KEY),
-- but revoke from anon/authenticated defensively since SECURITY DEFINER functions
-- run with the owner's privileges and must not be callable directly by clients.
REVOKE ALL ON FUNCTION public.count_verified_users_by_device(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_verified_admins_by_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_verified_users_by_device(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_verified_admins_by_device(text) TO service_role;

COMMENT ON FUNCTION public.count_verified_users_by_device(text) IS
  'Counts distinct verified (email-confirmed) peserta accounts linked to a device_id. Used by user-auth-complete edge function to enforce the 2-account device limit.';
COMMENT ON FUNCTION public.count_verified_admins_by_device(text) IS
  'Counts distinct verified (email-confirmed) admin accounts linked to a device_id. Used by register-admin edge function to enforce the 2-account device limit.';
