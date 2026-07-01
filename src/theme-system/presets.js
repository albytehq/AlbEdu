// =============================================================================
// theme-system/presets.js — 5 theme presets (Google Form-like quick picks)
// =============================================================================

export const PRESETS = [
  {
    id: 'default',
    name: 'AlbEdu Default',
    primary: '#2563eb',
    font: 'Plus Jakarta Sans',
    mode: 'auto',
  },
  {
    id: 'modern',
    name: 'Modern',
    primary: '#0f172a',
    font: 'Inter',
    mode: 'light',
  },
  {
    id: 'dark',
    name: 'Dark Pro',
    primary: '#3b82f6',
    font: 'Plus Jakarta Sans',
    mode: 'dark',
  },
  {
    id: 'focus',
    name: 'Focus',
    primary: '#059669',
    font: 'Plus Jakarta Sans',
    mode: 'light',
  },
  {
    id: 'school',
    name: 'School Custom',
    primary: '#7c3aed',
    font: 'Plus Jakarta Sans',
    mode: 'auto',
  },
];

// 8 quick-pick colors (Google Form-like)
export const QUICK_COLORS = [
  { hex: '#2563eb', name: 'Blue' },
  { hex: '#059669', name: 'Green' },
  { hex: '#dc2626', name: 'Red' },
  { hex: '#7c3aed', name: 'Purple' },
  { hex: '#ea580c', name: 'Orange' },
  { hex: '#d97706', name: 'Amber' },
  { hex: '#0f172a', name: 'Slate' },
  { hex: '#78350f', name: 'Brown' },
];

export function getPreset(id) {
  return PRESETS.find(p => p.id === id) || PRESETS[0];
}
