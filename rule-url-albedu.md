# rule-url-albedu.md — AlbEdu URL Routing Rules

> **Single source of truth** for URL routing, navigation, and redirect logic in AlbEdu.
> Read this BEFORE editing any HTML link, any `window.location.*` call, or any auth redirect.
>
> **Version:** 0.746.0  |  **Last updated:** 2026-07-05  |  **Owner:** Albi Fahriza (albytehq)

---

## 0. TL;DR — The 7 Rules You Must Never Break

1. **Base path is `/AlbEdu/`** in production (GitHub Pages: `albytehq.github.io/AlbEdu/`). Locally it's `/`. Never hardcode either — always derive from `AUTH_CONFIG.BASE_PATH`.
2. **Never use `href="/"`** anywhere. It jumps to `https://albytehq.github.io/` (the user's GitHub profile page), not the AlbEdu app. Use `href="./"` from root, `href="../"` from `pages/`, `href="../../"` from `pages/admin/` and `pages/assessment/` (v0.742.0+ flattened structure).
3. **Logout redirects to the LANDING PAGE** (root `index.html`), not `login.html`. Use `AUTH_CONFIG.landingUrl()` — never `AUTH_CONFIG.loginUrl()` for logout.
4. **Unauthenticated-on-protected-page redirects to LOGIN** (`pages/login.html`). Use `_redirectToLogin()` → `AUTH_CONFIG.loginUrl()`. (Different from logout.)
5. **The auto-404 page lives at project root** (`AlbEdu/404.html`). `pages/404.html` is a redirect stub. Root 404 uses dynamic base path detection for CSS.
6. **All auth redirects go through `window.Auth`** (`getBasePath()`, `getLandingPath()`, `getRoleRedirectPath()`, `navigateTo()`). Never write raw `window.location.replace('../some-page.html')` from a subfolder.
7. **Asset paths in HTML are page-relative** (`../styles/x.css` from `pages/foo.html`, `../../styles/x.css` from `pages/admin/foo.html` (v0.742.0+) or `pages/assessment/foo.html`). The root `index.html` and root `404.html` use bare paths (`styles/x.css`).

---

## 1. Production URL Anatomy

```
https://albytehq.github.io/AlbEdu/pages/admin/create-assessment.html
└───────────┬───────────────┘└────┬────┘└────┬───────────────────┘
       GitHub Pages origin     BASE_PATH   page-relative path
```

| Segment | Value (production) | Value (localhost) | How to read it |
|---|---|---|---|
| Origin | `https://albytehq.github.io` | `http://127.0.0.1:8765` | `window.location.origin` |
| BASE_PATH | `/AlbEdu/` | `/` | `AUTH_CONFIG.BASE_PATH` (auto-detected) |
| Page path | `pages/admin/create-assessment.html` | same | `window.location.pathname` minus BASE_PATH |

---

## 2. The `AUTH_CONFIG` Object (`src/auth/main.js`)

```javascript
AUTH_CONFIG = {
  BASE_PATH: (function () {
    const p = window.location.pathname;
    const base = p.substring(0, p.lastIndexOf('/') + 1);
    const APP_SUBFOLDERS = [
      '/pages/admin/pages/', '/pages/assessment/', '/pages/admin/',
      '/pages/ujian/', '/pages/', '/admin/pages/', '/ujian/', '/admin/',
      // v0.742.0: '/pages/admin/pages/' and '/admin/pages/' are kept as
      // legacy patterns for old bookmarked URLs that 404 — base path
      // detection must still work on the 404 page.
      // v0.742.2: '/pages/' added — without it, BASE_PATH returned
      // '/pages/' (not '/') when on /pages/login.html, causing
      // pathForRole() to emit '/pages/pages/admin/index.html' (doubled).
    ];
    for (const sub of APP_SUBFOLDERS) {
      const idx = base.indexOf(sub);
      if (idx !== -1) return base.substring(0, idx + 1);
    }
    return base || '/';
  })(),

  pathForRole(role) {
    const map = {
      peserta: 'pages/assessment/index.html',
      admin: 'pages/admin/index.html',
    };
    return this.BASE_PATH + (map[role] ?? this.loginUrl());
  },
};
```

---

## 3. The 4 Redirect Primitives

| Function | Destination | When to use |
|---|---|---|
| `_navigateTo(path, reason, delay)` | Generic `location.replace()` | Internal navigation |
| `_redirectToLogin()` | `AUTH_CONFIG.loginUrl()` → `/AlbEdu/pages/login.html` | Unauthenticated user on protected page |
| `_redirectForRole(role)` | `AUTH_CONFIG.pathForRole(role)` | Post-login redirect based on role |
| `authLogout()` | `AUTH_CONFIG.landingUrl()` → `/AlbEdu/` (root) | Logout — NEVER to login.html |

---

## 4. Page Classification (Scope-Based)

| Page | URL | Scope | Type |
|---|---|---|---|
| Landing | `/AlbEdu/` (index.html) | public | login-type |
| Login | `/AlbEdu/pages/login.html` | public | login-type |
| Register admin | `/AlbEdu/pages/register-admin.html` | public | login-type |
| Privacy policy | `/AlbEdu/pages/privacy-policy.html` | public | public |
| 404 | `/AlbEdu/404.html` | public | 404 |
| Admin dashboard | `/AlbEdu/pages/admin/index.html` | admin | protected |
| Create assessment | `/AlbEdu/pages/admin/create-assessment.html` | admin | protected |
| Active assessments | `/AlbEdu/pages/admin/active-assessments.html` | admin | protected |
| Monitoring | `/AlbEdu/pages/admin/monitoring.html` | admin | protected |
| Results analytics | `/AlbEdu/pages/admin/results-analytics.html` | admin | protected |
| Token entry | `/AlbEdu/pages/assessment/index.html` | ujian | protected (peserta) |
| Take assessment | `/AlbEdu/pages/assessment/take.html` | ujian | protected (peserta) |

---

## 5. HTML Link Rules — Per Page Location

| Page location | CSS/JS path | Link to admin | Link to peserta |
|---|---|---|---|
| Root (`index.html`, `404.html`) | `styles/...`, `src/...` | `pages/admin/index.html` | `pages/assessment/index.html` |
| `pages/` (`login.html`, etc.) | `../styles/...`, `../src/...` | `../pages/admin/index.html` | `../pages/assessment/index.html` |
| `pages/admin/` | `../../styles/...`, `../../src/...` | `../index.html` (admin home) | N/A |
| `pages/assessment/` | `../../styles/...`, `../../src/...` | N/A | `index.html` |

---

## 6. 404 Page Rules

- **Root `404.html`** — dynamic CSS loading via inline `<script>` that detects `__ALBEDU_BASE__`
- **`pages/404.html`** — redirect stub (`<meta http-equiv="refresh" content="0; url=../404.html">`)

---

## 7. Edge Function URLs

All Edge Function calls use **absolute Supabase URLs** (not relative paths):

```
https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/{function-name}
```

**NEVER use `window.location.origin` or relative `/functions/v1/...` paths.**

Functions: `submit-assessment`, `heartbeat`, `block-participant`, `assessment-lifecycle`, `cleanup-assessment`, `data-export`, `dsr-handler`, `access-code-attempt`, `register-admin`, `user-auth-preflight`, `user-auth-complete`

---

## 8. Cloudflare Worker

| Item | Value |
|---|---|
| URL | `https://edu.albyte-inc.workers.dev` |
| Endpoints | `/api/supabase-config`, `/api/health`, `/upload`, `/release` |
| Cron | `0 * * * *` (every hour — sweep expired assessments) |
| Format | Module Worker (`export default { fetch, scheduled }`) |

### Worker Environment Variables

> **IMPORTANT — FOR AI ASSISTANTS:**
> Do NOT write actual secret values in any file that will be committed to the repository.
> If you need the actual values, ask the user to provide them directly or check the local
> gitignored `.env.local` file. The values below are placeholders.

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL (ask user or check `.env.local`) |
| `SUPABASE_ANON_KEY` | Supabase publishable/anon key (ask user) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret/service role key (ask user — **NEVER commit this**) |
| `GITHUB_USERNAME` | `albytehq` |
| `GITHUB_TOKEN` | GitHub Personal Access Token (ask user — **NEVER commit this**) |

---

## 10. Supabase Auth Configuration

| Setting | Value |
|---|---|
| Site URL | `https://albytehq.github.io/AlbEdu` |
| URI Allow List | `https://albytehq.github.io/AlbEdu/pages/login.html` + other auth-flow pages + localhost URLs |
| Google OAuth | Enabled |
| Email confirm | False (auto-confirm) |
| Turnstile site key | `0x4AAAAAADtSMQt5KNMPWBzW` (public — safe to commit) |
| Turnstile secret key | **Ask user for this value — NEVER commit to repo** |

---

## 11. Common Pitfalls (DO NOT)

- ❌ **Jangan** gunakan `href="/"` — lompat ke profile GitHub, bukan app
- ❌ **Jangan** gunakan `fetch('/functions/v1/...')` — 404 di GitHub Pages
- ❌ **Jangan** gunakan `window.location.origin` di fetch — resolve ke GitHub Pages origin
- ❌ **Jangan** hardcode `/AlbEdu/` di JS — pakai `AUTH_CONFIG.BASE_PATH`
- ❌ **Jangan** commit secret keys (Supabase service role, GitHub token, Turnstile secret) ke repo
- ❌ **Jangan** gunakan URL lama `albedu-id.github.io` — pakai `albytehq.github.io`
- ❌ **Jangan** gunakan URL worker lama `albedu.examjuniorhighschool.workers.dev`
- ❌ **Jangan** gunakan path lama `admin/index.html` atau `ujian/index.html` di `pathForRole`

---

## 12. Version History

| Version | Date | Change |
|---|---|---|
| 0.746.0 | 2026-07-05 | **Version alignment + identity repositioning + privacy policy v4.0.0**: Bumped package.json from 0.742.9 to 0.746.0 to match code-level version references (v0.743.0, v0.745.0, v0.746.0 in CSS/JS comments). Aligned 8 admin HTML footers + manifest.json + README badge + service-worker header + docs/AI-CONTEXT.md to 0.746.0. Fixed src/auth/main.js console.log drift (v0.9.0 → v0.9.1 to match file header). Identity repositioned from 'platform ujian sekolah menengah' to 'platform asesmen untuk semua kebutuhan evaluasi — SD, SMP, SMA, kuliah, hingga personal use' across index.html, login.html, register-admin.html, register-success.html, package.json, README.md, manifest.json, docs/README.md, docs/ARCHITECTURE.md. Privacy policy rewritten from v3.0.0 → v4.0.0: 18 'ujian' → 'asesmen', 7 'peserta ujian' → 'peserta', 2 'sekolah menengah' removed, Section 7 (Data Anak) restructured from school-assumption to context-conditional. Bank Soal feature fully removed (migration 019: DROP TABLE question_bank CASCADE). Skeleton loading implemented for profile page + sidebar (all 6 admin pages). Consent RLS fix for admin (migration 020). Privacy policy link path fix in consent.js. Cloudflare Worker URL updated from deprecated albedu.examjuniorhighschool.workers.dev to edu.albyte-inc.workers.dev. |
| 0.742.9 | 2026-07-02 | **Full i18n coverage across ALL pages**: Extended i18n to every page that was missing it — landing, login, register-admin, forgot-password, reset-password, register-success, assessment/submitted, assessment/blocked, assessment/take (already had partial). Added 3 new i18n namespaces (136 keys × 5 locales = 680 new translations): `landing` (37 keys — hero, problems, solutions, how-it-works, CTA, footer), `auth` (40 keys — login/register/forgot/reset/success), `peserta` (35 keys — entry, take, submitted, blocked, consent, profile menu). New file `src/i18n/lang-switcher.js` — universal language switcher bootstrap that auto-wires any `.albedu-lang-switcher` element on the page (click to toggle dropdown, click locale to switch, click-outside/ESC to close, auto-updates UI on locale change via `locale-changed` event). `i18n/index.js` now dispatches `locale-changed` and `i18n-ready` events so lang-switcher can sync. Landing page got a floating frosted-glass language switcher (top-right). Login page got a compact language switcher in form header. Consent popup, assessment-entry cooldown/submit text, option-profile menu items all now use i18n. take.html fixed: was using inline ES module import that bypassed auto-init — replaced with `<script type="module" src>` that triggers auto-init properly. |
| 0.742.8 | 2026-07-02 | **Update daftar-nama.html to match other admin pages**: `pages/admin/daftar-nama.html` was the only admin page still using the old header layout (no language switcher, no `data-i18n` attributes, hardcoded notification badge "3", `menu-toggle` without `type="button"`). Updated to match the v0.742.7 admin page template: added `.albedu-lang-switcher` with 5-locale dropdown (id/en/ru/es/zh), added `data-i18n` attributes to page title + content header + dn-header + loading text + limit notice + "Buat Daftar" button, set notification badge to "0", added `type="button"` to menu-toggle, added full QNotify bridge (was missing `show`, `holdConfirmAsync`, `readNote`), added theme FOUC-prevention script, added site.webmanifest link, added favicon 96x96 + manifest, added meta description. Also added `daftar_nama` i18n namespace (46 keys) to all 5 locale files (id/en/ru/es/zh) — covers page title, content header, button labels, loading/empty/limit states, editor panel labels, delete confirm dialog, validation messages. |
| 0.742.7 | 2026-07-02 | **Peserta-side overhaul — floating profile button + iOS-feel UI + invisible Turnstile**: Three participant-experience fixes. (1) **Floating profile button**: New `src/profile/peserta-profile-fab.js` + `styles/peserta-floating-profile.css`. Adds a `position:fixed` circular avatar button (top-right, iOS-feel frosted glass + spring animation) to ALL participant pages (`assessment/index`, `take`, `submitted`, `blocked`). Clicking it triggers `OptionProfile` dropdown — giving peserta a way to **logout** (was previously impossible — no profile button existed on peserta pages). The FAB bootstraps `OptionProfile` + `ProfileEditorPanel` itself (since peserta pages don't load `navigasi.js`). Avatar populates from `Auth.userData` (foto_profil or initials). Presence dot if `profilLengkap === false`. Safe-area-inset aware (iPhone notch). Dark-mode aware. Reduced-motion aware. (2) **Invisible Turnstile on peserta pages**: `styles/pages/assessment-entry.css` now hides `.turnstile-wrap` via `clip:rect(0 0 0 0)` + `clip-path:inset(50%)` (same technique as `login.html`). The widget still renders and captures a token (sent to rate-limit Edge Function), but the user sees no visible challenge — matching login page behavior. `assessment-entry.js _renderTurnstile()` comment updated to explain this. (3) **iOS-feel beautification (10x)**: `assessment/index.html` now has a frosted-glass card container, spring-animated inputs (cubic-bezier(0.34, 1.56, 0.64, 1)), system font stack (`-apple-system, BlinkMacSystemFont, 'SF Pro Display'`), `safe-area-inset` padding, refined shadows, dark-mode support. `submitted.html` + `blocked.html` rebuilt with same iOS-feel scaffold (frosted card, pop-in icon animation, gradient buttons). Also fixed: `assessment-entry.js _waitForAuth()` redirect was using old `../login.html` path (404) — now uses `basePath + 'pages/login.html'`. `take.html` closed-screen button had same `../login.html` 404 — now uses inline `window.Auth.getBasePath()` expression. `submitted.html` + `blocked.html` "Kembali ke Login" buttons now go to landing page (`basePath`) instead of `../login.html`. |
| 0.742.6 | 2026-07-02 | **Fix raw i18n keys "spreading" across all pages**: The v0.742.4 auto-init fix was necessary but not sufficient — i18n init was still failing silently on most pages because `_getBasePath()`'s fallback regex (`/^(\/[^\/]+\/)/`) returned `/pages/` for `/pages/admin/profile.html` → fetch URL became `/pages/src/i18n/locales/id.json` → 404 → `_translations` stayed empty → `t(key)` returned the raw key → `updateDOM()` overwrote every `<span data-i18n="...">` with the key. Fix A: rewrote `_getBasePath()` fallback to mirror `AUTH_CONFIG.BASE_PATH` logic exactly — walks up past known app subfolders (`/pages/admin/`, `/pages/assessment/`, `/pages/`, etc.). Now resolves to `/` on localhost and `/AlbEdu/` on GitHub Pages, regardless of which page loaded the module. Fix B: `t()` no longer returns the raw KEY when translation is missing — returns `undefined` instead. `updateDOM()` now SKIPS elements whose translation is missing, preserving the HTML fallback text (e.g. `<span data-i18n="nav.profile">Profil Admin</span>` keeps "Profil Admin"). This is the "defense in depth" — even if locale fetch fails, users see the Indonesian fallback text baked into the HTML, never raw keys. Fix C: `_autoInit()` now retries up to 3 times with 200ms backoff on failure (handles transient network issues). Fix D: `results-analytics.js` and `question-bank.js` `_t()` helpers updated to handle `t()` returning `undefined` (fall back to key string for JS string ops, but DOM is handled by updateDOM). Console logging is now verbose — every step (basePath, fetch URL, locale loaded, DOM updated) is logged for debugging. |
| 0.742.5 | 2026-07-02 | **Fix consent gate Supabase errors (400 + .add not a function)**: Two bugs in `src/security/consent.js` v1.0.0 that surfaced when an admin opened `/pages/assessment/index.html`. (1) `.where('revoked_at', '==', null)` was translated by the Firestore-compat shim to PostgREST `?revoked_at=eq.null` — the STRING "null", not SQL NULL. Supabase returned HTTP 400: "invalid input syntax for type timestamp with time zone: 'null'". (2) `.add()` was never implemented on the shim's collection ref, so granting consent threw `db.collection(...).add is not a function`. Fix A: rewrote `consent.js` to v1.1.0 — bypasses the shim entirely and uses native `window.sb.from('consents')` with `.eq/.is/.order/.limit/.insert`. NULL comparisons now use `.is('revoked_at', null)`. Fix B (defensive): patched the Firestore-compat shim in `supabase-api.js` — `_buildQuery()` now routes NULL `==`/`!=` comparisons through `.is()`/`.not.is()` instead of `.eq()`/`.neq()`, and collection refs gained a real `.add(doc)` implementation that delegates to `sb.from(table).insert(_translateKeys(doc)).select().single()`. Both fixes are layered so any other caller still using the shim's Firestore-style API also benefits. |
| 0.742.4 | 2026-07-02 | **Fix raw i18n keys showing instead of translated text**: `src/i18n/index.js` exported `initI18n()` but never called it. Every page that loaded `<script type="module" src=".../i18n/index.js">` saw raw keys like `nav.profile`, `create.page_title`, `create.list_title` instead of "Profil Admin", "Buat Asesmen", "Daftar Asesmen". Root cause: `updateDOM()` was called but `_translations` was empty (no locale JSON loaded), so `t(key)` fell back to returning the key itself. Fix: added `_autoInit()` that calls `initI18n()` on DOMContentLoaded (or immediately if DOM is already ready). Idempotent — safe to call from multiple pages. The 9 pages affected: `pages/admin/{create-assessment,active-assessments,question-bank,monitoring,results-analytics,daftar-nama,profile}.html` + `pages/assessment/{index,take}.html`. |
| 0.742.3 | 2026-07-02 | **Fix "kicked out on admin entry" + option-profile navigation**: Three intertwined routing bugs. (1) `LOGIN_PAGE` constant was `'login.html'` but the login page actually lives at `/pages/login.html` — so `loginUrl()` returned `/login.html` (404) and any auth-state-change to `user=null` (token refresh, race condition) redirected the user to a non-existent page, appearing as "dikeluarkan saat mau masuk". Fixed to `'pages/login.html'`. (2) `_getRouteScope()` in `src/auth/main.js` only checked the first path segment against `{ujian, admin}` — for `/pages/admin/index.html`, firstSegment is `'pages'`, so scope was mis-returned as `'public'`, causing `_isLoginPage()` to return TRUE for the admin dashboard (since `'index.html'` is in `_PUBLIC_ENTRY_FILES` and scope==='public'). This triggered spurious "already logged in" redirects. Fixed to mirror `byteward.js` exactly: check second segment when firstSegment is `'pages'`. (3) `option-profile.js _navigateToAdmin()` used `basePath + 'admin/index.html'` (pre-v0.741.5 path) instead of `basePath + 'pages/admin/index.html'` — clicking "Panel Admin" in the option-profile dropdown 404'd. Fixed. Also: `byteward.js` `handle404Page()` and `_showAccessDenied()` now use `auth.loginUrl()` instead of hardcoded `+ 'login.html'`. Admin home (`pages/admin/index.html`) simplified to 2 cards: "AlbEdu Creates" (was "Profil Admin") and "Halaman Asesmen" (was "Halaman Ujian"). |
| 0.742.2 | 2026-07-02 | **Fix post-login double `/pages/` 404**: Added `/pages/` to the `APP_SUBFOLDERS` list in `AUTH_CONFIG.BASE_PATH` (`src/auth/main.js`). Previously, when a user was on `/pages/login.html`, `BASE_PATH` returned `/pages/` instead of `/`, so `pathForRole('admin')` produced `/pages/pages/admin/index.html` — a doubled `/pages/` segment that 404'd after login. Same fix applied to `404.html computeBasePath()` (CTA rewriter) and `src/utils/supabase-api.js _resolveRedirectUrl()` for consistency. The bug was latent for a long time because most testing happened from root `index.html` (which already had `BASE_PATH = '/'`), not from `/pages/login.html`. |
| 0.742.1 | 2026-07-02 | **Fix navigation flash**: `.page-transition` overlay changed from visible-by-default to hidden-by-default (CSS). `navigasi.js` no longer waits for `window.load` + 300ms to hide the overlay — it starts hidden, eliminating the solid-color flash on every admin page navigation. Admin home (`pages/admin/index.html`) enhanced with 8 navigation cards covering all admin pages (was 2 cards). Legacy redirect stubs (`buat-ujian.html`, `data-hasil.html`, `ujian-peserta.html`) now have empty `<body>` — no visible "Mengalihkan" text if hit via old bookmark. Service worker cache version bumped to invalidate stale browser caches that may still hold pre-v0.742.0 sidebar HTML. |
| 0.742.0 | 2026-07-01 | **Flatten admin structure**: moved `pages/admin/pages/*.html` up one level to `pages/admin/*.html`, deleted the empty `pages/admin/pages/` folder. All relative asset paths updated from `../../../` → `../../`. `navigasi.js` pageMapping extended to cover all admin pages (incl. legacy redirect stubs). Legacy subfolder patterns kept in `APP_SUBFOLDERS` for old bookmark 404 base-path detection. |
| 0.741.5 | 2026-07-01 | Final release. All routing fixed for v0.741.5 structure. Secrets removed from documentation. |
| 2.2.0 | 2026-06-30 | Dashboard cards redesign. |
| 0.2.0 | 2026-06-30 | Step-based wizard, theme color pickers. |
| 2.1.0 | 2026-06-29 | Landing URL, root 404, fixed href=/ bug. |
| 2.0.0 | 2026-06-28 | By-feature structure, auth.js split. |
