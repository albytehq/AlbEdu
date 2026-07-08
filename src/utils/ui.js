// ui.js — ByteWard UI module: avatar system (UI-Avatars + inline SVG
// fallback), loading system, auth loading, animations, profile panel.

window.UI = window.UI || {};

/* Avatar system — UI-Avatars (rate-limit friendly). Falls back to inline SVG
   initials if offline / blocked. */
const AvatarSystem = {
    // Primary: ui-avatars.com — simple, deterministic, no bot cleanup risk
    buildUrl(name, bg, color) {
        const n = encodeURIComponent((name || 'U').slice(0, 2).toUpperCase());
        const b = (bg    || '2563eb').replace('#', '');
        const c = (color || 'ffffff').replace('#', '');
        return `https://ui-avatars.com/api/?name=${n}&background=${b}&color=${c}&size=128&bold=true&format=svg`;
    },

    // Fallback: pure inline SVG — works completely offline, zero external dep
    buildSVG(name, bg) {
        const initials = _initials(name || 'U');
        const fill = bg || '#2563eb';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
            <rect width="128" height="128" rx="64" fill="${fill}"/>
            <text x="64" y="64" dy=".35em" text-anchor="middle"
                font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
                font-size="${initials.length > 1 ? 44 : 52}" font-weight="700" fill="#ffffff">${initials}</text>
        </svg>`;
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    },

    getDefaultAvatar(seed) {
        // seed = email or name — derive initials
        const name = typeof seed === 'string' ? seed.split('@')[0].replace(/[._-]/g, ' ') : 'User';
        return this.buildUrl(name);
    },

    // Pre-built avatar options for profile picker
    // Uses UI-Avatars with varied color palettes — not DiceBear
    generateAvatars(count = 16) {
        const palettes = [
            { bg: '2563eb', label: 'Biru' },
            { bg: '0891b2', label: 'Cyan' },
            { bg: '059669', label: 'Hijau' },
            { bg: '7c3aed', label: 'Ungu' },
            { bg: 'db2777', label: 'Merah Muda' },
            { bg: 'ea580c', label: 'Oranye' },
            { bg: '0f766e', label: 'Teal' },
            { bg: '4338ca', label: 'Indigo' },
            { bg: 'be185d', label: 'Rose' },
            { bg: '15803d', label: 'Hijau Tua' },
            { bg: 'b45309', label: 'Kuning' },
            { bg: '0284c7', label: 'Langit' },
            { bg: '6d28d9', label: 'Violet' },
            { bg: '0e7490', label: 'Laut' },
            { bg: 'dc2626', label: 'Merah' },
            { bg: '374151', label: 'Abu' },
        ];

        return palettes.slice(0, count).map((p, i) => ({
            id: `av${i}`,
            name: p.label,
            url: `https://ui-avatars.com/api/?name=AB&background=${p.bg}&color=ffffff&size=128&bold=true&format=svg&length=0`,
            bg: `#${p.bg}`,
        }));
    },

    validateUpload(file) {
        if (!file.type.startsWith('image/'))
            return { valid: false, error: 'Hanya file gambar yang diperbolehkan' };
        if (file.size > 4 * 1024 * 1024)
            return { valid: false, error: 'Ukuran gambar maksimal 4 MB' };
        return { valid: true };
    },
};

// Expose so other modules can use
window.AvatarSystem = AvatarSystem;

function _initials(str) {
    const words = String(str || 'U').trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
}

/* Loading status rotation */
const _STATUS_MSGS = [
    'Mengalihkan halaman',
    'Memuat sumber daya',
    'Menyiapkan tampilan',
    'Menghubungkan layanan',
    'Hampir selesai',
];
let _statusInterval = null;
let _statusIdx = 0;

function _startStatus(el) {
    const statusEl = el.querySelector('.loading-status');
    if (!statusEl) return;
    _statusIdx = 0;
    statusEl.textContent = _STATUS_MSGS[0];
    _statusInterval = setInterval(() => {
        _statusIdx = (_statusIdx + 1) % _STATUS_MSGS.length;
        statusEl.classList.remove('status-update');
        void statusEl.offsetWidth;
        statusEl.classList.add('status-update');
        statusEl.textContent = _STATUS_MSGS[_statusIdx];
    }, 1800);
}
function _stopStatus() {
    if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
}
window._startLoadingStatus = _startStatus;
window._stopLoadingStatus  = _stopStatus;

/* Auth loading overlay */
UI.showAuthLoading = function (text) {
    text = text || 'Memverifikasi sesi login...';
    let el = document.getElementById('loadingIndicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'loadingIndicator';
        el.className = 'loading-indicator';
        el.innerHTML = `
            <div class="spinner spinner-lg"></div>
            <div class="loading-text">${text}</div>
            <div class="progress-bar"><div class="progress-fill"></div></div>
            <div class="loading-status" aria-live="polite"></div>
        `;
        document.body.appendChild(el);
        _ensureLoadingCSS();
    }
    el.style.display = 'flex';
    const textEl = el.querySelector('.loading-text');
    if (textEl) textEl.textContent = text;
    _startStatus(el);
};

UI.hideAuthLoading = function () {
    const el = document.getElementById('loadingIndicator');
    if (!el) return;
    _stopStatus();
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; el.style.opacity = '1'; }, 300);
};

UI.showLoginError = function (message) {
    if (window.QNotify) {
        window.QNotify.label.alert({ title: 'Login Gagal', message, intent: 'danger' });
    } else if (window.notify) {
        window.notify.error('Login Gagal', message, 5000);
    }
    this.hideAuthLoading();
};

// Central confirm helper: use QNotify when available, otherwise fallback to native
UI.confirm = function (opts) {
    const options = typeof opts === 'string' ? { message: opts } : (opts || {});
    const qConfirm = window.notify?.confirm || window.QNotify?.dialog?.confirm;
    if (typeof qConfirm === 'function') {
        return new Promise(resolve => {
            let settled = false;
            const done = (v) => { if (settled) return; settled = true; resolve(!!v); };
            qConfirm({
                title:  options.title  || '',
                message: options.message || '',
                icon:    options.icon    || 'warning',
                intent:  options.intent  || 'warning',
                onYes:   () => done(true),
                onNo:    () => done(false),
                onClose: () => done(false),
            });
        });
    }

    try {
        return Promise.resolve(window.confirm(options.message || ''));
    } catch (e) {
        return Promise.resolve(false);
    }
};

/* After login/logout hooks */
UI.afterLogin = function () {
    this.hideAuthLoading();
    // Notify navigasi.js to sync sidebar user
    if (window.Auth?.userData) {
        window.dispatchEvent(new Event('auth-ready'));
    }
    // Trigger navbar avatar update (for non-admin pages)
    UI.NavAvatar?.update?.();
};

UI.afterLogout = function () {
    // Clean up any dynamically created UI elements on logout.
    // Profile panel overlay
    document.getElementById('profileOverlay')?.remove();
    document.getElementById('logoutModal')?.remove();
    // Loading overlay
    this.hideAuthLoading?.();
};

/* Animation helpers */
UI.Animate = {
    panelIn(panel) {
        if (!panel) return;
        panel.style.transform = 'translateY(16px) scale(0.98)';
        panel.style.opacity   = '0';
        requestAnimationFrame(() => {
            panel.style.transition = 'all 0.3s cubic-bezier(0.22,1,0.36,1)';
            panel.style.transform  = 'translateY(0) scale(1)';
            panel.style.opacity    = '1';
        });
    },
    panelOut(panel, cb) {
        if (!panel) { cb?.(); return; }
        panel.style.transition = 'all 0.25s cubic-bezier(0.4,0,0.2,1)';
        panel.style.transform  = 'translateY(16px) scale(0.98)';
        panel.style.opacity    = '0';
        setTimeout(() => cb?.(), 250);
    },
    modeTransition(oldEl, newEl, dir = 'next', cb) {
        if (!oldEl || !newEl) { cb?.(); return Promise.resolve(); }
        return new Promise(resolve => {
            oldEl.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
            oldEl.style.opacity   = '0';
            oldEl.style.transform = dir === 'next' ? 'translateX(-16px)' : 'translateX(16px)';
            newEl.style.opacity   = '0';
            newEl.style.transform = dir === 'next' ? 'translateX(16px)' : 'translateX(-16px)';
            setTimeout(() => {
                newEl.style.transition = 'opacity 0.22s cubic-bezier(0.22,1,0.36,1), transform 0.22s cubic-bezier(0.22,1,0.36,1)';
                newEl.style.opacity   = '1';
                newEl.style.transform = 'translateX(0)';
                setTimeout(() => {
                    [oldEl, newEl].forEach(el => {
                        el.style.opacity = el.style.transform = el.style.transition = '';
                    });
                    cb?.(); resolve();
                }, 220);
            }, 180);
        });
    },
};

/* Profile panel — modal dialog. Triggered from sidebar dropdown → "Edit Profil".
   Also used directly by profile.html. */
UI.Profile = {
    // init() is a no-op for the floating button — the panel is opened via
    // UI.Profile.open() from navigasi.js dropdown or profile.html.
    init() {
        // Only set up keyboard handler if panel might be opened on this page
        this._initKeyboard();
    },

    open(mode = 'view') {
        if (window.Auth?.profileState) {
            window.Auth.profileState.mode = mode;
            window.Auth.profileState.tempName = window.Auth.userData?.nama || '';
        } else if (window.Auth) {
            window.Auth.profileState = {
                mode, isLoading: false, hasChanges: false,
                tempName: window.Auth.userData?.nama || '',
                tempAvatar: null,
            };
        }
        this._createPanel();
        this._render();
        const overlay = document.getElementById('profileOverlay');
        const panel   = document.getElementById('profilePanel');
        if (overlay && panel) {
            overlay.style.display = 'flex';
            requestAnimationFrame(() => {
                overlay.style.opacity = '1';
                UI.Animate.panelIn(panel);
                document.getElementById('closeProfile')?.focus();
            });
        }
    },

    close() {
        const overlay = document.getElementById('profileOverlay');
        const panel   = document.getElementById('profilePanel');
        if (panel) {
            UI.Animate.panelOut(panel, () => {
                if (overlay) {
                    overlay.style.opacity = '0';
                    setTimeout(() => {
                        overlay.style.display = 'none';
                        document.getElementById('avatarUpload') && (document.getElementById('avatarUpload').value = '');
                    }, 300);
                }
            });
        } else if (overlay) {
            overlay.style.display = 'none';
        }
        if (window.Auth?.profileState) {
            window.Auth.profileState.mode       = 'view';
            window.Auth.profileState.hasChanges = false;
            window.Auth.profileState.tempAvatar = null;
        }
    },

    _render() {
        const panel = document.getElementById('profilePanel');
        if (!panel) return;
        const state = window.Auth?.profileState || { mode: 'view' };
        let body = '';
        if (state.isLoading && state.mode === 'view') {
            body = this._skeleton();
        } else {
            body = { view: this._viewMode, edit: this._editMode, avatar: this._avatarMode }[state.mode]?.call(this) || this._viewMode();
        }
        panel.innerHTML = `
            <div class="profile-header">
                <h2 id="profileTitle">${this._title(state.mode)}</h2>
                <button class="close-profile" id="closeProfile" aria-label="Tutup">&times;</button>
            </div>
            ${body}
        `;
        this._bindEvents();
    },

    _viewMode() {
        const u = window.Auth?.userData || {};
        const avatarUrl = u.avatar_url || u.foto_profil || AvatarSystem.getDefaultAvatar(u.email || u.nama || 'User');
        const fallback  = AvatarSystem.buildSVG(u.nama || 'U');
        return `
            <div class="view-mode">
                <div class="avatar-section">
                    <img src="${_esc(avatarUrl)}" alt="Avatar" class="view-avatar"
                         onerror="this.onerror=null;this.src='${fallback}'">
                    ${u.profilLengkap === false ? '<div class="incomplete-badge" aria-label="Profil belum lengkap">!</div>' : ''}
                </div>
                <div class="user-info">
                    <h3 class="user-name">${_esc(u.nama || 'Nama belum diisi')}</h3>
                    <p class="user-email">${_esc(u.email || 'Email tidak tersedia')}</p>
                    <div class="user-stats">
                        <div class="stat-item">
                            <span class="stat-value">${u.totalUjian || 0}</span>
                            <span class="stat-label">Asesmen Diselesaikan</span>
                        </div>
                    </div>
                </div>
                <div class="view-actions">
                    <button class="btn btn-edit" id="editProfileBtn">Edit Profil</button>
                    <button class="btn btn-logout" id="logoutBtnProfile">Log Out</button>
                </div>
            </div>
        `;
    },

    _editMode() {
        const u     = window.Auth?.userData || {};
        const state = window.Auth?.profileState || {};
        const avatarUrl = state.tempAvatar || u.avatar_url || u.foto_profil || AvatarSystem.getDefaultAvatar(u.email || u.nama || 'User');
        const fallback  = AvatarSystem.buildSVG(u.nama || 'U');
        return `
            <div class="edit-mode">
                <div class="edit-avatar-section">
                    <img src="${_esc(avatarUrl)}" alt="Avatar" class="edit-avatar" id="editAvatarImage"
                         onerror="this.onerror=null;this.src='${fallback}'">
                    <button class="avatar-edit-btn" id="editAvatarBtn">Ubah Avatar</button>
                </div>
                <div class="edit-form">
                    <div class="form-group">
                        <label for="editName">Nama Lengkap</label>
                        <input type="text" id="editName" value="${_esc(u.nama || '')}" placeholder="Masukkan nama lengkap" aria-label="Nama lengkap">
                    </div>
                </div>
                <div class="status-message" id="statusMessage" role="alert"></div>
                <div class="edit-actions">
                    <button class="btn btn-primary" id="saveProfileBtn" ${state.hasChanges ? '' : 'disabled'}>
                        ${state.isLoading ? '<span>Menyimpan...</span>' : '<span>Simpan</span>'}
                    </button>
                    <button class="btn btn-secondary" id="cancelEditBtn">Batal</button>
                </div>
            </div>
        `;
    },

    _avatarMode() {
        const state   = window.Auth?.profileState || {};
        const user    = window.Auth?.userData || {};
        const name    = user.nama || 'U';
        const avatars = AvatarSystem.generateAvatars(16);

        // Build avatar options: solid color tiles with user initials
        const avatarItems = avatars.map(av => {
            const url = AvatarSystem.buildUrl(name, av.bg);
            const selected = state.tempAvatar === url;
            return `
                <div class="avatar-item ${selected ? 'selected' : ''}" data-url="${_esc(url)}"
                     role="option" aria-label="${av.name}" aria-selected="${selected}"
                     style="background:${av.bg};">
                    <span class="av-initials">${_initials(name)}</span>
                </div>
            `;
        }).join('');

        return `
            <div class="edit-avatar-mode">
                <p class="avatar-hint">Pilih warna avatar</p>
                <div class="avatar-grid" id="avatarGrid" role="listbox" aria-label="Pilihan avatar">
                    ${avatarItems}
                </div>
                <div class="upload-avatar">
                    <label for="avatarUpload" class="btn-upload">Unggah Gambar Custom</label>
                    <input type="file" id="avatarUpload" accept="image/*" style="display:none" aria-label="Unggah avatar">
                </div>
                <div class="edit-avatar-actions">
                    <button class="btn-back" id="backToEditBtn">← Kembali ke Edit</button>
                </div>
            </div>
        `;
    },

    _skeleton() {
        return `
            <div class="view-mode" style="padding:24px">
                <div style="text-align:center;margin-bottom:28px">
                    <div class="skeleton skeleton-circle" style="width:140px;height:140px;margin:0 auto 20px"></div>
                </div>
                <div class="skeleton skeleton-text" style="width:60%;height:28px;margin:0 auto 12px"></div>
                <div class="skeleton skeleton-text" style="width:40%;height:18px;margin:0 auto 32px"></div>
                <div class="skeleton skeleton-text" style="height:52px;margin-bottom:12px;border-radius:12px"></div>
                <div class="skeleton skeleton-text" style="height:52px;border-radius:12px"></div>
            </div>
        `;
    },

    _title(mode) {
        return { view: 'Profil Saya', edit: 'Edit Profil', avatar: 'Pilih Avatar' }[mode] || 'Profil';
    },

    _bindEvents() {
        document.getElementById('closeProfile')?.addEventListener('click', () => this.close());
        document.getElementById('profileOverlay')?.addEventListener('click', e => {
            if (e.target.id === 'profileOverlay') this.close();
        });

        const state = window.Auth?.profileState || { mode: 'view' };
        if (state.mode === 'view') {
            document.getElementById('editProfileBtn')?.addEventListener('click', () => {
                if (window.Auth?.profileState) {
                    window.Auth.profileState.mode = 'edit';
                    window.Auth.profileState.tempName = window.Auth.userData?.nama || '';
                }
                this._render();
            });
            document.getElementById('logoutBtnProfile')?.addEventListener('click', () => this._showLogout());
        }
        if (state.mode === 'edit') {
            const nameInput = document.getElementById('editName');
            if (nameInput) {
                nameInput.addEventListener('input', e => {
                    if (window.Auth?.profileState) {
                        window.Auth.profileState.tempName = e.target.value;
                        window.Auth.profileState.hasChanges =
                            e.target.value !== (window.Auth.userData?.nama || '') ||
                            !!window.Auth.profileState.tempAvatar;
                        this._updateSaveBtn();
                    }
                });
                setTimeout(() => nameInput.focus(), 50);
            }
            document.getElementById('editAvatarBtn')?.addEventListener('click', () => {
                if (window.Auth?.profileState) window.Auth.profileState.mode = 'avatar';
                this._render();
            });
            document.getElementById('saveProfileBtn')?.addEventListener('click', () => this._save());
            document.getElementById('cancelEditBtn')?.addEventListener('click', () => {
                if (window.Auth?.profileState) {
                    window.Auth.profileState.mode = 'view';
                    window.Auth.profileState.hasChanges = false;
                    window.Auth.profileState.tempAvatar = null;
                }
                this._render();
            });
        }
        if (state.mode === 'avatar') {
            document.querySelectorAll('.avatar-item').forEach(item => {
                item.addEventListener('click', () => {
                    document.querySelectorAll('.avatar-item').forEach(i => {
                        i.classList.remove('selected');
                        i.setAttribute('aria-selected', 'false');
                    });
                    item.classList.add('selected');
                    item.setAttribute('aria-selected', 'true');
                    if (window.Auth?.profileState) {
                        window.Auth.profileState.tempAvatar = item.dataset.url;
                        window.Auth.profileState.hasChanges = true;
                    }
                });
            });
            document.getElementById('avatarUpload')?.addEventListener('change', e => this._handleUpload(e));
            document.querySelector('.btn-upload')?.addEventListener('click', () => {
                document.getElementById('avatarUpload')?.click();
            });
            document.getElementById('backToEditBtn')?.addEventListener('click', () => {
                if (window.Auth?.profileState) window.Auth.profileState.mode = 'edit';
                this._render();
                const img = document.getElementById('editAvatarImage');
                if (img && window.Auth?.profileState?.tempAvatar) img.src = window.Auth.profileState.tempAvatar;
            });
        }
    },

    _updateSaveBtn() {
        const btn = document.getElementById('saveProfileBtn');
        if (!btn || !window.Auth?.profileState) return;
        const { hasChanges, isLoading } = window.Auth.profileState;
        btn.disabled = !hasChanges || isLoading;
        btn.style.opacity = (hasChanges && !isLoading) ? '1' : '0.6';
    },

    _showStatus(message, type = 'success') {
        const el = document.getElementById('statusMessage');
        if (!el) return;
        el.innerHTML = `<span>${message}</span>`;
        el.className = `status-message status-${type}`;
        if (type === 'success') setTimeout(() => { el.className = 'status-message'; el.innerHTML = ''; }, 3000);
    },

    async _save() {
        if (!window.Auth?.currentUser || !window.Auth?.userData) {
            this._showStatus('Sistem auth tidak tersedia', 'error'); return;
        }
        const state = window.Auth.profileState;
        if (!state?.hasChanges || state.isLoading) return;
        if (!navigator.onLine) { this._showStatus('Anda sedang offline.', 'error'); return; }

        state.isLoading = true;
        state.mode = 'view';
        this._render();
        UI.showAuthLoading('Menyimpan profil...');

        try {
            const updates = {};
            const trimName = (state.tempName || '').trim();
            if (trimName.length === 0) throw new Error('Nama tidak boleh kosong');
            if (trimName !== window.Auth.userData.nama) updates.nama = trimName;
            // Migration 20260701_002_alter_users_snake_case.sql renamed
            // foto_profil → avatar_url and profil_lengkap → profile_complete.
            // Writing the old names threw "column does not exist" on every
            // save — fixed to current schema. window.Auth.userData still
            // carries foto_profil (normalizeUserDoc keeps both for legacy readers).
            if (state.tempAvatar && state.tempAvatar !== window.Auth.userData.foto_profil) {
                updates.avatar_url = state.tempAvatar;
            }
            const finalName   = updates.nama        || window.Auth.userData.nama       || '';
            const finalAvatar = updates.avatar_url  || window.Auth.userData.foto_profil || '';
            updates.profile_complete = finalName.trim().length > 0 && finalAvatar.trim().length > 0;
            updates.updated_at = new Date().toISOString();

            delete updates.email; delete updates.peran; delete updates.id; delete updates.created_at;

            // user.id (Supabase native) replaces the legacy user.uid shape.
            const userId = window.Auth.currentUser?.id || window.Auth.currentUser?.uid;
            await window.AlbEdu?.repository?.updateDoc('users', userId, updates);
            // Mirror the DB write into the local camelCase/legacy shape so the
            // rest of the UI (which still reads foto_profil/fotoProfil/
            // profilLengkap) reflects the change immediately without a refetch.
            const localMirror = { ...updates };
            if ('avatar_url' in updates) {
                localMirror.foto_profil = updates.avatar_url;
                localMirror.fotoProfil  = updates.avatar_url;
            }
            if ('profile_complete' in updates) {
                localMirror.profilLengkap = updates.profile_complete;
            }
            window.Auth.userData = { ...window.Auth.userData, ...localMirror };

            state.hasChanges = false; state.tempAvatar = null; state.isLoading = false;
            UI.hideAuthLoading();
            this._render();
            this._showStatus('Profil berhasil disimpan!', 'success');

            // Update sidebar avatar
            window.dispatchEvent(new Event('auth-ready'));

            if (updates.profile_complete) setTimeout(() => this.close(), 1500);
        } catch (err) {
            state.isLoading = false;
            this._render();
            UI.hideAuthLoading();
            let msg = 'Gagal menyimpan profil.';
            if (err.code === 'permission-denied') msg = 'Tidak ada izin untuk mengubah data ini.';
            else if (err.message) msg += ' ' + err.message;
            this._showStatus(msg, 'error');
        }
    },

    _handleUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const v = AvatarSystem.validateUpload(file);
        if (!v.valid) { this._showStatus(v.error, 'error'); return; }
        const reader = new FileReader();
        reader.onload = ev => {
            if (window.Auth?.profileState) {
                window.Auth.profileState.tempAvatar = ev.target.result;
                window.Auth.profileState.hasChanges = true;
            }
            document.querySelectorAll('.avatar-item').forEach(i => {
                i.classList.remove('selected');
                i.setAttribute('aria-selected', 'false');
            });
            this._showStatus('Avatar berhasil diunggah!', 'success');
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    },

    _showLogout() {
        // Delegate entirely to authLogout() — it handles confirmation,
        // cleanup, signOut, and redirect. No hardcoded paths here.
        if (window.Auth?.authLogout) {
            window.Auth.authLogout();
        }
    },

    _createPanel() {
        document.getElementById('profileOverlay')?.remove();
        document.getElementById('logoutModal')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'profile-overlay';
        overlay.id        = 'profileOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);display:none;justify-content:center;align-items:center;z-index:20000;opacity:0;transition:opacity 0.25s ease;padding:16px;';

        const panel = document.createElement('div');
        panel.className = 'profile-panel';
        panel.id        = 'profilePanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'profileTitle');

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    },

    _initKeyboard() {
        // Named handler so we can remove it on pagehide.
        const self = this;
        this._onKeydown = function (e) {
            if (e.key !== 'Escape') return;
            const overlay = document.getElementById('profileOverlay');
            if (overlay?.style.display === 'flex') { self.close(); e.preventDefault(); }
        };
        document.addEventListener('keydown', this._onKeydown);

        // Cleanup on pagehide.
        window.addEventListener('pagehide', () => {
            document.removeEventListener('keydown', this._onKeydown);
            if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
        }, { once: true });
    },
};

/* Login flow */
UI.handleLogin = async function () {
    this.showAuthLoading('Membuka Google Login...');
    try {
        if (!window.Auth?.authLogin) throw new Error('Auth system tidak tersedia');
        await window.Auth.authLogin();
    } catch (err) {
        this.hideAuthLoading();
        this.showLoginError(err.message);
        throw err;
    }
};

UI.initializeForLogin = function () { _ensureLoadingCSS(); };

/* CSS helper — load loading.css once */
function _ensureLoadingCSS() {
    if (document.querySelector('link[href*="loading.css"]') || document.querySelector('#loading-css-link')) return;
    const paths = ['styles/loading.css', '../styles/loading.css', '../../styles/loading.css', '../../../styles/loading.css'];
    const tryLink = i => {
        if (i >= paths.length) { _injectMinimalCSS(); return; }
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.id = 'loading-css-link'; link.href = paths[i];
        link.onerror = () => { link.remove(); tryLink(i + 1); };
        document.head.appendChild(link);
    };
    tryLink(0);
}

function _injectMinimalCSS() {
    if (document.querySelector('#loading-css-fallback')) return;
    const s = document.createElement('style');
    s.id = 'loading-css-fallback';
    s.textContent = `.loading-indicator{position:fixed;inset:0;background:rgba(248,250,252,0.93);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:10000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;backdrop-filter:blur(5px);transition:opacity .3s ease;}.spinner-lg{width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:_spin .7s linear infinite;}.loading-text{margin-top:24px;color:#1e293b;font-size:15px;font-weight:500;text-align:center;max-width:280px;line-height:1.5;}.loading-status{margin-top:14px;color:#64748b;font-size:13px;text-align:center;min-height:20px;}.progress-bar{width:180px;height:3px;background:#e2e8f0;border-radius:99px;margin-top:22px;overflow:hidden;}.progress-fill{width:45%;height:100%;background:linear-gradient(90deg,#2563eb,#3b82f6,#2563eb);background-size:200% 100%;border-radius:99px;animation:_ps 2.2s ease-in-out infinite;}@keyframes _spin{to{transform:rotate(360deg);}}@keyframes _ps{0%{transform:translateX(-120%);}100%{transform:translateX(350%);}}`
    document.head.appendChild(s);
}

/* Escape helper */
function _esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Init */
(function () {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => UI.Profile.init());
    } else {
        UI.Profile.init();
    }
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { UI: window.UI };