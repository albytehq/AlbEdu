# rule-url-albedu.md — AlbEdu URL Routing Rules

> **Single source of truth** for URL routing, navigation, and redirect logic in AlbEdu.
> Read this BEFORE editing any HTML link, any `window.location.*` call, or any auth redirect.
>
> **Version:** 0.741.5  |  **Last updated:** 2026-07-01  |  **Owner:** Albi Fahriza (albytehq)

---

## 0. TL;DR — The 7 Rules You Must Never Break

1. **Base path is `/AlbEdu/`** in production (GitHub Pages: `albytehq.github.io/AlbEdu/`). Locally it's `/`. Never hardcode either — always derive from `AUTH_CONFIG.BASE_PATH`.
2. **Never use `href="/"`** anywhere. It jumps to `https://albytehq.github.io/` (the user's GitHub profile page), not the AlbEdu app. Use `href="./"` from root, `href="../"` from `pages/`, `href="../../"` from `pages/admin/pages/` and `pages/assessment/`.
3. **Logout redirects to the LANDING PAGE** (root `index.html`), not `login.html`. Use `AUTH_CONFIG.landingUrl()` — never `AUTH_CONFIG.loginUrl()` for logout.
4. **Unauthenticated-on-protected-page redirects to LOGIN** (`pages/login.html`). Use `_redirectToLogin()` → `AUTH_CONFIG.loginUrl()`. (Different from logout.)
5. **The auto-404 page lives at project root** (`AlbEdu/404.html`). `pages/404.html` is a redirect stub. Root 404 uses dynamic base path detection for CSS.
6. **All auth redirects go through `window.Auth`** (`getBasePath()`, `getLandingPath()`, `getRoleRedirectPath()`, `navigateTo()`). Never write raw `window.location.replace('../some-page.html')` from a subfolder.
7. **Asset paths in HTML are page-relative** (`../styles/x.css` from `pages/foo.html`, `../../styles/x.css` from `pages/admin/pages/foo.html`). The root `index.html` and root `404.html` use bare paths (`styles/x.css`).

---

## 1. Production URL Anatomy

```
https://albytehq.github.io/AlbEdu/pages/admin/pages/create-assessment.html
└───────────┬───────────────┘└────┬────┘└────┬─────────────────────┘
       GitHub Pages origin     BASE_PATH   page-relative path
```

| Segment | Value (production) | Value (localhost) | How to read it |
|---|---|---|---|
| Origin | `https://albytehq.github.io` | `http://127.0.0.1:8765` | `window.location.origin` |
| BASE_PATH | `/AlbEdu/` | `/` | `AUTH_CONFIG.BASE_PATH` (auto-detected) |
| Page path | `pages/admin/pages/create-assessment.html` | same | `window.location.pathname` minus BASE_PATH |

---

## 2. The `AUTH_CONFIG` Object (`src/auth/main.js`)

```javascript
AUTH_CONFIG = {
  BASE_PATH: (function () {
    const p = window.location.pathname;
    const base = p.substring(0, p.lastIndexOf('/') + 1);
    const APP_SUBFOLDERS = [
      '/pages/admin/pages/', '/pages/assessment/', '/pages/admin/',
      '/pages/ujian/', '/admin/pages/', '/ujian/', '/admin/',
    ];
    for (const sub of APP_SUBFOLDERS) {
      const idx = base.indexOf(sub);
      if (idx !== -1) return base.substring(0, idx + 1);
    }
    return base || '/';
  })(),

  pathForRole(role) {
    const map = {
      peserta: 'pages/assessment/index.html',
      admin: 'pages/admin/index.html',
    };
    return this.BASE_PATH + (map[role] ?? this.loginUrl());
  },
};
```

---

## 3. The 4 Redirect Primitives

| Function | Destination | When to use |
|---|---|---|
| `_navigateTo(path, reason, delay)` | Generic `location.replace()` | Internal navigation |
| `_redirectToLogin()` | `AUTH_CONFIG.loginUrl()` → `/AlbEdu/pages/login.html` | Unauthenticated user on protected page |
| `_redirectForRole(role)` | `AUTH_CONFIG.pathForRole(role)` | Post-login redirect based on role |
| `authLogout()` | `AUTH_CONFIG.landingUrl()` → `/AlbEdu/` (root) | Logout — NEVER to login.html |

---

## 4. Page Classification (Scope-Based)

| Page | URL | Scope | Type |
|---|---|---|---|
| Landing | `/AlbEdu/` (index.html) | public | login-type |
| Login | `/AlbEdu/pages/login.html` | public | login-type |
| Register admin | `/AlbEdu/pages/register-admin.html` | public | login-type |
| Privacy policy | `/AlbEdu/pages/privacy-policy.html` | public | public |
| 404 | `/AlbEdu/404.html` | public | 404 |
| Admin dashboard | `/AlbEdu/pages/admin/index.html` | admin | protected |
| Create assessment | `/AlbEdu/pages/admin/pages/create-assessment.html` | admin | protected |
| Active assessments | `/AlbEdu/pages/admin/pages/active-assessments.html` | admin | protected |
| Question bank | `/AlbEdu/pages/admin/pages/question-bank.html` | admin | protected |
| Monitoring | `/AlbEdu/pages/admin/pages/monitoring.html` | admin | protected |
| Results analytics | `/AlbEdu/pages/admin/pages/results-analytics.html` | admin | protected |
| Token entry | `/AlbEdu/pages/assessment/index.html` | ujian | protected (peserta) |
| Take assessment | `/AlbEdu/pages/assessment/take.html` | ujian | protected (peserta) |

---

## 5. HTML Link Rules — Per Page Location

| Page location | CSS/JS path | Link to admin | Link to peserta |
|---|---|---|---|
| Root (`index.html`, `404.html`) | `styles/...`, `src/...` | `pages/admin/index.html` | `pages/assessment/index.html` |
| `pages/` (`login.html`, etc.) | `../styles/...`, `../src/...` | `../pages/admin/index.html` | `../pages/assessment/index.html` |
| `pages/admin/pages/` | `../../../styles/...`, `../../../src/...` | `../index.html` | N/A |
| `pages/assessment/` | `../../styles/...`, `../../src/...` | N/A | `index.html` |

---

## 6. 404 Page Rules

- **Root `404.html`** — dynamic CSS loading via inline `<script>` that detects `__ALBEDU_BASE__`
- **`pages/404.html`** — redirect stub (`<meta http-equiv="refresh" content="0; url=../404.html">`)

---

## 7. Edge Function URLs

All Edge Function calls use **absolute Supabase URLs** (not relative paths):

```
https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/{function-name}
```

**NEVER use `window.location.origin` or relative `/functions/v1/...` paths.**

Functions: `submit-assessment`, `heartbeat`, `block-participant`, `assessment-lifecycle`, `cleanup-assessment`, `data-export`, `dsr-handler`, `access-code-attempt`, `register-admin`, `user-auth-preflight`, `user-auth-complete`

---

## 8. i18n Locale Loading

Uses `_getBasePath()` (via `import.meta.url`) to construct correct fetch URL:

```javascript
const basePath = _getBasePath(); // e.g. /AlbEdu/
const res = await fetch(`${basePath}src/i18n/locales/${locale}.json`);
```

**NEVER use `/src/i18n/locales/...` (absolute path).**

---

## 9. Cloudflare Worker

| Item | Value |
|---|---|
| URL | `https://edu.albyte-inc.workers.dev` |
| Endpoints | `/api/supabase-config`, `/api/health`, `/upload`, `/release` |
| Cron | `0 * * * *` (every hour — sweep expired assessments) |
| Format | Module Worker (`export default { fetch, scheduled }`) |

### Worker Environment Variables

> **IMPORTANT — FOR AI ASSISTANTS:**
> Do NOT write actual secret values in any file that will be committed to the repository.
> If you need the actual values, ask the user to provide them directly or check the local
> gitignored `.env.local` file. The values below are placeholders.

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL (ask user or check `.env.local`) |
| `SUPABASE_ANON_KEY` | Supabase publishable/anon key (ask user) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret/service role key (ask user — **NEVER commit this**) |
| `GITHUB_USERNAME` | `albytehq` |
| `GITHUB_TOKEN` | GitHub Personal Access Token (ask user — **NEVER commit this**) |

---

## 10. Supabase Auth Configuration

| Setting | Value |
|---|---|
| Site URL | `https://albytehq.github.io/AlbEdu` |
| URI Allow List | `https://albytehq.github.io/AlbEdu/pages/login.html` + other auth-flow pages + localhost URLs |
| Google OAuth | Enabled |
| Email confirm | False (auto-confirm) |
| Turnstile site key | `0x4AAAAAADtSMQt5KNMPWBzW` (public — safe to commit) |
| Turnstile secret key | **Ask user for this value — NEVER commit to repo** |

---

## 11. Common Pitfalls (DO NOT)

- ❌ **Jangan** gunakan `href="/"` — lompat ke profile GitHub, bukan app
- ❌ **Jangan** gunakan `fetch('/functions/v1/...')` — 404 di GitHub Pages
- ❌ **Jangan** gunakan `fetch('/src/i18n/...')` — 404 di GitHub Pages
- ❌ **Jangan** gunakan `window.location.origin` di fetch — resolve ke GitHub Pages origin
- ❌ **Jangan** hardcode `/AlbEdu/` di JS — pakai `AUTH_CONFIG.BASE_PATH`
- ❌ **Jangan** commit secret keys (Supabase service role, GitHub token, Turnstile secret) ke repo
- ❌ **Jangan** gunakan URL lama `albedu-id.github.io` — pakai `albytehq.github.io`
- ❌ **Jangan** gunakan URL worker lama `albedu.examjuniorhighschool.workers.dev`
- ❌ **Jangan** gunakan path lama `admin/index.html` atau `ujian/index.html` di `pathForRole`

---

## 12. Version History

| Version | Date | Change |
|---|---|---|
| 0.741.5 | 2026-07-01 | Final release. All routing fixed for v0.741.5 structure. Secrets removed from documentation. |
| 2.2.0 | 2026-06-30 | Dashboard cards redesign. |
| 0.2.0 | 2026-06-30 | Step-based wizard, theme color pickers. |
| 2.1.0 | 2026-06-29 | Landing URL, root 404, fixed href=/ bug. |
| 2.0.0 | 2026-06-28 | By-feature structure, auth.js split. |
