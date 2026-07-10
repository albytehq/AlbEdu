-- ============================================================================
-- Migration 027: Extend assets_manifest with compression stats columns
-- ============================================================================
--
-- BACKGROUND:
--   Phase 2 needs to track compression effectiveness for monitoring.
--   Magic Compress™ v2 produces: originalSize, compressedSize, qualityUsed,
--   complexity score, SSIM. We store key metrics in assets_manifest for:
--     • Dashboard display (Phase 6)
--     • Compression effectiveness analytics
--     • Debugging (which images are too big / too small)
--
--   Migration 022 already added storage_backend, gc_fail_count, migrated_at.
--   This migration adds the compression-specific columns.
--
-- PART OF: docs/ROADMAP.md Phase 2
-- ============================================================================

-- original_size: size of the file BEFORE Magic Compress™ (bytes)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS original_size BIGINT;

-- compressed_size: size of the file AFTER Magic Compress™ (bytes)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS compressed_size BIGINT;

-- compression_ratio: 0-1 (compressedSize / originalSize)
--   e.g. 0.05 = 5% of original (95% reduction)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS compression_ratio REAL;

-- quality_used: JPEG quality used by Magic Compress™ (0-1)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS quality_used REAL;

-- uploaded_by: user ID of the admin who uploaded (for audit + dashboard)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS uploaded_by UUID;

-- ── Verification ───────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Migration 027 complete:';
  RAISE NOTICE '  assets_manifest extended with:';
  RAISE NOTICE '    original_size (BIGINT)';
  RAISE NOTICE '    compressed_size (BIGINT)';
  RAISE NOTICE '    compression_ratio (REAL)';
  RAISE NOTICE '    quality_used (REAL)';
  RAISE NOTICE '    uploaded_by (UUID)';
END $$;
