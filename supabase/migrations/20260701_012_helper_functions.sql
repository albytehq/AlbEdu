-- 20260701_012_helper_functions.sql
-- Helper functions used by RLS policies + Edge Functions.
-- Reuses legacy `peran_user()` if it exists; creates new helpers.

-- peran_user() — SECURITY DEFINER, returns role of current user.
-- Already exists from legacy migration. Recreate idempotently.
CREATE OR REPLACE FUNCTION public.peran_user()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT peran FROM public.users WHERE id = auth.uid();
$$;

COMMENT ON FUNCTION public.peran_user() IS
  'Returns peran (''admin'' | ''peserta'' | NULL) of current authenticated user. SECURITY DEFINER to avoid RLS recursion. Used by all RLS policies.';

-- org_id() — returns organization_id of current user (multi-tenant).
-- Returns NULL in single-tenant mode (all users have organization_id IS NULL).
CREATE OR REPLACE FUNCTION public.org_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT organization_id FROM public.users WHERE id = auth.uid();
$$;

COMMENT ON FUNCTION public.org_id() IS
  'Returns organization_id of current user. NULL in single-tenant mode.';

-- is_admin() — convenience boolean check
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT peran_user() = 'admin';
$$;

-- is_peserta() — convenience boolean check
CREATE OR REPLACE FUNCTION public.is_peserta()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT peran_user() = 'peserta';
$$;

-- generate_access_code() — 6-digit random string.
-- Used by Edge Function submit-assessment to generate unique codes.
-- Caller must check uniqueness (UNIQUE constraint will catch dupes).
CREATE OR REPLACE FUNCTION public.generate_access_code()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT lpad(floor(random() * 1000000)::int::text, 6, '0');
$$;

COMMENT ON FUNCTION public.generate_access_code() IS
  'Generates random 6-digit string for assessment access_code. Caller must handle uniqueness via UNIQUE constraint.';

-- count_active_sessions_for_user(assessment_uuid)
-- Used by start-session Edge Function to check if peserta already has
-- active session (enforce one-shot unless allow_retake=TRUE).
CREATE OR REPLACE FUNCTION public.count_active_sessions_for_user(
  p_assessment_id uuid,
  p_user_id uuid
)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.assessment_sessions
  WHERE assessment_id = p_assessment_id
    AND user_id = p_user_id
    AND status IN ('active', 'paused');
$$;

-- count_submissions_for_user(assessment_uuid)
-- Used to enforce allow_retake limit (default: 1 attempt unless allow_retake=TRUE)
CREATE OR REPLACE FUNCTION public.count_submissions_for_user(
  p_assessment_id uuid,
  p_user_id uuid
)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.submissions
  WHERE assessment_id = p_assessment_id
    AND user_id = p_user_id;
$$;

-- log_audit() — convenience function for Edge Functions.
-- Edge Functions call this to insert audit log entries (uses service role,
-- bypasses RLS — only callable server-side).
CREATE OR REPLACE FUNCTION public.log_audit(
  p_action text,
  p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_id uuid DEFAULT NULL,
  p_actor_email text DEFAULT NULL,
  p_actor_role text DEFAULT NULL,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.audit_logs (
    action, target_type, target_id, metadata,
    actor_id, actor_email, actor_role,
    ip_address, user_agent
  )
  VALUES (
    p_action, p_target_type, p_target_id, p_metadata,
    p_actor_id, p_actor_email, p_actor_role,
    p_ip_address, p_user_agent
  )
  RETURNING id;
$$;

COMMENT ON FUNCTION public.log_audit() IS
  'Convenience function for Edge Functions to insert audit log entries. SECURITY DEFINER — bypasses RLS. Only callable server-side (service role key).';
