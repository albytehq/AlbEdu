// =============================================================================
// panel.js - Admin Panel v1.4.0
// =============================================================================
//
// Tanggung jawab:
//   - Tampilkan profil admin dari Auth.userData/currentUser
//   - Navigasi kartu mobile
//   - Jam berjalan di header
//   - Salam berdasarkan waktu
//   - OptionProfile integration (profile actions via OptionProfile.js)
// =============================================================================

class AdminPanel {
    constructor() {
        this.workerBase = 'https://albedu.examjuniorhighschool.workers.dev';
        this._profilePanelReady = false;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this._init(), { once: true });
        } else {
            this._init();
        }
    }

    _init() {
        this._renderUserInfo();
        this._setupNavigation();
        this._bootstrapProfilePanel();
        this._bootstrapOptionProfile();
        this._startClock();

        document.addEventListener('firebase-ready', () => this._renderUserInfo(), { once: true });
        document.addEventListener('auth-ready', () => this._renderUserInfo());
        window.addEventListener('pep-saved', (e) => {
            if (e.detail && window.Auth) window.Auth.userData = e.detail;
            this._renderUserInfo();
        });
        window.addEventListener('op-profile-updated', (e) => {
            if (e.detail && window.Auth) window.Auth.userData = e.detail;
            this._renderUserInfo();
        });

        // i18n: re-render greeting + user info when language changes
        // (so salutation like "Selamat Pagi" → "Good Morning" updates instantly)
        if (window.I18n && typeof window.I18n.onChanged === 'function') {
            window.I18n.onChanged(() => {
                this._renderUserInfo();
            });
        } else {
            // I18n not yet loaded — listen for it
            document.addEventListener('albedu:language-changed', () => {
                this._renderUserInfo();
            });
        }
    }

    _renderUserInfo() {
        const container = document.getElementById('userInfo');
        if (!container) return;

        const user   = window.Auth?.currentUser;
        const data   = window.Auth?.userData || {};
        const escape = window.Auth?.escapeHTML ?? ((s) => String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'));

        // i18n helper — falls back to Indonesian string if I18n not loaded
        const t = (key, vars, fallback) => {
            if (window.I18n && typeof window.I18n.t === 'function') {
                return window.I18n.t(key, vars);
            }
            return fallback;
        };

        if (user || data.email || data.nama) {
            const rawName = data.nama || user?.displayName || user?.email?.split('@')[0] || t('admin.role.admin', null, 'Administrator');
            const rawEmail = data.email || user?.email || '';
            const name = escape(rawName);
            const email = escape(rawEmail);
            const avatarUrl = data.foto_profil || data.fotoProfil || '';
            const role = data.peran === 'admin' ? t('admin.role.admin', null, 'Administrator') : t('admin.role.admin_alt', null, 'Admin AlbEdu');
            const incomplete = data.profilLengkap === false || data.profil_lengkap === false;

            // BUGFIX M: Validate avatar URL scheme (only allow https:) and
            // remove the inline onerror handler -- it bypasses security.js
            // sanitization. Use a data-attribute + event listener instead.
            const safeAvatarUrl = (avatarUrl && /^https:/.test(avatarUrl)) ? avatarUrl : '';
            const incompleteBadge = incomplete
                ? `<span class="profile-status-mobile">${escape(t('admin.profile_incomplete', null, 'Profil belum lengkap'))}</span>`
                : '';
            container.innerHTML = `
                <div class="user-avatar-mobile" id="admin-index-avatar" aria-hidden="true">
                    ${safeAvatarUrl
                        ? `<img src="${escape(safeAvatarUrl)}" alt="" data-avatar-fallback="true">`
                        : '<i class="material-symbols-outlined">manage_accounts</i>'}
                </div>
                <div class="user-details-mobile">
                    <h3>${name}</h3>
                    <p>${email || role}</p>
                    ${incompleteBadge}
                </div>
            `;

            // Attach onerror via event listener (not inline) -- CSP-friendly
            const avatarImg = container.querySelector('img[data-avatar-fallback]');
            if (avatarImg) {
                avatarImg.addEventListener('error', function() {
                    this.style.display = 'none';
                    this.parentElement.classList.add('avatar-fallback');
                });
            }

            // Re-init OptionProfile triggers after re-render
            this._attachOptionProfileTrigger(container);

            this._renderGreeting(rawName);
            return;
        }

        container.innerHTML = `
            <div class="user-avatar-mobile" aria-hidden="true">
                <i class="material-symbols-outlined">manage_accounts</i>
            </div>
            <div class="user-details-mobile">
                <h3>${escape(t('admin.role.admin', null, 'Administrator'))}</h3>
                <p class="loading-text" aria-label="${escape(t('admin.loading_profile', null, 'Memuat profil...'))}">${escape(t('admin.loading_profile', null, 'Memuat profil...'))}</p>
            </div>
        `;
    }

    _attachOptionProfileTrigger(container) {
        // v3.0 FIX: Previously this method was called from _renderUserInfo()
        // BEFORE _bootstrapOptionProfile() had finished loading the
        // OptionProfile.js script. This meant window.OptionProfile was
        // undefined on first call → trigger was never attached → admin
        // panel dropdown appeared "broken" until auth-ready fired later
        // (and even then, only if OptionProfile had loaded by then).
        //
        // Now: if OptionProfile is loaded, attach immediately. If not,
        // listen for the `option-profile-ready` event (dispatched by
        // OptionProfile.init) and attach then. Once: true ensures we
        // don't stack deferred listeners.
        if (window.OptionProfile && typeof window.OptionProfile.addTrigger === 'function') {
            window.OptionProfile.addTrigger(container);
            return;
        }

        // Defer — OptionProfile.js hasn't finished loading yet.
        // We attach a one-shot listener; when OptionProfile dispatches
        // `option-profile-ready`, we attach the trigger. If the container
        // has been replaced by then (re-render), the listener is a no-op
        // because the container is detached from the DOM.
        const deferredAttach = () => {
            if (window.OptionProfile && typeof window.OptionProfile.addTrigger === 'function') {
                // Only attach if container is still connected to the DOM
                // (otherwise we'd bind a handler to a detached element).
                if (container.isConnected) {
                    window.OptionProfile.addTrigger(container);
                }
            }
        };
        document.addEventListener('option-profile-ready', deferredAttach, { once: true });

        // Safety net: if `option-profile-ready` was already fired before
        // we registered the listener (race condition), poll briefly.
        if (!window.OptionProfile) {
            let polls = 0;
            const poll = setInterval(() => {
                if (window.OptionProfile?.addTrigger) {
                    clearInterval(poll);
                    if (container.isConnected) {
                        window.OptionProfile.addTrigger(container);
                    }
                } else if (++polls > 20) {
                    // 4 seconds elapsed — give up silently
                    clearInterval(poll);
                }
            }, 200);
        }
    }

    _bootstrapProfilePanel() {
        const initPanel = () => {
            if (!window.ProfileEditorPanel || this._profilePanelReady) return;
            window.ProfileEditorPanel.init({
                trigger: [],
                workerBase: this.workerBase,
                onSaved: (user) => {
                    if (user && window.Auth) window.Auth.userData = user;
                    this._renderUserInfo();
                },
            });
            this._profilePanelReady = true;
        };

        if (window.ProfileEditorPanel) {
            initPanel();
            return;
        }

        if (document.getElementById('pep-panel-script-admin-index')) return;

        const script = document.createElement('script');
        script.id = 'pep-panel-script-admin-index';
        script.src = '../../src/profile/editor-panel.js';
        script.defer = true;
        script.onload = initPanel;
        document.head.appendChild(script);
    }

    _bootstrapOptionProfile() {
        if (document.getElementById('op-script-admin-index')) return;

        const s = document.createElement('script');
        s.id = 'op-script-admin-index';
        s.src = '../../src/profile/option-profile.js';
        s.defer = true;

        s.onload = () => {
            if (!window.OptionProfile) return;
            const userInfo = document.getElementById('userInfo');
            window.OptionProfile.init({
                triggers:   userInfo ? [userInfo] : [],
                context:    'standalone',
                workerBase: this.workerBase,
            });
        };

        document.head.appendChild(s);
    }

    _renderGreeting(name) {
        const el = document.getElementById('greeting');
        if (!el) return;

        // i18n helper — falls back to Indonesian if I18n not loaded
        const t = (key, vars, fallback) => {
            if (window.I18n && typeof window.I18n.t === 'function') {
                return window.I18n.t(key, vars);
            }
            return fallback;
        };

        const hour = new Date().getHours();
        let salutationKey;
        let salutationFallback;
        if (hour < 11)      { salutationKey = 'admin.greet.morning';   salutationFallback = 'Selamat Pagi'; }
        else if (hour < 15) { salutationKey = 'admin.greet.afternoon'; salutationFallback = 'Selamat Siang'; }
        else if (hour < 19) { salutationKey = 'admin.greet.evening';   salutationFallback = 'Selamat Sore'; }
        else                { salutationKey = 'admin.greet.night';     salutationFallback = 'Selamat Malam'; }

        const salutation = t(salutationKey, { name }, `${salutationFallback}, ${name}!`);
        el.textContent = salutation;
    }

    _setupNavigation() {
        const navCards = document.querySelectorAll('.mobile-card[data-link], .nav-card[data-href]');

        navCards.forEach(card => {
            const getHref = () => card.dataset.link ?? card.dataset.href;

            card.addEventListener('click', () => {
                const href = getHref();
                if (href) window.location.href = href;
            });

            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const href = getHref();
                    if (href) window.location.href = href;
                }
            });

            if (!card.getAttribute('role')) card.setAttribute('role', 'link');
            if (!card.getAttribute('tabindex')) card.setAttribute('tabindex', '0');
        });
    }

    _startClock() {
        const el = document.getElementById('live-clock') || document.getElementById('currentTime');
        if (!el) return;

        if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
        if (!el.getAttribute('aria-atomic')) el.setAttribute('aria-atomic', 'true');

        const tick = () => {
            const now = new Date();
            el.textContent = now.toLocaleTimeString('id-ID', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
        };
        tick();
        setInterval(tick, 1_000);
    }
}

new AdminPanel();
