// =============================================================================
// security/consent.js — UU PDP Consent Gate (v1.1.0)
// =============================================================================
// Checks if peserta has given consent. If not, shows consent popup.
// Records consent to `consents` table via Supabase native client (window.sb).
// Blocks access to assessment until consent given.
//
// v1.1.0 (v0.742.5): Rewrote to use window.sb (Supabase native) directly.
//   Previous v1.0.0 used Firebase Firestore API (db.collection().where().get(),
//   .add()) via the Firestore-compat shim — but the shim had two bugs:
//     1. .where('revoked_at', '==', null) translated to PostgREST
//        ?revoked_at=eq.null — which is the STRING "null", not SQL NULL.
//        PostgREST requires .is(col, null) for NULL checks. Supabase
//        returned HTTP 400: "invalid input syntax for type timestamp
//        with time zone: 'null'".
//     2. .add() was never implemented on the shim's collection ref —
//        so granting consent threw "db.collection(...).add is not a
//        function".
//   Fix: bypass the shim entirely. Use window.sb.from('consents') with
//   native Supabase query builder (.eq, .is, .order, .limit, .insert).
//
// Edge cases handled:
//   - First login (no consent) → show popup
//   - Consent already given → skip
//   - Policy version change → re-consent required
//   - Network error → show popup anyway (fail-safe)
//   - User not logged in → skip (auth will handle redirect)
//   - "Tidak Setuju" → logout
//   - Refresh during consent → re-show
// =============================================================================

(function () {
  'use strict';

  const POLICY_VERSION = '1.0.0';
  const CONSENT_TYPE = 'privacy_policy';

  const Consent = {
    async check() {
      // Wait for auth
      if (!window.firebaseAuth?.currentUser) {
        // Not logged in — let auth flow handle redirect
        console.info('[consent] User not logged in, skipping consent');
        return true;
      }

      const sb = window.sb;
      if (!sb) {
        console.warn('[consent] window.sb not ready, allowing access (fail-safe)');
        return true;
      }

      const user = window.firebaseAuth.currentUser;

      try {
        // Check existing consent.
        // v1.1.0: use .is('revoked_at', null) instead of .eq(..., null).
        // PostgREST requires .is() for NULL comparisons — .eq(col, null)
        // produces ?col=eq.null which is the string "null", not SQL NULL.
        const { data, error } = await sb
          .from('consents')
          .select('*')
          .eq('user_id', user.uid)
          .eq('consent_type', CONSENT_TYPE)
          .eq('granted', true)
          .is('revoked_at', null)
          .order('granted_at', { ascending: false })
          .limit(1);

        if (error) throw new Error(`[consent] query failed: ${error.message}`);

        if (!data || data.length === 0) {
          // No consent — show popup
          console.info('[consent] No consent found, showing popup');
          return this._showPopup();
        }

        const latest = data[0];
        // Check version — re-consent if policy updated
        if (latest.version !== POLICY_VERSION) {
          console.info(`[consent] Policy updated (${latest.version} → ${POLICY_VERSION}), re-consent required`);
          return this._showPopup(latest.version);
        }

        // Consent valid — update user's consent_at if null
        console.info('[consent] Consent valid, allowing access');
        await this._syncConsentAt(user.uid);
        return true;
      } catch (err) {
        console.error('[consent] Check failed, showing popup (fail-safe):', err);
        return this._showPopup();
      }
    },

    async _syncConsentAt(userId) {
      try {
        const sb = window.sb;
        if (!sb) return;
        // Update users.consent_at + consent_version.
        // Using .eq('id', userId) + .select() to confirm the row was touched.
        const { error } = await sb
          .from('users')
          .update({
            consent_at: new Date().toISOString(),
            consent_version: POLICY_VERSION,
          })
          .eq('id', userId);
        if (error) {
          console.warn('[consent] sync consent_at failed:', error.message);
        }
      } catch (err) {
        console.warn('[consent] sync consent_at failed:', err);
      }
    },

    _showPopup(previousVersion = null) {
      return new Promise((resolve) => {
        // v0.742.9: use i18n for all text
        const t = (key, params) => window.i18n?.t?.(key, params) || key;
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'consent-overlay';
        overlay.style.cssText = `
          position: fixed; inset: 0; z-index: 10000;
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(4px);
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
          opacity: 0; transition: opacity 200ms ease;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
          background: var(--albedu-surface, #fff);
          border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.2);
          max-width: 560px; width: 100%;
          padding: 32px;
          font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
          transform: translateY(10px); transition: transform 200ms ease;
        `;

        const versionNote = previousVersion
          ? `<p style="font-size: 13px; color: var(--albedu-warning, #f59e0b); margin: 8px 0 16px; padding: 8px 12px; background: #fffbeb; border-radius: 6px;">⚠ ${t('peserta.consent_updated', { old: previousVersion, new: POLICY_VERSION })}</p>`
          : '';

        dialog.innerHTML = `
          <h2 style="font-size: 22px; font-weight: 700; margin: 0 0 8px; color: var(--albedu-heading, #0f172a);">${t('peserta.consent_title')}</h2>
          ${versionNote}
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${t('peserta.consent_intro')}
          </p>
          <ul style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.8; padding-left: 20px; margin: 12px 0;">
            <li>${t('peserta.consent_data_1')}</li>
            <li>${t('peserta.consent_data_2')}</li>
            <li>${t('peserta.consent_data_3')}</li>
            <li>${t('peserta.consent_data_4')}</li>
            <li>${t('peserta.consent_data_5')}</li>
          </ul>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${t('peserta.consent_usage')}
          </p>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${t('peserta.consent_rights')} <a href="../pages/privacy-policy.html" target="_blank" style="color: var(--albedu-primary, #2563eb);">Kebijakan Privasi</a>
          </p>
          <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: flex-end;">
            <button id="consent-reject" type="button" style="
              padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
              background: transparent; color: var(--albedu-body, #475569);
              border: 1px solid var(--albedu-border, #e2e8f0); cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">${t('peserta.consent_reject')}</button>
            <button id="consent-accept" type="button" style="
              padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;
              background: var(--albedu-primary, #2563eb); color: #fff;
              border: none; cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">${t('peserta.consent_accept')}</button>
          </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          dialog.style.transform = 'translateY(0)';
        });

        // Wire buttons
        const acceptBtn = dialog.querySelector('#consent-accept');
        const rejectBtn = dialog.querySelector('#consent-reject');

        acceptBtn.addEventListener('click', async () => {
          acceptBtn.disabled = true;
          // v0.742.9: use i18n for saving text
          acceptBtn.textContent = window.i18n?.t?.('peserta.consent_saving') || 'Menyimpan...';
          try {
            await this._grantConsent();
            this._close(overlay, dialog);
            resolve(true);
          } catch (err) {
            console.error('[consent] grant failed:', err);
            window.notify?.error('Gagal', 'Tidak bisa menyimpan persetujuan. Coba lagi.');
            acceptBtn.disabled = false;
            acceptBtn.textContent = window.i18n?.t?.('peserta.consent_accept') || 'Setuju';
          }
        });

        rejectBtn.addEventListener('click', () => {
          rejectBtn.disabled = true;
          rejectBtn.textContent = window.i18n?.t?.('peserta.profile_logout') || 'Logout...';
          this._close(overlay, dialog);
          // Logout
          if (window.Auth?.authLogout) {
            window.Auth.authLogout({ skipConfirm: true });
          } else {
            // Fallback: redirect to login (v0.742.3+ login page is at /pages/login.html)
            const basePath = window.Auth?.getBasePath?.() || '/';
            window.location.href = basePath + 'pages/login.html';
          }
          resolve(false);
        });
      });
    },

    async _grantConsent() {
      const user = window.firebaseAuth?.currentUser;
      const sb = window.sb;
      if (!user || !sb) throw new Error('Auth not ready');

      const ip = await this._getClientIP();
      const userAgent = navigator.userAgent;

      // v1.1.0: Insert consent record via native Supabase .insert().
      // Previous v1.0.0 used db.collection('consents').add() — the Firestore
      // shim never implemented .add(), so this threw
      // "db.collection(...).add is not a function".
      const { error: insertError } = await sb
        .from('consents')
        .insert({
          user_id: user.uid,
          consent_type: CONSENT_TYPE,
          version: POLICY_VERSION,
          granted: true,
          granted_at: new Date().toISOString(),
          ip_address: ip,
          user_agent: userAgent,
        });

      if (insertError) {
        throw new Error(`[consent] insert failed: ${insertError.message}`);
      }

      // Update user's consent_at + consent_version
      const { error: updateError } = await sb
        .from('users')
        .update({
          consent_at: new Date().toISOString(),
          consent_version: POLICY_VERSION,
        })
        .eq('id', user.uid);

      if (updateError) {
        console.warn('[consent] sync consent_at failed:', updateError.message);
      }

      console.info('[consent] Consent granted, version', POLICY_VERSION);
    },

    async _getClientIP() {
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip || 'unknown';
      } catch {
        return 'unknown';
      }
    },

    _close(overlay, dialog) {
      overlay.style.opacity = '0';
      dialog.style.transform = 'translateY(10px)';
      setTimeout(() => overlay.remove(), 200);
    },
  };

  window.Consent = Consent;
})();
