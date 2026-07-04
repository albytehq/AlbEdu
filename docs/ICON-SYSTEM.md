# AlbEdu Icon System (v6.0 Enterprise)

> Enterprise-grade icon system built on **Lucide Icons** (ISC license).
> Used by Vercel, shadcn/ui, Cal.com, Linear, and other top-tier SaaS products.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ First Paint (0ms)                                               │
├─────────────────────────────────────────────────────────────────┤
│ 1. critical-css.js injects inline SVG sprite (5 critical icons) │
│ 2. <link rel="preload"> starts fetching icons.js immediately    │
│ 3. Critical icons render via <use href="#i-..."> (instant)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ DOM Ready + icons.js loaded (~30ms)                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. bindIcons() runs via requestIdleCallback                     │
│ 2. Visible icons: bound immediately (synchronous)               │
│ 3. Off-screen icons: deferred via IntersectionObserver          │
│ 4. MutationObserver watches for dynamic content (auto-bind)     │
│ 5. Metrics collected (render count, missing icons, errors)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ User scrolls / dynamic content added                            │
├─────────────────────────────────────────────────────────────────┤
│ 1. IntersectionObserver fires → bind off-screen icons           │
│ 2. MutationObserver fires → bind newly added icons              │
│ 3. requestAnimationFrame batches DOM updates (no layout thrash) │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Page hide / bfcache                                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. pagehide event → disconnect observers (prevent memory leaks) │
│ 2. pageshow (persisted) → re-init observers (bfcache restore)   │
└─────────────────────────────────────────────────────────────────┘
```

## Public API

### `AlbEdu.icon(name, opts?)` → `string`

Render an icon as an HTML string. **Never throws** — returns a fallback placeholder on error.

```javascript
// Basic
AlbEdu.icon('login')
// → '<svg class="albedu-icon" viewBox="0 0 24 24" ...>...</svg>'

// With size
AlbEdu.icon('login', { size: 20 })

// With class + ARIA label
AlbEdu.icon('login', { class: 'nav-icon', 'aria-label': 'Log in' })

// Custom stroke width
AlbEdu.icon('home', { strokeWidth: 1.5 })

// Disable fallback (return empty string if missing)
AlbEdu.icon('maybe-missing', { fallback: false })
```

### `AlbEdu.setIcon(el, name, opts?)`

Set an icon on an existing DOM element. Mutates `innerHTML`.

```javascript
const el = document.getElementById('myIcon')
AlbEdu.setIcon(el, 'login', { size: 24 })
```

### `AlbEdu.bindIcons(root?)`

Bind all `[data-albedu-icon]` elements in root. Returns bind counts.

```javascript
// Bind all icons in document
AlbEdu.bindIcons(document)

// Bind icons in a specific container (after AJAX)
AlbEdu.bindIcons(document.getElementById('modal-content'))
```

**Note:** You rarely need to call this manually — MutationObserver auto-binds dynamic content.

### `AlbEdu.registerIcon(name, svgPath)`

Register a custom icon at runtime.

```javascript
AlbEdu.registerIcon('my-logo', '<circle cx="12" cy="12" r="10"/>')
// Now: <span data-albedu-icon="my-logo"></span> works
```

### `AlbEdu.hasIcon(name)` → `boolean`

Check if an icon exists (resolves aliases).

```javascript
if (AlbEdu.hasIcon('login')) { /* ... */ }
```

### `AlbEdu.listIcons()` → `string[]`

List all registered icon names (registry + aliases), sorted.

### `AlbEdu.getMetrics()` → `IconMetrics`

Get performance metrics for debugging/observability.

```javascript
const m = AlbEdu.getMetrics()
console.log({
  rendered: m.iconsRendered,      // total icon() calls
  bound: m.iconsBound,            // total bindIcons() bindings
  missing: m.missingIconCount,    // distinct missing icons
  errors: m.errorCount,           // caught errors
  bindMs: m.bindTimeMs,           // last bindIcons() duration
  total: m.totalIconsInRegistry,  // registry size
})
```

### `AlbEdu.resetMetrics()`

Reset all metrics to zero.

### `AlbEdu.addEventListener(event, cb)` → `unsubscribe`

Subscribe to events.

```javascript
// Track missing icons in production
const unsub = AlbEdu.addEventListener('icon-missing', (detail) => {
  console.warn('Missing icon:', detail.requested)
  // Send to analytics/monitoring
  fetch('/api/log', { method: 'POST', body: JSON.stringify(detail) })
})

// Later: unsubscribe
unsub()
```

**Events:**
- `icon-missing` — fired when unknown icon is requested
- `icons-bound` — fired after bindIcons() completes
- `icon-error` — fired when rendering throws (caught by error boundary)

## Usage in HTML

```html
<!-- Auto-bound by icons.js on DOMContentLoaded -->
<span data-albedu-icon="login" class="albedu-icon--20"></span>

<!-- With explicit size (no class needed) -->
<span data-albedu-icon="warning" style="font-size: 24px"></span>

<!-- Dynamic content (auto-bound by MutationObserver) -->
<div id="modal">
  <span data-albedu-icon="close"></span>
</div>
```

## Naming Conventions

All three conventions are accepted and normalized to underscore form:

| Convention | Example | Notes |
|-----------|---------|-------|
| underscore | `account_circle` | Material Symbols style (canonical) |
| hyphen | `account-circle` | CSS class style |
| camelCase | `accountCircle` | Legacy AlbEdu style |

## Icon Registry

The registry contains **99 Lucide icons** (88 unique + 11 aliases). Built by:

```bash
python3 scripts/build_lucide_registry.py
python3 scripts/optimize_icons_js.py
```

To add new icons:
1. Edit `ALBEDU_TO_LUCIDE` mapping in `scripts/build_lucide_registry.py`
2. Run both scripts
3. The new icon will be available via `data-albedu-icon="new_name"`

## CSS Styling

```css
/* Default: 1em × 1em, inherits currentColor */
.albedu-icon {
  width: 1em;
  height: 1em;
  stroke: currentColor;  /* inherits from `color` */
  stroke-width: 2;
}

/* Size presets */
.albedu-icon--16 { width: 16px; height: 16px; }
.albedu-icon--20 { width: 20px; height: 20px; }
.albedu-icon--24 { width: 24px; height: 24px; }

/* Hover effect */
.nav-icon:hover {
  color: var(--color-primary);
  stroke-width: 2.5;
  transition: all 0.2s ease;
}

/* Active/filled state */
.nav-icon.active {
  color: var(--color-accent);
  fill: currentColor;
}

/* Missing icon indicator */
.albedu-icon--missing {
  opacity: 0.4;
  stroke-dasharray: 3 3;
}
```

## Performance Characteristics

| Metric | Value |
|--------|-------|
| File size (icons.js) | ~32 KB (uncompressed) |
| File size (Brotli) | ~8 KB |
| Icons in registry | 99 |
| First paint (critical icons) | ~0ms (inline sprite) |
| First paint (all visible icons) | ~10-20ms |
| Lazy bind threshold | 50px before viewport |
| Error boundary | Catches all errors, returns fallback |
| Memory cleanup | pagehide → disconnect observers |
| SSR safe | Yes (bails if no document) |
| Browser support | IE11+ (with fallbacks) |

## Build Scripts

| Script | Purpose |
|--------|---------|
| `scripts/build_lucide_registry.py` | Download Lucide SVGs, build registry |
| `scripts/optimize_icons_js.py` | Minify paths, inject into enterprise template |
| `scripts/add_icons_preload.py` | Add `<link rel="preload">` to HTML files |
| `scripts/remove_material_symbols_preload.py` | Cleanup old Material Symbols refs |

## TypeScript Support

Type definitions are in `src/shared/icons/icons.d.ts`. IDE autocomplete works automatically when the file is placed alongside `icons.js`.

## License

- **Lucide Icons**: ISC License (https://lucide.dev)
- **AlbEdu wrapper code**: Proprietary (AlbEdu)
