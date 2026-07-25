-- ============================================================================
-- Migration 028: Fix submit_assessment_atomic() RPC — non-existent columns
-- ============================================================================
--
-- BACKGROUND:
--   ALB-SEC-002 (CRITICAL, CVSS 9.1): submit_assessment_atomic() references
--   non-existent columns (total_questions, score_percentage) on submissions
--   table. The actual columns are total_count (int) and score (numeric(5,2)).
--   Also missing required NOT NULL columns: identity_snapshot, user_email,
--   started_at.
--
--   The function was created in migration 021 but never called by any code
--   (submit-assessment EF uses raw db.insert with correct column names, NOT
--   this RPC). It's a latent landmine that would explode if anyone wired it up.
--
--   Migration 025 (line 37-39) already REVOKED public access to it, but didn't
--   fix the broken signature.
--
-- THIS MIGRATION:
--   1. Drops the broken function (with old signature for proper DROP)
--   2. Re-creates with correct columns matching submissions table schema
--   3. Re-applies REVOKE (DROP FUNCTION resets grants)
--   4. GRANTs EXECUTE to service_role only
--
-- PART OF: AUDIT.md §4 ALB-SEC-002
-- RELATED: ROADMAP.md Phase 1 Step 3
-- ============================================================================

-- ── 1. Drop the broken function ────────────────────────────────────────────
-- Note: Multiple signatures may exist (migration 021 had 11 args, but a
-- later modification left 8 args in production). Drop both variants.
DROP FUNCTION IF EXISTS public.submit_assessment_atomic(
  UUID, UUID, UUID, JSONB, INT, INT, INT, INT, INT, INT, JSONB
);
DROP FUNCTION IF EXISTS public.submit_assessment_atomic(
  UUID, JSONB, NUMERIC, INT, INT, INT, INT, JSONB
);

-- ── 2. Re-create with correct columns matching submissions table ───────────
-- Reference: migration 20260701_005_create_submissions.sql
-- Note: Postgres requires all params after a param with DEFAULT to also have
-- DEFAULT. Required params first, then optional params with defaults last.
CREATE OR REPLACE FUNCTION public.submit_assessment_atomic(
  p_session_id        UUID,
  p_user_id           UUID,
  p_assessment_id     UUID,
  p_identity_snapshot JSONB,
  p_user_email        TEXT,
  p_answers           JSONB,
  p_score             NUMERIC(5,2),
  p_correct_count     INT,
  p_total_count       INT,
  p_started_at        TIMESTAMPTZ,
  p_duration_seconds  INT,
  p_max_score         INT     DEFAULT 100,
  p_attempt_number    INT     DEFAULT 1,
  p_violation_count   INT     DEFAULT 0,
  p_grading_detail    JSONB   DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_submission_id UUID;
  v_session_status TEXT;
BEGIN
  -- Lock the session row so concurrent submits serialize.
  SELECT status INTO v_session_status
  FROM public.assessment_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- Idempotent: return existing submission if already present.
  SELECT id INTO v_submission_id
  FROM public.submissions
  WHERE session_id = p_session_id
  LIMIT 1;

  IF FOUND THEN
    RETURN v_submission_id;
  END IF;

  INSERT INTO public.submissions (
    assessment_id, session_id, user_id,
    identity_snapshot, user_email,
    answers, score, max_score, correct_count, total_count,
    grading_detail, started_at, submitted_at,
    duration_seconds, attempt_number
  ) VALUES (
    p_assessment_id, p_session_id, p_user_id,
    p_identity_snapshot, p_user_email,
    p_answers, p_score, p_max_score, p_correct_count, p_total_count,
    p_grading_detail, p_started_at, now(),
    p_duration_seconds, p_attempt_number
  )
  RETURNING id INTO v_submission_id;

  UPDATE public.assessment_sessions
  SET status = 'submitted',
      submitted_at = now()
  WHERE id = p_session_id;

  RETURN v_submission_id;
END;
$$;

-- ── 3. Re-apply REVOKE (DROP FUNCTION resets grants) ──────────────────────
REVOKE ALL ON FUNCTION public.submit_assessment_atomic FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_assessment_atomic TO service_role;

-- ── 4. Comment ─────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.submit_assessment_atomic IS
  'Atomic submit: INSERT submission + UPDATE session in one transaction. Idempotent on session_id. Fixed in migration 028 — original had non-existent column names (total_questions, score_percentage) and missing NOT NULL columns (identity_snapshot, user_email, started_at).';

-- ── 5. Verification ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_argnames text[];
BEGIN
  SELECT proargnames INTO v_argnames
  FROM pg_proc
  WHERE proname = 'submit_assessment_atomic';

  RAISE NOTICE 'Migration 028 complete:';
  RAISE NOTICE '  Function: submit_assessment_atomic';
  RAISE NOTICE '  Args: %', array_to_string(v_argnames, ', ');
  RAISE NOTICE '  ';
  RAISE NOTICE '  Old broken columns (total_questions, score_percentage) REMOVED';
  RAISE NOTICE '  New correct columns (total_count, score, identity_snapshot, user_email, started_at) ADDED';
  RAISE NOTICE '  ';
  RAISE NOTICE '  REVOKE ALL from PUBLIC, authenticated';
  RAISE NOTICE '  GRANT EXECUTE to service_role';
END $$;
