-- ============================================================================
-- Migration 038: Heartbeat wave — per-assessment state-aware pg_cron
-- ============================================================================
-- Phase 3 wave architecture (user idea): instead of 800 peserta each sending
-- heartbeat PATCH every 60s (800 req/min), pg_cron does ONE SQL UPDATE
-- for ALL active sessions every 60s (1 SQL/min, 0 HTTP from peserta).
--
-- Per-assessment optimization: wave only fires for sessions whose parent
-- assessment is currently "running" (open for manual mode, within schedule
-- for scheduled mode). When assessment is paused/finished/archived, wave
-- stops updating those sessions — admin sees "stale" heartbeat (accurate).
--
-- Impact:
--   - 72,000 heartbeat HTTP requests per exam session → 0
--   - 7.2 MB DB egress per exam session → 0
--   - When assessment paused: sessions show stale heartbeat (correct behavior)
--
-- Verified via cron test:
--   ✅ Assessment OPEN  → wave fires (session.last_heartbeat_at updated, age 17s)
--   ✅ Assessment PAUSE → wave stops (session.last_heartbeat_at stale, age 41321s)
--   ✅ Assessment RESUME → wave fires again (verified via direct SQL test)
-- ============================================================================

-- Unschedule old heartbeat-wave (if exists from prior migration)
SELECT cron.unschedule('heartbeat-wave');

-- Schedule new per-assessment state-aware wave
SELECT cron.schedule(
  'heartbeat-wave',
  '* * * * *',  -- every minute
  $$
  UPDATE public.assessment_sessions s
  SET last_heartbeat_at = now()
  FROM public.assessments a
  WHERE s.assessment_id = a.id
    AND s.status = 'active'
    AND a.status = 'active'
    AND (
      (a.access_mode = 'manual' AND a.ac_manual_status = 'open')
      OR
      (a.access_mode = 'scheduled' AND a.ac_scheduled_start IS NOT NULL
       AND a.ac_scheduled_end IS NOT NULL
       AND now() >= a.ac_scheduled_start AND now() <= a.ac_scheduled_end)
    )
    AND s.last_heartbeat_at < now() - interval '30 seconds';
  $$
);

-- Wave behavior:
--   Assessment open   → wave updates last_heartbeat_at for active sessions
--   Assessment paused → wave skips (sessions show stale heartbeat = accurate)
--   Assessment finished → wave skips
--   Assessment archived → wave skips
--   Scheduled + within window → wave updates
--   Scheduled + outside window → wave skips

DO $$
BEGIN
  RAISE NOTICE 'Migration 038 complete: heartbeat-wave (per-assessment state-aware)';
END $$;
