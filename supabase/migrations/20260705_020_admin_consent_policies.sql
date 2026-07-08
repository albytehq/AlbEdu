-- Migration 020: Add admin consent INSERT/UPDATE policies.
-- Bug fix: admin accounts failed to accept the privacy policy on the
-- assessment page. Root cause: migration 009 only defined INSERT/UPDATE
-- policies for peserta, so admin got rejected by RLS. Peserta succeeded
-- because the policy matched.
--
-- Consent is a user-level concern (UU PDP), not role-level. Admins are also
-- users and need their own consent record. Same pattern as the peserta policies.

-- Admin: INSERT own consent record (when admin clicks "Setuju" on consent popup)
CREATE POLICY IF NOT EXISTS "consents_admin_insert_own"
  ON public.consents FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'admin' AND user_id = auth.uid());

-- Admin: UPDATE own consent (revoke consent — set revoked_at)
CREATE POLICY IF NOT EXISTS "consents_admin_update_own"
  ON public.consents FOR UPDATE TO authenticated
  USING (peran_user() = 'admin' AND user_id = auth.uid())
  WITH CHECK (peran_user() = 'admin' AND user_id = auth.uid());

-- Verification queries:
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname='public' AND tablename='consents'
-- ORDER BY policyname, cmd;
-- Expected: 6 rows (admin_read, admin_insert_own, admin_update_own,
--                   peserta_read_own, peserta_insert_own, peserta_update_own)
