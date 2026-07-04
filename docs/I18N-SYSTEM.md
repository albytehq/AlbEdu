# AlbEdu I18N System (v2.0 Enterprise)

> Enterprise-grade internationalization with Intl API, missing key tracking,
> completeness checking, memoization, and dev mode.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Page Load (0ms)                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. detectLocale() — URL param → localStorage → Supabase → nav  │
│ 2. loadLocale() — fetch JSON (cached in sessionStorage 1h)      │
│ 3. updateDOM() — scan [data-i18n] attributes, apply translations│
│ 4. dispatch 'i18n-ready' event                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Runtime (every t() call)                                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Check memoization cache (key + locale + paramsHash)         │
│ 2. Cache hit → return cached result (O(1))                     │
│ 3. Cache miss → resolve key (with context variant if provided) │
│ 4. Fallback chain: active → default → inline fallback          │
│ 5. Pluralization (if count param provided)                     │
│ 6. Interpolation (XSS-safe — vars HTML-escaped)                │
│ 7. Cache result + return                                       │
│ 8. If missing → track for analytics + warn (dev mode only)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Locale Switch                                                   │
├─────────────────────────────────────────────────────────────────┤
│ 1. switchLocale(newLocale)                                      │
│ 2. loadLocale() — fetch JSON if not cached                      │
│ 3. _clearCache() — invalidate memoization                      │
│ 4. Update <html lang="..." dir="...">                           │
│ 5. updateDOM() — re-scan + re-apply all translations            │
│ 6. Notify listeners (onLocaleChange)                            │
│ 7. Dispatch 'locale-changed' event                              │
│ 8. Sync to Supabase (async, fire-and-forget)                   │
└─────────────────────────────────────────────────────────────────┘
```

## Public API

### Core Translation

#### `t(key, params?, opts?)` → `string | undefined`

```javascript
// Basic
i18n.t('nav.profile')  // → 'Profil Admin'

// Interpolation (XSS-safe — vars are HTML-escaped)
i18n.t('auth.welcome', { name: '<script>alert(1)</script>' })
// → 'Selamat datang, &lt;script&gt;alert(1)&lt;/script&gt;!'

// Pluralization (object form in JSON)
i18n.t('notif.unread_count', { count: 0 })   // → 'Tidak ada notifikasi'
i18n.t('notif.unread_count', { count: 1 })   // → '1 notifikasi'
i18n.t('notif.unread_count', { count: 5 })   // → '5 notifikasi'

// Context variant
i18n.t('nav.profile', { context: 'admin' })
// Looks up 'nav.profile.admin' first, falls back to 'nav.profile'

// Bypass cache (force re-translation)
i18n.t('dynamic.key', {}, { bypassCache: true })
```

### Intl API Formatters (v2.0)

Locale-aware formatting using the browser's built-in `Intl` API.

#### `formatNumber(num, opts?)` → `string`

```javascript
i18n.formatNumber(1234567.89)
// ID: '1.234.567,89'  (dot = thousands, comma = decimal)
// EN: '1,234,567.89'  (comma = thousands, dot = decimal)

i18n.formatNumber(0.75, { style: 'percent' })
// ID: '75%'  EN: '75%'

i18n.formatNumber(42, { minimumFractionDigits: 2 })
// ID: '42,00'  EN: '42.00'
```

#### `formatCurrency(num, currency?, opts?)` → `string`

```javascript
i18n.formatCurrency(99999.99, 'IDR')
// ID: 'Rp 100.000'  EN: 'IDR 100,000.00'

i18n.formatCurrency(49.99, 'USD')
// ID: 'US$49,99'  EN: '$49.99'

i18n.formatCurrency(1500000, 'IDR', { notation: 'compact' })
// ID: 'Rp 1,5 jt'  EN: 'Rp1.5M'
```

#### `formatDate(date, opts?)` → `string`

```javascript
i18n.formatDate('2026-01-15')
// ID: '15 Jan 2026'  EN: 'Jan 15, 2026'

i18n.formatDate('2026-01-15', { dateStyle: 'long' })
// ID: '15 Januari 2026'  EN: 'January 15, 2026'

i18n.formatDate(new Date(), { dateStyle: 'full' })
// ID: 'Sabtu, 4 Juli 2026'  EN: 'Saturday, July 4, 2026'
```

#### `formatTime(date, opts?)` → `string`

```javascript
i18n.formatTime('2026-01-15T14:30:00')
// ID: '14.30'  EN: '2:30 PM'
```

#### `formatRelativeTime(date, opts?)` → `string`

Auto-selects the best unit (seconds, minutes, hours, days).

```javascript
i18n.formatRelativeTime(new Date(Date.now() - 3600000))  // 1 hour ago
// ID: '1 jam yang lalu'  EN: '1 hour ago'

i18n.formatRelativeTime(new Date(Date.now() + 86400000))  // tomorrow
// ID: 'besok'  EN: 'tomorrow'

i18n.formatRelativeTime(new Date(Date.now() - 86400000 * 3))  // 3 days ago
// ID: '3 hari yang lalu'  EN: '3 days ago'
```

#### `formatList(items, opts?)` → `string`

```javascript
i18n.formatList(['Alice', 'Bob', 'Charlie'])
// ID: 'Alice, Bob, dan Charlie'  EN: 'Alice, Bob, and Charlie'

i18n.formatList(['Alice', 'Bob', 'Charlie'], { type: 'disjunction' })
// ID: 'Alice, Bob, atau Charlie'  EN: 'Alice, Bob, or Charlie'
```

### Missing Key Tracking (v2.0)

Track every missing key request for analytics and debugging.

#### `getMissingKeys()` → `MissingKeyEntry[]`

```javascript
const missing = i18n.getMissingKeys()
// [
//   { key: 'nav.nonexistent', count: 5, firstSeen: 1234567890, lastSeen: 1234567990, locales: ['en', 'id'] },
//   { key: 'auth.broken', count: 2, ... }
// ]

// Send to analytics endpoint
fetch('/api/i18n/missing-keys', {
  method: 'POST',
  body: JSON.stringify({ missing, url: location.href, locale: i18n.getCurrentLocale() })
})
```

#### `onMissingKey(callback)` → `unsubscribe`

```javascript
// Real-time missing key alerts
const unsub = i18n.onMissingKey((event) => {
  console.warn(`Missing: ${event.key} in ${event.locale}`)
  // Or send to Sentry/Datadog
  Sentry.captureMessage(`i18n missing key: ${event.key}`, 'warning')
})

// Later: stop listening
unsub()
```

#### `resetMissingKeys()`

Clear all tracked missing keys.

### Completeness Checker (v2.0)

Useful for CI/CD pipelines to detect incomplete translations.

#### `getCompleteness(locale)` → `number` (0-100)

```javascript
const enCompleteness = i18n.getCompleteness('en')
console.log(`English translation: ${enCompleteness}% complete`)
// → 'English translation: 98.5% complete'
```

#### `getMissingKeysForLocale(locale)` → `string[]`

```javascript
const missingInEn = i18n.getMissingKeysForLocale('en')
console.log('Keys missing from English:', missingInEn)
// → ['nav.new_feature', 'auth.beta_message']
```

### Dev Mode (v2.0)

#### `isDevMode()` → `boolean`

Dev mode is active when:
- `location.hostname` is `localhost`, `127.0.0.1`, or `0.0.0.0`
- OR URL has `?i18n_debug` query parameter

In dev mode:
- Missing keys are wrapped with `⟦key⟧` markers for visual debugging
- Console warnings are shown for every missing key
- All Intl formatters work normally

In production:
- Missing keys return `undefined` (no visual markers)
- Console warnings are suppressed (use `getMissingKeys()` for reporting)
- `onMissingKey()` listeners still fire (for analytics)

### Cache Management (v2.0)

#### `clearCache()`

Clear the memoization cache. Automatically called on locale switch.

```javascript
// After dynamically updating a translation
i18n.clearCache()  // force re-translation on next t() call
```

## Locale JSON Structure

```json
{
  "nav": {
    "profile": "Profil Admin",
    "profile_admin": {
      "zero": "Tidak ada admin",
      "one": "1 admin",
      "other": "{{count}} admin"
    }
  }
}
```

### Pluralization Rules

Object form with `zero`, `one`, `other` keys:

```json
{
  "items_count": {
    "zero": "Tidak ada item",
    "one": "{{count}} item",
    "other": "{{count}} item"
  }
}
```

```javascript
i18n.t('items_count', { count: 0 })   // → 'Tidak ada item'
i18n.t('items_count', { count: 1 })   // → '1 item'
i18n.t('items_count', { count: 10 })  // → '10 item'
```

## Security

- **Allowlist enforcement**: Only `id` and `en` are valid. Other locale codes
  (from URL, localStorage, Supabase, navigator) are rejected with a warning.
- **XSS-safe interpolation**: All `{{var}}` values are HTML-escaped before
  substitution. Template strings (in JSON) are trusted (authored by dev).
- **No eval**: Translations are loaded via `fetch()` (not `eval`).
- **CSP-friendly**: No inline scripts/styles from translations.

## Performance

| Metric | Value |
|--------|-------|
| Memoization cache | Up to 5,000 entries (LRU-style) |
| Cache hit latency | O(1) — hash lookup |
| Cache miss latency | O(depth) — nested object traversal |
| Locale JSON size | ~53 KB (1,011 keys, uncompressed) |
| Locale JSON cached | Brotli ~12 KB, sessionStorage 1h TTL |
| DOM scan | Single `querySelectorAll` + batch update |

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Basic t() | ✅ | ✅ | ✅ | ✅ |
| Intl.NumberFormat | ✅ | ✅ | ✅ | ✅ |
| Intl.DateTimeFormat | ✅ | ✅ | ✅ | ✅ |
| Intl.RelativeTimeFormat | 71+ | 65+ | 14+ | 79+ |
| Intl.ListFormat | 72+ | 78+ | 14.1+ | 79+ |

For older browsers, formatters gracefully fall back to `String(num)` etc.

## TypeScript Support

Type definitions in `src/i18n/index.d.ts`. IDE autocomplete works automatically.

```typescript
// In TypeScript files
import { i18n } from './i18n'

const welcome: string = i18n.t('auth.welcome', { name: userName })
const price: string = i18n.formatCurrency(99.99, 'IDR')
const completeness: number = i18n.getCompleteness('en')
```

## Version

**2.0.0-enterprise** — check via `i18n.I18N_VERSION`
