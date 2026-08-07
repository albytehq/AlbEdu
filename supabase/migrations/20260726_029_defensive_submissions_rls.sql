-- ============================================================================
-- Migration 029: Defensive deny-all UPDATE on submissions
-- ============================================================================
-- ALB-SEC-004 (HIGH, CVSS 7.7): submissions_admin_grade policy may exist
-- (migration 005 creates it, migration 016 attempts to drop). If migration
-- order was reversed (005 applied after 016), the policy is still live and
-- allows admin UPDATE on any column — including score, answers,
-- correct_count. A compromised admin JWT could alter exam results post-hoc.
--
-- This migration:
--   1. Idempotently drops the permissive policy (regardless of order)
--   2. Adds an explicit deny-all UPDATE policy for defense-in-depth
--
-- When manual esai grading lands, replace this with a column-scoped UPDATE
-- policy (see AUDIT.md §4 ALB-SEC-004 for template).
-- ============================================================================

DROP POLICY IF EXISTS "submissions_admin_grade" ON public.submissions;
DROP POLICY IF EXISTS "submissions_no_admin_update" ON public.submissions;

CREATE POLICY "submissions_no_admin_update"
  ON public.submissions FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

COMMENT ON POLICY "submissions_no_admin_update" ON public.submissions IS
  'Defensive deny-all UPDATE. Submissions are immutable post-submit. Score is computed server-side in submit-assessment EF. When manual esai grading lands, replace with column-scoped UPDATE policy.';

DO $$
BEGIN
  RAISE NOTICE 'Migration 029 complete: submissions_admin_grade dropped (idempotent), submissions_no_admin_update deny-all added';
END $$;
