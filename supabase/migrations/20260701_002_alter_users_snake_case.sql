-- 20260701_002_alter_users_snake_case.sql
-- Renames users columns to snake_case (Postgres convention).
-- Adds: organization_id (multi-tenant), consent_at (UU PDP),
--       deleted_at (soft delete for DSR).
--
-- BEFORE: users (id, email, nama, peran, created_at, foto_profil, profil_lengkap, updated_at)
-- AFTER:  users (id, email, nama, peran, created_at, avatar_url, profile_complete,
--                updated_at, organization_id, consent_at, consent_version, deleted_at)

-- Rename columns
ALTER TABLE public.users RENAME COLUMN foto_profil TO avatar_url;
ALTER TABLE public.users RENAME COLUMN profil_lengkap TO profile_complete;

-- Add new columns
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id),
  ADD COLUMN IF NOT EXISTS consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_organization ON public.users(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_peran ON public.users(peran);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON public.users(deleted_at) WHERE deleted_at IS NOT NULL;

-- RLS for soft-delete awareness: hide soft-deleted users from non-admin queries.
-- Existing RLS policies on the users table are preserved.

-- Drop existing SELECT policy if present (safe to recreate)
DROP POLICY IF EXISTS "users_select_own_or_admin" ON public.users;
DROP POLICY IF EXISTS "users_update_own" ON public.users;

-- Peserta can read own row (not soft-deleted)
CREATE POLICY "users_select_own"
  ON public.users FOR SELECT TO authenticated
  USING (id = auth.uid() AND deleted_at IS NULL);

-- Admins can read all non-deleted users. Single-tenant: org IS NULL.
CREATE POLICY "users_select_admin"
  ON public.users FOR SELECT TO authenticated
  USING (
    peran_user() = 'admin' AND deleted_at IS NULL
  );

-- Users can update own row (limited fields — handled by Edge Function / trigger)
CREATE POLICY "users_update_own"
  ON public.users FOR UPDATE TO authenticated
  USING (id = auth.uid() AND deleted_at IS NULL);

-- Inserts only via Edge Functions (service role) — no direct client INSERT.

COMMENT ON TABLE public.users IS
  'AlbEdu users table. avatar_url / profile_complete are the renamed snake_case equivalents of foto_profil / profil_lengkap. organization_id, consent_at, deleted_at added for multi-tenant, UU PDP consent, and DSR soft-delete.';
