// peserta-profile-fab.js — Profile entry point for participant pages.
//
// Peserta pages (assessment/index, take, submitted, blocked) had no logout
// path: the "Kembali ke Login" buttons were plain hrefs, not real logout.
// This injects a profile trigger that opens OptionProfile (the same dropdown
// admin pages use), so peserta can reach "Keluar" → authLogout() → landing.
//
// Two render modes (auto-detected):
//   - WIDE CARD (default on assessment/index entry page, which has
//     `.token-container` + `.token-back`): a full-width card is inserted
//     BELOW the "Kembali ke beranda" link. Simple layout — avatar + nama +
//     peran (Peserta) + chevron. Click opens OptionProfile.
//   - FLOATING FAB (legacy, used on take/submitted/blocked): a fixed-position
//     iOS-style circular avatar button (top-right) that opens OptionProfile.
//
// On admin pages, navigasi.js bootstraps OptionProfile + ProfileEditorPanel.
// Peserta pages don't load navigasi.js (no sidebar), so we bootstrap both
// modules ourselves here. ProfileEditorPanel is needed for the "Edit Profil"
// menu item.

(function () {
  'use strict';

  const WORKER_BASE = 'https://edu.albyte-inc.workers.dev';
  const PEP_SCRIPT_ID = 'pep-panel-script-peserta';
  const OP_SCRIPT_ID = 'op-script-peserta';

  function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  // Build the floating FAB variant (used on take/submitted/blocked pages).
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
        <span data-albedu-icon="person"></span>
      </span>
    `;
    document.body.appendChild(btn);
    return btn;
  }

  // Build the wide card variant (used on assessment/index entry page).
  // Inserted INSIDE .token-container, right after .token-back ("Kembali ke beranda").
  // Layout: [avatar] [nama + peran] [chevron] — full-width, click = open OptionProfile.
  function _buildWideCard() {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'albedu-peserta-profile-card';
    card.setAttribute('data-state', 'loading');
    card.setAttribute('aria-label', 'Profil pengguna');
    card.setAttribute('aria-haspopup', 'menu');
    card.setAttribute('aria-expanded', 'false');
    card.innerHTML = `
      <span class="albedu-peserta-profile-card__avatar">
        <span data-albedu-icon="person"></span>
      </span>
      <span class="albedu-peserta-profile-card__info">
        <span class="albedu-peserta-profile-card__name">Memuat…</span>
        <span class="albedu-peserta-profile-card__role">Peserta</span>
      </span>
      <span class="albedu-peserta-profile-card__chevron" data-albedu-icon="expand_more" aria-hidden="true"></span>
    `;

    // Insert after .token-back inside .token-container. If .token-back isn't
    // found (page structure changed), fall back to appending inside
    // .token-container, then to body.
    const tokenBack = document.querySelector('.token-back');
    if (tokenBack && tokenBack.parentNode) {
      tokenBack.insertAdjacentElement('afterend', card);
    } else {
      const container = document.querySelector('.token-container');
      if (container) container.appendChild(card);
      else document.body.appendChild(card);
    }
    return card;
  }

  // Detect entry-page mode: presence of `.token-container` + `.token-back`
  // means we're on the assessment entry page (assessment/index.html) where the
  // user wants a wide profile card below "Kembali ke beranda" instead of the
  // floating FAB.
  function _useWideCardMode() {
    return !!document.querySelector('.token-container') &&
           !!document.querySelector('.token-back');
  }

  // Populate avatar from Auth.userData. Works for both FAB and wide-card
  // variants — uses a class-prefix argument to target the right elements.
  function _populateAvatar(btn, user) {
    if (!user) return;
    const isCard = btn.classList.contains('albedu-peserta-profile-card');
    const avatarCls = isCard ? '.albedu-peserta-profile-card__avatar' : '.albedu-profile-fab__avatar';
    const avatarEl = btn.querySelector(avatarCls);
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

    // Wide-card: also update the visible name + role text.
    if (isCard) {
      const nameEl = btn.querySelector('.albedu-peserta-profile-card__name');
      if (nameEl) nameEl.textContent = user.nama || 'Pengguna';
      const roleEl = btn.querySelector('.albedu-peserta-profile-card__role');
      if (roleEl) roleEl.textContent = 'Peserta';
    }

    // Presence dot if profile incomplete (FAB variant only — wide card uses
    // a subtler dot style via .albedu-peserta-profile-card__dot).
    if (user.profilLengkap === false) {
      const dot = document.createElement('span');
      dot.className = isCard ? 'albedu-peserta-profile-card__dot' : 'albedu-profile-fab__dot';
      dot.title = 'Profil belum lengkap';
      btn.appendChild(dot);
    }
  }

  // Resolve script base path (mirror navigasi.js logic)
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

  // Load OptionProfile + ProfileEditorPanel (idempotent)
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

  // Wait for Auth
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

  // Init
  function init() {
    // Don't double-init (either variant)
    if (document.querySelector('.albedu-profile-fab, .albedu-peserta-profile-card')) return;

    // Pick variant based on page structure.
    const useWideCard = _useWideCardMode();
    const trigger = useWideCard ? _buildWideCard() : _buildFab();

    // Click handler — OptionProfile will bind its OWN click handler to this
    // trigger via addTrigger() once scripts finish loading. We attach a
    // FALLBACK handler here ONLY for the case where scripts haven't loaded
    // yet (or failed to load). Once OptionProfile has registered this
    // trigger, we MUST skip — otherwise both handlers fire on the same
    // click: our fallback calls open() (sets _isOpen=true), then
    // addTrigger's toggle() sees _isOpen=true and immediately calls
    // close(). Net result: dropdown opens then closes in the same event
    // tick → user sees nothing. The toggle debounce (60ms) doesn't save
    // us because open() doesn't update _lastToggleAt (only toggle does).
    trigger.addEventListener('click', function (e) {
      // If OptionProfile has bound to this trigger, let its own handler
      // do the work — don't double-handle.
      if (window.OptionProfile?.getTriggers?.().includes(trigger)) {
        return;
      }
      // Fallback: OptionProfile not yet loaded or hasn't bound. Try to
      // open directly so the first click still works while scripts are
      // loading in the background.
      if (window.OptionProfile?.isOpen?.()) {
        window.OptionProfile.close();
        return;
      }
      if (window.OptionProfile?.open) {
        // open() expects positional args: (triggerEl, cursorX, cursorY)
        // NOT an object — passing object causes _activeTrigger.getBoundingClientRect error
        window.OptionProfile.open(trigger, e.clientX, e.clientY);
        return;
      }
      // Scripts still loading — click is silently ignored. User can click
      // again once _bootstrapOptionProfile finishes (typically <300ms).
      console.warn('[peserta-profile] OptionProfile not loaded yet — retry in a moment');
    });

    // Bootstrap OptionProfile in the background (non-blocking)
    _bootstrapOptionProfile(trigger);

    // Populate avatar once auth is ready
    _waitForAuth().then((userData) => {
      if (userData) {
        _populateAvatar(trigger, userData);
      } else {
        // No user — keep loading state (byteward will redirect to login)
        console.info('[peserta-profile] No user session — waiting for auth redirect');
      }
    });

    // Sync on pep-saved (profile editor save)
    window.addEventListener('pep-saved', function (e) {
      _populateAvatar(trigger, e.detail);
    });

    console.info('[peserta-profile] initialized (' + (useWideCard ? 'wide-card' : 'fab') + ' mode)');
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
