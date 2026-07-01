// =============================================================================
// theme-system/injector.js — Inject CSS Custom Properties to :root
// =============================================================================

export function injectTheme(theme) {
  const colors = deriveColors(theme.primary);
  const root = document.documentElement;

  // CSS Custom Properties
  root.style.setProperty('--albedu-primary', colors.primary);
  root.style.setProperty('--albedu-primary-hover', colors.primary_hover);
  root.style.setProperty('--albedu-primary-muted', colors.primary_muted);
  root.style.setProperty('--albedu-primary-ring', colors.primary_ring);
  root.style.setProperty('--albedu-heading', colors.heading);
  root.style.setProperty('--albedu-body', colors.body);
  root.style.setProperty('--albedu-surface', colors.surface);
  root.style.setProperty('--albedu-surface-alt', colors.surface_alt);
  root.style.setProperty('--albedu-border', colors.border);
  root.style.setProperty('--albedu-success', colors.success);
  root.style.setProperty('--albedu-warning', colors.warning);
  root.style.setProperty('--albedu-danger', colors.danger);

  // Dark mode
  const mode = theme.mode || 'auto';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (mode === 'dark' || (mode === 'auto' && prefersDark)) {
    root.setAttribute('data-theme', 'dark');
    // Override surface colors for dark mode
    root.style.setProperty('--albedu-surface', '#1e293b');
    root.style.setProperty('--albedu-surface-alt', '#0f172a');
    root.style.setProperty('--albedu-heading', '#f1f5f9');
    root.style.setProperty('--albedu-body', '#cbd5e1');
    root.style.setProperty('--albedu-border', '#334155');
  } else {
    root.setAttribute('data-theme', 'light');
  }

  // Meta theme-color (browser UI)
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', colors.primary);
  }

  // Font
  root.style.setProperty('--albedu-font', `'${theme.font || 'Plus Jakarta Sans'}', system-ui, sans-serif`);
}

import { deriveColors } from './derive.js';
