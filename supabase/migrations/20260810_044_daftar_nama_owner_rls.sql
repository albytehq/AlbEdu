-- ═══════════════════════════════════════════════════════════════════
-- Migration 20260810_044 — daftar_nama + admin_storages owner-scoped RLS
-- ═══════════════════════════════════════════════════════════════════
-- PROBLEM:
--   20260712_026 enabled RLS on daftar_nama + admin_storages but only
--   granted:
--     • daftar_nama:  service_role ALL, authenticated SELECT (owner)
--     • admin_storages: service_role ALL  (NO authenticated access)
--   The client-side SelfStorage._provision() and DaftarNama.create()
--   do direct client queries (not Edge Functions). With the current
--   policies:
--     • SelfStorage._provision() SELECT on admin_storages → 0 rows (RLS)
--     • SelfStorage._provision() INSERT on admin_storages → blocked
--     • DaftarNama.create() INSERT on daftar_nama → blocked
--   Result: storageId stays null → "Storage belum siap." error.
--
-- FIX:
--   Add owner-scoped policies so authenticated admins can directly
--   CRUD their own rows (matched by admin_id = auth.uid()). This
--   matches the existing daftar_nama SELECT policy pattern.
--
--   Security:
--     • All policies check admin_id = auth.uid() — owner-only
--     • INSERT/UPDATE cannot set admin_id to another user's id
--       (the WITH CHECK clause enforces admin_id = auth.uid())
--     • service_role retains full access (FOR ALL)
--
-- APPLY VIA: Supabase Studio → SQL Editor → paste + Run
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. admin_storages — owner-scoped SELECT + INSERT ──────────────
-- Needed for SelfStorage._provision() client-side flow:
--   1. SELECT to check if storage already exists
--   2. INSERT to create new storage row (admin_id = auth.uid())

DROP POLICY IF EXISTS "admin_storages_owner_select" ON public.admin_storages;
CREATE POLICY "admin_storages_owner_select" ON public.admin_storages
  FOR SELECT TO authenticated
  USING (admin_id = auth.uid());

DROP POLICY IF EXISTS "admin_storages_owner_insert" ON public.admin_storages;
CREATE POLICY "admin_storages_owner_insert" ON public.admin_storages
  FOR INSERT TO authenticated
  WITH CHECK (admin_id = auth.uid());

-- Note: NO UPDATE or DELETE policy for authenticated on admin_storages.
-- Storage is 1:1 with admin and immutable once created (by design).


-- ── 2. daftar_nama — owner-scoped INSERT/UPDATE/DELETE ────────────
-- SELECT policy already exists (20260712_026). Adding write policies.
-- All check admin_id = auth.uid() so:
--   • INSERT must set admin_id to self
--   • UPDATE can only touch own rows, cannot change admin_id
--   • DELETE can only remove own rows

DROP POLICY IF EXISTS "daftar_nama_owner_insert" ON public.daftar_nama;
CREATE POLICY "daftar_nama_owner_insert" ON public.daftar_nama
  FOR INSERT TO authenticated
  WITH CHECK (admin_id = auth.uid());

DROP POLICY IF EXISTS "daftar_nama_owner_update" ON public.daftar_nama;
CREATE POLICY "daftar_nama_owner_update" ON public.daftar_nama
  FOR UPDATE TO authenticated
  USING (admin_id = auth.uid())
  WITH CHECK (admin_id = auth.uid());

DROP POLICY IF EXISTS "daftar_nama_owner_delete" ON public.daftar_nama;
CREATE POLICY "daftar_nama_owner_delete" ON public.daftar_nama
  FOR DELETE TO authenticated
  USING (admin_id = auth.uid());


-- ── 3. Safety trigger — prevent admin_id tampering on daftar_nama ─
-- Belt-and-suspenders: even if a future bug allows an UPDATE through,
-- this trigger rejects any attempt to change admin_id (which would
-- transfer ownership to another admin).

DROP TRIGGER IF EXISTS daftar_nama_immutable_admin_id ON public.daftar_nama;
CREATE OR REPLACE FUNCTION public._daftar_nama_guard_admin_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.admin_id IS DISTINCT FROM OLD.admin_id THEN
    RAISE EXCEPTION 'admin_id is immutable (daftar_nama)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER daftar_nama_immutable_admin_id
  BEFORE UPDATE ON public.daftar_nama
  FOR EACH ROW
  EXECUTE FUNCTION public._daftar_nama_guard_admin_id();


-- ── 4. Same guard for admin_storages ──────────────────────────────
DROP TRIGGER IF EXISTS admin_storages_immutable_admin_id ON public.admin_storages;
CREATE OR REPLACE FUNCTION public._admin_storages_guard_admin_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.admin_id IS DISTINCT FROM OLD.admin_id THEN
    RAISE EXCEPTION 'admin_id is immutable (admin_storages)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_storages_immutable_admin_id
  BEFORE UPDATE ON public.admin_storages
  FOR EACH ROW
  EXECUTE FUNCTION public._admin_storages_guard_admin_id();


-- ── 5. Index for faster owner-scoped queries ──────────────────────
-- Most queries filter by admin_id. Already indexed in 20260807_043
-- for daftar_nama; adding one for admin_storages for parity.
CREATE INDEX IF NOT EXISTS admin_storages_admin_id_idx
  ON public.admin_storages (admin_id);

COMMIT;

-- ═════════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying):
--   SELECT polname, polcmd, polqual::text, polwithcheck::text
--   FROM pg_policy
--   WHERE polrelid IN (
--     'public.daftar_nama'::regclass,
--     'public.admin_storages'::regclass
--   );
--
-- Expected: 7 policies total
--   daftar_nama:          service_role (ALL), owner_select, owner_insert,
--                         owner_update, owner_delete  (5)
--   admin_storages:       service_role (ALL), owner_select, owner_insert  (3)
--
-- Test from client (logged in as admin):
--   await supabase.from('admin_storages').select('id').eq('admin_id', <your-uid>)
--   → should return your storage row, not empty
-- ═════════════════════════════════════════════════════════════════
