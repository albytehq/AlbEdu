-- ═══════════════════════════════════════════════════════════════════
-- Migration 20260815_046 — Submissions Forensic Hardening
-- ═══════════════════════════════════════════════════════════════════
-- PROBLEM:
--   assessments ON DELETE CASCADE → submissions destroyed when
--   assessment deleted. 50 peserta scores → GONE permanently.
--   Double-cascade: submissions killed via assessment_id AND
--   session_id→assessment_sessions→assessments.
--
-- ARCHITECTURE: "Defensive Triple Layer"
--   Layer 1 (DB): FK CASCADE → SET NULL (submissions survive)
--   Layer 2 (EF): Snapshot assessment data at submit time
--   Layer 3 (UI): Archive-only (no hard delete from UI)
--
-- This migration implements Layer 1 (DB):
--   1. Add assessment_title, assessment_subject, assessment_access_code
--   2. Add assessment_sections_snapshot (jsonb)
--   3. Drop NOT NULL on assessment_id + session_id
--   4. Change FK from CASCADE → SET NULL (both paths)
--   5. Backfill existing submissions with assessment metadata
--   6. Add index for detached submissions (assessment_id IS NULL)
--
-- APPLY VIA: Supabase Management API
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Add denormalized assessment metadata columns ──
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS assessment_title text,
  ADD COLUMN IF NOT EXISTS assessment_subject text,
  ADD COLUMN IF NOT EXISTS assessment_access_code text,
  ADD COLUMN IF NOT EXISTS assessment_sections_snapshot jsonb;

-- ── 2. Backfill existing submissions with assessment metadata ──
UPDATE public.submissions s
SET
  assessment_title = a.title,
  assessment_subject = a.subject,
  assessment_access_code = a.access_code,
  assessment_sections_snapshot = a.sections
FROM public.assessments a
WHERE s.assessment_id = a.id
  AND s.assessment_title IS NULL;

-- ── 3. Drop NOT NULL on assessment_id + session_id ──
-- (needed for SET NULL to work when parent is deleted)
ALTER TABLE public.submissions
  ALTER COLUMN assessment_id DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL;

-- ── 4. Change FK: CASCADE → SET NULL ──
-- Path 1: submissions.assessment_id → assessments
ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_assessment_id_fkey;
ALTER TABLE public.submissions
  ADD CONSTRAINT submissions_assessment_id_fkey
  FOREIGN KEY (assessment_id) REFERENCES public.assessments(id)
  ON DELETE SET NULL;

-- Path 2: submissions.session_id → assessment_sessions
ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_session_id_fkey;
ALTER TABLE public.submissions
  ADD CONSTRAINT submissions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.assessment_sessions(id)
  ON DELETE SET NULL;

-- ── 5. Index for detached submissions (assessment_id IS NULL) ──
CREATE INDEX IF NOT EXISTS idx_submissions_detached
  ON public.submissions (user_id)
  WHERE assessment_id IS NULL;

-- ── 6. Index for assessment_access_code lookups ──
CREATE INDEX IF NOT EXISTS idx_submissions_access_code
  ON public.submissions (assessment_access_code)
  WHERE assessment_access_code IS NOT NULL;

-- ── 7. Verify ──
SELECT
  'columns' AS check,
  count(*) AS count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'submissions'
  AND column_name IN ('assessment_title', 'assessment_subject', 'assessment_access_code', 'assessment_sections_snapshot')

UNION ALL

SELECT
  'fk_type' AS check,
  CASE WHEN confdeltype = 'n' THEN 1 ELSE 0 END
FROM pg_constraint
WHERE conname = 'submissions_assessment_id_fkey';

COMMIT;

-- Expected: columns=4, fk_type=1 (n = SET NULL)
