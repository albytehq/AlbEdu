# AlbEdu

> Production-grade exam platform untuk sekolah menengah.
> Vanilla JS + Supabase + Cloudflare — zero framework, zero build runtime.

[![Version](https://img.shields.io/badge/version-0.742.1-blue)]()
[![Structure](https://img.shields.io/badge/structure-by--feature-green)]()
[![License](https://img.shields.io/badge/license-MIT-brightgreen)]()

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- Modern browser (Chrome 100+, Firefox 100+, Safari 15+)

### Installation

```bash
git clone <repo>
cd AlbEdu
npm install
```

### Development

```bash
npm run dev
```

Buka di browser:
- **Landing:** http://127.0.0.1:8765/ (landing page langsung di root)
- **Login:** http://127.0.0.1:8765/pages/login.html
- **Admin:** http://127.0.0.1:8765/pages/admin/index.html

### Production Build

```bash
npm run build
```

Output: `dist/` directory (JS+CSS minified, ~27% size reduction).

### Verify Structure Integrity

```bash
npm run verify
```

---

## 📁 Project Structure (v0.2.0 — By-Feature)

```
AlbEdu/
├── src/                    # All JavaScript source code
│   ├── auth/               # Authentication & security
│   │   ├── main.js         # Bootstrap + window.Auth API (incl. AUTH_CONFIG routing)
│   │   ├── errors.js       # CompletionError class
│   │   ├── user-helpers.js # Pure utility functions
│   │   ├── constants.js    # AUTH_CONFIG, TIMING_CONFIG, RATE_LIMITS
│   │   ├── security.js, byteward.js, device-fingerprint.js
│   │   ├── user-auth-portal.js, forgot-password.js, reset-password.js
│   │   ├── admin-onboarding.js
│   │   ├── preflight.js, turnstile.js, auth-flow.js
│   │   ├── error-mapper.js
│   │   └── index.js        # Barrel export
│   ├── exam/               # Exam runtime (7 files)
│   ├── identity/           # Identity form system (3 files)
│   ├── profile/            # Profile management (2 files)
│   ├── pages/              # Page-specific controllers
│   │   ├── buat-ujian.js       # v0.2.0 — Buat Ujian page controller (window.BuatUjian)
│   │   ├── buat-ujian/         # v0.2.0 — Buat Ujian modules (8 files)
│   │   │   ├── metadata-card.js     # Step 1: info + identity + theme color pickers
│   │   │   ├── soal-card.js         # Step 2: sections + questions list
│   │   │   ├── soal-editor-modal.js # Step 2: question editor modal
│   │   │   ├── publish-card.js      # Step 3: summary + token + publish
│   │   │   ├── wizard-controller.js # Step nav (1→2→3) + list/wizard view toggle
│   │   │   ├── list-view.js         # Default list view (exam cards from Supabase)
│   │   │   ├── templates.js         # Question templates (PG, Esai)
│   │   │   ├── keyboard-shortcuts.js # Cmd+Enter (publish/next), Cmd+N (new question)
│   │   │   └── index.js    # Barrel export
│   │   ├── ujian-peserta.js, daftar-nama.js, panel.js, kerjakan-ujian.js, ujian.js
│   │   └── index.js        # Barrel export
│   ├── utils/              # Shared utilities (10 files)
│   └── ...
├── styles/                 # All CSS (consolidated)
├── pages/                  # HTML pages (route-based)
│   ├── index.html          # Legacy redirect → root (backward-compat)
│   ├── login.html          # Admin login
│   ├── 404.html            # Legacy 404 (only reachable by direct link)
│   ├── admin/              # Admin dashboard + sub-pages
│   └── ujian/              # Exam runner pages
├── public/                 # Static assets
│   ├── images/             # Logo, favicon
│   └── QNotify/            # Embedded notification library
├── supabase/               # Backend (functions, migrations)
├── scripts/                # Build & dev tooling
├── tests/                  # Test suites
├── docs/                   # Documentation
├── index.html              # Landing page (root)
├── 404.html                # Canonical 404 (GitHub Pages auto-serves this)
├── rule-url-albedu.md      # ⭐ URL routing rules — READ BEFORE editing links/redirects
└── package.json
```

**Detail lengkap:** lihat [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

---

## 🧠 Tech Stack

- **Frontend:** Vanilla JS (ES2020+), CSS3, no framework
- **Backend:** Supabase (Postgres + Auth + Edge Functions)
- **Build:** esbuild + lightningcss
- **Test:** Custom Node.js test runner
- **Deploy:** Static host (GitHub Pages, Cloudflare Pages, Netlify)

---

## 📚 Documentation Index

| Doc | Purpose |
|---|---|
| [rule-url-albedu.md](./rule-url-albedu.md) | ⭐ **URL routing rules** — read before editing any link or redirect |
| [docs/README.md](./docs/README.md) | Detailed project overview |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design, data flow, ADRs |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | How to add features, code style |
| [docs/AI-CONTEXT.md](./docs/AI-CONTEXT.md) | Cheat sheet for AI assistants |
| [docs/MIGRATION.md](./docs/MIGRATION.md) | Old → new structure migration guide |
| [docs/UPDATE-GUIDE.md](./docs/UPDATE-GUIDE.md) | v1.0.5 → v1.0.6 changes |

---

## 🤖 For AI Assistants

If you're an AI assistant (Claude, GPT, Copilot, etc.) working on this codebase:

1. **READ [rule-url-albedu.md](./rule-url-albedu.md) FIRST** if your task involves ANY link, redirect, navigation, URL, or 404 — it's the single source of truth for routing.
2. **READ [docs/AI-CONTEXT.md](./docs/AI-CONTEXT.md)** for the broader "kalau disuruh X, edit file Y" lookup table. It contains:
   - Quick lookup table
   - Common pitfalls (DO NOT)
   - Module pattern recognition
   - Database quick reference

---

## 📝 License

MIT — see [LICENSE](./LICENSE)
