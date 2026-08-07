-- 20260701_004_create_assessment_sessions.sql
-- Creates `assessment_sessions` — tracks each peserta's active session per
-- assessment. Used for:
--   - Proctoring dashboard (real-time monitoring)
--   - Cross-device resume
--   - Instant block (admin block → status='blocked' → peserta redirect)
--   - Heartbeat tracking (last_heartbeat_at for "is peserta still online?")
--
-- Replaces: ad-hoc violations table + localStorage submit lock

CREATE TABLE IF NOT EXISTS public.assessment_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id         uuid NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES public.users(id),

  -- Snapshot of peserta identity at session start
  user_email            text,
  identity_snapshot     jsonb,  -- { nama, kelas, is_manual, ... }

  -- Device + network forensics — IP stored 90 days then hashed per UU PDP.
  device_id             text,
  ip_address            text,
  user_agent            text,

  -- Session state machine
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'submitted', 'blocked', 'expired', 'disconnected')),

  -- Heartbeat (15s interval, in-memory cache 60s)
  started_at            timestamptz DEFAULT now(),
  last_heartbeat_at     timestamptz DEFAULT now(),
  submitted_at          timestamptz,

  -- Block info (instant block via Realtime channel)
  blocked_at            timestamptz,
  blocked_by            uuid REFERENCES public.users(id),
  blocked_reason        text,

  -- Progress tracking (for proctoring dashboard)
  current_section       int DEFAULT 0,
  current_question      int DEFAULT 0,
  progress_pct          numeric(5,2) DEFAULT 0.00 CHECK (progress_pct BETWEEN 0 AND 100),
  violation_count       int DEFAULT 0,

  -- Draft answers (for cross-device resume). Synced via heartbeat every 15s.
  draft_answers         jsonb DEFAULT '{}'::jsonb,

  -- Attempt number (for allow_retake feature)
  attempt_number        int DEFAULT 1 CHECK (attempt_number >= 1),

  -- Audit
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),

  -- One active session per user per assessment (partial unique index)
  -- Allows multiple blocked/expired/submitted sessions but only 1 active
  CONSTRAINT one_active_session UNIQUE (assessment_id, user_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- Indexes
CREATE INDEX idx_sessions_assessment   ON public.assessment_sessions(assessment_id);
CREATE INDEX idx_sessions_user         ON public.assessment_sessions(user_id);
CREATE INDEX idx_sessions_status       ON public.assessment_sessions(status);
CREATE INDEX idx_sessions_heartbeat    ON public.assessment_sessions(last_heartbeat_at DESC)
  WHERE status = 'active';
CREATE INDEX idx_sessions_attempt      ON public.assessment_sessions(assessment_id, user_id, attempt_number DESC);

-- RLS Policies
ALTER TABLE public.assessment_sessions ENABLE ROW LEVEL SECURITY;

-- Admins: read all sessions (collaborative model in single-tenant mode)
CREATE POLICY "sessions_admin_read"
  ON public.assessment_sessions FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Admins: update sessions for assessments they own (block, force-submit, etc.).
-- Server-side validation in Edge Function ensures admin owns the assessment.
CREATE POLICY "sessions_admin_update"
  ON public.assessment_sessions FOR UPDATE TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own sessions only
CREATE POLICY "sessions_peserta_read_own"
  ON public.assessment_sessions FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: insert own session (start assessment)
CREATE POLICY "sessions_peserta_insert_own"
  ON public.assessment_sessions FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: update own session (heartbeat, draft sync, status changes)
CREATE POLICY "sessions_peserta_update_own"
  ON public.assessment_sessions FOR UPDATE TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid())
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS sessions_updated_at ON public.assessment_sessions;
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON public.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Trigger: enforce one active session per assessment+user.
-- The UNIQUE constraint above handles this; the trigger gives a friendlier
-- error message instead of a raw constraint violation.
CREATE OR REPLACE FUNCTION enforce_single_active_session()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM 1 FROM public.assessment_sessions
    WHERE assessment_id = NEW.assessment_id
      AND user_id = NEW.user_id
      AND id <> NEW.id
      AND status = 'active';
    IF FOUND THEN
      RAISE EXCEPTION 'Peserta already has an active session for this assessment'
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_single_active_session ON public.assessment_sessions;
CREATE TRIGGER enforce_single_active_session
  BEFORE INSERT OR UPDATE OF status ON public.assessment_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_single_active_session();

COMMENT ON TABLE public.assessment_sessions IS
  'Tracks each peserta session per assessment. Powers proctoring dashboard, cross-device resume, instant block, heartbeat tracking.';
COMMENT ON COLUMN public.assessment_sessions.draft_answers IS 'JSONB. Synced every 15s via heartbeat Edge Function. Enables cross-device resume.';
COMMENT ON COLUMN public.assessment_sessions.status IS 'State machine: active → (paused|blocked|submitted|expired|disconnected).';
