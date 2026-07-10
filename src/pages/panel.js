// panel.js — admin dashboard: profile header, mobile nav cards, clock, greeting.
// Profile editing is delegated to OptionProfile + ProfileEditorPanel.

class AdminPanel {
    constructor() {
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
        this._setupDashboard();

        document.addEventListener('albedu:platform-ready', () => {
            this._renderUserInfo();
            this._loadDashboardData();
        }, { once: true });
        document.addEventListener('auth-ready', () => this._renderUserInfo());
        window.addEventListener('pep-saved', (e) => {
            if (e.detail && window.Auth) window.Auth.userData = e.detail;
            this._renderUserInfo();
        });
        window.addEventListener('op-profile-updated', (e) => {
            if (e.detail && window.Auth) window.Auth.userData = e.detail;
            this._renderUserInfo();
        });
    }

    // Hide skeleton + show empty state on dashboard. Once real data loads
    // (future: recent assessments feed), this can be replaced with actual
    // content rendering.
    _setupDashboard() {
        const skeleton = document.getElementById('dashboard-skeleton');
        const empty = document.getElementById('dashboard-empty');
        if (!skeleton && !empty) return;
        // Defer to next tick so platform-ready has a chance to fire first.
        setTimeout(() => {
            if (skeleton) skeleton.hidden = true;
            if (empty) empty.hidden = false;
        }, 1500);
    }

    async _loadDashboardData() {
        // Placeholder for future dashboard data loading. For now, just
        // ensures the skeleton is hidden after platform is ready.
        this._setupDashboard();
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

        const t = (key, vars, fallback) => fallback;

        if (user || data.email || data.nama) {
            const rawName = data.nama || user?.displayName || user?.email?.split('@')[0] || t('nav.role_admin', null, 'Administrator');
            const rawEmail = data.email || user?.email || '';
            const name = escape(rawName);
            const email = escape(rawEmail);
            const avatarUrl = data.avatar_url || data.foto_profil || data.fotoProfil || '';
            const role = data.peran === 'admin' ? t('nav.role_admin', null, 'Administrator') : t('nav.role_admin_alt', null, 'Admin AlbEdu');
            // DB column is `profile_complete` (renamed from `profil_lengkap`
            // by migration 20260701_002_alter_users_snake_case.sql).
            const incomplete = data.profile_complete === false || data.profilLengkap === false || data.profil_lengkap === false;

            const safeAvatarUrl = (avatarUrl && /^https:/.test(avatarUrl) && !avatarUrl.endsWith('.html')) ? avatarUrl : '';
            const incompleteBadge = incomplete
                ? `<span class="profile-status-mobile">${escape(t('nav.profile_incomplete', null, 'Profil belum lengkap'))}</span>`
                : '';
            const defaultAvatarIcon = '<span data-albedu-icon="manage_accounts"></span>';
            container.innerHTML = `
                <div class="user-avatar-mobile" id="admin-index-avatar" aria-hidden="true">
                    ${safeAvatarUrl
                        ? `<img src="${escape(safeAvatarUrl)}" alt="" data-avatar-fallback="true" style="width:100%;height:100%;object-fit:cover;border-radius:50%;opacity:0;transition:opacity 300ms ease">`
                        : defaultAvatarIcon}
                </div>
                <div class="user-details-mobile">
                    <h3>${name}</h3>
                    <p>${email || role}</p>
                    ${incompleteBadge}
                </div>
            `;

            const avatarImg = container.querySelector('img[data-avatar-fallback]');
            if (avatarImg) {
                avatarImg.addEventListener('error', function() {
                    // Restore default icon on error
                    this.parentElement.innerHTML = defaultAvatarIcon;
                });
                avatarImg.addEventListener('load', function() {
                    this.style.opacity = '1';
                });
            }

            this._attachOptionProfileTrigger(container);
            this._renderGreeting(rawName);
            return;
        }

        container.innerHTML = `
            <div class="user-avatar-mobile" aria-hidden="true">
                <span data-albedu-icon="manage_accounts"></span>
            </div>
            <div class="user-details-mobile">
                <h3>${escape(t('nav.role_admin', null, 'Administrator'))}</h3>
                <p class="loading-text" aria-label="${escape(t('nav.loading_profile', null, 'Memuat profil...'))}">${escape(t('nav.loading_profile', null, 'Memuat profil...'))}</p>
            </div>
        `;
    }

    _attachOptionProfileTrigger(container) {
        // If OptionProfile is already loaded, attach immediately. Otherwise
        // wait for its `option-profile-ready` event (or poll briefly as a
        // safety net for the race where the event already fired).
        if (window.OptionProfile && typeof window.OptionProfile.addTrigger === 'function') {
            window.OptionProfile.addTrigger(container);
            return;
        }

        const deferredAttach = () => {
            if (window.OptionProfile && typeof window.OptionProfile.addTrigger === 'function') {
                // Only attach if container is still in the DOM (re-render may
                // have replaced it).
                if (container.isConnected) {
                    window.OptionProfile.addTrigger(container);
                }
            }
        };
        document.addEventListener('option-profile-ready', deferredAttach, { once: true });

        // Safety net: if `option-profile-ready` already fired, poll briefly.
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
            });
        };

        document.head.appendChild(s);
    }

    _renderGreeting(name) {
        const el = document.getElementById('greeting');
        if (!el) return;

        const t = (key, vars, fallback) => fallback;

        const hour = new Date().getHours();
        let salutationKey, salutationFallback;
        if (hour < 11)      { salutationKey = 'nav.greet_morning';   salutationFallback = 'Selamat Pagi'; }
        else if (hour < 15) { salutationKey = 'nav.greet_afternoon'; salutationFallback = 'Selamat Siang'; }
        else if (hour < 19) { salutationKey = 'nav.greet_evening';   salutationFallback = 'Selamat Sore'; }
        else                { salutationKey = 'nav.greet_night';     salutationFallback = 'Selamat Malam'; }

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
