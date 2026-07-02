-- =============================================================================
-- 20260702_013_add_preferred_locale.sql
-- =============================================================================
-- Tambahan kolom preferred_locale ke tabel users untuk sistem i18n AlbEdu v2.0.
--
-- TUJUAN
--   Simpan preferensi bahasa user (ID/EN) supaya:
--   1. Persist antar session (login lagi di perangkat sama → bahasa sama)
--   2. Sync antar device (login di HP setelah set bahasa di laptop → bahasa ikut)
--   3. Anti-tamper: localStorage bisa di-edit user, tapi kolom ini hanya bisa
--      di-update oleh user yang bersangkutan via RLS policy (auth.uid() = id).
--
-- CARA KERJA
--   1. Client (i18n/index.js) panggil i18n.switchLocale('en')
--   2. i18n simpan ke localStorage 'albedu_locale' (instant)
--   3. i18n juga UPDATE users SET preferred_locale='en' WHERE id=auth.uid()
--      (async, fire-and-forget, RLS memastikan hanya row sendiri yang di-update)
--   4. Saat login berikutnya, Auth.userData.preferred_locale di-load dari DB
--   5. i18n._syncFromUser() apply bahasa dari DB ke client
--
-- RLS POLICY
--   - SELECT: user hanya bisa baca row sendiri (policy sudah ada, diasumsikan)
--   - UPDATE preferred_locale: user hanya bisa update kolom INI pada row sendiri
--     Kolom lain tetap diatur oleh policy yang sudah ada (admin-only, dll)
--   - Insert: tidak diizinkan via kolom ini (registration lewat edge function)
--
-- ALLOWLIST
--   CHECK constraint memastikan hanya 'id' atau 'en' yang valid — defense in
--   depth terhadap aplikasi client yang mungkin lupa validasi.
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS preferred_locale;
--   DROP POLICY IF EXISTS "Users update own preferred_locale" ON users;
-- =============================================================================

-- ── 1. Tambah kolom preferred_locale ───────────────────────────────────────
-- DEFAULT 'id' supaya user lama (yang belum pernah set bahasa) dapat Indonesian.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS preferred_locale TEXT DEFAULT 'id'
    CHECK (preferred_locale IN ('id', 'en'));

-- ── 2. Index untuk performa (opsional, untuk analytics query) ──────────────
CREATE INDEX IF NOT EXISTS idx_users_preferred_locale ON users(preferred_locale)
    WHERE preferred_locale IS NOT NULL;

-- ── 3. RLS Policy: user hanya bisa update preferred_locale row sendiri ─────
-- PostgreSQL tidak support column-level RLS policy secara native, tapi kita
-- capai efek yang sama dengan GRANT column-level + RLS row-level.
-- User hanya bisa UPDATE kolom yang di-GRANT, dan hanya pada row yang lolos RLS.

-- 3a. Pastikan GRANT SELECT tetap ada (policy lama)
GRANT SELECT ON users TO authenticated;

-- 3b. GRANT UPDATE hanya pada kolom preferred_locale
-- User tidak bisa update kolom lain (peran, email, nama, dll) via API ini.
-- Kolom lain hanya bisa di-update via edge function (admin path) atau via
-- ProfileEditorPanel yang lewat worker dengan validasi server-side.
GRANT UPDATE (preferred_locale) ON users TO authenticated;

-- 3c. RLS Policy untuk UPDATE preferred_locale
-- Hanya owner dari row (id = auth.uid()) yang bisa update kolom ini.
DROP POLICY IF EXISTS "Users update own preferred_locale" ON users;
CREATE POLICY "Users update own preferred_locale"
    ON users
    FOR UPDATE
    TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- ── 4. Comment untuk dokumentasi ─────────────────────────────────────────────
COMMENT ON COLUMN users.preferred_locale IS
    'User language preference for AlbEdu i18n v2.0. Allowed: id, en. Default: id. Only the user themselves can update this column (RLS policy).';

COMMENT ON POLICY "Users update own preferred_locale" IS
    'Allows authenticated users to update ONLY their own preferred_locale column. Other columns are protected by separate GRANT/policy.';

-- =============================================================================
-- VERIFIKASI (jalankan setelah migration):
-- =============================================================================
-- 1. Cek kolom ada:
--    SELECT column_name, data_type, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'users' AND column_name = 'preferred_locale';
--
-- 2. Cek policy ada:
--    SELECT policyname, cmd, roles, qual, with_check
--    FROM pg_policies
--    WHERE tablename = 'users' AND policyname = 'Users update own preferred_locale';
--
-- 3. Test dari client (login sebagai user):
--    const { error } = await sb.from('users')
--      .update({ preferred_locale: 'en' }).eq('id', user.id);
--    // Harus sukses tanpa error
--
-- 4. Test negative (login sebagai user A, coba update user B):
--    const { data, error } = await sb.from('users')
--      .update({ preferred_locale: 'en' }).eq('id', '<user-b-id>');
--    // Harus return 0 rows updated (RLS blocks silently)
--
-- 5. Test negative (coba update kolom lain via API):
--    const { error } = await sb.from('users')
--      .update({ peran: 'admin' }).eq('id', user.id);
--    // Harus error: "permission denied" (GRANT hanya untuk preferred_locale)
-- =============================================================================
