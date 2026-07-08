// theme-system/validate.js — WCAG AA contrast validation.

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

import { hexToRgb } from './derive.js';

export function contrastRatio(foreground, background) {
  const fgL = relativeLuminance(foreground);
  const bgL = relativeLuminance(background);
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

export function validateTheme(primary) {
  const colors = deriveColors(primary);
  const checks = [
    { name: 'Primary on Surface', fg: colors.primary, bg: colors.surface, minRatio: 4.5 },
    { name: 'Surface on Primary (button text)', fg: colors.surface, bg: colors.primary, minRatio: 4.5 },
    { name: 'Body on Surface', fg: colors.body, bg: colors.surface, minRatio: 4.5 },
    { name: 'Heading on Surface', fg: colors.heading, bg: colors.surface, minRatio: 4.5 },
    { name: 'Primary on Primary Muted', fg: colors.primary, bg: colors.primary_muted, minRatio: 4.5 },
  ];

  const results = checks.map(c => {
    const ratio = contrastRatio(c.fg, c.bg);
    return {
      ...c,
      ratio: parseFloat(ratio.toFixed(2)),
      pass: ratio >= c.minRatio,
    };
  });

  const allPass = results.every(r => r.pass);
  return { results, allPass };
}

import { deriveColors } from './derive.js';
