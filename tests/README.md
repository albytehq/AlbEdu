# AlbEdu Tests

This folder contains test suites for the AlbEdu project.

## Available Tests

> **Note:** Test scripts need to be copied from the original `albedu-tests/` sibling folder (if available).

### Smoke Test (Manual)

Run the dev server and verify all 15 pages load without console errors:

```bash
npm run dev
```

Open each URL in the browser:
- http://127.0.0.1:8765/
- http://127.0.0.1:8765/pages/login.html
- http://127.0.0.1:8765/pages/admin/index.html
- http://127.0.0.1:8765/pages/ujian/index.html

### Structure Verify (Automated)

```bash
npm run verify
```

Runs `scripts/verify-structure.mjs` which checks:
- All expected folders exist
- No orphan files in old paths
- All HTML references resolve
- All ES module imports resolve
- All feature folders have barrel `index.js`
- Required docs and config files exist

### JS Syntax Check (Automated)

```bash
python3 /path/to/verify-js-syntax.py
```

Runs `node --check` on all JS files in `src/` and `scripts/`.

## Test Phases (Planned)

| Phase | Description | Status |
|---|---|---|
| Phase 1 | User simulation (login, register, forgot password) | TODO |
| Phase 2 | Wizard flow (4-step exam creation) | TODO |
| Phase 3 | Exam runner (token entry, kerjakan ujian, submit) | TODO |
| Phase 4 | Edge cases (concurrent logout, network failure, etc.) | TODO |
| Phase 5 | Performance benchmarks | TODO |

## Running Tests

Once test scripts are added:

```bash
npm test                # Run all phases
node tests/phase1-user-sim.js   # Run specific phase
```

## Test Reports

Test reports will be saved to `tests/reports/` (created on first run).
