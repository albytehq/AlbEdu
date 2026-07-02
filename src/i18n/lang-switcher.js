// =============================================================================
// lang-switcher.js — Universal language switcher bootstrap (v0.742.9)
// =============================================================================
// Auto-wires any `.albedu-lang-switcher` element on the page to the i18n
// system. Works on landing, admin pages, peserta pages, auth pages —
// anywhere the i18n module is loaded and a lang-switcher element exists.
//
// Behavior:
//   1. Click switcher → toggle dropdown visibility.
//   2. Click locale option → window.i18n.switchLocale(locale).
//   3. Click outside → close dropdown.
//   4. ESC → close dropdown.
//   5. On locale change → update #current-lang text + active option styling.
//
// This module is auto-loaded via `<script defer>` and runs on DOMContentLoaded.
// It's idempotent — safe to call multiple times (only wires once per element).
// =============================================================================

(function () {
  'use strict';

  const FLAG_MAP = {
    id: '🇮🇩',
    en: '🇬🇧',
    ru: '🇷🇺',
    es: '🇪🇸',
    zh: '🇨🇳',
  };

  const NAME_MAP = {
    id: 'ID',
    en: 'EN',
    ru: 'RU',
    es: 'ES',
    zh: 'ZH',
  };

  let _wired = false;

  function _getCurrentLocale() {
    return window.i18n?.getCurrentLocale?.() || 'id';
  }

  function _updateSwitcherUI(switcherEl, locale) {
    const currentSpan = switcherEl.querySelector('#current-lang');
    if (currentSpan) {
      const flag = FLAG_MAP[locale] || '🌐';
      const name = NAME_MAP[locale] || locale.toUpperCase();
      currentSpan.textContent = `${flag} ${name}`;
    }
    // Update active option styling
    const options = switcherEl.querySelectorAll('.albedu-lang-option');
    options.forEach(opt => {
      const optLocale = opt.getAttribute('data-locale');
      if (optLocale === locale) {
        opt.classList.add('albedu-active');
      } else {
        opt.classList.remove('albedu-active');
      }
    });
  }

  function _wireSwitcher(switcherEl) {
    if (switcherEl.dataset.wired === 'true') return;
    switcherEl.dataset.wired = 'true';

    const dropdown = switcherEl.querySelector('.albedu-lang-dropdown') ||
                     switcherEl.querySelector('#lang-dropdown');

    // Toggle on click
    switcherEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dropdown) {
        const isHidden = dropdown.hasAttribute('hidden');
        // Close all other open dropdowns first
        document.querySelectorAll('.albedu-lang-dropdown, #lang-dropdown').forEach(d => {
          if (d !== dropdown) d.setAttribute('hidden', '');
        });
        if (isHidden) {
          dropdown.removeAttribute('hidden');
        } else {
          dropdown.setAttribute('hidden', '');
        }
      }
    });

    // Option clicks
    const options = switcherEl.querySelectorAll('.albedu-lang-option');
    options.forEach(opt => {
      opt.addEventListener('click', async function (e) {
        e.stopPropagation();
        const locale = opt.getAttribute('data-locale');
        if (!locale) return;
        if (dropdown) dropdown.setAttribute('hidden', '');
        if (window.i18n?.switchLocale) {
          try {
            await window.i18n.switchLocale(locale);
            console.info('[lang-switcher] Switched to:', locale);
          } catch (err) {
            console.error('[lang-switcher] switchLocale failed:', err);
          }
        } else {
          console.warn('[lang-switcher] window.i18n.switchLocale not available');
        }
      });
    });

    // Initial UI sync
    _updateSwitcherUI(switcherEl, _getCurrentLocale());

    // Listen for locale changes (from other sources)
    document.addEventListener('locale-changed', function (e) {
      _updateSwitcherUI(switcherEl, e.detail?.locale || _getCurrentLocale());
    });
  }

  function _wireAll() {
    if (_wired) return;
    _wired = true;

    const switchers = document.querySelectorAll('.albedu-lang-switcher, #lang-switcher');
    switchers.forEach(_wireSwitcher);

    // Global click-outside → close all dropdowns
    document.addEventListener('click', function () {
      document.querySelectorAll('.albedu-lang-dropdown, #lang-dropdown').forEach(d => {
        d.setAttribute('hidden', '');
      });
    });

    // ESC → close all dropdowns
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.albedu-lang-dropdown, #lang-dropdown').forEach(d => {
          d.setAttribute('hidden', '');
        });
      }
    });

    console.info('[lang-switcher] Wired', switchers.length, 'switcher(s)');
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireAll);
  } else {
    _wireAll();
  }

  // Re-wire when i18n becomes ready (in case switchers were added after init)
  document.addEventListener('i18n-ready', _wireAll, { once: true });

  // Public API
  window.LangSwitcher = { wireAll: _wireAll, wireSwitcher: _wireSwitcher };
})();
