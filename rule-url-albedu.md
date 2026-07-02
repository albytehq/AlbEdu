# rule-url-albedu.md — AlbEdu URL Routing Rules

> **Single source of truth** for URL routing, navigation, and redirect logic in AlbEdu.
> Read this BEFORE editing any HTML link, any `window.location.*` call, or any auth redirect.
>
> **Version:** 2.1.0  |  **Last updated:** 2026-06-29  |  **Owner:** AlbEdu Core

---

## 0. TL;DR — The 7 Rules You Must Never Break

1. **Base path is `/AlbEdu/`** in production. Locally it's `/`. Never hardcode either — always derive from `AUTH_CONFIG.BASE_PATH`.
2. **Never use `href="/"`** anywhere. It jumps to `https://albedu-id.github.io/` (the GitHub user's profile page), not the AlbEdu app. Use `href="./"` from root, `href="../"` from `pages/`, `href="../../"` from `pages/admin/pages/` and `pages/ujian/`.
3. **Logout redirects to the LANDING PAGE** (root `index.html`), not `login.html`. Use `AUTH_CONFIG.landingUrl()` — never `AUTH_CONFIG.loginUrl()` for logout.
4. **Unauthenticated-on-protected-page redirects to LOGIN** (`login.html`). Use `_redirectToLogin()` → `AUTH_CONFIG.loginUrl()`. (Different from logout.)
5. **The auto-404 page lives at project root** (`AlbEdu/404.html`). `pages/404.html` is legacy and only reachable by direct link. Both must use root-relative asset paths that match their location.
6. **All auth redirects go through `window.Auth`** (`getBasePath()`, `getLandingPath()`, `getRoleRedirectPath()`, `navigateTo()`). Never write raw `window.location.replace('../some-page.html')` from a subfolder.
7. **Asset paths in HTML are page-relative** (`../styles/x.css` from `pages/foo.html`, `../../styles/x.css` from `pages/admin/pages/foo.html`). The root `index.html` and root `404.html` use bare paths (`styles/x.css`).

---

## 1. Production URL Anatomy

```
https://albedu-id.github.io/AlbEdu/pages/admin/pages/buat-ujian.html
└───────────┬───────────────┘└────┬────┘└────┬─────────────────────┘
       GitHub Pages origin     BASE_PATH   page-relative path
```

| Segment | Value (production) | Value (localhost) | How to read it |
|---|---|---|---|
| Origin | `https://albedu-id.github.io` | `http://127.0.0.1:8765` | `window.location.origin` |
| BASE_PATH | `/AlbEdu/` | `/` | `AUTH_CONFIG.BASE_PATH` |
| Page path | `pages/admin/pages/buat-ujian.html` | same | `window.location.pathname.slice(BASE_PATH.length)` |

**Critical implication:** any link that starts with `/` (e.g. `href="/"`) resolves against the **origin**, not against BASE_PATH. So `href="/"` jumps to `https://albedu-id.github.io/` — the GitHub user profile page, NOT the AlbEdu landing page at `/AlbEdu/`.

---

## 2. The `AUTH_CONFIG` Object (`src/auth/main.js`)

This is the **single source of truth** for all auth-related URLs. Every redirect in AlbEdu goes through it.

```javascript
const AUTH_CONFIG = {
    // ── Resolved once at page load ──────────────────────────────────
    // Walks up from current pathname past known app subfolders.
    // Examples:
    //   /AlbEdu/login.html              → '/AlbEdu/'
    //   /AlbEdu/ujian/index.html        → '/AlbEdu/'
    //   /AlbEdu/admin/pages/buat-ujian  → '/AlbEdu/'
    //   /login.html (localhost)         → '/'
    BASE_PATH: (function () { /* subfolder walker */ })(),

    LANDING_PAGE: '',       // root index.html — server resolves it
    LOGIN_PAGE:   'login.html',

    // ── Role → dashboard path map ───────────────────────────────────
    // Unknown roles fall back to loginUrl() so they can never reach a
    // protected page by accident.
    pathForRole(role) {
        const map = { peserta: 'ujian/index.html', admin: 'admin/index.html' };
        if (!(role in map)) return this.loginUrl();
        return this.BASE_PATH + map[role];
    },

    // ── URL builders (always return absolute path from origin) ─────
    landingUrl() { return this.BASE_PATH + this.LANDING_PAGE; },  // '/AlbEdu/'
    loginUrl()   { return this.BASE_PATH + this.LOGIN_PAGE; },    // '/AlbEdu/login.html'
};
```

### Exposed on `window.Auth`

| Method | Returns | Used for |
|---|---|---|
| `Auth.getBasePath()` | `'/AlbEdu/'` | Building custom URLs |
| `Auth.getLandingPath()` | `'/AlbEdu/'` | **Logout destination** (v2.1+) |
| `Auth.getRoleRedirectPath(role)` | `'/AlbEdu/admin/index.html'` | Post-login redirect |
| `Auth.navigateTo(path, reason)` | `void` | All auth-driven redirects (uses `location.replace`) |
| `Auth.redirectToLogin()` | `void` | Unauthenticated → login |

---

## 3. The 4 Redirect Primitives

Every `window.location.*` call in AlbEdu MUST use one of these four primitives. Never write `window.location.href = '...'` directly.

### 3.1 `_navigateTo(path, reason, delay)` — Generic
- Uses `location.replace()` (no history entry — user can't press Back to return to a protected page).
- Trailing-slash-aware: `/foo/` and `/foo` are treated as equal (prevents redirect loops).
- Dev-only logging with `[AuthRedirect]` prefix.
- Located in: `src/auth/main.js` AND `src/auth/byteward.js` (mirror).

### 3.2 `_redirectToLogin()` — Unauthenticated → Login
- Calls `_navigateTo(AUTH_CONFIG.loginUrl(), 'unauthenticated → login')`.
- Skips redirect if user is already on a public page (login, landing, 404).
- Used by: `_handleAuthStateChange(user=null)` in main.js, `checkPageAccess()` in byteward.js.

### 3.3 `_redirectForRole(role)` — Post-Login → Dashboard
- Calls `_navigateTo(AUTH_CONFIG.pathForRole(role))`.
- Used by: `_handleAuthStateChange(user=valid)` when user is on a login-type page.
- Admin → `/AlbEdu/admin/index.html`, Peserta → `/AlbEdu/ujian/index.html`.

### 3.4 `authLogout()` → `AUTH_CONFIG.landingUrl()` — Logout → Landing (v2.1+)
- **Before v2.1:** logout went to `loginUrl()` → `login.html`.
- **v2.1 (current):** logout goes to `landingUrl()` → root `index.html` (the public landing page).
- User sees marketing content and can choose to log in again from the navbar.
- The `auth-logout-started` event fires before signOut so UI can clean up.
- `signOut()` failure is non-fatal — client state is already clean, redirect still happens.

> ⚠️ **DO NOT** change `authLogout()` to redirect to `loginUrl()`. The user explicitly chose landing page as the logout destination. See git history of `src/auth/main.js` Step 11 for context.

---

## 4. Page Classification (Scope-Based)

`byteward.js` and `main.js` classify every page into one of three **route scopes**. This is folder-based, not filename-based, because `index.html` is ambiguous (it appears at root, `/admin/`, and `/ujian/`).

### `_getRouteScope()` algorithm
```
1. Strip BASE_PATH prefix from pathname
2. Take first path segment (the immediate subfolder)
3. Map: 'ujian' → 'ujian' | 'admin' → 'admin' | anything else → 'public'
```

### Scope Policy
| Role | Allowed scopes | Effect |
|---|---|---|
| `admin` | (all) | Admin can access every route |
| `peserta` | `ujian`, `public` | Peserta CANNOT access `/admin/*` (gets 403) |
| (no role) | `public` only | Unauthenticated on protected page → redirect to login |

### Page Classifications
| Page | Scope | Type |
|---|---|---|
| `/AlbEdu/` (root `index.html`) | public | Landing (login-type page) |
| `/AlbEdu/login.html` | public | Login (login-type page) |
| `/AlbEdu/register-admin.html` | public | Login-type page |
| `/AlbEdu/404.html` | public | 404 (special) |
| `/AlbEdu/forgot-password.html` | public | Auth-flow (NOT login-type — no auto-redirect) |
| `/AlbEdu/reset-password.html` | public | Auth-flow (NOT login-type) |
| `/AlbEdu/register-success.html` | public | Auth-flow (NOT login-type) |
| `/AlbEdu/admin/index.html` | admin | Protected dashboard |
| `/AlbEdu/admin/pages/*.html` | admin | Protected sub-page |
| `/AlbEdu/ujian/index.html` | ujian | Protected peserta entry |
| `/AlbEdu/ujian/kerjakan-ujian.html` | ujian | Protected exam runtime |

### Login-type page behavior
A **login-type page** is a public page where an authenticated user is auto-redirected to their dashboard. The set is: `{ login.html, index.html (root only), register-admin.html }`.

Auth-flow pages (`forgot-password.html`, `reset-password.html`, `register-success.html`) are explicitly **excluded** — an authenticated user mid-flow should NOT be yanked to the dashboard.

---

## 5. HTML Link Rules — Per Page Location

### 5.1 From Root (`/AlbEdu/index.html`, `/AlbEdu/404.html`)

| Want to go to | Use |
|---|---|
| Landing page | `href="./"` |
| Login | `href="pages/login.html"` |
| Register | `href="pages/register-admin.html"` |
| CSS | `href="styles/x.css"` |
| Image | `href="public/images/x.svg"` |
| Favicon | `href="public/images/favicon/x.ico"` |

### 5.2 From `pages/*.html` (login, register-admin, forgot-password, reset-password, register-success, 404)

| Want to go to | Use |
|---|---|
| Landing page | `href="../"` |
| Login | `href="login.html"` (same folder) |
| Register | `href="register-admin.html"` (same folder) |
| Forgot password | `href="forgot-password.html"` (same folder) |
| CSS | `href="../styles/x.css"` |
| Image | `href="../public/images/x.svg"` |

### 5.3 From `pages/admin/index.html` and `pages/ujian/index.html`

| Want to go to | Use |
|---|---|
| Landing page | `href="../../"` |
| Admin dashboard | `href="../admin/index.html"` (from ujian) or `href="index.html"` (from admin) |
| Ujian entry | `href="../ujian/index.html"` (from admin) or `href="index.html"` (from ujian) |
| Admin sub-page | `href="pages/buat-ujian.html"` (from admin/index.html) |
| CSS | `href="../../styles/x.css"` |
| Image | `href="../../public/images/x.svg"` |

### 5.4 From `pages/admin/pages/*.html` (buat-ujian, profile, daftar-nama, ujian-peserta, data-hasil)

| Want to go to | Use |
|---|---|
| Admin dashboard (sidebar logo) | `href="../index.html"` (resolves to `pages/admin/index.html`) |
| Landing page (PUBLIC) | `href="../../"` |
| Another admin sub-page | `href="profile.html"` (same folder) |
| Ujian entry | `href="../../ujian/index.html"` |
| CSS | `href="../../../styles/x.css"` |
| Image | `href="../../../public/images/x.svg"` |

### 5.5 From `pages/ujian/kerjakan-ujian.html`

| Want to go to | Use |
|---|---|
| Ujian entry (token form) | `href="./index.html"` or `href="index.html"` |
| Landing page | `href="../../"` |
| CSS | `href="../../styles/x.css"` |
| Image | `href="../../public/images/x.svg"` |

---

## 6. 404 Page Rules

### 6.1 Two 404 files (intentional)

| File | Purpose | Auto-served by GitHub Pages? |
|---|---|---|
| `AlbEdu/404.html` (root) | **Canonical 404** — auto-served for any unmatched URL | ✅ YES |
| `AlbEdu/pages/404.html` (legacy) | Only reachable by direct link | ❌ No (kept for backward compat) |

> ⚠️ **GitHub Pages, Cloudflare Pages, Netlify, and Vercel all serve ONLY the root-level `404.html` as the auto-404.** A `404.html` inside `pages/` is just a regular page — visiting a non-existent URL will NOT show it.

### 6.2 Asset path rules

- **Root `404.html`:** use bare paths (`styles/404.css`, `public/images/favicon/...`). Same as root `index.html`.
- **`pages/404.html`:** use `../`-prefixed paths (`../styles/404.css`, `../public/images/...`). Same as other `pages/*.html`.

### 6.3 The CTA link

Both 404 pages have a "Kembali ke Beranda" button. The correct `href`:

| File | CTA href | Why |
|---|---|---|
| Root `404.html` | `href="./"` (then JS rewrites to absolute `BASE_PATH`) | `./` is too fragile when served from a deep missing path |
| `pages/404.html` | `href="../"` | Resolves to landing page from `pages/` |

The root 404 has an inline `<script>` that computes `BASE_PATH` (same algorithm as `AUTH_CONFIG.BASE_PATH`) and rewrites both CTAs to the absolute path. This handles the case where GitHub Pages serves `/AlbEdu/some/deep/missing-path` — the browser keeps that path as the document base, so a relative `./` would resolve to `/AlbEdu/some/deep/` (wrong).

> ❌ **NEVER use `href="/"` in any 404 page.** It jumps to `https://albedu-id.github.io/` instead of `/AlbEdu/`.

### 6.4 404 + authenticated user behavior

If a logged-in user lands on the 404 page, `_handle404Redirect()` in `main.js` shows a "Halaman tidak ditemukan. Kamu akan diarahkan ke halaman sebelumnya dalam 5 detik." toast and calls `window.history.back()` after 5 seconds (with fallback to role dashboard if no history).

---

## 7. The `navigasi.js` Sidebar Logo — Two-State Behavior

The admin sidebar logo (`.logo-icon-link[data-nav="logo"]`) has TWO states:

### 7.1 EXPANDED state (sidebar visible)
- Logo is a normal `<a>` link to admin dashboard (`../index.html` from `pages/admin/pages/*.html`).
- `navigasi.js` sets `href` to `logoLink.dataset.href || '../index.html'`.
- Click → navigate to admin dashboard.

### 7.2 COLLAPSED state (desktop only, sidebar collapsed)
- Logo becomes a BUTTON that expands the sidebar.
- `navigasi.js` removes `href` attribute (defensive — `<a>` without href can't navigate).
- Click → `expand()` (no navigation).
- Spacebar / Enter also triggers expand (matches native `<button>` semantics).

### 7.3 Mobile (always expanded conceptually)
- Sidebar is an off-canvas drawer, "collapsed" doesn't apply.
- Logo is always a normal link to admin dashboard.
- State is cleared from `localStorage` on mobile.

> **Note:** The sidebar logo NEVER goes to the public landing page. It goes to the admin dashboard. To go to the public landing page, the user clicks "Logout" (which now goes to landing per §3.4).

---

## 8. The `option-profile.js` Logout Flow

The user-profile dropdown in the sidebar (`.user-profile-content`) opens a menu with a "Logout" option. The flow:

```
User clicks "Logout" in dropdown
        ↓
OptionProfile._doLogout() calls window.Auth.authLogout()
        ↓
authLogout() shows confirmation dialog
        ↓ (user confirms)
Step 1-10: cleanup (state, listeners, sessionStorage, Supabase channels, signOut)
        ↓
Step 11: window.location.replace(AUTH_CONFIG.landingUrl())  ← LANDING PAGE (v2.1+)
        ↓
Browser navigates to /AlbEdu/ (root index.html)
```

If `authLogout()` fails for any reason, the catch block also redirects to `landingUrl()` after `LOGOUT_REDIRECT_DELAY_MS` (500ms).

---

## 9. The `byteward.js` Auto-Enforce Bootstrap

`byteward.js` runs on every page that includes it. On page load:

1. Check if current page is a **public page** (login-type or 404). If yes → skip enforcement.
2. Wait for `auth-ready` event (or use fast-path if `Auth.authReady` is already true).
3. Call `checkPageAccess()`:
   - No user + protected page → `_navigateTo(basePath + 'login.html')`
   - User on login-type page → `_navigateTo(role dashboard)`
   - User on 404 → let `_handle404Redirect()` in main.js handle it
   - User accessing disallowed scope (e.g. peserta on `/admin/*`) → `_showAccessDenied()` (403 page)

> **Note:** `byteward.js` uses `Auth.getBasePath()` for its URL construction (not a hardcopy of `BASE_PATH`). This ensures consistency if `AUTH_CONFIG` ever changes.

---

## 10. The OAuth Redirect URL (`supabase-api.js`)

When a user clicks "Login dengan Google", Supabase needs to know where to redirect after Google approves. The redirect URL is computed by `_resolveRedirectUrl()`:

```javascript
// Localhost: return current URL (Supabase needs the exact URL registered)
if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return window.location.href;
}
// Production: derive BASE_PATH (same subfolder walker as AUTH_CONFIG)
// and return origin + pathname (the page user is currently on).
return window.location.origin + window.location.pathname;
```

**Registered redirect URLs in Supabase dashboard must include:**
- `http://localhost:8765/pages/login.html`
- `http://127.0.0.1:8765/pages/login.html`
- `https://albedu-id.github.io/AlbEdu/pages/login.html`
- (Same for `index.html` if peserta OAuth flow is enabled from landing page)

After Google redirects back, Supabase appends `?code=...` (PKCE) or `#access_token=...` (implicit) to the URL. `onAuthStateChanged` fires SIGNED_IN, `_handleAuthStateChange` runs, role is fetched, and `_redirectForRole(role)` sends the user to their dashboard.

---

## 11. Common Pitfalls (DO NOT)

### 11.1 ❌ Hardcoded absolute paths
```javascript
// BAD — breaks on localhost AND on /AlbEdu/ deployment
window.location.href = '/login.html';

// BAD — works on localhost, breaks on /AlbEdu/
window.location.href = '../login.html';

// GOOD — BASE_PATH-aware
window.location.replace(window.Auth.getBasePath() + 'login.html');
```

### 11.2 ❌ `href="/"` in HTML
```html
<!-- BAD — goes to https://albedu-id.github.io/ -->
<a href="/">Home</a>

<!-- GOOD (from root) — goes to /AlbEdu/ -->
<a href="./">Home</a>

<!-- GOOD (from pages/) — goes to /AlbEdu/ -->
<a href="../">Home</a>
```

### 11.3 ❌ Logout redirecting to login
```javascript
// BAD — user has to log in again immediately
window.location.replace(AUTH_CONFIG.loginUrl());

// GOOD — user sees landing page, can choose to log in
window.location.replace(AUTH_CONFIG.landingUrl());
```

### 11.4 ❌ Treating 404 as a way to redirect to dashboard
The 404 page is for genuine "page not found" cases. Don't use `window.location.href = '/404.html'` as a way to bounce users — let `byteward.js` `_showAccessDenied()` handle authorization failures (403), and let `handle404Page()` in byteward handle genuine 404s.

### 11.5 ❌ Using `innerHTML` for navigation
All navigation in AlbEdu uses `setAttribute('href', ...)` or `window.location.replace()`. Never build navigation links via `innerHTML` — XSS risk if URL contains user input.

### 11.6 ❌ Renaming `firebase-ready` event
Despite the Supabase migration, the event name `firebase-ready` is preserved for backward compat. Many legacy scripts listen to it. Do NOT rename to `supabase-ready`.

### 11.7 ❌ Wrong regex when deriving script base URL
When dynamically loading another script based on the current script's `src`, you MUST account for which directory the current script lives in. The navigasi.js bug (v2.1 fix) is the canonical example:

```javascript
// BAD — navigasi.js is at src/utils/navigasi.js
// This strips only 'navigasi.js', leaving 'src/utils/'.
// Then appending 'editor-panel.js' tries to load src/utils/editor-panel.js (404!).
const navSrc = document.querySelector('script[src*="navigasi.js"]')?.src || '';
const base   = navSrc.replace(/navigasi\.js.*$/, '');  // ❌ leaves 'src/utils/'
s.src = base + 'editor-panel.js';                       // ❌ src/utils/editor-panel.js

// GOOD — strip 'utils/navigasi.js' and replace with 'profile/'
// to land in the correct directory.
const base = navSrc.replace(/utils\/navigasi\.js.*$/, 'profile/');  // ✅ 'src/profile/'
s.src = base + 'editor-panel.js';                                   // ✅ src/profile/editor-panel.js
```

The general rule: **if the current script is in directory A and the target script is in directory B, the regex must strip A's name AND the filename, then append B's name.** Just stripping the filename leaves you in A, which is wrong if A ≠ B.

The cleanest pattern is in `src/utils/navigasi.js` `_resolveProfileScriptBase()` (v2.1+) — read it as the reference implementation.

---

## 12. Quick Lookup — "I Want To..."

| Task | File(s) to edit |
|---|---|
| Change logout destination | `src/auth/main.js` (`AUTH_CONFIG.landingUrl()`, `authLogout()` Step 11) |
| Change post-login redirect per role | `src/auth/main.js` (`AUTH_CONFIG.pathForRole()`) |
| Add a new admin page | Create `pages/admin/pages/{name}.html`, `src/pages/{name}.js`, `styles/{name}.css`. Use 3-level-deep paths (`../../../`). |
| Add a new public page | Create `pages/{name}.html`. Use 2-level-deep paths (`../`). Add filename to `_PUBLIC_ENTRY_FILES` in main.js if it should auto-redirect logged-in users. |
| Change 404 behavior | `404.html` (canonical), `pages/404.html` (legacy), `src/auth/main.js` (`_handle404Redirect`), `src/auth/byteward.js` (`handle404Page`) |
| Change sidebar logo target | `src/utils/navigasi.js` (`syncAriaLabels()`, the `logoLink.dataset.href || '../index.html'` line) |
| Add a new role | `AUTH_CONFIG.pathForRole()` (add to map), `byteward.js SCOPE_POLICY` (add allowed scopes), `src/auth/main.js` `_PUBLIC_ENTRY_FILES` (no change usually) |
| Change BASE_PATH detection | `AUTH_CONFIG.BASE_PATH` IIFE in `src/auth/main.js`. Also update `404.html` inline script. Also update `supabase-api.js` `_resolveRedirectUrl()`. |
| Debug a redirect loop | Open DevTools, filter Console by `[AuthRedirect]` or `[ByteWard]`. Check `Auth.debugByteWard()` output. |
| Verify all links work after deployment | Run `npm run verify`, then crawl with a link checker (e.g. `lychee` against the deployed URL). |

---

## 13. Deployment Checklist

Before pushing to `main` (which auto-deploys to GitHub Pages):

- [ ] `npm run verify` passes (structure integrity check)
- [ ] `npm run build` produces `dist/` with no errors
- [ ] Root `404.html` is present at project root (NOT just in `pages/`)
- [ ] All HTML files use page-relative asset paths (no `href="/"`)
- [ ] All JS redirects go through `window.Auth` helpers
- [ ] Logout goes to landing page (test: log in → log out → verify URL is `/AlbEdu/`)
- [ ] Login page after authed visit auto-redirects to dashboard
- [ ] Unauthenticated visit to `/AlbEdu/admin/index.html` redirects to `/AlbEdu/pages/login.html`
- [ ] Visiting a non-existent URL (e.g. `/AlbEdu/foo/bar`) shows the root 404 page
- [ ] Supabase dashboard has all redirect URLs registered (see §10)

---

## 14. Version History

| Version | Date | Change |
|---|---|---|
| 0.2.0 | 2026-06-30 | **Version reset by owner Albi Fahriza.** Redesigned `pages/admin/pages/buat-ujian.html` again — reverted from 4-card dashboard back to step-based wizard (3 steps: Informasi+Identitas+Tema, Soal, Publish) per owner preference. List view is now default; clicking "Buat Ujian Baru" button reveals the wizard. Hybrid: tema color pickers (CU/HJ/TW) moved INTO Step 1, replacing the old `theme.tema` dropdown. Pengaturan Lanjutan card DELETED (max_halaman hardcoded to 3, never user-editable). localStorage draft system DELETED (publish is the only save action). Custom-styled all form controls (no default Chrome UI): custom select arrows, radio/checkbox, datetime picker, number spinner (hidden), focus ring (AlbEdu blue), autofill background override, scrollbar. Replaced Vercel black/white palette with AlbEdu white-blue (`--bu-accent: #2563eb`). Header switched from custom `.bu-header` to standard `.header` (consistent with other admin pages). Added `wizard-controller.js` (step nav + view toggle) and `list-view.js` (live exam list from Supabase via onSnapshot). Deleted `settings-card.js` + `draft-storage.js`. Keyboard shortcuts simplified: Cmd+S removed, Cmd+Enter (publish/next), Cmd+N (new question). After publish, returns to list view (no longer redirects to ujian-peserta.html). |
| 2.2.0 | 2026-06-30 | Redesigned `pages/admin/pages/buat-ujian.html` — replaced modal-wizard flow with full-page Vercel-style dashboard (4 stacked cards). Deleted `src/wizard/` entirely (controller.js, state.js, dom.js, validation.js, index.js — 3622 LOC) and `styles/wizard.css` + `styles/buat-ujian.css` (2906 LOC). Added `src/pages/buat-ujian/` folder with 9 new modules: `metadata-card.js`, `soal-card.js`, `soal-editor-modal.js`, `settings-card.js`, `publish-card.js`, `templates.js`, `keyboard-shortcuts.js`, `draft-storage.js`, `index.js`. New page controller `src/pages/buat-ujian.js` exposes `window.BuatUjian` (central state + schema-accurate validation + score auto-distribution). Schema unchanged (table `ujian`, PK `kode_id`, pilihan `{A,B,C,D}` object, `identity_mode`+`identity_config` replacing dropped `kelas`). Save strategy: localStorage draft auto-save (1500ms debounce) + Supabase publish via runTransaction (INSERT-only, no update). Added `--bu-*` design tokens to `tokens.css`. Added `styles/buat-ujian-v2.css` + `styles/buat-ujian-modal.css`. Updated `scripts/verify-structure.mjs` (removed `src/wizard/*` from CRITICAL_JS, added `src/pages/buat-ujian/*`). Keyboard shortcuts: Cmd+S (save draft), Cmd+Enter (publish), Cmd+N (add question). |
| 2.1.3 | 2026-06-29 | CRITICAL: IIFE-wrapped `errors.js`, `user-helpers.js`, `byteward.js`. Top-level `const`/`class`/`function` declarations were leaking into the global lexical environment (classic scripts share it), causing `SyntaxError: Identifier 'CompletionError' has already been declared` when `main.js` tried `const CompletionError = window.CompletionError;`. Same issue affected 9 constants + 6 functions in `user-helpers.js` and 5 functions in `byteward.js`. Bug existed since v2.0.0 by-feature restructure. Added Check 9c to verify-structure.mjs (catches top-level name conflicts across classic scripts). |
| 2.1.2 | 2026-06-29 | CRITICAL: Added `errors.js` + `user-helpers.js` `<script>` tags to all 9 HTML pages that load `main.js`. Bug existed since v2.0.0 — `main.js` reads `window.AuthHelpers.isDev` at eval time, but `user-helpers.js` was never loaded in any HTML file → `TypeError: Cannot read properties of undefined` → `window.Auth` never defined → ALL auth flows broken. Added Check 9b to verify-structure.mjs (regression prevention). |
| 2.1.1 | 2026-06-29 | Auth critical fix: defined `_createUserDocViaServer()` in `src/auth/main.js` (was called in 3 places but NEVER defined — broke ALL new user logins silently with a ReferenceError caught by the outer try/catch → force signOut). Added `_extractFunctionErrorCode()` helper for parsing Supabase FunctionsHttpError. |
| 2.1.0 | 2026-06-29 | Added `landingUrl()`, logout now goes to landing page (was login). Created root `404.html`. Fixed landing page `href="/"` bug. Added this file. Fixed navigasi.js `_resolveProfileScriptBase()` — ProfileEditorPanel + OptionProfile were silently 404ing on 4 of 5 admin pages due to wrong regex (stripped filename but not `utils/` directory). Added §11.7 pitfall. |
| 2.0.0 | 2026-06-28 | By-feature structure, auth.js split, CSS consolidation. |
| 1.0.5 | 2026-06-26 | Performance optimization, 27 bugs fixed, XSS hardening. |
| 1.0.0 | 2026-Q1 | Initial Supabase migration from Firebase. |

---

## 15. Related Files

| File | Role in routing |
|---|---|
| `src/auth/main.js` | `AUTH_CONFIG`, `_navigateTo`, `_redirectToLogin`, `_redirectForRole`, `authLogout`, `_handleAuthStateChange`, `_handle404Redirect`, `_getRouteScope` |
| `src/auth/byteward.js` | `_getRouteScope`, `checkPageAccess`, `handle404Page`, `_showAccessDenied`, auto-enforce bootstrap |
| `src/auth/user-helpers.js` | Timing constants (`REDIRECT_DELAY_MS`, `LOGOUT_REDIRECT_DELAY_MS`, `PAGE_404_REDIRECT_DELAY_MS`) |
| `src/utils/navigasi.js` | Sidebar logo two-state behavior, mobile drawer, profile panel bootstrap |
| `src/profile/option-profile.js` | User dropdown menu (logout trigger) → calls `Auth.authLogout()` |
| `src/utils/supabase-api.js` | OAuth redirect URL resolution (`_resolveRedirectUrl`) |
| `src/auth/forgot-password.js` | Forgot-password redirect URL (preserves BASE_PATH via `pathname.replace`) |
| `src/auth/reset-password.js` | Post-reset redirect to `login.html` (same folder, relative) |
| `src/auth/admin-onboarding.js` | Post-register redirect to `register-success.html` (same folder, relative) |
| `src/pages/panel.js` | Admin dashboard nav card click → `data-link` href navigation |
| `src/pages/kerjakan-ujian.js` | Exam runtime: back-to-token-entry (`./index.html`), login fallback (BASE_PATH-aware) |
| `404.html` (root) | Canonical 404 page (auto-served by GitHub Pages) |
| `pages/404.html` | Legacy 404 (only reachable by direct link) |
| `index.html` | Landing page (root, public) |
| `pages/login.html` | Admin login (public, login-type) |
| `pages/admin/index.html` | Admin dashboard (protected, scope=admin) |
| `pages/ujian/index.html` | Peserta token entry (protected, scope=ujian) |

---

## 16. AI Assistant Quick-Start

If you're an AI assistant (Claude, GPT, Copilot, etc.) editing AlbEdu routing:

1. **READ THIS FILE FIRST** (you're here — good).
2. **READ `docs/AI-CONTEXT.md`** for the broader "where is X" lookup table.
3. **RUN `npm run dev`** before and after edits to verify no console errors.
4. **TEST IN 3 LOCATIONS** if you change routing:
   - `http://127.0.0.1:8765/` (localhost, BASE_PATH = `/`)
   - Open the deployed `/AlbEdu/` URL after push (BASE_PATH = `/AlbEdu/`)
   - Test a deep URL like `/AlbEdu/admin/pages/buat-ujian.html` to verify subfolder paths
5. **USE `window.Auth` HELPERS** for any redirect — never raw `window.location.*`.
6. **NEVER USE `href="/"`** — it's the #1 cause of "logo goes to wrong page" bugs.
7. **NEVER HARDCODE `/AlbEdu/`** — `BASE_PATH` is environment-agnostic for a reason.

When in doubt, search the codebase:
```bash
rg "href=['\"]\/['\"]" --type html  # find any absolute-path href (should be ZERO matches)
rg "location\.replace\(['\"]" src/  # find raw redirects (should ALL go through Auth helpers)
```
