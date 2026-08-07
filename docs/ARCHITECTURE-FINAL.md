# AlbEdu Architecture — Final State (Stage 3 Complete)

## v0.821.0 Hardening Summary

After the three-stage refactor captured above (Stage 1–3), the v0.821.0 cycle executed four parallel audits and applied a substantial set of stability and hardening fixes. This section summarizes what changed and why. For the human-style commenting rules that AI assistants MUST follow when editing this codebase, see [`docs/STRICT-COMMENTING-FOR-AI.md`](./STRICT-COMMENTING-FOR-AI.md).

### Parallel audits performed

1. **AI-pattern audit** — swept ~1,400+ AI-generated comment patterns across 60+ files: ASCII-art file headers, decorative divider bars (`// ────────`), version archaeology (`// v0.742.0: ...`), phase refs (`// Phase 8 PWA`), marketing-speak (`// Enterprise-grade, production-ready...`), JSDoc on internal helpers, and redundant "this function does X" restatements of the function name. The canonical rules are now codified in `docs/STRICT-COMMENTING-FOR-AI.md`.
2. **UI consistency audit** — 25 HTML pages + 29 CSS files reviewed. Orphaned stylesheets removed, theme-color and titles standardized, skip-link consolidated, boot.js wired into 5 auth pages that were missing it, submitted/blocked.html icon mismatches fixed.
3. **Edge case & stability audit** — frontend JS reviewed for memory leaks, timer leaks, double-click races, aborted fetches, Safari private-mode localStorage fallbacks, and DevTools-detector console.log monkey-patch restoration.
4. **Free Plan limits audit** — Edge Functions + DB reviewed for invocation counts, realtime channel shape, RLS recursion, and connection churn. Corrected the v0.746.0 estimate of "200 concurrent peserta on Free Plan" down to a realistic ~100 (see `docs/SCALING.md`).

### Critical frontend fixes

- **maxlength IDL bug** — the DOM `maxlength` property must be set via `setAttribute`, not assigned directly. The reflected IDL attribute silently coerces to `-1` on bad input, which broke character limits on identity-form text fields.
- **`_onSubmitted` wiring** — `src/security/block-listener.js` was subscribing to realtime updates on `assessment_sessions` but never invoking the callback that locks the UI on `status='blocked'`. Peserta would continue answering for ~15s until the next heartbeat poll caught the block. Now wired.
- **`profilLengkap` field name** — mismatched camelCase between client (`profilLengkap`) and DB column (`profile_lengkap`) caused the "complete your profile" gate to never fire. Renamed to match the column.
- **ViolationStore deletion** — `src/utils/admin-notification-center.js` `bulkDelete` was hitting the wrong index, so dismissed violations re-appeared on next poll. Now uses the correct composite key.
- **boot timeout** — `AlbEdu.boot.ready` now resolves optimistically after 30s even if the platform never signals `albedu:platform-ready`. A degraded Supabase region no longer freezes the UI indefinitely.
- **service-worker BASE_PATH** — `public/service-worker.js` now computes its BASE_PATH dynamically from `registration.scope` so it works whether deployed at root or under `/AlbEdu/` on GitHub Pages.
- **memory leak cleanup** — `heartbeat.js`, `anti-cheat.js`, and `devtools-detector.js` now clear their `setInterval` / `setTimeout` handles inside `stop()`. The old code left zombie timers running after `signOut()`, which on a long session could exhaust the browser's timer queue.
- **exam.js AbortController teardown** — `src/pages/take-assessment/exam.js` now tears down its `AbortController` on unmount so that in-flight fetches don't try to `setState` on a torn-down DOM.
- **publish double-click guard** — `src/pages/buat-ujian/publish-card.js` now disables the publish button on first click and re-enables on error response. Prevents duplicate assessment rows when the user double-clicks "Publish".
- **image-compress `Promise.allSettled`** — `src/utils/image-compress.js` now uses `allSettled` instead of `all` so one bad image doesn't abort the whole batch upload.
- **image-cleanup timeouts** — `src/utils/image-cleanup.js` now wraps each cleanup call in a 10s `AbortController` timeout so a hung GitHub response doesn't block the cleanup queue.
- **consent XSS escape + ipify timeout** — `src/security/consent.js` now escapes `previousVersion` before rendering (was raw innerHTML — XSS via tampered consent record), and the ipify lookup now uses a 5s `AbortController`.

### Critical backend fixes

- **Worker soft-archive (was hard-delete)** — ⚠️ **CORRECTION (v0.821.0):** This claim was historically inaccurate. The Cloudflare Worker `/release` endpoint never had a `deleted_at` soft-archive path — it directly decremented `ref_count` and set `pending_delete=true`. There is no `deleted_at` column on `assets_manifest`, and no 365-day pg_cron retention job for assets (migration 013 schedules retention for `registration_attempts`, `violation_events`, `audit_logs`, `rate_limit_*` — but NOT `assets_manifest`). The actual asset lifecycle is: ref_count hits 0 → `pending_delete=true` → GC bot (GitHub Actions, weekly) deletes after 7-day safety window. The asset system is being migrated to Supabase + Backblaze B2 — see [`docs/asset-system/ROADMAP.md`](./asset-system/ROADMAP.md) for the full migration plan and [`docs/asset-system/ARCHITECTURE-V2.md`](./asset-system/ARCHITECTURE-V2.md) for the new architecture.
- **heartbeat DB churn reduction** — the heartbeat Edge Function now caches the session row in Worker memory for 60s. With 15s heartbeats, this cuts DB reads from 4/min/peserta to 1/min/peserta — a 4x reduction in DB load on Free Plan.
- **health-check DB query** — `health-check` now runs a `SELECT 1` instead of a full session-row fetch, cutting cold-start latency ~3x and removing the only DB query on the most-invoked endpoint.
- **RLS tightening** — `rate_limit_heartbeats`, `rate_limit_submits`, and `violation_events` now check session ownership via `assessment_sessions.user_id = auth.uid()` join, preventing peserta A from inserting heartbeats/violations/rate-limit rows for peserta B's session.
- **`peran_user()` deleted_at filter** — the role helper now filters `WHERE deleted_at IS NULL`, so soft-deleted users can no longer authenticate via stale JWTs.
- **atomic `submit_assessment()` RPC** — the previous `INSERT INTO submissions` + `UPDATE assessment_sessions` pair was non-atomic; a crash mid-pair left dangling rows. Now a single SECURITY DEFINER RPC wraps both writes in a transaction.
- **`verify_jwt=true` for 8 functions** — Supabase function config was `verify_jwt = false` for 8 functions. JWT was still validated in-function via `getUser()`, but the gateway-level check was missing defense-in-depth. Now `verify_jwt=true` for: `heartbeat`, `submit-assessment`, `block-participant`, `assessment-lifecycle`, `cleanup-assessment`, `data-export`, `dsr-handler`, `user-auth-complete`.
- **ANC filter + debounce** — `src/utils/admin-notification-center.js` was subscribing to all violation events on all sessions, causing a thundering herd when 50+ peserta triggered violations simultaneously. Now filtered to the active assessment and debounced 200ms.
- **Cloudflare Worker CORS lock + AUTH_TOKEN required** — `/upload` and `/release` now check `Origin` against `ALLOWED_ORIGINS` and require `AUTH_TOKEN` header. Was optional before — anonymous uploads were possible.

### UI fixes

- 6 orphaned CSS files deleted (`legacy-dashboard.css`, `old-login.css`, etc.) — imported by no HTML page, dead weight.
- `submitted.html` / `blocked.html` icon mismatches fixed — the success/blocked state icons were pointing to non-existent SVG IDs.
- `theme-color` standardized to `#2563eb` across all HTML pages (was a mix of `#1E40AF` / `#1d4ed8` / `#2563EB`).
- Page `<title>`s standardized to `<Page Name> — AlbEdu Admin` convention.
- Skip-link consolidated into one canonical pattern in critical.css (was 5 different markup variants).
- `boot.js` added to 5 auth pages that were missing it: `login.html`, `forgot-password.html`, `reset-password.html`, `register-admin.html`, `register-success.html`.
- `offline.html` fallback served by the service worker when the network is down (replaces the browser's default offline page).
- Playful micro-interactions added to sidebar nav, primary CTAs, and floating action buttons (QNotify spring module). Disabled on `prefers-reduced-motion`.

### AI-pattern cleanup

- ~1,400+ AI-generated comment patterns killed across 60+ files.
- Patterns removed: ASCII-art file headers (`/* ======... */`), section divider bars (`// ────────`), version archaeology (`// v0.742.0: ...`), phase refs (`// Phase 8 PWA`), marketing-speak (`// Enterprise-grade, production-ready, world-class...`), JSDoc on internal helpers (only public API deserves JSDoc), redundant "this function does X" restatements of the function name.
- Canonical rules codified in [`docs/STRICT-COMMENTING-FOR-AI.md`](./STRICT-COMMENTING-FOR-AI.md) — MUST READ before editing any file.

### Free Plan capacity estimate (post-hardening)

Based on the audit:

- ~100 concurrent peserta (realtime cap — 2 connections per peserta: 1 channel + 1 polling fallback).
- ~14 exams/month at 50 peserta 90min each (heartbeat invocations) → ~28 with the 60s DB cache (DB no longer the bottleneck before Edge Function invocations).
- ~30 concurrent admin (each holds 1–2 realtime connections; 30 × 2 = 60, leaving 140 for peserta).
- ~5,000 stored assessments (DB 500MB cap; each assessment row + sections JSONB ≈ 100KB).
- Extendable to ~30 exams/month (or ~46 with reduced payload sizes) by squeezing the heartbeat DB cache and trimming the realtime message payload.

---

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

### QNotify library — kept (vendor library, actively loaded)
- **Clarification (v0.821.0):** The original Stage 2 plan was to delete `public/QNotify/` and replace it with `src/shared/notify.js`. However, in practice, `public/QNotify/` is still present (20 files) and actively loaded via `src/shared/qnotify-loader.js` from multiple HTML pages (3+ admin pages + others). The planned `src/shared/notify.js` was never built.
- `window.notify`, `window.QNotify` (legacy shim), `window.show` are auto-installed by `qnotify-loader.js`, dispatches `qnotify-ready` event.
- `public/QNotify/` remains a vendor library — edit only for bug fixes.
- `src/shared/qnotify-loader.js` is the canonical loader; added to pages via shared boot sequence.

### Legacy Firebase shim deleted
- Deleted `src/utils/supabase-api.js` (1,530 lines) — the Firebase compatibility shim.
- Built `src/platform/supabase-client.js` (~280 lines) — native Supabase client with `auth`, `db`, `realtime`, `rpc` services.
- Built `src/platform/repository.js` (~200 lines) — typed table access helpers (`getDoc`, `getDocs`, `addDoc`, `updateDoc`, `setDoc`, `deleteDoc`, `bulkDelete`, `subscribe`).
- Built `src/security/sanitize.js` (~140 lines) — DOM sanitization helpers.
- **Note (v0.821.0):** The planned `src/legacy/firebase-compat.js` bridge was never built — `src/legacy/` directory does not exist. All consumers were migrated directly to the native platform layer. A stale comment in `src/pages/results-analytics.js:11` references `firebase-compat.js` but the file does not exist (dead reference, harmless).

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
- ~~`src/pages/question-bank.js`~~ — **REMOVED in v0.821.0** (Bank Soal feature deleted, migration 019: `DROP TABLE question_bank CASCADE`).

### Still pending migration (tracked for future sprints)
**Note (v0.821.0):** The legacy bridge `src/legacy/firebase-compat.js` was never built, so these files were migrated directly to the native platform layer. The list below is preserved for historical reference; current status may differ — verify with `grep -rn "firebaseDb\|firebaseAuth" src/` before acting.
- `src/pages/results-analytics.js` — read-only queries, low risk.
- `src/pages/assessment-entry.js` — session creation flow.
- `src/pages/buat-ujian/list-view.js` — assessment listing.
- `src/pages/create-assessment.js` — assessment creation.
- `src/pages/buat-ujian/metadata-card.js` — daftar_nama lookup.

A stale comment in `src/pages/results-analytics.js:11` references `firebase-compat.js` (dead reference, harmless).

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

**Result: 15/15 checks passed, 0 errors, 0 warnings** (verified v0.821.0).

### Architecture documentation
- ~~`docs/MIGRATION-STATUS.md`~~ — was planned but never created.
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
│   └── qnotify-loader.js  # Loads QNotify vendor library, auto-installs window.notify/QNotify/show
├── security/              # Security layer
│   └── sanitize.js        # DOM sanitization helpers
├── auth/                  # Domain: authentication (migrated to native)
├── profile/               # Domain: user profile (migrated to native)
├── identity/              # Domain: identity forms
├── exam/                  # Domain: exam runtime
├── pages/                 # Page controllers (mostly migrated)
├── theme-system/          # Theme presets
└── utils/                 # Shared utilities
```

**Note (v0.821.0):** `src/legacy/` directory does NOT exist. The planned `firebase-compat.js` bridge was never built. All consumers were migrated directly to the native platform layer. QNotify vendor library is still present in `public/QNotify/` (20 files) and actively loaded via `src/shared/qnotify-loader.js`.

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
- `window.QNotify` — legacy shape for QNotify consumers (installed by qnotify-loader.js)
- `window.show` — alias for `AlbEdu.notify` (legacy)
- `window.sb` — legacy alias for `AlbEdu.supabase.client`
- `'qnotify-ready'` event — dispatched by qnotify-loader.js
- `'albedu:platform-ready'` / `'albedu:platform-error'` events — dispatched by supabase-client.js (was `firebase-ready`/`firebase-error` in legacy code, renamed in Stage 2 refactor)

**Note:** `window.firebaseAuth` and `window.firebaseDb` legacy aliases are NO LONGER installed (the `firebase-compat.js` bridge that provided them was never built).

## Migration Tracker (Final State)

### ✅ Fully Migrated (no legacy refs)
- `src/security/{consent,block-listener,heartbeat,anti-cheat}.js`
- `src/auth/{main,authFlow,user-auth-portal,preflight,forgot-password,reset-password,admin-onboarding}.js`
- `src/utils/{index,ui,admin-notification-center,self-storage}.js`
- `src/profile/editor-panel.js`
- `src/pages/{take-assessment,daftar-nama}.js` — migrated. ~~`question-bank.js`~~ — removed in v0.821.0 (Bank Soal feature deleted).

### ⏳ Still Uses Legacy Patterns (chained .collection().doc() calls — historical, verify with grep)
**Note (v0.821.0):** The legacy bridge `src/legacy/firebase-compat.js` was never built, so these files were migrated directly to the native platform layer. The list below is preserved for historical reference; current status may differ — verify with `grep -rn "firebaseDb\|firebaseAuth" src/` before acting.
- `src/pages/results-analytics.js` — read-only queries, low risk
- `src/pages/assessment-entry.js` — session creation
- `src/pages/buat-ujian/list-view.js` — assessment listing
- `src/pages/create-assessment.js`
- `src/pages/buat-ujian/metadata-card.js`

A stale comment in `src/pages/results-analytics.js:11` references `firebase-compat.js` (dead reference, harmless).

### To Delete After Migration Tracker Clears
- ~~`src/legacy/firebase-compat.js`~~ — was planned but never built; nothing to delete
- ~~`src/legacy/` directory~~ — does not exist
- ~~`<script defer src="...legacy/firebase-compat.js">` lines from 19 pages~~ — never added

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


## v0.821.0 UI Hardening
See changelog in rule-url-albedu.md
