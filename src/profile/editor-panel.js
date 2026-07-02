// =============================================================
//  ProfileEditorPanel.js — AlbEdu Floating Profile Editor v1.0
//
//  Self-contained. Zero external dependencies.
//  Integrates dengan: window.sb, window.firebaseAuth, Worker upload.
//
//  Usage:
//    ProfileEditorPanel.init({
//      trigger:    document.getElementById('btn-edit-profile'),
//      workerBase: 'https://albedu.examjuniorhighschool.workers.dev',
//      onSaved:    (updatedUser) => { /* update UI avatar, name, dll */ }
//    })
//
//  Panel mount otomatis ke document.body.
//  Bisa dipanggil dari admin page maupun halaman ujian.
//  Tidak ada konflik dengan CSS global — semua style scoped ke prefix 'pep-'.
// =============================================================

;(function (global) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB — Worker max adalah 10MB, kita batasi 4MB di client
  const ALLOWED_TYPES   = ['image/jpeg', 'image/png', 'image/webp'];
  const NAME_MAX_LEN    = 60;

  // ── State ──────────────────────────────────────────────────
  let _cfg        = null;   // { trigger, workerBase, onSaved }
  let _panel      = null;   // DOM panel element
  let _backdrop   = null;   // DOM backdrop element
  let _user       = null;   // current user doc dari Supabase
  let _previewUrl = null;   // blob URL dari foto baru (belum di-upload)
  let _newFile    = null;   // File object yang akan di-upload saat save
  let _saving     = false;

  // ── CSS ────────────────────────────────────────────────────
  // Scoped ke prefix pep- agar tidak bocor ke halaman manapun.
  // Warna ikut design system AlbEdu: biru #2563eb, surface #f8fafc.
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
      }
      .pep-avatar-img {
        width: 88px; height: 88px; border-radius: 50%;
        object-fit: cover; display: block;
        border: 2.5px solid #e2e8f0;
        transition: filter 180ms, border-color 180ms;
        background: #f1f5f9;
      }
      .pep-avatar-ring:hover .pep-avatar-img {
        filter: brightness(0.72);
        border-color: #2563eb;
      }
      .pep-avatar-overlay {
        position: absolute; inset: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 180ms; pointer-events: none;
      }
      .pep-avatar-ring:hover .pep-avatar-overlay { opacity: 1; }
      .pep-avatar-icon {
        color: #ffffff; background: rgba(37,99,235,0.85);
        border-radius: 50%; padding: 7px;
      }
      .pep-avatar-icon svg { display: block; }
      .pep-avatar-hint {
        font-size: 12px; color: #94a3b8; text-align: center;
        line-height: 1.4;
      }
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

  // ── DOM Builder ────────────────────────────────────────────
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
    _panel.setAttribute('aria-label', 'Edit Profil');
    _panel.setAttribute('aria-hidden', 'true');
    _panel.innerHTML = `
      <div class="pep-header">
        <span class="pep-title">Edit Profil</span>
        <button class="pep-close" id="pep-close-btn" aria-label="Tutup">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="pep-body">
        <div class="pep-avatar-wrap">
          <div class="pep-avatar-ring" id="pep-avatar-ring" role="button" aria-label="Ganti foto profil" tabindex="0">
            <img class="pep-avatar-img" id="pep-avatar-img" src="" alt="Foto profil" />
            <div class="pep-avatar-overlay">
              <span class="pep-avatar-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              </span>
            </div>
          </div>
          <span class="pep-avatar-hint">Klik foto untuk mengubah<br>JPG, PNG, WebP · maks 4 MB</span>
          <input class="pep-file-input" id="pep-file-input" type="file" accept="image/jpeg,image/png,image/webp" />
        </div>

        <div class="pep-field">
          <label class="pep-label" for="pep-name-input">Nama Lengkap</label>
          <input class="pep-input" id="pep-name-input" type="text"
            placeholder="Masukkan nama lengkap"
            maxlength="${NAME_MAX_LEN}"
            autocomplete="name"
          />
          <div class="pep-err-msg" id="pep-name-err"></div>
        </div>

        <div class="pep-progress-wrap" id="pep-progress-wrap">
          <div class="pep-progress-bar" id="pep-progress-bar"></div>
        </div>

        <div class="pep-actions">
          <button class="pep-btn pep-btn-cancel" id="pep-cancel-btn">Batal</button>
          <button class="pep-btn pep-btn-save"   id="pep-save-btn">Simpan</button>
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

  // ── File Pick ──────────────────────────────────────────────
  function _handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate type
    if (!ALLOWED_TYPES.includes(file.type)) {
      _showToast('Format tidak didukung. Gunakan JPG, PNG, atau WebP.', 'error');
      return;
    }

    // Validate size
    if (file.size > MAX_IMAGE_BYTES) {
      _showToast('Foto terlalu besar. Maks 4 MB.', 'error');
      return;
    }

    // Revoke lama kalau ada
    if (_previewUrl) URL.revokeObjectURL(_previewUrl);

    _newFile    = file;
    _previewUrl = URL.createObjectURL(file);
    _panel.querySelector('#pep-avatar-img').src = _previewUrl;
  }

  // ── Save ───────────────────────────────────────────────────
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
      nameErrEl.textContent = 'Nama tidak boleh kosong.';
      nameInput.classList.add('pep-error');
      nameInput.focus();
      return;
    }
    if (name.length < 2) {
      nameErrEl.textContent = 'Nama minimal 2 karakter.';
      nameInput.classList.add('pep-error');
      return;
    }

    _saving = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="pep-spinner"></span>Menyimpan…';

    try {
      let fotoUrl = _user?.foto_profil || _user?.fotoProfil || '';

      // Upload foto baru jika ada
      if (_newFile) {
        _setProgress(10);
        fotoUrl = await _uploadImage(_newFile);
        _setProgress(70);
      }

      // Update Supabase
      await _updateUserProfile({ nama: name, foto_profil: fotoUrl });
      _setProgress(100);

      // Sembunyikan progress setelah selesai
      setTimeout(() => _setProgress(0, false), 600);

      // Update local state agar reopen panel pakai data baru
      if (_user) {
        _user.nama       = name;
        _user.foto_profil = fotoUrl;
        _user.fotoProfil  = fotoUrl;
      }

      _showToast('Profil berhasil disimpan.', 'success');

      const savedUser = { ..._user, nama: name, foto_profil: fotoUrl, fotoProfil: fotoUrl };

      // Broadcast event sehingga halaman manapun bisa react tanpa tight coupling
      window.dispatchEvent(new CustomEvent('pep-saved', { detail: savedUser }));

      if (typeof _cfg?.onSaved === 'function') {
        _cfg.onSaved(savedUser);
      }

      // Tutup panel setelah toast muncul sebentar
      setTimeout(close, 900);

    } catch (err) {
      console.error('[ProfileEditorPanel] save error:', err);
      _showToast(err.message || 'Gagal menyimpan profil. Coba lagi.', 'error');
      _setProgress(0, false);
    } finally {
      _saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Simpan';
    }
  }

  // ── Upload via Worker ──────────────────────────────────────
  async function _uploadImage(file) {
    const workerBase = _cfg?.workerBase;
    if (!workerBase) throw new Error('workerBase tidak di-set di ProfileEditorPanel.init()');

    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${workerBase}/upload`, { method: 'POST', body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Upload gagal (HTTP ${res.status})`);
    }

    const data = await res.json();
    // Worker return { cdn_url } untuk format baru
    return data.cdn_url;
  }

  // ── Supabase update ────────────────────────────────────────
  async function _updateUserProfile(fields) {
    // Pakai window.firebaseDb shim dari SupabaseApi.js
    const db   = window.firebaseDb;
    const auth = window.firebaseAuth;

    if (!db || !auth) throw new Error('SupabaseApi belum siap.');

    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('User tidak login.');

    const payload = {
      ...fields,
      // Jaga sinkronisasi kedua key shape (legacy camelCase + baru snake_case)
      fotoProfil:    fields.foto_profil,
      updated_at:    new Date().toISOString(),
      profil_lengkap: true,
    };

    await db.collection('users').doc(uid).update(payload);
  }

  // ── Progress bar ───────────────────────────────────────────
  function _setProgress(pct, visible = true) {
    if (!_panel) return;
    const wrap = _panel.querySelector('#pep-progress-wrap');
    const bar  = _panel.querySelector('#pep-progress-bar');
    wrap.classList.toggle('pep-visible', visible && pct > 0);
    bar.style.width = pct + '%';
  }

  // ── Toast ──────────────────────────────────────────────────
  // Pakai QNotify kalau tersedia, fallback ke minimal toast sendiri.
  function _showToast(msg, type = 'info') {
    if (window.notify) {
      if (type === 'success') return window.notify.success('Profil', msg);
      if (type === 'error')   return window.notify.error('Profil', msg);
      return window.notify.info('Profil', msg);
    }
    // Fallback minimal toast
    const t = document.createElement('div');
    t.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: ${type === 'error' ? '#ef4444' : '#22c55e'};
      color: #fff; padding: 10px 20px; border-radius: 8px;
      font-size: 14px; font-family: -apple-system, sans-serif;
      z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      animation: pepToastIn 200ms ease;
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Populate panel dengan data user ───────────────────────
  function _populatePanel(user) {
    _user = user;
    const imgEl   = _panel.querySelector('#pep-avatar-img');
    const nameEl  = _panel.querySelector('#pep-name-input');

    // Avatar
    const foto = user?.foto_profil || user?.fotoProfil || '';
    imgEl.src   = foto || _fallbackAvatar(user?.nama || user?.email || '?');
    imgEl.onerror = () => { imgEl.src = _fallbackAvatar(user?.nama || '?'); };

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

  // Gravatar-style inisial fallback
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

  // ── Fetch user doc dari Supabase ───────────────────────────
  async function _fetchCurrentUser() {
    const db   = window.firebaseDb;
    const auth = window.firebaseAuth;
    if (!db || !auth) throw new Error('SupabaseApi belum siap.');

    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('User tidak login.');

    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) throw new Error('Dokumen user tidak ditemukan.');
    return snap.data();
  }

  // ── Open / Close ───────────────────────────────────────────
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
      _showToast('Gagal memuat data profil.', 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Simpan';
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

  // ── Public API ─────────────────────────────────────────────
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
