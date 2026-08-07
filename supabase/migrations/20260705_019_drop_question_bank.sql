-- Migration 019: Drop question_bank table
-- Inverse of migration 007. Live audit confirmed the table is empty with
-- zero inbound FKs, zero Edge Function references, and zero views / functions
-- / cron jobs depending on it. The outbound FK (owner_id → users.id ON DELETE
-- CASCADE), RLS policy, trigger, and 7 indexes are auto-dropped by CASCADE.
-- Shared functions peran_user() and update_updated_at() are NOT dropped —
-- they're referenced by other tables' RLS policies and triggers.

BEGIN;

  -- Drop policy explicitly (CASCADE handles it, but explicit is clearer for review).
  DROP POLICY IF EXISTS qbank_admin_all_own ON public.question_bank;

  -- Drop trigger explicitly.
  DROP TRIGGER IF EXISTS qbank_updated_at ON public.question_bank;

  -- Drop the table. CASCADE drops the 6 idx_qbank_* indexes + PK automatically.
  DROP TABLE IF EXISTS public.question_bank CASCADE;

  -- Update the audit_logs.target_type comment to remove the 'question_bank'
  -- example. The column itself remains (free-text, no enum constraint).
  COMMENT ON COLUMN public.audit_logs.target_type IS
    'Free-text label of the audited entity type. Examples: assessment, session, submission, user, data_subject_request.';

COMMIT;

-- Verification queries (run manually after applying this migration):
-- SELECT to_regclass('public.question_bank');            -- should return NULL
-- SELECT relname FROM pg_class WHERE relname = 'question_bank' AND relkind = 'r'; -- 0 rows
-- SELECT policyname FROM pg_policies WHERE tablename = 'question_bank';          -- 0 rows
-- SELECT indexname FROM pg_indexes WHERE tablename = 'question_bank';            -- 0 rows
-- SELECT proname FROM pg_proc WHERE proname IN ('peran_user','update_updated_at','log_audit'); -- 3 rows (shared fns intact)
