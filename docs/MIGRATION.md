# Migration Guide — v1.x → v2.0.0

**Date:** 2026-06-28
**From:** Flat structure (`assets/js/`, `assets/css/`, root HTML)
**To:** By-feature structure (`src/{feature}/`, `styles/`, `pages/`)

---

## TL;DR

v2.0.0 adalah **breaking structural change**. Code logic tetap sama, tetapi semua path file berubah. Update semua bookmarks, cache-bust, dan deploy config.

---

## Apa yang Berubah

### 1. Folder Structure

| v1.x | v2.0.0 |
|---|---|
| `assets/js/*.js` (38 files flat) | `src/{auth,wizard,exam,identity,profile,pages,utils}/*.js` (7 feature folders) |
| `assets/css/*.css` (17 files flat) | `styles/*.css` (consolidated) |
| `*.html` di root (7 files) | `pages/*.html` |
| `admin/pages/*.html` | `pages/admin/pages/*.html` |
| `ujian/*.html` | `pages/ujian/*.html` |
| `assets/images/` | `public/images/` |
| `assets/QNotify/` | `public/QNotify/` |
| `UPDATE-GUIDE.md` di root | `docs/UPDATE-GUIDE.md` |

### 2. File Renames

**Auth feature:**
- `auth.js` (994 lines) → `src/auth/main.js` (853 lines) + `errors.js` (53 lines) + `user-helpers.js` (132 lines)
- `UserAuthPortal.js` → `src/auth/user-auth-portal.js`
- `ForgotPassword.js` → `src/auth/forgot-password.js`
- `ResetPassword.js` → `src/auth/reset-password.js`
- `AdminOnboarding.js` → `src/auth/admin-onboarding.js`
- `DeviceFingerprint.js` → `src/auth/device-fingerprint.js`
- `auth/errorMapper.js` → `src/auth/error-mapper.js`
- `auth/authFlow.js` → `src/auth/auth-flow.js`

**Wizard feature:**
- `wizard-controller.js` → `src/wizard/controller.js`
- `wizard-dom.js` → `src/wizard/dom.js`
- `wizard-state.js` → `src/wizard/state.js`
- `wizard-validation.js` → `src/wizard/validation.js`

**Exam feature:**
- `ExamData.js` → `src/exam/data.js`
- `ExamExpiryManager.js` → `src/exam/expiry-manager.js`
- `ExamGuardian.js` → `src/exam/guardian.js`
- `ExamIdentitySeparator.js` → `src/exam/identity-separator.js`
- `ExamLogic.js` → `src/exam/logic.js`
- `ExamViewer.js` → `src/exam/viewer.js`
- `exam-admin-controller.js` → `src/exam/admin-controller.js`

**Identity feature:**
- `IdentityFormBuilder.js` → `src/identity/form-builder.js`
- `IdentityFormRenderer.js` → `src/identity/form-renderer.js`
- `IdentityProvider.js` → `src/identity/provider.js`

**Profile feature:**
- `OptionProfile.js` → `src/profile/option-profile.js`
- `ProfileEditorPanel.js` → `src/profile/editor-panel.js`

**Pages feature:**
- `buat-ujian.js` → `src/pages/buat-ujian.js`
- `ujian-peserta.js` → `src/pages/ujian-peserta.js`
- `DaftarNama.js` → `src/pages/daftar-nama.js`
- `ujian/kerjakan-ujian-controller.js` → `src/pages/kerjakan-ujian.js`
- `ujian/ujian.js` → `src/pages/ujian.js`
- `admin/panel.js` → `src/pages/panel.js`

**Utils feature:**
- `ui.js` → `src/utils/ui.js`
- `navigasi.js` → `src/utils/navigasi.js`
- `error-manager.js` → `src/utils/error-manager.js`
- `MathRenderer.js` → `src/utils/math-renderer.js`
- `MathPasteConverter.js` → `src/utils/math-paste-converter.js`
- `imageCompress.js` → `src/utils/image-compress.js`
- `imageCleanup.js` → `src/utils/image-cleanup.js`
- `SelfStorage.js` → `src/utils/self-storage.js`
- `AdminNotificationCenter.js` → `src/utils/admin-notification-center.js`
- `SupabaseApi.js` → `src/utils/supabase-api.js`

### 3. CSS Changes

- `assets/css/style.css` — **DELETED** (0 refs, dead)
- `assets/css/redirect.css` — **DELETED** (1 byte, empty)
- `assets/css/profile.css` + `profile2.css` + `profile-fallback.css` — **MERGED** ke `styles/profile.css` (2294 lines)
- `ujian/ujian.css` → `styles/ujian.css`
- `admin/panel.css` → `styles/admin-panel.css`
- 8 HTML files dengan inline `<style>` → extracted ke external CSS:
  - `pages/index.html` → `styles/landing.css` (27KB)
  - `pages/ujian/kerjakan-ujian.html` → `styles/kerjakan-ujian.css` (33KB)
  - `pages/login.html` → `styles/login.css` (appended to existing, 58KB)
  - `pages/reset-password.html` → `styles/reset-password.css` (15KB)
  - `pages/register-admin.html` → `styles/register.css` (12KB)
  - `pages/forgot-password.html` → `styles/forgot-password.css` (11KB)
  - `pages/404.html` → `styles/404.css` (11KB)
  - `pages/register-success.html` → `styles/register-success.css` (8KB)

### 4. New Files

- `index.html` (root) — redirect ke `pages/index.html`
- `src/{feature}/index.js` — barrel exports untuk 6 feature folders
- `src/auth/errors.js` — CompletionError class (extracted dari auth.js)
- `src/auth/user-helpers.js` — Pure utility functions (extracted dari auth.js)
- `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/CONTRIBUTING.md`, `docs/AI-CONTEXT.md`, `docs/MIGRATION.md`
- `.gitignore`, `.editorconfig`, `.eslintrc.json`, `.prettierrc`, `jsconfig.json`, `LICENSE`
- `scripts/verify-structure.mjs` (planned)

### 5. Updated Files

- `package.json` — version 2.0.0, new scripts (`verify`, `lint`)
- `scripts/serve.mjs` — updated port info, better error handling
- `scripts/minify.mjs` — handle new structure (`src/`, `styles/`, `pages/`, `public/`)

---

## Migration Steps

### OPSI A: Replace Entire Source (Recommended)

```bash
# 1. Backup source lama (WAJIB)
cp -r /path/to/your/AlbEdu /path/to/AlbEdu.backup-$(date +%Y%m%d)

# 2. Hapus source lama
rm -rf /path/to/your/AlbEdu/*

# 3. Extract source baru
unzip AlbEdu-v2.0.0.zip -d /path/to/your/
mv AlbEdu-v2.0.0 AlbEdu  # rename if needed

# 4. Install dependencies
cd AlbEdu
npm install

# 5. Test lokal
npm run dev
# Buka http://127.0.0.1:8765/
# Cek: landing → login → admin dashboard → buat ujian → kerjakan ujian

# 6. Build untuk production
npm run build
# Output: dist/ directory

# 7. Verify structure
npm run verify

# 8. Deploy dist/ ke static host lu
```

### OPSI B: Git Apply (kalau pakai git)

```bash
# 1. Commit state lama
cd /path/to/your/AlbEdu
git add -A
git commit -m "pre-v2 restructure snapshot"
git tag v1.0.5-pre-restructure

# 2. Copy source baru ke folder (overwrite)
cp -r /path/to/AlbEdu-v2.0.0/* /path/to/your/AlbEdu/

# 3. Hapus file yang sudah tidak ada di v2
rm -rf assets/  # semua file udah pindah ke src/, styles/, public/
# (HTML files di root juga udah pindah ke pages/)

# 4. Commit source baru
git add -A
git commit -m "refactor: v2.0.0 by-feature structure

- Move JS to src/{auth,wizard,exam,identity,profile,pages,utils}/
- Move CSS to styles/
- Move HTML to pages/
- Move images & QNotify to public/
- Split auth.js (994 lines) → main.js + errors.js + user-helpers.js
- Merge 3 profile CSS files → 1 styles/profile.css
- Extract inline <style> dari 8 HTML files ke external CSS
- Delete dead files (redirect.css, style.css)
- Add docs (README, ARCHITECTURE, CONTRIBUTING, AI-CONTEXT, MIGRATION)
- Add config files (.gitignore, .editorconfig, .eslintrc, .prettierrc, jsconfig.json)"
git tag v2.0.0

# 5. Push
git push origin main --tags
```

---

## ⚠️ Step Tambahan yang Perlu Perhatikan

### 1. Root Index Redirect

Source baru punya `index.html` di root yang otomatis redirect ke `pages/index.html`. Kalau lu pakai nginx/Apache config yang override `index.html`, pastikan tidak conflict.

### 2. Cloudflare Worker CORS

Tidak ada perubahan di Worker. Tapi kalau testing di localhost, pastikan `ALLOWED_ORIGINS` include `http://127.0.0.1:8765` dan `http://localhost:8765`.

### 3. Supabase Auth Redirect URLs

Kalau Supabase Auth config punya redirect URLs yang hardcode `/login.html`, update ke `/pages/login.html`.

### 4. Browser Cache

Karena semua path berubah, browser cache kemungkinan serve old paths. Solusi:
- Tambah `?v=2.0.0` ke semua asset URLs (cache-busting), atau
- Configure HTTP `Cache-Control: no-cache` untuk HTML files
- Long-term `Cache-Control: max-age=31536000, immutable` untuk hashed assets

### 5. localStorage & sessionStorage

**Tidak ada perubahan** di localStorage/sessionStorage keys. Semua key names (`albedu_wizard_draft`, `albedu_user_auth_preflight`, dll) tetap sama.

### 6. `window.Auth` API

**Tidak ada breaking change** di `window.Auth` public API. Semua method signatures tetap sama:
- `window.Auth.authLogin()`
- `window.Auth.authLogout(options)`
- `window.Auth.fetchUserData(uid)`
- `window.Auth.getCurrentUser()` (via property getter)
- dst.

### 7. `window.CompletionError` & `window.AuthHelpers`

v2.0.0 tambah 2 window globals baru:
- `window.CompletionError` — error class (sebelumnya di auth.js, sekarang di errors.js)
- `window.AuthHelpers` — pure utility functions (buildAvatarUrl, escapeHTML, isProfileComplete, dll)

Code lama yang pakai `window.CompletionError` tetap work tanpa perubahan.

### 8. ES Module Imports

4 file yang import dari `./auth/index.js`:
- `AdminOnboarding.js` → `src/auth/admin-onboarding.js`
- `ForgotPassword.js` → `src/auth/forgot-password.js`
- `ResetPassword.js` → `src/auth/reset-password.js`
- `UserAuthPortal.js` → `src/auth/user-auth-portal.js`

Import path diubah dari `./auth/index.js` ke `./index.js` (karena file sekarang ada di folder yang sama dengan index.js).

---

## Verification Checklist (Post-Migration)

Setelah update, test berikut untuk verify semua feature work:

### Smoke Test (5 menit)

- [ ] Buka `http://127.0.0.1:8765/` — harus auto-redirect ke `/pages/index.html`
- [ ] Buka `pages/login.html` — split-screen layout render
- [ ] Buka `pages/admin/index.html` — dashboard dengan nav sidebar
- [ ] Buka `pages/ujian/index.html` — 5-digit token input muncul
- [ ] Buka browser console — banner `QNotify 1.0.5 For AlbEdu` muncul

### Functional Test (15 menit)

- [ ] Login sebagai admin (Google OAuth atau email/password)
- [ ] Buat ujian via wizard (4 steps)
- [ ] Publish ujian — kode_id ter-generate
- [ ] Buka `pages/ujian/index.html` di incognito → masuk token
- [ ] Kerjakan ujian: pilih kelas → pilih nama → jawab soal → submit
- [ ] Cek `pages/admin/data-hasil.html` (redirects ke `results-analytics.html` di v0.742.0+) — hasil muncul di completed list

### Build Test (3 menit)

- [ ] `npm run build` lulus tanpa error
- [ ] `dist/` directory ter-create
- [ ] `dist/src/auth/main.js` ada dan minified
- [ ] `dist/styles/profile.css` ada dan minified
- [ ] Test `dist/` di static server — semua halaman load dengan benar

### Structure Verify (1 menit)

- [ ] `npm run verify` lulus (kalau script sudah dibuat)
- [ ] Tidak ada file di `assets/` folder (semua sudah pindah)
- [ ] Tidak ada file di root selain `index.html`, `package.json`, `README.md`, config files

---

## Rollback (Kalau Ada Masalah)

### Quick Rollback (Full Revert)

```bash
# Kalau pakai OPSI B (git):
git checkout v1.0.5-pre-restructure -- .
git commit -m "rollback: revert to pre-v2 restructure"

# Atau reset hard ke tag:
git reset --hard v1.0.5-pre-restructure
```

### Partial Rollback

Setiap phase di migration bisa di-revert individual. Lihat git log untuk detail commit per phase.

---

## FAQ

### Q: Apakah data user hilang setelah migration?

**A:** Tidak. Supabase data tetap utuh. localStorage user (draft history, dll) juga tetap valid karena key names tidak berubah.

### Q: Apakah `window.Auth` API berubah?

**A:** Tidak. Semua method signatures tetap sama. Yang berubah hanya internal implementation (sebagian logic di-extract ke `errors.js` dan `user-helpers.js`).

### Q: Bisakah saya pakai v1.x dan v2.0.0 bersamaan?

**A:** Tidak recommended. Path file berubah total, jadi code lama yang reference `assets/js/auth.js` akan 404. Pilih salah satu.

### Q: Bagaimana kalau saya ada custom code yang hardcode path `assets/js/...`?

**A:** Update path ke `src/{feature}/...`. Gunakan mapping table di section "File Renames" atas.

### Q: Apakah build pipeline berubah?

**A:** Ya. `scripts/minify.mjs` sekarang handle struktur baru (`src/`, `styles/`, `pages/`, `public/`). Kalau lu customize build script, update sesuai.

### Q: Apakah tests perlu update?

**A:** Tests di `tests/` folder tidak reference path spesifik (mereka test behavior, bukan file structure). Tapi kalau ada test yang hardcode `assets/js/...`, update ke path baru.

---

## Contact

Kalau ada masalah dengan migration:
1. Check `docs/AI-CONTEXT.md` — common pitfalls
2. Check `docs/ARCHITECTURE.md` — module dependency
3. Run `npm run verify` untuk structure integrity check
4. Run `npm run dev` dan cek browser console untuk runtime errors
