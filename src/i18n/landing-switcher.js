// =============================================================================
// i18n/landing-switcher.js — AlbEdu Landing Language Switcher v1.0.0
// =============================================================================
//
//  Compact language switcher for landing page FOOTER.
//  Design contract:
//    - Inject globe icon + current lang code into .site-footer .footer-inner
//    - Click → dropdown with ID/EN options (mobile: flag emoji only)
//    - Position: bottom-right of footer (absolute), responsive
//    - Auto-detect existing language from I18n module
//    - Instant switch (no reload) — I18n.setLang handles DOM rescan
//    - CSP-friendly: no inline styles/scripts in HTML
//    - XSS-safe: all strings via I18n.t() + escapeAttr
//    - Accessible: aria-haspopup, aria-expanded, keyboard nav, focus trap
//
//  WHY footer (not navbar)?
//    - User clarification: footer is less intrusive, doesn't compete with
//      Login/Sign Up CTAs in navbar.
//    - Visitors who care about language will find it in footer (standard
//      pattern: Wikipedia, Apple, Google all put lang switcher in footer).
//
//  USAGE:
//    <script src="src/i18n/index.js" defer></script>
//    <script src="src/i18n/landing-switcher.js" defer></script>
//    <!-- Auto-injects into .site-footer .footer-inner on DOMContentLoaded -->
//
//  Notes:
//    - Only initializes if window.I18n exists. If not, warns + exits.
//    - Idempotent: calling init() twice is safe (no double-inject).
//    - If footer doesn't exist, exits silently (page may not be landing).
// =============================================================================

(function (global) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const SWITCHER_ID = 'albedu-lang-switcher';
  const DROPDOWN_ID = 'albedu-lang-dropdown';

  // Flag emoji for compact mobile display.
  // Using emoji instead of PNG/SVG to avoid asset loading.
  const FLAGS = {
    id: '🇮🇩',
    en: '🇬🇧',
  };

  const LANG_NAMES = {
    id: 'Bahasa Indonesia',
    en: 'English',
  };

  let _initialized = false;
  let _isOpen = false;
  let _trigger = null;
  let _dropdown = null;
  let _docClickHandler = null;

  // ── CSS (scoped, prefixed with albedu-ls-) ───────────────────────────────
  function _injectStyles() {
    if (document.getElementById('albedu-ls-styles')) return;
    const s = document.createElement('style');
    s.id = 'albedu-ls-styles';
    s.textContent = `
      .albedu-ls-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: inherit;
      }
      .albedu-ls-trigger {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.18);
        color: inherit;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 180ms ease, border-color 180ms ease;
        font-family: inherit;
        line-height: 1;
        white-space: nowrap;
      }
      .albedu-ls-trigger:hover {
        background: rgba(255,255,255,0.08);
        border-color: rgba(255,255,255,0.32);
      }
      .albedu-ls-trigger:focus-visible {
        outline: 2px solid #60a5fa;
        outline-offset: 2px;
      }
      .albedu-ls-trigger .albedu-ls-globe {
        font-size: 15px;
        line-height: 1;
      }
      .albedu-ls-trigger .albedu-ls-code {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .albedu-ls-trigger .albedu-ls-chevron {
        font-size: 14px;
        transition: transform 200ms ease;
        opacity: 0.7;
      }
      .albedu-ls-trigger[aria-expanded="true"] .albedu-ls-chevron {
        transform: rotate(180deg);
      }

      .albedu-ls-dropdown {
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        min-width: 180px;
        background: #ffffff;
        color: #1e293b;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 10px 32px rgba(15,23,42,0.14), 0 2px 6px rgba(15,23,42,0.06);
        padding: 6px;
        z-index: 100;
        opacity: 0;
        transform: translateY(8px) scale(0.97);
        transform-origin: bottom right;
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms cubic-bezier(0.22,1,0.36,1);
      }
      .albedu-ls-dropdown.albedu-ls-open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }
      .albedu-ls-option {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 9px 12px;
        background: transparent;
        border: 0;
        border-radius: 8px;
        color: #1e293b;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        text-align: left;
        transition: background 140ms ease;
        font-family: inherit;
      }
      .albedu-ls-option:hover {
        background: #f1f5f9;
      }
      .albedu-ls-option:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: -2px;
      }
      .albedu-ls-option[aria-current="true"] {
        background: #eff6ff;
        color: #2563eb;
      }
      .albedu-ls-option .albedu-ls-flag {
        font-size: 18px;
        line-height: 1;
      }
      .albedu-ls-option .albedu-ls-name {
        flex: 1;
      }
      .albedu-ls-option .albedu-ls-check {
        font-size: 16px;
        opacity: 0;
        color: #2563eb;
      }
      .albedu-ls-option[aria-current="true"] .albedu-ls-check {
        opacity: 1;
      }

      /* Mobile: compact — show only flag + 2-letter code */
      @media (max-width: 640px) {
        .albedu-ls-trigger .albedu-ls-globe { display: none; }
        .albedu-ls-trigger .albedu-ls-chevron { display: none; }
        .albedu-ls-dropdown {
          min-width: 150px;
          right: 0;
        }
      }

      /* Dark mode adjustment for footer context (footer is dark by default) */
      .albedu-ls-trigger.albedu-ls-dark {
        color: rgba(255,255,255,0.85);
      }

      /* Reduced motion */
      @media (prefers-reduced-motion: reduce) {
        .albedu-ls-trigger,
        .albedu-ls-dropdown,
        .albedu-ls-trigger .albedu-ls-chevron {
          transition-duration: 0.01ms !important;
        }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Build trigger button ──────────────────────────────────────────────────
  function _buildTrigger() {
    const currentLang = global.I18n?.getLang() || 'id';
    const flag = FLAGS[currentLang] || FLAGS.id;
    const code = currentLang.toUpperCase();

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'albedu-ls-trigger';
    trigger.id = SWITCHER_ID;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', global.I18n?.t('lang.switch') || 'Switch Language');

    trigger.innerHTML = `
      <span class="albedu-ls-globe" aria-hidden="true">🌐</span>
      <span class="albedu-ls-flag" aria-hidden="true">${flag}</span>
      <span class="albedu-ls-code">${code}</span>
      <span class="albedu-ls-chevron material-symbols-outlined" aria-hidden="true">expand_more</span>
    `;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      _toggle();
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        _open();
        // Focus first option
        setTimeout(() => {
          const first = _dropdown?.querySelector('.albedu-ls-option');
          first?.focus();
        }, 50);
      }
    });

    return trigger;
  }

  // ── Build dropdown ────────────────────────────────────────────────────────
  function _buildDropdown() {
    const dropdown = document.createElement('div');
    dropdown.className = 'albedu-ls-dropdown';
    dropdown.id = DROPDOWN_ID;
    dropdown.setAttribute('role', 'listbox');
    dropdown.setAttribute('aria-label', global.I18n?.t('lang.switch') || 'Switch Language');

    const currentLang = global.I18n?.getLang() || 'id';
    const allowedLangs = global.I18n?.ALLOWED_LANGS || ['id', 'en'];

    dropdown.innerHTML = allowedLangs.map((lang) => {
      const isCurrent = lang === currentLang;
      const flag = FLAGS[lang] || '';
      const name = LANG_NAMES[lang] || lang;
      return `
        <button type="button"
                class="albedu-ls-option"
                role="option"
                aria-selected="${isCurrent}"
                aria-current="${isCurrent}"
                data-lang="${lang}">
          <span class="albedu-ls-flag" aria-hidden="true">${flag}</span>
          <span class="albedu-ls-name">${name}</span>
          <span class="albedu-ls-check material-symbols-outlined" aria-hidden="true">check</span>
        </button>
      `;
    }).join('');

    // Wire click handlers
    dropdown.querySelectorAll('.albedu-ls-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const lang = opt.getAttribute('data-lang');
        if (lang) {
          global.I18n?.setLang(lang);
          _close();
          _refreshTrigger();
          _refreshDropdown();
        }
      });

      opt.addEventListener('keydown', (e) => {
        const opts = Array.from(dropdown.querySelectorAll('.albedu-ls-option'));
        const idx = opts.indexOf(opt);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = (idx + 1) % opts.length;
          opts[next].focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = (idx - 1 + opts.length) % opts.length;
          opts[prev].focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _close();
          _trigger?.focus();
        } else if (e.key === 'Home') {
          e.preventDefault();
          opts[0].focus();
        } else if (e.key === 'End') {
          e.preventDefault();
          opts[opts.length - 1].focus();
        }
      });
    });

    return dropdown;
  }

  // ── Open / close / toggle ─────────────────────────────────────────────────
  function _open() {
    if (_isOpen) return;
    _isOpen = true;
    _dropdown?.classList.add('albedu-ls-open');
    _trigger?.setAttribute('aria-expanded', 'true');
    _attachOutsideClick();
  }

  function _close() {
    if (!_isOpen) return;
    _isOpen = false;
    _dropdown?.classList.remove('albedu-ls-open');
    _trigger?.setAttribute('aria-expanded', 'false');
    _detachOutsideClick();
  }

  function _toggle() {
    if (_isOpen) _close();
    else _open();
  }

  // ── Outside click handler ─────────────────────────────────────────────────
  function _attachOutsideClick() {
    if (_docClickHandler) return;
    _docClickHandler = (e) => {
      if (!_isOpen) return;
      // Click inside wrap → let inner handler take over
      const wrap = _trigger?.parentElement;
      if (wrap && wrap.contains(e.target)) return;
      _close();
    };
    document.addEventListener('click', _docClickHandler, true);
    document.addEventListener('touchstart', _docClickHandler, { passive: true, capture: true });
  }

  function _detachOutsideClick() {
    if (!_docClickHandler) return;
    document.removeEventListener('click', _docClickHandler, true);
    document.removeEventListener('touchstart', _docClickHandler, true);
    _docClickHandler = null;
  }

  // ── Refresh trigger + dropdown on language change ─────────────────────────
  function _refreshTrigger() {
    if (!_trigger) return;
    const currentLang = global.I18n?.getLang() || 'id';
    const flag = FLAGS[currentLang] || FLAGS.id;
    const code = currentLang.toUpperCase();
    const flagEl = _trigger.querySelector('.albedu-ls-flag');
    const codeEl = _trigger.querySelector('.albedu-ls-code');
    if (flagEl) flagEl.textContent = flag;
    if (codeEl) codeEl.textContent = code;
    // Update aria-label
    _trigger.setAttribute('aria-label', global.I18n?.t('lang.switch') || 'Switch Language');
  }

  function _refreshDropdown() {
    if (!_dropdown) return;
    const currentLang = global.I18n?.getLang() || 'id';
    _dropdown.querySelectorAll('.albedu-ls-option').forEach((opt) => {
      const lang = opt.getAttribute('data-lang');
      const isCurrent = lang === currentLang;
      opt.setAttribute('aria-selected', isCurrent);
      opt.setAttribute('aria-current', isCurrent);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    if (!global.I18n) {
      console.warn('[LandingSwitcher] I18n module not loaded. Skipping init.');
      return;
    }

    _injectStyles();

    // Find footer container
    // Priority: .site-footer .footer-inner → .site-footer → fallback: skip
    const footerInner = document.querySelector('.site-footer .footer-inner')
                     || document.querySelector('.site-footer');

    if (!footerInner) {
      // Not a landing page — exit silently (this script is landing-only)
      return;
    }

    // Build trigger + dropdown
    _trigger = _buildTrigger();
    _dropdown = _buildDropdown();

    // Wrap them together for outside-click detection
    const wrap = document.createElement('div');
    wrap.className = 'albedu-ls-wrap';
    wrap.appendChild(_trigger);
    wrap.appendChild(_dropdown);

    // Insert into footer — appended to end so it appears on the right
    footerInner.appendChild(wrap);

    // Listen for language changes from OTHER sources (OptionProfile, etc.)
    global.I18n.onChanged(() => {
      _refreshTrigger();
      _refreshDropdown();
    });

    // Close on Escape (global)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _isOpen) {
        _close();
        _trigger?.focus();
      }
    });

    // Close on window blur / page hide
    window.addEventListener('blur', () => { if (_isOpen) _close(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && _isOpen) _close();
    });

    _initialized = true;
  }

  // ── Auto-init on DOMContentLoaded ─────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ── Public API (for testing / manual mount) ───────────────────────────────
  global.LandingLangSwitcher = {
    init,
    open:  _open,
    close: _close,
    toggle: _toggle,
    isOpen: () => _isOpen,
  };

}(window));
