-- =============================================================================
-- 20260701_015_drop_legacy_tables.sql
-- AlbEdu v1.0.0 — Phase 1.15
-- =============================================================================
-- Drops legacy tables that are REPLACED by v1.0.0 schema.
-- KEEPS tables that are still used by v1.0.0 (assets_manifest, admin_storages,
-- daftar_nama, registration_attempts, user_devices).
--
-- IMPORTANT: Run this AFTER migration 014 (migrate_legacy_ujian.sql).
-- This is the LAST migration in the v1.0.0 series.
-- =============================================================================

-- ── Drop legacy view ──
DROP VIEW IF EXISTS public.ujian_peserta CASCADE;

-- ── Drop legacy `ujian` table (REPLACED by `assessments`) ──
DROP TABLE IF EXISTS public.ujian CASCADE;

-- ── Drop legacy `violations` table (REPLACED by `violation_events` + `assessment_sessions`) ──
-- Note: legacy violations table had composite doc_id PK. New violation_events
-- table uses UUID PK with FK to assessment_sessions.
DROP TABLE IF EXISTS public.violations CASCADE;

-- ── KEEP these tables (still used by v1.0.0) ──
-- public.assets_manifest      — still used by Cloudflare Worker for image dedup
-- public.admin_storages       — still used for storage provisioning (1:1 admin)
-- public.daftar_nama          — still used for identity_mode='daftar'
-- public.registration_attempts — still used by Edge Functions for rate limiting
-- public.user_devices         — still used for device fingerprint tracking

-- ── Rename daftar_nama columns to snake_case (if not already) ──
-- Legacy schema already uses snake_case, no changes needed.

-- ── Update admin_storages: keep as-is (1:1 with users where peran='admin') ──
-- No changes needed.

-- ── Final: update comments ──
COMMENT ON SCHEMA public IS
  'AlbEdu v1.0.0 — Enterprise schema. Legacy ujian + violations tables dropped. 10 active tables + 1 view. See docs/ARCHITECTURE.md for ERD.';

-- ── Verification query (run manually to confirm) ──
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
