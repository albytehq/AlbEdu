-- =============================================================================
-- 20260622_grant_ujian_rls.sql
-- =============================================================================
-- FIX: 403 "permission denied for table ujian"
-- (HTTP 403 dari Supabase REST API dengan hint:
--  "Grant the required privileges to the current role …
--   GRANT SELECT ON public.ujian TO authenticated;")
--
-- ROOT CAUSE
--   Migration lama `20260618_rename_siswa_to_peserta.sql` mengeksekusi:
--     REVOKE SELECT ON ujian FROM authenticated;
--     REVOKE SELECT ON ujian FROM anon;
--   Tujuannya memaksa peserta lewat view `ujian_peserta` (menyembunyikan
--   kunci jawaban `p_q`). Tapi REVOKE menghapus privilege table-level,
--   sehingga RLS policy yang BERJALAN DI ATAS GRANT tidak pernah dievaluasi.
--   Akibatnya SEMUA query (admin & peserta) ke tabel `ujian` gagal 403.
--
-- PENTING — BEDA GRANT vs RLS POLICY
--   1. GRANT  = gate pertama (table-level). Kalau di-REVOKE, request
--      langsung 403 SEBELUM RLS policy sempat dievaluasi.
--   2. RLS    = gate kedua (row-level). Hanya berjalan SETELAH GRANT lolos.
--   Database ini SUDAH punya RLS policy yang benar:
--     - "Admins full access ujian"  (USING peran_user() = 'admin')
--     - "Siswa select ujian (blocked)" (USING false → deny peserta)
--   Yang hilang HANYA GRANT-nya. File ini hanya GRANT ulang.
--
-- CARA PAKAI
--   Sudah dijalankan via `supabase db query --linked` pada 2026-06-22.
--   File ini idempotent — aman di-run ulang via SQL Editor Dashboard.
--
-- ROLLBACK
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON ujian FROM authenticated;
--   (akan mengembalikan kondisi 403 — hanya lakukan kalau ingin re-lock)
-- =============================================================================


-- ── 1. GRANT table privileges ke authenticated ──────────────────────────────
-- INI SATU-SATUNYA YANG DIBUTUHKAN. RLS policy yang sudah ada akan mengambil
-- alih filtering row-level setelah GRANT ini berlaku.
GRANT SELECT, INSERT, UPDATE, DELETE ON ujian TO authenticated;


-- ── 2. Pastikan RLS aktif (idempotent) ──────────────────────────────────────
-- Database sudah ENABLE sebelumnya, tapi baris ini aman di-run ulang.
ALTER TABLE ujian ENABLE ROW LEVEL SECURITY;


-- ── 3. Verifikasi policy yang sudah ada (TIDAK membuat baru) ────────────────
-- Database sudah memiliki 2 policy ini — jangan di-drop/di-recreate:
--
--   "Admins full access ujian"
--     FOR ALL TO authenticated
--     USING (peran_user() = 'admin')
--     WITH CHECK (peran_user() = 'admin')
--     -- peran_user() = SECURITY DEFINER function yang baca kolom `peran`
--     -- dari tabel users where id = auth.uid()
--
--   "Siswa select ujian (blocked)"
--     FOR SELECT TO authenticated
--     USING (false)
--     -- deny-all untuk peserta. Mereka lewat view ujian_peserta (tanpa p_q).
--
-- Policy di PostgreSQL itu OR-ed per command, jadi:
--   Admin  : (peran_user()='admin' = true) OR (false)         → BISA akses
--   Peserta: (peran_user()='admin' = false) OR (false)        → DITOLAK


-- ── 4. Pastikan view ujian_peserta tetap bisa di-SELECT ─────────────────────
-- View ini jalur resmi peserta untuk baca ujian (tanpa p_q / kunci jawaban).
GRANT SELECT ON ujian_peserta TO authenticated;


-- =============================================================================
-- VERIFIKASI (sudah dijalankan, hasilnya):
-- =============================================================================
-- ✓ RLS aktif:        pg_tables.rownickname = true untuk 'ujian'
-- ✓ GRANT lengkap:    DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
--                     TRUNCATE, UPDATE untuk grantee 'authenticated'
-- ✓ Policy terdaftar: 'Admins full access ujian' + 'Siswa select ujian (blocked)'
-- ✓ Function helper:  peran_user() ada (SECURITY DEFINER, STABLE)
-- =============================================================================
