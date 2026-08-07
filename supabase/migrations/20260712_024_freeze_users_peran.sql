-- ============================================================================
-- Migration 024: Freeze users.peran — prevent peserta → admin self-escalation
-- ============================================================================
--
-- BACKGROUND:
--   SEC-B-C1 CRITICAL: Migration 002's `users_update_own` policy had no
--   column restriction and no WITH CHECK. Any authenticated peserta could run:
--     supabase.from('users').update({peran:'admin'}).eq('id', ownId)
--   in the browser console → instant admin escalation.
--
--   This migration adds TWO layers of protection:
--   1. RLS WITH CHECK: ensures updated row still belongs to the user
--   2. TRIGGER: blocks peran column changes by non-service-role callers
--
--   The trigger is the real defense — RLS WITH CHECK alone can't block
--   specific column changes. The trigger fires BEFORE UPDATE OF peran and
--   raises an exception if the caller isn't service_role.
--
-- PART OF: docs/security/SECURITY-ROADMAP.md Phase S0 #1
-- ============================================================================

-- ── 1. Drop and recreate users_update_own with WITH CHECK ───────────────────
-- The old policy had no WITH CHECK, allowing any column value in the new row.
-- We add WITH CHECK (id = auth.uid()) as defense-in-depth — the row must
-- still belong to the user after update (can't transfer ownership).

DROP POLICY IF EXISTS "users_update_own" ON public.users;

CREATE POLICY "users_update_own"
  ON public.users FOR UPDATE TO authenticated
  USING (id = auth.uid() AND deleted_at IS NULL)
  WITH CHECK (id = auth.uid() AND deleted_at IS NULL);

-- ── 2. Create trigger function to block peran changes ──────────────────────
-- This is the PRIMARY defense. Even if RLS allows the UPDATE, the trigger
-- fires BEFORE the write and blocks it if:
--   - Caller is NOT service_role (i.e., authenticated/anon)
--   - AND the peran column is being changed (NEW.peran != OLD.peran)
--
-- service_role bypasses this check (Edge Functions use service_role to set
-- peran during registration).

CREATE OR REPLACE FUNCTION public.prevent_peran_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow service_role to change anything (Edge Functions use this)
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Block peran changes for everyone else (authenticated, anon)
  IF NEW.peran IS DISTINCT FROM OLD.peran THEN
    RAISE EXCEPTION 'Permission denied: cannot modify peran field directly. Use register-admin Edge Function.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists (idempotent)
DROP TRIGGER IF EXISTS users_peran_immutable ON public.users;

-- Create trigger — fires BEFORE UPDATE that touches peran column
CREATE TRIGGER users_peran_immutable
  BEFORE UPDATE OF peran ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_peran_change();

-- ── 3. Verification ────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Migration 024 complete:';
  RAISE NOTICE '  users_update_own policy recreated with WITH CHECK';
  RAISE NOTICE '  prevent_peran_change() trigger function created';
  RAISE NOTICE '  users_peran_immutable trigger attached';
  RAISE NOTICE '  ';
  RAISE NOTICE '  Peserta can no longer UPDATE peran column.';
  RAISE NOTICE '  service_role (Edge Functions) can still set peran.';
END $$;
