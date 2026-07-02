/* ═══════════════════════════════════════════════════════════════
 * navigasi.js v2.0 — AlbEdu Admin Sidebar Navigation
 * ───────────────────────────────────────────────────────────────
 * REBUILD FROM SCRATCH.
 *
 * Design contract:
 *   1. No idle / looping animations. Every visual transition is
 *      triggered by a user action (hover, focus, active, click,
 *      touch, resize). Removed all staggered animateIn/animateOut
 *      timeouts from v1.
 *   2. Two-state logo behaviour:
 *        EXPANDED → .logo-icon-link is a normal <a> link to admin home.
 *                   .sidebar-collapse-toggle button is visible
 *                   floating at the sidebar edge.
 *        COLLAPSED → .logo-icon-link becomes the expand button (clicks
 *                    are intercepted, navigation prevented). The
 *                    separate .sidebar-collapse-toggle is hidden
 *                    via CSS — visually "melebur" into the logo.
 *      On hover/focus/active while collapsed, CSS cross-fades the
 *      default AlbEdu icon → chevron icon. No JS needed for that.
 *   3. Mobile breakpoint pinned at 1023px — MUST match the
 *      @media (max-width: 1023px) rule in navigasi.css. Below this
 *      the sidebar becomes an off-canvas drawer and "collapsed"
 *      no longer applies.
 *   4. State is persisted to localStorage so a refresh keeps the
 *      user's preference (desktop only).
 *   5. All logic is centralised here — no inline <script> copies
 *      on individual admin pages.
 * ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function () {

    /* ── Constants ─────────────────────────────────────────────── */
    const MOBILE_BREAKPOINT = 1023;
    const STORAGE_KEY       = 'albedu-sidebar-collapsed';

    /* ── DOM ───────────────────────────────────────────────────── */
    const sidebar    = document.querySelector('.sidebar');
    if (!sidebar) return; // Not an admin page with a sidebar.

    const logoLink   = document.querySelector('.logo-icon-link[data-nav="logo"]');
    const toggleBtn  = document.getElementById('sidebar-collapse-toggle');
    const menuToggle = document.getElementById('menu-toggle');
    const menuItems  = document.querySelectorAll('.menu-item');
    const notifBtn   = document.querySelector('.header-right .notification-btn, .notification-btn');
    const badge      = document.querySelector('.header-right .badge, .notification-btn .badge');

    /* ── Sidebar overlay (mobile) ──────────────────────────────── */
    let sidebarOverlay = document.querySelector('.sidebar-overlay');
    if (!sidebarOverlay) {
        sidebarOverlay = document.createElement('div');
        sidebarOverlay.className = 'sidebar-overlay';
        document.body.appendChild(sidebarOverlay);
    }

    /* ── Native tooltips on menu items (visible when collapsed) ── */
    // v2.0.0: i18n-aware — re-runs on locale change so tooltips reflect
    // the current language (since sidebar-text is data-i18n-translated).
    function _t(key, fallback) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            const v = window.i18n.t(key);
            return v !== undefined ? v : fallback;
        }
        return fallback;
    }

    function _updateTooltips() {
        document.querySelectorAll('.menu-item-content').forEach(a => {
            const txt = a.querySelector('.sidebar-text')?.textContent.trim();
            if (txt) a.setAttribute('title', txt);
        });
        const userProfileBtn = document.querySelector('.user-profile-content');
        if (userProfileBtn && !userProfileBtn.getAttribute('title')) {
            userProfileBtn.setAttribute('title', _t('nav.profile_menu', 'Menu profil pengguna'));
        }
    }
    _updateTooltips();

    // Re-update tooltips when locale changes (so they reflect the new lang)
    document.addEventListener('locale-changed', _updateTooltips);

    /* ── State helpers ─────────────────────────────────────────── */
    function isMobile() {
        return window.innerWidth <= MOBILE_BREAKPOINT;
    }
    function isCollapsed() {
        return sidebar.classList.contains('collapsed');
    }

    /**
     * Apply collapsed/expanded state and persist to localStorage
     * (desktop only — mobile never persists since the drawer
     * system takes over below MOBILE_BREAKPOINT).
     */
    function setCollapsed(collapsed) {
        if (collapsed) {
            sidebar.classList.add('collapsed');
        } else {
            sidebar.classList.remove('collapsed');
        }
        if (!isMobile()) {
            try {
                localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
            } catch (_) { /* localStorage may be disabled (private mode) */ }
        }
        syncAriaLabels();
    }

    /**
     * Sync aria-label / aria-expanded / role / title on the toggle
     * button and the logo link based on the current state.
     *
     * - When collapsed (desktop), the logo link announces itself as
     *   a button ("Buka sidebar") because that's what it now is.
     * - When expanded, the logo link is a normal link to home.
     * - On mobile, the logo link is always a normal link — the
     *   sidebar is a drawer that's either open or closed, and the
     *   "collapsed" concept doesn't apply.
     */
    function syncAriaLabels() {
        const collapsed = isCollapsed();
        const mobile    = isMobile();

        if (toggleBtn) {
            const label = collapsed ? _t('nav.open_sidebar', null, 'Buka sidebar') : _t('nav.close_sidebar', null, 'Tutup sidebar');
            toggleBtn.setAttribute('aria-label',    label);
            toggleBtn.setAttribute('aria-expanded', String(!collapsed));
            toggleBtn.title = label;
            // FIX i1.5: When collapsed + desktop, the toggle is
            // visually hidden (visibility:hidden + opacity:0 via CSS).
            // Mark it aria-hidden so screen readers don't announce a
            // hidden "Buka sidebar" button that the user can't see.
            // The logo link now carries that role instead.
            if (collapsed && !mobile) {
                toggleBtn.setAttribute('aria-hidden', 'true');
            } else {
                toggleBtn.removeAttribute('aria-hidden');
            }
        }

        if (logoLink) {
            if (collapsed && !mobile) {
                // COLLAPSED STATE: icon AlbEdu berfungsi sebagai tombol EXPAND.
                // Hapus href supaya <a> TIDAK bisa navigate sama sekali —
                // defensive approach. Even if JS click handler fails/races,
                // browser won't navigate to panel admin. Click handler
                // (registered separately) will call expand().
                logoLink.removeAttribute('href');
                logoLink.setAttribute('aria-label', _t('nav.open_sidebar', null, 'Buka sidebar'));
                logoLink.setAttribute('role', 'button');
                logoLink.setAttribute('aria-expanded', 'false');
                logoLink.title = _t('nav.open_sidebar', null, 'Buka sidebar');
                logoLink.style.cursor = 'pointer';
            } else {
                // EXPANDED STATE (or mobile): icon AlbEdu berfungsi sebagai
                // LINK ke panel administrator. Restore href.
                // v0.742.0: fallback is 'index.html' (same folder) since all
                // admin pages now live at pages/admin/*.html (flat structure).
                logoLink.setAttribute('href', logoLink.dataset.href || 'index.html');
                logoLink.setAttribute('aria-label', 'AlbEdu Creates — Ke beranda');
                logoLink.removeAttribute('role');
                logoLink.removeAttribute('aria-expanded');
                logoLink.title = 'AlbEdu Creates — Klik untuk ke beranda';
                logoLink.style.cursor = 'pointer';
            }
        }
    }

    /* ── Toggle handlers ───────────────────────────────────────── */
    function toggleCollapsed() {
        setCollapsed(!isCollapsed());
        // FIX i1.1: When the toggle button is clicked, it becomes
        // visibility:hidden + opacity:0 in collapsed state, which
        // causes focus to fall back to <body>. Move focus to the
        // logo link so keyboard users can continue tabbing from a
        // sensible anchor — the logo is now the next logical
        // interactive element (it acts as the expand button when
        // collapsed, or as the home link when expanded).
        if (logoLink) {
            // Use a microtask to let the CSS transition + visibility
            // change settle before moving focus.
            Promise.resolve().then(() => logoLink.focus());
        }
    }
    function expand() {
        if (isCollapsed()) setCollapsed(false);
    }
    function collapse() {
        if (!isCollapsed()) setCollapsed(true);
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleCollapsed);
    }

    /* ── Logo click handler — link when expanded, button when collapsed ──
     * This is the core "two-state logo" behaviour. When the sidebar
     * is collapsed (desktop only), clicking the logo must NOT
     * navigate to home — it must expand the sidebar instead. We
     * intercept the click and prevent default navigation.
     *
     * On mobile, the logo is always a normal link — the drawer's
     * open/close is handled by the menu-toggle button.
     */
    if (logoLink) {
        logoLink.addEventListener('click', function (e) {
            if (isCollapsed() && !isMobile()) {
                e.preventDefault();
                expand();
                return;
            }
            // Otherwise: allow the normal link navigation to admin home.
        });

        // Keyboard accessibility: when the logo is acting as a button
        // (collapsed state), Enter and Space should trigger expand —
        // matching native <button> semantics. The browser already
        // fires click() on Enter for <a> tags, but Space does not.
        logoLink.addEventListener('keydown', function (e) {
            if (!(isCollapsed() && !isMobile())) return;
            if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                expand();
            }
        });
    }

    /* ── Restore persisted state (desktop only) ──────────────────
     * FIX i1.4: If the user is on mobile, clear any stale 'true'
     * value from localStorage. The previous version left the stale
     * value in storage on mobile reload — it was only cleaned up
     * later by the resize handler. Cleaning immediately on init
     * keeps the storage value consistent with the actual rendered
     * state, and prevents a confusing "collapsed=true restored"
     * log on a subsequent desktop reload.
     */
    try {
        if (isMobile()) {
            // Mobile: collapsed doesn't apply, drop stale value.
            localStorage.removeItem(STORAGE_KEY);
        } else if (localStorage.getItem(STORAGE_KEY) === 'true') {
            sidebar.classList.add('collapsed');
        }
    } catch (_) { /* ignore */ }
    syncAriaLabels();

    /* ── Mobile sidebar drawer ─────────────────────────────────── */
    function setMenuIcon(name) {
        if (!menuToggle) return;
        const icon = menuToggle.querySelector('i');
        if (!icon) return;
        icon.className = 'material-symbols-outlined';
        icon.textContent = name;
    }

    function openSidebar() {
        sidebar.classList.add('active');
        sidebarOverlay.classList.add('visible');
        setMenuIcon('close');
    }
    function closeSidebar() {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('visible');
        setMenuIcon('menu');
    }

    if (menuToggle) {
        menuToggle.addEventListener('click', function () {
            sidebar.classList.contains('active') ? closeSidebar() : openSidebar();
        });
    }
    sidebarOverlay.addEventListener('click', closeSidebar);

    /* FIX i1.2: ESC key closes the mobile drawer. Standard a11y
     * pattern for off-canvas overlays. Listener is on document
     * (not on the overlay) because the overlay has tabindex=-1
     * and won't receive key events when the sidebar itself holds
     * focus. */
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!isMobile()) return;
        if (!sidebar.classList.contains('active')) return;
        closeSidebar();
        // Return focus to the menu-toggle button so keyboard users
        // can re-open the drawer without tabbing back.
        if (menuToggle) menuToggle.focus();
    });

    /* ── Navigation click handler ─────────────────────────────────
     * FIX i1.3: v2 erroneously called e.preventDefault() unconditionally
     * in some branches, which blocked the default navigation to the
     * target page. The click handler should only intervene for:
     *   - placeholder hrefs ('#', 'javascript:')
     *   - mobile drawer closing before navigate (no preventDefault)
     * Otherwise let the browser do its native <a href> navigation.
     */
    menuItems.forEach(item => {
        const link = item.querySelector('.menu-item-content');
        if (!link) return;
        item.addEventListener('click', function (e) {
            const href = link.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) {
                e.preventDefault();
                return;
            }
            // Close drawer on mobile BEFORE the browser navigates.
            // No preventDefault — let the browser follow the link.
            if (isMobile()) closeSidebar();
        });
    });

    /* ── Active state from URL ───────────────────────────────────
     * v0.742.0: Mapping extended to cover every admin page so the
     * sidebar "active" highlight works uniformly across both legacy
     * redirect stubs (buat-ujian, data-hasil, ujian-peserta) and the
     * new v2 admin pages. Legacy stubs still map to their canonical
     * destination tab so the user lands on the right highlighted
     * entry even when they hit an old bookmark. */
    const pageMapping = {
        'profile.html':          'profil',
        'create-assessment.html': 'create-assessment',
        'buat-ujian.html':       'create-assessment', // legacy stub → canonical
        'active-assessments.html': 'active-assessments',
        'ujian-peserta.html':    'active-assessments', // legacy stub → canonical
        'question-bank.html':    'question-bank',
        'monitoring.html':       'monitoring',
        'results-analytics.html': 'results',
        'data-hasil.html':       'results',            // legacy stub → canonical
        'daftar-nama.html':      'daftar-nama',
    };
    const currentPage = window.location.pathname.split('/').pop();
    const activeTab   = pageMapping[currentPage] || null;
    const activeItem  = activeTab
        ? document.querySelector(`.menu-item[data-tab="${activeTab}"]`)
        : null;
    if (activeItem) {
        menuItems.forEach(i => i.classList.remove('active'));
        activeItem.classList.add('active');
    }

    /* ── Resize: reset state when crossing the breakpoint ────────
     * Debounced — prevents thrashing during drag-resize. The
     * previous version had race conditions where drawer state and
     * collapsed state could fight each other in the 993–1023px
     * "dead zone". Now both states are reset cleanly whenever the
     * viewport crosses MOBILE_BREAKPOINT.
     *
     * FIX i2.1: When crossing into mobile, ALSO clear the
     * localStorage value. The init-time cleanup (fix i1.4) only
     * handles reload; the resize handler previously left the stale
     * 'true' value intact, so a user who resized mobile→desktop
     * would unexpectedly see the sidebar collapsed even if they
     * had been on mobile for a while.
     */
    let resizeTimer;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (isMobile()) {
                // Entering mobile: clear collapsed + close drawer +
                // purge stale storage value (collapsed doesn't apply
                // to drawer mode).
                sidebar.classList.remove('collapsed');
                closeSidebar();
                try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
            } else {
                // Entering desktop: restore persisted collapsed state,
                // clear any drawer state.
                sidebar.classList.remove('active');
                sidebarOverlay.classList.remove('visible');
                setMenuIcon('menu');
                try {
                    if (localStorage.getItem(STORAGE_KEY) === 'true') {
                        sidebar.classList.add('collapsed');
                    } else {
                        sidebar.classList.remove('collapsed');
                    }
                } catch (_) { /* ignore */ }
            }
            syncAriaLabels();
        }, 150);
    });

    /* ── Page transition overlay — defensive cleanup ────────────
     * v0.742.1: loading.css was changed so `.page-transition` is
     * now HIDDEN BY DEFAULT (opacity:0, visibility:hidden). This
     * means the overlay no longer flashes on every navigation
     * between admin pages — fixing the "flash pages" complaint.
     *
     * The overlay only becomes visible if JS explicitly adds the
     * `.visible` class (no caller does this currently, but the
     * hook is preserved for future use).
     *
     * The old hidePageTransition() logic (waiting for window.load
     * + 300ms timeout) is no longer needed — the overlay starts
     * hidden. We still strip any stale `.visible` class as a
     * defensive measure in case a previous page set it before
     * navigation (BFCache restore, etc.). */
    const pageTransition = document.querySelector('.page-transition');
    if (pageTransition) {
        pageTransition.classList.remove('visible');
    }

    /* ── Notification badge ────────────────────────────────────── */
    if (badge) badge.style.display = 'none';
    if (notifBtn) {
        notifBtn.addEventListener('click', function () {
            if (window.AdminNotificationCenter) AdminNotificationCenter.openPanel();
        });
    }

    /* ── Remove logout-btn from header — handled by OptionProfile ── */
    const logoutBtn = document.getElementById('logout-btn-header');
    if (logoutBtn) logoutBtn.remove();

    /* ═══════════════════════════════════════════════════════════
     * Auth integration — kept from v1, unchanged.
     * Syncs sidebar avatar + name from window.Auth.userData.
     * ═══════════════════════════════════════════════════════════ */
    function _esc(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _syncSidebarUser() {
        const user = window.Auth?.userData;
        if (!user) return;

        const avatarEl = document.querySelector('.user-profile .avatar');
        const nameEl   = document.querySelector('.user-profile .user-info h4');
        const roleEl   = document.querySelector('.user-profile .user-info p');

        if (avatarEl) {
            const url = user.foto_profil || user.fotoProfil;
            if (url) {
                const safeUrl = (/^https:/i.test(url) || /^data:image\//i.test(url) || !/^[a-z]+:/i.test(url)) ? url : '';
                if (safeUrl) {
                    avatarEl.innerHTML = `<img src="${_esc(safeUrl)}" alt="Avatar" data-nav-avatar>`;
                    const img = avatarEl.querySelector('img[data-nav-avatar]');
                    if (img) {
                        img.addEventListener('error', function () {
                            this.style.display = 'none';
                        }, { once: true });
                    }
                }
            }
        }
        if (nameEl) nameEl.textContent = user.nama  || _t('nav.default_admin_name', null, 'Admin');
        if (roleEl) roleEl.textContent = user.peran === 'admin' ? _t('nav.role_admin', null, 'Administrator') : _t('nav.peserta_role', null, 'Peserta');

        const content = document.querySelector('.user-profile-content');
        if (content && user.profilLengkap === false) {
            if (!content.querySelector('.profile-incomplete-dot')) {
                const dot = document.createElement('span');
                dot.className = 'profile-incomplete-dot';
                dot.title = _t('nav.profile_incomplete_short', null, 'Profil belum lengkap');
                content.appendChild(dot);
            }
        }
    }

    if (window.Auth?.userData) {
        _syncSidebarUser();
    } else {
        window.addEventListener('auth-ready', _syncSidebarUser, { once: true });
        let polls = 0;
        const pollAuth = setInterval(() => {
            if (window.Auth?.userData || ++polls > 20) {
                clearInterval(pollAuth);
                if (window.Auth?.userData) _syncSidebarUser();
            }
        }, 300);
    }

    const _origSetUserData = window.Auth?.setUserData;
    if (window.Auth && _origSetUserData) {
        window.Auth.setUserData = function (data) {
            _origSetUserData.call(this, data);
            _syncSidebarUser();
        };
    }

    /* ── Toast helper (kept from v1) ── */
    function showToast(message, type = 'info') {
        const qn = window.QNotify || window.notify;
        if (qn?.notify?.[type]) { qn.notify[type]('', message, 3000); return; }
        console.info('[Toast/' + type + ']', message);
    }
    window.showToast = showToast;

    /* ═══════════════════════════════════════════════════════════
     * _resolveProfileScriptBase() — v2.1 helper.
     *
     * Computes the base URL for loading scripts from `src/profile/`.
     * Used by both _bootstrapProfilePanel() and _bootstrapOptionProfile()
     * to avoid duplicating the path-resolution logic.
     *
     * Algorithm:
     *   1. Find the <script> tag that loaded navigasi.js (this file).
     *      Its `src` attribute is a full URL like
     *      `https://albytehq.github.io/AlbEdu/src/utils/navigasi.js`.
     *   2. Strip `utils/navigasi.js` and everything after, replace with
     *      `profile/`. Result: `.../src/profile/`.
     *   3. If navigasi.js can't be found in the DOM (defensive — should
     *      never happen since this code IS running from navigasi.js),
     *      fall back to `window.Auth.getBasePath()` + `src/profile/`
     *      (root-relative, e.g. `/AlbEdu/src/profile/`).
     *   4. Final fallback: assume 2-level page depth (pages/admin/*.html)
     *      and use `../../src/profile/`. This matches the actual depth
     *      of every page that loads navigasi.js (v0.742.0+).
     *
     * Returns a string suitable for `script.src = base + 'editor-panel.js'`.
     * ═══════════════════════════════════════════════════════════ */
    function _resolveProfileScriptBase() {
        const navSrc = document.querySelector('script[src*="navigasi.js"]')?.src || '';
        if (navSrc) {
            // navigasi.js lives at {BASE_PATH}src/utils/navigasi.js.
            // editor-panel.js / option-profile.js live at {BASE_PATH}src/profile/.
            // Strip 'utils/navigasi.js...' and replace with 'profile/'.
            // Regex: matches 'utils/navigasi.js' followed by any query/hash, to end.
            return navSrc.replace(/utils\/navigasi\.js.*$/, 'profile/');
        }
        // Fallback 1: use Auth BASE_PATH (root-relative, e.g. '/AlbEdu/')
        const authBase = window.Auth?.getBasePath?.();
        if (authBase) return authBase + 'src/profile/';
        // Fallback 2: assume 2-level page depth (all pages that load
        // navigasi.js are at pages/admin/*.html = 2 levels deep, v0.742.0+).
        return '../../src/profile/';
    }

    /* ═══════════════════════════════════════════════════════════
     * ProfileEditorPanel bootstrap — kept from v1, FIXED in v2.1.
     * Loads once here so every admin page gets the panel without
     * each page loading its own copy. onSaved updates sidebar
     * avatar + name without a reload.
     *
     * v2.1 FIX: The original regex `navSrc.replace(/navigasi\.js.*$/, '')`
     * strips only the filename from `src/utils/navigasi.js`, leaving
     * `src/utils/`. Appending `editor-panel.js` then tried to load
     * `src/utils/editor-panel.js` — a 404, because editor-panel.js
     * actually lives at `src/profile/editor-panel.js`. The script
     * silently failed to load on 4 of 5 admin sub-pages (only
     * profile.html worked, because it also loads editor-panel.js
     * directly via a <script> tag). The fix: strip `utils/navigasi.js`
     * and replace with `profile/` to land in the correct directory.
     * See rule-url-albedu.md §3 (always use Auth BASE_PATH helpers).
     * ═══════════════════════════════════════════════════════════ */
    (function _bootstrapProfilePanel() {
        if (document.getElementById('pep-panel-script')) return;

        const s    = document.createElement('script');
        s.id       = 'pep-panel-script';
        const base   = _resolveProfileScriptBase();
        s.src        = base + 'editor-panel.js';
        s.defer      = true;

        s.onload = function () {
            if (!window.ProfileEditorPanel) return;
            window.ProfileEditorPanel.init({
                trigger:    [],
                workerBase: 'https://edu.albyte-inc.workers.dev',
                onSaved: function (user) {
                    const nameEl   = document.getElementById('sidebar-user-name');
                    const avatarEl = document.getElementById('sidebar-avatar');
                    if (nameEl   && user.nama)        nameEl.textContent = user.nama;
                    if (avatarEl && user.foto_profil) {
                        const url = user.foto_profil;
                        const safeUrl = (/^https:/i.test(url) || /^data:image\//i.test(url) || !/^[a-z]+:/i.test(url)) ? url : '';
                        if (safeUrl) {
                            avatarEl.innerHTML = `<img src="${_esc(safeUrl)}" alt="Avatar"
                                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" data-nav-avatar-saved>`;
                            const img = avatarEl.querySelector('img[data-nav-avatar-saved]');
                            if (img) {
                                img.addEventListener('error', function () {
                                    this.parentElement.innerHTML = '<i class="material-symbols-outlined">person</i>';
                                }, { once: true });
                            }
                        }
                    }
                    const adminName   = document.getElementById('admin-name');
                    const adminAvatar = document.getElementById('admin-avatar');
                    if (adminName   && user.nama)        adminName.textContent = user.nama;
                    if (adminAvatar && user.foto_profil) {
                        const url2 = user.foto_profil;
                        const safeUrl2 = (/^https:/i.test(url2) || /^data:image\//i.test(url2) || !/^[a-z]+:/i.test(url2)) ? url2 : '';
                        if (safeUrl2) {
                            adminAvatar.innerHTML = `<img src="${_esc(safeUrl2)}" alt="Foto Profil"
                                style="width:100%;height:100%;object-fit:cover;border-radius:50%;" data-nav-admin-avatar>`;
                            const img2 = adminAvatar.querySelector('img[data-nav-admin-avatar]');
                            if (img2) {
                                img2.addEventListener('error', function () {
                                    this.parentElement.innerHTML = '<i class="material-symbols-outlined">account_circle</i>';
                                }, { once: true });
                            }
                        }
                    }
                }
            });
        };

        document.head.appendChild(s);
    }());

    /* ═══════════════════════════════════════════════════════════
     * OptionProfile bootstrap — kept from v1, FIXED in v2.1.
     * Loads OptionProfile.js and attaches to the sidebar
     * user-profile-content button. Clicking the name/avatar in the
     * sidebar opens the global profile options panel.
     *
     * v2.1 FIX: Same regex bug as _bootstrapProfilePanel above —
     * `navigasi.js` lives in `src/utils/` but `option-profile.js`
     * lives in `src/profile/`. The original code tried to load from
     * `src/utils/option-profile.js` (404). Now uses the shared
     * _resolveProfileScriptBase() helper.
     * ═══════════════════════════════════════════════════════════ */
    (function _bootstrapOptionProfile() {
        if (document.getElementById('op-script')) return;

        const s    = document.createElement('script');
        s.id       = 'op-script';
        const base   = _resolveProfileScriptBase();
        s.src        = base + 'option-profile.js';
        s.defer      = true;

        s.onload = function () {
            if (!window.OptionProfile) return;
            const userContent = document.querySelector('.user-profile-content');
            window.OptionProfile.init({
                triggers:   userContent ? [userContent] : [],
                context:    'sidebar',
                workerBase: 'https://edu.albyte-inc.workers.dev',
            });
        };

        document.head.appendChild(s);

        document.addEventListener('option-profile-ready', function () {
            if (!window.OptionProfile || typeof window.OptionProfile.addTrigger !== 'function') return;
            const userContent = document.querySelector('.user-profile-content');
            if (userContent) {
                window.OptionProfile.addTrigger(userContent);
            }
        });
    }());

});
