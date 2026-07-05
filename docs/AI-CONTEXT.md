# AI-CONTEXT — Cheat Sheet for AI Assistants

> File ini buat AI assistant (Claude, GPT, Copilot, dst.) cepat onboard ke project AlbEdu.
> **READ THIS FIRST** sebelum edit code apapun.

**Last verified:** 2026-07-05 (v0.746.0)

---

## TL;DR

- **Stack:** Vanilla JS (no framework) + Supabase + Cloudflare Worker v6.0
- **Structure:** Strict by-feature (`src/{feature}/index.js` as entry)
- **Patterns:** Mix classic scripts (`window.X`) + ES modules (`import/export`) — gradual migration to ESM
- **Tests:** `tests/` folder (TODO — not yet implemented)
- **Build:** `npm run build` (esbuild + lightningcss → `dist/`)
- **Dev:** `npm run dev` (port 8765, landing page langsung di `/` root)

---

## Quick Lookup — "Kalau disuruh X, edit file Y"

| Task | File(s) to edit |
|---|---|
| Fix login bug | `src/auth/main.js`, `src/auth/user-auth-portal.js`, `pages/login.html` |
| Add new assessment question type | `src/pages/buat-ujian/templates.js`, `src/pages/buat-ujian/soal-editor-modal.js`, `src/identity/form-builder.js` |
| Change Buat Asesmen page behavior | `src/pages/buat-ujian/` modules, `styles/buat-ujian-v2.css`, `styles/buat-ujian-modal.css` |
| Update navigation menu | `src/utils/navigasi.js`, `pages/admin/index.html` |
| Add new admin page | Bikin `pages/admin/{name}.html`, `src/pages/{name}.js`, `styles/{name}.css` (v0.742.0+: flat structure, no more `pages/admin/pages/` subfolder) |
| Fix notification styling | `public/QNotify/ui/*.css` |
| Update Supabase schema | `supabase/migrations/{date}_{name}.sql` |
| Change auth redirect logic | `src/auth/main.js` (cari `_redirectToLogin`, `_redirectForRole`, `authLogout`) — **read [`rule-url-albedu.md`](../rule-url-albedu.md) FIRST** |
| Change logout destination | `src/auth/main.js` Step 11 of `authLogout()` — logout goes to LANDING PAGE (`landingUrl()`), NOT login. See `rule-url-albedu.md §3.4` |
| Change 404 page | `404.html` (canonical, project root) + `pages/404.html` (legacy) — see `rule-url-albedu.md §6` |
| Change post-login redirect | `src/auth/main.js` `AUTH_CONFIG.pathForRole()` |
| Change BASE_PATH detection | `src/auth/main.js` `AUTH_CONFIG.BASE_PATH` IIFE + `404.html` inline script |
| Fix any "logo navigates to wrong page" bug | Check for `href="/"` in HTML files — NEVER use it. Use `./`, `../`, or `../../` depending on file location. See `rule-url-albedu.md §5` |
| Add new profile field | `src/auth/user-helpers.js` (`normalizeUserDoc`), `src/profile/editor-panel.js`, `pages/admin/profile.html` |
| Fix assessment anti-cheat | `src/exam/guardian.js`, `src/security/anti-cheat.js` |
| Change Turnstile config | `src/auth/constants.js` (`AUTH_CONFIG.TURNSTILE_SITE_KEY`) |
| Fix error message mapping | `src/auth/error-mapper.js` |
| Update assessment token validation | `supabase/functions/access-code-attempt/index.ts` |
| Add new CSS design token | `styles/tokens.css` |
| Fix loading indicator / skeleton | `styles/loading.css`, `styles/skeleton-loading.css`, `src/utils/ui.js` |
| Update favicon/logo | `public/images/favicon/`, `public/images/logo.svg` |
| Change rate limit config | `src/auth/constants.js` (`RATE_LIMITS`) |
| Fix assessment draft autosave | `src/pages/take-assessment/` modules |
| Add new Buat Asesmen module | `src/pages/buat-ujian/{module-name}.js`, register in `src/pages/buat-ujian/index.js`, load via `<script defer>` in `pages/admin/create-assessment.html` |
| Update QNotify XSS sanitize | `public/QNotify/security/sanitize.js` |
| Change logout behavior | `src/auth/main.js` (cari `authLogout`, `_confirmLogout`) |
| Update privacy policy | `pages/privacy-policy.html` (v4.0.0 — legal document style, 18 sections) |
| Fix consent gate | `src/security/consent.js`, `supabase/migrations/20260701_009_create_consents.sql` |
| Update skeleton loading | `styles/skeleton-loading.css`, `src/utils/navigasi.js` (sidebar skeleton), `pages/admin/profile.html` (profile skeleton) |

---

## Common Pitfalls (DO NOT)

- ❌ **Jangan** edit `window.Auth` API tanpa update `src/auth/main.js` public API section juga
- ❌ **Jangan** tambah inline `<style>` di HTML — extract ke `styles/`
- ❌ **Jangan** import langsung dari submodule (e.g., `../pages/buat-ujian/metadata-card.js`) — pakai `../pages/buat-ujian/index.js`
- ❌ **Jangan** rename file tanpa update semua HTML refs yang load file itu
- ❌ **Jangan** edit `public/QNotify/` kalau bukan bug fix — itu vendor library
- ❌ **Jangan** tambah `default export` — pakai named exports saja
- ❌ **Jangan** hardcode Supabase URL — pakai `src/platform/supabase-client.js` (native Supabase client, fetch config dari Cloudflare Worker)
- ❌ **Jangan** direct query Supabase dari UI tanpa RLS — pakai edge functions untuk privileged operations
- ❌ **Jangan** gunakan `innerHTML` dengan user-controlled input — pakai `escapeHTML()` dari `src/auth/user-helpers.js`
- ❌ **Jangan** hapus `window.X = X` global assignments — classic scripts depend on them
- ❌ **Jangan** ubah `albedu:platform-ready` / `albedu:platform-error` event names — code modern listen ke event ini. (Legacy `firebase-ready` event sudah deprecated dan di-rename di Stage 2 refactor.)
- ❌ **Jangan** pakai `href="/"` di HTML apapun — itu navigate ke `https://albedu-id.github.io/` (GitHub profile), BUKAN ke `/AlbEdu/` (app). Pakai `./`, `../`, atau `../../`. Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §5.
- ❌ **Jangan** hardcode `/AlbEdu/` di JS — pakai `window.Auth.getBasePath()` (BASE_PATH auto-detected, environment-agnostic)
- ❌ **Jangan** redirect logout ke `login.html` — pakai `AUTH_CONFIG.landingUrl()` (root index.html). Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §3.4.
- ❌ **Jangan** taruh 404.html cuma di `pages/` — GitHub Pages hanya auto-serve 404.html di project root. Selalu maintain `404.html` di root. Lihat [`rule-url-albedu.md`](../rule-url-albedu.md) §6.
- ❌ **Jangan** referensi `src/utils/supabase-api.js` — file ini SUDAH DIHAPUS di Stage 2 refactor. Pakai `src/platform/supabase-client.js` + `src/platform/repository.js`.
- ❌ **Jangan** referensi `src/legacy/firebase-compat.js` — directory `src/legacy/` TIDAK ADA. Legacy bridge sudah dihapus.

---

## DO

- ✅ Baca `docs/ARCHITECTURE-FINAL.md` sebelum edit structural code
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
- ✅ Pakai `AlbEdu.supabase.client` / `AlbEdu.repository` untuk semua DB access (native Supabase, no shim)
- ✅ Pakai `install_font_fallback()` setelah register fonts (auto-handles mixed CJK/Latin)

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
| Buat Asesmen — Step 1 (info + identity + theme colors) | `src/pages/buat-ujian/metadata-card.js` |
| Buat Asesmen — Step 2 (sections + questions list) | `src/pages/buat-ujian/soal-card.js` |
| Buat Asesmen — Step 2 question editor modal | `src/pages/buat-ujian/soal-editor-modal.js` |
| Buat Asesmen — Step 3 (summary + token + publish) | `src/pages/buat-ujian/publish-card.js` |
| Buat Asesmen — step nav + list/wizard view toggle | `src/pages/buat-ujian/wizard-controller.js` |
| Buat Asesmen — list view (assessment cards from Supabase) | `src/pages/buat-ujian/list-view.js` |
| Buat Asesmen — question templates (PG, Esai) | `src/pages/buat-ujian/templates.js` |
| Buat Asesmen — keyboard shortcuts | `src/pages/buat-ujian/keyboard-shortcuts.js` |
| Buat Asesmen — page styling | `styles/buat-ujian-v2.css`, `styles/buat-ujian-modal.css` |
| Assessment anti-cheat | `src/exam/guardian.js`, `src/security/anti-cheat.js` |
| Assessment runtime (peserta side) | `src/pages/take-assessment.js` + `src/pages/take-assessment/` modules |
| Identity form builder | `src/identity/form-builder.js`, `src/identity/form-renderer.js` |
| Profile panel | `src/profile/editor-panel.js` |
| Profile options menu (dropdown) | `src/profile/option-profile.js` |
| Peserta floating profile button | `src/profile/peserta-profile-fab.js` |
| Navigation sidebar | `src/utils/navigasi.js` |
| UI helpers (loading, toast) | `src/utils/ui.js` |
| Error manager | `src/utils/error-manager.js` |
| Math rendering (KaTeX) | `src/utils/math-renderer.js` |
| Math paste converter | `src/utils/math-paste-converter.js` |
| Image compression | `src/utils/image-compress.js` |
| Image cleanup | `src/utils/image-cleanup.js` |
| Self-storage (IndexedDB) | `src/utils/self-storage.js` |
| Admin notification center | `src/utils/admin-notification-center.js` |
| Supabase client (native) | `src/platform/supabase-client.js` |
| Repository (typed table access) | `src/platform/repository.js` |
| Consent gate (UU PDP) | `src/security/consent.js` |
| DOM sanitization | `src/security/sanitize.js` |
| Heartbeat | `src/security/heartbeat.js` |
| Block listener | `src/security/block-listener.js` |
| DevTools detector | `src/security/devtools-detector.js` |
| Logout confirmation | `src/auth/main.js` (`_confirmLogout`, `authLogout`) — **logout redirects to LANDING PAGE**, see `rule-url-albedu.md §3.4` |
| Profile completeness check | `src/auth/user-helpers.js` (`isProfileComplete`) |
| Avatar URL generation | `src/auth/user-helpers.js` (`buildAvatarUrl`) |
| HTML escape (XSS prevention) | `src/auth/user-helpers.js` (`escapeHTML`) |
| BASE_PATH detection | `src/auth/main.js` (`AUTH_CONFIG.BASE_PATH` IIFE) — see `rule-url-albedu.md §2` |
| 404 page (canonical) | `404.html` (project root) — see `rule-url-albedu.md §6` |
| 404 page (legacy) | `pages/404.html` (only reachable by direct link) |
| Profile script base resolver | `src/utils/navigasi.js` (`_resolveProfileScriptBase`) — used to dynamically load `editor-panel.js` and `option-profile.js` from `src/profile/` |
| Server-side user provisioning | `src/auth/main.js` (`_createUserDocViaServer`) — invokes `user-auth-complete` Edge Function with Bearer token + preflight data |
| Supabase function error code extractor | `src/auth/main.js` (`_extractFunctionErrorCode`) — parses FunctionsHttpError → backendCode string |
| Auth flow orchestration | `src/auth/main.js` (`_handleAuthStateChange`, `_syncUserDocument`, `authLogin`, `authLogout`) |
| Turnstile widget lifecycle | `src/auth/turnstile.js` (`getFreshTurnstileToken`, `renderTurnstile`, `resetTurnstile`) |
| Preflight validation flow | `src/auth/preflight.js` (`executePreflightFlow`, `runPreflightValidation`) — creates preflight session before Google OAuth |
| Email verification gate | `src/auth/main.js` (`_handleAuthStateChange` Patch A — reads `user._supabaseUser?.email_confirmed_at`) |
| Theme system | `src/theme-system/index.js` + `presets.js`, `derive.js`, `validate.js`, `injector.js` |
| Icon system (v7.0, 101 icons) | `src/shared/icons/icons.js` (78KB bundle) |
| Skeleton loading | `styles/skeleton-loading.css` + `styles/tokens.css` (base `.skeleton` class) |
| Privacy policy | `pages/privacy-policy.html` (v4.0.0, 18 sections, honest disclosure) |

---

## Edge Functions (12 total, all ACTIVE)

| Function | File | Purpose |
|---|---|---|
| `user-auth-preflight` | `supabase/functions/user-auth-preflight/index.ts` | Validates Turnstile token + device fingerprint, returns preflightId (15-min TTL) |
| `user-auth-complete` | `supabase/functions/user-auth-complete/index.ts` | Verifies preflight, creates user row in `users` table if missing, upserts `user_devices` row, returns user profile |
| `register-admin` | `supabase/functions/register-admin/index.ts` | Public admin registration (no auth required) — Turnstile + device limit + creates user with `peran='admin'` |
| `access-code-attempt` | `supabase/functions/access-code-attempt/index.ts` | Validates 6-digit access code + tracks attempts per device (was `exam-token-attempt`, renamed) |
| `submit-assessment` | `supabase/functions/submit-assessment/index.ts` | Server-side scoring (re-scores PG, never trusts client), creates submission record |
| `assessment-lifecycle` | `supabase/functions/assessment-lifecycle/index.ts` | Assessment state transitions (publish, archive, etc.) |
| `block-participant` | `supabase/functions/block-participant/index.ts` | Block peserta from assessment (admin action) |
| `cleanup-assessment` | `supabase/functions/cleanup-assessment/index.ts` | Soft-archive assessments (status='archived') |
| `data-export` | `supabase/functions/data-export/index.ts` | DSR: export user data as JSON (Pasal 16 UU PDP) |
| `dsr-handler` | `supabase/functions/dsr-handler/index.ts` | DSR: handle Data Subject Requests (access, correction, deletion) |
| `health-check` | `supabase/functions/health-check/index.ts` | System health check endpoint |
| `heartbeat` | `supabase/functions/heartbeat/index.ts` | Peserta heartbeat during assessment (anti-disconnect) |

---

## Database Quick Reference

### Tables (live DB, 16 tables)

- `users` — { id (UUID), email, peran ('admin'|'peserta'), nama, foto_profil, organization_id, consent_at, consent_version, deleted_at, created_at }
- `organizations` — { id, name, created_at }
- `assessments` — { id, access_code (6-digit), title, subject, sections (JSONB), status, created_by, organization_id, ... }
- `assessment_sessions` — { id, assessment_id, peserta_id, status, draft_answers, progress_pct, heartbeat, ... }
- `submissions` — { id, session_id, assessment_id, peserta_id, score, max_score, correct_count, total_count, grading_detail, ... }
- `violation_events` — { id, session_id, user_id, type, ip_address, ... }
- `audit_logs` — { id, actor_id, action, target_type, target_id, ip_address, ... }
- `consents` — { id, user_id, consent_type, version, granted, granted_at, revoked_at, ip_address, user_agent, ... }
- `data_subject_requests` — { id, user_id, request_type, status, ... }
- `daftar_nama` — { id, owner_id, name, entries, ... } (manual table, not in migrations)
- `user_devices` — { id, user_id, device_fingerprint, verified_at, ... } (manual)
- `registration_attempts` — { id, email, ip_address, ... }
- `rate_limit_heartbeats`, `rate_limit_submits` — rate limiting (manual)
- `admin_storages`, `assets_manifest` — admin storage (manual)

### RLS Policies

- `users`: user can read own row only
- `assessments`: admin can read all (NOTE: multi-institusi isolation belum penuh — see privacy policy Section 15.1), peserta can read active
- `assessment_sessions`: admin read all, peserta read/insert own
- `submissions`: admin read all, peserta read/insert own
- `violation_events`: admin read all, peserta read/insert own
- `audit_logs`: admin read all, anon deny, authenticated self-read
- `consents`: admin read all + insert/update own, peserta read/insert/update own

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
node scripts/smoke-test.mjs  # Quick HTML ref resolver (requires dev server running)
```

---

## When You're Stuck

1. **Check `docs/ARCHITECTURE-FINAL.md`** — three-stage refactor summary, current architecture
2. **Check `docs/README.md`** — documentation index
3. **Check [`rule-url-albedu.md`](../rule-url-albedu.md)** — URL routing rules (single source of truth)
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
3. Atau listen `'albedu:platform-ready'` / `'auth-ready'` event sebelum akses auth state

### "Failed to fetch" / CORS error

Penyebab: Cloudflare Worker CORS tidak include origin yang dipakai.
Solusi:
1. Update `ALLOWED_ORIGINS` di Worker code (`cloudflare-worker/worker-v6.js`)
2. Atau tambahkan pattern match untuk localhost

### "new row violates row-level security policy"

Penyebab: RLS policy tidak mengizinkan operasi untuk role pengguna.
Solusi:
1. Cek `supabase/migrations/` untuk policy yang relevan
2. Verifikasi `peran_user()` return value cocok dengan policy
3. Untuk consent: pastikan admin INSERT policy ada (migration 020)
