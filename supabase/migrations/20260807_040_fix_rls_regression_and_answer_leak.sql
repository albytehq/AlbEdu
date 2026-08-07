-- 20260807_040_fix_rls_regression_and_answer_leak.sql
--
-- CRITICAL SECURITY FIX (S4-01 + S4-02 from audit)
--
-- S4-01: RLS regression — migration 031 (20260731_001) created a LOOSE
--   `sessions_peserta_update_own` policy with no column restrictions,
--   which ORs over the strict `sessions_peserta_update_own_safe_fields`
--   policy from migration 016. Result: peserta can self-clear blocks,
--   zero violations, reset timer via browser console.
--
--   Root cause: migration 031 intended to allow ADMIN testing (admin
--   creates a session with their own user_id to test the peserta flow).
--   But it did so by loosening the PESERTA policy instead of adding a
--   separate ADMIN policy. PostgreSQL RLS ORs permissive policies, so
--   the loose policy wins.
--
--   Fix: drop the loose policy, keep the strict peserta policy from 016,
--   add a separate admin policy for admin testing.
--
-- S4-02: Answer leak — view `assessment_view_peserta` (migration 011)
--   exposes the full `sections` JSONB which contains `jawaban_benar`
--   (correct answers) for each question. Any authenticated peserta can
--   pre-fetch all exam answers before starting. The migration 011
--   comment acknowledged this and claimed "server-side scoring mitigates"
--   — but that's wrong. Server-side scoring prevents SCORE FAKING, not
--   ANSWER LEAKING. A peserta who knows jawaban_benar can answer
--   everything correctly = 100% score = exam integrity destroyed.
--
--   Fix: create a `strip_jawaban_benar(jsonb)` function that recursively
--   removes `jawaban_benar` from each question in each section. Recreate
--   the view using this function. Also set security_invoker=true so the
--   view respects RLS of the underlying assessments table.
--
--   Note: access_code is KEPT in the view because the peserta frontend
--   uses it as the lookup key (repo.getDoc('assessment_view_peserta',
--   token, 'access_code')). Peserta already knows the code (they entered
--   it), so exposing it in the view is not a security issue.

-- ═══════════════════════════════════════════════════════════════════
-- S4-01: Fix RLS regression on assessment_sessions UPDATE
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Drop the LOOSE policy from migration 031.
-- This was the regression — it allowed peserta to update ANY column
-- (status, blocked_at, submitted_at, started_at, violation_count,
-- attempt_number) on their own session row.
DROP POLICY IF EXISTS "sessions_peserta_update_own" ON public.assessment_sessions;

-- Step 2: Verify the STRICT policy from migration 016 still exists.
-- It should — migration 031 dropped "sessions_peserta_update_own" (different
-- name) and created a new one with that name, leaving "sessions_peserta_update_own_safe_fields"
-- intact. This strict policy enforces column immutability for peserta:
-- status, blocked_at, blocked_by, submitted_at, started_at, violation_count,
-- attempt_number cannot be changed by peserta.
-- (No action needed — just documenting that it's still active.)

-- Step 3: Add a separate ADMIN policy for admin testing.
-- Migration 031's intent was to allow admins to test the peserta flow
-- (admin creates a session with their own user_id). We preserve that
-- capability but in a SEPARATE policy scoped to admin role only.
-- Admins are trusted, so no column restrictions — they can update
-- any field on their own test session.
CREATE POLICY "sessions_admin_test_update_own"
  ON public.assessment_sessions FOR UPDATE TO authenticated
  USING (
    peran_user() = 'admin'
    AND user_id = auth.uid()
  )
  WITH CHECK (
    peran_user() = 'admin'
    AND user_id = auth.uid()
  );

COMMENT ON POLICY "sessions_admin_test_update_own" ON public.assessment_sessions IS
  'Admin can update their own test sessions freely (admin testing flow). Peserta updates go through sessions_peserta_update_own_safe_fields which enforces column immutability.';

-- ═══════════════════════════════════════════════════════════════════
-- S4-02: Fix jawaban_benar leak in assessment_view_peserta
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Create a function that strips `jawaban_benar` from sections JSONB.
-- The sections structure is:
--   [
--     {
--       "name": "Section 1",
--       "type_question": "PG",
--       "questions": [
--         {"idq": "1", "pertanyaan": "...", "jawaban_benar": "A", "pilihan": [...], "skor": 10},
--         ...
--       ]
--     },
--     ...
--   ]
--
-- The function iterates over sections, then over questions within each
-- section, and deletes the `jawaban_benar` key from each question.
-- Returns the modified JSONB. If sections is null or not an array,
-- returns an empty array.

CREATE OR REPLACE FUNCTION public.strip_jawaban_benar(sections jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_set(
          section,
          '{questions}',
          COALESCE(
            (
              SELECT jsonb_agg(question - 'jawaban_benar')
              FROM jsonb_array_elements(section -> 'questions') AS question
            ),
            '[]'::jsonb
          )
        )
      )
      FROM jsonb_array_elements(sections) AS section
    ),
    '[]'::jsonb
  );
$$;

COMMENT ON FUNCTION public.strip_jawaban_benar(jsonb) IS
  'Strips jawaban_benar (correct answer) from each question in each section of the sections JSONB. Used by assessment_view_peserta to prevent peserta from pre-fetching answers.';

-- Step 2: Recreate the view with jawaban_benar stripped from sections.
-- access_code is KEPT (needed for peserta frontend lookup).
-- All other fields unchanged from migration 011.
CREATE OR REPLACE VIEW public.assessment_view_peserta AS
SELECT
  -- Identity
  id,
  access_code,

  -- Metadata (safe to expose)
  title,
  subject,
  duration_minutes,
  access_mode,
  note_enabled,
  note_text,
  max_pages_per_section,

  -- Theme (peserta needs this to render UI)
  theme_config,

  -- Identity config (peserta needs this to render identity form)
  identity_mode,
  identity_config,

  -- Sections — jawaban_benar STRIPPED (S4-02 fix)
  public.strip_jawaban_benar(sections) AS sections,

  -- Feature toggles
  allow_retake,

  -- Access control (peserta needs this to know if exam is open)
  ac_manual_status,
  ac_scheduled_start,
  ac_scheduled_end,
  ac_end,

  -- Status
  status,

  -- Timestamps
  published_at

  -- NOT exposed:
  --   total_score, ac_override, ac_remaining_time, created_by, created_by_email,
  --   organization_id, created_at, updated_at
FROM public.assessments
WHERE status = 'active';

-- Step 3: Set security_invoker = true so the view respects RLS of the
-- underlying assessments table. Without this, views run with the view
-- owner's privileges, bypassing RLS. With security_invoker=true, the
-- view runs with the querying user's privileges, so RLS on assessments
-- applies. (PostgreSQL 15+ feature, supported by Supabase.)
ALTER VIEW public.assessment_view_peserta SET (security_invoker = true);

-- Step 4: Re-grant SELECT to authenticated (ALTER VIEW may reset grants).
GRANT SELECT ON public.assessment_view_peserta TO authenticated;

-- Update the comment to reflect the security fix.
COMMENT ON VIEW public.assessment_view_peserta IS
  'Peserta-facing view of assessments. Strips admin-only fields AND jawaban_benar from sections JSONB (S4-02 fix). security_invoker=true ensures RLS on assessments applies. access_code is kept (needed for peserta lookup).';

-- ═══════════════════════════════════════════════════════════════════
-- Verification queries (run manually to confirm fix)
-- ═══════════════════════════════════════════════════════════════════
--
-- -- S4-01: Verify only strict peserta policy + admin policy exist (no loose one)
-- SELECT polname, polcmd, qual, with_check
-- FROM pg_policy
-- WHERE polrelid = 'public.assessment_sessions'::regclass
--   AND polcmd = 'u';  -- UPDATE policies
-- Expected:
--   sessions_peserta_update_own_safe_fields  (strict, from migration 016)
--   sessions_admin_test_update_own           (admin, from this migration)
--   sessions_peserta_update_own should NOT exist (dropped by this migration)
--
-- -- S4-02: Verify jawaban_benar is stripped from the view
-- SELECT sections->0->'questions'->0->'jawaban_benar' AS still_has_answer
-- FROM public.assessment_view_peserta
-- LIMIT 1;
-- Expected: NULL (jawaban_benar stripped)
--
-- -- S4-02: Verify security_invoker is set
-- SELECT reloptions FROM pg_class WHERE relname = 'assessment_view_peserta';
-- Expected: {security_invoker=true}
