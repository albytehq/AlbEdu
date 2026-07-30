// theme-system/injector.js — inject CSS custom properties into :root.
// Includes smart auto-fallback: if user-selected text_accent has poor
// contrast against the assessment surface, it's auto-adjusted to meet
// WCAG AA (4.5:1 for normal text).
//
// Smart fallback strategy:
//   - If text_accent is VERY LIGHT (luminance > 0.7): skip gradual
//     darkening (produces muddy mid-tones). Fall back directly to
//     --albedu-heading (guaranteed readable dark color).
//   - If text_accent is medium: try gradual darkening/lightening.
//   - If text_accent is VERY DARK in dark mode: fall back to
//     --albedu-heading (light in dark mode).
//   - Primary color: if too light for gradient banner, warn (white
//     text on light gradient = invisible).

import { deriveColors } from './derive.js';
import { ensureContrast, contrastRatio } from './contrast.js';

// WCAG AA threshold for normal text (labels, body text, etc.)
const MIN_CONTRAST_NORMAL = 4.5;
// Luminance threshold: above this, a color is "very light" and
// gradual darkening produces ugly muddy tones — better to fall back.
const VERY_LIGHT_LUMINANCE = 0.7;
const VERY_DARK_LUMINANCE = 0.15;

function relativeLuminance(hex) {
  const { r, g, b } = (() => {
    const c = hex.replace('#', '');
    const f = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
    const n = parseInt(f, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  })();
  const toLinear = (c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function injectTheme(theme) {
  const colors = deriveColors(theme.primary, theme.text_accent);
  const root = document.documentElement;

  // ── Smart auto-fallback for PRIMARY color ──
  // Primary is used for: buttons (white text on primary bg), active tabs
  // (primary text on white bg), badges (primary text on primary-muted bg),
  // gradient banner (white text on primary gradient).
  //
  // If primary is too light:
  //   - White text on primary buttons becomes invisible
  //   - Primary text on white active-tab bg becomes invisible
  //   - White text on gradient banner becomes invisible
  //
  // Fix: if white-on-primary contrast < 3.0 (WCAG AA large text), darken
  // primary until white text is readable on it.
  let safePrimary = colors.primary;
  const whiteOnPrimaryRatio = contrastRatio('#ffffff', safePrimary);
  if (whiteOnPrimaryRatio < 3.0) {
    const oldPrimary = safePrimary;
    safePrimary = ensureContrast(safePrimary, '#ffffff', 3.0);
    // Re-derive the dependent colors from the safe primary
    const safeDerived = deriveColors(safePrimary, colors.text_accent);
    colors.primary = safeDerived.primary;
    colors.primary_hover = safeDerived.primary_hover;
    colors.primary_muted = safeDerived.primary_muted;
    colors.primary_ring = safeDerived.primary_ring;
    console.warn('[theme] primary too light — auto-darkened:',
      oldPrimary, '→', colors.primary,
      '(white-on-primary ratio was', whiteOnPrimaryRatio.toFixed(2),
      ', needed ≥ 3.0)');
  }

  // ── Smart auto-fallback for text_accent ──
  let safeTextAccent = colors.text_accent;
  const surfaceBg = colors.surface; // '#ffffff' light, '#1e293b' dark
  const surfaceLum = relativeLuminance(surfaceBg);
  const accentLum = relativeLuminance(safeTextAccent);
  const isLightSurface = surfaceLum > 0.5;

  const currentRatio = contrastRatio(safeTextAccent, surfaceBg);
  if (currentRatio < MIN_CONTRAST_NORMAL) {
    // Contrast insufficient — need to adjust
    if (isLightSurface && accentLum > VERY_LIGHT_LUMINANCE) {
      // Very light color on light surface → gradual darkening produces
      // muddy tones. Fall back directly to heading color (guaranteed dark).
      safeTextAccent = colors.heading;
      console.warn('[theme] text_accent too light for white card —',
        'fell back to heading color:', colors.text_accent, '→', safeTextAccent,
        '(ratio was', currentRatio.toFixed(2), ', needed ≥', MIN_CONTRAST_NORMAL + ')');
    } else if (!isLightSurface && accentLum < VERY_DARK_LUMINANCE) {
      // Very dark color on dark surface → fall back to heading (light in dark mode)
      safeTextAccent = colors.heading;
      console.warn('[theme] text_accent too dark for dark surface —',
        'fell back to heading color:', safeTextAccent);
    } else {
      // Medium color — try gradual adjustment
      safeTextAccent = ensureContrast(safeTextAccent, surfaceBg, MIN_CONTRAST_NORMAL);
      console.warn('[theme] text_accent auto-adjusted for contrast:',
        colors.text_accent, '→', safeTextAccent,
        '(ratio was', currentRatio.toFixed(2), ', needed ≥', MIN_CONTRAST_NORMAL + ')');
    }
  }

  // ── Primary color check for gradient banner ──
  // The identity-banner uses linear-gradient(primary → primary-hover) with
  // white text. If primary is too light, white text becomes invisible.
  // (Already auto-corrected above via safePrimary — this is just a
  // secondary warning if the auto-corrected primary is STILL too light.)
  const postSafePrimaryRatio = contrastRatio('#ffffff', colors.primary);
  if (postSafePrimaryRatio < MIN_CONTRAST_NORMAL) {
    console.warn('[theme] primary still light after auto-adjust —',
      'white text on gradient banner may be hard to read on', colors.primary,
      '(ratio:', postSafePrimaryRatio.toFixed(2), ')');
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
    root.style.setProperty('--albedu-surface', '#1e293b');
    root.style.setProperty('--albedu-surface-alt', '#0f172a');
    root.style.setProperty('--albedu-heading', '#f1f5f9');
    root.style.setProperty('--albedu-body', '#cbd5e1');
    root.style.setProperty('--albedu-border', '#334155');
    // Re-check text_accent against dark surface
    const darkSurface = '#1e293b';
    const darkRatio = contrastRatio(safeTextAccent, darkSurface);
    if (darkRatio < MIN_CONTRAST_NORMAL) {
      const darkAccentLum = relativeLuminance(safeTextAccent);
      if (darkAccentLum < VERY_DARK_LUMINANCE) {
        // Too dark for dark surface → fall back to light heading
        safeTextAccent = '#f1f5f9';
      } else {
        safeTextAccent = ensureContrast(safeTextAccent, darkSurface, MIN_CONTRAST_NORMAL);
      }
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
