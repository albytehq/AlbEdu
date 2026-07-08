-- 20260701_009_create_consents.sql
-- Creates `consents` — records explicit user consent for data processing.
-- Required by UU PDP (Indonesia) Article 20-22.

CREATE TABLE IF NOT EXISTS public.consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Consent type (what did user consent to?)
  consent_type    text NOT NULL CHECK (consent_type IN (
                    'terms_of_service',
                    'privacy_policy',
                    'data_processing',
                    'marketing',  -- future: email newsletters
                    'analytics'   -- future: anonymous usage analytics
                  )),

  -- Version (which version of the policy did they agree to?)
  version         text NOT NULL,  -- for example "1.0.0", "1.1.0"

  -- Consent state
  granted         boolean NOT NULL,
  granted_at      timestamptz DEFAULT now(),
  revoked_at      timestamptz,  -- if user revokes consent later

  -- Forensics (UU PDP requires proof of consent)
  ip_address      text,
  user_agent      text,

  -- Audit
  created_at      timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_consents_user        ON public.consents(user_id);
CREATE INDEX idx_consents_type        ON public.consents(consent_type);
CREATE INDEX idx_consents_granted     ON public.consents(granted) WHERE granted = true;
CREATE INDEX idx_consents_active      ON public.consents(user_id, consent_type)
  WHERE revoked_at IS NULL;

-- RLS Policies
ALTER TABLE public.consents ENABLE ROW LEVEL SECURITY;

-- Admins: read all consents (compliance audit)
CREATE POLICY "consents_admin_read"
  ON public.consents FOR SELECT TO authenticated
  USING (peran_user() = 'admin');

-- Peserta: read own consents (transparency)
CREATE POLICY "consents_peserta_read_own"
  ON public.consents FOR SELECT TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: INSERT own consent (when they click "Setuju" on consent popup)
CREATE POLICY "consents_peserta_insert_own"
  ON public.consents FOR INSERT TO authenticated
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- Peserta: UPDATE own consent (revoke consent — set revoked_at)
CREATE POLICY "consents_peserta_update_own"
  ON public.consents FOR UPDATE TO authenticated
  USING (peran_user() = 'peserta' AND user_id = auth.uid())
  WITH CHECK (peran_user() = 'peserta' AND user_id = auth.uid());

-- No DELETE — consents are immutable history (append-only with revoke timestamp)

COMMENT ON TABLE public.consents IS
  'UU PDP compliance: explicit user consent records. Required by UU PDP Indonesia Article 20-22.';
COMMENT ON COLUMN public.consents.version IS 'Policy version user agreed to. Allows re-consent when policy changes.';
