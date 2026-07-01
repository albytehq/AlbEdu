// =============================================================================
// peserta-profile-fab.js — Floating Profile Button for participant pages
// =============================================================================
// v0.742.7: New file. Bootstraps a fixed-position iOS-feel profile button
// on participant-side pages (assessment/index, take, submitted, blocked).
// Clicking it triggers OptionProfile (the same dropdown used on admin pages).
//
// WHY: Peserta had no way to logout — the assessment pages had no profile
// button at all. The "Kembali ke Login" buttons on submitted/blocked pages
// were just href links, not real logout. Now peserta can tap the floating
// avatar (top-right, iOS-style) → OptionProfile dropdown → "Keluar" →
// authLogout() → landing page.
//
// HOW IT WORKS:
//   1. Inject a <button class="albedu-profile-fab"> into <body> on DOMContentLoaded.
//   2. Wait for window.Auth to be ready (auth-ready event or polling).
//   3. Populate the avatar with user initials / foto_profil.
//   4. Load OptionProfile script (if not already loaded) and init it with
//      the FAB as a trigger.
//   5. Clicking the FAB → OptionProfile.toggle() at cursor position.
//
// OPTIONPROFILE LOAD PATH:
//   - On admin pages, navigasi.js bootstraps OptionProfile + ProfileEditorPanel.
//   - On peserta pages, navigasi.js is NOT loaded (no sidebar). So we
//     bootstrap OptionProfile ourselves here.
//   - ProfileEditorPanel is also bootstrapped (for "Edit Profil" menu item).
// =============================================================================

(function () {
  'use strict';

  const WORKER_BASE = 'https://edu.albyte-inc.workers.dev';
  const PEP_SCRIPT_ID = 'pep-panel-script-peserta';
  const OP_SCRIPT_ID = 'op-script-peserta';

  // ── Avatar helpers ──────────────────────────────────────────────────────
  function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).slice(0, 2);
    return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
  }

  function _safeAvatarUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (/^https:/i.test(url)) return url;
    if (/^data:image\//i.test(url)) return url;
    if (!/^[a-z]+:/i.test(url)) return url;
    return '';
  }

  // ── Build the FAB DOM ───────────────────────────────────────────────────
  function _buildFab() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'albedu-profile-fab';
    btn.setAttribute('data-state', 'loading');
    btn.setAttribute('aria-label', 'Profil pengguna');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `
      <span class="albedu-profile-fab__avatar">
        <i class="material-symbols-outlined">person</i>
      </span>
    `;
    document.body.appendChild(btn);
    return btn;
  }

  // ── Populate avatar from Auth.userData ──────────────────────────────────
  function _populateAvatar(btn, user) {
    if (!user) return;
    const avatarEl = btn.querySelector('.albedu-profile-fab__avatar');
    if (!avatarEl) return;

    const fotoUrl = user.foto_profil || user.fotoProfil;
    const safeUrl = _safeAvatarUrl(fotoUrl);

    if (safeUrl) {
      avatarEl.innerHTML = `<img src="${_esc(safeUrl)}" alt="Avatar">`;
      const img = avatarEl.querySelector('img');
      if (img) {
        img.addEventListener('error', function () {
          this.style.display = 'none';
          avatarEl.innerHTML = `<span>${_esc(_initials(user.nama))}</span>`;
        }, { once: true });
      }
    } else if (user.nama) {
      avatarEl.innerHTML = `<span>${_esc(_initials(user.nama))}</span>`;
    }

    btn.setAttribute('data-state', 'ready');
    btn.setAttribute('aria-label', `Profil ${user.nama || 'pengguna'}`);
    btn.title = user.nama || 'Profil';

    // Presence dot if profile incomplete
    if (user.profilLengkap === false) {
      const dot = document.createElement('span');
      dot.className = 'albedu-profile-fab__dot';
      dot.title = 'Profil belum lengkap';
      btn.appendChild(dot);
    }
  }

  // ── Resolve script base path (mirror navigasi.js logic) ─────────────────
  function _resolveScriptBase() {
    // Try to find this script's src
    const myScript = document.querySelector('script[src*="peserta-profile-fab.js"]');
    if (myScript && myScript.src) {
      // src = .../src/profile/peserta-profile-fab.js → strip filename
      return myScript.src.replace(/peserta-profile-fab\.js.*$/, '');
    }
    // Fallback: derive from Auth BASE_PATH
    const authBase = window.Auth?.getBasePath?.();
    if (authBase) return authBase + 'src/profile/';
    // Final fallback: peserta pages are at /pages/assessment/*.html = 2 levels deep
    return '../../src/profile/';
  }

  // ── Load OptionProfile + ProfileEditorPanel (idempotent) ────────────────
  function _loadScript(src, id) {
    return new Promise((resolve, reject) => {
      if (document.getElementById(id)) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(s);
    });
  }

  async function _bootstrapOptionProfile(fab) {
    const base = _resolveScriptBase();

    try {
      // Load ProfileEditorPanel first (OptionProfile.init depends on it for "Edit Profil")
      await _loadScript(base + 'editor-panel.js', PEP_SCRIPT_ID);

      if (window.ProfileEditorPanel) {
        window.ProfileEditorPanel.init({
          trigger: [],
          workerBase: WORKER_BASE,
          onSaved: function (user) {
            // Refresh FAB avatar after profile save
            _populateAvatar(fab, user);
          },
        });
      }

      // Load OptionProfile
      await _loadScript(base + 'option-profile.js', OP_SCRIPT_ID);

      if (!window.OptionProfile) {
        console.warn('[peserta-fab] OptionProfile failed to load');
        return;
      }

      window.OptionProfile.init({
        triggers: [fab],
        context: 'peserta',
        workerBase: WORKER_BASE,
      });

      // Listen for option-profile-ready (defensive — navigasi.js pattern)
      document.addEventListener('option-profile-ready', function () {
        if (window.OptionProfile?.addTrigger) {
          window.OptionProfile.addTrigger(fab);
        }
      });

      console.info('[peserta-fab] OptionProfile bootstrapped');
    } catch (err) {
      console.error('[peserta-fab] bootstrap failed:', err);
    }
  }

  // ── Wait for Auth ───────────────────────────────────────────────────────
  function _waitForAuth() {
    return new Promise((resolve) => {
      if (window.Auth?.userData) return resolve(window.Auth.userData);
      if (window.Auth?.authReady) return resolve(window.Auth.userData || null);

      let resolved = false;
      const onReady = (e) => {
        if (resolved) return;
        resolved = true;
        resolve(e?.detail?.role != null ? window.Auth?.userData : null);
      };
      document.addEventListener('auth-ready', onReady, { once: true });

      // Poll fallback (in case auth-ready already fired before listener attached)
      let polls = 0;
      const poll = setInterval(() => {
        if (window.Auth?.userData || window.Auth?.authReady || ++polls > 30) {
          clearInterval(poll);
          if (!resolved) {
            resolved = true;
            resolve(window.Auth?.userData || null);
          }
        }
      }, 200);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    // Don't double-init
    if (document.querySelector('.albedu-profile-fab')) return;

    const fab = _buildFab();

    // Click handler — OptionProfile will bind to it via triggers,
    // but we add a fallback click that calls toggle() directly in case
    // OptionProfile script load fails.
    fab.addEventListener('click', function (e) {
      if (window.OptionProfile?.isOpen?.()) {
        window.OptionProfile.close();
        return;
      }
      if (window.OptionProfile?.open) {
        window.OptionProfile.open({ trigger: fab, x: e.clientX, y: e.clientY });
        return;
      }
      // Fallback: if OptionProfile not loaded, do nothing (script load error logged)
      console.warn('[peserta-fab] OptionProfile not loaded — cannot open dropdown');
    });

    // Bootstrap OptionProfile in the background (non-blocking)
    _bootstrapOptionProfile(fab);

    // Populate avatar once auth is ready
    _waitForAuth().then((userData) => {
      if (userData) {
        _populateAvatar(fab, userData);
      } else {
        // No user — keep loading state (byteward will redirect to login)
        console.info('[peserta-fab] No user session — waiting for auth redirect');
      }
    });

    // Sync on pep-saved (profile editor save)
    window.addEventListener('pep-saved', function (e) {
      _populateAvatar(fab, e.detail);
    });

    console.info('[peserta-fab] initialized');
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API (for manual control if needed)
  window.PesertaProfileFab = { init };
})();
