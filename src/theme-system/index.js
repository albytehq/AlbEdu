// theme-system/index.js — Theme System public API.
// One primary color → auto-derive the rest.

import { deriveColors } from './derive.js';
import { validateTheme } from './validate.js';
import { PRESETS, QUICK_COLORS, getPreset } from './presets.js';
import { injectTheme } from './injector.js';

const ThemeSystem = {
  // Apply theme (inject CSS variables)
  apply(theme) {
    // Merge with defaults
    const merged = {
      version: '1.0',
      preset: theme.preset || 'default',
      primary: theme.primary || '#2563eb',
      font: theme.font || 'Plus Jakarta Sans',
      mode: theme.mode || 'auto',
      ...theme,
    };
    injectTheme(merged);
    return merged;
  },

  // Get current theme from CSS variables
  getCurrent() {
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue('--albedu-primary').trim() || '#2563eb',
      heading: style.getPropertyValue('--albedu-heading').trim() || '#0f172a',
      body: style.getPropertyValue('--albedu-body').trim() || '#475569',
    };
  },

  // Get available presets
  getPresets() {
    return PRESETS;
  },

  // Get quick-pick colors
  getQuickColors() {
    return QUICK_COLORS;
  },

  // Get specific preset by ID
  getPreset(id) {
    return getPreset(id);
  },

  // Validate theme (WCAG AA check)
  validate(primary) {
    return validateTheme(primary);
  },

  // Derive colors without applying
  derive(primary) {
    return deriveColors(primary);
  },

  // Reset to default
  reset() {
    this.apply({
      preset: 'default',
      primary: '#2563eb',
      font: 'Plus Jakarta Sans',
      mode: 'auto',
    });
  },
};

// Auto-init: listen for system dark mode changes
if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    // Re-apply current theme if in auto mode
    const root = document.documentElement;
    const mode = root.getAttribute('data-current-mode');
    if (mode === 'auto') {
      // Trigger re-injection
      const currentPrimary = getComputedStyle(root).getPropertyValue('--albedu-primary').trim();
      if (currentPrimary) {
        injectTheme({ primary: currentPrimary, font: 'Plus Jakarta Sans', mode: 'auto' });
      }
    }
  });
}

window.ThemeSystem = ThemeSystem;
export default ThemeSystem;
