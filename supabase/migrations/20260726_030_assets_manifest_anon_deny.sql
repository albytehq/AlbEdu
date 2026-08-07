-- ============================================================================
-- Migration 030: assets_manifest explicit anon-deny policy
-- ============================================================================
-- ALB-SEC-005 (HIGH, CVSS 7.5): assets_manifest table relied on RLS
-- default-deny for anon, but no explicit policy documented intent. A
-- future migration that accidentally adds a permissive policy would
-- expose asset metadata (B2 paths, hashes, original_size, uploaded_by)
-- to the world.
--
-- This migration adds explicit anon-deny + authenticated-deny. Edge
-- Functions use service_role which bypasses RLS, so they're unaffected.
-- ============================================================================

ALTER TABLE public.assets_manifest ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assets_manifest_anon_deny" ON public.assets_manifest;
DROP POLICY IF EXISTS "assets_manifest_authenticated_deny" ON public.assets_manifest;
DROP POLICY IF EXISTS "assets_manifest_service_role_all" ON public.assets_manifest;

-- Explicit anon deny
CREATE POLICY "assets_manifest_anon_deny"
  ON public.assets_manifest
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- Authenticated deny too — route through Edge Functions only
CREATE POLICY "assets_manifest_authenticated_deny"
  ON public.assets_manifest
  FOR SELECT TO authenticated
  USING (false);

-- service_role (Edge Functions) — full access, bypasses RLS by default
-- but explicit policy documents intent
CREATE POLICY "assets_manifest_service_role_all"
  ON public.assets_manifest
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON POLICY "assets_manifest_anon_deny" ON public.assets_manifest IS
  'Explicit anon deny. Asset metadata (B2 paths, hashes) is not public. Access via Edge Functions only.';
COMMENT ON POLICY "assets_manifest_authenticated_deny" ON public.assets_manifest IS
  'Authenticated deny too. Even logged-in users cannot read asset manifest directly — must go through Edge Functions.';

DO $$
BEGIN
  RAISE NOTICE 'Migration 030 complete: assets_manifest explicit anon-deny + authenticated-deny added';
END $$;
