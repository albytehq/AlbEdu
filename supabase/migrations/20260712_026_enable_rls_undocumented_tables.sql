-- ============================================================================
-- Migration 026: Enable RLS on undocumented tables (created via Studio SQL)
-- ============================================================================
--
-- BACKGROUND:
--   SEC-B-C3 CRITICAL: 4 tables were created manually via Supabase Studio SQL
--   editor (no migration file). Their RLS state was unverifiable from the repo.
--   If RLS wasn't enabled in production, the anon key could SELECT * and dump:
--     • daftar_nama — student names, class lists (PII)
--     • admin_storages — admin storage configs
--     • user_devices — device fingerprints, user IDs (PII)
--     • registration_attempts — signup emails, IP addresses (PII)
--
--   This migration:
--   1. Enables RLS on all 4 tables (idempotent)
--   2. Creates service_role-only policies (same pattern as assets_manifest)
--   3. Allows owners to read their own user_devices and registration_attempts
--
--   Client access is via Edge Functions (service_role), NOT direct client
--   queries. This is the correct security posture.
--
-- PART OF: docs/security/SECURITY-ROADMAP.md Phase S0 #3
-- ============================================================================

-- ── 1. daftar_nama — admin's class/student lists ───────────────────────────
-- Should only be accessible by the owner admin (via Edge Function).
-- Direct client queries should be blocked.

ALTER TABLE public.daftar_nama ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any (idempotent)
DROP POLICY IF EXISTS "daftar_nama_service_role" ON public.daftar_nama;
DROP POLICY IF EXISTS "daftar_nama_owner_select" ON public.daftar_nama;

-- service_role (Edge Functions) can do everything
CREATE POLICY "daftar_nama_service_role" ON public.daftar_nama
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Owner admin can SELECT their own daftar_nama (matched by admin_id column)
-- Note: this allows direct client reads if the admin_id matches auth.uid(),
-- which is intentional — admins can view their lists without an EF round-trip.
CREATE POLICY "daftar_nama_owner_select" ON public.daftar_nama
  FOR SELECT TO authenticated
  USING (admin_id = auth.uid());

-- ── 2. admin_storages — admin storage configurations ──────────────────────
-- Only service_role should touch this (no direct client access).

ALTER TABLE public.admin_storages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_storages_service_role" ON public.admin_storages;

CREATE POLICY "admin_storages_service_role" ON public.admin_storages
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 3. user_devices — device fingerprints linked to users ─────────────────
-- Users can read their own devices (to see what's linked).
-- Only service_role can INSERT/UPDATE/DELETE (via Edge Functions).

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_devices_service_role" ON public.user_devices;
DROP POLICY IF EXISTS "user_devices_owner_select" ON public.user_devices;

CREATE POLICY "user_devices_service_role" ON public.user_devices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "user_devices_owner_select" ON public.user_devices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── 4. registration_attempts — signup attempts with email + IP ────────────
-- ONLY service_role can access. Users should NEVER see this table directly
-- (would leak other users' emails and IPs).

ALTER TABLE public.registration_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "registration_attempts_service_role" ON public.registration_attempts;

CREATE POLICY "registration_attempts_service_role" ON public.registration_attempts
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Verification ───────────────────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  rls_enabled BOOLEAN;
BEGIN
  RAISE NOTICE 'Migration 026 complete:';

  FOR t IN SELECT unnest(ARRAY['daftar_nama', 'admin_storages', 'user_devices', 'registration_attempts'])
  LOOP
    SELECT relrowsecurity INTO rls_enabled FROM pg_class WHERE relname = t;
    RAISE NOTICE '  % — RLS enabled: %', t, rls_enabled;
  END LOOP;

  RAISE NOTICE '  ';
  RAISE NOTICE '  All 4 tables now have RLS enabled with service_role-only access.';
  RAISE NOTICE '  daftar_nama + user_devices also allow owner SELECT.';
  RAISE NOTICE '  registration_attempts + admin_storages: service_role only.';
END $$;
