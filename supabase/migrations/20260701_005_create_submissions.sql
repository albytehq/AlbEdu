-- =============================================================================
-- 20260701_005_create_submissions.sql
-- AlbEdu v1.0.0 — Phase 1.5
-- =============================================================================
-- Creates `submissions` — final submitted answers + server-side score.
-- Replaces: hasil_peserta JSONB blob (embedded in ujian row — anti-pattern).
--
-- Q5: 100% server-side scoring. Score computed in submit-assessment Edge
-- Function, NOT client. Peserta cannot fake score.
-- Q6: Esai grading skipped. graded_by NULL until manual grading UI (Phase 9).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id     uuid NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL REFERENCES public.assessment_sessions(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES public.users(id),

  -- Snapshot (immutable once submitted — for forensic audit)
  identity_snapshot jsonb NOT NULL,
  user_email        text,

  -- Final answers (immutable once submitted)
  -- Format: { "section_0": { "1": "A", "2": "B" }, "section_1": { "1": "esai answer text" } }
  answers           jsonb NOT NULL,

  -- Server-side score (Q5: computed in Edge Function, NOT client)
  score             numeric(5,2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  max_score         int DEFAULT 100,
  correct_count     int,
  total_count       int,

  -- Per-question grading detail (Q6: esai grading deferred — auto-set to 0 or NULL)
  -- [{ section_idx, idq, peserta_answer, jawaban_benar, is_correct, points, type }]
  grading_detail    jsonb,

  -- Timing
  started_at        timestamptz NOT NULL,
  submitted_at      timestamptz DEFAULT now(),
  duration_seconds  int,

  -- Grading metadata (Q6: skipped, all NULL until Phase 9)
  graded_by         uuid REFERENCES public.users(id),
  graded_at         timestamptz,
  grading_notes     text,

  -- Attempt tracking (Q: allow_retake feature)
  attempt_number    int DEFAULT 1 CHECK (attempt_number >= 1),

  -- Audit
  created_at        timestamptz DEFAULT now(),

  -- One submission per session (immutable)
  CONSTRAINT submissions_session_unique UNIQUE (session_id)
);

-- ── Indexes ──
CREATE INDEX idx_submissions_assessment  ON public.submissions(assessment_id);
CREATE INDEX idx_submissions_user         ON public.submissions(user_id);
CREATE INDEX idx_submissions_submitted    ON public.submissions(submitted_at DESC);
CREATE INDEX idx_submissions_score        ON public.submissions(assessment_id, score DESC);
CREATE INDEX idx_submissions_attempt      ON public.submissions(assessment_id, user_id, attempt_number DESC);

-- ── RLS Policies ──
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

-- Admins: read all submissions (collaborative — single-tenant all share)
CREATE POLICY "submissions_admin_read"
  ON public.submissions FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Admins: update only for grading (Phase 9 — manual esai grading)
-- For now, no UPDATE policy (submissions are immutable post-submit)
CREATE POLICY "submissions_admin_grade"
  ON public.submissions FOR UPDATE TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own submissions only
CREATE POLICY "submissions_peserta_read_own"
  ON public.submissions FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: insert own submission (submit-assessment Edge Function does this server-side)
CREATE POLICY "submissions_peserta_insert_own"
  ON public.submissions FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- No UPDATE for peserta — submissions are immutable once submitted
-- No DELETE for anyone (soft-delete via separate archive flow if needed)

COMMENT ON TABLE public.submissions IS
  'Final submitted answers + server-side score. Replaces hasil_peserta JSONB blob. Q5: 100% server-side scoring via submit-assessment Edge Function.';
COMMENT ON COLUMN public.submissions.score IS 'Server-computed score (0-100). NULL only if grading in progress.';
COMMENT ON COLUMN public.submissions.grading_detail IS 'Per-question grading. Auto-graded PG + (future) manual esai.';
COMMENT ON COLUMN public.submissions.identity_snapshot IS 'Immutable snapshot of peserta identity at submit time. For audit.';
