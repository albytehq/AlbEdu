# AlbEdu

> Platform asesmen production-grade untuk semua kebutuhan evaluasi — SD, SMP, SMA, kuliah, hingga personal use.
> Vanilla JS + Supabase + Cloudflare — zero framework, zero build runtime.

[![Version](https://img.shields.io/badge/version-v0.818.2-blue)]()
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

Output: `dist/` directory (JS+CSS minified).

### Verify Structure Integrity

```bash
npm run verify
```

---

## 📁 Project Structure (v0.818.2 — By-Feature)

```
AlbEdu/
├── src/                        # All JavaScript source code (94 files)
│   ├── auth/                   # Authentication & security (14 files)
│   │   ├── main.js             # Bootstrap + window.Auth API
│   │   ├── byteward.js         # Route guard (role-based access)
│   │   ├── user-auth-portal.js # Email + Google login
│   │   ├── forgot-password.js, reset-password.js
│   │   ├── admin-onboarding.js # Admin registration
│   │   ├── preflight.js, turnstile.js, auth-flow.js
│   │   ├── security.js, device-fingerprint.js
│   │   ├── errors.js, error-mapper.js, user-helpers.js, constants.js
│   │   └── index.js            # Barrel export
│   ├── platform/               # Service layer — Supabase native (2 files)
│   │   ├── supabase-client.js  # Single Supabase client + auth/db/realtime/rpc
│   │   └── repository.js       # Typed table access helpers
│   ├── shared/                 # Shared design system + boot orchestrator
│   │   ├── head/               # critical-css.js, fonts.js
│   │   ├── icons/              # SVG icon system (8 files, 78KB bundle)
│   │   ├── boot.js, notify.js, error-boundary.js, resilience.js
│   │   ├── qnotify-loader.js, observability.js
│   │   ├── link-prefetch.js, page-transition-overlay.js, view-transitions.js
│   │   └── race-condition.js
│   ├── security/               # Security layer (6 files)
│   │   ├── consent.js          # UU PDP consent gate
│   │   ├── sanitize.js         # DOM sanitization
│   │   ├── anti-cheat.js, heartbeat.js, block-listener.js
│   │   └── devtools-detector.js
│   ├── exam/                   # Exam runtime (2 files: index.js, guardian.js)
│   ├── identity/               # Identity form system (4 files)
│   ├── profile/                # Profile management (4 files)
│   │   ├── option-profile.js   # User dropdown menu
│   │   ├── editor-panel.js     # Profile edit modal
│   │   ├── peserta-profile-fab.js # Floating profile button (peserta side)
│   │   └── index.js
│   ├── pages/                  # Page-specific controllers
│   │   ├── create-assessment.js  # Buat Asesmen page controller
│   │   ├── active-assessments.js # Asesmen Aktif
│   │   ├── monitoring.js         # Real-time monitoring
│   │   ├── results-analytics.js  # Hasil & Analitik
│   │   ├── daftar-nama.js        # Daftar Nama management
│   │   ├── panel.js              # Admin hub controller
│   │   ├── assessment-entry.js   # Peserta token entry
│   │   ├── take-assessment.js    # Peserta assessment runtime
│   │   ├── buat-ujian/           # Buat Asesmen modules (8 files)
│   │   │   ├── metadata-card.js     # Step 1: info + identity + theme
│   │   │   ├── soal-card.js         # Step 2: sections + questions list
│   │   │   ├── soal-editor-modal.js # Step 2: question editor
│   │   │   ├── publish-card.js      # Step 3: summary + token + publish
│   │   │   ├── wizard-controller.js # Step nav + list/wizard toggle
│   │   │   ├── list-view.js         # Default list view
│   │   │   ├── templates.js         # Question templates (PG, Esai)
│   │   │   ├── keyboard-shortcuts.js
│   │   │   └── index.js
│   │   ├── take-assessment/      # Peserta runtime modules (5 files)
│   │   └── index.js
│   ├── theme-system/           # Theme presets + injector (5 files)
│   ├── utils/                  # Shared utilities (10 files)
│   │   ├── navigasi.js         # Sidebar + profile sync
│   │   ├── ui.js, admin-notification-center.js
│   │   ├── self-storage.js, image-compress.js, image-cleanup.js
│   │   ├── math-renderer.js, math-paste-converter.js
│   │   ├── error-manager.js, index.js
│   └── legacy/                 # (deprecated — empty, was firebase-compat)
├── styles/                     # All CSS (29 files)
│   ├── tokens.css              # Design tokens + skeleton system
│   ├── albedu-v1.css, admin-panel.css, navigasi.css
│   ├── profile.css, login.css, landing.css
│   ├── loading.css, skeleton-loading.css
│   ├── pages/                  # Page-specific CSS
│   └── ...
├── pages/                      # HTML pages (23 files)
│   ├── admin/                  # Admin dashboard + sub-pages (9 files)
│   │   ├── index.html          # Admin hub (card layout)
│   │   ├── profile.html        # Profil Admin
│   │   ├── create-assessment.html
│   │   ├── active-assessments.html
│   │   ├── monitoring.html
│   │   ├── results-analytics.html
│   │   ├── daftar-nama.html
│   │   └── buat-ujian.html, data-hasil.html, ujian-peserta.html
│   │       # Legacy redirect stubs (flattened to canonical pages)
│   ├── assessment/             # Peserta assessment pages (4 files)
│   │   ├── index.html          # Token entry
│   │   ├── take.html           # Assessment runtime
│   │   ├── submitted.html      # Success screen
│   │   └── blocked.html        # Blocked screen
│   ├── ujian/                  # Legacy redirect stubs (2 files)
│   ├── login.html, register-admin.html, register-success.html
│   ├── forgot-password.html, reset-password.html
│   ├── privacy-policy.html     # Kebijakan Privasi v4.0.0
│   └── 404.html
├── public/                     # Static assets
│   ├── images/                 # Logo, favicon
│   ├── fonts/                  # Plus Jakarta Sans, JetBrains Mono
│   ├── QNotify/                # Embedded notification library (20 files)
│   ├── lib/actly/              # Resilience library
│   ├── service-worker.js       # PWA service worker
│   └── manifest.json           # PWA manifest
├── supabase/                   # Backend
│   ├── functions/              # 12 Edge Functions
│   │   ├── _shared/            # Shared modules (9 files: auth, audit, cors, db, error, rate-limit, realtime, turnstile, types)
│   │   ├── access-code-attempt/
│   │   ├── assessment-lifecycle/
│   │   ├── block-participant/
│   │   ├── cleanup-assessment/
│   │   ├── data-export/
│   │   ├── dsr-handler/
│   │   ├── health-check/
│   │   ├── heartbeat/
│   │   ├── register-admin/
│   │   ├── submit-assessment/
│   │   ├── user-auth-complete/
│   │   └── user-auth-preflight/
│   ├── migrations/             # 22 SQL migration files
│   ├── config.toml
│   └── README.md
├── cloudflare-worker/          # Cloudflare Worker (v6.0)
│   ├── worker-v6.js
│   └── README.md
├── scripts/                    # Build & dev tooling
├── tests/                      # Test suites (TODO)
├── docs/                       # Documentation
├── index.html                  # Landing page (root)
├── 404.html                    # Canonical 404
├── rule-url-albedu.md          # ⭐ URL routing rules — READ BEFORE editing links/redirects
└── package.json
```

---

## 🧠 Tech Stack

- **Frontend:** Vanilla JS (ES2020+), CSS3, no framework
- **Backend:** Supabase (Postgres + Auth + Edge Functions)
- **Build:** esbuild + lightningcss
- **Deploy:** Static host (GitHub Pages, Cloudflare Pages, Netlify)
- **CDN/Edge:** Cloudflare (CDN + Turnstile + Worker v6.0)

---

## 📚 Documentation Index

| Doc | Purpose |
|---|---|
| [rule-url-albedu.md](./rule-url-albedu.md) | ⭐ **URL routing rules** — read before editing any link or redirect |
| [docs/README.md](./docs/README.md) | Documentation index |
| [docs/ARCHITECTURE-FINAL.md](./docs/ARCHITECTURE-FINAL.md) | System design, three-stage refactor summary |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | How to add features, code style |
| [docs/AI-CONTEXT.md](./docs/AI-CONTEXT.md) | Cheat sheet for AI assistants |
| [docs/SECURITY.md](./docs/SECURITY.md) | Security architecture + RLS matrix |
| [docs/COMPLIANCE.md](./docs/COMPLIANCE.md) | UU PDP compliance checklist |
| [docs/SCALING.md](./docs/SCALING.md) | Scaling notes (Supabase Free Plan) |
| [docs/ICON-SYSTEM-ENTERPRISE.md](./docs/ICON-SYSTEM-ENTERPRISE.md) | Icon system v7.0 |
| [docs/THEME-SYSTEM.md](./docs/THEME-SYSTEM.md) | Theme system |
| [docs/PAGE-TEMPLATE.html](./docs/PAGE-TEMPLATE.html) | Canonical page template |
| [docs/asset-system/ROADMAP.md](./docs/asset-system/ROADMAP.md) | 🆕 Asset system migration roadmap (v0.818.2+) |
| [docs/asset-system/ARCHITECTURE-V2.md](./docs/asset-system/ARCHITECTURE-V2.md) | 🆕 New asset system architecture (Supabase + B2 + Magic Compress™ v2) |
| [docs/asset-system/BACKBLAZE-SETUP.md](./docs/asset-system/BACKBLAZE-SETUP.md) | 🆕 Step-by-step BackBlaze B2 + Cloudflare Bandwidth Alliance setup |

---

## 🖼️ Asset System (v0.818.2+)

AlbEdu's asset system (avatar + assessment images) is being migrated from GitHub repos to **Supabase Storage + Backblaze B2** with **Magic Compress™** technology.

> ⚠️ **Cloudflare R2 is EXCLUDED** — requires credit card even for free tier. AlbEdu uses BackBlaze B2 instead (10 GB free, no CC, free egress via Cloudflare Bandwidth Alliance).

### Current State (v0.818.2 — Phase 0 complete)
- ✅ `assets_manifest` migration created with RLS, indexes, CHECK constraints
- ✅ Magic Compress™ v2 implemented (`src/utils/image-compress.js` + `image-compress-worker.js`) — perceptual compression with complexity analysis, MozJPEG WASM, SSIM quality check
- ✅ BackBlaze B2 setup guide created (`docs/asset-system/BACKBLAZE-SETUP.md`)
- ✅ Documentation corrected (removed false `deleted_at` / R2 / 365-day retention claims)
- ⏳ Avatar migration to Supabase Storage (Phase 1 — next)
- ⏳ Assessment image upload UI + B2 (Phase 2)
- ⏳ GC migration to Supabase Edge Function (Phase 3)
- ⏳ Cloudflare Worker repurpose as edge cache (Phase 4)
- ⏳ GitHub repos decommission (Phase 5)
- ⏳ Monitoring & alerting (Phase 6)

### Magic Compress™ v2 (Perceptual Compression)
Not "quality = 80" but "human eye barely sees the difference." Every uploaded image goes through a 9-stage adaptive pipeline:

1. **Decode** → ImageBitmap
2. **Smart Resize** → fit to max 1920×1080, no upscale
3. **Complexity Analysis** → Shannon Entropy + Sobel Edge Density + Laplacian Noise + Color Variance → Score (0-100) → Tier (low/med/high)
4. **Smart Denoise** → conditional Gaussian (only if noisy)
5. **Adaptive Sharpen** → unsharp mask (intensity by complexity)
6. **MozJPEG Encode** → WASM with progressive + optimized Huffman + trellis + 4:2:0 (fallback: Canvas)
7. **Binary Search Quality** → target 80-300 KB (converges in 6 steps)
8. **Resolution Fallback** → 1920→1700→1500→1280 if quality floor (q35) hit
9. **SSIM Check** → structural similarity (>0.95 excellent, 0.85-0.95 good, <0.75 poor)

**Result:** 10 MB input → 80-300 KB JPEG in 2-4 seconds. 15-25% smaller than v1 at same visual quality. B2 10 GB free tier lasts **90+ years** at current scale.

**Web Worker:** non-blocking compression via `src/utils/image-compress-worker.js` — UI stays responsive during 4-second compression.

See [`docs/asset-system/ARCHITECTURE-V2.md`](./docs/asset-system/ARCHITECTURE-V2.md) §3.8 for full pipeline details and [`docs/asset-system/BACKBLAZE-SETUP.md`](./docs/asset-system/BACKBLAZE-SETUP.md) for B2 setup instructions.

---

## 🤖 For AI Assistants

If you're an AI assistant (Claude, GPT, Copilot, etc.) working on this codebase:

1. **READ [rule-url-albedu.md](./rule-url-albedu.md) FIRST** if your task involves ANY link, redirect, navigation, URL, or 404 — it's the single source of truth for routing.
2. **READ [docs/AI-CONTEXT.md](./docs/AI-CONTEXT.md)** for the broader "kalau disuruh X, edit file Y" lookup table.

---

## 📝 License

MIT — see [LICENSE](./LICENSE)
