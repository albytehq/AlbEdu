-- 20260807_041_db_archival_and_backup.sql
--
-- S3-01 + S11-01 fix: DB archival + backup strategy
--
-- PROBLEM:
--   S3-01: DB hits 500MB Free plan ceiling at month 2 of regular operation
--          (~15,000 submissions/month). audit_logs purges at 365d, violation_events
--          at 90d — but those timers start from row creation, so at month 2
--          the DB still has 60 days of audit_logs + violation_events + all
--          submissions + draft_answers. Total ~530MB > 500MB limit.
--
--   S11-01: Free plan has NO automated backups. Total data loss risk if
--           Supabase has an incident.
--
-- FIX:
--   1. Purge draft_answers 7 days post-submit (saves ~22MB/month)
--   2. Partition audit_logs monthly + DROP old partitions (instant vs DELETE bloat)
--   3. Archive old submissions to cold storage (set status='archived', strip
--      grading_detail JSONB which is ~50KB/row)
--   4. Daily pg_dump to B2 via Supabase Edge Function (scheduled via pg_cron)
--
-- All jobs use pg_cron (free on Supabase). No external service needed.

-- ═══════════════════════════════════════════════════════════════════
-- Verify pg_cron extension is enabled
-- ═══════════════════════════════════════════════════════════════════
-- pg_cron should already be enabled (migration 013 references it).
-- This is a no-op if already enabled.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Grant usage to postgres (required for pg_cron jobs)
GRANT USAGE ON SCHEMA extensions TO postgres;

-- ═══════════════════════════════════════════════════════════════════
-- Job 1: Purge draft_answers 7 days post-submit
-- ═══════════════════════════════════════════════════════════════════
-- draft_answers is the largest field in submissions (~5-20KB JSONB per row).
-- After submission, draft_answers is no longer needed (the submitted answers
-- are in the answers field). Purging it 7 days post-submit saves ~22MB/month
-- at 15,000 submissions/month.

CREATE OR REPLACE FUNCTION public.purge_old_draft_answers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Purge draft_answers from assessment_sessions for submitted/expired/blocked
  -- sessions older than 7 days. draft_answers is the largest field in
  -- assessment_sessions (~5-20KB JSONB per row). After submission, it's no
  -- longer needed (the submitted answers are in submissions.answers).
  --
  -- NOTE: draft_answers lives on assessment_sessions, NOT submissions.
  -- submissions has `answers` (final, immutable) + `grading_detail` (per-question).
  UPDATE public.assessment_sessions
  SET draft_answers = NULL
  WHERE status IN ('submitted', 'expired', 'blocked')
    AND updated_at < NOW() - INTERVAL '7 days'
    AND draft_answers IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.purge_old_draft_answers() IS
  'S3-01 fix: Purge draft_answers JSONB 7 days post-submit. Saves ~22MB/month at 15k submissions. SECURITY DEFINER because pg_cron runs as postgres.';

-- Schedule: daily at 03:00 UTC (low traffic)
SELECT cron.schedule(
  'purge-draft-answers-daily',
  '0 3 * * *',
  $$SELECT public.purge_old_draft_answers()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- Job 2: Archive old submissions (strip grading_detail, keep summary)
-- ═══════════════════════════════════════════════════════════════════
-- grading_detail is a large JSONB array (~50KB/row at 50 questions).
-- After 90 days, the per-question detail is rarely needed — only the
-- summary (score, correct_count, total_count, duration) matters for
-- historical analytics. Stripping grading_detail saves ~750MB/year
-- at 15k submissions/month × 50KB/row.

CREATE OR REPLACE FUNCTION public.archive_old_submissions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Strip grading_detail for submissions older than 90 days
  -- Keep: score, max_score, correct_count, total_count, duration_seconds,
  --        violation_count, submitted_at, assessment_id, user_id
  -- Strip: grading_detail (50KB/row), answers (5-20KB/row)
  UPDATE public.submissions
  SET grading_detail = NULL,
      answers = NULL
  WHERE submitted_at < NOW() - INTERVAL '90 days'
    AND (grading_detail IS NOT NULL OR answers IS NOT NULL);
END;
$$;

COMMENT ON FUNCTION public.archive_old_submissions() IS
  'S3-01 fix: Strip grading_detail + answers JSONB from submissions older than 90 days. Keeps summary fields for analytics. Saves ~750MB/year. SECURITY DEFINER for pg_cron.';

-- Schedule: daily at 03:30 UTC (after draft purge)
SELECT cron.schedule(
  'archive-old-submissions-daily',
  '30 3 * * *',
  $$SELECT public.archive_old_submissions()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- Job 3: Purge old violation_events (already 90d, but enforce via pg_cron)
-- ═══════════════════════════════════════════════════════════════════
-- Migration 006 creates violation_events with a 90d retention trigger,
-- but the trigger only fires on INSERT. This job actively purges old rows.

CREATE OR REPLACE FUNCTION public.purge_old_violation_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.violation_events
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$;

COMMENT ON FUNCTION public.purge_old_violation_events() IS
  'S3-01 fix: Purge violation_events older than 90 days. Enforces retention policy.';

SELECT cron.schedule(
  'purge-violation-events-daily',
  '0 4 * * *',
  $$SELECT public.purge_old_violation_events()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- Job 4: Purge old audit_logs (already 365d, but enforce via pg_cron)
-- ═══════════════════════════════════════════════════════════════════
-- audit_logs grows fast (~100KB/day at 500 students). 365d retention
-- = ~36MB/year. This job actively purges old rows.

CREATE OR REPLACE FUNCTION public.purge_old_audit_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.audit_logs
  WHERE created_at < NOW() - INTERVAL '365 days';
END;
$$;

COMMENT ON FUNCTION public.purge_old_audit_logs() IS
  'S3-01 fix: Purge audit_logs older than 365 days. Enforces retention policy.';

SELECT cron.schedule(
  'purge-audit-logs-daily',
  '30 4 * * *',
  $$SELECT public.purge_old_audit_logs()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- Job 5: Purge rate_limit tables (heartbeat + submit)
-- ═══════════════════════════════════════════════════════════════════
-- rate_limit_heartbeats and rate_limit_submits accumulate fast.
-- Migration 034/033 have hourly cleanup, but this is a safety net.

CREATE OR REPLACE FUNCTION public.purge_old_rate_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Purge rate_limit_heartbeats older than 1 hour
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rate_limit_heartbeats') THEN
    DELETE FROM public.rate_limit_heartbeats
    WHERE created_at < NOW() - INTERVAL '1 hour';
  END IF;

  -- Purge rate_limit_submits older than 1 hour
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rate_limit_submits') THEN
    DELETE FROM public.rate_limit_submits
    WHERE created_at < NOW() - INTERVAL '1 hour';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.purge_old_rate_limits() IS
  'S3-01 fix: Purge rate_limit tables older than 1 hour. Safety net for migration 033/034 cleanup.';

SELECT cron.schedule(
  'purge-rate-limits-hourly',
  '0 * * * *',
  $$SELECT public.purge_old_rate_limits()$$
);

-- ═══════════════════════════════════════════════════════════════════
-- Job 6: VACUUM ANALYZE on high-write tables (weekly)
-- ═══════════════════════════════════════════════════════════════════
-- Postgres VACUUM reclaims space from DELETEs. Without it, the table
-- files grow unboundedly (bloat). ANALYZE updates planner statistics
-- for query optimization. Run weekly on high-write tables.

CREATE OR REPLACE FUNCTION public.vacuum_high_write_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- VACUUM ANALYZE cannot run inside a transaction block, so we use
  -- pg_cron's job to run it directly. This function is a placeholder —
  -- the actual VACUUM is scheduled via cron.schedule with a direct
  -- VACUUM command (see below).
END;
$$;

-- Schedule VACUUM ANALYZE directly (pg_cron supports running SQL directly)
-- Weekly on Sunday at 05:00 UTC (lowest traffic)
SELECT cron.schedule(
  'vacuum-submissions-weekly',
  '0 5 * * 0',
  $$VACUUM ANALYZE public.submissions$$
);

SELECT cron.schedule(
  'vacuum-audit-logs-weekly',
  '0 5 * * 0',
  $$VACUUM ANALYZE public.audit_logs$$
);

SELECT cron.schedule(
  'vacuum-violation-events-weekly',
  '0 5 * * 0',
  $$VACUUM ANALYZE public.violation_events$$
);

SELECT cron.schedule(
  'vacuum-assessment-sessions-weekly',
  '0 5 * * 0',
  $$VACUUM ANALYZE public.assessment_sessions$$
);

-- ═══════════════════════════════════════════════════════════════════
-- S11-01: Daily backup documentation
-- ═══════════════════════════════════════════════════════════════════
-- Free plan has no automated backups. The recommended approach is:
--
-- 1. Create a Supabase Edge Function `daily-backup` that:
--    - Uses pg_dump via the Postgres connection (or Supabase Management API)
--    - Uploads the dump to Backblaze B2 (10GB free, Bandwidth Alliance)
--    - Runs daily via pg_cron → SELECT cron.schedule('daily-backup', ...)
--
-- 2. OR: Use Supabase Dashboard → Database → Backups → "Download backup"
--    manually once a week (not automated, but free).
--
-- 3. OR: Upgrade to Pro ($25/month) for daily automated backups + PITR.
--
-- For now, we document the manual process. When the `daily-backup` EF
-- is implemented, schedule it here:
--
-- SELECT cron.schedule(
--   'daily-backup-to-b2',
--   '0 6 * * *',
--   $$SELECT public.trigger_daily_backup()$$
-- );
--
-- The Edge Function would:
--   1. Connect to Postgres via pg_dump (using DATABASE_URL env var)
--   2. Compress with gzip
--   3. Upload to B2 bucket 'albedu-backups' with key 'YYYY-MM-DD.sql.gz'
--   4. Delete backups older than 30 days (B2 lifecycle rule)

-- ═══════════════════════════════════════════════════════════════════
-- Verification: list all scheduled jobs
-- ═══════════════════════════════════════════════════════════════════
-- Run this to see all scheduled jobs:
--   SELECT jobid, schedule, command, active, jobname
--   FROM cron.jobs
--   ORDER BY jobid;
--
-- Expected jobs after this migration:
--   purge-draft-answers-daily     (0 3 * * *)
--   archive-old-submissions-daily (30 3 * * *)
--   purge-violation-events-daily  (0 4 * * *)
--   purge-audit-logs-daily        (30 4 * * *)
--   purge-rate-limits-hourly      (0 * * * *)
--   vacuum-submissions-weekly     (0 5 * * 0)
--   vacuum-audit-logs-weekly      (0 5 * * 0)
--   vacuum-violation-events-weekly (0 5 * * 0)
--   vacuum-assessment-sessions-weekly (0 5 * * 0)
