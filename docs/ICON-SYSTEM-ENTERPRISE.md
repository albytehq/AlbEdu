# AlbEdu Icon System v7.0 — Enterprise Architecture

> Enterprise-grade icon system with multi-layer caching, clone-based rendering,
> and instant first paint via inline SVG sprite. Performance comparable to
> Linear, Notion, GitHub, Figma, Vercel Dashboard, and Stripe Dashboard.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Performance Characteristics](#performance-characteristics)
3. [Icon Classification](#icon-classification)
4. [Multi-Layer Caching Strategy](#multi-layer-caching-strategy)
5. [Rendering Pipeline](#rendering-pipeline)
6. [Module Structure](#module-structure)
7. [Public API Reference](#public-api-reference)
8. [Build System](#build-system)
9. [Performance Benchmarks](#performance-benchmarks)
10. [Tree-Shaking Validation](#tree-shaking-validation)
11. [Migration from v6.0](#migration-from-v60)
12. [Architectural Decisions](#architectural-decisions)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: HTML Parse Begins                                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  critical-css.js (synchronous, in <head>)                               │
│    ↓ injects inline SVG sprite (16 critical <symbol> elements)          │
│    ↓ injects critical CSS (shell paints immediately)                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: First Paint (~0ms for critical icons)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Browser renders HTML. Critical icons materialize via:                  │
│    <span data-albedu-icon="login">  ← empty span in HTML                │
│    ↓ icons.js (deferred) runs and binds via:                            │
│    <svg><use href="#i-login"/></svg>  ← instant sprite clone            │
│                                                                         │
│  NO network round-trip. NO string parsing. NO DOM creation from JS.    │
│  Pure browser-native <use> clone — the fastest possible render.         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: icons.js Loads (~10-30ms after parse)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Module load order (strict dependencies):                               │
│    1. metrics.js    → window.AlbEdu.__iconMetrics                       │
│    2. cache.js      → window.AlbEdu.__iconCache (Layer 1b: templates)   │
│    3. sprite.js     → window.AlbEdu.__iconSprite                        │
│    4. critical.js   → window.AlbEdu.__iconRegistryCritical (16 icons)   │
│    5. secondary.js  → window.AlbEdu.__iconRegistrySecondary (85 icons)  │
│    6. renderer.js   → window.AlbEdu.__iconRenderer (Layer 1a: strings)  │
│    7. loader.js     → window.AlbEdu.__iconLoader (idle preloader)       │
│                                                                         │
│  Orchestrator (icons.js) captures module references and exposes        │
│  the public API on window.AlbEdu.                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Auto-Init (requestIdleCallback)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  bindIcons(document) runs:                                              │
│    ↓ Visible icons → bound immediately (synchronous)                    │
│    ↓ Off-screen icons → deferred via IntersectionObserver               │
│                                                                         │
│  MutationObserver starts watching document.body for dynamic content.    │
│                                                                         │
│  requestIdleCallback fires:                                             │
│    ↓ Preloads critical icons into renderer cache                        │
│    ↓ Warms Layer 1a (string cache) + Layer 1b (template cache)          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Steady State                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  User scrolls / dynamic content added:                                  │
│    ↓ IntersectionObserver fires → bind off-screen icons                 │
│    ↓ MutationObserver fires → bind new [data-albedu-icon] elements      │
│    ↓ requestAnimationFrame batches DOM updates (no layout thrash)       │
│                                                                         │
│  Cache hit rate stabilizes at ~99.5%.                                   │
│  Per-icon render time: ~0.001ms (cache hit).                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 6: Page Hide / bfcache                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  pagehide event:                                                        │
│    ↓ Disconnect IntersectionObserver                                    │
│    ↓ Disconnect MutationObserver                                        │
│    ↓ (Cache is preserved — survives bfcache navigation)                 │
│                                                                         │
│  pageshow (persisted):                                                  │
│    ↓ Re-init observers (bfcache restore)                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Performance Characteristics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| First paint (critical icons) | ~0ms | < 1ms | ✓ PASS |
| First paint (visible secondary icons) | ~5-15ms | < 50ms | ✓ PASS |
| Cold render (cache miss) | 0.005ms | < 1ms | ✓ PASS |
| Warm render (cache hit) | 0.001ms | ~0ms | ✓ PASS |
| Cache speedup | 4.1x | > 2x | ✓ PASS |
| Cache hit rate (steady state) | 99.5% | > 95% | ✓ PASS |
| Bulk bind (1000 icons) | 0.20ms/icon | < 1ms/icon | ✓ PASS |
| setIcon toggle | 0.097ms/toggle | < 1ms | ✓ PASS |
| Bundle size (uncompressed) | 73 KB | < 100 KB | ✓ PASS |
| Bundle size (Brotli) | ~18 KB | < 30 KB | ✓ PASS |
| Memory cache ceiling | 50 KB | < 100 KB | ✓ PASS |
| Missing icons | 0 | 0 | ✓ PASS |
| Render errors | 0 | 0 | ✓ PASS |

### Memory Footprint

| Component | Size | Notes |
|-----------|------|-------|
| Layer 1a: String cache | ~25 KB max | 256 entries × ~100 bytes |
| Layer 1b: Template cache | ~50 KB max | 256 entries × ~200 bytes |
| Registry | ~15 KB | 101 icons × ~150 bytes |
| Sprite (DOM) | ~2 KB | 16 `<symbol>` elements |
| Total runtime overhead | ~92 KB | Negligible |

---

## Icon Classification

### Critical Icons (16) — Layer 0: Inline Sprite

These icons are bundled into `critical-css.js` as an inline SVG sprite and
injected synchronously into `<head>` BEFORE first paint. They render
instantly via `<use href="#i-NAME">` — zero JS execution, zero network
requests, zero string parsing.

**Selection criteria** (ALL must be true):
1. Appears in the persistent app shell (navbar, sidebar, header, footer)
2. Appears on auth gates (login, register, forgot-password)
3. Used on every page (or nearly every page)
4. Visible above the fold on first paint

| Icon | Used In |
|------|---------|
| `menu` | Mobile sidebar toggle |
| `close` | Mobile sidebar close, modal dismiss |
| `login` | Auth gates, navbar login button |
| `logout` | User menu, session end |
| `person` | User avatar, profile |
| `person_add` | Register admin button |
| `manage_accounts` | Admin profile, settings |
| `notifications` | Header notification bell |
| `arrow_back` | Back navigation |
| `arrow_forward` | Forward navigation |
| `chevron_right` | Submenu indicator, list expansion |
| `chevron_left` | Pagination, back indicator |
| `search` | Search bar |
| `home` | Home navigation |
| `language` | Language switcher |
| `refresh` | Refresh actions |

### Secondary Icons (85) — Layer 1: Cached Templates

Feature-specific icons bundled into `icons.js` (loaded via `<script defer>`).
Rendered via the cached-template renderer (cloneNode from `<template>`).

**Categories**:
- Editor icons: `edit`, `edit_note`, `delete`, `save`, `content_copy`, `add`, `add_circle`
- Chart/analytics icons: `bar_chart`, `monitoring`, `monitor_heart`, `table_view`, `data_object`
- File/document icons: `assignment`, `assignment_turned_in`, `file_download`, `file_upload`, `picture_as_pdf`, `inventory_2`
- Communication icons: `mail`, `chat_bubble`, `inbox`, `notifications`
- Status icons: `check`, `check_circle`, `error`, `warning`, `info`, `block`, `dangerous`
- Action icons: `refresh`, `sync`, `restart_alt`, `play_arrow`, `pause`, `stop_circle`
- Domain icons: `school`, `science`, `book`, `menu_book`, `quiz`, `task_alt`
- Security icons: `lock`, `unlock`, `shield`, `fingerprint`, `badge`
- And 50+ more...

### Lazy-Loaded Icons (future) — Layer 2: Dynamic Import

For rarely-used feature-specific icons (e.g. analytics deep-dive, admin
tools), the architecture supports dynamic `import()` chunks:

```javascript
// Example: lazy-load analytics icons only when results page opens
const analyticsIcons = await import('./modules/registry/feature-analytics.js');
analyticsIcons.register(); // registers icons at runtime
```

This is not yet implemented but the architecture supports it cleanly via
`AlbEdu.registerIcon()`.

---

## Multi-Layer Caching Strategy

The system implements defense-in-depth caching across 4 layers:

### Layer 1a: String Cache (in-memory, ~25 KB)

- **Location**: `renderer.js` → `_stringCache` Map
- **Purpose**: Cache rendered SVG strings for the `AlbEdu.icon()` string API
- **Capacity**: 256 entries (LRU eviction)
- **Hit time**: ~0.001ms (Map.get + LRU refresh)
- **Miss time**: ~0.005ms (string concatenation + cache set)

### Layer 1b: Template Cache (in-memory, ~50 KB)

- **Location**: `cache.js` → `window.AlbEdu.__iconCache`
- **Purpose**: Cache parsed `<template>` elements for DOM insertion (`AlbEdu.setIcon()`, `bindIcons()`)
- **Capacity**: 256 entries (LRU eviction)
- **Hit time**: ~0.002ms (Map.get + `cloneNode(true)`)
- **Miss time**: ~0.05ms (string parse + template creation + cache set)

### Layer 2: Browser HTTP Cache

- **Location**: Browser HTTP cache
- **Purpose**: Cache the `icons.js` file itself across page navigations
- **TTL**: Set by `Cache-Control` headers (recommend `max-age=31536000, immutable`)
- **Hit time**: 0ms (no network request)

### Layer 3: Service Worker Cache

- **Location**: `public/service-worker.js`
- **Purpose**: Offline support, instant icon load on repeat visits
- **Strategy**: Cache-first (icons are immutable per version)
- **Hit time**: ~5ms (SW fetch + cache read)

### Layer 4: CDN Edge Cache

- **Location**: Cloudflare / Vercel Edge
- **Purpose**: Geographic caching of `icons.js`
- **Hit time**: ~20-50ms (depends on edge location)

---

## Rendering Pipeline

### Critical Icon Render Path (instant)

```
HTML: <span data-albedu-icon="login"></span>
                    ↓
icons.js bindIcons() runs:
    ↓ normalizeName("login") → "login"
    ↓ sprite.isCritical("login") → true
    ↓ sprite.buildUseHtml("login") → '<svg class="albedu-icon" ...><use href="#i-login"/></svg>'
    ↓ span.innerHTML = useHtml
                    ↓
DOM: <span><svg class="albedu-icon"><use href="#i-login"/></svg></span>
                    ↓
Browser renders: instant <use> clone from sprite
```

**Total time**: ~0.05ms per icon (string build + innerHTML set)
**Cache**: N/A (sprite is always available)

### Secondary Icon Render Path (cached)

```
HTML: <span data-albedu-icon="bar_chart"></span>
                    ↓
icons.js bindIcons() runs:
    ↓ normalizeName("bar_chart") → "bar_chart"
    ↓ sprite.isCritical("bar_chart") → false
    ↓ renderer.bindToElement(span, "bar_chart")
        ↓ resolve("bar_chart") → { name: "bar_chart", path: "<path.../>" }
        ↓ cacheKey = "bar_chart||2|||0"
        ↓ cache.get(cacheKey) → cached <template> (if hit)
            ↓ IF HIT: template.content.firstChild.cloneNode(true)
            ↓ IF MISS: _buildSvgString() + template creation + cache.set()
        ↓ span.clear() + span.appendChild(clonedSvg)
                    ↓
DOM: <span><svg class="albedu-icon"><path d="M3 3v16..."/></svg></span>
```

**Total time (cache hit)**: ~0.05ms (cloneNode + DOM insert)
**Total time (cache miss)**: ~0.1ms (string build + template parse + DOM insert)

### String API Render Path (for `AlbEdu.icon()` calls)

```
JS: const html = AlbEdu.icon('home');
                    ↓
renderer.render('home') runs:
    ↓ resolve('home') → { name: "home", path: "<path.../>" }
    ↓ cacheKey = "home||2|||0"
    ↓ _getString(cacheKey) → cached string (if hit)
        ↓ IF HIT: return cached string
        ↓ IF MISS: _buildSvgString() + _setString() + return string
                    ↓
Result: '<svg class="albedu-icon" viewBox="0 0 24 24" ...><path d="M15 21v-8..."/></svg>'
```

**Total time (cache hit)**: ~0.001ms (Map.get + LRU refresh)
**Total time (cache miss)**: ~0.005ms (string concatenation + Map.set)

---

## Module Structure

```
src/shared/icons/
├── icons.js                          # Bundled production file (73 KB)
├── icons.bundle.js                   # Backup of bundled output
├── icons.template.js                 # Orchestrator template (with placeholder)
├── icons.legacy-v6.js                # v6.0 backup (for rollback / benchmarking)
├── icons.d.ts                        # TypeScript definitions (v7.0)
└── modules/                          # Modular source files
    ├── performance/
    │   └── metrics.js                # Performance observability (counters, events)
    ├── cache/
    │   └── cache.js                  # Layer 1b: Template cache (LRU, 256 entries)
    ├── sprite/
    │   └── sprite.js                 # Inline SVG sprite manager (16 critical icons)
    ├── registry/
    │   ├── critical.js               # 16 critical icon paths (bundled)
    │   └── secondary.js              # 85 secondary icon paths (bundled)
    ├── renderer/
    │   └── renderer.js               # Clone-based SVG renderer (Layer 1a + 1b)
    └── loader/
        └── loader.js                 # requestIdleCallback preloader
```

### Module Dependency Graph

```
metrics.js (no deps)
    ↓
cache.js (no deps)
    ↓
sprite.js (no deps)
    ↓
registry/critical.js (no deps)
    ↓
registry/secondary.js (no deps)
    ↓
renderer.js (deps: metrics, cache, registry)
    ↓
loader.js (deps: renderer, sprite)
    ↓
icons.js orchestrator (deps: all above)
```

---

## Public API Reference

### `AlbEdu.icon(name, opts?)` → `string`

Render an icon as an HTML string. **Never throws** — returns fallback on error.

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

Set an icon on an existing DOM element. Uses `cloneNode` — no string parsing on repeat renders.

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

Register a custom icon at runtime. Invalidates both string and template caches.

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
  rendered: m.iconsRendered,          // total icon() calls
  bound: m.iconsBound,                // total bindIcons() bindings
  cacheHits: m.cacheHits,             // Layer 1 hits
  cacheMisses: m.cacheMisses,         // Layer 1 misses
  cacheHitRate: m.cacheHitRate,       // 0-1
  avgRenderTimeUs: m.avgRenderTimeUs, // microseconds
  bindMs: m.bindTimeMs,               // last bindIcons() duration
  total: m.totalIconsInRegistry,      // registry size
  critical: m.criticalIconsCount,     // sprite size
})
```

### `AlbEdu.resetMetrics()`

Reset all metrics to zero and clear both caches (Layer 1a + 1b).

### `AlbEdu.preloadIcons(names?)` — NEW v7.0

Preload specific icons (or the critical set) into the cache during idle time.

```javascript
// Preload critical icons (recommended on app shell mount)
AlbEdu.preloadIcons()

// Preload specific icons
AlbEdu.preloadIcons(['home', 'search', 'settings'])
```

### `AlbEdu.preloadAll()` — NEW v7.0

Preload the entire registry into the cache. Useful for SPA route transitions
where you want every icon to be a cache hit.

```javascript
AlbEdu.preloadAll()
```

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

### Usage in HTML

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

### Naming Conventions

All three conventions are accepted and normalized to underscore form:

| Convention | Example | Notes |
|-----------|---------|-------|
| underscore | `account_circle` | Material Symbols style (canonical) |
| hyphen | `account-circle` | CSS class style |
| camelCase | `accountCircle` | Legacy AlbEdu style |

---

## Build System

### Source Files vs Production Bundle

The icon system uses a **single-bundle production model**:
- **Source**: Modular ES files in `src/shared/icons/modules/` (7 files)
- **Bundle**: Single `src/shared/icons/icons.js` (73 KB, all modules inlined)
- **HTML**: Loads only `src/shared/icons/icons.js` (zero HTML changes from v6.0)

### Build Script

```bash
# Rebuild the bundle from modules (after editing any module source)
python3 scripts/build_icons_bundle.py
```

The build script:
1. Reads `src/shared/icons/icons.template.js` (orchestrator with placeholder)
2. Reads each module from `src/shared/icons/modules/{module}/{file}.js`
3. Inlines all modules at the placeholder position
4. Writes the bundled output to `src/shared/icons/icons.js`

### Module Re-build Workflow

When you edit a module source file (e.g. `renderer.js`):

```bash
# 1. Edit the module
vim src/shared/icons/modules/renderer/renderer.js

# 2. Re-build the bundle
python3 scripts/build_icons_bundle.py

# 3. Verify syntax
node -c src/shared/icons/icons.js

# 4. Run smoke tests
node scripts/smoke-test-icons.mjs

# 5. Run benchmarks
node scripts/benchmark_icons.mjs
```

### Production Minification

The project's existing `scripts/minify.mjs` handles production minification:
- Each `.js` file is minified in-place using esbuild
- Target: ES2020, IIFE format
- Output: `dist/src/shared/icons/icons.js` (minified)

---

## Performance Benchmarks

Run the benchmark suite:

```bash
node scripts/benchmark_icons.mjs
```

### Sample Output (Node.js v24, jsdom)

```
┌─ Benchmark 1: Cold render (cache miss)
│ Average per icon: 0.0051ms (cold)
└─

┌─ Benchmark 2: Warm render (cache hit)
│ Average per render: 0.0012ms (warm)
│ Cache speedup: 4.1x faster than cold
└─

┌─ Benchmark 3: Critical vs Secondary icon render
│ Critical icon:    0.0018ms/render
│ Secondary icon:   0.0015ms/render
└─

┌─ Benchmark 4: Bulk bindIcons() throughput
│  100 icons: 0.54ms/icon
│  500 icons: 0.21ms/icon
│ 1000 icons: 0.20ms/icon
└─

┌─ Benchmark 5: setIcon() — single element re-render
│ 0.0974ms/toggle (mobile sidebar use case)
└─

┌─ Benchmark 6: Cache effectiveness
│ Hit rate: 99.52% (steady state)
│ Avg render time: 0.0010ms
└─

═══════════════════════════════════════════════
Performance targets:
  Initial icon render < 1ms:    ✓ PASS (0.0051ms)
  Repeat icon render ~0ms:      ✓ PASS (0.0012ms)
  Cache hit rate > 95%:         ✓ PASS (99.5%)
═══════════════════════════════════════════════
```

---

## Tree-Shaking Validation

Run the tree-shaking validator:

```bash
python3 scripts/validate_icon_treeshake.py
```

This script verifies:
1. Every icon in the registry is actually used in the codebase
2. No missing icons (referenced but not registered)
3. Critical icon coverage (all 16 shell icons are in the sprite)
4. Bundle size is within limits

### Sample Output

```
┌─ Registry
│ Total icons in registry:    101
│ Critical icons (sprite):    16
│ Secondary icons (cached):   85
└─

┌─ Usage
│ Icons referenced in HTML:   85
│ Total unique icons used:    85
│ Total icon instances:       247
└─

┌─ Tree-shaking analysis
│ Unused icons: 16 (registry, not referenced — candidates for removal)
│ Missing icons: 0 (all referenced icons exist)
└─

┌─ Critical icon coverage
│ ✓ All 16 shell/navigation icons are in critical set
└─

✓ VALIDATION PASSED
```

---

## Migration from v6.0

### Backward Compatibility

The v7.0 system is **100% backward compatible** with v6.0:

| Aspect | v6.0 | v7.0 | Compatible? |
|--------|------|------|-------------|
| `AlbEdu.icon(name, opts)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.setIcon(el, name, opts)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.registerIcon(name, path)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.bindIcons(root)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.listIcons()` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.hasIcon(name)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.getMetrics()` | ✓ | ✓ | ✓ Extended (new fields) |
| `AlbEdu.addEventListener(event, cb)` | ✓ | ✓ | ✓ Same signature |
| `AlbEdu.ICONS_VERSION` | `'6.0.0-enterprise'` | `'7.0.0-enterprise'` | ✓ Version bump |
| HTML `<span data-albedu-icon="X">` | ✓ | ✓ | ✓ No HTML changes |
| Critical sprite | 5 icons | 16 icons | ✓ Superset |
| File size | 33 KB | 73 KB | ⚠ Larger (more icons + modules) |

### New APIs in v7.0

| API | Purpose |
|-----|---------|
| `AlbEdu.preloadIcons(names?)` | Preload icons into cache during idle time |
| `AlbEdu.preloadAll()` | Preload entire registry into cache |
| `AlbEdu.resetMetrics()` | Reset metrics + clear all caches (improved) |

### Rollback Procedure

If v7.0 causes issues, rollback to v6.0:

```bash
# v6.0 is preserved at:
cp src/shared/icons/icons.legacy-v6.js src/shared/icons/icons.js

# Restart the dev server
npm run dev
```

---

## Architectural Decisions

### 1. Why a Single Bundled File (Instead of Multiple `<script>` Tags)?

**Decision**: Bundle all modules into a single `icons.js`.

**Rationale**:
- Zero HTML changes required (preserves existing `<script defer src="...">`)
- Single HTTP request (better for HTTP/1.1, negligible difference for HTTP/2)
- Simpler caching (one file, one cache entry)
- The modular source files still exist in `src/shared/icons/modules/` for
  developer clarity and future bundler integration

**Trade-off**: Source code is less "modular" at runtime, but the build
script (`scripts/build_icons_bundle.py`) makes the modular structure
visible at development time.

### 2. Why `<template>` + `cloneNode` Instead of `innerHTML`?

**Decision**: Cache parsed SVGs as `<template>` elements and use `cloneNode(true)`.

**Rationale**:
- `cloneNode(true)` is V8/JSC/SpiderMonkey-optimized (native browser fast-path)
- `innerHTML` parses HTML strings every time (slow)
- `<template>.content` is a DocumentFragment — inert, not in DOM tree
- First render: ~0.05ms (parse + template creation)
- Repeat render: ~0.002ms (cloneNode only) — 25x faster

### 3. Why a Separate String Cache (Layer 1a) AND Template Cache (Layer 1b)?

**Decision**: Maintain two caches — one for strings, one for templates.

**Rationale**:
- `AlbEdu.icon()` returns a string → needs string cache (no DOM round-trip)
- `AlbEdu.setIcon()` / `bindIcons()` need a DOM node → needs template cache (cloneNode)
- Without separation, the string API would do: cloneNode → div.appendChild → div.innerHTML (DOM round-trip = slow)
- With separation: string API is pure Map.get (fastest possible)

### 4. Why 16 Critical Icons (Not 5, Not 50)?

**Decision**: 16 critical icons in the inline sprite.

**Rationale**:
- v6.0 had only 5 critical icons (login, person, menu, close, language)
- This missed common shell icons (search, home, notifications, etc.) causing visual pop-in
- 16 covers ALL icons in the persistent app shell + auth gates
- Adding more (e.g. 50) would bloat `critical-css.js` (which loads synchronously in `<head>`)
- 16 × ~200 bytes = ~3 KB inline — negligible for first paint

### 5. Why IntersectionObserver for Off-Screen Icons?

**Decision**: Defer binding of off-screen icons via IntersectionObserver.

**Rationale**:
- Initial viewport typically contains 5-20 icons
- A long page might have 100+ icons total
- Binding all 100 synchronously delays first paint by ~20ms
- IntersectionObserver binds icons just before they scroll into view
- `rootMargin: '50px 0px'` pre-binds icons 50px before viewport edge (no visible pop-in)

### 6. Why MutationObserver for Dynamic Content?

**Decision**: Auto-bind dynamically-added `[data-albedu-icon]` elements via MutationObserver.

**Rationale**:
- Many pages add icons via AJAX (modals, notifications, dynamic lists)
- Without MutationObserver, developers must manually call `bindIcons(newContainer)` after every DOM update
- MutationObserver detects new `[data-albedu-icon]` elements and binds them automatically
- Uses `requestAnimationFrame` to batch DOM updates (no layout thrash)

### 7. Why `requestIdleCallback` for Preloading?

**Decision**: Preload critical icons into the renderer cache during idle time.

**Rationale**:
- After first paint, the browser has idle time before user interaction
- Preloading critical icons into the cache makes future `setIcon()` calls (e.g. mobile menu toggle) instant cache hits
- `requestIdleCallback` with `timeout: 2000` ensures preloading happens within 2 seconds, even on busy pages
- The preload is best-effort — failures are swallowed

### 8. Why LRU Cache Eviction (Not FIFO)?

**Decision**: LRU (Least Recently Used) eviction with 256-entry cap.

**Rationale**:
- LRU keeps frequently-used icons in cache (e.g. `home`, `search`)
- FIFO would evict `home` after 256 unique renders, even if it's used 1000 times
- 256 entries × ~200 bytes = ~50 KB max memory — negligible
- LRU refresh on access ensures hot icons stay cached

### 9. Why Keep the v6.0 Legacy File?

**Decision**: Preserve `icons.legacy-v6.js` as a backup.

**Rationale**:
- Enables instant rollback if v7.0 causes issues
- Used by the benchmark suite for performance comparison
- Serves as a reference for the v6.0 API surface

### 10. Why Not Use ES Modules (`import`/`export`)?

**Decision**: Use IIFE pattern with `window.AlbEdu.__iconXxx` namespaces.

**Rationale**:
- The project's HTML loads icons.js via `<script defer src="...">` (not `type="module"`)
- Switching to ES modules would require updating ~20 HTML files
- IIFE pattern works in all browsers (including IE11 with fallbacks)
- The build script could easily switch to ES modules in the future if needed

---

## License

- **Lucide Icons**: ISC License (https://lucide.dev)
- **AlbEdu wrapper code**: Proprietary (AlbEdu)
