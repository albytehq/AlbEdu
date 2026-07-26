-- ============================================================================
-- Migration 038: Heartbeat wave — server-side pg_cron bulk heartbeat update
-- ============================================================================
-- Phase 3 innovation (user idea): instead of 800 peserta each sending
-- heartbeat PATCH every 60s (800 req/min), pg_cron does ONE SQL UPDATE
-- for ALL active sessions every 60s (1 SQL/min, 0 HTTP from peserta).
--
-- Impact:
--   - 72,000 heartbeat HTTP requests per exam session → 0
--   - 7.2 MB DB egress per exam session → 0
--   - 800 concurrent DB connections peak → ~13/sec (answer-change events only)
--
-- Peserta client NO LONGER sends heartbeat timer. Instead:
--   - Answer changes → debounced PATCH (2s debounce) for draft_answers
--   - Section changes → immediate PATCH for current_section, current_question
--   - Violation events → immediate PATCH for violation_count
--   - Block-check poll → unchanged (10s SELECT, no DB write)
--
-- Server-side pg_cron handles last_heartbeat_at bulk update.
-- Rate-limit trigger (migration 034) is bypassed for service_role writes.
-- ============================================================================

-- Schedule the heartbeat wave: every minute, update last_heartbeat_at for
-- all active sessions. Single SQL statement, indexes make it O(active count).
SELECT cron.schedule(
  'heartbeat-wave',
  '* * * * *',  -- every minute
  $$
  UPDATE public.assessment_sessions
  SET last_heartbeat_at = now()
  WHERE status = 'active'
    AND last_heartbeat_at < now() - interval '30 seconds';
  $$
);

-- Note: WHERE last_heartbeat_at < now() - 30s prevents redundant updates
-- if pg_cron fires twice in same minute (rare but possible).
-- Also: only updates 'active' status, not 'paused' or 'disconnected'
-- (those need explicit resume from peserta client or admin).

-- (COMMENT ON JOB is not valid Postgres syntax; documenting inline instead)
-- heartbeat-wave: Phase 3 wave architecture. Bulk-update last_heartbeat_at
-- for all active sessions every 60s. Replaces 800 peserta × 1 PATCH/min =
-- 800 req/min with 1 SQL/min. Peserta client no longer sends heartbeat timer
-- — only sends answer-change events (debounced).

DO $$
BEGIN
  RAISE NOTICE 'Migration 038 complete: heartbeat-wave pg_cron job scheduled (every 1 min)';
END $$;
