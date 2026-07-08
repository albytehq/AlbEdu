-- 20260701_007_create_question_bank.sql
-- Creates `question_bank` — reusable question bank per admin (owner_id).
-- Same question structure as assessment sections[].questions[].

CREATE TABLE IF NOT EXISTS public.question_bank (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Classification
  subject         text NOT NULL,  -- for example "Matematika", "Bahasa Inggris"
  topic           text,           -- for example "Aljabar", "Tenses" (optional)
  difficulty      text CHECK (difficulty IN ('easy', 'medium', 'hard')),

  -- Question content (same structure as assessment sections[].questions[])
  type            text NOT NULL CHECK (type IN ('PG', 'esai')),
  question        text NOT NULL CHECK (char_length(question) >= 3),
  pilihan         jsonb,  -- { A, B, C, D } for PG, NULL for esai
  jawaban_benar   text,   -- letter A/B/C/D for PG, NULL for esai
  media           jsonb DEFAULT '{}'::jsonb,  -- { video: {enabled, src}, gambar: [] }

  -- Tags (for search + filter)
  tags            text[] DEFAULT '{}'::text[],

  -- Usage analytics (auto-updated when question is added to an assessment)
  usage_count     int DEFAULT 0,
  last_used_at    timestamptz,

  -- Audit
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_qbank_owner      ON public.question_bank(owner_id);
CREATE INDEX idx_qbank_subject    ON public.question_bank(subject);
CREATE INDEX idx_qbank_difficulty ON public.question_bank(difficulty) WHERE difficulty IS NOT NULL;
CREATE INDEX idx_qbank_tags       ON public.question_bank USING GIN(tags);
CREATE INDEX idx_qbank_last_used  ON public.question_bank(last_used_at DESC) WHERE last_used_at IS NOT NULL;
CREATE INDEX idx_qbank_search     ON public.question_bank USING gin(to_tsvector('simple', subject || ' ' || coalesce(topic, '') || ' ' || question));

-- RLS Policies
ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;

-- Admins: full CRUD on own questions only (private per admin)
CREATE POLICY "qbank_admin_all_own"
  ON public.question_bank FOR ALL TO authenticated
  USING (peran_user() = 'admin' AND owner_id = auth.uid())
  WITH CHECK (peran_user() = 'admin' AND owner_id = auth.uid());

-- Peserta: NO access (question bank is admin-only)
-- (No SELECT policy for peserta = deny by default)

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS qbank_updated_at ON public.question_bank;
CREATE TRIGGER qbank_updated_at
  BEFORE UPDATE ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.question_bank IS
  'Reusable question bank. Per-admin private. Same question structure as assessment sections.';
COMMENT ON COLUMN public.question_bank.usage_count IS 'Auto-incremented when this question is added to an assessment (via Edge Function).';
