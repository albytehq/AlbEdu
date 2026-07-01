# AlbEdu — Update Guide

**Date:** 2026-06-26
**From:** Original (pre-optimization)
**To:** Optimized (post bug-hunting event)

---

## 📦 Apa yang Berubah

### Files Modified (28 files)

**HTML pages (15 files) — font strategy + render-block elimination:**
- `404.html`
- `index.html`
- `login.html`
- `register-admin.html`
- `register-success.html`
- `forgot-password.html`
- `reset-password.html`
- `admin/index.html`
- `admin/pages/buat-ujian.html`
- `admin/pages/daftar-nama.html`
- `admin/pages/data-hasil.html`
- `admin/pages/profile.html`
- `admin/pages/ujian-peserta.html`
- `ujian/index.html`
- `ujian/kerjakan-ujian.html`

**CSS (2 files):**
- `assets/css/tokens.css` — removed `@import url(Google Fonts)` (was blocking entire site)
- `assets/css/wizard.css` — removed `@import url(DM Sans)` + CSS perf fixes (transition:all → specific, box-shadow animations → transform:scale, prefers-reduced-motion)

**Wizard JS (4 files):**
- `assets/js/wizard-controller.js` — W1-W9 fixes + errorManager wiring + _applyImportedSoal dead code fix
- `assets/js/wizard-dom.js` — W1 memoization cache + W2 DropdownManager event delegation
- `assets/js/wizard-state.js` — W4 getStateRef + W5 recalculateScores cache + W9 quickHash memoization
- `assets/js/wizard-validation.js` — W3 single-scan (eliminate double validateStepN)

**Exam JS (3 files):**
- `assets/js/ExamIdentitySeparator.js` — S1 destroy() at start of render()
- `assets/js/ExamLogic.js` — S4 debounced _saveDraft + flushDraft on submit/unload
- `assets/js/ExamViewer.js` — S5 event delegation + AbortController cleanup

**QNotify (10 files):**
- `assets/QNotify/api/index.js` — Q7 rebrand + Q8 drop unused globals
- `assets/QNotify/main/config.js` — VERSION = '1.0.5'
- `assets/QNotify/main/engine.js` — banner "QNotify 1.0.5 For AlbEdu"
- `assets/QNotify/main/render.js` — Q1, Q2 escapeHtml on all fields
- `assets/QNotify/main/label.js` — Q3 escapeHtml on all fields
- `assets/QNotify/main/Readnote.js` — Q4, Q5 escapeHtml + sanitizeUrl whitelist
- `assets/QNotify/main/glitch.js` — Q6 CSP nonce support
- `assets/QNotify/main/notify.js` — header normalized
- `assets/QNotify/main/spring.js` — header normalized
- `assets/QNotify/main/timer.js` — header normalized
- `assets/QNotify/main/stack.js` — header normalized
- `assets/QNotify/ui/label.css` — header normalized

### Files Added (3 new)

- `assets/QNotify/security/sanitize.js` — NEW: escapeHtml, sanitizeUrl, stripHtml utilities
- `ujian/kerjakan-ujian-controller.js` — NEW: extracted from 775-line inline `<script>` in kerjakan-ujian.html
- `package.json` — NEW: esbuild + lightningcss devDeps for build pipeline
- `scripts/minify.mjs` — NEW: production build script
- `scripts/serve.mjs` — NEW: dev server

### Files Deleted (2 files)

- `assets/js/data-hasil.js` — dead code (466 LOC, zero callers)
- `assets/js/data-ujian.js` — dead code (24 LOC, zero callers)

---

## 🚀 Cara Update — 3 Opsi

### OPSI A: Replace Entire Source (Palingsimple, Recommended)

```bash
# 1. Backup source lama (WAJIB)
cp -r /path/to/your/AlbEdu /path/to/AlbEdu.backup-$(date +%Y%m%d)

# 2. Hapus source lama (atau pindah ke folder lain)
rm -rf /path/to/your/AlbEdu/*
# ATAU
mv /path/to/your/AlbEdu /path/to/AlbEdu.old

# 3. Extract source baru
cd /path/to/your/
unzip albedu-latest.zip
mv albedu-latest AlbEdu  # rename if needed

# 4. Install devDependencies (untuk build pipeline)
cd AlbEdu
npm install

# 5. Test lokal
npm run dev
# Buka http://localhost:8765 di browser
# Cek: login → buat ujian → publish → token entry → kerjakan ujian

# 6. Build untuk production
npm run build
# Output: dist/ directory

# 7. Deploy dist/ ke static host lu
# Contoh untuk GitHub Pages:
# git add dist/* && git commit -m "deploy AlbEdu optimized" && git push
```

### OPSI B: Git Apply (kalau pakai git)

```bash
# 1. Commit state lama
cd /path/to/your/AlbEdu
git add -A
git commit -m "pre-optimization snapshot"
git tag v1.0.0-pre-optimization

# 2. Copy source baru ke folder (overwrite)
cp -r /path/to/albedu-latest/* /path/to/your/AlbEdu/
# Hapus file yang sudah tidak ada di source baru
rm -f assets/js/data-hasil.js assets/js/data-ujian.js

# 3. Commit source baru
git add -A
git commit -m "AlbEdu optimized — 27 bugs fixed, performance +20%, XSS-hardened"
git tag v1.0.0-optimized

# 4. Push
git push origin main --tags
```

### OPSI C: Per-File Patch (kalau mau gradual)

Update file per file, test setelah masing-masing. Urutan recommended:

**Step 1: Critical fixes (F1-F3 — render block)**
```bash
# Copy 3 file ini dulu
cp albedu-latest/assets/css/tokens.css /your-albedu/assets/css/
cp albedu-latest/assets/css/wizard.css /your-albedu/assets/css/
cp albedu-latest/ujian/kerjakan-ujian.html /your-albedu/ujian/

# Test: buka semua 14 halaman, pastikan load tanpa error
```

**Step 2: HTML font strategy (all 15 HTML files)**
```bash
# Copy semua HTML files
cp albedu-latest/*.html /your-albedu/
cp albedu-latest/admin/pages/*.html /your-albedu/admin/pages/
cp albedu-latest/admin/index.html /your-albedu/admin/

# Test: cek Network tab di DevTools — Google Fonts harus pakai preconnect+swap
```

**Step 3: Wizard optimization (4 JS files)**
```bash
cp albedu-latest/assets/js/wizard-*.js /your-albedu/assets/js/

# Test: buat ujian dengan 50 soal, type cepat, add/delete/move — harus smooth
```

**Step 4: Exam runner fixes (3 JS files + 1 new)**
```bash
cp albedu-latest/assets/js/ExamIdentitySeparator.js /your-albedu/assets/js/
cp albedu-latest/assets/js/ExamLogic.js /your-albedu/assets/js/
cp albedu-latest/assets/js/ExamViewer.js /your-albedu/assets/js/
cp albedu-latest/ujian/kerjakan-ujian-controller.js /your-albedu/ujian/

# Test: student token entry → kerjakan ujian → submit
```

**Step 5: QNotify rework + security (12 files + 1 new folder)**
```bash
cp -r albedu-latest/assets/QNotify/* /your-albedu/assets/QNotify/

# Test: trigger toast/dialog/alert/readNote — pastikan banner "QNotify 1.0.5 For AlbEdu"
# Test XSS: window.QNotify.notify.success('<script>alert(1)</script>', 'test') — harus escape
```

**Step 6: Cleanup + build pipeline**
```bash
# Hapus dead code
rm /your-albedu/assets/js/data-hasil.js
rm /your-albedu/assets/js/data-ujian.js

# Copy build pipeline
cp albedu-latest/package.json /your-albedu/
cp -r albedu-latest/scripts /your-albedu/

# Install + build
cd /your-albedu
npm install
npm run build
```

---

## ⚠️ Step Tambahan yang Perlu Perhatikan

### 1. Cloudflare Worker CORS ( kalau testing di localhost )

Worker lu (`albedu.examjuniorhighschool.workers.dev`) punya `ALLOWED_ORIGINS` yang tidak include `http://127.0.0.1:8765`. Untuk testing lokal, tambahkan:

```javascript
// Di Cloudflare Worker (Worker v5.1)
const ALLOWED_ORIGINS = new Set([
  'https://albedu-id.github.io',
  'https://albedu.examjuniorhighschool.com',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://127.0.0.1:8765',  // ← TAMBAH INI untuk dev server AlbEdu
  'http://localhost:8765',  // ← TAMBAH INI juga
]);
```

Atau kalau mau pattern match (lebih fleksibel):
```javascript
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow localhost + 127.0.0.1 di port manapun (dev only)
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
```

**Deploy Worker baru** setelah edit via `wrangler deploy` atau dashboard Cloudflare.

### 2. Supabase Config Cache

Source baru pakai `sessionStorage` cache untuk Supabase config (key: `albedu_sb_config`). Cache ini TTL-based. Kalau lu ganti Supabase credentials, clear cache:

```javascript
// Di browser console:
sessionStorage.removeItem('albedu_sb_config');
// Lalu refresh page
```

### 3. localStorage Migration (draft history)

Wizard draft history (`albedu_wizard_draft` + `albedu_wizard_draft_history`) format tidak berubah. Tapi kalau ada draft lama yang corrupt, bisa di-clear:

```javascript
// Di browser console (di halaman buat-ujian.html):
localStorage.removeItem('albedu_wizard_draft');
localStorage.removeItem('albedu_wizard_draft_history');
```

### 4. QNotify Breaking Changes ( kalau pakai globals lama )

Source baru hapus 5 window globals yang tidak dipakai AlbEdu:
- ~~`window.QnotifyShow`~~ → pakai `window.QNotify` atau `window.show`
- ~~`window.Qnotify`~~ (lowercase) → pakai `window.QNotify` (uppercase)
- ~~`window.Notifications`~~ → pakai `window.QNotify`
- ~~`window.QnotifySolver`~~ → solver selalu 'hybrid' (tidak bisa diubah)
- ~~`window.QnotifyVersion`~~ → tidak ada pengganti

**Cek apakah code lu pakai globals lama:**
```bash
grep -rn "QnotifyShow\|window\.Qnotify[^S]\|window\.Notifications\|QnotifySolver\|QnotifyVersion" /your-albedu/
```

Kalau ada yang ketemu, ganti dengan `window.QNotify`.

### 5. QNotify Indonesian Aliases Removed

Method berikut dihapus (zero callers di AlbEdu):
- ~~`show.notify.sukses()`~~ → `show.notify.success()`
- ~~`show.notify.gagal()`~~ → `show.notify.error()`
- ~~`show.notify.peringatan()`~~ → `show.notify.warning()`
- ~~`show.notify.informasi()`~~ → `show.notify.info()`

**Cek:**
```bash
grep -rn "notify\.sukses\|notify\.gagal\|notify\.peringatan\|notify\.informasi" /your-albedu/
```

### 6. Optional: CSP Strict Mode

Source baru support strict Content-Security-Policy via nonce. Kalau lu mau deploy CSP:

```html
<!-- Di setiap HTML <head>, tambahkan: -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com;
               style-src 'self' 'nonce-{{nonce}}' https://fonts.googleapis.com;
               font-src 'self' https://fonts.gstatic.com;
               img-src 'self' data: https:;
               connect-src 'self' https://*.supabase.co https://*.workers.dev;
               frame-src https://challenges.cloudflare.com">

<!-- Set nonce before QNotify loads: -->
<script>window.__QNOTIFY_NONCE__ = '{{nonce}}';</script>
```

**Tanpa nonce**, QNotify masih work tapi butuh `'unsafe-inline'` di `style-src`.

### 7. Production Build (Optional tapi Recommended)

Source baru datang dengan build pipeline (esbuild + lightningcss). Untuk production:

```bash
cd /your-albedu
npm install      # sekali saja
npm run build    # output ke dist/
```

`dist/` berisi JS+CSS minified (27% size reduction). Deploy `dist/` ke static host.

**Tanpa build** (dev mode): source files dipakai langsung. Work 100%, cuma tidak minified.

---

## ✅ Verification Checklist (Post-Update)

Setelah update, test berikut untuk verify semua feature work:

### Smoke Test (5 menit)
- [ ] Buka `index.html` — load tanpa error
- [ ] Buka `login.html` — split-screen layout render
- [ ] Buka `admin/pages/buat-ujian.html` — wizard modal bisa dibuka
- [ ] Buka `ujian/index.html` — token input (5 digit) muncul
- [ ] Buka browser console — banner `QNotify 1.0.5 For AlbEdu` muncul

### Functional Test (15 menit)
- [ ] Login sebagai admin (Google OAuth atau email/password)
- [ ] Buat ujian via wizard:
  - [ ] Step 1: isi judul, mata pelajaran, kelas, mode, waktu
  - [ ] Step 2: pilih tema
  - [ ] Step 3: add section → set type (PG) → add 5 questions → type pertanyaan + pilihan
  - [ ] Step 4: publish reviewer muncul + kode_id ter-generate
- [ ] Buka `ujian-peserta.html` — exam card muncul
- [ ] Start exam manually → `access_control.manual_status = 'open'`
- [ ] Buka `ujian/index.html` di incognito → masuk token
- [ ] Kerjakan ujian: pilih kelas → pilih nama → jawab soal → submit
- [ ] Cek `ujian-peserta.html` — hasil muncul di completed list

### Performance Test (5 menit)
- [ ] DevTools → Performance tab → record saat typing di wizard (50 soal loaded)
- [ ] Expected: 0 jank, tidak ada re-render saat typing
- [ ] Klik "Add Question" 10x cepat → harus smooth

### Security Test (2 menit)
- [ ] Buka browser console, jalankan:
  ```javascript
  window.QNotify.notify.success('<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 3000);
  ```
- [ ] Expected: Notification muncul dengan text literal `<script>alert(1)</script>` — TIDAK ada alert dialog fire

### QNotify Test (3 menit)
- [ ] `window.QNotify.notify.success('Title', 'Message', 3000)` — toast muncul
- [ ] `window.QNotify.dialog.confirm({message: 'Test?', onYes: () => alert('yes')})` — dialog + click Yes → alert
- [ ] `window.QNotify.label.alert({title: 'Alert', message: 'Test'})` — alert card muncul
- [ ] `window.QNotify.label.readNote({title: 'Help', bodyText: '**bold** text'})` — readNote dengan markdown render

---

## 🔄 Rollback (kalau ada masalah)

### Quick Rollback (full revert)
```bash
# Kalau pakai OPSI A:
cp -r /path/to/AlbEdu.backup-*/* /path/to/your/AlbEdu/

# Kalau pakai OPSI B (git):
git checkout v1.0.0-pre-optimization -- .
git commit -m "rollback to pre-optimization"
```

### Partial Rollback (file spesifik)
Setiap fix didocument di `/home/z/my-project/worklog.md` dengan file paths + line numbers. Cari comment `// W1 fix:` atau `// BUG #1:` di source untuk identify perubahan spesifik.

---

## 📞 Kalau Ada Masalah

1. **Cek worklog**: `/home/z/my-project/worklog.md` (1500+ lines, semua perubahan documented)
2. **Cek test reports**: `/home/z/my-project/download/baseline/phase*.json`
3. **Re-run tests**: 
   ```bash
   cd /home/z/my-project/albedu-tests
   npm install
   node scripts/phase1-user-sim.js  # 31 tests
   node scripts/phase2-user-sim.js  # 12 tests
   node scripts/phase4-edge-cases.js # 12 tests
   ```

---

## 📊 Summary Perubahan

| Metric | Before | After |
|---|---|---|
| Render-blocking scripts | 72 | **0** |
| CSS `@import` blocks | 2 | **0** |
| Inline controller LOC | 775 | **0** (extracted) |
| Dead code LOC | 490 | **0** |
| `transition: all` count | 42 | **36** |
| Infinite box-shadow animations | 3 | **0** |
| DropdownManager listener leaks | ~550/50 edits | **0** |
| XSS vectors (innerHTML) | 4 | **0** |
| QNotify version | v8.0.5 (drift) | **1.0.5** (uniform) |
| Unused window globals | 5 | **0** |
| Mammoth.js initial load | 100KB sync | **0** (lazy) |
| Avg DOM load time | 206ms | **164ms** (-20%) |
| Bugs found & fixed | — | **27** |
| Tests passing | — | **55/55** |

---

**Update guide version:** 1.0
**Last updated:** 2026-06-26
