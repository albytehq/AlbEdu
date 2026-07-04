-- =============================================================================
-- Migration 019: Drop question_bank table
-- =============================================================================
-- Feature: Bank Soal removal
-- Author: Z.ai audit
-- Date: 2026-07-05
--
-- This migration drops the question_bank table and all dependent objects
-- (RLS policy, indexes, trigger). It is the inverse of migration 007.
--
-- Live audit confirmed:
--   * Table exists on live DB (to_regclass = 'question_bank')
--   * Table is EMPTY (0 rows) — zero data loss risk
--   * 0 inbound FKs from other tables (fully isolated)
--   * 0 Edge Functions reference it (12 EFs inspected)
--   * 0 views, 0 functions, 0 cron jobs reference it
--   * 1 outbound FK (owner_id -> users.id ON DELETE CASCADE) auto-dropped
--   * 1 RLS policy (qbank_admin_all_own) auto-dropped
--   * 1 trigger (qbank_updated_at) auto-dropped
--   * 7 indexes (6 user + 1 PK) auto-dropped
--
-- Shared functions peran_user() and update_updated_at() are NOT dropped
-- (they are referenced by other tables' RLS policies and triggers).
-- =============================================================================

BEGIN;

  -- Defensive: drop policy explicitly (CASCADE handles it, but explicit
  -- is clearer for code review).
  DROP POLICY IF EXISTS qbank_admin_all_own ON public.question_bank;

  -- Defensive: drop trigger explicitly.
  DROP TRIGGER IF EXISTS qbank_updated_at ON public.question_bank;

  -- Drop the table. CASCADE drops the 6 idx_qbank_* indexes + PK automatically.
  DROP TABLE IF EXISTS public.question_bank CASCADE;

  -- Update the audit_logs.target_type comment to remove the 'question_bank'
  -- example. The column itself remains (free-text, no enum constraint).
  COMMENT ON COLUMN public.audit_logs.target_type IS
    'Free-text label of the audited entity type. Examples: assessment, session, submission, user, data_subject_request.';

COMMIT;

-- =============================================================================
-- Verification queries (run manually after applying this migration):
-- =============================================================================
-- SELECT to_regclass('public.question_bank');            -- should return NULL
-- SELECT relname FROM pg_class WHERE relname = 'question_bank' AND relkind = 'r'; -- 0 rows
-- SELECT policyname FROM pg_policies WHERE tablename = 'question_bank';          -- 0 rows
-- SELECT indexname FROM pg_indexes WHERE tablename = 'question_bank';            -- 0 rows
-- SELECT proname FROM pg_proc WHERE proname IN ('peran_user','update_updated_at','log_audit'); -- 3 rows (shared fns intact)
