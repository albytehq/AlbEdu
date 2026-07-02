# AlbEdu — Detailed Documentation

> Index halaman dokumentasi AlbEdu v2.0.0

---

## Documentation Index

| Doc | Purpose | Audience |
|---|---|---|
| [../README.md](../README.md) | Project overview, quick start | All |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flow, ADRs | Developers, Architects |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to add features, code style, PR checklist | Contributors |
| [AI-CONTEXT.md](./AI-CONTEXT.md) | Cheat sheet for AI assistants | AI assistants, New devs |
| [MIGRATION.md](./MIGRATION.md) | v1.x → v2.0.0 migration guide | Maintainers |
| [UPDATE-GUIDE.md](./UPDATE-GUIDE.md) | v1.0.5 → v1.0.6 changes (pre-restructure) | Maintainers |

---

## Quick Navigation

### Untuk Developer Baru

1. Baca [../README.md](../README.md) dulu — quick start, install, run
2. Baca [AI-CONTEXT.md](./AI-CONTEXT.md) — cheat sheet untuk locate code
3. Baca [ARCHITECTURE.md](./ARCHITECTURE.md) — system design, data flow
4. Baca [CONTRIBUTING.md](./CONTRIBUTING.md) — code style, cara add feature

### Untuk AI Assistant

1. Baca [AI-CONTEXT.md](./AI-CONTEXT.md) FIRST — quick lookup table
2. Baca [ARCHITECTURE.md](./ARCHITECTURE.md) kalau perlu deeper context
3. Pakai [CONTRIBUTING.md](./CONTRIBUTING.md) untuk naming convention

### Untuk Maintainer (Upgrade v1 → v2)

1. Baca [MIGRATION.md](./MIGRATION.md) — step-by-step migration
2. Baca [UPDATE-GUIDE.md](./UPDATE-GUIDE.md) — pre-restructure changes (v1.0.5)
3. Test dengan checklist di MIGRATION.md

---

## Project Stats (v2.0.0)

| Metric | Value |
|---|---|
| Total source files | 132 |
| JS files | 41 (di `src/`) |
| CSS files | 21 (di `styles/`) |
| HTML pages | 15 (di `pages/`) |
| Documentation files | 5 (di `docs/`) |
| Largest JS file | `src/wizard/controller.js` (~83KB, ~2200 lines) |
| Largest CSS file | `styles/wizard.css` (~60KB) |
| Total source size | ~2.1MB |
| Build size (minified) | ~1.5MB (-28%) |
| Dependencies | esbuild, lightningcss (dev only) |

---

## Folder Structure Summary

```
AlbEdu/
├── src/                    # JavaScript source (by-feature)
│   ├── auth/               # 17 files — Authentication & security
│   ├── wizard/             # 4 files  — Exam creation wizard
│   ├── exam/               # 7 files  — Exam runtime
│   ├── identity/           # 3 files  — Identity form system
│   ├── profile/            # 2 files  — Profile management
│   ├── pages/              # 6 files  — Page-specific controllers
│   └── utils/              # 11 files — Shared utilities
├── styles/                 # CSS (consolidated)
├── pages/                  # HTML (route-based)
├── public/                 # Static assets (images, QNotify)
├── supabase/               # Backend (functions, migrations)
├── scripts/                # Build & dev tooling
├── tests/                  # Test suites
├── docs/                   # This documentation
├── index.html              # Landing page (root, served at /)
├── package.json            # v2.0.0
└── README.md               # Project overview
```

---

## External Resources

- **Supabase Dashboard:** https://supabase.com/dashboard
- **Cloudflare Worker:** `albedu.examjuniorhighschool.workers.dev`
- **Production URL:** https://albedu.examjuniorhighschool.com (or as configured)
