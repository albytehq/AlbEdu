// theme-system/injector.js — inject CSS custom properties into :root.
// Includes auto-fallback: if user-selected text_accent has poor contrast
// against the assessment surface, it's auto-adjusted to meet WCAG AA.

import { deriveColors } from './derive.js';
import { ensureContrast, contrastRatio } from './contrast.js';

export function injectTheme(theme) {
  const colors = deriveColors(theme.primary, theme.text_accent);
  const root = document.documentElement;

  // Auto-fallback: if text_accent has poor contrast (< 3.0 = WCAG AA large text)
  // against the surface, auto-adjust it to be readable.
  // This prevents admin from accidentally making titles invisible.
  let safeTextAccent = colors.text_accent;
  const surfaceBg = colors.surface; // '#ffffff' in light mode
  const minContrast = 3.0; // WCAG AA for large text (titles are 15-22px bold)
  if (contrastRatio(colors.text_accent, surfaceBg) < minContrast) {
    safeTextAccent = ensureContrast(colors.text_accent, surfaceBg, minContrast);
    console.warn('[theme] text_accent auto-adjusted for contrast:',
      colors.text_accent, '→', safeTextAccent,
      '(ratio was', contrastRatio(colors.text_accent, surfaceBg).toFixed(2),
      ', needed ≥', minContrast + ')');
  }

  // CSS Custom Properties
  root.style.setProperty('--albedu-primary', colors.primary);
  root.style.setProperty('--albedu-primary-hover', colors.primary_hover);
  root.style.setProperty('--albedu-primary-muted', colors.primary_muted);
  root.style.setProperty('--albedu-primary-ring', colors.primary_ring);
  root.style.setProperty('--albedu-text-accent', safeTextAccent);
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
    // Re-check text_accent contrast against dark surface
    const darkSurface = '#1e293b';
    if (contrastRatio(safeTextAccent, darkSurface) < minContrast) {
      safeTextAccent = ensureContrast(safeTextAccent, darkSurface, minContrast);
      root.style.setProperty('--albedu-text-accent', safeTextAccent);
      console.warn('[theme] text_accent re-adjusted for dark mode:', safeTextAccent);
    }
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
