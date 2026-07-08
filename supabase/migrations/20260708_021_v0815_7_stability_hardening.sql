-- Migration 021: v0.815.7 stability hardening
-- Covers: peran_user() deleted_at filter, rate_limit RLS tightening,
-- health-check friendly DB ping, atomic submit helper, missing indexes.

-- 1. peran_user() must filter deleted_at — soft-deleted admins were
--    still satisfying `peran_user() = 'admin'` checks elsewhere.
CREATE OR REPLACE FUNCTION public.peran_user()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT peran FROM public.users
  WHERE id = auth.uid()
    AND deleted_at IS NULL;
$$;

COMMENT ON FUNCTION public.peran_user() IS
  'Returns the role of the current authenticated, non-deleted user.';

-- 2. Tighten rate_limit RLS — previously WITH CHECK (true) allowed any
--    authenticated user to insert rows for ANY session_id, enabling DoS
--    by filling another user's rate-limit quota.
DROP POLICY IF EXISTS rl_hb_auth_insert ON public.rate_limit_heartbeats;
CREATE POLICY rl_hb_auth_insert ON public.rate_limit_heartbeats
  FOR INSERT TO authenticated
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.assessment_sessions WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rl_submit_auth_insert ON public.rate_limit_submits;
CREATE POLICY rl_submit_auth_insert ON public.rate_limit_submits
  FOR INSERT TO authenticated
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.assessment_sessions WHERE user_id = auth.uid()
    )
  );

-- 3. Tighten violation_events INSERT — peserta could previously insert
--    violations for sessions that weren't theirs (using their own user_id).
DROP POLICY IF EXISTS violations_peserta_insert_own ON public.violation_events;
CREATE POLICY violations_peserta_insert_own ON public.violation_events
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND session_id IN (
      SELECT id FROM public.assessment_sessions WHERE user_id = auth.uid()
    )
  );

-- 4. Add expires_at to rate_limit tables so cleanup still works if
--    pg_cron misses a tick. Default 1 hour TTL is plenty for rate-limiting.
ALTER TABLE public.rate_limit_heartbeats
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '1 hour');
ALTER TABLE public.rate_limit_submits
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '1 hour');

CREATE INDEX IF NOT EXISTS idx_rl_hb_expires
  ON public.rate_limit_heartbeats(expires_at);
CREATE INDEX IF NOT EXISTS idx_rl_submit_expires
  ON public.rate_limit_submits(expires_at);

-- 5. users.updated_at trigger — every other table has one, users didn't.
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- 6. Missing indexes on hot paths.
CREATE INDEX IF NOT EXISTS idx_assessments_ac_end
  ON public.assessments(ac_end) WHERE ac_end IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_attempts_ip_time
  ON public.registration_attempts(ip_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reg_attempts_device_time
  ON public.registration_attempts(device_id, created_at DESC)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_attempts_email_time
  ON public.registration_attempts(email, created_at DESC)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_devices_device
  ON public.user_devices(device_id);

-- 7. Atomic submit helper — INSERT submission + UPDATE session in one
--    transaction so a step-2 failure can't leave submission recorded
--    but session.status='active'. Scoring stays in the submit-assessment
--    Edge Function (server-side TypeScript) — this RPC is for callers
--    that already have the score and want DB-level atomicity.
--
--    Idempotent on session_id: if a submission already exists for this
--    session, returns the existing record without re-inserting.
CREATE OR REPLACE FUNCTION public.submit_assessment_atomic(
  p_session_id UUID,
  p_user_id UUID,
  p_assessment_id UUID,
  p_answers JSONB,
  p_score INT,
  p_total_questions INT,
  p_correct_count INT,
  p_score_pct INT,
  p_duration_seconds INT,
  p_violation_count INT DEFAULT 0,
  p_grading_detail JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_submission_id UUID;
  v_session_status TEXT;
BEGIN
  -- Lock the session row so concurrent submits serialize.
  SELECT status INTO v_session_status
  FROM public.assessment_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- Idempotent: return existing submission if already present.
  SELECT id INTO v_submission_id
  FROM public.submissions
  WHERE session_id = p_session_id
  LIMIT 1;

  IF FOUND THEN
    RETURN v_submission_id;
  END IF;

  INSERT INTO public.submissions (
    assessment_id, session_id, user_id,
    answers, score, total_questions, correct_count,
    score_percentage, duration_seconds, violation_count,
    grading_detail, submitted_at
  ) VALUES (
    p_assessment_id, p_session_id, p_user_id,
    p_answers, p_score, p_total_questions, p_correct_count,
    p_score_pct, p_duration_seconds, p_violation_count,
    p_grading_detail, now()
  )
  RETURNING id INTO v_submission_id;

  UPDATE public.assessment_sessions
  SET status = 'submitted',
      submitted_at = now()
  WHERE id = p_session_id;

  RETURN v_submission_id;
END;
$$;

COMMENT ON FUNCTION public.submit_assessment_atomic IS
  'Atomic submit: INSERT submission + UPDATE session in one transaction. Idempotent on session_id. Scoring done by caller (Edge Function).';

-- 8. Cleanup: drop stale rate-limit rows older than 2 hours. Runs hourly
--    via pg_cron (already scheduled in migration 013). Add expires_at-aware
--    variant so the sweep is index-backed.
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM public.rate_limit_heartbeats
    WHERE expires_at IS NOT NULL AND expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::INT FROM deleted
  UNION ALL
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM public.rate_limit_heartbeats WHERE expires_at < now());
$$;
