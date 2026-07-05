-- =============================================================================
-- Migration 020: Add admin consent INSERT/UPDATE policies
-- =============================================================================
-- Bug fix: admin account gagal saat accept privacy policy di halaman assessment.
-- Root cause: migration 009 hanya define INSERT/UPDATE policy untuk peserta,
-- admin ditolak RLS. Peserta langsung sukses karena policy cocok.
--
-- Consent adalah user-level concern (UU PDP), bukan role-level. Admin juga
-- user, perlu INSERT consent record sendiri. Policy mengikuti pattern yang
-- sama dengan consents_peserta_insert_own / consents_peserta_update_own.
-- =============================================================================

-- Admin: INSERT own consent record (when admin clicks "Setuju" on consent popup)
CREATE POLICY IF NOT EXISTS "consents_admin_insert_own"
  ON public.consents FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'admin' AND user_id = auth.uid());

-- Admin: UPDATE own consent (revoke consent — set revoked_at)
CREATE POLICY IF NOT EXISTS "consents_admin_update_own"
  ON public.consents FOR UPDATE TO authenticated
  USING (peran_user() = 'admin' AND user_id = auth.uid())
  WITH CHECK (peran_user() = 'admin' AND user_id = auth.uid());

-- =============================================================================
-- Verification queries:
-- =============================================================================
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname='public' AND tablename='consents'
-- ORDER BY policyname, cmd;
-- Expected: 6 rows (admin_read, admin_insert_own, admin_update_own,
--                   peserta_read_own, peserta_insert_own, peserta_update_own)
