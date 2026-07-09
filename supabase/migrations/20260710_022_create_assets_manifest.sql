-- ============================================================================
-- Migration 022: Create assets_manifest table (Phase 0 stabilization)
-- ============================================================================
--
-- BACKGROUND:
--   The `assets_manifest` table was created manually via Supabase Studio SQL
--   editor during early development. No migration existed for it. This meant:
--   - `supabase db reset` did NOT produce this table (broken local dev)
--   - Schema was undocumented, drift-prone, untestable
--   - No RLS policies (anon key could potentially SELECT *)
--   - No indexes (GC query did full table scan)
--   - No CHECK constraints (ref_count could go negative)
--
--   This migration formalizes the schema. It is IDEMPOTENT — safe to run on
--   existing production databases that already have the table (created manually).
--   All statements use IF NOT EXISTS.
--
-- POST-MIGRATION:
--   - Table is under migration control (reproducible via supabase db reset)
--   - RLS enabled, service_role-only policy
--   - idx_gc_eligible partial index for GC query performance
--   - CHECK (ref_count >= 0) prevents negative ref_count bugs
--   - gc_fail_count column added (for Phase 3 GC migration)
--   - storage_backend column added (for Phase 2 B2 migration, supports
--     coexistence of 'github' legacy assets and 'b2' new assets)
--   - migrated_at column added (for Phase 5 GitHub→B2 migration script)
--
-- PART OF: docs/asset-system/ROADMAP.md Phase 0
-- RELATED: docs/asset-system/ARCHITECTURE-V2.md
-- ============================================================================

-- ── 1. Create table (idempotent — existing manual table is preserved) ───────

CREATE TABLE IF NOT EXISTS public.assets_manifest (
  hash              TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  path              TEXT NOT NULL,
  cdn_url           TEXT NOT NULL,
  ref_count         INTEGER NOT NULL DEFAULT 1,
  pending_delete    BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Add new columns (idempotent — IF NOT EXISTS) ─────────────────────────

-- storage_backend: tracks which storage provider holds the bytes.
-- 'github' = legacy (assets-1 to assets-20 repos)
-- 'b2'     = Backblaze B2 (new, post Phase 2)
-- 'supabase' = Supabase Storage (avatars only — future)
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS storage_backend TEXT
  NOT NULL DEFAULT 'github'
  CHECK (storage_backend IN ('github', 'b2', 'supabase'));

-- gc_fail_count: incremented by GC when delete fails; reset on success.
-- Used for alerting when gc_fail_count >= 3 (asset permanently broken).
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS gc_fail_count INTEGER NOT NULL DEFAULT 0;

-- migrated_at: timestamp when asset was migrated from github to b2 (Phase 5).
-- NULL = not yet migrated (still on github).
ALTER TABLE public.assets_manifest
  ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ;

-- ── 3. Add CHECK constraint on ref_count (idempotent) ───────────────────────
-- Prevents ref_count from going negative (root cause of GC deleting in-use
-- assets, per ASSETS-A audit finding).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_manifest_ref_count_check'
  ) THEN
    ALTER TABLE public.assets_manifest
      ADD CONSTRAINT assets_manifest_ref_count_check CHECK (ref_count >= 0);
  END IF;
END $$;

-- ── 4. Create indexes (idempotent) ──────────────────────────────────────────

-- idx_gc_eligible: partial index for GC query.
-- GC queries: WHERE pending_delete = true AND last_seen < cutoff
-- Without this index, GC does a full table scan (per ASSETS-C audit).
CREATE INDEX IF NOT EXISTS idx_gc_eligible
  ON public.assets_manifest (last_seen)
  WHERE pending_delete = true;

-- idx_storage_backend: partial index for migration script.
-- Migration queries: WHERE storage_backend != 'b2' (find legacy assets)
-- Drops to 0 rows after Phase 5 completes (index becomes no-op, harmless).
CREATE INDEX IF NOT EXISTS idx_storage_backend
  ON public.assets_manifest (storage_backend)
  WHERE storage_backend != 'b2';

-- idx_ref_count_zero: partial index for GC's ref_count = 0 check.
-- Combined with idx_gc_eligible via bitmap scan for fast GC queries.
CREATE INDEX IF NOT EXISTS idx_ref_count_zero
  ON public.assets_manifest (hash)
  WHERE ref_count = 0 AND pending_delete = true;

-- ── 5. Enable RLS (idempotent) ──────────────────────────────────────────────
-- Per ASSETS-C audit: RLS state was UNKNOWN — possible anon-key data leak.
-- This migration enables RLS and creates a service_role-only policy.
-- Both Worker (using service_role key) and Edge Functions (service_role) bypass
-- RLS, so functional behavior is unchanged. Anon key (used by client SDK) is
-- now blocked from touching this table directly.

ALTER TABLE public.assets_manifest ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if present (idempotent — allows re-running migration)
DROP POLICY IF EXISTS "assets_manifest_service_role_only" ON public.assets_manifest;

-- Service role can do everything; all others (anon, authenticated) get nothing.
CREATE POLICY "assets_manifest_service_role_only" ON public.assets_manifest
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── 6. Update existing rows: set storage_backend = 'github' for legacy assets
-- This is a one-time backfill. New uploads post-Phase 2 will set 'b2' explicitly.
-- Only runs if there are rows with NULL or missing storage_backend.

UPDATE public.assets_manifest
SET storage_backend = 'github'
WHERE storage_backend IS NULL
   OR storage_backend NOT IN ('github', 'b2', 'supabase');

-- ── 7. Verification NOTICE (visible in psql / Supabase SQL editor) ─────────

DO $$
DECLARE
  total_rows INTEGER;
  github_rows INTEGER;
  b2_rows INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_rows FROM public.assets_manifest;
  SELECT COUNT(*) INTO github_rows FROM public.assets_manifest WHERE storage_backend = 'github';
  SELECT COUNT(*) INTO b2_rows FROM public.assets_manifest WHERE storage_backend = 'b2';

  RAISE NOTICE 'Migration 022 complete:';
  RAISE NOTICE '  Total assets_manifest rows: %', total_rows;
  RAISE NOTICE '  Legacy (github) assets: %', github_rows;
  RAISE NOTICE '  New (b2) assets: %', b2_rows;
  RAISE NOTICE '  RLS enabled: %', (
    SELECT relrowsecurity FROM pg_class WHERE relname = 'assets_manifest'
  );
  RAISE NOTICE '  Indexes: idx_gc_eligible, idx_storage_backend, idx_ref_count_zero';
  RAISE NOTICE '  ';
  RAISE NOTICE 'Next steps (see docs/asset-system/ROADMAP.md):';
  RAISE NOTICE '  Phase 1: Migrate avatars to Supabase Storage';
  RAISE NOTICE '  Phase 2: Migrate soal images to Backblaze B2';
  RAISE NOTICE '  Phase 5: Decommission GitHub repos (after migration)';
END $$;
