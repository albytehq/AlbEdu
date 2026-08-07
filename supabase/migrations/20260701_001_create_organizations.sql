-- 20260701_001_create_organizations.sql
-- Creates the `organizations` table for future multi-tenant support.
-- Single-tenant mode = organization_id IS NULL on all rows.

CREATE TABLE IF NOT EXISTS public.organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  metadata    jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE public.organizations IS
  'Organizations table. Single-tenant mode: all rows have organization_id IS NULL.';

-- Index for slug lookup (UNIQUE constraint already covers uniqueness; explicit for clarity).
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON public.organizations(slug);

-- Enable RLS — only authenticated users can read organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "organizations_read_authenticated"
  ON public.organizations FOR SELECT TO authenticated
  USING (true);
-- Writes only via service role (server-side), no client writes
