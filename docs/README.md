# AlbEdu — Documentation Index

> Index halaman dokumentasi AlbEdu v0.819.0

---

## Documentation Index

| Doc | Purpose | Audience |
|---|---|---|
| [../README.md](../README.md) | Project overview, quick start, structure | All |
| [ARCHITECTURE-FINAL.md](./ARCHITECTURE-FINAL.md) | System design, three-stage refactor summary | Developers, Architects |
| [STRICT-COMMENTING-FOR-AI.md](./STRICT-COMMENTING-FOR-AI.md) | Human-style commenting rules (MUST READ before editing any file) | AI assistants, Contributors |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to add features, code style, PR checklist | Contributors |
| [AI-CONTEXT.md](./AI-CONTEXT.md) | Cheat sheet for AI assistants | AI assistants, New devs |
| [SECURITY.md](./SECURITY.md) | Security architecture, RLS matrix, anti-cheat | Security reviewers |
| [COMPLIANCE.md](./COMPLIANCE.md) | UU PDP compliance checklist | Compliance |
| [SCALING.md](./SCALING.md) | Scaling notes (Supabase Free Plan) | Ops |
| [ICON-SYSTEM-ENTERPRISE.md](./ICON-SYSTEM-ENTERPRISE.md) | Icon system v7.0 (101 icons) | Frontend |
| [THEME-SYSTEM.md](./THEME-SYSTEM.md) | Theme presets + injector | Frontend |
| [PAGE-TEMPLATE.html](./PAGE-TEMPLATE.html) | Canonical page head template | Frontend |
| [USER-SIMULATION-CHECKLIST.md](./USER-SIMULATION-CHECKLIST.md) | Manual test scenarios | QA |

---

## Quick Navigation

### Untuk Developer Baru

1. Baca [../README.md](../README.md) dulu — quick start, install, run
2. Baca [AI-CONTEXT.md](./AI-CONTEXT.md) — cheat sheet untuk locate code
3. Baca [ARCHITECTURE-FINAL.md](./ARCHITECTURE-FINAL.md) — system design summary
4. Baca [CONTRIBUTING.md](./CONTRIBUTING.md) — code style, cara add feature

### Untuk AI Assistant

1. Baca [AI-CONTEXT.md](./AI-CONTEXT.md) FIRST — quick lookup table
2. Baca [../rule-url-albedu.md](../rule-url-albedu.md) kalau task involves links/redirects
3. Pakai [CONTRIBUTING.md](./CONTRIBUTING.md) untuk naming convention

### Untuk Security/Compliance Review

1. Baca [SECURITY.md](./SECURITY.md) — RLS matrix, anti-cheat, Turnstile
2. Baca [COMPLIANCE.md](./COMPLIANCE.md) — UU PDP checklist
3. Baca [../pages/privacy-policy.html](../pages/privacy-policy.html) — privacy policy v4.0.0 (honest disclosure)

---

## Project Stats (v0.819.0)

| Metric | Value |
|---|---|
| JS files | 94 (di `src/`) |
| CSS files | 29 (di `styles/`) |
| HTML pages | 25 (23 di `pages/` + 2 root) |
| Documentation files | 12 (di `docs/`) |
| Edge Functions | 12 (di `supabase/functions/`) |
| SQL migrations | 22 (di `supabase/migrations/`) |
| Largest JS file | `src/shared/icons/icons.js` (~78KB) |
| Total source size | ~6.6MB |
| Dependencies | esbuild, lightningcss, jsdom (dev only); actly (runtime) |

---

## Folder Structure Summary

```
AlbEdu/
├── src/                    # JavaScript source (94 files, by-feature)
│   ├── auth/               # 14 files — Authentication & security
│   ├── platform/           # 2 files  — Supabase native client + repository
│   ├── shared/             # 12 files — Design system, boot, icons, notify
│   ├── security/           # 6 files  — Consent, sanitize, anti-cheat
│   ├── exam/               # 2 files  — Exam runtime (guardian)
│   ├── identity/           # 4 files  — Identity form system
│   ├── profile/            # 4 files  — Profile management
│   ├── pages/              # 11 files — Page controllers + 2 sub-modules
│   ├── theme-system/       # 5 files  — Theme presets + injector
│   ├── utils/              # 10 files — Shared utilities
│   └── legacy/             # (deprecated — was firebase-compat)
├── styles/                 # 29 CSS files
├── pages/                  # 23 HTML pages (admin, assessment, auth, public)
├── public/                 # Static assets (QNotify, fonts, images)
├── supabase/               # 12 Edge Functions + 22 migrations
├── cloudflare-worker/      # Worker v6.0 (CDN + cron)
├── scripts/                # Build & dev tooling
├── tests/                  # Test suites (TODO)
├── docs/                   # 12 documentation files
├── index.html              # Landing page (root)
├── rule-url-albedu.md      # URL routing rules
└── package.json            # v0.819.0
```

---

## External Resources

- **Supabase Dashboard:** https://supabase.com/dashboard
- **Cloudflare Worker:** `edu.albyte-inc.workers.dev` (current v6.0; legacy `albedu.examjuniorhighschool.workers.dev` deprecated)
- **Production URL:** https://albytehq.github.io/AlbEdu/ (GitHub Pages)

---

## Deleted Docs (historical reference)

Dokumen berikut telah dihapus karena isinya stale/sudah tidak akurat:

- ~~`docs/ARCHITECTURE.md`~~ — mengacu pada legacy v0.2.0 schema (`exams`, `exam_tokens`) yang sudah tidak ada. Diganti dengan [ARCHITECTURE-FINAL.md](./ARCHITECTURE-FINAL.md).
- ~~`docs/UPDATE-GUIDE.md`~~ — pre-restructure paths (`admin/pages/`, `assets/css/`). Tidak relevan lagi.
- ~~`docs/ICON-SYSTEM.md`~~ — v6.0, sudah superseded oleh [ICON-SYSTEM-ENTERPRISE.md](./ICON-SYSTEM-ENTERPRISE.md) v7.0.
- ~~`docs/MIGRATION.md`~~ — tidak pernah dibuat, tapi beberapa file referensi ke dokumen ini. Link sudah dihapus.
