-- ============================================================================
-- Migration 037: Fix one_active_session constraint — make it partial
-- ============================================================================
-- BUG: Migration 20260701_004_create_assessment_sessions.sql created
-- `one_active_session UNIQUE (assessment_id, user_id)` as a FULL unique
-- constraint. The comment said "Allows multiple blocked/expired/submitted
-- sessions but only 1 active" — but the implementation didn't match.
--
-- IMPACT: A peserta who already has a blocked/submitted/expired session
-- cannot create a new active session for the same assessment. This breaks:
--   - allow_retake feature (peserta can't retake after submitting)
--   - Block-then-resume flow (peserta blocked, can't start fresh)
--   - Test cleanup (can't easily create test sessions on same assessment)
--
-- FIX: Drop the full UNIQUE constraint, replace with partial UNIQUE index
-- WHERE status = 'active'. This matches the original intent + comment.
--
-- Discovered during Phase 2 deep testing (block-participant test failed
-- when trying to create a 'submitted' session for a peserta who already
-- had a 'blocked' session).
-- ============================================================================

-- Drop the table-level CONSTRAINT first (this also drops the backing index)
ALTER TABLE public.assessment_sessions
  DROP CONSTRAINT IF EXISTS one_active_session;

-- Drop any standalone index of the same name (in case it was created
-- without a CONSTRAINT wrapper)
DROP INDEX IF EXISTS public.one_active_session;

-- Recreate as PARTIAL unique index — only enforces uniqueness for active sessions
CREATE UNIQUE INDEX one_active_session
  ON public.assessment_sessions(assessment_id, user_id)
  WHERE status = 'active';

-- The trigger enforce_single_active_session (already in place) provides
-- the same check with a friendlier error message. The partial index is
-- defense-in-depth.

COMMENT ON INDEX public.one_active_session IS
  'Partial unique index — only enforces one ACTIVE session per peserta per assessment. Blocked/expired/submitted sessions do NOT count. Fixed in migration 037 — original was full UNIQUE which broke allow_retake + test cleanup.';

DO $$
BEGIN
  RAISE NOTICE 'Migration 037 complete:';
  RAISE NOTICE '  Dropped full UNIQUE constraint one_active_session';
  RAISE NOTICE '  Created partial UNIQUE index WHERE status = ''active''';
  RAISE NOTICE '  Now peserta can have multiple non-active sessions + 1 active';
END $$;
