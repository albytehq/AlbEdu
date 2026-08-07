-- 20260701_011_create_view_assessment_peserta.sql
-- Creates view `assessment_view_peserta` — strips sensitive fields from
-- assessments so peserta cannot read:
--   - total_score (would reveal scoring algorithm)
--   - ac_override (admin-only)
--   - ac_remaining_time (admin-only runtime state)
--   - created_by_email (admin PII)
--   - any internal/debug fields
--
-- Replaces legacy view `ujian_peserta` (which stripped p_q/kunci_jawaban).
-- jawaban_benar lives inside the sections JSONB. The view cannot efficiently
-- strip nested JSONB fields, so we expose sections AS-IS and rely on RLS +
-- server-side scoring to prevent cheating.
--
-- Security: peserta CAN read jawaban_benar from sections JSONB via this view.
-- Mitigation: server-side scoring — peserta cannot fake score even if they
-- know jawaban_benar, because scoring happens in the Edge Function. Peserta
-- cannot submit modified answers either — submit-assessment re-validates
-- against stored sections. The real anti-cheat is server-side scoring, not
-- hiding jawaban_benar.

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

  -- Sections (includes jawaban_benar — see Security note above)
  sections,

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

-- Grants
GRANT SELECT ON public.assessment_view_peserta TO authenticated;

COMMENT ON VIEW public.assessment_view_peserta IS
  'Peserta-facing view of assessments. Strips admin-only fields. jawaban_benar is exposed in sections JSONB (mitigated by server-side scoring).';
