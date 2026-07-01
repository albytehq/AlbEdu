# THEME SYSTEM — Google Form-Like, Production-Grade

> AlbEdu v1.0.0 theme system: 1 primary color → auto-derive everything.
> Simplicity of Google Form, quality of enterprise design system.

---

## 1. Design Philosophy

**Owner directive (Q13):**
> "Pastikan kemudahannya itu kayak Ngatur tema Google Form, tapi kualitas UI nya bagus banget"

**Principles:**
1. **1 input, many outputs** — admin picks 1 primary color, system derives 10+ variants
2. **Live preview** — admin sees changes instantly
3. **WCAG AA auto-check** — warning if contrast fails (not blocking)
4. **5 presets** — quick-start for non-technical admins
5. **Dark mode** — 1 toggle (auto/light/dark)
6. **No per-field manual picker** — removed CU/HJ/TW manual pickers (too complex)

---

## 2. Theme Schema

```json
{
  "version": "1.0",
  "preset": "default",
  "primary": "#2563eb",
  "font": "Plus Jakarta Sans",
  "mode": "auto"
}
```

**Fields:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `version` | string | Yes | "1.0" | Schema version for migration |
| `preset` | string | No | "default" | Preset name: default, modern, dark, focus, school |
| `primary` | string (hex) | Yes | "#2563eb" | Primary accent color |
| `font` | string | No | "Plus Jakarta Sans" | Font family |
| `mode` | string | No | "auto" | auto, light, dark |

**Auto-derived (not stored, computed client-side):**
- `primary_hover` — darken 10%
- `primary_muted` — lighten 90%
- `heading` — fixed #0f172a (slate-900)
- `body` — fixed #475569 (slate-600)
- `surface` — fixed #ffffff (white)
- `surface_alt` — fixed #f8fafc (slate-50)
- `border` — fixed #e2e8f0 (slate-200)
- `success` — fixed #10b981
- `warning` — fixed #f59e0b
- `danger` — fixed #ef4444

---

## 3. Presets

| Preset | Primary | Font | Mode | Use Case |
|---|---|---|---|---|
| **Default** | `#2563eb` (AlbEdu blue) | Plus Jakarta Sans | auto | Default for all assessments |
| **Modern** | `#0f172a` (slate-900) | Inter | light | Minimalist, professional |
| **Dark** | `#3b82f6` (blue-500) | Plus Jakarta Sans | dark | Dark mode preference |
| **Focus** | `#059669` (emerald-600) | Plus Jakarta Sans | light | Minim distraction (green calm) |
| **School** | configurable | configurable | configurable | Per-school custom (future SCloud) |

**Preset application:**
```js
ThemeSystem.apply({ preset: 'dark' });
// Equivalent to: { primary: '#3b82f6', font: 'Plus Jakarta Sans', mode: 'dark' }
```

---

## 4. Quick-Pick Colors (8 presets)

For admins who don't want to use color picker:

| Color | Hex | Name |
|---|---|---|
| 🔵 Blue | `#2563eb` | AlbEdu Default |
| 🟢 Green | `#059669` | Focus |
| 🔴 Red | `#dc2626` | Alert |
| 🟣 Purple | `#7c3aed` | Creative |
| 🟠 Orange | `#ea580c` | Energetic |
| 🟡 Amber | `#d97706` | Warm |
| ⚫ Slate | `#0f172a` | Modern |
| 🟤 Brown | `#78350f` | Earthy |

---

## 5. Auto-Derive Logic

```js
// src/theme-system/derive.js

function deriveColors(primary) {
  return {
    primary:          primary,
    primary_hover:    darken(primary, 0.10),   // 10% darker
    primary_muted:    lighten(primary, 0.90),  // 90% lighter (tint)
    primary_ring:     `${primary}33`,           // 20% opacity for focus ring
    // Fixed (professional palette)
    heading:          '#0f172a',
    body:             '#475569',
    surface:          '#ffffff',
    surface_alt:      '#f8fafc',
    border:           '#e2e8f0',
    success:          '#10b981',
    warning:          '#f59e0b',
    danger:           '#ef4444',
  };
}

function darken(hex, amount) {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    Math.round(rgb.r * (1 - amount)),
    Math.round(rgb.g * (1 - amount)),
    Math.round(rgb.b * (1 - amount))
  );
}

function lighten(hex, amount) {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    Math.round(rgb.r + (255 - rgb.r) * amount),
    Math.round(rgb.g + (255 - rgb.g) * amount),
    Math.round(rgb.b + (255 - rgb.b) * amount)
  );
}
```

---

## 6. WCAG AA Validation

```js
// src/theme-system/validate.js

function validateContrast(foreground, background) {
  const fgLuminance = relativeLuminance(foreground);
  const bgLuminance = relativeLuminance(background);
  const ratio = (Math.max(fgLuminance, bgLuminance) + 0.05) /
                (Math.min(fgLuminance, bgLuminance) + 0.05);
  return {
    ratio: parseFloat(ratio.toFixed(2)),
    pass: ratio >= 4.5,  // WCAG AA normal text
    passLarge: ratio >= 3.0,  // WCAG AA large text
  };
}

function validateTheme(theme) {
  const colors = deriveColors(theme.primary);
  const checks = [
    { name: 'Primary on Surface', fg: colors.primary, bg: colors.surface },
    { name: 'Body on Surface', fg: colors.body, bg: colors.surface },
    { name: 'Heading on Surface', fg: colors.heading, bg: colors.surface },
    { name: 'Surface on Primary (button text)', fg: colors.surface, bg: colors.primary },
  ];
  return checks.map(c => ({ ...c, ...validateContrast(c.fg, c.bg) }));
}
```

**UI behavior:**
- If any check fails (ratio < 4.5): show warning "⚠ Kombinasi warna ini mungkin sulit dibaca. Coba warna lebih gelap."
- NOT blocking — admin can still save
- Auto-suggest darker alternative

---

## 7. CSS Variable Injection

```js
// src/theme-system/injector.js

function injectTheme(theme) {
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
  if (theme.mode === 'dark' ||
      (theme.mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }

  // Meta theme-color (browser UI)
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colors.primary);

  // Font
  root.style.setProperty('--albedu-font', theme.font);
}
```

---

## 8. UI — Theme Editor (in Create Assessment Step 1)

```
┌─ Tema Asesmen ──────────────────────────────────────┐
│                                                      │
│  Template:                                           │
│  [● Default] [○ Modern] [○ Dark] [○ Focus] [○ School]│
│                                                      │
│  Warna Utama:                                        │
│  [●][●][●][●][●][●][●][●]   [🎨 Custom]             │
│   B  G  R  P  O  A  S  Br                            │
│                                                      │
│  Font: [Plus Jakarta Sans ▾]                         │
│                                                      │
│  Mode: [Auto (sistem) ▾]                             │
│                                                      │
│  ┌─ Live Preview ───────────────────────────────┐   │
│  │                                                │   │
│  │  Judul Asesmen                                 │   │
│  │  ─────────────                                 │   │
│  │                                                │   │
│  │  Pertanyaan: Berapakah 7 × 8?                  │   │
│  │                                                │   │
│  │  ○ A. 54                                       │   │
│  │  ○ B. 56                                       │   │
│  │  ○ C. 58                                       │   │
│  │  ○ D. 64                                       │   │
│  │                                                │   │
│  │  [ Mulai Asesmen ]                             │   │
│  │                                                │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ✓ WCAG AA: Contrast 7.2:1 (Pass)                   │
│  [Reset ke Default]                                  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Admin clicks:** 3-4 (preset or color / preview / save). 30 seconds total.

---

## 9. Theme Application — Peserta Side

When peserta loads assessment:

```js
// In take-assessment.js
const assessment = await fetchAssessment(accessCode);
ThemeSystem.apply(assessment.theme_config);
// CSS variables injected → entire UI updates instantly
```

**No rebuild needed.** Theme stored as JSONB in `assessments.theme_config`, injected as CSS Custom Properties at runtime.

---

## 10. Migration from v0.2.0 (CU/HJ/TW)

**Legacy schema:**
```json
{
  "tema": "default",
  "CU": "#2563eb",   // Card Ujian
  "HJ": "#0f172a",   // Header Judul
  "TW": null          // Teks Warna (?)
}
```

**Migration logic (in migration 014):**
```sql
jsonb_build_object(
  'version', '1.0',
  'preset', 'default',
  'primary', COALESCE(u.ujian->'theme'->>'CU', '#2563eb'),
  'heading', u.ujian->'theme'->>'HJ',
  'body', u.ujian->'theme'->>'TW',
  'font', 'Plus Jakarta Sans',
  'mode', 'auto'
)
```

- `CU` → `primary` (if set, else default #2563eb)
- `HJ` → ignored (auto-derived from primary now)
- `TW` → ignored (auto-derived from primary now)

**Legacy themes are lost** (HJ/TW customizations) — admin must re-set in new theme editor. Acceptable trade-off for simplicity.

---

## 11. API Reference

```js
// Apply theme (injects CSS variables)
window.ThemeSystem.apply({
  preset: 'default',     // or null for custom
  primary: '#2563eb',
  font: 'Plus Jakarta Sans',
  mode: 'auto'           // 'auto' | 'light' | 'dark'
});

// Get current theme
window.ThemeSystem.getCurrent();

// Get available presets
window.ThemeSystem.getPresets();

// Validate theme (returns WCAG check results)
window.ThemeSystem.validate({
  primary: '#2563eb'
});
// Returns: [{ name: 'Primary on Surface', ratio: 7.2, pass: true }, ...]

// Derive colors (without applying)
window.ThemeSystem.derive('#2563eb');
// Returns: { primary, primary_hover, primary_muted, heading, body, ... }

// Reset to default
window.ThemeSystem.reset();
```

---

## 12. File Structure

```
src/theme-system/
├── index.js          # Public API (apply, getCurrent, getPresets, validate, reset)
├── presets.js        # 5 preset definitions
├── derive.js         # Auto-derive hover/muted/ring from primary
├── validate.js       # WCAG AA contrast check
└── injector.js       # CSS Custom Properties injection
```

---

**Document version:** 1.0.0
**Last updated:** 2026-06-30
