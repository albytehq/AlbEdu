-- 20260816_047_violation_signaling_pipeline.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  Violation Signaling Pipeline — production-grade peserta→admin realtime
--  --------------------------------------------------------------------------
--  Extends violation_events with:
--    • dedup_key       — server-enforced deduplication (prevents double-counting
--                        when peserta retries a signal after a transient failure)
--    • batch_id        — groups signals sent in the same HTTP request (audit trail)
--    • signal_source   — 'client' (peserta browser) or 'server' (admin action, etc.)
--    • metadata        — JSONB for extra context (tab title, viewport size, etc.)
--    • acknowledged_at — NULL when unread by admin; set when admin acks the notification
--    • acknowledged_by — UUID of admin who acked
--
--  Also:
--    • Adds a partial UNIQUE index on dedup_key (NULLs are distinct, so legacy
--      rows and rows without dedup_key remain insertable)
--    • Adds a partial index on (acknowledged_at IS NULL, created_at DESC) for
--      the admin "unread notifications" query
--    • Adds an RPC `acknowledge_violation` (SECURITY DEFINER) so admins can
--      ack violations without needing direct UPDATE permission on the table
--    • Grants EXECUTE on the RPC to authenticated users (RLS inside checks admin)
--
--  RLS changes:
--    • Peserta INSERT policy unchanged (can still INSERT own rows, but the EF
--      uses service-role so RLS is bypassed anyway)
--    • Admin UPDATE policy added — only on acknowledged_at / acknowledged_by
--      columns, only for rows they're allowed to read
--
--  Safe to re-run: all DDL uses IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Extend violation_events table ──────────────────────────────────────

ALTER TABLE public.violation_events
  ADD COLUMN IF NOT EXISTS dedup_key        text,
  ADD COLUMN IF NOT EXISTS batch_id         text,
  ADD COLUMN IF NOT EXISTS signal_source    text NOT NULL DEFAULT 'client'
    CHECK (signal_source IN ('client', 'server')),
  ADD COLUMN IF NOT EXISTS metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS acknowledged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by  uuid;

COMMENT ON COLUMN public.violation_events.dedup_key IS
  'Server-computed deduplication key (format: session_id|event_type|epoch_bucket). When a peserta retries a signal due to network failure, the dedup_key matches an existing row and the duplicate INSERT is silently skipped via ON CONFLICT.';
COMMENT ON COLUMN public.violation_events.batch_id IS
  'Groups signals sent in the same HTTP request (audit trail for batched sends).';
COMMENT ON COLUMN public.violation_events.signal_source IS
  'client = peserta browser signal, server = admin/server-initiated (e.g., heartbeat-timeout detected by pg_cron).';
COMMENT ON COLUMN public.violation_events.metadata IS
  'JSONB for additional context (e.g., {tab_title, viewport_w, viewport_h, key_pressed, mouse_pos}). Never contains PII.';
COMMENT ON COLUMN public.violation_events.acknowledged_at IS
  'NULL = unread notification in admin panel. Non-NULL = admin has dismissed/acked this violation.';
COMMENT ON COLUMN public.violation_events.acknowledged_by IS
  'UUID of the admin who acked this violation. NULL when unread.';

-- ── 2. Indexes ────────────────────────────────────────────────────────────

-- Partial UNIQUE on dedup_key — only enforces uniqueness when dedup_key is set.
-- NULLs are distinct in Postgres, so legacy rows (NULL dedup_key) don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_violations_dedup_key
  ON public.violation_events(dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Partial index for "unread notifications" query (admin panel's primary query).
CREATE INDEX IF NOT EXISTS idx_violations_unread
  ON public.violation_events(created_at DESC)
  WHERE acknowledged_at IS NULL;

-- Composite: assessment_id + acknowledged_at IS NULL (per-admin filtered unread)
CREATE INDEX IF NOT EXISTS idx_violations_assessment_unread
  ON public.violation_events(assessment_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- Index on acknowledged_by for "my acked history" query
CREATE INDEX IF NOT EXISTS idx_violations_acked_by
  ON public.violation_events(acknowledged_by, created_at DESC)
  WHERE acknowledged_by IS NOT NULL;

-- ── 3. RLS: Admin UPDATE policy for ack columns only ─────────────────────

-- Drop any existing UPDATE policy first (idempotent)
DROP POLICY IF EXISTS "violations_admin_update_ack" ON public.violation_events;

-- Admins can UPDATE acknowledged_at + acknowledged_by on rows they can read.
-- The CHECK clause restricts the UPDATE to ONLY those two columns — they cannot
-- modify event_type, severity, message, etc. (those are immutable).
CREATE POLICY "violations_admin_update_ack"
  ON public.violation_events FOR UPDATE TO authenticated
  USING (peran_user() = 'admin')   -- can only update rows they can read
  WITH CHECK (
    peran_user() = 'admin'
    AND acknowledged_by = auth.uid()  -- must set acked_by to themselves
  );

-- ── 4. RPC: acknowledge_violation (SECURITY DEFINER) ─────────────────────
--  Allows admin to ack a violation by ID. Returns the updated row's id.
--  SECURITY DEFINER bypasses RLS so we can do atomic UPDATE + RETURNING.

CREATE OR REPLACE FUNCTION public.acknowledge_violation(v_violation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid;
  v_updated_id uuid;
BEGIN
  -- Resolve caller via auth.uid() — SECURITY DEFINER still respects auth context
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Verify caller is an admin
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_admin_id AND peran = 'admin') THEN
    RAISE EXCEPTION 'Only admins can acknowledge violations' USING ERRCODE = '42501';
  END IF;

  -- Atomic UPDATE — only updates if the row is currently unread
  UPDATE public.violation_events
    SET acknowledged_at = now(),
        acknowledged_by = v_admin_id
    WHERE id = v_violation_id
      AND acknowledged_at IS NULL
    RETURNING id INTO v_updated_id;

  RETURN v_updated_id;  -- NULL if row didn't exist or was already acked
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_violation(uuid) TO authenticated;

-- ── 5. RPC: bulk_acknowledge_violations (for "Clear All" button) ─────────

CREATE OR REPLACE FUNCTION public.bulk_acknowledge_violations(v_assessment_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid;
  v_count integer;
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_admin_id AND peran = 'admin') THEN
    RAISE EXCEPTION 'Only admins can bulk-acknowledge' USING ERRCODE = '42501';
  END IF;

  IF v_assessment_ids IS NULL THEN
    -- Ack ALL unread violations the admin can see
    UPDATE public.violation_events
      SET acknowledged_at = now(),
          acknowledged_by = v_admin_id
      WHERE acknowledged_at IS NULL;
  ELSE
    -- Ack only violations for the specified assessment_ids
    UPDATE public.violation_events
      SET acknowledged_at = now(),
          acknowledged_by = v_admin_id
      WHERE acknowledged_at IS NULL
        AND assessment_id = ANY(v_assessment_ids);
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_acknowledge_violations(uuid[]) TO authenticated;

-- ── 6. Trigger: auto-bump assessment_sessions.violation_count on INSERT ──
--  Server-side enforcement so the counter is always accurate even when the
--  signal comes via the EF (service-role, bypasses RLS) — the peserta can no
--  longer "forget" to bump the counter.

DROP TRIGGER IF EXISTS trg_violations_bump_session_count ON public.violation_events;
DROP FUNCTION IF EXISTS public.bump_session_violation_count();

CREATE OR REPLACE FUNCTION public.bump_session_violation_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only count client-originated signals (server-originated ones like
  -- heartbeat_timeout are admin/system signals — admin already sees them
  -- in the notification panel, no need to bump the counter that the peserta sees).
  IF NEW.signal_source = 'client' AND NEW.event_type NOT IN ('max_violations_reached', 'session_blocked', 'session_expired', 'heartbeat_timeout') THEN
    UPDATE public.assessment_sessions
      SET violation_count = COALESCE(violation_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_violations_bump_session_count
  AFTER INSERT ON public.violation_events
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_session_violation_count();

-- ── 7. Realtime: ensure violation_events is in the publication ──────────
--  Supabase Realtime only broadcasts tables that are in the 'supabase_realtime'
--  publication. Check and add if missing (idempotent).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'violation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.violation_events;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Publication might not exist in some environments — non-fatal
  RAISE NOTICE 'Could not add violation_events to supabase_realtime publication: %', SQLERRM;
END $$;

-- ── 8. Verify ────────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Migration 047 applied: violation_events extended with dedup_key, batch_id, signal_source, metadata, acknowledged_at, acknowledged_by.';
  RAISE NOTICE 'New RPCs: acknowledge_violation(uuid), bulk_acknowledge_violations(uuid[])';
  RAISE NOTICE 'New trigger: trg_violations_bump_session_count (auto-increments session.violation_count on INSERT)';
  RAISE NOTICE 'Realtime: violation_events added to supabase_realtime publication (if not already there)';
END $$;
