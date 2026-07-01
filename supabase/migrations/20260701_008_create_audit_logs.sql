-- =============================================================================
-- 20260701_008_create_audit_logs.sql
-- AlbEdu v1.0.0 — Phase 1.8
-- =============================================================================
-- Creates `audit_logs` — Q9 audit trail tier B (Standard).
-- Logs ~15 event types: login, logout, create/publish/start/pause/resume/finish/delete
-- assessment, block/unblock participant, submit assessment, violation, DSR, etc.
--
-- Q10: retention 1 year (auto-archive via pg_cron — see 013).
-- Q17: UU PDP compliance — IP + user_agent stored for forensic.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Actor (who performed the action)
  actor_id        uuid REFERENCES public.users(id),
  actor_email     text,
  actor_role      text CHECK (actor_role IN ('admin', 'peserta', 'system')),

  -- Action (what happened)
  action          text NOT NULL CHECK (action IN (
                    -- Auth events
                    'LOGIN', 'LOGOUT', 'LOGIN_FAILED',
                    'REGISTER_ADMIN', 'REGISTER_PESERTA',
                    -- Assessment lifecycle
                    'CREATE_ASSESSMENT', 'PUBLISH_ASSESSMENT', 'ARCHIVE_ASSESSMENT',
                    'DELETE_ASSESSMENT', 'EDIT_ASSESSMENT',
                    'START_ASSESSMENT', 'PAUSE_ASSESSMENT', 'RESUME_ASSESSMENT',
                    'FINISH_ASSESSMENT',
                    -- Session/participant
                    'BLOCK_PARTICIPANT', 'UNBLOCK_PARTICIPANT',
                    'FORCE_SUBMIT', 'START_SESSION', 'END_SESSION',
                    -- Submission
                    'SUBMIT_ASSESSMENT',
                    -- Compliance (Q17)
                    'CONSENT_GRANTED', 'CONSENT_REVOKED',
                    'DSR_REQUEST', 'DSR_RESOLVED',
                    'DATA_EXPORT', 'ACCOUNT_DELETE',
                    -- Violations
                    'VIOLATION_DETECTED', 'MAX_VIOLATIONS_REACHED',
                    -- System
                    'CONFIG_CHANGE', 'WORKER_DEPLOY'
                  )),

  -- Target (what was acted upon)
  target_type     text,  -- 'assessment' | 'session' | 'submission' | 'user' | 'question_bank' | etc.
  target_id       text,  -- UUID of target (string for flexibility)

  -- Metadata (action-specific details)
  metadata        jsonb DEFAULT '{}'::jsonb,

  -- Forensics (Q17)
  ip_address      text,
  user_agent      text,

  -- Auto-expiry (Q10: 1 year for audit logs)
  created_at      timestamptz DEFAULT now(),
  expires_at      timestamptz DEFAULT (now() + INTERVAL '365 days')
);

-- ── Indexes ──
CREATE INDEX idx_audit_actor     ON public.audit_logs(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_audit_action    ON public.audit_logs(action);
CREATE INDEX idx_audit_target    ON public.audit_logs(target_type, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX idx_audit_created   ON public.audit_logs(created_at DESC);
CREATE INDEX idx_audit_expires   ON public.audit_logs(expires_at) WHERE expires_at IS NOT NULL;

-- ── RLS Policies ──
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Admins: read all audit logs (forensic visibility)
CREATE POLICY "audit_admin_read"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own audit logs only (transparency — they can see their own activity)
CREATE POLICY "audit_peserta_read_own"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND actor_id = auth.uid());

-- INSERT only via Edge Functions (service role) or trusted server paths
-- No direct client INSERT — prevents audit log tampering
-- (Edge Functions use service role key which bypasses RLS)

-- No UPDATE — audit logs are immutable (append-only)
-- No DELETE — only via pg_cron cleanup (service role)

COMMENT ON TABLE public.audit_logs IS
  'Q9 audit trail tier B (Standard). ~25 event types. Immutable append-only. 1-year retention. Forensic-grade.';
COMMENT ON COLUMN public.audit_logs.action IS 'Enum: see CHECK constraint for full list. ~25 event types covering auth, assessment lifecycle, sessions, submissions, compliance, violations.';
COMMENT ON COLUMN public.audit_logs.metadata IS 'JSONB. Action-specific details, e.g. { access_code, score, reason }.';
