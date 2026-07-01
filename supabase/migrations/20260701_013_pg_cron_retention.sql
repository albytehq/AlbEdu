-- =============================================================================
-- 20260701_013_pg_cron_retention.sql
-- AlbEdu v1.0.0 — Phase 1.13 — Data Retention (Q10 + Q17)
-- =============================================================================
-- Schedules pg_cron jobs for automatic data cleanup per retention policy:
--   - registration_attempts: purge after 30 days
--   - violation_events: purge after 90 days (Q10)
--   - audit_logs: archive after 1 year (Q10)
--   - assessment_sessions: mark stale (heartbeat >5 min) as 'disconnected'
--   - consents: keep history (no purge — immutable audit trail)
--
-- Requires: pg_cron extension (Supabase built-in, enable via dashboard if needed)
-- =============================================================================

-- ── Enable pg_cron if not already enabled ──
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ── Job 1: Purge registration_attempts older than 30 days ──
-- Runs daily at 03:00 UTC
SELECT cron.schedule(
  'purge-registration-attempts',
  '0 3 * * *',
  $$
    DELETE FROM public.registration_attempts
    WHERE created_at < now() - INTERVAL '30 days';
  $$
);

-- ── Job 2: Purge violation_events older than 90 days (Q10) ──
-- Runs daily at 03:15 UTC
SELECT cron.schedule(
  'purge-violation-events',
  '15 3 * * *',
  $$
    DELETE FROM public.violation_events
    WHERE expires_at < now() OR created_at < now() - INTERVAL '90 days';
  $$
);

-- ── Job 3: Archive audit_logs older than 1 year (Q10) ──
-- Runs daily at 03:30 UTC
-- Note: For v1.0.0 we just DELETE (no archive table). Phase 9 can add
-- audit_logs_archive table for long-term storage if needed.
SELECT cron.schedule(
  'purge-audit-logs',
  '30 3 * * *',
  $$
    DELETE FROM public.audit_logs
    WHERE expires_at < now() OR created_at < now() - INTERVAL '365 days';
  $$
);

-- ── Job 4: Mark stale assessment_sessions as 'disconnected' ──
-- Sessions with last_heartbeat_at > 5 minutes ago are considered disconnected.
-- Runs every 1 minute.
SELECT cron.schedule(
  'mark-stale-sessions-disconnected',
  '* * * * *',
  $$
    UPDATE public.assessment_sessions
    SET status = 'disconnected'
    WHERE status = 'active'
      AND last_heartbeat_at < now() - INTERVAL '5 minutes';
  $$
);

-- ── Job 5: Mark expired assessment_sessions (ac_end passed) ──
-- Sessions where assessment's ac_end has passed and status is still 'active'.
-- Runs every 1 minute.
SELECT cron.schedule(
  'mark-expired-sessions',
  '* * * * *',
  $$
    UPDATE public.assessment_sessions s
    SET status = 'expired'
    WHERE s.status = 'active'
      AND EXISTS (
        SELECT 1 FROM public.assessments a
        WHERE a.id = s.assessment_id
          AND a.ac_end IS NOT NULL
          AND a.ac_end < now()
      );
  $$
);

-- ── Job 6: Anonymize IP addresses older than 90 days (Q17 UU PDP) ──
-- Per UU PDP best practice: don't store raw IP indefinitely.
-- Replace with SHA-256 hash (one-way, cannot reverse to original IP).
-- Runs daily at 04:00 UTC.
SELECT cron.schedule(
  'anonymize-old-ips',
  '0 4 * * *',
  $$
    -- Anonymize IPs in audit_logs older than 90 days
    UPDATE public.audit_logs
    SET ip_address = 'sha256:' || encode(digest(ip_address, 'sha256'), 'hex')
    WHERE ip_address IS NOT NULL
      AND ip_address NOT LIKE 'sha256:%'
      AND created_at < now() - INTERVAL '90 days';
    -- Anonymize IPs in violation_events older than 90 days
    UPDATE public.violation_events
    SET ip_address = 'sha256:' || encode(digest(ip_address, 'sha256'), 'hex')
    WHERE ip_address IS NOT NULL
      AND ip_address NOT LIKE 'sha256:%'
      AND created_at < now() - INTERVAL '90 days';
  $$
);

-- ── Job 7: Auto-archive assessments older than 1 year (Q10) ──
-- Mark assessments with status='active' but created_at > 1 year ago as 'archived'.
-- Runs daily at 04:15 UTC.
SELECT cron.schedule(
  'archive-old-assessments',
  '15 4 * * *',
  $$
    UPDATE public.assessments
    SET status = 'archived'
    WHERE status = 'active'
      AND created_at < now() - INTERVAL '365 days';
  $$
);

COMMENT ON SCHEMA public IS 'AlbEdu v1.0.0 — pg_cron retention jobs scheduled. See docs/COMPLIANCE.md for retention policy details.';
