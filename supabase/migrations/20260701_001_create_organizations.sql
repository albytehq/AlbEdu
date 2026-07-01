-- =============================================================================
-- 20260701_001_create_organizations.sql
-- AlbEdu v1.0.0 — Phase 1.1
-- =============================================================================
-- Creates the `organizations` table for future SCloud (School Cloud) multi-tenant
-- support. Single-tenant mode = organization_id IS NULL on all rows.
--
-- Decision ref: docs/MIGRATION-DECISIONS.md §Q1 (Hybrid, prioritize single-tenant)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  metadata    jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE public.organizations IS
  'SCloud organizations. v1.0.0: single-tenant mode (all rows have organization_id IS NULL). SCloud deferred to Phase 9.';

-- Index for slug lookup (already UNIQUE, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON public.organizations(slug);

-- Enable RLS — only authenticated users can read organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "organizations_read_authenticated"
  ON public.organizations FOR SELECT TO authenticated
  USING (true);
-- Writes only via service role (server-side), no client writes
