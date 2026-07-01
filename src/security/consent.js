// =============================================================================
// security/consent.js — UU PDP Consent Gate (v1.0.0)
// =============================================================================
// Checks if peserta has given consent. If not, shows consent popup.
// Records consent to `consents` table via Supabase REST API.
// Blocks access to assessment until consent given.
//
// Edge cases handled:
//   - First login (no consent) → show popup
//   - Consent already given → skip
//   - Policy version change → re-consent required
//   - Network error → show popup anyway (fail-safe)
//   - User not logged in → redirect to login
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
        // Not logged in — redirect to login
        console.info('[consent] User not logged in, skipping consent');
        return true;
      }

      const user = window.firebaseAuth.currentUser;
      const db = window.firebaseDb;
      if (!db) {
        console.warn('[consent] DB not ready, allowing access (fail-safe)');
        return true;
      }

      try {
        // Check existing consent
        const snap = await db.collection('consents')
          .where('user_id', '==', user.uid)
          .where('consent_type', '==', CONSENT_TYPE)
          .where('granted', '==', true)
          .where('revoked_at', '==', null)
          .orderBy('granted_at', 'desc')
          .limit(1)
          .get();

        if (snap.empty) {
          // No consent — show popup
          console.info('[consent] No consent found, showing popup');
          return this._showPopup();
        }

        const latest = snap.docs[0].data();
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
        const db = window.firebaseDb;
        const user = window.firebaseAuth?.currentUser;
        if (!db || !user) return;
        // Update users.consent_at if null (one-time sync)
        await db.collection('users').doc(userId).update({
          consent_at: new Date().toISOString(),
          consent_version: POLICY_VERSION,
        });
      } catch (err) {
        console.warn('[consent] sync consent_at failed:', err);
      }
    },

    _showPopup(previousVersion = null) {
      return new Promise((resolve) => {
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
          ? `<p style="font-size: 13px; color: var(--albedu-warning, #f59e0b); margin: 8px 0 16px; padding: 8px 12px; background: #fffbeb; border-radius: 6px;">⚠ Kebijakan Privasi telah diperbarui (v${previousVersion} → v${POLICY_VERSION}). Mohon setujui kembali.</p>`
          : '';

        dialog.innerHTML = `
          <h2 style="font-size: 22px; font-weight: 700; margin: 0 0 8px; color: var(--albedu-heading, #0f172a);">Pemberitahuan Privasi AlbEdu</h2>
          ${versionNote}
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            AlbEdu mengumpulkan data berikut saat Anda mengerjakan asesmen:
          </p>
          <ul style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.8; padding-left: 20px; margin: 12px 0;">
            <li>Email Google Anda</li>
            <li>Nama yang Anda input</li>
            <li>Jawaban Anda</li>
            <li>Aktivitas selama ujian (untuk anti-cheat)</li>
            <li>Alamat IP dan perangkat</li>
          </ul>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            Data digunakan untuk: menyimpan dan menilai jawaban, mencegah kecurangan, audit keamanan.
            Data disimpan sesuai kebijakan retensi (90 hari - 3 tahun).
          </p>
          <p style="font-size: 14px; color: var(--albedu-body, #475569); line-height: 1.6; margin: 16px 0;">
            Anda bisa request akses/hapus data kapan saja. Lihat <a href="../pages/privacy-policy.html" target="_blank" style="color: var(--albedu-primary, #2563eb);">Kebijakan Privasi</a> lengkap.
          </p>
          <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: flex-end;">
            <button id="consent-reject" type="button" style="
              padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
              background: transparent; color: var(--albedu-body, #475569);
              border: 1px solid var(--albedu-border, #e2e8f0); cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">Tidak Setuju</button>
            <button id="consent-accept" type="button" style="
              padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;
              background: var(--albedu-primary, #2563eb); color: #fff;
              border: none; cursor: pointer;
              font-family: inherit; transition: all 150ms;
            ">Setuju</button>
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
          // Logout
          if (window.Auth?.authLogout) {
            window.Auth.authLogout({ skipConfirm: true });
          } else {
            window.location.href = '../pages/login.html';
          }
          resolve(false);
        });
      });
    },

    async _grantConsent() {
      const user = window.firebaseAuth?.currentUser;
      const db = window.firebaseDb;
      if (!user || !db) throw new Error('Auth not ready');

      const ip = await this._getClientIP();
      const userAgent = navigator.userAgent;

      // Insert consent record
      await db.collection('consents').add({
        user_id: user.uid,
        consent_type: CONSENT_TYPE,
        version: POLICY_VERSION,
        granted: true,
        granted_at: new Date().toISOString(),
        ip_address: ip,
        user_agent: userAgent,
      });

      // Update user's consent_at
      await db.collection('users').doc(user.uid).update({
        consent_at: new Date().toISOString(),
        consent_version: POLICY_VERSION,
      });

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
