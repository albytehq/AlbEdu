-- =============================================================================
-- 20260702_add_preferred_language.sql
-- =============================================================================
-- Tambahan kolom preferred_language ke tabel users untuk sistem i18n AlbEdu.
--
-- TUJUAN
--   Simpan preferensi bahasa user (ID/EN) supaya:
--   1. Persist antar session (login lagi di perangkat sama → bahasa sama)
--   2. Sync antar device (login di HP setelah set bahasa di laptop → bahasa ikut)
--   3. Anti-tamper: localStorage bisa di-edit user, tapi kolom ini hanya bisa
--      di-update oleh user yang bersangkutan via RLS policy (auth.uid() = id).
--
-- CARA KERJA
--   1. Client (i18n/index.js) panggil I18n.setLang('en')
--   2. I18n simpan ke localStorage 'albedu_lang' (instant)
--   3. I18n juga UPDATE users SET preferred_language='en' WHERE id=auth.uid()
--      (async, fire-and-forget, RLS memastikan hanya row sendiri yang di-update)
--   4. Saat login berikutnya, Auth.userData.preferred_language di-load dari DB
--   5. I18n.syncFromUser() apply bahasa dari DB ke client
--
-- RLS POLICY
--   - SELECT: user hanya bisa baca row sendiri (policy sudah ada, diasumsikan)
--   - UPDATE preferred_language: user hanya bisa update kolom INI pada row sendiri
--     Kolom lain tetap diatur oleh policy yang sudah ada (admin-only, dll)
--   - Insert: tidak diizinkan via kolom ini (registration lewat edge function)
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS preferred_language;
--   DROP POLICY IF EXISTS "Users update own preferred_language" ON users;
-- =============================================================================

-- ── 1. Tambah kolom preferred_language ───────────────────────────────────────
-- DEFAULT 'id' supaya user lama (yang belum pernah set bahasa) dapat Indonesian.
-- CHECK constraint memastikan hanya 'id' atau 'en' yang valid — defense in depth
-- terhadap aplikasi client yang mungkin lupa validasi.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'id'
    CHECK (preferred_language IN ('id', 'en'));

-- ── 2. Index untuk performa (opsional, cuma jika perlu query berdasarkan lang) ──
-- Tidak perlu index untuk lookup by user id (sudah ada PK).
-- Tapi kalau nanti mau analytics "berapa user pakai EN", index ini membantu.
CREATE INDEX IF NOT EXISTS idx_users_preferred_language ON users(preferred_language)
    WHERE preferred_language IS NOT NULL;

-- ── 3. RLS Policy: user hanya bisa update preferred_language row sendiri ─────
-- Policy ini SCOPE ke kolom preferred_language saja (COLUMN-LEVEL via GRANT).
-- Step 3a: REVOKE UPDATE pada kolom lain dari authenticated (jika sebelumnya ada)
-- Step 3b: GRANT UPDATE hanya pada kolom preferred_language
-- Step 3c: RLS policy memastikan WHERE id = auth.uid()
--
-- PENTING: PostgreSQL tidak support column-level RLS policy secara native,
-- tapi kita bisa capai efek yang sama dengan GRANT column-level + RLS row-level.
-- User hanya bisa UPDATE kolom yang di-GRANT, dan hanya pada row yang lolos RLS.

-- 3a. Pastikan GRANT SELECT tetap ada (policy lama)
GRANT SELECT ON users TO authenticated;

-- 3b. GRANT UPDATE hanya pada kolom preferred_language
-- User tidak bisa update kolom lain (peran, email, nama, dll) via API ini.
-- Kolom lain hanya bisa di-update via edge function (admin path) atau via
-- ProfileEditorPanel yang lewat worker dengan validasi server-side.
GRANT UPDATE (preferred_language) ON users TO authenticated;

-- 3c. RLS Policy untuk UPDATE preferred_language
-- Hanya owner dari row (id = auth.uid()) yang bisa update kolom ini.
DROP POLICY IF EXISTS "Users update own preferred_language" ON users;
CREATE POLICY "Users update own preferred_language"
    ON users
    FOR UPDATE
    TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- ── 4. Comment untuk dokumentasi ─────────────────────────────────────────────
COMMENT ON COLUMN users.preferred_language IS
    'User language preference for AlbEdu i18n system. Allowed: id, en. Default: id. Only the user themselves can update this column (RLS policy).';

COMMENT ON POLICY "Users update own preferred_language" IS
    'Allows authenticated users to update ONLY their own preferred_language column. Other columns are protected by separate GRANT/policy.';

-- =============================================================================
-- VERIFIKASI (jalankan setelah migration):
-- =============================================================================
-- 1. Cek kolom ada:
--    SELECT column_name, data_type, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'users' AND column_name = 'preferred_language';
--
-- 2. Cek policy ada:
--    SELECT policyname, cmd, roles, qual, with_check
--    FROM pg_policies
--    WHERE tablename = 'users' AND policyname = 'Users update own preferred_language';
--
-- 3. Test dari client (login sebagai user):
--    const { error } = await sb.from('users')
--      .update({ preferred_language: 'en' }).eq('id', user.id);
--    // Harus sukses tanpa error
--
-- 4. Test negative (login sebagai user A, coba update user B):
--    const { data, error } = await sb.from('users')
--      .update({ preferred_language: 'en' }).eq('id', '<user-b-id>');
--    // Harus return 0 rows updated (RLS blocks silently)
--
-- 5. Test negative (coba update kolom lain via API):
--    const { error } = await sb.from('users')
--      .update({ peran: 'admin' }).eq('id', user.id);
--    // Harus error: "permission denied" (GRANT hanya untuk preferred_language)
-- =============================================================================
