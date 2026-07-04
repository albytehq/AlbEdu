# AlbEdu Architecture — Final State (Stage 3 Complete)

## Three-Stage Refactor Summary

This document captures the final architecture after the three-stage refactor.

## Stage 1 — Stabilize the Core (DONE)

**Goal:** make the application feel instant, deterministic, and trustworthy.

**What changed:**
- Built `src/shared/head/critical-css.js` — synchronous inline critical CSS for paint-first shell.
- Built `src/shared/head/fonts.js` — single shared font strategy with deduplication.
- Built `src/shared/icons/icons.js` — SVG icon system (60+ icons) replacing Material Symbols font.
- Built `src/shared/boot.js` — `AlbEdu.boot.ready` Promise orchestrator.
- Migrated 26 HTML pages to canonical head structure: critical-css → tokens → fonts → icons → supabase-client → repository → sanitize → boot → legacy-compat.
- Migrated 249 icons (194 HTML + 55 JS) from `<i class="material-symbols-outlined">` font to `<span data-albedu-icon="...">` SVG.
- Fixed all 4 broken `type="module"src=` syntax mistakes.
- Removed all duplicate Google Fonts `<link>` tags (was 4 per page, now 0 — handled by fonts.js).
- Changed Supabase SDK + Turnstile loading from `defer` to `async` (non-blocking).
- Changed KaTeX loading from `defer` to `async` with `media="print" onload="this.media='all'"` pattern for non-blocking CSS.

**Result:** First meaningful paint is stable. No font flash, no icon flash, no layout shift. Shell renders immediately even on slow networks.

## Stage 2 — Clean the Architecture (DONE)

**Goal:** remove legacy coupling and reduce the codebase to a clean Supabase-native shape.

**What changed:**

### QNotify library deleted
- Built `src/shared/notify.js` (~250 lines) — native toast + confirm dialog system.
- Auto-installs `window.notify`, `window.QNotify` (legacy shim), `window.show`, dispatches `qnotify-ready` event.
- Deleted `public/QNotify/` entirely (14 files, ~3,000 lines).
- Removed 39 QNotify CSS `<link>` tags and 10 inline QNotify bootstrap `<script type="module">` blocks from 10 admin/assessment pages.
- Added `src/shared/notify.js` to 19 pages via shared boot sequence.

### Legacy Firebase shim deleted
- Deleted `src/utils/supabase-api.js` (1,530 lines) — the Firebase compatibility shim.
- Built `src/platform/supabase-client.js` (~280 lines) — native Supabase client with `auth`, `db`, `realtime`, `rpc` services.
- Built `src/platform/repository.js` (~200 lines) — typed table access helpers (`getDoc`, `getDocs`, `addDoc`, `updateDoc`, `setDoc`, `deleteDoc`, `bulkDelete`, `subscribe`).
- Built `src/security/sanitize.js` (~140 lines) — DOM sanitization helpers.
- Built `src/legacy/firebase-compat.js` (~250 lines) — short-lived, isolated bridge that aliases `window.firebaseAuth`/`window.firebaseDb` to the new native layer.

### Consumer migrations (16 files migrated to native platform layer)
- `src/auth/main.js` — 19 legacy refs → 0 (only stale comments remain). All `window.firebaseAuth`/`window.firebaseDb`/`window.sb` replaced with `AlbEdu.supabase.{auth,client,realtime,rpc}` or `AlbEdu.repository.*`. The `onAuthStateChanged` callback renamed to `onAuthStateChange` (native). The `firebase-ready`/`firebase-error` events replaced with `albedu:platform-ready`/`albedu:platform-error`. The `_syncUserDocument` function now uses `repo.subscribe()` + `repo.getDoc()` instead of `db.collection().doc().onSnapshot()`.
- `src/auth/authFlow.js` — `waitForSupabaseReady()` now waits on `albedu:platform-ready` instead of `firebase-ready`. `signInWithGoogle()` calls `AlbEdu.supabase.auth.signInWithGoogle()` directly (no more `GoogleAuthProvider` stub).
- `src/auth/user-auth-portal.js` — email login uses `AlbEdu.supabase.client.auth.signInWithPassword()`.
- `src/auth/preflight.js` — preflight invoke uses `AlbEdu.supabase.rpc.invoke()`.
- `src/auth/forgot-password.js`, `src/auth/reset-password.js` — all `window.sb.auth.*` calls migrated to `AlbEdu.supabase.client.auth.*`.
- `src/auth/admin-onboarding.js` — Edge Function invoke migrated.
- `src/security/{consent,block-listener,heartbeat,anti-cheat}.js` — fully migrated (done in earlier phase).
- `src/utils/index.js` — removed legacy `firebaseAuth`/`firebaseDb` aliases from `SupabaseApi` barrel export; added `auth`, `repo`, `realtime`, `rpc`, `ready` native accessors.
- `src/utils/ui.js` — profile update uses `AlbEdu.repository.updateDoc()`.
- `src/utils/admin-notification-center.js` — fully migrated: `_subscribeToViolations` uses `repo.subscribe()` + `repo.getDocs()`; `_dismissOne` uses `repo.deleteDoc()`; `_clearAll` uses `repo.bulkDelete()`; init waits on `albedu:platform-ready` event.
- `src/utils/self-storage.js` — uses `AlbEdu.supabase.client`.
- `src/pages/daftar-nama.js` — uses `AlbEdu.supabase.client`.
- `src/profile/editor-panel.js` — `_updateUserProfile` and `_fetchCurrentUser` use `AlbEdu.repository`.
- `src/pages/take-assessment.js` — `_waitForAuth`, `_fetchAssessment`, `_fetchSession`, identity persist, reset sync, and submit all use native platform layer. Submit now uses `AlbEdu.supabase.rpc.invoke('submit-assessment', ...)` instead of raw `fetch()` with manual auth token.
- `src/pages/question-bank.js` — `_waitForAuth`, `_loadQuestions`, save, delete, batch import, and export all use `AlbEdu.repository`.

### Still pending migration (tracked for future sprints)
These files still have some `window.firebaseDb.collection().doc()` chained calls — they work via the legacy bridge but should be migrated:
- `src/pages/results-analytics.js` (7 refs) — read-only queries, low risk.
- `src/pages/assessment-entry.js` (4 refs) — session creation flow.
- `src/pages/buat-ujian/list-view.js` (2 refs) — assessment listing.
- `src/pages/create-assessment.js` (1 ref) — assessment creation.
- `src/pages/buat-ujian/metadata-card.js` (1 ref) — daftar_nama lookup.

The legacy bridge (`src/legacy/firebase-compat.js`) cannot be deleted until these are migrated. The migration tracker below shows the per-file status.

## Stage 3 — Lock Down Enterprise Quality (DONE)

**Goal:** harden security, reliability, accessibility, and long-term maintainability.

### Security hardening
- **Turnstile fail-closed:** `supabase/functions/_shared/turnstile.ts` now fails CLOSED on network/timeout errors (5s timeout via Promise.race). Token length validation (10–2048 chars). Production env detection fails closed if `TURNSTILE_SECRET_KEY` missing. Error messages do NOT leak Cloudflare error codes.
- **Turnstile required in production:** `supabase/functions/access-code-attempt/index.ts` now REQUIRES `turnstile_token` in production (no more skip-if-missing bypass).
- **RLS hardening:** `supabase/migrations/20260702_016_rls_hardening.sql`:
  - `assessment_sessions` peserta UPDATE policy restricted to safe fields only (heartbeat, draft_answers, current_section/question, progress_pct). All sensitive state (status, blocked_at, submitted_at, started_at, violation_count, attempt_number) immutable from client.
  - `violation_events` peserta INSERT restricted to `user_id = auth.uid()`.
  - `submissions` admin UPDATE policy removed (Phase 9 will re-add scoped to grading fields).
  - `audit_logs` anon DENY + authenticated self-read + admin-read policies added.
- **Server-side scoring:** verified `submit-assessment` Edge Function re-scores PG server-side (already in place — score is NEVER trusted from client).
- **Server-side authorization:** verified all 12 Edge Functions use `verifyAuth()` / `requireAdmin()` / `requirePeserta()` / `requireAnyRole()` helpers (already in place).
- **Rate limiting:** access-code-attempt uses DB-based rate limiting (10/IP/hour, 10/device/hour) — already strong. Heartbeat/submit use in-memory per-isolate (adequate for soft limits, tracked for future DB-based migration).

### Accessibility
- Skip-link added to 11 pages (was missing).
- `<html lang="id">` present on all pages (verified by automated check).
- `prefers-reduced-motion` handling built into critical CSS.
- ARIA labels preserved on all SVG icons (aria-hidden for decorative, role="img" + aria-label for meaningful).
- Focus states: `albedu-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }` in critical CSS.
- Dialog: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, ESC to cancel, Enter+Cmd/Ctrl to confirm.
- Toast: `role="alert"` for errors, `role="status"` for info/success/warning.

### Regression guards (automated)
`scripts/verify_audit.py` — 14 automated checks:
1. No duplicate Google Fonts `<link>` tags
2. No Material Symbols font references in HTML
3. No broken `type="module"src=` syntax
4. New code does not reference legacy Firebase shim (platform/, shared/, security/, identity/)
5. Unsafe innerHTML assignments (advisory)
6. All non-critical head scripts have defer or async
7. All UI pages load critical-css.js
8. All module script tags have proper spacing
9. No references to deleted supabase-api.js
10. No QNotify library references in HTML (replaced by notify.js)
11. No window.sb in new code (platform/, shared/, security/, identity/)
12. Pages with notify consumers load notify.js
13. Skip-link present for accessibility
14. `<html lang>` attribute present

**Result: 13/14 passed, 0 errors, 78 advisory warnings** (innerHTML assignments — most are safe via escapeHTML or SVG icons, but tracked for review).

### Architecture documentation
- `docs/MIGRATION-STATUS.md` — per-file migration tracker.
- `docs/ARCHITECTURE-FINAL.md` (this file) — final state documentation.
- `docs/PAGE-TEMPLATE.html` — canonical page template.
- Code comments throughout the platform/shared/security layers document the new architecture and explicitly forbid legacy patterns in new code.

## Final Architecture

```
src/
├── platform/              # Service layer — Supabase native
│   ├── supabase-client.js # Single Supabase client + auth/db/realtime/rpc services
│   └── repository.js      # Typed table access helpers
├── shared/                # Shared design system + boot orchestrator
│   ├── head/
│   │   ├── critical.css   # Critical inline CSS for paint-first shell
│   │   ├── critical-css.js # Injects critical CSS + applies theme
│   │   └── fonts.js       # Single font strategy (deduplicates)
│   ├── icons/
│   │   └── icons.js       # SVG icon system (60+ icons)
│   ├── boot.js            # Boot orchestrator (AlbEdu.boot.ready Promise)
│   └── notify.js          # Native toast + confirm dialog (replaces QNotify)
├── security/              # Security layer
│   └── sanitize.js        # DOM sanitization helpers
├── legacy/                # ⚠ DEPRECATED — short-lived compat bridge
│   └── firebase-compat.js # Aliases window.firebaseAuth/firebaseDb to AlbEdu.supabase
├── auth/                  # Domain: authentication (migrated to native)
├── profile/               # Domain: user profile (migrated to native)
├── identity/              # Domain: identity forms
├── exam/                  # Domain: exam runtime
├── pages/                 # Page controllers (mostly migrated)
├── theme-system/          # Theme presets
└── utils/                 # Shared utilities
```

## Public API Surface

### `window.AlbEdu` namespace
- `AlbEdu.supabase.client` — raw SupabaseClient (escape hatch)
- `AlbEdu.supabase.auth` — `{ currentUser, onAuthStateChange, signInWithGoogle, signInWithEmail, signUpWithEmail, sendPasswordReset, signOut, getAccessToken, getSession }`
- `AlbEdu.supabase.db` — `{ select, selectOne, insert, update, delete, upsert, from }`
- `AlbEdu.supabase.realtime` — `{ subscribe, unsubscribe, unsubscribeAll }`
- `AlbEdu.supabase.rpc` — `{ invoke }`
- `AlbEdu.supabase.ready` — Promise<true> (resolves when bootstrap complete)
- `AlbEdu.supabase.isReady()` — sync boolean
- `AlbEdu.repository` — `{ getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc, bulkDelete, subscribe, unsubscribeAll }`
- `AlbEdu.sanitize` — `{ escapeHtml, sanitizeHtml, setText, setHTML }`
- `AlbEdu.icon(name, opts)` — SVG icon HTML string
- `AlbEdu.setIcon(el, name, opts)` — set icon on element
- `AlbEdu.bindIcons(root)` — materialize all `[data-albedu-icon]` elements
- `AlbEdu.notify` — `{ success, error, warning, info, confirm, dismissAll }`
- `AlbEdu.boot.ready` — Promise<true> (resolves when DOM + platform ready)
- `AlbEdu.boot.whenReady(cb)` — convenience callback wrapper

### Legacy compatibility shims (auto-installed, will be removed)
- `window.notify` — alias for `AlbEdu.notify` (legacy)
- `window.QNotify` — legacy shape for QNotify consumers
- `window.show` — alias for `AlbEdu.notify` (legacy)
- `window.firebaseAuth` — legacy alias (via firebase-compat.js)
- `window.firebaseDb` — legacy alias (via firebase-compat.js)
- `window.sb` — legacy alias for `AlbEdu.supabase.client`
- `'qnotify-ready'` event — dispatched by notify.js
- `'firebase-ready'` / `'firebase-error'` events — dispatched by firebase-compat.js

## Migration Tracker (Final State)

### ✅ Fully Migrated (no legacy refs)
- `src/security/{consent,block-listener,heartbeat,anti-cheat}.js`
- `src/auth/{main,authFlow,user-auth-portal,preflight,forgot-password,reset-password,admin-onboarding}.js`
- `src/utils/{index,ui,admin-notification-center,self-storage}.js`
- `src/profile/editor-panel.js`
- `src/pages/{take-assessment,question-bank,daftar-nama}.js`

### ⏳ Still Uses Legacy Bridge (chained .collection().doc() calls)
- `src/pages/results-analytics.js` (7 refs) — read-only queries, low risk
- `src/pages/assessment-entry.js` (4 refs) — session creation
- `src/pages/buat-ujian/list-view.js` (2 refs) — assessment listing
- `src/pages/create-assessment.js` (1 ref)
- `src/pages/buat-ujian/metadata-card.js` (1 ref)

### To Delete After Migration Tracker Clears
- `src/legacy/firebase-compat.js`
- `src/legacy/` directory
- `<script defer src="...legacy/firebase-compat.js">` lines from 19 pages
- `verify_audit.py` legacy exemption clause

## How to Run Verification

```bash
cd AlbEdu
python3 scripts/verify_audit.py
```

Expected output:
```
PASSED: 13 checks
WARNINGS: ~78 (innerHTML advisories — most are safe)
ERRORS: 0
```
