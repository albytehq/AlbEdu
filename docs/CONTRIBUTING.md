# Contributing to AlbEdu

**Version:** v0.821.0
**Last updated:** 2026-07-08

---

## Development Setup

```bash
git clone <repo>
cd AlbEdu
npm install
npm run dev
```

Buka http://127.0.0.1:8765/ di browser.

---

## Before You Edit

Before writing or modifying any code in this repo, read [`docs/STRICT-COMMENTING-FOR-AI.md`](./STRICT-COMMENTING-FOR-AI.md). That document codifies the human-style commenting rules that all contributors (human AND AI assistant) must follow. The rules exist because the codebase accumulated ~1,400+ AI-generated noise patterns (ASCII-art headers, version archaeology, marketing-speak, JSDoc on internal helpers) that made the code harder to read, not easier.

The 5 rules in brief:

1. Comments explain WHY, not WHAT. Don't restate the code in English.
2. No ASCII art, no boxes, no dividers. A single-line `// filename.js — description` is the only file header allowed.
3. No version archaeology. Git blame already records when a line changed.
4. No marketing-speak. "Enterprise-grade", "robust", "seamless" are banned.
5. JSDoc only on public API (exported functions, `window.AlbEdu.*` namespace). Internal helpers get a one-liner or nothing.

PRs that violate these rules will be requested-for-changes — even if the code logic is correct. The reviewer will run `rg -n '^/\* ={5,}' src/` and similar greps (see the "Enforcement" section of that doc) before approving.

Also read [`docs/AI-CONTEXT.md`](./AI-CONTEXT.md) for a quick lookup table of "if you need to change X, edit file Y". And if your task involves URLs, redirects, or navigation, read [`rule-url-albedu.md`](../rule-url-albedu.md) FIRST — there are 7 routing rules that are easy to break by accident.

---

## Code Style

### JavaScript

- **Indentation:** 4 spaces
- **Quotes:** Single quotes (`'`)
- **Semicolons:** Required
- **Naming:** 
  - Files: `kebab-case.js` (e.g., `auth-manager.js`)
  - Classes: `PascalCase` (e.g., `WizardController`)
  - Functions: `camelCase` (e.g., `redirectToLogin`)
  - Constants: `SCREAMING_SNAKE_CASE` (e.g., `AUTH_CONFIG`)
  - Private: `_underscorePrefix` (e.g., `_currentUser`)
- **Exports:** Named exports only. NO default exports.
- **Header comment:** Wajib di setiap file (lihat template di bawah)

### File Header Template

```javascript
/**
 * {filename} — {One-line description}
 *
 * {Detailed description}
 *
 * Dependencies:
 *   - {dependency 1}
 *
 * Public API:
 *   - {export 1}: {description}
 *
 * @module {feature-folder}
 * @since v2.0.0
 */
```

### CSS

- **Indentation:** 2 spaces
- **Naming:** BEM-ish (`.block__element--modifier`)
- **Mobile-first:** responsive
- **Variables:** Use CSS custom properties dari `styles/tokens.css`
- **No `!important`** tanpa comment justifikasi

### HTML

- **Indentation:** 2 spaces
- **Semantic tags:** `<main>`, `<nav>`, `<article>`
- **Alt text:** Wajib untuk `<img>`
- **`lang="id"`** di `<html>`

---

## How to Add a New Feature

### Scenario: Tambah feature "exam archive"

#### Step 1: Bikin folder feature

```
src/exam-archive/
├── index.js                # Barrel export
├── archive-controller.js   # Main logic
└── archive-viewer.js       # UI rendering
```

#### Step 2: Bikin `index.js` (barrel)

```javascript
// src/exam-archive/index.js
export const ArchiveController = window.ArchiveController;
export const ArchiveViewer    = window.ArchiveViewer;

export default { ArchiveController, ArchiveViewer };
```

#### Step 3: Bikin HTML page

```
pages/admin/exam-archive.html
```

> Admin HTML pages live directly under `pages/admin/` — the
> old `pages/admin/pages/` subfolder has been flattened. Use `../../` for
> asset paths (`../../styles/...`, `../../src/...`) from any admin page.

```html
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>Exam Archive — AlbEdu Admin</title>
    <link rel="stylesheet" href="../../styles/tokens.css">
    <link rel="stylesheet" href="../../styles/navigasi.css">
    <link rel="stylesheet" href="../../styles/exam-archive.css">
</head>
<body>
    <!-- Page content -->
    <script src="../../src/platform/supabase-client.js" defer></script>
    <script src="../../src/platform/repository.js" defer></script>
    <script src="../../src/auth/main.js" defer></script>
    <script src="../../src/exam-archive/archive-controller.js" defer></script>
    <script src="../../src/exam-archive/archive-viewer.js" defer></script>
</body>
</html>
```

#### Step 4: Bikin CSS

```
styles/exam-archive.css
```

#### Step 5: Tambah navigasi link

Edit `src/utils/navigasi.js` — tambah menu item di sidebar.

#### Step 6: Test

1. Manual test flow exam archive
2. Test di 3 browser (Chrome, Firefox, Safari)
3. Test mobile viewport (375px)

#### Step 7: Update docs

- `docs/ARCHITECTURE-FINAL.md` — tambah ke module dependency graph
- `docs/AI-CONTEXT.md` — tambah "Exam Archive" row di lookup table

---

## Pull Request Checklist

- [ ] Code follows style guide (run `npm run lint`)
- [ ] File header comment ada di setiap file JS baru
- [ ] `npm run dev` berjalan tanpa error
- [ ] `npm run build` berjalan tanpa error
- [ ] `npm run verify` lulus (structure integrity)
- [ ] Manual smoke test done
- [ ] Docs updated (ARCHITECTURE.md if structural change)
- [ ] Commit message follows conventional commits

---

## Commit Message Convention

Pakai [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

### Types

- `feat` — New feature
- `fix` — Bug fix
- `refactor` — Code refactor (no behavior change)
- `docs` — Documentation only
- `test` — Test additions/changes
- `chore` — Build, dependencies, config
- `perf` — Performance improvement
- `style` — Code style (formatting, no logic change)

### Scopes

- `auth` — Authentication & security
- `buat-ujian` — Assessment creation wizard (`src/pages/buat-ujian/`)
- `exam` — Exam runtime
- `identity` — Identity form system
- `profile` — Profile management
- `pages` — Page-specific controllers
- `utils` — Shared utilities
- `styles` — CSS
- `structure` — File structure changes
- `docs` — Documentation
- `build` — Build pipeline

### Examples

```bash
feat(exam): add archive feature with filter by date
fix(auth): handle null user on redirect after signOut
refactor(buat-ujian): split controller into submodules
docs: update ARCHITECTURE.md with new ADR
test: add phase5 exam archive tests
chore: bump esbuild to 0.25.0
```

---

## Branch Naming

- `feat/{feature-name}` — new feature (e.g., `feat/exam-archive`)
- `fix/{bug-description}` — bug fix (e.g., `fix/login-redirect-loop`)
- `refactor/{scope}` — code refactor (e.g., `refactor/auth-split`)
- `docs/{topic}` — documentation only

---

## Issue Reporting

### Bug Report Template

```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. See error

**Expected behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots.

**Environment**
- OS: [e.g., iOS]
- Browser: [e.g., Chrome 120]
- Version: [e.g., 2.0.0]

**Additional context**
Add any other context about the problem here.
```

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of the problem.

**Proposed solution**
A clear description of what you want to happen.

**Alternatives considered**
Any alternative solutions you've considered.

**Additional context**
Add any other context or screenshots about the feature request here.
```

---

## Code Review Guidelines

### What to Look For

1. **Correctness** — Does the code do what it claims?
2. **Security** — Any XSS, injection, or auth bypass risks?
3. **Performance** — Any unnecessary re-renders, N+1 queries, or memory leaks?
4. **Maintainability** — Is the code readable? Are functions < 50 lines?
5. **Tests** — Are there tests for new features?
6. **Docs** — Are docs updated for structural changes?

### Review Etiquette

- Be kind and constructive
- Suggest improvements, don't just criticize
- Use `nit:` prefix for minor style issues
- Approve with `LGTM` (Looks Good To Me) when ready

---

## Release Process

### Version Numbering (SemVer)

- `MAJOR.MINOR.PATCH` (e.g., `2.0.0`)
- MAJOR: breaking changes
- MINOR: new features (backward compatible)
- PATCH: bug fixes (backward compatible)

### Release Steps

1. Update `package.json` version
2. Update `docs/ARCHITECTURE-FINAL.md` "Last updated" date
3. Run full test suite
4. Create git tag: `git tag v2.0.1`
5. Push tag: `git push origin v2.0.1`
6. Deploy `dist/` ke production
7. Update `rule-url-albedu.md` changelog dengan version baru

---

## Getting Help

- **Documentation:** Start with [docs/README.md](./README.md)
- **Architecture:** [docs/ARCHITECTURE-FINAL.md](./ARCHITECTURE-FINAL.md) — three-stage refactor summary
- **AI Assistant Guide:** [docs/AI-CONTEXT.md](./AI-CONTEXT.md)
- **Migration Help:** [docs/ARCHITECTURE-FINAL.md](./ARCHITECTURE-FINAL.md) — three-stage refactor summary. (Note: `docs/MIGRATION.md` was planned but never created.)
