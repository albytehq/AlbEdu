-- ============================================================================
-- Migration 023: Create Supabase Storage bucket 'avatars' with RLS policies
-- ============================================================================
--
-- BACKGROUND:
--   Phase 1 of the asset system migration. Avatar uploads were previously
--   handled by the Cloudflare Worker `/upload` endpoint, which is broken in
--   production (requires AUTH_TOKEN that no client sends — see ASSETS-A audit).
--
--   This migration creates the `avatars` bucket in Supabase Storage and
--   configures RLS policies so:
--     • Authenticated users can UPLOAD to their own folder only
--     • Authenticated users can UPDATE their own avatar only
--     • Anyone (including anon) can READ avatars (they're public — visible
--       in daftar-nama, OptionProfile dropdown, peserta FAB)
--     • Authenticated users can DELETE their own avatar (for DSR compliance)
--
-- BUCKET CONFIG:
--   • Name: avatars
--   • Public: TRUE (avatars visible to other participants in daftar-nama)
--   • Max file size: 2 MB (enforced via storage.objects size check + client)
--   • Allowed MIME: image/jpeg, image/png, image/webp (client validates;
--     Supabase Storage does not enforce MIME by default — relying on client
--     + Edge Function validation. Future: add trigger to enforce MIME.)
--
-- PATH CONVENTION:
--   {user_id}/avatar-{timestamp}.jpg
--   • user_id = auth.uid() — enables RLS per-user folder
--   • timestamp = Date.now() — prevents stale CDN cache after avatar update
--
-- PART OF: docs/asset-system/ROADMAP.md Phase 1
-- RELATED: docs/asset-system/ARCHITECTURE-V2.md §3.1
-- ============================================================================

-- ── 1. Insert bucket (idempotent) ──────────────────────────────────────────
-- public = TRUE so avatars are readable without authentication (anon key OK).
-- avatars are NOT sensitive — they're display pictures visible in shared UI.
-- File size limit: 2 MB (2_097_152 bytes) — enforced at Storage layer.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  TRUE,
  2097152,  -- 2 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = TRUE,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[],
  updated_at = now();

-- ── 2. RLS Policies (idempotent) ───────────────────────────────────────────
--
-- Storage RLS uses the special `storage.objects` table. The `name` column
-- holds the path (e.g. "user-uuid/avatar-1234567890.jpg"). We use
-- `storage.foldername(name)[1]` to extract the first path segment (the
-- user_id) for per-user isolation.
--
-- Policy matrix:
--   INSERT  → authenticated, folder = own user_id
--   UPDATE  → authenticated, folder = own user_id
--   SELECT  → public (anyone, including anon) — avatars are display pictures
--   DELETE  → authenticated, folder = own user_id (DSR compliance)

-- 2a. INSERT — upload to own folder
DROP POLICY IF EXISTS "avatars_upload_own" ON storage.objects;
CREATE POLICY "avatars_upload_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 2b. UPDATE — replace own avatar
DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 2c. SELECT — public read (avatars visible to other participants)
-- Note: bucket is already `public = TRUE`, but explicit policy is good practice.
DROP POLICY IF EXISTS "avatars_read_public" ON storage.objects;
CREATE POLICY "avatars_read_public" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- 2d. DELETE — user can delete own avatar (DSR compliance)
DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 3. Verification NOTICE ─────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Migration 023 complete:';
  RAISE NOTICE '  Bucket "avatars" created (public=TRUE, 2MB limit, jpeg/png/webp)';
  RAISE NOTICE '  RLS policies:';
  RAISE NOTICE '    avatars_upload_own   — authenticated, folder = own user_id';
  RAISE NOTICE '    avatars_update_own   — authenticated, folder = own user_id';
  RAISE NOTICE '    avatars_read_public  — public (anyone can read)';
  RAISE NOTICE '    avatars_delete_own   — authenticated, folder = own user_id';
  RAISE NOTICE '  ';
  RAISE NOTICE 'Next: Refactor src/profile/editor-panel.js to use supabase.storage.from(''avatars'')';
END $$;
