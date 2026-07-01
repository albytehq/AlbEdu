-- =============================================================================
-- 20260701_014_migrate_legacy_ujian.sql
-- AlbEdu v1.0.0 — Phase 1.14
-- =============================================================================
-- Migrates data from legacy `ujian` table → new `assessments` table.
-- Idempotent: safe to run multiple times (uses ON CONFLICT DO NOTHING).
--
-- If legacy `ujian` table is empty (no production data), this is a no-op.
-- If legacy data exists, this copies:
--   - kode_id → access_code (pad to 6 digits if 5-digit legacy)
--   - ujian.judul → title
--   - ujian.mata_pelajaran → subject
--   - ujian.time → duration_minutes
--   - ujian.mode_pembuka → access_mode
--   - ujian.catatan → note_enabled + note_text
--   - ujian.max_halaman → max_pages_per_section
--   - ujian.global_skor → total_score
--   - ujian.theme → theme_config (mapped to new schema)
--   - ujian.identity_mode → identity_mode
--   - ujian.identity_config → identity_config
--   - sections → sections (same structure)
--   - access_control → normalized ac_* columns
--   - hasil_peserta JSONB → submissions (extracted via PL/pgSQL)
--   - violations JSONB → violation_events (extracted via PL/pgSQL)
--
-- IMPORTANT: Run this AFTER all other migrations (001-013) are applied.
-- Legacy `ujian` table is DROPPED in migration 015 (drop_legacy_tables.sql).
-- =============================================================================

-- Only proceed if legacy `ujian` table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ujian'
  ) THEN
    RAISE NOTICE 'Legacy ujian table found. Starting migration...';

    -- ── Step 1: Migrate ujian → assessments ──
    -- Pad 5-digit kode_id to 6-digit access_code (prefix with '0')
    INSERT INTO public.assessments (
      access_code, created_by, created_by_email, published_at,
      title, subject, duration_minutes, access_mode,
      note_enabled, note_text, max_pages_per_section, total_score,
      theme_config, identity_mode, identity_config, sections,
      allow_retake, status,
      ac_manual_status, ac_override, ac_end, ac_remaining_time,
      ac_scheduled_start, ac_scheduled_end,
      created_at, updated_at
    )
    SELECT
      lpad(u.kode_id, 6, '0'),  -- pad to 6 digits
      -- created_by: legacy is text UUID, cast to uuid; if NULL/invalid, skip
      CASE
        WHEN u.created_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN u.created_by::uuid
        ELSE NULL
      END,
      u.created_by_email,
      u.created_at,
      COALESCE(u.ujian->>'judul', u.judul, 'Untitled Assessment'),
      COALESCE(u.ujian->>'mata_pelajaran', u.mata_pelajaran, 'Unknown'),
      COALESCE((u.ujian->>'time')::int, 60),
      CASE WHEN u.ujian->>'mode_pembuka' = 'Otomatis' THEN 'scheduled' ELSE 'manual' END,
      CASE WHEN u.ujian->>'catatan' = 'On' THEN true ELSE false END,
      u.ujian->>'is_catatan',
      COALESCE((u.ujian->>'max_halaman')::int, 3),
      COALESCE((u.ujian->>'global_skor')::int, 100),
      -- Map legacy theme {tema, CU, HJ, TW} → new theme_config {preset, primary, font, mode}
      CASE
        WHEN u.ujian->'theme' IS NOT NULL THEN
          jsonb_build_object(
            'version', '1.0',
            'preset', 'default',
            'primary', COALESCE(u.ujian->'theme'->>'CU', '#2563eb'),
            'heading', u.ujian->'theme'->>'HJ',
            'body', u.ujian->'theme'->>'TW',
            'font', 'Plus Jakarta Sans',
            'mode', 'auto'
          )
        ELSE '{}'::jsonb
      END,
      COALESCE(u.ujian->>'identity_mode', u.identity_mode, 'manual'),
      COALESCE(u.ujian->'identity_config', u.identity_config, '{}'::jsonb),
      COALESCE(u.sections, '[]'::jsonb),
      false,  -- allow_retake (new feature, default false for legacy)
      CASE u.status
        WHEN 'expired' THEN 'archived'
        WHEN 'draft' THEN 'draft'
        ELSE 'active'
      END,
      COALESCE(u.access_control->>'manual_status', 'closed'),
      COALESCE((u.access_control->>'override')::boolean, false),
      -- ac_end: legacy stores as ISO string or Firestore Timestamp {seconds, nanoseconds}
      CASE
        WHEN u.access_control->>'end' IS NOT NULL THEN
          (u.access_control->>'end')::timestamptz
        WHEN u.access_control->'end' ? 'seconds' THEN
          to_timestamp((u.access_control->'end'->>'seconds')::numeric)
        ELSE NULL
      END,
      -- ac_remaining_time: legacy stores as string seconds
      CASE
        WHEN u.access_control->>'remaining_time' IS NOT NULL THEN
          (u.access_control->>'remaining_time')::int
        ELSE NULL
      END,
      CASE
        WHEN u.access_control->'scheduled'->>'start' IS NOT NULL THEN
          (u.access_control->'scheduled'->>'start')::timestamptz
        WHEN u.access_control->'scheduled'->'start' ? 'seconds' THEN
          to_timestamp((u.access_control->'scheduled'->'start'->>'seconds')::numeric)
        ELSE NULL
      END,
      CASE
        WHEN u.access_control->'scheduled'->>'end' IS NOT NULL THEN
          (u.access_control->'scheduled'->>'end')::timestamptz
        WHEN u.access_control->'scheduled'->'end' ? 'seconds' THEN
          to_timestamp((u.access_control->'scheduled'->'end'->>'seconds')::numeric)
        ELSE NULL
      END,
      u.created_at,
      COALESCE(u.updated_at, u.created_at)
    FROM public.ujian u
    WHERE u.kode_id IS NOT NULL
      AND u.created_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ON CONFLICT (access_code) DO NOTHING;

    RAISE NOTICE 'Step 1 complete: ujian → assessments migrated.';

    -- ── Step 2: Migrate hasil_peserta JSONB → submissions ──
    -- Legacy stores results as: { "Nama Peserta": { skor, selesai_at } }
    -- We cannot fully reconstruct submissions (no answer data), so we create
    -- stub submissions with just the score + identity snapshot.
    -- This is best-effort — full migration not possible without source answers.
    INSERT INTO public.submissions (
      assessment_id, session_id, user_id, identity_snapshot, user_email,
      answers, score, max_score, correct_count, total_count,
      grading_detail, started_at, submitted_at, duration_seconds,
      attempt_number
    )
    SELECT
      a.id,
      -- session_id: create a stub session for legacy submissions
      gen_random_uuid(),
      -- user_id: we don't know the UUID, use a deterministic NULL UUID placeholder
      -- (these are legacy stubs, real data starts fresh in v1.0.0)
      '00000000-0000-0000-0000-000000000000'::uuid,
      jsonb_build_object('nama', hp.key, 'source', 'legacy_migration'),
      NULL,
      '{}'::jsonb,  -- no answer data available
      (hp.value->>'skor')::numeric,
      100,
      NULL,
      NULL,
      NULL,
      COALESCE((hp.value->>'selesai_at')::timestamptz, u.created_at),
      COALESCE((hp.value->>'selesai_at')::timestamptz, u.created_at),
      NULL,
      1
    FROM public.ujian u
    JOIN public.assessments a ON a.access_code = lpad(u.kode_id, 6, '0')
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(u.hasil_peserta, '{}'::jsonb)) AS hp(key, value)
    WHERE u.hasil_peserta IS NOT NULL
      AND u.hasil_peserta::text != '{}'
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Step 2 complete: hasil_peserta → submissions migrated (stub records).';

    -- ── Step 3: Migrate violations JSONB → violation_events ──
    -- Legacy stores: { "Nama": { severity, count, blocked, blockedAt, blockedBy } }
    -- We create summary violation_events (one per blocked user).
    INSERT INTO public.violation_events (
      assessment_id, session_id, user_id, user_email, user_name, exam_title,
      event_type, message, severity, ip_address, user_agent, device_id,
      created_at, expires_at
    )
    SELECT
      a.id,
      gen_random_uuid(),
      '00000000-0000-0000-0000-000000000000'::uuid,
      NULL,
      v.key,
      a.title,
      'session_blocked',
      CASE WHEN v.value->>'blocked' = 'true' THEN 'Blocked by admin (legacy migration)' ELSE 'Legacy violation record' END,
      'critical',
      NULL, NULL, NULL,
      COALESCE((v.value->>'blockedAt')::timestamptz, u.created_at),
      COALESCE((v.value->>'blockedAt')::timestamptz, u.created_at) + INTERVAL '90 days'
    FROM public.ujian u
    JOIN public.assessments a ON a.access_code = lpad(u.kode_id, 6, '0')
    CROSS JOIN LATERAL jsonb_each(COALESCE(u.violations, '{}'::jsonb)) AS v(key, value)
    WHERE u.violations IS NOT NULL
      AND u.violations::text != '{}'
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Step 3 complete: violations → violation_events migrated.';

    RAISE NOTICE 'Migration complete. Legacy ujian table will be dropped in migration 015.';
  ELSE
    RAISE NOTICE 'Legacy ujian table not found. Skipping migration (fresh install).';
  END IF;
END $$;
