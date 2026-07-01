// =============================================================================
// theme-system/derive.js — Auto-derive color variants from primary color
// =============================================================================
// Input: hex color (e.g. "#2563eb")
// Output: { primary, primary_hover, primary_muted, primary_ring, ...fixed colors }
// =============================================================================

function hexToRgb(hex) {
  const cleaned = hex.replace('#', '');
  const full = cleaned.length === 3
    ? cleaned.split('').map(c => c + c).join('')
    : cleaned;
  const num = parseInt(full, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function darken(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

function lighten(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    r + (255 - r) * amount,
    g + (255 - g) * amount,
    b + (255 - b) * amount
  );
}

function withOpacity(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function deriveColors(primary) {
  return {
    // Derived from primary
    primary: primary,
    primary_hover: darken(primary, 0.10),
    primary_muted: lighten(primary, 0.90),
    primary_ring: withOpacity(primary, 0.20),

    // Fixed professional palette
    heading: '#0f172a',
    body: '#475569',
    surface: '#ffffff',
    surface_alt: '#f8fafc',
    border: '#e2e8f0',
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
  };
}

export { hexToRgb, rgbToHex, darken, lighten, withOpacity };
