-- ============================================================================
-- Migration 036: Add created_by_email index on assessments
-- ============================================================================
-- ALB-SEC-020 (LOW): admin dashboard list-by-email query does seq scan.
-- Add partial index for non-NULL emails.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_assessments_created_by_email
  ON public.assessments(created_by_email)
  WHERE created_by_email IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'Migration 036 complete: idx_assessments_created_by_email added (partial, WHERE created_by_email IS NOT NULL)';
END $$;
