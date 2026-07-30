// theme-system/contrast.js — adaptive text color utilities.
//
// Provides:
//   - contrastRatio(fg, bg): WCAG contrast ratio between two hex colors
//   - ensureContrast(fg, bg, minRatio): auto-adjust fg until contrast met
//   - getReadableOnSurface(bg): returns '#fff' or '#000' based on luminance
//   - isSafeContrast(fg, bg, minRatio): boolean check
//
// Used by injector.js to auto-fallback text_accent if user picks
// a color with poor contrast against the assessment surface.

import { hexToRgb, rgbToHex, darken, lighten } from './derive.js';

/**
 * Calculate WCAG 2.1 contrast ratio between two hex colors.
 * @param {string} fg - foreground hex (e.g. '#2563eb')
 * @param {string} bg - background hex (e.g. '#ffffff')
 * @returns {number} contrast ratio (1.0 = no contrast, 21.0 = max)
 */
export function contrastRatio(fg, bg) {
  const lum = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    const toLinear = (c) => {
      const srgb = c / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  };
  const fgL = lum(fg);
  const bgL = lum(bg);
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if fg has sufficient contrast against bg.
 * @param {string} fg - foreground hex
 * @param {string} bg - background hex
 * @param {number} minRatio - minimum WCAG ratio (4.5 for normal text, 3.0 for large text)
 * @returns {boolean}
 */
export function isSafeContrast(fg, bg, minRatio = 4.5) {
  return contrastRatio(fg, bg) >= minRatio;
}

/**
 * Auto-adjust a foreground color until it meets the minimum contrast
 * ratio against the given background. Darkens if fg is too light,
 * lightens if fg is too dark.
 *
 * @param {string} fgHex - original foreground hex
 * @param {string} bgHex - background hex
 * @param {number} minRatio - target contrast ratio (default 4.5 = WCAG AA)
 * @param {number} maxSteps - max adjustment iterations (default 10)
 * @returns {string} adjusted hex that meets minRatio, or original if already safe
 */
export function ensureContrast(fgHex, bgHex, minRatio = 4.5, maxSteps = 10) {
  // Already safe? Return as-is.
  if (contrastRatio(fgHex, bgHex) >= minRatio) return fgHex;

  // Determine direction: if bg is light, darken fg; if bg is dark, lighten fg.
  const { r, g, b } = hexToRgb(bgHex);
  const bgLum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const isLightBg = bgLum > 0.5;

  let adjusted = fgHex;
  for (let i = 0; i < maxSteps; i++) {
    if (isLightBg) {
      // Darken the color to increase contrast against light bg
      adjusted = darken(adjusted, 0.10);
    } else {
      // Lighten the color to increase contrast against dark bg
      adjusted = lighten(adjusted, 0.10);
    }
    if (contrastRatio(adjusted, bgHex) >= minRatio) {
      return adjusted;
    }
  }

  // If we still can't reach minRatio after maxSteps, return the best attempt
  return adjusted;
}

/**
 * Return the most readable text color ('#ffffff' or '#000000') for
 * a given background. Uses relative luminance threshold.
 *
 * @param {string} bgHex - background hex
 * @returns {string} '#ffffff' or '#000000'
 */
export function getReadableOnSurface(bgHex) {
  const { r, g, b } = hexToRgb(bgHex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}
