-- 20260807_042_drop_custom_theme_feature.sql
--
-- Remove custom theme feature — not a big win for Akses Awal, adds
-- maintenance burden. Drop theme_config column from assessments table.
--
-- The column is JSONB and stores: { primary, text_accent, font, mode, preset }
-- All UI code that reads/writes this column has been removed.

-- Step 1: Drop the view that depends on theme_config
DROP VIEW IF EXISTS public.assessment_view_peserta;

-- Step 2: Drop the column
ALTER TABLE public.assessments DROP COLUMN IF EXISTS theme_config;

-- Step 3: Recreate the view WITHOUT theme_config
-- (theme_config was previously exposed but is no longer needed)
CREATE OR REPLACE VIEW public.assessment_view_peserta AS
SELECT
  id,
  access_code,
  title,
  subject,
  duration_minutes,
  access_mode,
  note_enabled,
  note_text,
  max_pages_per_section,
  identity_mode,
  identity_config,
  public.strip_jawaban_benar(sections) AS sections,
  allow_retake,
  ac_manual_status,
  ac_scheduled_start,
  ac_scheduled_end,
  ac_end,
  status,
  published_at
FROM public.assessments
WHERE status = 'active';

-- Preserve security_invoker + grants
ALTER VIEW public.assessment_view_peserta SET (security_invoker = true);
GRANT SELECT ON public.assessment_view_peserta TO authenticated;

COMMENT ON TABLE public.assessments IS
  'Assessments table. Custom theme feature removed for Akses Awal — all assessments use the default AlbEdu blue theme.';
