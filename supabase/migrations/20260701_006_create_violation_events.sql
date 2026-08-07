-- 20260701_006_create_violation_events.sql
-- Creates `violation_events` — normalized violation log (1 row per event).
-- Replaces: violations table (composite doc_id, embedded violationEvents JSONB array).
-- 90-day retention via pg_cron (see migration 013). Heartbeat 15s + DevTools
-- detection. Violations pushed realtime to admin.

CREATE TABLE IF NOT EXISTS public.violation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   uuid NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES public.assessment_sessions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id),

  -- Snapshot (immutable)
  user_email      text,
  user_name       text,
  exam_title      text,

  -- Event details
  event_type      text NOT NULL CHECK (event_type IN (
                    'devtools_shortcut', 'devtools_open', 'tab_switch', 'window_blur',
                    'keyboard_violation', 'copy_attempt', 'paste_attempt',
                    'context_menu', 'select_text', 'max_violations_reached',
                    'session_blocked', 'session_expired', 'heartbeat_timeout'
                  )),
  message         text,
  severity        text DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),

  -- Forensics — IP hashed after 90 days per UU PDP.
  ip_address      text,
  user_agent      text,
  device_id       text,

  -- Auto-expiry (90-day retention)
  created_at      timestamptz DEFAULT now(),
  expires_at      timestamptz DEFAULT (now() + INTERVAL '90 days')
);

-- Indexes
CREATE INDEX idx_violations_assessment  ON public.violation_events(assessment_id);
CREATE INDEX idx_violations_session     ON public.violation_events(session_id);
CREATE INDEX idx_violations_user        ON public.violation_events(user_id);
CREATE INDEX idx_violations_type        ON public.violation_events(event_type);
CREATE INDEX idx_violations_created     ON public.violation_events(created_at DESC);
CREATE INDEX idx_violations_expires     ON public.violation_events(expires_at) WHERE expires_at IS NOT NULL;

-- RLS Policies
ALTER TABLE public.violation_events ENABLE ROW LEVEL SECURITY;

-- Admins: read all violations (collaborative)
CREATE POLICY "violations_admin_read"
  ON public.violation_events FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own violations (for transparency — they can see their own violation history)
CREATE POLICY "violations_peserta_read_own"
  ON public.violation_events FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: INSERT own violations (Guardian.js writes violation events client-side via heartbeat)
-- Server-side validation in Edge Function ensures user_id matches auth.uid()
CREATE POLICY "violations_peserta_insert_own"
  ON public.violation_events FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- No UPDATE — violations are immutable
-- No DELETE — only via pg_cron cleanup (service role)

COMMENT ON TABLE public.violation_events IS
  'Normalized violation log (1 row per event). Replaces violations table with embedded JSONB array. 90-day retention.';
COMMENT ON COLUMN public.violation_events.event_type IS 'Enum: devtools_shortcut, devtools_open, tab_switch, window_blur, keyboard_violation, copy_attempt, paste_attempt, context_menu, select_text, max_violations_reached, session_blocked, session_expired, heartbeat_timeout.';
COMMENT ON COLUMN public.violation_events.expires_at IS 'Auto-purge date (90 days from created_at). pg_cron job deletes expired rows.';
