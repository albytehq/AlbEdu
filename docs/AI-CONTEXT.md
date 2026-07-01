# AI-CONTEXT — Cheat Sheet for AI Assistants

> File ini buat AI assistant (Claude, GPT, Copilot, dst.) cepat onboard ke project AlbEdu.
> **READ THIS FIRST** sebelum edit code apapun.

**Last verified:** 2026-06-28 (v2.0.0)

---

## TL;DR

- **Stack:** Vanilla JS (no framework) + Supabase + Cloudflare Worker
- **Structure:** Strict by-feature (`src/{feature}/index.js` as entry)
- **Patterns:** Mix classic scripts (`window.X`) + ES modules (`import/export`) — gradual migration to ESM
- **Tests:** Custom Node.js runner di `tests/` folder
- **Build:** `npm run build` (esbuild + lightningcss → `dist/`)
- **Dev:** `npm run dev` (port 8765, landing page langsung di `/` root)

---

## Quick Lookup — "Kalau disuruh X, edit file Y"

| Task | File(s) to edit |
|---|---|
| Fix login bug | `src/auth/main.js`, `src/auth/user-auth-portal.js`, `pages/login.html` |
| Add new exam question type | `src/exam/logic.js`, `src/exam/viewer.js`, `src/identity/form-builder.js` |
| Change Buat Ujian v0.2.0 page behavior | `src/pages/buat-ujian.js`, `src/pages/buat-ujian/*.js` (modules), `styles/buat-ujian-v2.css`, `styles/buat-ujian-modal.css` |
| Update navigation menu | `src/utils/navigasi.js`, `pages/admin/index.html` |
| Add new admin page | Bikin `pages/admin/pages/{name}.html`, `src/pages/{name}.js`, `styles/{name}.css` |
| Fix notification styling | `public/QNotify/ui/*.css` |
| Update Supabase schema | `supabase/migrations/{date}_{name}.sql` |
| Change auth redirect logic | `src/auth/main.js` (cari `_redirectToLogin`, `_redirectForRole`, `authLogout`) — **read [`rule-url-albedu.md`](../rule-url-albedu.md) FIRST** |
| Change logout destination | `src/auth/main.js` Step 11 of `authLogout()` — logout goes to LANDING PAGE (`landingUrl()`), NOT login. See `rule-url-albedu.md §3.4` |
| Change 404 page | `404.html` (canonical, project root) + `pages/404.html` (legacy) — see `rule-url-albedu.md §6` |
| Change post-login redirect | `src/auth/main.js` `AUTH_CONFIG.pathForRole()` |
| Change BASE_PATH detection | `src/auth/main.js` `AUTH_CONFIG.BASE_PATH` IIFE + `404.html` inline script + `src/utils/supabase-api.js` `_resolveRedirectUrl()` |
| Fix any "logo navigates to wrong page" bug | Check for `href="/"` in HTML files — NEVER use it. Use `./`, `../`, or `../../` depending on file location. See `rule-url-albedu.md §5` |
| Add new profile field | `src/auth/user-helpers.js` (`normalizeUserDoc`), `src/profile/editor-panel.js`, `pages/admin/pages/profile.html` |
| Fix exam anti-cheat | `src/exam/guardian.js` |
| Change Turnstile config | `src/auth/constants.js` (`AUTH_CONFIG.TURNSTILE_SITE_KEY`) |
| Fix error message mapping | `src/auth/error-mapper.js` |
| Update exam token validation | `src/exam/admin-controller.js`, `supabase/functions/exam-token-attempt/index.ts` |
| Add new CSS design token | `styles/tokens.css` |
| Fix loading indicator | `styles/loading.css`, `src/utils/ui.js` (`_ensureLoadingCSS`) |
| Update favicon/logo | `public/images/favicon/`, `public/images/logo.svg` |
| Change rate limit config | `src/auth/constants.js` (`RATE_LIMITS`) |
| Fix exam draft autosave | `src/exam/logic.js` (cari `_saveDraft`) |
| Add new Buat Ujian v0.2.0 module | `src/pages/buat-ujian/{module-name}.js`, register in `src/pages/buat-ujian/index.js`, load via `<script defer>` in `pages/admin/pages/buat-ujian.html`, init from `src/pages/buat-ujian.js` DOMContentLoaded |
| Update QNotify XSS sanitize | `public/QNotify/security/sanitize.js` |
| Change logout behavior | `src/auth/main.js` (cari `authLogout`, `_confirmLogout`) |

---

## Common Pitfalls (DO NOT)

- ❌ **Jangan** edit `window.Auth` API tanpa update `src/auth/main.js` public API section juga
- ❌ **Jangan** tambah inline `<style>` di HTML — extract ke `styles/`
- ❌ **Jangan** import langsung dari submodule (e.g., `../pages/buat-ujian/metadata-card.js`) — pakai `../pages/buat-ujian/index.js`
- ❌ **Jangan** rename file tanpa update semua HTML refs yang load file itu
- ❌ **Jangan** edit `public/QNotify/` kalau bukan bug fix — itu vendor library
- ❌ **Jangan** tambah `default export` — pakai named exports saja
- ❌ **Jangan** hardcode Supabase URL — pakai `src/utils/supabase-api.js` bridge (fetch dari Cloudflare Worker)
- ❌ **Jangan** direct query Supabase dari UI tanpa RLS — pakai edge functions untuk privileged operations
- ❌ **Jangan** gunakan `innerHTML` dengan user-controlled input — pakai `escapeHTML()` dari `src/auth/user-helpers.js`
- ❌ **Jangan** hapus `window.X = X` global assignments — classic scripts depend on them
- ❌ **Jangan** ubah `firebase-ready` event name — banyak code lama listen ke event ini (Supabase compat)
- ❌ **Jangan** pakai `href="/"` di HTML apapun — itu navigate ke `https://albedu-id.github.io/` (GitHub profile), BUKAN ke `/AlbEdu/` (app). Pakai `./`, `../`, atau `../../`. Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §5.
- ❌ **Jangan** hardcode `/AlbEdu/` di JS — pakai `window.Auth.getBasePath()` (BASE_PATH auto-detected, environment-agnostic)
- ❌ **Jangan** redirect logout ke `login.html` — pakai `AUTH_CONFIG.landingUrl()` (root index.html). Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §3.4.
- ❌ **Jangan** taruh 404.html cuma di `pages/` — GitHub Pages hanya auto-serve 404.html di project root. Selalu maintain `404.html` di root. Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §6.

---

## DO

- ✅ Baca `docs/ARCHITECTURE.md` sebelum edit structural code
- ✅ Baca [`rule-url-albedu.md`](../rule-url-albedu.md) sebelum edit apapun yang berhubungan dengan URL, link, redirect, atau 404
- ✅ Run `npm run dev` sebelum dan sesudah edit, verify tidak ada console error
- ✅ Pakai `git mv` untuk rename/move file (preserve history)
- ✅ Tambah header comment di setiap file JS baru (lihat template di `docs/CONTRIBUTING.md`)
- ✅ Update `docs/AI-CONTEXT.md` kalau add new feature
- ✅ Pakai barrel exports via `index.js` untuk cross-feature imports
- ✅ Test di 3 browser (Chrome, Firefox, Safari) untuk CSS changes
- ✅ Run `npm run verify` setelah structural changes
- ✅ Pakai `escapeHTML()` dari `src/auth/user-helpers.js` untuk semua user input
- ✅ Pakai CSS custom properties dari `styles/tokens.css` untuk warna/spacing
- ✅ Tambah `defer` attribute di semua `<script>` tags
- ✅ Load `tokens.css` FIRST di setiap HTML (di `<head>` sebelum CSS lain)
- ✅ Pakai `window.Auth.getBasePath()` / `getLandingPath()` / `getRoleRedirectPath()` untuk semua redirect
- ✅ Pakai `href="./"` (dari root) atau `href="../"` (dari `pages/`) untuk link ke landing page

---

## Module Pattern Recognition

### Pattern 1: Classic Script (window.X global)

Untuk backward compatibility, sebagian besar file pakai pola IIFE + window global.

```javascript
// File: src/utils/ui.js
const UI = {
    showAuthLoading: () => { ... },
    hideAuthLoading: () => { ... }
};
window.UI = UI;  // expose global
```

Loaded via: `<script src="../src/utils/ui.js" defer>`

### Pattern 2: ES Module (import/export)

Untuk file baru yang tidak perlu backward compat.

```javascript
// File: src/auth/user-auth-portal.js
import { runPreflightValidation } from './index.js';

export class UserAuthPortal { ... }
```

Loaded via: `<script type="module" src="../src/auth/user-auth-portal.js"></script>`

### Pattern 3: Hybrid (Module + window global)

Untuk file yang perlu diakses dari kedua pola.

```javascript
// File: src/auth/main.js
const Auth = { ... };
window.Auth = Auth;  // classic scripts can access
// (no export — loaded as classic script with defer)
```

---

## File Location Quick Reference

### "Saya mau cari..."

| Yang dicari | Lokasi |
|---|---|
| Auth login/logout logic | `src/auth/main.js` |
| Auth state (currentUser, dll) | `src/auth/main.js` (private vars) |
| Cloudflare Turnstile | `src/auth/turnstile.js` |
| Device fingerprint | `src/auth/device-fingerprint.js` |
| Preflight validation | `src/auth/preflight.js` |
| Error messages (Indonesian) | `src/auth/error-mapper.js` |
| Auth constants (timings, rate limits) | `src/auth/constants.js` |
| Buat Ujian v0.2.0 — central state + schema validation | `src/pages/buat-ujian.js` (`window.BuatUjian`) |
| Buat Ujian v0.2.0 — Step 1 (info + identity + theme colors) | `src/pages/buat-ujian/metadata-card.js` |
| Buat Ujian v0.2.0 — Step 2 (sections + questions list) | `src/pages/buat-ujian/soal-card.js` |
| Buat Ujian v0.2.0 — Step 2 question editor modal | `src/pages/buat-ujian/soal-editor-modal.js` |
| Buat Ujian v0.2.0 — Step 3 (summary + token + publish) | `src/pages/buat-ujian/publish-card.js` |
| Buat Ujian v0.2.0 — step nav + list/wizard view toggle | `src/pages/buat-ujian/wizard-controller.js` |
| Buat Ujian v0.2.0 — list view (exam cards from Supabase) | `src/pages/buat-ujian/list-view.js` |
| Buat Ujian v0.2.0 — question templates (PG, Esai) | `src/pages/buat-ujian/templates.js` |
| Buat Ujian v0.2.0 — keyboard shortcuts | `src/pages/buat-ujian/keyboard-shortcuts.js` |
| Buat Ujian v0.2.0 — page styling (AlbEdu white-blue) | `styles/buat-ujian-v2.css`, `styles/buat-ujian-modal.css` |
| Exam data fetch/save | `src/exam/data.js` |
| Exam timer/expiry | `src/exam/expiry-manager.js` |
| Exam anti-cheat | `src/exam/guardian.js` |
| Exam state machine | `src/exam/logic.js` |
| Exam UI rendering | `src/exam/viewer.js` |
| Identity form builder | `src/identity/form-builder.js` |
| Identity form renderer | `src/identity/form-renderer.js` |
| Profile panel | `src/profile/editor-panel.js` |
| Profile options menu | `src/profile/option-profile.js` |
| Navigation sidebar | `src/utils/navigasi.js` |
| UI helpers (loading, toast) | `src/utils/ui.js` |
| Error manager | `src/utils/error-manager.js` |
| Math rendering (KaTeX) | `src/utils/math-renderer.js` |
| Math paste converter | `src/utils/math-paste-converter.js` |
| Image compression | `src/utils/image-compress.js` |
| Image cleanup | `src/utils/image-cleanup.js` |
| Self-storage (IndexedDB) | `src/utils/self-storage.js` |
| Admin notification center | `src/utils/admin-notification-center.js` |
| Supabase bridge | `src/utils/supabase-api.js` |
| Logout confirmation | `src/auth/main.js` (`_confirmLogout`, `authLogout`) — **logout redirects to LANDING PAGE**, see `rule-url-albedu.md §3.4` |
| Profile completeness check | `src/auth/user-helpers.js` (`isProfileComplete`) |
| Avatar URL generation | `src/auth/user-helpers.js` (`buildAvatarUrl`) |
| HTML escape (XSS prevention) | `src/auth/user-helpers.js` (`escapeHTML`) |
| BASE_PATH detection | `src/auth/main.js` (`AUTH_CONFIG.BASE_PATH` IIFE) — see `rule-url-albedu.md §2` |
| 404 page (canonical) | `404.html` (project root) — see `rule-url-albedu.md §6` |
| 404 page (legacy) | `pages/404.html` (only reachable by direct link) |
| OAuth redirect URL | `src/utils/supabase-api.js` (`_resolveRedirectUrl`) |
| Profile script base resolver | `src/utils/navigasi.js` (`_resolveProfileScriptBase`) — used to dynamically load `editor-panel.js` and `option-profile.js` from `src/profile/` |
| Server-side user provisioning | `src/auth/main.js` (`_createUserDocViaServer`) — invokes `user-auth-complete` Edge Function with Bearer token + preflight data. CRITICAL: must be defined; was missing before v2.1.1 (broke all new user logins). |
| Supabase function error code extractor | `src/auth/main.js` (`_extractFunctionErrorCode`) — parses FunctionsHttpError → backendCode string |
| Auth flow orchestration | `src/auth/main.js` (`_handleAuthStateChange`, `_syncUserDocument`, `authLogin`, `authLogout`) |
| Turnstile widget lifecycle | `src/auth/turnstile.js` (`getFreshTurnstileToken`, `renderTurnstile`, `resetTurnstile`) |
| Preflight validation flow | `src/auth/preflight.js` (`executePreflightFlow`, `runPreflightValidation`) — creates preflight session before Google OAuth |
| Email verification gate | `src/auth/main.js` (`_handleAuthStateChange` Patch A — reads `user._supabaseUser?.email_confirmed_at`) |

---

## Auth Flow Quick Reference

AlbEdu auth has 4 entry points and 1 server-side completion function. **Read this before editing any auth code.**

### Entry Points

| Flow | Entry File | UI Elements | Result |
|---|---|---|---|
| Google login (admin + peserta) | `src/auth/user-auth-portal.js` | `#userLoginBtn`, `#userLoginBtn2` | Pre-flight + Google OAuth redirect → role dashboard |
| Email/password login (admin) | `src/auth/user-auth-portal.js` | `#emailLoginForm` | Direct Supabase `signInWithPassword` → role dashboard |
| Admin registration | `src/auth/admin-onboarding.js` | `#adminRegisterForm` | Invoke `register-admin` Edge Function → `register-success.html` |
| Forgot password | `src/auth/forgot-password.js` | `#forgotPasswordForm` | Supabase `resetPasswordForEmail` → success state |
| Reset password (from email link) | `src/auth/reset-password.js` | `#resetPasswordForm` | Supabase `updateUser` → login.html after 3s |

### Google Login Flow (detailed)

```
User clicks "Masuk dengan Google"
   ↓
user-auth-portal.js handleGoogleLogin():
   1. waitForSupabaseReady()                    — authFlow.js
   2. executePreflightFlow()                    — preflight.js
      ├─ getStoredPreflight() — cache check
      ├─ getFreshTurnstileToken(container)      — turnstile.js
      └─ runPreflightValidation(token)          — preflight.js
         └─ window.sb.functions.invoke('user-auth-preflight', body)
         └─ storePreflight(result) → sessionStorage
   3. window.Auth.authLogin()                   — main.js
      └─ window.firebaseAuth.signInWithPopup()  — supabase-api.js shim
         └─ window.sb.auth.signInWithOAuth()    — redirect to Google
   ↓
[Browser redirects to Google → user approves → redirects back]

   ↓
SupabaseApi.js onAuthStateChange fires (SIGNED_IN)
   ↓
main.js _handleAuthStateChange(user):
   1. Patch A: email verification gate
      └─ if !user._supabaseUser?.email_confirmed_at → signOut + return
   2. _syncUserDocument(user.uid)              — main.js
      ├─ _getDb().collection('users').doc(userId).onSnapshot()
      ├─ If user exists → _applyUserSnapshot(data)
      └─ If user missing → _createUserDoc(userId)
         └─ _createUserDocViaServer(userId)    — main.js (v2.1.1 FIX)
            ├─ _getUserPreflight()             — user-helpers.js
            ├─ window.sb.auth.getSession()     — get Bearer token
            ├─ window.sb.functions.invoke('user-auth-complete', {
            │     headers: { Authorization: Bearer <token> },
            │     body: { preflightId, deviceId, browserHash, deviceInfo }
            │  })
            ├─ On error → _extractFunctionErrorCode() → throw CompletionError
            └─ On success → return data.user
   3. Dispatch 'auth-ready' event with role
   4. If on login page → _redirectForRole(role) → dashboard
```

### Error Event Flow

When `_createUserDocViaServer` throws a `CompletionError`:
1. `_syncUserDocument` rejects with the error
2. `_handleAuthStateChange` outer try/catch catches it
3. Dispatches `auth-completion-error` event with `{backendCode, message}`
4. `user-auth-portal.js` listens for this event → shows error to user
5. User is force-signed-out (session is invalid without a user doc)
6. UI resets to idle after 5s

**CRITICAL**: If `_createUserDocViaServer` is undefined (the v2.1.1 bug), step 1 throws `ReferenceError` instead of `CompletionError`. The catch block only handles `CompletionError` specially — `ReferenceError` falls through, user sees nothing, gets silently signed out. This is exactly what was happening before v2.1.1.

### Edge Functions

| Function | File | Purpose |
|---|---|---|
| `user-auth-preflight` | `supabase/functions/user-auth-preflight/index.ts` | Validates Turnstile token + device fingerprint, returns preflightId (15-min TTL) |
| `user-auth-complete` | `supabase/functions/user-auth-complete/index.ts` | Verifies preflight, creates user row in `users` table if missing, upserts `user_devices` row, returns user profile |
| `register-admin` | `supabase/functions/register-admin/index.ts` | Public admin registration (no auth required) — Turnstile + device limit + creates user with `peran='admin'` |
| `exam-token-attempt` | `supabase/functions/exam-token-attempt/index.ts` | Validates 5-digit exam token + tracks attempts per device |

### Testing Auth

Run the auth unit tests:
```bash
node /home/z/my-project/scripts/test-auth-functions.mjs   # 33 unit tests
node /home/z/my-project/scripts/test-auth-modules.mjs      # 10 module import tests
```

---

## Database Quick Reference

### Tables

- `users` — { id (UUID), email, peran ('admin'|'peserta'), nama, foto_profil, created_at }
- `exams` — { id, kode_id (5-digit), judul, mata_pelajaran, kelas, mode, durasi, soal (JSONB), access_control (JSONB), created_by, created_at }
- `exam_tokens` — { token (5-digit), exam_id, used_at, used_by }
- `exam_attempts` — { id, exam_id, user_id, identity_id, jawaban (JSONB), score, started_at, submitted_at }
- `identities` — { id, exam_id, nama, kelas, nis, metadata (JSONB), created_at }

### RLS Policies

- `users`: user can read own row only
- `exams`: admin can CRUD, peserta can read where token matches
- `exam_attempts`: user can read own attempts only
- `identities`: user can read identities for exams they have token for

### Edge Functions

- `user-auth-preflight` — Verify device limits before Google OAuth
- `user-auth-complete` — Create user doc after Google OAuth (verifies preflight)
- `register-admin` — Admin registration with Turnstile + rate limit
- `exam-token-attempt` — Validate exam token & track attempts

---

## Build Pipeline

```
Source (src/, styles/, pages/, public/)
    ↓
npm run dev  ──► scripts/serve.mjs (port 8765, no minify)
    OR
npm run build ──► scripts/minify.mjs
                    ├── esbuild (JS minify, target es2020)
                    ├── lightningcss (CSS minify)
                    └── Output: dist/ directory
                        ├── src/         (minified JS)
                        ├── styles/      (minified CSS)
                        ├── pages/       (HTML copied)
                        ├── public/      (assets copied)
                        └── supabase/    (backend copied)
```

Deploy `dist/` ke static host (GitHub Pages, Cloudflare Pages, Netlify, Vercel).

---

## Test Commands

```bash
npm run dev          # Start dev server
npm run build        # Minify to dist/
npm run verify       # Structure integrity check
npm run lint         # ESLint (if configured)
```

---

## When You're Stuck

1. **Check `docs/ARCHITECTURE.md`** — module dependency graph, data flow, ADRs
2. **Check `docs/MIGRATION.md`** — kalau masalah berkaitan dengan path atau v1→v2 migration
3. **Check `docs/UPDATE-GUIDE.md`** — kalau masalah post-v1.0.5 update
4. **Check this file** — Quick Lookup table untuk locate feature
5. **Run `npm run dev`** — test di browser, cek console error
6. **Run `npm run verify`** — pastikan struktur file intact
7. **Grep for the function name** — `grep -rn "functionName" src/`

---

## Common Error Patterns

### "X is not defined" di browser console

Penyebab: file JS belum di-load, atau load order salah.
Solusi:
1. Cek HTML file — pastikan `<script src="...">` untuk file yang dimaksud ada
2. Pastikan `defer` attribute ada (supaya script jalan setelah DOM parse)
3. Untuk ES modules, pastikan `<script type="module">` digunakan
4. Cek Network tab di DevTools — pastikan file ter-load dengan 200 status

### "Cannot read property 'X' of null"

Penyebab: `window.X` belum di-set saat code jalan.
Solusi:
1. Cek load order — script yang set `window.X` harus load SEBELUM script yang baca
2. Gunakan `typeof X !== 'undefined'` guard
3. Atau listen `'firebase-ready'` / `'auth-ready'` event sebelum akses auth state

### "Failed to fetch" / CORS error

Penyebab: Cloudflare Worker CORS tidak include origin yang dipakai.
Solusi:
1. Update `ALLOWED_ORIGINS` di Worker code
2. Atau tambahkan pattern match untuk localhost
3. Deploy Worker baru via `wrangler deploy`

### Inline `<style>` tidak di-render

Penyebab: HTML file mungkin punya multiple `<style>` blocks, dan yang satu error.
Solusi:
1. Cek DevTools → Elements → `<head>` — pastikan `<style>` block ada
2. Cek CSS syntax error di console
3. Kalau perlu, extract ke external CSS file

---

## Version History

| Version | Date | Key Changes |
|---|---|---|
| 2.1.8 | 2026-06-29 | Fixed sidebar profile layout bug: `.user-info` class in navigasi.css was being overridden by the same-named class in profile.css and ujian.css (which load on the same admin pages). The generic `.user-info` (specificity 0,1,0) from profile.css set `text-align:center; margin-bottom:32px; animation:slideInRight` and from ujian.css set `margin-top; padding-top; border-top; text-align:center` — all of which broke the sidebar's avatar+name+role layout. Fix: scoped sidebar styles to `.user-profile .user-info` (specificity 0,2,0) with explicit resets (`text-align:left; margin:0; padding:0; border:none; animation:none`). VLM-verified: clean layout, no divider, tight spacing. |
| 2.1.7 | 2026-06-29 | Two fixes: (1) CRITICAL logout bug — `landingUrl()` was returning `/AlbEdu/pages/` (404, no index.html) instead of `/AlbEdu/` (actual landing page). Fix: strip trailing `pages/` from BASE_PATH in `landingUrl()`. Verified with 10 test cases covering all page paths. (2) Removed "Live" badge from notification header + "Real-time aktif" text from footer per user request. Footer now shows "Terhubung" (Connected) with green status dot. |
| 2.1.6 | 2026-06-29 | Notification panel header layout fix: 2-row layout to prevent element crowding/overlap. Row 1: title + Live badge + close button. Row 2: Baca Semua + Hapus Semua buttons side-by-side (flex:1, even spacing). Sub-text now has white-space:nowrap + text-overflow:ellipsis to prevent truncation wrap. Header height increased 76px → 108px to accommodate 2 rows. Mobile (<480px): button text labels hidden, only icons shown. VLM-verified: no element collisions, all text fully visible. |
| 2.1.5 | 2026-06-29 | Notification center full LIGHT theme conversion (notification-panel.css v0.5.1). Header converted from dark glass-morphism gradient to clean white background with subtle slate border + thin brand-color accent strip on top. Header icon container: dark translucent → brand-soft (light blue) tint. Title text: white → slate-900. Live badge: light-on-dark green → dark-green on light-green tint. All header buttons: ghost-on-dark → clean white with slate borders. Close button: ghost-on-dark → white with slate border. Severity tints (red/orange/green) on notification items preserved. |
| 2.1.4 | 2026-06-29 | Major UI upgrade: enterprise redesign of AdminNotificationCenter (notification-panel.css v0.5.0). Dark glass-morphism header with Live badge, sliding pill tabs with tabular-nums counters, refined notification items with rounded-square icons + severity-tinted borders, critical items pulse animation, hover-revealed action buttons, refined empty state with rotating dashed ring + contextual messaging, footer with live status dot + last-updated timestamp. All animations respect prefers-reduced-motion. VLM-rated 8/10 for enterprise polish. |
| 2.1.3 | 2026-06-29 | CRITICAL: IIFE-wrapped `errors.js`, `user-helpers.js`, `byteward.js` — top-level `const`/`class`/`function` declarations were leaking into the global lexical environment and causing `SyntaxError: Identifier 'X' has already been declared` when `main.js` re-declared them as `const X = window.X;`. Bug existed since v2.0.0 by-feature restructure. Added Check 9c to verify-structure.mjs to catch this bug class. |
| 2.1.2 | 2026-06-29 | CRITICAL: Added `errors.js` + `user-helpers.js` `<script>` tags to all 9 HTML pages that load `main.js`. These were missing since v2.0.0 by-feature restructure — `main.js` was reading `window.AuthHelpers.isDev` at eval time but `user-helpers.js` was never loaded → `TypeError: Cannot read properties of undefined` → `window.Auth` never defined → ALL auth flows broken. Added Check 9b to verify-structure.mjs to catch this bug class in the future. |
| 2.1.1 | 2026-06-29 | Auth bug fix: defined `_createUserDocViaServer()` in `src/auth/main.js` (was called in 3 places but NEVER defined — broke ALL new user logins silently). Added `_extractFunctionErrorCode()` helper. Verified all 16 auth files load + 33 unit tests pass. |
| 2.1.0 | 2026-06-29 | Routing overhaul: logout → landing page (not login), root `404.html` added, `href="/"` bugs fixed, `rule-url-albedu.md` documentation added, `AUTH_CONFIG.landingUrl()` added, navigasi.js `_resolveProfileScriptBase()` fix (ProfileEditorPanel + OptionProfile were silently failing on 4 of 5 admin pages) |
| 2.0.0 | 2026-06-28 | By-feature structure, auth.js split, CSS consolidation, inline style extraction |
| 1.0.5 | 2026-06-26 | Performance optimization, 27 bugs fixed, XSS hardening |
| 1.0.0 | 2026-Q1 | Initial Supabase migration from Firebase |
