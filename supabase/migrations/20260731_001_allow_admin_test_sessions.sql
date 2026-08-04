-- Migration: Allow admins to test assessments as peserta
-- Issue: RLS policy on assessment_sessions requires peran_user() = 'peserta',
-- but admins testing the peserta flow get 403 Forbidden on INSERT.
-- Fix: Allow both 'peserta' and 'admin' roles to INSERT/SELECT/UPDATE sessions.

-- Drop existing peserta-only INSERT policy
DROP POLICY IF EXISTS "sessions_peserta_insert_own" ON public.assessment_sessions;

-- Recreate with admin also allowed (for testing)
CREATE POLICY "sessions_peserta_insert_own"
  ON public.assessment_sessions FOR INSERT TO authenticated
  WITH CHECK (
    (peran_user() = 'peserta' OR peran_user() = 'admin')
    AND user_id = auth.uid()
  );

-- Drop existing peserta-only SELECT policy
DROP POLICY IF EXISTS "sessions_peserta_select_own" ON public.assessment_sessions;

-- Recreate with admin also allowed
CREATE POLICY "sessions_peserta_select_own"
  ON public.assessment_sessions FOR SELECT TO authenticated
  USING (
    (peran_user() = 'peserta' OR peran_user() = 'admin')
    AND user_id = auth.uid()
  );

-- Drop existing peserta-only UPDATE policy
DROP POLICY IF EXISTS "sessions_peserta_update_own" ON public.assessment_sessions;

-- Recreate with admin also allowed
CREATE POLICY "sessions_peserta_update_own"
  ON public.assessment_sessions FOR UPDATE TO authenticated
  USING (
    (peran_user() = 'peserta' OR peran_user() = 'admin')
    AND user_id = auth.uid()
  )
  WITH CHECK (
    (peran_user() = 'peserta' OR peran_user() = 'admin')
    AND user_id = auth.uid()
  );
