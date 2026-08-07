// security/consent.js — UU PDP consent gate
//
// Checks if peserta has given consent. If not, shows the consent popup.
// Records consent to the `consents` table via the native Supabase platform
// layer (window.AlbEdu.supabase.client). Blocks access to assessment until
// consent is given.

(function () {
  'use strict';

  const POLICY_VERSION = '1.0.0';
  const CONSENT_TYPE = 'privacy_policy';

  const Consent = {
    async check() {
      if (!window.AlbEdu?.supabase?.auth?.currentUser) {
        // Not logged in — let auth flow handle redirect
        console.info('[consent] User not logged in, skipping consent');
        return true;
      }

      const sb = window.AlbEdu?.supabase?.client;
      if (!sb) {
        console.warn('[consent] AlbEdu.supabase.client not ready, allowing access (fail-safe)');
        return true;
      }

      const user = window.AlbEdu.supabase.auth.currentUser;

      try {
        // .is('revoked_at', null) is required for NULL comparisons.
        // .eq(col, null) produces ?col=eq.null which is the string "null",
        // not SQL NULL — the query silently returns zero rows.
        const { data, error } = await sb
          .from('consents')
          .select('*')
          .eq('user_id', user.id)
          .eq('consent_type', CONSENT_TYPE)
          .eq('granted', true)
          .is('revoked_at', null)
          .order('granted_at', { ascending: false })
          .limit(1);

        if (error) throw new Error(`[consent] query failed: ${error.message}`);

        if (!data || data.length === 0) {
          console.info('[consent] No consent found, showing popup');
          return this._showPopup();
        }

        const latest = data[0];
        if (latest.version !== POLICY_VERSION) {
          console.info(`[consent] Policy updated (${latest.version} → ${POLICY_VERSION}), re-consent required`);
          return this._showPopup(latest.version);
        }

        console.info('[consent] Consent valid, allowing access');
        await this._syncConsentAt(user.id);
        return true;
      } catch (err) {
        console.error('[consent] Check failed, showing popup (fail-safe):', err);
        return this._showPopup();
      }
    },

    async _syncConsentAt(userId) {
      try {
        const sb = window.AlbEdu?.supabase?.client;
        if (!sb) return;
        // Update users.consent_at + consent_version.
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
        const t = (key, params) => key;
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

        // Escape previousVersion before interpolation — it comes from the DB
        // and could contain markup if the policy_versions table is ever
        // tampered.
        const safePrev = String(previousVersion || '').replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
        const versionNote = safePrev
          ? `<p style="font-size: 13px; color: var(--albedu-warning, #f59e0b); margin: 8px 0 16px; padding: 8px 12px; background: #fffbeb; border-radius: 6px;">⚠ Kebijakan Privasi telah diperbarui (v${safePrev} → v${POLICY_VERSION}). Mohon setujui kembali.</p>`
          : '';

        dialog.innerHTML = `
          <h2 style="font-size: 22px; font-weight: 700; margin: 0 0 8px; color: var(--albedu-heading, #0f172a);">${'Pemberitahuan Privasi AlbEdu'}</h2>
          ${versionNote}
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${'AlbEdu mengumpulkan data berikut saat Anda mengerjakan asesmen:'}
          </p>
          <ul style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.8; padding-left: 20px; margin: 12px 0;">
            <li>${'Email Google Anda'}</li>
            <li>${'Nama yang Anda input'}</li>
            <li>${'Jawaban Anda'}</li>
            <li>${'Aktivitas selama asesmen (untuk anti-cheat)'}</li>
            <li>${'Alamat IP dan perangkat'}</li>
          </ul>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${'Data digunakan untuk: menyimpan dan menilai jawaban, mencegah kecurangan, audit keamanan. Data disimpan sesuai kebijakan retensi (90 hari - 3 tahun).'}
          </p>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            ${'Anda bisa request akses/hapus data kapan saja. Lihat Kebijakan Privasi lengkap.'} <a href="../privacy-policy.html" target="_blank" style="color: var(--albedu-primary, #2563eb);">Kebijakan Privasi</a>
          </p>
          <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: flex-end;">
            <button id="consent-reject" type="button" style="
              padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
              background: transparent; color: var(--albedu-body, #475569);
              border: 1px solid var(--albedu-border, #e2e8f0); cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">${'Tidak Setuju'}</button>
            <button id="consent-accept" type="button" style="
              padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;
              background: var(--albedu-primary, #2563eb); color: #fff;
              border: none; cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">${'Setuju'}</button>
          </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          dialog.style.transform = 'translateY(0)';
        });

        const acceptBtn = dialog.querySelector('#consent-accept');
        const rejectBtn = dialog.querySelector('#consent-reject');

        acceptBtn.addEventListener('click', async () => {
          acceptBtn.disabled = true;
          acceptBtn.textContent = 'Menyimpan...';
          try {
            await this._grantConsent();
            this._close(overlay, dialog);
            resolve(true);
          } catch (err) {
            console.error('[consent] grant failed:', err);
            window.notify?.error('Gagal', 'Tidak bisa menyimpan persetujuan. Coba lagi.');
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Setuju';
          }
        });

        rejectBtn.addEventListener('click', () => {
          rejectBtn.disabled = true;
          rejectBtn.textContent = 'Logout...';
          this._close(overlay, dialog);
          if (window.Auth?.authLogout) {
            window.Auth.authLogout({ skipConfirm: true });
          } else {
            // Fallback redirect to login (login page is at /pages/login.html)
            const basePath = window.Auth?.getBasePath?.() || '/';
            window.location.href = basePath + 'pages/login.html';
          }
          resolve(false);
        });
      });
    },

    async _grantConsent() {
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      const sb = window.AlbEdu?.supabase?.client;
      if (!user || !sb) throw new Error('Auth not ready');

      const ip = await this._getClientIP();
      const userAgent = navigator.userAgent;

      // Native Supabase .insert(). The legacy Firebase-shaped code used
      // db.collection('consents').add() — the Firestore shim never
      // implemented .add(), so this threw
      // "db.collection(...).add is not a function".
      const { error: insertError } = await sb
        .from('consents')
        .insert({
          user_id: user.id,
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

      const { error: updateError } = await sb
        .from('users')
        .update({
          consent_at: new Date().toISOString(),
          consent_version: POLICY_VERSION,
        })
        .eq('id', user.id);

      if (updateError) {
        console.warn('[consent] sync consent_at failed:', updateError.message);
      }

      console.info('[consent] Consent granted, version', POLICY_VERSION);
    },

    async _getClientIP() {
      // 5s timeout — ipify should respond in <500ms. If it doesn't, the
      // consent dialog would otherwise hang on "Menyimpan..." forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
        const data = await res.json();
        return data.ip || 'unknown';
      } catch {
        return 'unknown';
      } finally {
        clearTimeout(timer);
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
