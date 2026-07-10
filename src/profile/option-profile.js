// OptionProfile.js — global profile dropdown (Apple-styled) for both admin and
// peserta contexts. Anchors to the cursor on click and pops a frosted-glass
// menu with avatar, role chip, and actions (edit profile, navigate, logout).
// Zero external deps beyond Auth + ProfileEditorPanel.
//
// Public API: init({triggers, context}), open(triggerEl, x, y),
// close(), toggle(), isOpen(), update(), destroy(), addTrigger(el),
// getTriggers().

;(function (global) {
  'use strict';

  // Animation easings
  const ANIM_SPRING_OVERSHOOT = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const ANIM_SPRING           = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const ANIM_EASE             = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const ANIM_EASE_IN          = 'cubic-bezier(0.4, 0, 1, 1)';

  const DROPDOWN_W    = 280;
  const GAP           = 24;  // gap between cursor and dropdown
  const EDGE_PAD      = 12;  // minimum distance from viewport edge

  // Toggle debounce — short enough to allow intentional rapid toggles, long
  // enough to swallow genuine double-clicks (~50-100ms apart).
  const TOGGLE_DEBOUNCE_MS = 60;
  const CLOSE_ANIM_MS = 200;       // matches CSS 180ms + 20ms margin

  const STAGGER_DELAY_MS = 35;     // delay between each menu item
  const STAGGER_BASE_MS  = 60;     // base delay before first item

  let _cfg          = null;
  let _dropdown     = null;
  let _arrow        = null;
  let _liveRegion   = null;
  let _isOpen       = false;
  let _activeTrigger = null;
  let _cursorX      = 0;
  let _cursorY      = 0;
  // Saved on open so a cancelled logout can re-open the dropdown at the
  // original cursor position instead of jumping to the trigger's rect.
  let _origCursorX  = 0;
  let _origCursorY  = 0;
  let _ppeReady     = false;
  let _closeTimer   = null;
  let _rafId        = null;
  let _lastToggleAt = 0;
  let _initialized  = false;
  let _focusBeforeOpen = null;
  let _cachedHeight = null;
  let _closeResolver = null;
  let _docClickHandler = null;   // outside-click listener
  let _docContextHandler = null; // outside-right-click listener

  // Track attached triggers so we never double-bind. WeakSet means when
  // an element is GC'd, its entry vanishes — no leak. `let` so destroy() can
  // reset it.
  let _attachedTriggers = new WeakSet();

  // CSS (scoped: op-* prefix)
  function _injectStyles() {
    if (document.getElementById('op-styles')) return;
    const s = document.createElement('style');
    s.id = 'op-styles';
    s.textContent = `
      /* Dropdown shell */
      .op-dropdown {
        position: fixed; z-index: 9997;
        width: ${DROPDOWN_W}px; max-width: calc(100vw - ${EDGE_PAD * 2}px);
        background: rgba(255, 255, 255, 0.98);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(59, 130, 246, 0.08);
        border-radius: 16px;
        box-shadow:
          0 0 0 1px rgba(15, 23, 42, 0.03),
          0 4px 8px  rgba(15, 23, 42, 0.04),
          0 12px 28px rgba(15, 23, 42, 0.10),
          0 24px 56px rgba(15, 23, 42, 0.06),
          0 0 32px rgba(37, 99, 235, 0.06);
        overflow: hidden;
        opacity: 0;
        pointer-events: none;
        transform: scale(0.85);
        transition:
          transform 420ms ${ANIM_SPRING_OVERSHOOT},
          opacity   220ms ${ANIM_EASE};
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display',
                     'Segoe UI', Roboto, sans-serif;
        will-change: transform, opacity;
      }
      .op-dropdown.op-open {
        opacity: 1;
        pointer-events: auto;
        transform: scale(1);
      }
      .op-dropdown.op-closing {
        opacity: 0;
        transform: scale(0.92);
        transform-origin: center bottom;
        transition:
          transform 180ms ${ANIM_EASE_IN},
          opacity   140ms ${ANIM_EASE_IN};
        pointer-events: none;
      }
      /* Container focus: no visible outline. Keyboard users get item-level
         focus rings via :focus-visible below. */
      .op-dropdown:focus {
        outline: none;
      }
      .op-dropdown:focus-visible {
        outline: none;
      }

      /* Arrow — pure clip-path triangle pointing at the trigger. (Earlier
         versions tried to combine a rotate(45deg) with clip-path and produced
         a malformed shape; this is the clean version.) */
      .op-arrow {
        position: fixed; z-index: 9998;
        width: 16px; height: 8px;
        background: #ffffff;
        opacity: 0;
        pointer-events: none;
        transform: scale(0.6);
        transition: opacity 220ms ${ANIM_EASE}, transform 220ms ${ANIM_SPRING};
        filter: drop-shadow(0 -1px 1px rgba(15, 23, 42, 0.04));
      }
      .op-arrow.op-visible {
        opacity: 1;
        transform: scale(1);
      }
      /* Arrow placement variants — set by JS via clip-path */
      .op-arrow.op-below {
        /* Dropdown is BELOW trigger → arrow at top of dropdown, pointing UP */
        clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
      }
      .op-arrow.op-above {
        /* Dropdown is ABOVE trigger → arrow at bottom of dropdown, pointing DOWN */
        clip-path: polygon(0% 0%, 100% 0%, 50% 100%);
      }

      /* User header */
      .op-header {
        display: flex; align-items: center; gap: 12px;
        padding: 16px 14px 13px;
        position: relative;
      }
      .op-avatar {
        width: 42px; height: 42px;
        border-radius: 11px;
        overflow: hidden;
        flex-shrink: 0;
        background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; color: #2563eb;
        box-shadow:
          0 2px 8px rgba(37, 99, 235, 0.15),
          inset 0 0 0 1px rgba(255, 255, 255, 0.5);
        animation: op-avatar-in 500ms ${ANIM_SPRING_OVERSHOOT} both;
      }
      @keyframes op-avatar-in {
        0%   { transform: scale(0.6); opacity: 0; }
        60%  { transform: scale(1.08); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      .op-avatar img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .op-avatar-fallback {
        font-size: 16px; color: #2563eb;
      }

      .op-user-info {
        flex: 1; min-width: 0;
      }
      .op-user-name {
        font-size: 14px; font-weight: 620; color: #0f172a;
        line-height: 1.3;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        letter-spacing: -0.18px;
      }
      .op-user-email {
        font-size: 11.5px; color: #94a3b8;
        margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-weight: 400;
      }
      .op-chips {
        display: flex; align-items: center; gap: 5px;
        margin-top: 5px;
        flex-wrap: wrap;
      }
      .op-role-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2.5px 7.5px;
        border-radius: 6px;
        font-size: 10px; font-weight: 600;
        letter-spacing: 0.02em;
        line-height: 1.4;
        animation: op-chip-in 360ms ${ANIM_SPRING} both;
        animation-delay: 80ms;
      }
      @keyframes op-chip-in {
        0%   { transform: translateY(4px); opacity: 0; }
        100% { transform: translateY(0); opacity: 1; }
      }
      .op-role-admin {
        background: rgba(37, 99, 235, 0.10);
        color: #2563eb;
      }
      .op-role-peserta {
        background: rgba(16, 185, 129, 0.10);
        color: #059669;
      }
      .op-role-chip i { font-size: 8px; }
      .op-incomplete-chip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 2.5px 6.5px;
        border-radius: 6px;
        font-size: 9.5px; font-weight: 600;
        background: rgba(245, 158, 11, 0.12);
        color: #b45309;
        animation: op-chip-in 360ms ${ANIM_SPRING} both, op-pulse 2s ${ANIM_EASE} infinite;
        animation-delay: 120ms, 480ms;
      }
      @keyframes op-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.55; }
      }
      .op-incomplete-chip i { font-size: 8px; }

      /* Separator */
      .op-sep {
        height: 1px;
        background: linear-gradient(90deg,
          transparent 0%, #e2e8f0 20%, #e2e8f0 80%, transparent 100%);
        margin: 0 12px;
      }

      /* Menu items */
      .op-menu {
        padding: 6px 6px 7px;
      }
      .op-item {
        display: flex; align-items: center; gap: 11px;
        width: 100%;
        padding: 9px 10px;
        border-radius: 9px;
        border: none; background: transparent;
        cursor: pointer;
        font-family: inherit; font-size: 13px; font-weight: 500;
        color: #334155;
        transition:
          background 140ms ease,
          transform 100ms ease;
        text-align: left;
        -webkit-tap-highlight-color: transparent;
        outline: none;
        position: relative;
        overflow: hidden;
        opacity: 0;
        transform: translateY(6px);
        animation: op-item-in 280ms ${ANIM_SPRING} forwards;
      }
      @keyframes op-item-in {
        0%   { opacity: 0; transform: translateY(6px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      /* Stagger — set via inline --op-delay */
      .op-item { animation-delay: var(--op-delay, 0ms); }

      /* Clear focus styling on programmatic focus. Without this, browsers
         keep a default outline/background on the auto-focused first item,
         making it look "stuck hovered" even after the mouse moves away.
         Only :focus-visible (keyboard nav) gets a visible ring. */
      .op-item:focus {
        outline: none;
      }
      .op-item:focus:not(:focus-visible) {
        background: transparent;
        box-shadow: none;
      }
      /* Subtle focus ring — distinct from hover, only for keyboard nav */
      .op-item:focus-visible {
        outline: none;
        background: transparent;
        box-shadow: inset 0 0 0 1.5px rgba(37,99,235,0.22);
      }
      /* Scope :hover to devices that actually support hover (mouse). On
         touch devices, :hover sticks after a tap and won't clear until the
         user taps elsewhere — looks like a stuck hover state. */
      @media (hover: hover) {
        .op-item:hover {
          background: linear-gradient(180deg, #f0f5ff 0%, #e8eeff 100%);
        }
        .op-item:hover .op-item-icon {
          transform: scale(1.12) rotate(-3deg);
        }
        .op-item:hover .op-item-chevron {
          color: #64748b;
          transform: translateX(3px);
        }
      }
      .op-item:active {
        background: #dbe7ff;
        transform: scale(0.985);
      }
      .op-item:active .op-item-icon {
        transform: scale(0.95);
      }
      .op-item-icon {
        width: 30px; height: 30px;
        border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
        transition: transform 180ms ${ANIM_SPRING};
      }
      .op-icon-blue {
        background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
        color: #2563eb;
      }
      .op-icon-green {
        background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
        color: #059669;
      }
      .op-icon-amber {
        background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
        color: #d97706;
      }
      .op-icon-red {
        background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
        color: #dc2626;
      }
      .op-item-text {
        flex: 1; min-width: 0;
      }
      .op-item-text span {
        display: block;
        font-size: 11px; font-weight: 400;
        color: #94a3b8;
        margin-top: 1.5px;
        line-height: 1.3;
      }
      .op-item-chevron {
        font-size: 10px; color: #cbd5e1;
        transition: transform 180ms ${ANIM_SPRING}, color 140ms ease;
        margin-right: -2px;
      }
      /* (chevron hover is scoped inside @media (hover: hover) above) */

      /* Danger item */
      .op-item.op-danger {
        color: #dc2626;
      }
      @media (hover: hover) {
        .op-item.op-danger:hover {
          background: linear-gradient(180deg, #fef2f2 0%, #fee2e2 100%);
        }
        .op-item.op-danger:hover .op-item-icon {
          background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
        }
      }
      .op-item.op-danger:active {
        background: #fecaca;
      }
      .op-item.op-danger:focus-visible {
        background: transparent;
        box-shadow: inset 0 0 0 1.5px rgba(239,68,68,0.22);
        outline: none;
      }
      /* (danger hover is scoped inside @media (hover: hover) above) */

      /* Footer */
      .op-footer {
        padding: 7px 14px 9px;
        text-align: right;
        font-size: 9.5px; color: #cbd5e1;
        letter-spacing: 0.04em;
        font-weight: 500;
        border-top: 1px solid #f1f5f9;
        background: rgba(248, 250, 252, 0.6);
      }

      /* Live region (sr-only) */
      .op-live {
        position: absolute;
        width: 1px; height: 1px;
        padding: 0; margin: -1px;
        overflow: hidden;
        clip: rect(0,0,0,0);
        white-space: nowrap;
        border: 0;
      }

      /* Ripple effect on item click */
      .op-ripple {
        position: absolute;
        border-radius: 50%;
        background: rgba(37, 99, 235, 0.22);
        pointer-events: none;
        transform: scale(0);
        animation: op-ripple 520ms ${ANIM_EASE} forwards;
      }
      .op-item.op-danger .op-ripple {
        background: rgba(239, 68, 68, 0.22);
      }
      @keyframes op-ripple {
        to {
          transform: scale(2.4);
          opacity: 0;
        }
      }

      /* Responsive: slightly wider on small screens */
      @media (max-width: 400px) {
        .op-dropdown {
          width: calc(100vw - ${EDGE_PAD * 2}px);
          max-width: 320px;
        }
      }

      /* Reduced motion: collapse all animations */
      @media (prefers-reduced-motion: reduce) {
        .op-dropdown,
        .op-arrow,
        .op-avatar,
        .op-role-chip,
        .op-incomplete-chip,
        .op-item,
        .op-item-icon,
        .op-item-chevron,
        .op-ripple {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
    `;
    document.head.appendChild(s);
  }

  // Escape HTML
  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Validate avatar URL scheme — only https: or data:image/ allowed.
  function _safeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (/^https:/i.test(url)) return url;
    if (/^data:image\//i.test(url)) return url;
    if (!/^[a-z]+:/i.test(url)) return url;
    return '';
  }

  // Fallback avatar (initials SVG data-URI)
  function _initialsAvatar(seed) {
    const rawInitials = (seed || '?')
      .trim()
      .split(/\s+/)
      .map(w => w[0]?.toUpperCase() || '')
      .slice(0, 2)
      .join('');
    const initials = _esc(rawInitials);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'>
      <defs>
        <linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'>
          <stop offset='0%' stop-color='%23dbeafe'/>
          <stop offset='100%' stop-color='%23bfdbfe'/>
        </linearGradient>
      </defs>
      <rect width='80' height='80' rx='18' fill='url(%23g)'/>
      <text x='50%' y='55%' dominant-baseline='middle' text-anchor='middle'
        fill='%232563eb' font-size='30' font-family='system-ui,sans-serif' font-weight='700'>
        ${initials}
      </text>
    </svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Build DOM
  function _buildDOM() {
    // Arrow: clean triangle pointing at trigger
    _arrow = document.createElement('div');
    _arrow.className = 'op-arrow';
    _arrow.setAttribute('aria-hidden', 'true');

    // Dropdown
    _dropdown = document.createElement('div');
    _dropdown.className = 'op-dropdown';
    _dropdown.setAttribute('role', 'menu');
    _dropdown.setAttribute('aria-label', 'Opsi Profil');
    _dropdown.setAttribute('aria-hidden', 'true');

    // Live region for screen reader announcements.
    _liveRegion = document.createElement('div');
    _liveRegion.className = 'op-live';
    _liveRegion.setAttribute('aria-live', 'polite');
    _liveRegion.setAttribute('aria-atomic', 'true');

    document.body.appendChild(_arrow);
    document.body.appendChild(_dropdown);
    document.body.appendChild(_liveRegion);

    // Keyboard navigation inside dropdown
    _dropdown.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); e.stopPropagation(); return; }

      const items = Array.from(_dropdown.querySelectorAll('[data-op]'));
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = idx < items.length - 1 ? idx + 1 : 0;
        items[next].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx === -1) {
          items[items.length - 1].focus();
        } else if (idx > 0) {
          items[idx - 1].focus();
        }
        // idx === 0 → no-op (stay on first item)
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Tab') {
        // Tab closes the dropdown — focus naturally moves to next element
        close();
      }
    });

    // Close dropdown when window loses focus or page becomes hidden.
    window.addEventListener('blur', () => { if (_isOpen) close(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && _isOpen) close();
    });
  }

  // Document-level outside-click handler. Earlier versions used an invisible
  // full-viewport .op-shade div, but it intercepted ALL clicks (including on
  // the trigger itself, breaking toggle-close). Replaced with a document
  // listener that ignores clicks on the dropdown or the active trigger.
  function _attachOutsideClickHandlers() {
    if (_docClickHandler) return; // already attached

    _docClickHandler = (e) => {
      if (!_isOpen) return;
      // Click inside dropdown — let item handler take over
      if (_dropdown && _dropdown.contains(e.target)) return;
      // Click on active trigger — let toggle handler take over
      if (_activeTrigger && _activeTrigger.contains(e.target)) return;
      // Otherwise: outside click → close
      close();
    };

    _docContextHandler = (e) => {
      if (!_isOpen) return;
      if (_dropdown && _dropdown.contains(e.target)) return;
      if (_activeTrigger && _activeTrigger.contains(e.target)) return;
      e.preventDefault();
      close();
    };

    // Use capture phase so we run BEFORE any other handler that might
    // stopPropagation. This guarantees we always see the click.
    document.addEventListener('click', _docClickHandler, true);
    document.addEventListener('contextmenu', _docContextHandler, true);
  }

  function _detachOutsideClickHandlers() {
    if (_docClickHandler) {
      document.removeEventListener('click', _docClickHandler, true);
      _docClickHandler = null;
    }
    if (_docContextHandler) {
      document.removeEventListener('contextmenu', _docContextHandler, true);
      _docContextHandler = null;
    }
  }

  // Ripple effect on item click
  function _spawnRipple(btn, e) {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.className = 'op-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';

    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 520);
  }

  // Populate dropdown content
  function _populate() {
    // Invalidate height cache — content may have changed
    _cachedHeight = null;

    const user = window.Auth?.userData || {};

    const name       = user.nama || user.displayName || 'Pengguna';
    const email      = user.email || '';
    const avatarUrl  = user.avatar_url || user.foto_profil || user.fotoProfil || '';
    const role       = user.peran || 'peserta';
    const isAdmin    = role === 'admin';
    // DB column is `profile_complete` (renamed from `profil_lengkap` by
    // migration 20260701_002_alter_users_snake_case.sql). `profilLengkap` is
    // never actually set anywhere, so that check was always false — this
    // banner silently never showed. Kept as fallback for any legacy caller.
    const incomplete = user.profile_complete === false || user.profilLengkap === false || user.profil_lengkap === false;
    const roleLabel  = isAdmin ? ('Administrator') : ('Peserta');
    const roleClass  = isAdmin ? 'op-role-admin' : 'op-role-peserta';
    const roleIcon   = isAdmin ? 'shield' : 'school';

    const avatarSrc = _safeUrl(avatarUrl) || _initialsAvatar(name || email);

    // Build menu items array for stagger calculation
    const items = [
      {
        op: 'edit-profile',
        iconClass: 'op-icon-blue',
        icon: 'person_edit',
        title: 'Edit Profil',
        subtitle: 'Ubah nama dan foto profil',
        danger: false,
      },
    ];

    if (isAdmin) {
      items.push({
        op: 'admin-panel',
        iconClass: 'op-icon-amber',
        icon: 'view_column',
        title: 'Panel Admin',
        subtitle: 'Kembali ke dashboard',
        danger: false,
      });
    }

    items.push({
      op: 'logout',
      iconClass: 'op-icon-red',
      icon: 'logout',
      title: 'Keluar',
      subtitle: 'Logout dari akun',
      danger: true,
    });

    // Render items with stagger delay
    const itemsHtml = items.map((item, i) => {
      const delay = STAGGER_BASE_MS + (i * STAGGER_DELAY_MS);
      const sepBefore = (i > 0 && items[i].op === 'logout') ? '<div class="op-sep" style="margin:4px 12px;"></div>' : '';
      return `
        ${sepBefore}
        <button class="op-item ${item.danger ? 'op-danger' : ''}" data-op="${item.op}" role="menuitem" style="--op-delay: ${delay}ms;">
          <div class="op-item-icon ${item.iconClass}">
            <span data-albedu-icon="${item.icon}"></span>
          </div>
          <div class="op-item-text">
            ${_esc(item.title)}
            <span>${_esc(item.subtitle)}</span>
          </div>
          <span class="op-item-chevron" data-albedu-icon="chevron_right"></span>
        </button>
      `;
    }).join('');

    _dropdown.innerHTML = `
      <div class="op-header">
        <div class="op-avatar">
          <img src="${_esc(avatarSrc)}" alt="Avatar ${_esc(name)}" data-op-avatar>
        </div>
        <div class="op-user-info">
          <div class="op-user-name">${_esc(name)}</div>
          ${email ? `<div class="op-user-email">${_esc(email)}</div>` : ''}
          <div class="op-chips">
            <span class="op-role-chip ${roleClass}">
              <span data-albedu-icon="${roleIcon}"></span> ${_esc(roleLabel)}
            </span>
            ${incomplete ? `<span class="op-incomplete-chip"><span data-albedu-icon="error"></span> ${_esc('Belum lengkap')}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="op-sep"></div>

      <div class="op-menu">
        ${itemsHtml}
      </div>

      <div class="op-footer">AlbEdu v0.819.0</div>
    `;

    // Attach onerror via event listener (CSP-friendly)
    const avatarImg = _dropdown.querySelector('img[data-op-avatar]');
    if (avatarImg) {
      avatarImg.addEventListener('error', function () {
        this.style.display = 'none';
        // SVG icon fallback (replaces Material Symbols font)
        const fallback = document.createElement('span');
        fallback.className = 'op-avatar-fallback';
        fallback.setAttribute('data-albedu-icon', 'account-circle');
        fallback.setAttribute('aria-hidden', 'true');
        this.parentElement.appendChild(fallback);
        window.AlbEdu?.bindIcons?.(this.parentElement);
      }, { once: true });
    }

    // Wire click handlers + ripple effect + mouseleave blur.
    _dropdown.querySelectorAll('[data-op]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        _spawnRipple(btn, e);
        // Blur immediately on click so the focus ring (which looks like a
        // stuck hover) is removed before the close animation starts.
        btn.blur();
        _handleAction(btn.dataset.op, btn);
      });
      // On mouseleave, blur the item. Catches the edge case where focus was
      // set programmatically (for example via keyboard navigation) and the
      // user then moves the mouse over a different item — without this, the
      // originally-focused item keeps its ring while the newly-hovered item
      // also shows hover state.
      btn.addEventListener('mouseleave', () => {
        // Only blur if this item is the active element AND the user is
        // using mouse (not keyboard). We detect "mouse user" by checking
        // if the focused item matches the one we're leaving.
        if (document.activeElement === btn) {
          // Defer blur slightly so a subsequent click still registers
          setTimeout(() => {
            if (document.activeElement === btn) btn.blur();
          }, 0);
        }
      });
    });
  }

  // _handleAction (async — awaits close before executing action)
  async function _handleAction(action, sourceBtn) {
    const trigger = _activeTrigger;

    await close();

    switch (action) {
      case 'edit-profile':
        await _openProfileEditor();
        break;
      case 'admin-panel':
        _navigateToAdmin();
        break;
      case 'logout':
        const loggedOut = await _doLogout();
        if (!loggedOut && trigger) {
          // Re-open at the ORIGINAL cursor position (not the trigger rect) —
          // otherwise the dropdown visually "jumps" when logout is cancelled.
          setTimeout(() => open(trigger, _origCursorX, _origCursorY), 120);
        }
        break;
    }
  }

  // Profile editor
  async function _openProfileEditor() {
    _bootstrapPEP();
    if (window.ProfileEditorPanel) {
      window.ProfileEditorPanel.open();
      return;
    }
    // Poll for PEP to load (max 2 seconds)
    await new Promise(resolve => {
      let tries = 0;
      const t = setInterval(() => {
        if (window.ProfileEditorPanel || ++tries > 20) {
          clearInterval(t);
          if (window.ProfileEditorPanel) {
            window.ProfileEditorPanel.open();
          }
          resolve();
        }
      }, 100);
    });
  }

  function _bootstrapPEP() {
    if (_ppeReady && window.ProfileEditorPanel) return;
    if (window.ProfileEditorPanel) {
      _initPEP();
      return;
    }
    if (document.getElementById('op-pep-script')) return;

    const s = document.createElement('script');
    s.id = 'op-pep-script';
    const navSrc = document.querySelector('script[src*="option-profile.js"]')?.src || '';
    let base;
    if (navSrc) {
      base = navSrc.replace(/option-profile\.js.*$/, '');
    } else {
      const authBase = window.Auth?.getBasePath?.() || '/';
      base = authBase + 'src/profile/';
    }
    s.src = base + 'editor-panel.js';
    s.defer = true;
    s.onload = () => { _initPEP(); };
    document.head.appendChild(s);
  }

  function _initPEP() {
    if (!window.ProfileEditorPanel || _ppeReady) return;
    // v0.819.0: workerBase no longer required — ProfileEditorPanel uses Supabase Storage directly.
    // Kept for backward compat (ignored if passed).
    window.ProfileEditorPanel.init({
      trigger: [],
      onSaved: (user) => {
        if (window.Auth) window.Auth.userData = user;
        window.dispatchEvent(new CustomEvent('op-profile-updated', { detail: user }));
        // Also dispatch pep-saved for backward compat with consumers listening to it
        window.dispatchEvent(new CustomEvent('pep-saved', { detail: user }));
      },
    });
    _ppeReady = true;
  }

  // Navigate
  function _navigateToAdmin() {
    const basePath = window.Auth?.getBasePath?.() || '/';
    // Admin panel lives at /pages/admin/index.html (not /admin/index.html —
    // the older path structure 404'd from this dropdown).
    const target = basePath + 'pages/admin/index.html';
    window.location.replace(target);
  }

  // Logout
  async function _doLogout() {
    if (!window.Auth?.authLogout) {
      console.warn('[OptionProfile] _doLogout: window.Auth.authLogout not available');
      return false;
    }
    try {
      const result = await window.Auth.authLogout();
      return result !== false;
    } catch (err) {
      console.error('[OptionProfile] _doLogout error:', err);
      return false;
    }
  }

  // Measure dropdown height (heavy — only call when content changes)
  function _measureHeight() {
    if (!_dropdown) return 0;
    const pw = Math.min(DROPDOWN_W, window.innerWidth - EDGE_PAD * 2);
    const prevTransition = _dropdown.style.transition;
    const prevWidth      = _dropdown.style.width;
    const prevLeft       = _dropdown.style.left;
    const prevVisibility = _dropdown.style.visibility;

    _dropdown.style.transition = 'none';
    _dropdown.style.width      = pw + 'px';
    _dropdown.style.left       = '-9999px';
    _dropdown.style.visibility = 'hidden';
    void _dropdown.offsetHeight;
    const ph = _dropdown.offsetHeight;

    _dropdown.style.transition = prevTransition;
    _dropdown.style.width      = prevWidth;
    _dropdown.style.left       = prevLeft;
    _dropdown.style.visibility = prevVisibility;

    return ph;
  }

  // Position dropdown: centers on cursor X, places it exactly above or below
  // cursor Y with a small GAP for the arrow. Below cursor wins if it fits;
  // otherwise above; otherwise whichever side has more space, clamped.
  //
  // The dropdown is position:fixed, so it stays at this viewport position
  // even when the page scrolls. No scroll listener — repositioning on scroll
  // would make the dropdown visually "jump" away from where the user clicked.
  function _position(useCursor = true) {
    if (!_dropdown) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = Math.min(DROPDOWN_W, vw - EDGE_PAD * 2);

    if (_cachedHeight === null) {
      _cachedHeight = _measureHeight();
    }
    const ph = _cachedHeight;

    // Determine anchor point. Prefer cursor (stored at open time); fall back
    // to trigger rect.
    let anchorX, anchorY;
    if (useCursor && _cursorX && _cursorY) {
      anchorX = _cursorX;
      anchorY = _cursorY;
    } else if (_activeTrigger) {
      const r = _activeTrigger.getBoundingClientRect();
      anchorX = r.left + r.width / 2;
      anchorY = r.bottom;
    } else {
      anchorX = vw / 2;
      anchorY = 60;
    }

    // Vertical placement: top edge GAP px below cursor (below) or bottom
    // edge GAP px above cursor (above). The arrow fills the GAP.
    let placeBelow = true;
    let top;

    const spaceBelow = vh - EDGE_PAD - anchorY;  // space from cursor to viewport bottom
    const spaceAbove = anchorY - EDGE_PAD;        // space from cursor to viewport top

    if (spaceBelow >= ph + GAP) {
      // Enough space below cursor → place BELOW
      top = anchorY + GAP;
      placeBelow = true;
    } else if (spaceAbove >= ph + GAP) {
      // Enough space above cursor → place ABOVE
      top = anchorY - GAP - ph;
      placeBelow = false;
    } else {
      // Neither fits perfectly — place on the side with more space, clamped
      if (spaceBelow >= spaceAbove) {
        placeBelow = true;
        // Place as far down as possible without going off-screen
        top = Math.max(anchorY + GAP, vh - EDGE_PAD - ph);
      } else {
        placeBelow = false;
        // Place as far up as possible without going off-screen
        top = Math.min(anchorY - GAP - ph, EDGE_PAD);
      }
    }

    // Horizontal placement: center dropdown on cursor X so the arrow
    // (which points at cursor X) appears centered. Clamp within viewport.
    let left = anchorX - pw / 2;
    left = Math.max(EDGE_PAD, Math.min(left, vw - pw - EDGE_PAD));

    _dropdown.style.top   = top + 'px';
    _dropdown.style.left  = left + 'px';
    _dropdown.style.width = pw + 'px';

    // Transform origin: scale from the anchor point so the open animation
    // feels like the dropdown grows from the cursor position.
    const originX = Math.max(0, Math.min(100, ((anchorX - left) / pw * 100)));
    const originY = placeBelow ? '0%' : '100%';
    _dropdown.style.transformOrigin = `${originX.toFixed(0)}% ${originY}`;

    // Position arrow toward anchor (cursor).
    _positionArrow(top, left, pw, ph, placeBelow, anchorX);
  }

  function _positionArrow(dropTop, dropLeft, dropWidth, dropHeight, placeBelow, anchorX) {
    // Arrow points at cursor X (clamped within dropdown width so it doesn't
    // overflow the rounded corners). When the dropdown is centered on the
    // cursor, arrowX = anchorX = dropdown center, so the arrow is centered.
    const arrowX = Math.max(dropLeft + 18, Math.min(anchorX, dropLeft + dropWidth - 18));

    if (placeBelow) {
      // Dropdown is BELOW cursor → arrow at top edge, pointing UP. Bottom
      // edge overlaps dropdown top by 1px for visual connection.
      _arrow.style.left = (arrowX - 8) + 'px';   // center 16px arrow on arrowX
      _arrow.style.top  = (dropTop - 7) + 'px';   // 8px tall arrow, 7px above dropdown top
      _arrow.classList.remove('op-above');
      _arrow.classList.add('op-below');
    } else {
      // Dropdown is ABOVE cursor → arrow at bottom edge, pointing DOWN. Top
      // edge overlaps dropdown bottom by 1px for visual connection.
      _arrow.style.left = (arrowX - 8) + 'px';
      _arrow.style.top  = (dropTop + dropHeight - 1) + 'px';  // 1px overlap with dropdown bottom
      _arrow.classList.remove('op-below');
      _arrow.classList.add('op-above');
    }
  }

  // Open
  async function open(triggerEl, cursorX, cursorY) {
    if (!_dropdown) _buildDOM();

    // If there's a pending close() Promise, resolve it immediately so
    // the pending _handleAction can proceed (its action will run, but
    // since we're now re-opening, the user clearly cancelled the close).
    if (_closeTimer) {
      clearTimeout(_closeTimer);
      _closeTimer = null;
    }
    if (_closeResolver) {
      _closeResolver();
      _closeResolver = null;
    }

    // Store active trigger and cursor position
    _activeTrigger = triggerEl || _cfg?.triggers?.[0] || null;

    // Save current focus so we can restore it on close
    _focusBeforeOpen = document.activeElement;

    // Use provided cursor coords, or fall back to trigger center
    if (typeof cursorX === 'number' && typeof cursorY === 'number') {
      _cursorX = cursorX;
      _cursorY = cursorY;
    } else if (_activeTrigger) {
      const r = _activeTrigger.getBoundingClientRect();
      _cursorX = r.left + r.width / 2;
      _cursorY = r.bottom;
    } else {
      _cursorX = window.innerWidth / 2;
      _cursorY = 60;
    }

    // Save original cursor position for re-open after logout cancel.
    // Only update if new cursor coords were EXPLICITLY provided (not fallback),
    // so _handleAction's re-open call lands at the exact same spot.
    if (typeof cursorX === 'number' && typeof cursorY === 'number') {
      _origCursorX = cursorX;
      _origCursorY = cursorY;
    }

    // Populate fresh content
    _populate();

    // Position before showing
    _position(true);

    // Attach outside-click handlers (replaces shade)
    _attachOutsideClickHandlers();

    // Show
    _dropdown.classList.remove('op-closing');
    _dropdown.setAttribute('aria-hidden', 'false');

    // Sync aria-expanded on the trigger
    if (_activeTrigger) {
      _activeTrigger.setAttribute('aria-expanded', 'true');
    }

    // Force reflow for animation
    void _dropdown.offsetHeight;

    _dropdown.classList.add('op-open');
    _arrow.classList.add('op-visible');

    _isOpen = true;

    // Announce to screen readers
    if (_liveRegion) {
      _liveRegion.textContent = 'Menu profil dibuka. Gunakan tombol panah untuk navigasi.';
    }

    // No auto-focus on first item — auto-focus caused a persistent
    // "stuck hover" ring on Edit Profile because focus doesn't follow the
    // mouse. Instead, focus the dropdown container itself so keyboard
    // events are captured without painting a focus state on any item.
    setTimeout(() => {
      if (_isOpen && _dropdown) {
        _dropdown.setAttribute('tabindex', '-1');
        // Only focus if the user isn't already interacting with mouse
        // (that is, activeElement is body or the trigger).
        const ae = document.activeElement;
        if (ae === document.body || ae === _activeTrigger) {
          _dropdown.focus({ preventScroll: true });
        }
      }
    }, 280);
  }

  // Close
  function close() {
    return new Promise((resolve) => {
      if (!_dropdown || !_isOpen) {
        resolve();
        return;
      }

      _dropdown.classList.add('op-closing');
      _dropdown.classList.remove('op-open');
      _arrow.classList.remove('op-visible');

      _dropdown.setAttribute('aria-hidden', 'true');

      if (_activeTrigger) {
        _activeTrigger.setAttribute('aria-expanded', 'false');
      }

      _isOpen = false;

      // Detach outside-click handlers (dropdown is closing)
      _detachOutsideClickHandlers();

      // Blur ALL items (not just :focus) to clear any stuck hover/focus
      // state. Some browsers (especially mobile) keep :hover applied to the
      // last-tapped item until the user taps elsewhere. Explicitly blurring
      // every item forces the browser to re-evaluate hover cleanly.
      _dropdown.querySelectorAll('[data-op]').forEach(item => {
        if (typeof item.blur === 'function') item.blur();
      });
      // Also blur the dropdown container itself (it may have focus from
      // the container-focus behavior in open()).
      if (_dropdown && typeof _dropdown.blur === 'function') {
        _dropdown.blur();
      }
      // Clean up any lingering ripple spans
      _dropdown.querySelectorAll('.op-ripple').forEach(r => r.remove());

      // Announce to screen readers
      if (_liveRegion) {
        _liveRegion.textContent = 'Menu profil ditutup.';
      }

      // Restore focus to the element that had it before open()
      if (_focusBeforeOpen && typeof _focusBeforeOpen.focus === 'function') {
        try { _focusBeforeOpen.focus(); } catch (_) {}
      }
      _focusBeforeOpen = null;

      // Store the resolver so open() can resolve it early if re-opened
      _closeResolver = resolve;

      // Cleanup after animation
      _closeTimer = setTimeout(() => {
        if (_dropdown) _dropdown.classList.remove('op-closing');
        _closeTimer = null;
        _closeResolver = null;
        resolve();
      }, CLOSE_ANIM_MS);
    });
  }

  // Toggle
  function toggle(triggerEl, cursorX, cursorY) {
    const now = Date.now();
    if (now - _lastToggleAt < TOGGLE_DEBOUNCE_MS) {
      return;
    }
    _lastToggleAt = now;

    if (_isOpen) {
      close();
    } else {
      open(triggerEl, cursorX, cursorY);
    }
  }

  // Update (refresh dropdown content if open)
  function update() {
    if (!_isOpen) return;
    _populate();
    _position(false);
  }

  // isOpen (check dropdown state)
  function isOpen() {
    return _isOpen;
  }

  // Destroy (teardown everything — for hot-reload / tests)
  function destroy() {
    if (_closeTimer) {
      clearTimeout(_closeTimer);
      _closeTimer = null;
    }
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    _detachOutsideClickHandlers();

    if (_arrow)     { _arrow.remove();     _arrow = null; }
    if (_dropdown)  { _dropdown.remove();  _dropdown = null; }
    if (_liveRegion){ _liveRegion.remove();_liveRegion = null; }

    const styles = document.getElementById('op-styles');
    if (styles) styles.remove();

    _isOpen = false;
    _activeTrigger = null;
    _initialized = false;
    _ppeReady = false;
    _cachedHeight = null;
    _cfg = null;
    _attachedTriggers = new WeakSet(); // reset
  }

  // Init. Idempotent — safe to call multiple times. Re-calls only add
  // new triggers (via addTrigger), never double-bind existing ones.
  function init(cfg) {
    _cfg = cfg || {};

    // v0.819.0: workerBase is now optional (ignored). Avatars use Supabase Storage directly.
    // No error if missing — backward compat with older callers that still pass it.

    _injectStyles();

    // If no explicit triggers, auto-detect common selectors
    const triggers = _cfg.triggers ||
      document.querySelectorAll(
        '.user-profile-content, .user-info-mobile, #userInfo, #userInfoChip'
      );

    const triggerArr = Array.isArray(triggers)
      ? triggers
      : triggers instanceof NodeList
        ? Array.from(triggers)
        : [triggers];

    if (!Array.isArray(_cfg.triggers)) {
      _cfg.triggers = [];
    }
    // Merge new triggers into _cfg.triggers
    triggerArr.forEach(el => {
      if (el && !_cfg.triggers.includes(el)) {
        _cfg.triggers.push(el);
      }
    });

    // Attach click handler to each trigger (idempotent via WeakSet).
    triggerArr.forEach(el => addTrigger(el));

    // Register global listeners ONCE.
    if (!_initialized) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _isOpen) close();
      });

      // Reposition on RESIZE only (not scroll). The dropdown is
      // position:fixed, so it stays at its initial viewport position when
      // the page scrolls. A scroll listener would re-anchor to the trigger
      // rect and cause a visible "jump" from the cursor-anchored position.
      //
      // On resize, reposition using the CURSOR coords so the dropdown stays
      // anchored to where the user originally clicked.
      const _repositionOnResize = () => {
        if (_isOpen) {
          if (_rafId) cancelAnimationFrame(_rafId);
          _rafId = requestAnimationFrame(() => {
            _position(true);  // use cursor, not trigger rect
            _rafId = null;
          });
        }
      };
      window.addEventListener('resize', () => {
        _cachedHeight = null;  // invalidate cache (responsive CSS may change height)
        _repositionOnResize();
      });
      // No scroll listener — dropdown stays at initial viewport position

      // Listen for profile updates from PEP / other sources
      window.addEventListener('pep-saved', (e) => {
        if (e.detail && window.Auth) window.Auth.userData = e.detail;
        update();
      });
      window.addEventListener('op-profile-updated', (e) => {
        if (e.detail && window.Auth) window.Auth.userData = e.detail;
        update();
      });

      _initialized = true;

      // Dispatch ready event — consumers (panel.js, navigasi.js,
      // ujian/index.html) can defer trigger attachment until this fires.
      document.dispatchEvent(new CustomEvent('option-profile-ready'));
    } else {
      // Already initialized — still dispatch ready for new consumers
      document.dispatchEvent(new CustomEvent('option-profile-ready'));
    }
  }

  // Public API to add a trigger at runtime.
  // Idempotent — calling addTrigger(el) multiple times with the same el
  // only binds the click handler ONCE.
  function addTrigger(el) {
    if (!el) return;
    if (_attachedTriggers.has(el)) return;
    _attachedTriggers.add(el);

    el.style.cursor = 'pointer';
    el.setAttribute('aria-haspopup', 'true');
    el.setAttribute('aria-expanded', 'false');

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle(el, e.clientX, e.clientY);
    });

    // Track in _cfg.triggers so external code can still query the list.
    if (_cfg) {
      if (!Array.isArray(_cfg.triggers)) _cfg.triggers = [];
      if (!_cfg.triggers.includes(el)) _cfg.triggers.push(el);
    }
  }

  // Public getter for triggers
  function getTriggers() {
    return _cfg?.triggers ? [..._cfg.triggers] : [];
  }

  // Public API
  global.OptionProfile = {
    init,
    open,
    close,
    toggle,
    addTrigger,
    getTriggers,
    isOpen,
    update,
    destroy,
  };

}(window));
