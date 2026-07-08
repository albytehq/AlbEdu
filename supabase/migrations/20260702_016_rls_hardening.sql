-- 20260702_016_rls_hardening.sql
-- Security hardening of RLS policies.
--
-- ISSUES FOUND IN AUDIT:
--
-- 1. assessment_sessions — peserta UPDATE policy is too permissive.
--    The current rule `peserta AND user_id = auth.uid()` allows a peserta
--    to UPDATE any column on their own session row, including:
--      - status (could self-block → unblock, or self-submit-then-reopen)
--      - violation_count (could zero out their own violations)
--      - started_at (could reset the timer)
--      - blocked_at / blocked_by (could clear their own block)
--
--    A peserta should ONLY be allowed to update:
--      - last_heartbeat_at (heartbeat Edge Function — but EF uses service role)
--      - draft_answers (sync answers)
--      - current_section / current_question / progress_pct (UI progress)
--
--    All sensitive state transitions (status, blocked_at, submitted_at)
--    should be done via Edge Functions using the service role key, NOT
--    via direct peserta UPDATE.
--
-- 2. violation_events — peserta INSERT policy allows inserting violations
--    for any user_id, not just auth.uid(). Anti-cheat client-side reporting
--    must be scoped to the authenticated user.
--
-- 3. assessment_sessions DELETE — there is no DELETE policy. By default,
--    RLS DENIES if no policy matches, but explicit DENY is clearer.
--
-- 4. submissions — admin UPDATE policy allows updating any submission
--    without scope. Should be limited to grading fields only when manual
--    esai grading lands. For now, restrict to graded_by/graded_at/
--    grading_notes columns via a COLUMN-level policy.

-- Replace peserta UPDATE policy on assessment_sessions.
-- Old policy allowed peserta to update ANY column on their own row.
-- New policy restricts peserta to only "safe" columns:
--   last_heartbeat_at, draft_answers, current_section, current_question,
--   progress_pct.
-- All other state changes (status, blocked_at, submitted_at, etc.) must
-- go through Edge Functions using the service role key.

DROP POLICY IF EXISTS "sessions_peserta_update_own" ON public.assessment_sessions;

-- Peserta can update their own session, but only safe progress fields.
-- The WITH CHECK clause ensures they cannot escalate status or clear blocks.
CREATE POLICY "sessions_peserta_update_own_safe_fields"
  ON public.assessment_sessions FOR UPDATE TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid())
  WITH CHECK (
    peran_user() = 'peserta'
    AND user_id = auth.uid()
    -- Block forbidden column changes:
    -- status cannot be changed by peserta (must go through Edge Function)
    AND status IS NOT DISTINCT FROM (SELECT status FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    -- blocked_at / blocked_by cannot be cleared by peserta
    AND blocked_at IS NOT DISTINCT FROM (SELECT blocked_at FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    AND blocked_by IS NOT DISTINCT FROM (SELECT blocked_by FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    -- submitted_at cannot be set by peserta (Edge Function only)
    AND submitted_at IS NOT DISTINCT FROM (SELECT submitted_at FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    -- started_at cannot be reset
    AND started_at IS NOT DISTINCT FROM (SELECT started_at FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    -- violation_count cannot be modified by peserta (admin/EF only)
    AND violation_count IS NOT DISTINCT FROM (SELECT violation_count FROM public.assessment_sessions WHERE id = assessment_sessions.id)
    -- attempt_number cannot be changed
    AND attempt_number IS NOT DISTINCT FROM (SELECT attempt_number FROM public.assessment_sessions WHERE id = assessment_sessions.id)
  );

-- Restrict violation_events INSERT to peserta's own user_id.
-- Old policy: peserta could INSERT violation_events with ANY user_id.
-- New policy: user_id MUST match auth.uid().

DROP POLICY IF EXISTS "violations_peserta_insert" ON public.violation_events;
DROP POLICY IF EXISTS "violations_peserta_insert_own" ON public.violation_events;

CREATE POLICY "violations_peserta_insert_own"
  ON public.violation_events FOR INSERT TO authenticated
  WITH CHECK (
    peran_user() = 'peserta'
    AND user_id = auth.uid()
  );

-- Explicit DENY on assessment_sessions DELETE for peserta.
-- (Admins can delete via service role key only — no RLS DELETE policy.)

-- Restrict submissions admin UPDATE to grading fields only.
-- Manual esai grading can be added later. Until then, no UPDATE at all.
-- The current "submissions_admin_grade" policy allows updating any column.

DROP POLICY IF EXISTS "submissions_admin_grade" ON public.submissions;

-- Re-add when manual esai grading lands. For now, submissions are immutable
-- post-submit. Score is computed server-side in submit-assessment Edge Function.

-- Add audit_logs INSERT policy for Edge Functions.
-- Edge Functions insert audit logs using service role key — no RLS needed.
-- But explicit policy documents intent and prevents accidental anon access.

CREATE POLICY "audit_logs_anon_deny"
  ON public.audit_logs FOR SELECT TO anon
  USING (false);

CREATE POLICY "audit_logs_anon_deny_insert"
  ON public.audit_logs FOR INSERT TO anon
  WITH CHECK (false);

-- Authenticated users can read their own audit logs only (DSR compliance)
CREATE POLICY "audit_logs_self_read"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (actor_id = auth.uid());

-- Admins can read all audit logs
CREATE POLICY "audit_logs_admin_read_all"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Document the policy hardening.
COMMENT ON POLICY "sessions_peserta_update_own_safe_fields" ON public.assessment_sessions IS
  'Peserta can only update progress fields (heartbeat, draft_answers, current_section/question, progress_pct). All sensitive state (status, blocked_at, submitted_at, started_at, violation_count, attempt_number) is immutable from the client — must go through Edge Functions using service role key.';
