-- =============================================================================
-- 20260701_003_create_assessments.sql
-- AlbEdu v1.0.0 — Phase 1.3
-- =============================================================================
-- Creates the new `assessments` table that REPLACES the legacy `ujian` table.
--
-- Key changes vs legacy `ujian`:
--   - access_code is 6-digit (was 5-digit kode_id)
--   - All fields snake_case English (was Indonesian: judul → title, etc.)
--   - access_control normalized to flat columns (was JSONB blob)
--   - theme_config JSONB (was nested theme object)
--   - allow_retake BOOLEAN (NEW — feature toggle "Boleh ulang?")
--   - organization_id (SCloud-ready, nullable for single-tenant)
--   - created_by is UUID FK to users.id (was text createdBy)
--   - status includes 'archived' (was only 'draft|active|expired')
--
-- Decision ref:
--   - Q1: Hybrid multi-tenant (organization_id nullable)
--   - Q2: Collaborative ownership (admin can read all, edit/delete own)
--   - Q5: 100% server-side scoring (sections stored, scoring in Edge Function)
--   - §4.5: 6-digit access code
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.assessments (
  -- Identity
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_code           text UNIQUE NOT NULL CHECK (access_code ~ '^[0-9]{6}$'),

  -- Organization (SCloud-ready, NULL = single-tenant)
  organization_id       uuid REFERENCES public.organizations(id),

  -- Ownership (Q2: collaborative — admin can SELECT all, but created_by determines UPDATE/DELETE)
  created_by            uuid NOT NULL REFERENCES public.users(id),
  created_by_email      text,
  published_at          timestamptz,

  -- Metadata (English, snake_case)
  title                 text NOT NULL CHECK (char_length(title) >= 5),
  subject               text NOT NULL,
  duration_minutes      int NOT NULL CHECK (duration_minutes BETWEEN 1 AND 120),

  -- Access mode (was mode_pembuka)
  access_mode           text NOT NULL DEFAULT 'manual'
                        CHECK (access_mode IN ('manual', 'scheduled')),

  -- Note (was catatan/is_catatan)
  note_enabled          boolean DEFAULT FALSE,
  note_text             text CHECK (note_text IS NULL OR char_length(note_text) <= 500),

  -- Section config
  max_pages_per_section int DEFAULT 3 CHECK (max_pages_per_section BETWEEN 1 AND 10),
  total_score           int DEFAULT 100 CHECK (total_score = 100),  -- hardcoded v1.0.0

  -- Theme (production-grade, Google Form-like — see docs/THEME-SYSTEM.md)
  theme_config          jsonb DEFAULT '{}'::jsonb,

  -- Identity (peserta identification)
  identity_mode         text NOT NULL DEFAULT 'manual'
                        CHECK (identity_mode IN ('manual', 'daftar')),
  identity_config       jsonb DEFAULT '{}'::jsonb,

  -- Sections (JSONB array, same structure as v0.2.0 but stored here directly)
  -- [{ id, name, type_question: 'PG'|'esai', questions: [{ idq, pertanyaan, pilihan, jawaban_benar, skor, media }] }]
  sections              jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Feature toggles
  allow_retake          boolean DEFAULT FALSE,  -- Q: "Boleh ulang?" Ya/Tidak

  -- Status
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft', 'active', 'archived')),

  -- ── Access Control (normalized from JSONB blob) ──
  -- Manual mode runtime state
  ac_manual_status      text DEFAULT 'closed' CHECK (ac_manual_status IN ('closed', 'open', 'finished')),
  ac_override           boolean DEFAULT FALSE,
  ac_end                timestamptz,  -- runtime: when exam should end (manual) or null
  ac_remaining_time     int,  -- runtime: seconds remaining (paused state), null when running

  -- Scheduled mode config
  ac_scheduled_start    timestamptz,
  ac_scheduled_end      timestamptz,

  -- Audit
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ── Indexes ──
CREATE INDEX idx_assessments_created_by    ON public.assessments(created_by);
CREATE INDEX idx_assessments_status        ON public.assessments(status);
CREATE INDEX idx_assessments_access_code   ON public.assessments(access_code);
CREATE INDEX idx_assessments_organization  ON public.assessments(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX idx_assessments_active        ON public.assessments(id, created_by, ac_end) WHERE status = 'active';
CREATE INDEX idx_assessments_created_at    ON public.assessments(created_at DESC);

-- ── RLS Policies ──
-- Q2: Collaborative — admins can SELECT all active assessments, but only
-- created_by can UPDATE/DELETE.

ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;

-- Admins can read all assessments (collaborative model — siswa lihat semua admin)
CREATE POLICY "assessments_admin_read_all"
  ON public.assessments FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Admins can INSERT (created_by auto-set to auth.uid() via trigger)
CREATE POLICY "assessments_admin_insert"
  ON public.assessments FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'admin' AND created_by = auth.uid());

-- Admins can UPDATE only their own (creator)
CREATE POLICY "assessments_admin_update_own"
  ON public.assessments FOR UPDATE TO authenticated
  USING (peran_user() = 'admin' AND created_by = auth.uid())
  WITH CHECK (peran_user() = 'admin' AND created_by = auth.uid());

-- Admins can DELETE only their own (creator)
CREATE POLICY "assessments_admin_delete_own"
  ON public.assessments FOR DELETE TO authenticated
  USING (peran_user() = 'admin' AND created_by = auth.uid());

-- Peserta can SELECT only active assessments (NOT draft, NOT archived)
CREATE POLICY "assessments_peserta_read_active"
  ON public.assessments FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND status = 'active');

-- ── Trigger: auto-update updated_at ──
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assessments_updated_at ON public.assessments;
CREATE TRIGGER assessments_updated_at
  BEFORE UPDATE ON public.assessments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Trigger: validate access_code uniqueness on INSERT ──
-- (UNIQUE constraint already handles this, but we add explicit error message)
-- No-op trigger; constraint is sufficient.

COMMENT ON TABLE public.assessments IS
  'AlbEdu assessments table (v1.0.0). Replaces legacy `ujian`. 6-digit access_code. Normalized access_control columns. allow_retake feature toggle. SCloud-ready (organization_id nullable).';

COMMENT ON COLUMN public.assessments.access_code IS '6-digit numeric string (was 5-digit kode_id). 1M combinations + Turnstile = brute-force safe.';
COMMENT ON COLUMN public.assessments.allow_retake IS 'Feature toggle: can peserta retake this assessment? Default FALSE (one-shot).';
COMMENT ON COLUMN public.assessments.theme_config IS 'JSONB. Schema: { preset, primary, font, mode }. Auto-derived colors computed client-side. See docs/THEME-SYSTEM.md';
COMMENT ON COLUMN public.assessments.sections IS 'JSONB array. Same structure as v0.2.0 (id, name, type_question, questions[]). pilihan is OBJECT {A,B,C,D}.';
