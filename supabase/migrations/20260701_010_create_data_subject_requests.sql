-- 20260701_010_create_data_subject_requests.sql
-- Creates `data_subject_requests` — tracks DSR (Data Subject Request) lifecycle.
-- UU PDP Article 5-13: peserta can request access, correction, or deletion of
-- their personal data. Admin reviews + resolves DSRs via UI.

CREATE TABLE IF NOT EXISTS public.data_subject_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Request type
  request_type    text NOT NULL CHECK (request_type IN (
                    'access',     -- "I want to see all my data"
                    'correct',    -- "I want to fix my data"
                    'delete',     -- "Delete my account and all my data"
                    'portability',-- "Export my data in machine-readable format"
                    'restrict'    -- "Stop processing my data" (future)
                  )),

  -- Request details
  details         jsonb DEFAULT '{}'::jsonb,  -- { reason, fields_to_correct, ... }
  status          text DEFAULT 'pending' CHECK (status IN (
                    'pending', 'processing', 'completed', 'rejected', 'cancelled'
                  )),

  -- Resolution
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES public.users(id),  -- admin who resolved
  resolution_notes text,

  -- Forensics
  ip_address      text,
  user_agent      text,

  -- Audit
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_dsr_user        ON public.data_subject_requests(user_id);
CREATE INDEX idx_dsr_status      ON public.data_subject_requests(status);
CREATE INDEX idx_dsr_type        ON public.data_subject_requests(request_type);
CREATE INDEX idx_dsr_created     ON public.data_subject_requests(created_at DESC);

-- RLS Policies
ALTER TABLE public.data_subject_requests ENABLE ROW LEVEL SECURITY;

-- Admins: read all DSRs (for review queue)
CREATE POLICY "dsr_admin_read"
  ON public.data_subject_requests FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Admins: update DSR status (resolve/reject)
CREATE POLICY "dsr_admin_update"
  ON public.data_subject_requests FOR UPDATE TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own DSRs (track request status)
CREATE POLICY "dsr_peserta_read_own"
  ON public.data_subject_requests FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: create DSR (submit new request)
CREATE POLICY "dsr_peserta_insert_own"
  ON public.data_subject_requests FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: cancel own pending DSR
CREATE POLICY "dsr_peserta_cancel_own"
  ON public.data_subject_requests FOR UPDATE TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid() AND status = 'pending')
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- No DELETE — DSRs are audit history (append-only with status transitions)

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS dsr_updated_at ON public.data_subject_requests;
CREATE TRIGGER dsr_updated_at
  BEFORE UPDATE ON public.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.data_subject_requests IS
  'UU PDP compliance: Data Subject Request lifecycle. Peserta can request access/correct/delete/portability of their data.';
