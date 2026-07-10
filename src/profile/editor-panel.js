// ProfileEditorPanel.js — floating profile editor modal (avatar + name).
// Self-contained: zero external deps beyond the platform layer + Supabase Storage.
// All styles are scoped to the `pep-` prefix so it can mount on any page
// without leaking CSS.
//
// v0.819.0: Avatar uploads now go to Supabase Storage (bucket: `avatars`)
// instead of the broken Cloudflare Worker `/upload` endpoint. Magic Compress™
// v2 is wired in — every avatar is resized to 256×256, JPEG q85, <50 KB.
//
// Usage:
//   ProfileEditorPanel.init({
//     trigger: HTMLElement | HTMLElement[] | NodeList,
//     onSaved: (updatedUser) => { /* sync avatar/name in the host UI */ }
//   })
//   // Note: workerBase is no longer required — Supabase Storage is used.

;(function (global) {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  // Client cap: 10 MB input → Magic Compress™ will shrink to <50 KB JPEG.
  // Pre-compression size limit. Server (Storage bucket) enforces 2 MB post-compression.
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB input cap
  const ALLOWED_TYPES   = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
  const NAME_MAX_LEN    = 60;

  // Avatar compression config — overrides Magic Compress™ defaults for avatars.
  // Avatars are small display pictures (256×256 is plenty for 96px renders).
  // Target: <50 KB JPEG (small for fast load in daftar-nama lists).
  const AVATAR_COMPRESS_OPTS = {
    maxWidth: 256,
    maxHeight: 256,
    targetMaxBytes: 50 * 1024,   // 50 KB — avatars are tiny
    targetMinBytes: 5 * 1024,    // 5 KB floor (don't over-compress)
    computeSSIM: false,          // skip SSIM for avatars (fast path)
  };

  let _cfg        = null;
  let _panel      = null;
  let _backdrop   = null;
  let _user       = null;   // current user doc from Supabase
  let _previewUrl = null;   // blob URL of a not-yet-uploaded photo
  let _newFile    = null;   // File to upload on save
  let _saving     = false;

  // Styles scoped to `pep-` prefix. Colors follow the AlbEdu design system
  // (primary #2563eb, surface #f8fafc).
  function _injectStyles() {
    if (document.getElementById('pep-styles')) return;
    const s = document.createElement('style');
    s.id = 'pep-styles';
    s.textContent = `
      .pep-backdrop {
        position: fixed; inset: 0; z-index: 9998;
        background: rgba(15, 23, 42, 0.45);
        opacity: 0; transition: opacity 220ms ease;
        pointer-events: none;
      }
      .pep-backdrop.pep-visible { opacity: 1; pointer-events: auto; }

      .pep-panel {
        position: fixed; z-index: 9999;
        top: 50%; left: 50%;
        transform: translate(-50%, -52%) scale(0.97);
        opacity: 0;
        pointer-events: none;
        transition: transform 260ms cubic-bezier(0.34, 1.36, 0.64, 1),
                    opacity   200ms ease;
        width: 360px; max-width: calc(100vw - 32px);
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        box-shadow: 0 20px 48px rgba(15, 23, 42, 0.14),
                    0 4px 12px  rgba(15, 23, 42, 0.06);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        overflow: hidden;
      }
      .pep-panel.pep-visible {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
        pointer-events: auto;
      }

      /* Header */
      .pep-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 20px 14px;
        border-bottom: 1px solid #f1f5f9;
      }
      .pep-title {
        font-size: 15px; font-weight: 600; color: #0f172a; letter-spacing: -0.2px;
      }
      .pep-close {
        width: 28px; height: 28px; border-radius: 8px; border: none;
        background: transparent; cursor: pointer; color: #94a3b8;
        display: flex; align-items: center; justify-content: center;
        transition: background 140ms, color 140ms; padding: 0;
      }
      .pep-close:hover { background: #f1f5f9; color: #475569; }
      .pep-close svg { display: block; }

      /* Body */
      .pep-body { padding: 24px 20px 20px; }

      /* Avatar section */
      .pep-avatar-wrap {
        display: flex; flex-direction: column; align-items: center;
        gap: 12px; margin-bottom: 24px;
      }
      .pep-avatar-ring {
        position: relative; width: 88px; height: 88px; cursor: pointer;
        transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .pep-avatar-ring:hover { transform: scale(1.05); }
      .pep-avatar-ring:active { transform: scale(0.98); }
      .pep-avatar-img {
        width: 88px; height: 88px; border-radius: 50%;
        object-fit: cover; display: block;
        border: 2.5px solid #e2e8f0;
        transition: filter 200ms, border-color 200ms, opacity 300ms ease;
        background: #f1f5f9;
        opacity: 0;
      }
      .pep-avatar-img.pep-loaded { opacity: 1; }
      .pep-avatar-ring:hover .pep-avatar-img {
        filter: brightness(0.72);
        border-color: #2563eb;
      }
      .pep-avatar-overlay {
        position: absolute; inset: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 200ms; pointer-events: none;
      }
      .pep-avatar-ring:hover .pep-avatar-overlay { opacity: 1; }
      .pep-avatar-icon {
        color: #ffffff; background: rgba(37,99,235,0.85);
        border-radius: 50%; padding: 7px;
        transform: scale(0.8); transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .pep-avatar-ring:hover .pep-avatar-icon { transform: scale(1); }
      .pep-avatar-icon svg { display: block; }
      .pep-avatar-hint {
        font-size: 12px; color: #94a3b8; text-align: center;
        line-height: 1.4;
      }
      /* Upload progress ring */
      .pep-avatar-progress {
        position: absolute; inset: -4px; border-radius: 50%;
        opacity: 0; transition: opacity 200ms;
        pointer-events: none;
      }
      .pep-avatar-progress.pep-active { opacity: 1; }
      .pep-avatar-progress svg { transform: rotate(-90deg); }
      .pep-avatar-progress circle {
        fill: none; stroke-width: 3; stroke-linecap: round;
      }
      .pep-avatar-progress .pep-track { stroke: #e2e8f0; }
      .pep-avatar-progress .pep-fill {
        stroke: #2563eb; stroke-dasharray: 283;
        stroke-dashoffset: 283;
        transition: stroke-dashoffset 300ms ease;
      }
      /* Success checkmark */
      .pep-avatar-success {
        position: absolute; inset: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: rgba(34, 197, 94, 0.9);
        opacity: 0; pointer-events: none;
        transform: scale(0.8);
        transition: opacity 200ms, transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .pep-avatar-success.pep-show {
        opacity: 1; transform: scale(1);
      }
      .pep-avatar-success svg { color: white; width: 32px; height: 32px; }
      .pep-file-input { display: none; }

      /* Name field */
      .pep-field { margin-bottom: 20px; }
      .pep-label {
        display: block; font-size: 12px; font-weight: 500;
        color: #64748b; letter-spacing: 0.3px; margin-bottom: 7px;
        text-transform: uppercase;
      }
      .pep-input {
        width: 100%; box-sizing: border-box;
        padding: 10px 12px; border-radius: 8px;
        border: 1.5px solid #e2e8f0; outline: none;
        font-size: 14px; font-family: inherit; color: #0f172a;
        background: #f8fafc;
        transition: border-color 160ms, box-shadow 160ms;
      }
      .pep-input:focus {
        border-color: #93c5fd;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.06);
        background: #ffffff;
      }
      .pep-input::placeholder { color: #cbd5e1; }
      .pep-input.pep-error { border-color: #ef4444; }

      /* Error message */
      .pep-err-msg {
        font-size: 12px; color: #ef4444; margin-top: 5px;
        min-height: 16px;
      }

      /* Actions */
      .pep-actions {
        display: flex; gap: 10px; padding-top: 4px;
      }
      .pep-btn {
        flex: 1; padding: 10px 0; border-radius: 8px; cursor: pointer;
        font-size: 14px; font-weight: 500; font-family: inherit;
        border: 1.5px solid transparent;
        transition: background 140ms, color 140ms, border-color 140ms,
                    opacity 140ms, transform 100ms;
      }
      .pep-btn:active { transform: scale(0.98); }
      .pep-btn-cancel {
        background: transparent; color: #64748b; border-color: #e2e8f0;
      }
      .pep-btn-cancel:hover { background: #f1f5f9; border-color: #cbd5e1; }
      .pep-btn-save {
        background: #2563eb; color: #ffffff; border-color: #2563eb;
      }
      .pep-btn-save:hover { background: #1d4ed8; border-color: #1d4ed8; }
      .pep-btn-save:disabled {
        opacity: 0.55; cursor: not-allowed; transform: none;
      }

      /* Loading spinner di dalam tombol save */
      .pep-spinner {
        display: inline-block; width: 13px; height: 13px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: pep-spin 0.65s linear infinite;
        vertical-align: -2px; margin-right: 6px;
      }
      @keyframes pep-spin { to { transform: rotate(360deg); } }

      /* Upload progress bar */
      .pep-progress-wrap {
        height: 3px; background: #e2e8f0; border-radius: 2px;
        overflow: hidden; margin-top: 10px;
        opacity: 0; transition: opacity 160ms;
      }
      .pep-progress-wrap.pep-visible { opacity: 1; }
      .pep-progress-bar {
        height: 100%; background: #2563eb;
        transition: width 300ms ease;
        width: 0%;
      }
    `;
    document.head.appendChild(s);
  }

  // DOM Builder
  function _buildPanel() {
    // Backdrop
    _backdrop = document.createElement('div');
    _backdrop.className = 'pep-backdrop';
    _backdrop.setAttribute('aria-hidden', 'true');
    _backdrop.addEventListener('click', close);

    // Panel
    _panel = document.createElement('div');
    _panel.className = 'pep-panel';
    _panel.setAttribute('role', 'dialog');
    _panel.setAttribute('aria-modal', 'true');
    _panel.setAttribute('aria-label', t('pep.title', null, 'Edit Profil'));
    _panel.setAttribute('aria-hidden', 'true');
    _panel.innerHTML = `
      <div class="pep-header">
        <span class="pep-title">${t('pep.title', null, 'Edit Profil')}</span>
        <button class="pep-close" id="pep-close-btn" aria-label="${t('common.close', null, 'Tutup')}">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="pep-body">
        <div class="pep-avatar-wrap">
          <div class="pep-avatar-ring" id="pep-avatar-ring" role="button" aria-label="${t('pep.change_photo_aria', null, 'Ganti foto profil')}" tabindex="0">
            <img class="pep-avatar-img" id="pep-avatar-img" alt="${t('pep.photo_alt', null, 'Foto profil')}" />
            <div class="pep-avatar-overlay">
              <span class="pep-avatar-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              </span>
            </div>
            <div class="pep-avatar-progress" id="pep-avatar-progress">
              <svg width="96" height="96" viewBox="0 0 100 100">
                <circle class="pep-track" cx="50" cy="50" r="45"/>
                <circle class="pep-fill" id="pep-progress-fill" cx="50" cy="50" r="45"/>
              </svg>
            </div>
            <div class="pep-avatar-success" id="pep-avatar-success">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
            </div>
          </div>
          <span class="pep-avatar-hint">${t('pep.avatar_hint', null, 'Klik foto untuk mengubah<br>Format apapun · maks 10 MB · auto-compress')}</span>
          <input class="pep-file-input" id="pep-file-input" type="file" accept="image/*" />
        </div>

        <div class="pep-field">
          <label class="pep-label" for="pep-name-input">${t('pep.name_label', null, 'Nama Lengkap')}</label>
          <input class="pep-input" id="pep-name-input" type="text"
            placeholder="${t('pep.name_placeholder', null, 'Masukkan nama lengkap')}"
            maxlength="${NAME_MAX_LEN}"
            autocomplete="name"
          />
          <div class="pep-err-msg" id="pep-name-err"></div>
        </div>

        <div class="pep-progress-wrap" id="pep-progress-wrap">
          <div class="pep-progress-bar" id="pep-progress-bar"></div>
        </div>

        <div class="pep-actions">
          <button class="pep-btn pep-btn-cancel" id="pep-cancel-btn">${t('common.cancel', null, 'Batal')}</button>
          <button class="pep-btn pep-btn-save"   id="pep-save-btn">${t('common.save', null, 'Simpan')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(_backdrop);
    document.body.appendChild(_panel);

    // Wire events
    _panel.querySelector('#pep-close-btn').addEventListener('click', close);
    _panel.querySelector('#pep-cancel-btn').addEventListener('click', close);
    _panel.querySelector('#pep-save-btn').addEventListener('click', _handleSave);

    const ring      = _panel.querySelector('#pep-avatar-ring');
    const fileInput = _panel.querySelector('#pep-file-input');
    ring.addEventListener('click',   () => fileInput.click());
    ring.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', _handleFileChange);

    // Trap focus inside panel
    _panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  // File pick
  function _handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate type — Magic Compress™ v2 accepts any image format (will convert to JPEG)
    if (file.type && !ALLOWED_TYPES.includes(file.type) && !file.type.startsWith('image/')) {
      _showToast('Format tidak didukung. Gunakan JPG, PNG, WebP, GIF, BMP, atau AVIF.', 'error');
      return;
    }

    // Validate size — 10 MB input cap (Magic Compress™ will shrink to <50 KB)
    if (file.size > MAX_IMAGE_BYTES) {
      _showToast(t('pep.file_too_big', null, 'Foto terlalu besar. Maks 10 MB.'), 'error');
      return;
    }

    // Revoke lama kalau ada
    if (_previewUrl) URL.revokeObjectURL(_previewUrl);

    _newFile    = file;
    _previewUrl = URL.createObjectURL(file);
    var imgEl = _panel.querySelector('#pep-avatar-img');
    imgEl.classList.remove('pep-loaded');
    imgEl.src = _previewUrl;
    imgEl.onload = function() { this.classList.add('pep-loaded'); };
  }

  // Save
  async function _handleSave() {
    if (_saving) return;

    const nameInput = _panel.querySelector('#pep-name-input');
    const nameErrEl = _panel.querySelector('#pep-name-err');
    const saveBtn   = _panel.querySelector('#pep-save-btn');
    const name      = nameInput.value.trim();

    // Clear previous errors
    nameErrEl.textContent = '';
    nameInput.classList.remove('pep-error');

    // Validate name
    if (!name) {
      nameErrEl.textContent = t('pep.name_empty', null, 'Nama tidak boleh kosong.');
      nameInput.classList.add('pep-error');
      nameInput.focus();
      return;
    }
    if (name.length < 2) {
      nameErrEl.textContent = t('pep.name_too_short', null, 'Nama minimal 2 karakter.');
      nameInput.classList.add('pep-error');
      return;
    }

    _saving = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="pep-spinner"></span>Menyimpan…';

    try {
      let fotoUrl = _user?.avatar_url || _user?.foto_profil || _user?.fotoProfil || '';

      // Upload foto baru jika ada — dengan progress ring animation
      if (_newFile) {
        _setProgress(10);
        _showAvatarProgress(30);
        fotoUrl = await _uploadImage(_newFile);
        _setProgress(70);
        _showAvatarProgress(80);
      }

      // Update Supabase
      await _updateUserProfile({ nama: name, foto_profil: fotoUrl });
      _setProgress(100);
      _showAvatarProgress(100);

      // Success checkmark animation
      _showAvatarSuccess();

      // Sembunyikan progress setelah selesai
      setTimeout(() => { _setProgress(0, false); _hideAvatarProgress(); }, 800);

      // Update local state agar reopen panel pakai data baru
      if (_user) {
        _user.nama       = name;
        _user.avatar_url  = fotoUrl;
        _user.foto_profil = fotoUrl;
        _user.fotoProfil  = fotoUrl;
      }

      _showToast('Profil berhasil disimpan.', 'success');

      const savedUser = { ..._user, nama: name, avatar_url: fotoUrl, foto_profil: fotoUrl, fotoProfil: fotoUrl };

      // Broadcast event sehingga halaman manapun bisa react tanpa tight coupling
      window.dispatchEvent(new CustomEvent('pep-saved', { detail: savedUser }));

      if (typeof _cfg?.onSaved === 'function') {
        _cfg.onSaved(savedUser);
      }

      // Tutup panel setelah toast muncul sebentar
      setTimeout(close, 900);

    } catch (err) {
      console.error('[ProfileEditorPanel] save error:', err);
      _showToast(err.message || t('pep.save_failed', null, 'Gagal menyimpan profil. Coba lagi.'), 'error');
      _setProgress(0, false);
    } finally {
      _saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = t('common.save', null, 'Simpan');
    }
  }

  // Lazy-load image-compress.js on first use.
  // Resolves the script URL via window.Auth.getBasePath() (AlbEdu's canonical
  // pattern for subpath-safe URLs — works on GitHub Pages /AlbEdu/ subpath).
  // Idempotent — concurrent callers share the same promise.
  let _imageCompressLoadPromise = null;

  function _ensureImageCompressLoaded() {
    if (window.ImageCompress) return Promise.resolve();
    if (_imageCompressLoadPromise) return _imageCompressLoadPromise;

    _imageCompressLoadPromise = new Promise((resolve, reject) => {
      const basePath = (global.Auth?.getBasePath?.()) || '/';
      const src = basePath + 'src/utils/image-compress.js';

      // If already loaded by another caller, resolve
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (window.ImageCompress) return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load image-compress.js')));
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.defer = true;
      script.onload = () => {
        if (window.ImageCompress) {
          console.info('[ProfileEditorPanel] image-compress.js loaded (lazy)');
          resolve();
        } else {
          reject(new Error('image-compress.js loaded but window.ImageCompress not defined'));
        }
      };
      script.onerror = () => reject(new Error('Failed to fetch image-compress.js (network error or 404)'));
      document.head.appendChild(script);
    });

    // Allow retry on failure
    _imageCompressLoadPromise.catch(() => { _imageCompressLoadPromise = null; });

    return _imageCompressLoadPromise;
  }

  // Upload via Supabase Storage (Phase 1 — replaces Worker /upload).
  //
  // Flow:
  //   1. Magic Compress™ v2 (compressInWorker): resize to 256×256, JPEG q85, <50 KB
  //   2. Upload compressed blob to `avatars` bucket at path {user_id}/avatar-{timestamp}.jpg
  //   3. Get public URL (avatars bucket is public)
  //   4. Return URL to caller — caller updates users.avatar_url with it
  //
  // Auth: uses the user's Supabase session (JWT). RLS policy on storage.objects
  // requires (storage.foldername(name))[1] = auth.uid() — so the path MUST
  // start with the user's own ID. Server-enforced; cannot be spoofed.
  async function _uploadImage(file) {
    const supabase = window.AlbEdu?.supabase?.client;
    const auth = window.AlbEdu?.supabase?.auth;
    if (!supabase || !auth) {
      throw new Error('Platform layer belum siap (Supabase client tidak ditemukan).');
    }

    const userId = auth.currentUser?.id;
    if (!userId) {
      throw new Error('Sesi login tidak ditemukan. Silakan login ulang.');
    }

    // ── 1. Magic Compress™ via Web Worker (non-blocking) ──
    // Lazy-load image-compress.js if not yet loaded. This avoids editing every
    // HTML page that uses ProfileEditorPanel — the module loads on first use.
    if (!window.ImageCompress) {
      await _ensureImageCompressLoaded();
    }
    if (!window.ImageCompress) {
      throw new Error('Gagal memuat modul kompresi gambar. Cek koneksi internet dan refresh halaman.');
    }

    let compressed;
    try {
      // Try Worker first (non-blocking). Falls back to main thread automatically
      // if Worker fails to load (e.g., GitHub Pages CSP edge case).
      compressed = await window.ImageCompress.compressInWorker(file, AVATAR_COMPRESS_OPTS);
    } catch (err) {
      console.warn('[ProfileEditorPanel] Worker compress failed, trying main thread:', err.message);
      try {
        compressed = await window.ImageCompress.magicCompress(file, AVATAR_COMPRESS_OPTS);
      } catch (err2) {
        throw new Error('Gagal kompres gambar: ' + err2.message);
      }
    }

    // Defense in depth: if compression didn't get under 2 MB, reject (Storage bucket limit)
    if (compressed.compressedSize > 2 * 1024 * 1024) {
      throw new Error('Gambar terlalu besar bahkan setelah kompresi. Coba gambar lain.');
    }

    // ── 2. Upload to Supabase Storage ──
    const path = `${userId}/avatar-${Date.now()}.jpg`;
    const uploadBtn = _panel?.querySelector('#pep-save-btn');
    const _origText = uploadBtn?.textContent;

    let uploadResult;
    try {
      uploadResult = await supabase.storage
        .from('avatars')
        .upload(path, compressed.blob, {
          contentType: 'image/jpeg',
          upsert: false,  // don't overwrite — timestamp makes path unique
          cacheControl: '3600',
        });
    } catch (err) {
      throw new Error('Upload ke Storage gagal: ' + (err.message || 'unknown error'));
    }

    if (uploadResult.error) {
      const msg = uploadResult.error.message || '';
      // Friendly error messages for common RLS / quota failures
      if (msg.includes('row-level security') || msg.includes('policy')) {
        throw new Error('Akses ditolak. Anda hanya bisa upload ke folder sendiri. Refresh halaman dan coba lagi.');
      }
      if (msg.includes('size') || msg.includes('limit') || msg.includes('too large')) {
        throw new Error('Ukuran file melebihi batas Storage (2 MB). Kompresi gagal — coba gambar lain.');
      }
      if (msg.includes('mime') || msg.includes('type') || msg.includes('format')) {
        throw new Error('Format file tidak didukung oleh Storage. Gunakan JPEG, PNG, atau WebP.');
      }
      throw new Error('Upload ke Storage gagal: ' + msg);
    }

    // ── 3. Get public URL ──
    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(path);

    if (!urlData?.publicUrl) {
      throw new Error('Gagal mendapatkan URL publik avatar. Hubungi admin.');
    }

    console.info('[ProfileEditorPanel] Avatar uploaded:', {
      path,
      originalSize: compressed.originalSize,
      compressedSize: compressed.compressedSize,
      compressionRatio: Math.round((1 - compressed.compressedSize / compressed.originalSize) * 100) + '%',
      qualityUsed: compressed.qualityUsed,
      url: urlData.publicUrl,
    });

    return urlData.publicUrl;
  }

  // Supabase update
  async function _updateUserProfile(fields) {
    const repo = window.AlbEdu?.repository;
    const auth = window.AlbEdu?.supabase?.auth;

    if (!repo || !auth) throw new Error('Platform layer belum siap.');

    const userId = auth.currentUser?.id;
    if (!userId) throw new Error('User tidak login.');

    // Migration 20260701_002_alter_users_snake_case.sql renamed
    // foto_profil → avatar_url and profil_lengkap → profile_complete.
    // `fields` may still come in as { foto_profil } from older callers, so
    // translate it to the real column name here rather than sending a
    // nonexistent column to Postgrest (which previously made every profile
    // save fail).
    const { foto_profil, ...restFields } = fields;
    const payload = {
      ...restFields,
      ...(foto_profil !== undefined ? { avatar_url: foto_profil } : {}),
      updated_at:       new Date().toISOString(),
      profile_complete: true,
    };

    // Use Actly resilience for profile update
    const resilience = window.AlbEdu?.resilience;
    if (resilience) {
      const result = await resilience.write(
        `profile-update:${userId}`,
        async () => { await repo.updateDoc('users', userId, payload); return true; }
      );
      if (!result.ok) throw result.error || new Error('Profile update failed');
      resilience.invalidate(`profile-update:${userId}`);
    } else {
      await repo.updateDoc('users', userId, payload);
    }
  }

  // Progress bar
  function _setProgress(pct, visible = true) {
    if (!_panel) return;
    const wrap = _panel.querySelector('#pep-progress-wrap');
    const bar  = _panel.querySelector('#pep-progress-bar');
    wrap.classList.toggle('pep-visible', visible && pct > 0);
    bar.style.width = pct + '%';
  }

  // Avatar progress ring
  function _showAvatarProgress(pct) {
    if (!_panel) return;
    const ring = _panel.querySelector('#pep-avatar-progress');
    const fill = _panel.querySelector('#pep-progress-fill');
    if (!ring || !fill) return;
    ring.classList.add('pep-active');
    // circumference = 2 * π * 45 ≈ 283
    const offset = 283 - (283 * pct / 100);
    fill.style.strokeDashoffset = offset;
  }

  function _hideAvatarProgress() {
    if (!_panel) return;
    const ring = _panel.querySelector('#pep-avatar-progress');
    if (ring) ring.classList.remove('pep-active');
  }

  // Avatar success checkmark
  function _showAvatarSuccess() {
    if (!_panel) return;
    const success = _panel.querySelector('#pep-avatar-success');
    if (!success) return;
    success.classList.add('pep-show');
    setTimeout(() => success.classList.remove('pep-show'), 1200);
  }

  // Toast: prefer QNotify, fall back to a minimal inline toast.
  function _showToast(msg, type = 'info') {
    if (window.notify) {
      const title = t('pep.title', null, 'Profil');
      if (type === 'success') return window.notify.success(title, msg);
      if (type === 'error')   return window.notify.error(title, msg);
      return window.notify.info(title, msg);
    }
    // Fallback minimal toast
    const toastEl = document.createElement('div');
    toastEl.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: ${type === 'error' ? '#ef4444' : '#22c55e'};
      color: #fff; padding: 10px 20px; border-radius: 8px;
      font-size: 14px; font-family: -apple-system, sans-serif;
      z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      animation: pepToastIn 200ms ease;
    `;
    toastEl.textContent = msg;
    document.body.appendChild(toastEl);
    setTimeout(() => toastEl.remove(), 3000);
  }

  // Populate panel with user data
  function _populatePanel(user) {
    _user = user;
    const imgEl   = _panel.querySelector('#pep-avatar-img');
    const nameEl  = _panel.querySelector('#pep-name-input');

    // Avatar — fade-in saat load, fallback ke initials kalau error
    // Check avatar_url (DB column) + foto_profil (legacy alias set by normalizeUserDoc)
    const foto = user?.avatar_url || user?.foto_profil || user?.fotoProfil || '';
    imgEl.classList.remove('pep-loaded');
    if (foto) {
      // Validate URL scheme + block .html URLs (page URLs, not images)
      var fotoSafe = '';
      if ((/^https:/i.test(foto) || /^data:image\//i.test(foto) || !/^[a-z]+:/i.test(foto))
          && !foto.endsWith('.html')) {
        fotoSafe = foto;
      }
      if (fotoSafe) {
        imgEl.src = fotoSafe;
        imgEl.onload = function() { this.classList.add('pep-loaded'); };
        imgEl.onerror = function() {
          this.src = _fallbackAvatar(user?.nama || '?');
          this.classList.add('pep-loaded');
        };
      } else {
        imgEl.src = _fallbackAvatar(user?.nama || '?');
        imgEl.classList.add('pep-loaded');
      }
    } else {
      imgEl.src = _fallbackAvatar(user?.nama || '?');
      imgEl.classList.add('pep-loaded');
    }

    // Nama
    nameEl.value = user?.nama || '';

    // Reset state upload foto
    _newFile    = null;
    _previewUrl = null;

    // Reset error state
    _panel.querySelector('#pep-name-err').textContent = '';
    _panel.querySelector('#pep-name-input').classList.remove('pep-error');
    _setProgress(0, false);
  }

  // Gravatar-style initials fallback
  function _fallbackAvatar(seed) {
    const initials = (seed || '?')
      .trim()
      .split(/\s+/)
      .map(w => w[0]?.toUpperCase() || '')
      .slice(0, 2)
      .join('');
    const svg = `
      <svg xmlns='http://www.w3.org/2000/svg' width='88' height='88' viewBox='0 0 88 88'>
        <rect width='88' height='88' rx='44' fill='%232563eb'/>
        <text x='50%' y='55%' dominant-baseline='middle' text-anchor='middle'
          fill='white' font-size='32' font-family='system-ui,sans-serif' font-weight='600'>
          ${initials}
        </text>
      </svg>
    `.trim();
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Fetch user doc from Supabase
  async function _fetchCurrentUser() {
    const repo = window.AlbEdu?.repository;
    const auth = window.AlbEdu?.supabase?.auth;
    if (!repo || !auth) throw new Error('Platform layer belum siap.');

    const userId = auth.currentUser?.id;
    if (!userId) throw new Error('User tidak login.');

    const snap = await repo.getDoc('users', userId);
    if (!snap.exists) throw new Error('Dokumen user tidak ditemukan.');
    return snap.data();
  }

  // Open / Close
  async function open() {
    if (!_panel) _buildPanel();

    // Populate dengan data terbaru dari Supabase
    const saveBtn = _panel.querySelector('#pep-save-btn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="pep-spinner"></span>Memuat…';

    _backdrop.classList.add('pep-visible');
    _panel.classList.add('pep-visible');
    _backdrop.setAttribute('aria-hidden', 'false');
    _panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Focus trap awal
    setTimeout(() => _panel.querySelector('#pep-name-input')?.focus(), 280);

    try {
      const user = await _fetchCurrentUser();
      _populatePanel(user);
    } catch (err) {
      console.error('[ProfileEditorPanel] fetch user error:', err);
      _showToast(t('pep.load_failed', null, 'Gagal memuat data profil.'), 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = t('common.save', null, 'Simpan');
    }
  }

  function close() {
    if (!_panel) return;

    _panel.classList.remove('pep-visible');
    _backdrop.classList.remove('pep-visible');
    _backdrop.setAttribute('aria-hidden', 'true');
    _panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    // Bersihkan blob URL agar tidak leak memory
    if (_previewUrl) {
      URL.revokeObjectURL(_previewUrl);
      _previewUrl = null;
    }
    _newFile = null;
    _saving  = false;
  }

  // Public API
  function init(cfg) {
    if (!cfg?.trigger) {
      console.warn('[ProfileEditorPanel] init() butuh { trigger: HTMLElement }');
      return;
    }

    _cfg = cfg;
    _injectStyles();

    // Attach trigger — support element tunggal atau array/NodeList
    const triggers = Array.isArray(cfg.trigger) ? cfg.trigger
      : cfg.trigger instanceof NodeList       ? Array.from(cfg.trigger)
      : [cfg.trigger];

    triggers.forEach(el => {
      el.addEventListener('click', open);
    });
  }

  // Expose ke global agar bisa dipakai dari halaman manapun
  global.ProfileEditorPanel = { init, open, close };

}(window));
