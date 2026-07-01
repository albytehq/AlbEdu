# AlbEdu Architecture

**Version:** 2.0.0
**Last updated:** 2026-06-28

---

## Overview

AlbEdu adalah platform ujian online untuk sekolah menengah. Arsitektur:
- **Frontend:** Vanilla JS (no framework), HTML, CSS — disajikan sebagai static files
- **Backend:** Supabase (Postgres + Auth + Edge Functions + Storage)
- **Bridge:** Cloudflare Worker untuk Supabase config + CORS proxy
- **Library:** QNotify (embedded notification library)

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER BROWSER (Client)                        │
│                                                                 │
│  index.html (root) ───► src/utils/supabase-api.js ───► window.sb │
│       │                              │                          │
│       │                              ▼                          │
│       │              Cloudflare Worker (CORS proxy)             │
│       │                              │                          │
│       │                              ▼                          │
│       │                    Supabase (Postgres)                  │
│       │                              │                          │
│       │              ┌───────────────┴───────────────┐          │
│       │              │                               │          │
│       ▼              ▼                               ▼          │
│  pages/login.html  Auth API                  Edge Functions     │
│       │          (Google OAuth)               (Deno)            │
│       │                                              │          │
│       ▼                                              ▼          │
│  src/auth/main.js ────► user-auth-complete ◄──── verify device   │
│       │                                              limits     │
│       ▼                                                          │
│  pages/admin/index.html (admin dashboard)                       │
│       │                                                          │
│       ▼                                                          │
│  src/wizard/controller.js ───► save exam to Supabase            │
│       │                                                          │
│       ▼                                                          │
│  pages/ujian/index.html (peserta token entry)                   │
│       │                                                          │
│       ▼                                                          │
│  src/exam/logic.js ───► load exam ───► save attempt             │
└─────────────────────────────────────────────────────────────────┘
```

---

## High-Level Components

### 1. Frontend (Static Files)

| Folder | Purpose |
|---|---|
| `pages/` | HTML files (route-based organization) |
| `src/` | JavaScript source code (by-feature) |
| `styles/` | All CSS files |
| `public/` | Static assets (images, QNotify library) |

### 2. Cloudflare Worker

URL: `albedu.examjuniorhighschool.workers.dev`

Tanggung jawab:
- Serve Supabase config (URL, anon key) ke frontend
- CORS proxy untuk Supabase API calls
- Rate limiting per IP

### 3. Supabase

| Komponen | Lokasi |
|---|---|
| Auth (Google OAuth) | Managed by Supabase |
| Database (Postgres) | Tables: users, exams, exam_tokens, exam_attempts, identities |
| Edge Functions (Deno) | `supabase/functions/` |
| Storage | Untuk avatar & gambar soal |
| RLS | Row-Level Security di semua table |

### 4. QNotify (Embedded Library)

Lokasi: `public/QNotify/`

Library notifikasi custom (toast, dialog, alert, readNote). Struktur:
- `api/index.js` — Public API
- `main/` — Engine, render, dialog, motion
- `ui/` — CSS files
- `security/` — XSS sanitization

---

## Module Dependency Graph

```
pages/login.html
    │
    ├──► src/utils/supabase-api.js ───► window.sb (Supabase client)
    │         │
    │         └──► dispatch 'firebase-ready' event
    │
    ├──► src/auth/security.js
    ├──► src/utils/ui.js ───► _ensureLoadingCSS() ───► styles/loading.css
    ├──► src/auth/device-fingerprint.js
    │
    ├──► src/auth/errors.js         (window.CompletionError)
    ├──► src/auth/user-helpers.js   (window.AuthHelpers)
    ├──► src/auth/main.js           (window.Auth)
    │         │
    │         ├──► uses window.CompletionError, window.AuthHelpers
    │         ├──► _handleAuthStateChange()
    │         └──► window.Auth.initializeSystem()
    │
    ├──► src/auth/byteward.js       (listens 'auth-ready')
    │
    └──► src/auth/user-auth-portal.js (ES module)
              │
              └──► import from './index.js'
                          │
                          ├──► './constants.js'
                          ├──► './error-mapper.js'
                          ├──► './turnstile.js'
                          ├──► './preflight.js'
                          └──► './auth-flow.js'

pages/admin/index.html
    │
    ├──► src/utils/navigasi.js ───► _bootstrapProfilePanel()
    │                                    │
    │                                    └──► loads src/profile/editor-panel.js dynamically
    │
    ├──► src/pages/panel.js
    │
    └──► src/auth/main.js (window.Auth)
```

---

## Data Flow

### Login Flow (Admin)

1. User buka `pages/login.html`
2. `src/utils/supabase-api.js` fetch Supabase config dari Cloudflare Worker
3. Supabase client di-init, dispatch `firebase-ready` event
4. `src/auth/main.js` listen event → `_initializeSystem()` → register `onAuthStateChanged`
5. User klik "Login dengan Google"
6. `src/auth/user-auth-portal.js` (ES module):
   - Run preflight via `src/auth/preflight.js` (device fingerprint, rate limit)
   - Store preflight di sessionStorage
   - Call Supabase Auth Google OAuth
7. Browser redirect ke Google → kembali ke `pages/login.html`
8. `onAuthStateChanged` fires → `_handleAuthStateChange(user)`
9. `_syncUserDocument(uid)`:
   - Call `user-auth-complete` edge function dengan preflight ID
   - Edge function verify device limits, create user doc
   - Return user data
10. `_applyUserSnapshot(data)` update module state
11. Dispatch `auth-ready` event dengan role
12. `byteward.js` listen event → redirect ke `pages/admin/index.html`

### Exam Creation Flow (Admin)

1. Admin buka `pages/admin/pages/buat-ujian.html`
2. Klik "Buat Ujian Baru" → wizard modal muncul
3. `src/wizard/controller.js` orchestrate 4-step wizard:
   - Step 1: Metadata (judul, mata pelajaran, kelas, mode, waktu)
   - Step 2: Tema
   - Step 3: Soal (sections + questions)
   - Step 4: Publish
4. State disimpan di `src/wizard/state.js`:
   - Draft autosave ke localStorage (`albedu_wizard_draft`)
   - History stack untuk undo/redo
5. Klik Publish → generate `kode_id` → save exam ke Supabase
6. Modal close, exam card muncul di halaman

### Exam Execution Flow (Peserta)

1. Peserta buka `pages/ujian/index.html`
2. Input 5-digit token → `src/exam/admin-controller.js` lookup
3. Pilih kelas & nama → identity form (`src/identity/`)
4. Submit identity → start exam
5. `src/pages/kerjakan-ujian.js` (controller):
   - Load exam data via `src/exam/data.js`
   - Render soal via `src/exam/viewer.js`
   - Handle state via `src/exam/logic.js`
   - Anti-cheat via `src/exam/guardian.js`
6. Autosave jawaban ke localStorage (draft)
7. Submit → save attempt ke Supabase → redirect ke result page

---

## Database Schema (Supabase)

### Tables

```sql
-- Users (admin & peserta)
users {
  id          UUID PRIMARY KEY
  email       TEXT UNIQUE
  peran       TEXT ('admin' | 'peserta')
  nama        TEXT
  foto_profil TEXT
  created_at  TIMESTAMPTZ
}

-- Exams (ujian)
exams {
  id             UUID PRIMARY KEY
  kode_id        TEXT UNIQUE  -- 5-digit token
  judul          TEXT
  mata_pelajaran TEXT
  kelas          TEXT
  mode           TEXT ('pg' | 'esai' | 'campuran')
  durasi         INTEGER  -- minutes
  soal           JSONB
  access_control JSONB
  created_by     UUID REFERENCES users(id)
  created_at     TIMESTAMPTZ
}

-- Exam tokens (1-time use)
exam_tokens {
  token     TEXT PRIMARY KEY  -- 5-digit
  exam_id   UUID REFERENCES exams(id)
  used_at   TIMESTAMPTZ
  used_by   UUID REFERENCES users(id)
}

-- Exam attempts (hasil ujian peserta)
exam_attempts {
  id           UUID PRIMARY KEY
  exam_id      UUID REFERENCES exams(id)
  user_id      UUID REFERENCES users(id)
  identity_id  UUID REFERENCES identities(id)
  jawaban      JSONB
  score        INTEGER
  started_at   TIMESTAMPTZ
  submitted_at TIMESTAMPTZ
}

-- Identities (data peserta per exam)
identities {
  id         UUID PRIMARY KEY
  exam_id    UUID REFERENCES exams(id)
  nama       TEXT
  kelas      TEXT
  nis        TEXT
  metadata   JSONB
  created_at TIMESTAMPTZ
}
```

### RLS Policies

- `users`: user can read own row only
- `exams`: admin can CRUD; peserta can read where token matches
- `exam_attempts`: user can read own attempts only
- `identities`: user can read identities for exams they have token for

---

## Security Model

### Authentication
- Google OAuth via Supabase Auth
- Cloudflare Turnstile anti-bot di login & register
- Device fingerprint untuk rate limiting

### Authorization
- RLS (Row-Level Security) di semua table Supabase
- Admin vs peserta role check di edge functions
- Token-based access untuk exam (5-digit kode)

### Client-Side Hardening
- `escapeHTML()` di semua user input (XSS prevention)
- `sanitizeUrl()` dengan whitelist di QNotify
- CSP strict mode support via nonce (optional)
- No `innerHTML` dengan user-controlled input

---

## Decision Records (ADRs)

### ADR-001: Pilih Supabase atas Firebase
- **Date:** 2026-Q1
- **Status:** Accepted
- **Context:** Project migrated dari Firebase (deprecated) ke Supabase
- **Decision:** Pakai Supabase dengan Firestore-compatible shim untuk minimize code change
- **Consequences:** `src/utils/supabase-api.js` ada shim layer, dispatch `firebase-ready` event untuk backward compat

### ADR-002: Strict by-feature folder structure (v2.0.0)
- **Date:** 2026-06-28
- **Status:** Accepted
- **Context:** Project grow ke 38 JS files flat, AI lookup slow
- **Decision:** Adopt by-feature structure (`src/auth/`, `src/wizard/`, `src/exam/`, dst.)
- **Consequences:** Migration effort besar one-time, long-term AI maintainability++

### ADR-003: Split auth.js (994 lines) ke 3 files
- **Date:** 2026-06-28
- **Status:** Accepted
- **Context:** `auth.js` terlalu besar, sulit navigate
- **Decision:** Extract pure functions ke `errors.js` + `user-helpers.js`, sisanya jadi `main.js`
- **Consequences:** main.js turun dari 994 → 853 lines, pure functions reusable, backward compat preserved via window globals

### ADR-004: Extract inline `<style>` dari 8 HTML files
- **Date:** 2026-06-28
- **Status:** Accepted
- **Context:** 8 HTML files punya inline `<style>` 8-33KB, inconsistent dengan external CSS pattern
- **Decision:** Extract ke external CSS files di `styles/`
- **Consequences:** HTML files lebih kecil, CSS cacheable, consistent pattern

### ADR-005: Merge 3 profile CSS files jadi 1
- **Date:** 2026-06-28
- **Status:** Accepted
- **Context:** `profile.css` + `profile2.css` + `profile-fallback.css` = 2073 lines, header comment minta consolidation
- **Decision:** Merge ke single `styles/profile.css` dengan section markers
- **Consequences:** 1 file 2294 lines, easier to manage, section markers preserve original organization

---

## Build Pipeline

```
Source (src/, styles/, pages/, public/)
    │
    ├── npm run dev
    │   └── scripts/serve.mjs (HTTP server, port 8765)
    │
    └── npm run build
        └── scripts/minify.mjs
            ├── esbuild (JS minify, target es2020)
            ├── lightningcss (CSS minify)
            └── Output: dist/ directory
                ├── src/         (minified JS)
                ├── styles/      (minified CSS)
                ├── pages/       (HTML copied)
                ├── public/      (assets copied)
                └── supabase/    (backend copied)
```

Deploy `dist/` ke static host mana saja (GitHub Pages, Cloudflare Pages, Netlify, Vercel).

---

## Performance Characteristics

| Metric | Value |
|---|---|
| Avg DOM load time | ~164ms (dev) |
| Render-blocking scripts | 0 |
| CSS `@import` blocks | 0 |
| Inline `<style>` blocks > 50 lines | 4 (admin pages, kecil) |
| Largest JS file | `src/wizard/controller.js` (~83KB) |
| Total source size | ~1.9MB |
| Build size (minified) | ~1.4MB (-27%) |

---

## Browser Support

- Chrome 100+
- Firefox 100+
- Safari 15+
- Edge 100+

Tidak support: IE 11, Chrome <100, Firefox <100, Safari <15.
