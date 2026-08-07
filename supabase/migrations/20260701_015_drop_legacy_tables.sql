-- 20260701_015_drop_legacy_tables.sql
-- Drops legacy tables that are replaced by the new schema.
-- KEEPS tables still in use: assets_manifest, admin_storages, daftar_nama,
-- registration_attempts, user_devices.
--
-- Run this AFTER migration 014 (migrate_legacy_ujian.sql).

-- Drop legacy view
DROP VIEW IF EXISTS public.ujian_peserta CASCADE;

-- Drop legacy `ujian` table (replaced by `assessments`)
DROP TABLE IF EXISTS public.ujian CASCADE;

-- Drop legacy `violations` table (replaced by `violation_events` + `assessment_sessions`).
-- Legacy violations table had composite doc_id PK. New violation_events uses
-- UUID PK with FK to assessment_sessions.
DROP TABLE IF EXISTS public.violations CASCADE;

-- KEEP these tables (still used):
-- public.assets_manifest      — Cloudflare Worker image dedup
-- public.admin_storages       — storage provisioning (1:1 admin)
-- public.daftar_nama          — identity_mode='daftar'
-- public.registration_attempts — Edge Functions rate limiting
-- public.user_devices         — device fingerprint tracking

-- Rename daftar_nama columns to snake_case (if not already)
-- Legacy schema already uses snake_case, no changes needed.

-- Update admin_storages: keep as-is (1:1 with users where peran='admin')
-- No changes needed.

-- Final: update schema comment
COMMENT ON SCHEMA public IS
  'AlbEdu schema. Legacy ujian + violations tables dropped. 10 active tables + 1 view. See docs/ARCHITECTURE.md for ERD.';

-- Verification query (run manually to confirm):
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- Expected output (10 tables + 1 view):
--   admin_storages
--   assessment_sessions
--   assessments
--   audit_logs
--   consents
--   daftar_nama
--   data_subject_requests
--   organizations
--   question_bank
--   registration_attempts
--   submissions
--   user_devices
--   users
--   violation_events
--   assets_manifest
-- Plus view: assessment_view_peserta
