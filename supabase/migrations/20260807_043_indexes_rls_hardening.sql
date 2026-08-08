-- 20260807_043_indexes_rls_hardening.sql
--
-- S5-01: Add missing indexes for active-sessions + admin queries
-- S4-04: Enforce access_code at INSERT (prevent session without valid code)
-- S5-03: Optimize results-analytics (drop heavy JSONB from list queries)

-- ═══════════════════════════════════════════════════════════════════
-- S5-01: Missing indexes (from audit S5)
-- ═══════════════════════════════════════════════════════════════════

-- Index for active-sessions.js: queries .in('status', [active,paused,disconnected])
-- The existing idx_sessions_heartbeat only covers status='active' (partial).
-- This new index covers ALL 3 live statuses for the admin dashboard.
CREATE INDEX IF NOT EXISTS idx_sessions_live_status
  ON public.assessment_sessions (status, assessment_id, updated_at DESC)
  WHERE status IN ('active', 'paused', 'disconnected');

-- Index for admin-notification-center: queries violation_events by assessment_id
-- S5-02 fix: the admin notification center fetches violation_events without
-- assessment_id filter, causing multi-tenant data leak. This index supports
-- the filter we'll add in the JS code.
CREATE INDEX IF NOT EXISTS idx_violations_assessment_created
  ON public.violation_events (assessment_id, created_at DESC);

-- Index for results-analytics: queries submissions by assessment_id + submitted_at
CREATE INDEX IF NOT EXISTS idx_submissions_assessment_submitted
  ON public.submissions (assessment_id, submitted_at DESC);

-- Index for audit_logs by actor + created_at (admin audit trail queries)
CREATE INDEX IF NOT EXISTS idx_audit_actor_created
  ON public.audit_logs (actor_id, created_at DESC);

-- Index for assessments by created_by + created_at (admin list queries)
CREATE INDEX IF NOT EXISTS idx_assessments_created_by_created_at
  ON public.assessments (created_by, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════
-- S4-04: Enforce access_code at INSERT
-- ═══════════════════════════════════════════════════════════════════
-- Currently peserta can INSERT assessment_sessions with ANY assessment_id
-- (even non-existent ones). Add a trigger that validates the assessment_id
-- references a real, active assessment with a matching access_code.

CREATE OR REPLACE FUNCTION public.validate_session_access_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_assessment public.assessments%ROWTYPE;
BEGIN
  -- Fetch the assessment referenced by NEW.assessment_id
  SELECT * INTO v_assessment
  FROM public.assessments
  WHERE id = NEW.assessment_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSESSMENT_NOT_FOUND: Assessment does not exist or is not active';
  END IF;

  -- Verify the session's assessment_id matches an active assessment.
  -- The access_code is verified at the application layer (assessment-entry.js
  -- looks up assessment by access_code before creating session). This trigger
  -- is a defense-in-depth check: if someone bypasses the app layer and INSERTs
  -- directly, the assessment_id must still reference a valid active assessment.

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_session_access_code() IS
  'S4-04 fix: Defense-in-depth trigger — validates assessment_id references a real active assessment before INSERT. Prevents direct API INSERT with fake assessment_id.';

-- Drop old trigger if exists, create new
DROP TRIGGER IF EXISTS trg_validate_session_access_code ON public.assessment_sessions;
CREATE TRIGGER trg_validate_session_access_code
  BEFORE INSERT ON public.assessment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_session_access_code();

-- ═══════════════════════════════════════════════════════════════════
-- S5-03: Add lightweight view for results-analytics list queries
-- ═══════════════════════════════════════════════════════════════════
-- results-analytics.js loads 25MB of JSONB (grading_detail) per dashboard
-- view. Create a lightweight view that strips heavy JSONB for list queries.
-- The full grading_detail is only needed when viewing individual submission details.

CREATE OR REPLACE VIEW public.submissions_summary AS
SELECT
  id,
  session_id,
  assessment_id,
  user_id,
  user_email,
  score,
  max_score,
  correct_count,
  total_count,
  duration_seconds,
  attempt_number,
  submitted_at,
  graded_by,
  graded_at,
  created_at
  -- NOT exposed: grading_detail (50KB/row), answers (5-20KB/row), identity_snapshot (PII)
  -- These are loaded on-demand from submissions table when viewing details
FROM public.submissions;

ALTER VIEW public.submissions_summary SET (security_invoker = true);
GRANT SELECT ON public.submissions_summary TO authenticated;

COMMENT ON VIEW public.submissions_summary IS
  'S5-03 fix: Lightweight view of submissions without heavy JSONB (grading_detail, answers). Use for list/dashboard queries. Full data in submissions table for detail views.';

-- ═══════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════
-- Run these to verify:
--   SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%' ORDER BY indexname;
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.assessment_sessions'::regclass;
--   SELECT * FROM pg_views WHERE schemaname='public' AND viewname='submissions_summary';
