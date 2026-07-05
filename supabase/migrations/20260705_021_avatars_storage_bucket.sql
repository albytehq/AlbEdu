-- =============================================================================
-- Migration 021: Create avatars storage bucket + RLS policies
-- =============================================================================
-- Bug fix: Avatar upload via Cloudflare Worker → GitHub repos failed with 404
-- (repos albytehq/assets-1 through assets-20 not created).
-- Fix: Use Supabase Storage bucket 'avatars' instead — native, no GitHub
-- dependency, has RLS support.
--
-- RLS policies:
--   - avatars_admin_upload_own: admin INSERT to own folder ({auth.uid()}/...)
--   - avatars_admin_update_own: admin UPDATE own avatar
--   - avatars_admin_delete_own: admin DELETE own avatar
--   - avatars_public_read: anyone SELECT (public bucket for avatar display)
-- =============================================================================

-- Create bucket (public — avatars need to be visible to all users)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- RLS: admin can upload to own folder
DROP POLICY IF EXISTS avatars_admin_upload_own ON storage.objects;
CREATE POLICY avatars_admin_upload_own
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: admin can update own avatar
DROP POLICY IF EXISTS avatars_admin_update_own ON storage.objects;
CREATE POLICY avatars_admin_update_own
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: anyone can read avatars (public bucket)
DROP POLICY IF EXISTS avatars_public_read ON storage.objects;
CREATE POLICY avatars_public_read
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- RLS: admin can delete own avatar
DROP POLICY IF EXISTS avatars_admin_delete_own ON storage.objects;
CREATE POLICY avatars_admin_delete_own
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
