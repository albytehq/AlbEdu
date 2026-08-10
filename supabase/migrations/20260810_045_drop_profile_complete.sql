-- ═══════════════════════════════════════════════════════════════════
-- Migration 20260810_045 — Drop profile_complete system entirely
-- ═══════════════════════════════════════════════════════════════════
-- PROBLEM:
--   The "profile complete" system (profile_complete boolean column +
--   isProfileComplete() JS gate + "Profil belum lengkap" UI badges)
--   has been removed from the frontend. The column is now dead weight.
--
-- FIX:
--   Drop the profile_complete column from the users table.
--   All EFs that previously set profile_complete=true have been updated
--   to omit it from their INSERT/UPDATE payloads.
--
-- SAFETY:
--   This is a non-destructive migration (DROP COLUMN). The column
--   contains only boolean values that are no longer read by any code.
--   If rollback is needed, re-add with: ALTER TABLE users ADD COLUMN
--   profile_complete boolean DEFAULT true;
--
-- APPLY VIA: Supabase Studio → SQL Editor → paste + Run
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Drop profile_complete column (renamed from profil_lengkap by 20260701_002)
ALTER TABLE public.users DROP COLUMN IF EXISTS profile_complete;

-- Verify
SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users'
  AND column_name = 'profile_complete';

COMMIT;

-- Expected result: 0 rows (column successfully dropped)
