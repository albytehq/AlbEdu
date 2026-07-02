// =============================================================
//  ujian-peserta.js — Advanced Admin Exam Panel
//  Version: 4.3.0 | Migrated: Firebase → Supabase shim
//
//  Boot order:
//    1. SupabaseApi.js init, dispatch 'firebase-ready' (compat)
//    2. _waitForFirebase gates on window.__firebaseReady
//    3. _waitForAuth uses window.firebaseAuth shim
//    4. ExamAdminController.init() receives resolved user directly
// =============================================================

const TOGGLE_RENABLE_MS = 1_500;
const DELETE_ANIMATE_MS = 240;
const MODAL_REMOVE_MS   = 300;

class UjianPesertaManager {

    constructor() {
        // v2.0.0: Class filter system removed entirely.
        // Exams are shown in general list (no class tab UI).
        this.controller      = new ExamAdminController(); // safe: no firebase calls in constructor now
        this.searchDebounce  = null;
        this._allExams       = [];
        this.isInitialized   = false;
        this._prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.init();
    }

    // =========================================================
    //  INIT — gate on firebase-ready before ANY firebase call
    // =========================================================

    async init() {
        if (this.isInitialized) return;

        this._renderSkeleton();

        try {
            // Step 1: wait for SupabaseApi.js to finish init and dispatch 'firebase-ready'.
            await this._waitForFirebase(15_000);

            // Step 2: wait for auth state (firebaseAuth shim is ready after firebase-ready)
            const user = await this._waitForAuth(12_000);

            // Step 3: wire the update callback BEFORE init() so we don't miss the first snapshot
            this.controller.onExamUpdateCallback = (exams) => {
                this._allExams = exams;
                this._refreshView();
            };

            // Step 4: pass the resolved user directly — avoids a third onAuthStateChanged listener
            await this.controller.init(user);

            this._setupSearch();
            this._setupDelegatedClicks();
            // Class tab wiring removed — exams now displayed in general, no filter.

            this.isInitialized = true;

        } catch (err) {
            this._showInitError(err.message);
            this._toast('Gagal memuat halaman. Coba refresh.', 'error');
        }
    }

    // Wait for SupabaseApi.js to dispatch 'firebase-ready' (compat event).
    // Resolves immediately if already ready (fast path).
    _waitForFirebase(ms) {
        return new Promise((resolve, reject) => {
            // Fast path: SupabaseApi already init (e.g. cached session)
            if (window.__firebaseReady) { resolve(); return; }

            // Error path: firebase already failed
            if (window.__firebaseError) { reject(new Error(window.__firebaseError)); return; }

            const timer = setTimeout(
                () => reject(new Error('Koneksi timeout — periksa koneksi internet')), ms
            );

            document.addEventListener('firebase-ready', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });

            document.addEventListener('firebase-error', (e) => {
                clearTimeout(timer);
                reject(new Error(e.detail?.error || 'Koneksi gagal'));
            }, { once: true });
        });
    }

    // Wait for Auth to confirm a logged-in user.
    // Called AFTER _waitForFirebase, so window.firebaseAuth shim is ready.
    _waitForAuth(ms) {
        return new Promise((resolve, reject) => {
            const doAuthWait = (auth) => {
                const timer = setTimeout(
                    () => reject(new Error('Auth timeout — periksa koneksi internet')), ms
                );
                const unsub = auth.onAuthStateChanged(user => {
                    if (user) {
                        clearTimeout(timer);
                        unsub();
                        resolve(user);
                    }
                });
            };

            // Check if firebaseAuth shim exists
            if (window.firebaseAuth) {
                doAuthWait(window.firebaseAuth);
                return;
            }

            // Wait for it to become available
            let authPolls = 0;
            const authPoll = setInterval(() => {
                if (window.firebaseAuth) {
                    clearInterval(authPoll);
                    doAuthWait(window.firebaseAuth);
                } else if (++authPolls > 30) {
                    clearInterval(authPoll);
                    reject(new Error('Auth tidak tersedia — periksa koneksi internet'));
                }
            }, 300);
        });
    }

    // =========================================================
    //  MAIN REFRESH — called on every Firestore snapshot
    // =========================================================

    _refreshView() {
        // v2.0.0: No class filter — render all exams. _forClass() passes through.
        const filtered = this._forClass(this._allExams);

        this._renderExams(filtered);
        this._updateSummaryBar(filtered);
        this._renderStats(this._allExams);

        // Re-apply active search after data refresh
        const searchTerm = document.getElementById('search-exam')?.value?.trim() || '';
        if (searchTerm) this._applySearch(searchTerm);

        this._renderCompletedUsers(filtered);
        this._renderCheatingUsers(filtered);
    }

    // v2.0.0: No-op class filter — returns all exams regardless of `cls`.
    // Kept for backward-compat with internal call sites; class filter was removed
    // per spec "Ujian Peserta: Remove class filter, make exam general".
    _forClass(exams, _cls) {
        return exams;
    }

    // =========================================================
    //  SKELETON
    // =========================================================

    _renderSkeleton() {
        const grid = document.getElementById('exams-grid');
        if (!grid) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 3; i++) {
            const card = document.createElement('div');
            card.className = 'exam-card skeleton';
            card.innerHTML = `
                <div class="exam-card-body" style="gap:10px">
                    <div class="skeleton-block" style="height:18px;width:70%;margin-bottom:4px"></div>
                    <div class="skeleton-block" style="height:14px;width:50%"></div>
                    <div class="skeleton-block" style="height:12px;width:40%;margin-top:8px"></div>
                    <div class="skeleton-block" style="height:38px;width:100%;margin-top:12px;border-radius:10px"></div>
                </div>
                <div class="exam-card-footer">
                    <div class="skeleton-block" style="height:14px;width:80px"></div>
                    <div class="skeleton-block" style="height:30px;width:110px;border-radius:8px"></div>
                </div>`;
            frag.appendChild(card);
        }
        grid.innerHTML = '';
        grid.appendChild(frag);
    }

    // =========================================================
    //  RENDER EXAMS
    // =========================================================

    _renderExams(exams) {
        const grid  = document.getElementById('exams-grid');
        const noMsg = document.getElementById('no-exams-message');
        if (!grid) return;

        if (exams.length === 0) {
            grid.innerHTML = '';
            if (noMsg) {
                noMsg.classList.add('show');
                noMsg.innerHTML = `
                    <div class="message-icon"><i class="material-symbols-outlined">assignment</i></div>
                    <h3>Tidak Ada Ujian</h3>
                    <p>Belum ada ujian yang dibuat.</p>
                    <a href="buat-ujian.html" class="btn-create-exam">
                        <i class="material-symbols-outlined">add_circle</i> Buat Ujian
                    </a>`;
            }
            return;
        }

        if (noMsg) noMsg.classList.remove('show');

        // Build a lookup of incoming exam IDs so removal is O(1).
        // Skeleton cards (no data-exam-id) are one-shot placeholders — remove them
        // the moment real data arrives. They will never come back after this point.
        grid.querySelectorAll('.exam-card.skeleton').forEach(el => el.remove());

        const incomingIds = new Set(exams.map(e => e.id));

        // Remove cards that are no longer in the dataset.
        // querySelectorAll is live-safe here because we iterate a static NodeList.
        grid.querySelectorAll('.exam-card[data-exam-id]').forEach(el => {
            if (!incomingIds.has(el.dataset.examId)) el.remove();
        });

        // Add new cards or replace ones whose status changed.
        // Cards that already exist and haven't changed are left untouched —
        // no re-paint, no countdown interruption.
        exams.forEach((exam, i) => {
            const existing = grid.querySelector(`.exam-card[data-exam-id="${CSS.escape(exam.id)}"]`);
            const statusChanged = existing?.dataset.examStatus !== exam._status;

            if (!existing) {
                // New exam — insert at correct position via reference node.
                const card = this._buildCard(exam);
                card.dataset.examStatus = exam._status;
                if (!this._prefersReduced) card.style.animationDelay = `${i * 45}ms`;
                // insertBefore(null) appends, so this handles the tail case too.
                const refNode = grid.children[i] ?? null;
                grid.insertBefore(card, refNode);
                this._startCardTimers(exam);
            } else if (statusChanged) {
                // Status changed (e.g. RUNNING → FINISHED) — swap the whole card.
                // Timer for old status is already stopped by the controller before
                // this callback fires; we just need to start the new one if needed.
                const card = this._buildCard(exam);
                card.dataset.examStatus = exam._status;
                grid.replaceChild(card, existing);
                this._startCardTimers(exam);
            } else {
                // Nothing structural changed — stamp the current status so future
                // snapshots can detect transitions correctly.
                existing.dataset.examStatus = exam._status;
            }
        });
    }

    // Extracted from the old requestAnimationFrame block so both the initial
    // render path and the surgical-update path share the same timer logic.
    _startCardTimers(exam) {
        requestAnimationFrame(() => {
            if (exam._status === 'RUNNING' && exam.access_control?.end) {
                this.controller.startCountdown(
                    exam.id,
                    exam.access_control.end,
                    (id, m, s, diff) => this._onTick(id, m, s, diff),
                    (id) => this._onFinish(id)
                );
            }

            if (exam._status === 'FINISHED') {
                const expiryEl = document.getElementById(`expiry-${exam.id}`);
                try {
                    const ms   = ExamExpiryManager.msUntilDelete(exam);
                    const tier = ExamExpiryManager.expiryTier(exam);

                    if (expiryEl) {
                        if (ms <= 0) {
                            expiryEl.textContent = 'Akan dihapus otomatis segera';
                            expiryEl.classList.remove('expiry-warning','expiry-soon','expiry-expired');
                            expiryEl.classList.add('expiry-expired');
                        } else {
                            expiryEl.textContent = ExamExpiryManager.deleteCountdownText(exam);
                            expiryEl.classList.remove('expiry-warning','expiry-soon','expiry-expired');
                            if (tier === 'warning') expiryEl.classList.add('expiry-warning');
                            else if (tier === 'deleted-soon') expiryEl.classList.add('expiry-soon');
                            this.controller.startCountdown(
                                exam.id,
                                Date.now() + ms,
                                (id, m, s, diff) => {
                                    const el = document.getElementById(`expiry-${id}`);
                                    if (!el) return;
                                    el.textContent = ExamExpiryManager.deleteCountdownText(exam);
                                    const t = ExamExpiryManager.expiryTier(exam);
                                    el.classList.remove('expiry-warning','expiry-soon','expiry-expired');
                                    if (t === 'warning') el.classList.add('expiry-warning');
                                    else if (t === 'deleted-soon') el.classList.add('expiry-soon');
                                    else if (t === 'expired') el.classList.add('expiry-expired');
                                },
                                (id) => {
                                    const el = document.getElementById(`expiry-${id}`);
                                    if (el) {
                                        el.textContent = 'Akan dihapus otomatis segera';
                                        el.classList.remove('expiry-warning','expiry-soon');
                                        el.classList.add('expiry-expired');
                                    }
                                }
                            );
                        }
                    }
                } catch (e) {
                    console.warn('Expiry badge error for', exam.id, e);
                }
            }
        });
    }

    // =========================================================
    //  BUILD EXAM CARD
    // =========================================================

    _buildCard(exam) {
        const id     = exam.id;
        const ujian  = this._meta(exam);
        const access = exam.access_control || {};
        const soal   = exam.PQ             || {};
        const status = exam._status        || 'NOT_STARTED';

        const S = {
            NOT_STARTED: { label:'Belum Mulai', dot:'inactive', btnText:'Mulai Ujian',  btnIcon:'play_arrow',      cls:'start',    disabled:false },
            RUNNING:     { label:'Berjalan',    dot:'active',   btnText:'Hentikan',     btnIcon:'pause',           cls:'stop',     disabled:false },
            PAUSED:      { label:'Ditunda',     dot:'paused',   btnText:'Lanjutkan',    btnIcon:'play_arrow',      cls:'resume',   disabled:false },
            FINISHED:    { label:'Selesai',     dot:'finished', btnText:'Selesai',      btnIcon:'check_circle',    cls:'finished', disabled:true  },
        };
        const cfg = S[status] || S.NOT_STARTED;

        const mode      = access.mode || 'manual';
        const modeText  = mode === 'manual' ? 'Manual' : 'Otomatis';
        const modeIcon  = mode === 'manual' ? 'person_edit' : 'smart_toy';

        const kelasChips = (ujian.kelas || []).map(k =>
            `<span class="kelas-chip">Kelas ${this._esc(String(k))}</span>`
        ).join('');

        // Prefer the pre-computed _totalQuestions from the controller snapshot;
        // fall back to counting live if for any reason it's missing.
        const jumlahSoal = exam._totalQuestions ?? this._countQuestions(soal);
        const metaChips  = [
            ujian.global_skor != null ? `<span class="exam-meta-chip"><i class="material-symbols-outlined">star</i>${ujian.global_skor} Poin</span>` : '',
            ujian.time             ? `<span class="exam-meta-chip"><i class="material-symbols-outlined">schedule</i>${this._esc(String(ujian.time))}</span>` : '',
            jumlahSoal > 0         ? `<span class="exam-meta-chip"><i class="material-symbols-outlined">format_list_numbered</i>${jumlahSoal} Soal</span>` : '',
            ujian.tipe             ? `<span class="exam-meta-chip"><i class="material-symbols-outlined">sell</i>${this._esc(ujian.tipe)}</span>` : '',
            ujian.tingkat          ? `<span class="exam-meta-chip"><i class="material-symbols-outlined">layers</i>${this._esc(ujian.tingkat)}</span>` : '',
        ].filter(Boolean).join('');

        let timerHTML = '';
        if (status === 'RUNNING' && access.end) {
            timerHTML = `
                <div class="exam-timer running" id="timer-${id}" aria-live="polite" aria-label="Sisa waktu ujian">
                    <i aria-hidden="true" class="material-symbols-outlined">hourglass_top</i>
                    <span class="timer-label">Sisa Waktu</span>
                    <span class="timer-value" id="timer-val-${id}">--:--</span>
                </div>`;
        } else if (status === 'PAUSED') {
            // BUG-17 fix: remaining_time sekarang dalam detik, bukan menit
            const remSeconds = access.remaining_time ?? 0;
            const remMinutes = Math.ceil(remSeconds / 60);
            timerHTML = `
                <div class="exam-timer paused">
                    <i aria-hidden="true" class="material-symbols-outlined">pause_circle</i>
                    <span class="timer-label">Ditunda</span>
                    <span class="timer-value">${remMinutes} mnt</span>
                </div>`;
        } else if (status === 'FINISHED') {
            timerHTML = `
                <div class="exam-timer finished">
                    <i aria-hidden="true" class="material-symbols-outlined">check_circle</i>
                    <span>Ujian Selesai</span>
                </div>`;
        }

        // Finished exam uses <span> to prevent stale click events after DOM replace
        const toggleBtn = cfg.disabled
            ? `<span class="btn-toggle-exam finished" aria-disabled="true">
                    <i class="material-symbols-outlined" aria-hidden="true">${cfg.btnIcon}</i> ${cfg.btnText}
               </span>`
            : `<button class="btn-toggle-exam ${cfg.cls}" aria-label="${cfg.btnText}">
                    <i class="material-symbols-outlined" aria-hidden="true">${cfg.btnIcon}</i> ${cfg.btnText}
               </button>`;

        const cardClass = [
            'exam-card',
            status === 'RUNNING'  ? 'active'         : '',
            status === 'PAUSED'   ? 'status-paused'  : '',
            status === 'FINISHED' ? 'status-finished' : '',
        ].filter(Boolean).join(' ');

        const card = document.createElement('div');
        card.className        = cardClass;
        card.dataset.examId   = id;
        card.setAttribute('role', 'listitem');
        card.setAttribute('aria-label', `Ujian: ${ujian.judul || id}`);

        card.innerHTML = `
            <div class="exam-card-body">
                <div class="exam-card-header">
                    <span class="exam-id" title="ID Ujian">${this._esc(id)}</span>
                    <span class="exam-mode ${mode === 'manual' ? 'manual' : 'auto'}">
                        <i class="material-symbols-outlined" aria-hidden="true">${modeIcon}</i> ${modeText}
                    </span>
                </div>
                <h3 class="exam-title">${this._esc(ujian.judul || 'Tanpa Judul')}</h3>
                <div class="exam-subject">
                    <i aria-hidden="true" class="material-symbols-outlined">menu_book</i>
                    <span>${this._esc(ujian.mata_pelajaran || 'Mata pelajaran belum diisi')}</span>
                </div>
                ${kelasChips ? `<div class="exam-kelas-chips" aria-label="Kelas yang mengikuti">${kelasChips}</div>` : ''}
                ${metaChips  ? `<div class="exam-meta-chips">${metaChips}</div>` : ''}
                ${timerHTML}
            </div>
            <div class="exam-card-footer">
                    <div class="exam-status">
                        <span class="status-dot ${cfg.dot}" aria-hidden="true"></span>
                        <span>${cfg.label}</span>
                    </div>
                    <div class="exam-expiry" id="expiry-${id}" aria-live="polite"></div>
                <div class="exam-actions">
                    <button class="btn-action" data-action="edit"   title="Edit ujian"  aria-label="Edit ujian">
                        <i aria-hidden="true" class="material-symbols-outlined">edit</i>
                    </button>
                    <button class="btn-action delete" data-action="delete" title="Hapus ujian" aria-label="Hapus ujian">
                        <i aria-hidden="true" class="material-symbols-outlined">delete</i>
                    </button>
                    ${toggleBtn}
                </div>
            </div>`;

        return card;
    }

    // =========================================================
    //  TIMER CALLBACKS
    // =========================================================

    _onTick(id, mins, secs, diffMs) {
        const valEl   = document.getElementById(`timer-val-${id}`);
        const timerEl = document.getElementById(`timer-${id}`);
        if (!valEl) return;

        valEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

        if (timerEl && diffMs <= 5 * 60_000 && !timerEl.classList.contains('warning-time')) {
            timerEl.classList.add('warning-time');
        }
    }

    _onFinish(id) {
        const valEl = document.getElementById(`timer-val-${id}`);
        if (valEl) valEl.textContent = '00:00';

        const timerEl = document.getElementById(`timer-${id}`);
        if (timerEl) {
            timerEl.className = 'exam-timer finished';
            timerEl.innerHTML = `<i aria-hidden="true" class="material-symbols-outlined">check_circle</i> <span>Waktu Habis</span>`;
        }
    }

    // =========================================================
    //  SUMMARY BAR & STATS
    // =========================================================

    _updateSummaryBar(filtered) {
        const total  = filtered.length;
        const active = filtered.filter(e => e._status === 'RUNNING').length;
        this._setText('total-exams',    total);
        this._setText('active-exams',   active);
    }

    _renderStats(all) {
        this._setText('stat-total',    all.length);
        this._setText('stat-running',  all.filter(e => e._status === 'RUNNING').length);
        this._setText('stat-finished', all.filter(e => e._status === 'FINISHED').length);
    }

    // =========================================================
    //  TABS — v2.0.0: Class tab UI removed entirely.
    // =========================================================
    // All class-tab methods (_setupTabs, _onTabClick, _restoreHashClass,
    // _updateAllTabCounts) have been removed.
    // _forClass() kept as a pass-through for existing filter call-sites.

    // =========================================================
    //  SEARCH
    // =========================================================

    _setupSearch() {
        const input = document.getElementById('search-exam');
        const clear = document.getElementById('search-clear');

        input?.addEventListener('input', () => {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => this._applySearch(input.value.trim()), 240);
        });
        input?.addEventListener('keydown', e => { if (e.key === 'Escape') this._clearSearch(true); });
        clear?.addEventListener('click', () => this._clearSearch(true));
    }

    _applySearch(term) {
        const lc    = term.toLowerCase();
        const cards = document.querySelectorAll('.exams-management-container .exam-card:not(.skeleton)');
        let visible = 0;

        cards.forEach(card => {
            const haystack = [
                card.querySelector('.exam-title')?.textContent,
                card.querySelector('.exam-subject span')?.textContent,
                card.querySelector('.exam-id')?.textContent,
                card.querySelector('.exam-kelas-chips')?.textContent,
                card.querySelector('.exam-meta-chips')?.textContent,
            ].join(' ').toLowerCase();

            const show = !lc || haystack.includes(lc);
            card.style.display = show ? '' : 'none';
            if (show) visible++;
        });

        const hint = document.getElementById('search-results-hint');
        if (hint) {
            hint.textContent = lc
                ? (visible > 0
                    ? `${visible} ujian ditemukan untuk "${term}"`
                    : `Tidak ada hasil untuk "${term}"`)
                : '';
        }

        const noMsg     = document.getElementById('no-exams-message');
        const dataCount = this._forClass(this._allExams).length;
        if (noMsg) {
            if (visible === 0 && lc && dataCount > 0) {
                noMsg.classList.add('show');
                noMsg.innerHTML = `
                    <div class="message-icon"><i class="material-symbols-outlined">search</i></div>
                    <h3>Tidak Ditemukan</h3>
                    <p>Tidak ada ujian yang cocok dengan "<strong>${this._esc(term)}</strong>"</p>`;
            } else if (dataCount === 0) {
                noMsg.classList.add('show');
            } else {
                noMsg.classList.remove('show');
            }
        }
    }

    _clearSearch(refocus = true) {
        const input = document.getElementById('search-exam');
        if (input) { input.value = ''; if (refocus) input.focus(); }
        this._applySearch('');
    }

    // =========================================================
    //  DELEGATED CLICK ROUTER
    // =========================================================

    _setupDelegatedClicks() {
        document.addEventListener('click', e => this._router(e));
    }

    _router(e) {
        const t = e.target;

        const toggleBtn = t.closest('.btn-toggle-exam:not(.finished):not([aria-disabled])');
        if (toggleBtn) {
            e.preventDefault(); e.stopPropagation();
            const card = toggleBtn.closest('.exam-card');
            if (card?.dataset.examId) this._toggleStatus(card.dataset.examId, card, toggleBtn);
            return;
        }

        const editBtn = t.closest('.btn-action[data-action="edit"]');
        if (editBtn) {
            e.preventDefault();
            const card = editBtn.closest('.exam-card');
            // F3: Open full edit modal instead of read-only detail
            if (card?.dataset.examId) this._openEditModal(card.dataset.examId);
            return;
        }

        const deleteBtn = t.closest('.btn-action[data-action="delete"]');
        if (deleteBtn) {
            e.preventDefault();
            const card  = deleteBtn.closest('.exam-card');
            const title = card?.querySelector('.exam-title')?.textContent?.trim() || 'Ujian';
            if (card?.dataset.examId) this._deleteExam(card.dataset.examId, title, card);
            return;
        }

        const card = t.closest('.exam-card');
        if (card && !t.closest('.btn-action') && !t.closest('.btn-toggle-exam')) {
            if (card.dataset.examId) this._openDetail(card.dataset.examId);
            return;
        }

        const viewBtn = t.closest('[data-action="view-detail"]');
        if (viewBtn) { e.preventDefault(); this._viewUser(viewBtn.dataset.user); return; }

        const reviewBtn = t.closest('[data-action="review"]');
        if (reviewBtn) { e.preventDefault(); this._reviewCheating(reviewBtn.dataset.user); return; }

        const blockBtn = t.closest('[data-action="block"]');
        if (blockBtn) { e.preventDefault(); this._blockUser(blockBtn.dataset.user, blockBtn.dataset.examId); return; }

        const closeBtn = t.closest('.modal-close, [data-action="close"]');
        if (closeBtn) {
            const modal = closeBtn.closest('.custom-modal');
            if (modal) { e.preventDefault(); this._closeModal(modal); }
            return;
        }

        // F3: save-edit button in the edit modal
        const saveEditBtn = t.closest('[data-action="save-edit"]');
        if (saveEditBtn) {
            e.preventDefault();
            const examId = saveEditBtn.dataset.examId;
            if (examId) this._saveEdit(examId);
            return;
        }
        const overlay = t.closest('.modal-overlay');
        if (overlay) { this._closeModal(overlay.closest('.custom-modal')); }
    }

    // =========================================================
    //  EXAM OPERATIONS
    // =========================================================

    async _toggleStatus(examId, card, btn) {
        if (btn.disabled) return;
        btn.disabled = true;

        const exam = this.controller.getExam(examId);
        if (!exam) {
            this._toast('Data ujian tidak ditemukan', 'error');
            btn.disabled = false;
            return;
        }

        const status      = exam._status;
        const origContent = btn.innerHTML;

        try {
            if (status === 'NOT_STARTED') {
                const duration = parseInt(exam.ujian?.time) || 60;
                const ok = await this._confirm({
                    title:   'Mulai Ujian',
                    message: `Mulai <strong>${this._esc(this._meta(exam).judul || examId)}</strong>?
                              <br><small style="color:var(--gray-500)">Durasi: ${duration} menit</small>`,
                    icon: 'play_arrow',
                });
                if (!ok) { btn.disabled = false; return; }
                btn.innerHTML = `<i class="material-symbols-outlined ms-spin">progress_activity</i> Memulai...`;
                await this.controller.startManualExam(examId, duration);
                this._toast(`Ujian dimulai (${duration} menit)`, 'success');

            } else if (status === 'RUNNING') {
                const ok = await this._confirm({
                    title:   'Hentikan Ujian',
                    message: 'Hentikan sementara ujian yang sedang berjalan?',
                    icon: 'pause',
                });
                if (!ok) { btn.disabled = false; return; }
                btn.innerHTML = `<i class="material-symbols-outlined ms-spin">progress_activity</i> Menghentikan...`;
                const remainingSeconds = await this.controller.pauseExam(examId);
                const remainingMinutes = Math.ceil(remainingSeconds / 60);
                this._toast(`Ujian ditunda. Sisa: ${remainingMinutes} menit`, 'warning');

            } else if (status === 'PAUSED') {
                const ok = await this._confirm({
                    title:   'Lanjutkan Ujian',
                    message: 'Lanjutkan ujian yang ditunda?',
                    icon: 'play_arrow',
                });
                if (!ok) { btn.disabled = false; return; }
                btn.innerHTML = `<i class="material-symbols-outlined ms-spin">progress_activity</i> Melanjutkan...`;
                const remaining = await this.controller.resumeExam(examId);
                this._toast(`Ujian dilanjutkan. Sisa: ${remaining} menit`, 'success');

            } else {
                btn.disabled = false;
                return;
            }
        } catch (err) {
            this._toast(err.message || 'Gagal mengubah status ujian', 'error');
            btn.innerHTML = origContent;
            btn.disabled  = false;
        } finally {
            setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, TOGGLE_RENABLE_MS);
        }
    }

    async _deleteExam(examId, title, card) {
        const ok = await this._holdConfirm({
            title:        'Hapus Ujian',
            message:      `<strong>${this._esc(title)}</strong> akan dihapus permanen beserta seluruh datanya.`,
            holdDuration: 3000,
        });
        if (!ok) return;

        try {
            if (!this._prefersReduced) {
                card.style.transition = 'opacity .22s ease, transform .22s ease';
                card.style.opacity    = '0';
                card.style.transform  = 'scale(.92) translateY(10px)';
            }
            await this.controller.deleteExam(examId, title);
            this._toast(`"${title}" berhasil dihapus`, 'success');
            setTimeout(() => { if (card.isConnected) card.remove(); }, DELETE_ANIMATE_MS);
        } catch (err) {
            card.style.opacity   = '1';
            card.style.transform = '';
            this._toast('Gagal menghapus ujian', 'error');
        }
    }

    // =========================================================
    //  EXAM DETAIL MODAL
    // =========================================================

    // =========================================================
    //  EDIT UJIAN MODAL (Feature 3)
    //  Fully editable modal — separate from _openDetail (read-only).
    // =========================================================

    _openEditModal(examId) {
        const exam = this.controller.getExam(examId);
        if (!exam) { this._toast('Data ujian tidak ditemukan', 'error'); return; }

        const ujian  = this._meta(exam);
        const access = exam.access_control || {};
        const sched  = access.scheduled    || {};

        // Parse durasi — stored as "60 Menit" or raw number
        const durasiRaw = ujian.time || '';
        const durasiNum = parseInt(String(durasiRaw)) || 60;

        // Kelas checkboxes — support single string or array
        const kelasList   = ['7', '8', '9'];
        const selectedKls = Array.isArray(ujian.kelas)
            ? ujian.kelas.map(String)
            : ujian.kelas ? [String(ujian.kelas)] : [];

        const kelasCheckboxes = kelasList.map(k => `
            <label class="edit-checkbox-label">
                <input type="checkbox" name="kelas" value="${k}"
                       ${selectedKls.includes(k) ? 'checked' : ''}
                       aria-label="Kelas ${k}">
                <span>Kelas ${k}</span>
            </label>`).join('');

        // Scheduled fields — only shown when mode = scheduled
        const isScheduled = access.mode === 'scheduled';
        const schedStart  = sched.start ? this._toDatetimeLocal(sched.start) : '';
        const schedEnd    = sched.end   ? this._toDatetimeLocal(sched.end)   : '';

        const html = `
            <div class="modal-header">
                <h3><i class="material-symbols-outlined">edit</i> Edit Ujian</h3>
                <button class="modal-close" aria-label="Tutup">&times;</button>
            </div>
            <div class="modal-body edit-modal-body">
                <div class="edit-field-group">
                    <label class="edit-label" for="editJudul">Judul Ujian <span class="edit-required">*</span></label>
                    <input type="text" id="editJudul" class="edit-input" maxlength="200"
                           value="${this._esc(ujian.judul || '')}"
                           placeholder="Contoh: Ulangan Harian Bab 3"
                           aria-required="true">
                    <div class="edit-error hidden" id="errJudul">Judul tidak boleh kosong</div>
                </div>
                <div class="edit-field-group">
                    <label class="edit-label" for="editMapel">Mata Pelajaran</label>
                    <input type="text" id="editMapel" class="edit-input" maxlength="100"
                           value="${this._esc(ujian.mata_pelajaran || '')}"
                           placeholder="Contoh: Matematika">
                </div>
                <div class="edit-field-row">
                    <div class="edit-field-group">
                        <label class="edit-label" for="editDurasi">Durasi <span class="edit-required">*</span></label>
                        <div class="edit-input-with-unit">
                            <input type="number" id="editDurasi" class="edit-input"
                                   min="1" max="480" value="${durasiNum}"
                                   aria-required="true" aria-label="Durasi dalam menit">
                            <span class="edit-unit">menit</span>
                        </div>
                        <div class="edit-error hidden" id="errDurasi">Durasi harus lebih dari 0</div>
                    </div>
                    <div class="edit-field-group">
                        <label class="edit-label" for="editSkor">Total Poin <span class="edit-required">*</span></label>
                        <input type="number" id="editSkor" class="edit-input"
                               min="1" max="10000" value="${ujian.global_skor ?? 100}"
                               aria-required="true" aria-label="Total poin ujian">
                        <div class="edit-error hidden" id="errSkor">Total poin harus lebih dari 0</div>
                    </div>
                </div>
                <div class="edit-field-group">
                    <label class="edit-label">Kelas yang Dituju <span class="edit-required">*</span></label>
                    <div class="edit-checkboxes" role="group" aria-label="Pilih kelas">
                        ${kelasCheckboxes}
                    </div>
                    <div class="edit-error hidden" id="errKelas">Pilih minimal satu kelas</div>
                </div>
                <div class="edit-field-group">
                    <label class="edit-label" for="editCatatan">Catatan Ujian</label>
                    <textarea id="editCatatan" class="edit-textarea" rows="3"
                              placeholder="Petunjuk pengerjaan, boleh kosong..."
                              maxlength="1000">${this._esc(ujian.is_catatan || '')}</textarea>
                </div>
                <div class="edit-field-group">
                    <label class="edit-label" for="editMode">Mode Akses <span class="edit-required">*</span></label>
                    <select id="editMode" class="edit-select" aria-label="Mode akses ujian">
                        <option value="manual"    ${access.mode !== 'scheduled' ? 'selected' : ''}>Manual (dibuka/tutup manual)</option>
                        <option value="scheduled" ${access.mode === 'scheduled' ? 'selected' : ''}>Otomatis (jadwal waktu)</option>
                    </select>
                </div>
                <div id="editScheduledFields" class="edit-field-row"
                     style="display:${isScheduled ? 'flex' : 'none'}">
                    <div class="edit-field-group">
                        <label class="edit-label" for="editStart">Waktu Mulai <span class="edit-required">*</span></label>
                        <input type="datetime-local" id="editStart" class="edit-input"
                               value="${schedStart}" aria-label="Waktu mulai ujian">
                        <div class="edit-error hidden" id="errStart">Waktu mulai wajib diisi</div>
                    </div>
                    <div class="edit-field-group">
                        <label class="edit-label" for="editEnd">Waktu Selesai <span class="edit-required">*</span></label>
                        <input type="datetime-local" id="editEnd" class="edit-input"
                               value="${schedEnd}" aria-label="Waktu selesai ujian">
                        <div class="edit-error hidden" id="errEnd">Waktu selesai wajib diisi dan setelah waktu mulai</div>
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn-modal btn-modal-secondary" data-action="close">
                    <i class="material-symbols-outlined">close</i> Batal
                </button>
                <button class="btn-modal btn-modal-primary" data-action="save-edit"
                        data-exam-id="${this._esc(examId)}" id="btnSaveEdit"
                        aria-label="Simpan perubahan ujian">
                    <i class="material-symbols-outlined">save</i> Simpan Perubahan
                </button>
            </div>`;

        const modal = this._showModal(html);

        // Show/hide scheduled fields when mode changes
        const modeSelect = modal.querySelector('#editMode');
        const schedFields = modal.querySelector('#editScheduledFields');
        modeSelect?.addEventListener('change', () => {
            schedFields.style.display = modeSelect.value === 'scheduled' ? 'flex' : 'none';
        });
    }

    /**
     * Validate and save edited exam data to Firestore.
     * Called from delegated click handler when [data-action="save-edit"] is clicked.
     */
    async _saveEdit(examId) {
        // Validate inline — no alert(), errors shown below each field
        let isValid = true;

        const _setErr = (id, show) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', !show);
            if (show) isValid = false;
        };

        const judul   = document.getElementById('editJudul')?.value?.trim() || '';
        const mapel   = document.getElementById('editMapel')?.value?.trim() || '';
        const durasi  = parseInt(document.getElementById('editDurasi')?.value) || 0;
        const skor    = parseInt(document.getElementById('editSkor')?.value)   || 0;
        const catatan = document.getElementById('editCatatan')?.value?.trim() || '';
        const mode    = document.getElementById('editMode')?.value || 'manual';
        const start   = document.getElementById('editStart')?.value || '';
        const end     = document.getElementById('editEnd')?.value   || '';

        const kelasCBs   = document.querySelectorAll('input[name="kelas"]:checked');
        const kelasArr   = Array.from(kelasCBs).map(cb => cb.value);

        _setErr('errJudul',  !judul);
        _setErr('errDurasi', durasi < 1);
        _setErr('errSkor',   skor < 1);
        _setErr('errKelas',  kelasArr.length === 0);

        if (mode === 'scheduled') {
            _setErr('errStart', !start);
            if (start && end) {
                _setErr('errEnd', new Date(end) <= new Date(start));
            } else {
                _setErr('errEnd', !end);
            }
        }

        if (!isValid) return;

        const btn = document.getElementById('btnSaveEdit');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="material-symbols-outlined ms-spin">progress_activity</i> Menyimpan...'; }

        try {
            const db = window.firebaseDb;
            if (!db) throw new Error('Firebase tidak tersedia');

            // Build update payload — only defined fields
            const updateData = {
                judul:                  judul,
                mata_pelajaran:         mapel,
                kelas:                  kelasArr,
                'ujian.judul':          judul,
                'ujian.mata_pelajaran': mapel,
                'ujian.time':           `${durasi} Menit`,
                'ujian.kelas':          kelasArr,
                'ujian.catatan':        catatan ? 'On' : 'Off',
                'ujian.is_catatan':     catatan,
                'ujian.global_skor':    skor,
                'access_control.mode':  mode,
            };

            if (mode === 'scheduled') {
                updateData['access_control.scheduled.start']  = new Date(start).toISOString();
                updateData['access_control.scheduled.end']    = new Date(end).toISOString();
                updateData['access_control.scheduled.active'] = true;
            }

            await db.collection('ujian').doc(examId).update(updateData);

            // Close modal and notify — Firestore snapshot will refresh the card automatically
            document.querySelector('.custom-modal')?.remove();
            this._toast('Ujian berhasil diperbarui', 'success');

        } catch (err) {
            console.warn('[EditUjian] Gagal simpan:', err.message);
            this._toast('Gagal menyimpan: ' + err.message, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="material-symbols-outlined">save</i> Simpan Perubahan'; }
        }
    }

    /**
     * Convert an ISO date string or timestamp to datetime-local input format.
     * datetime-local expects "YYYY-MM-DDTHH:MM" without seconds or timezone.
     */
    _toDatetimeLocal(dateStr) {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return '';
            // Format: YYYY-MM-DDTHH:MM (local time, no timezone suffix)
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (_) {
            return '';
        }
    }

    _openDetail(examId) {
        const exam = this.controller.getExam(examId);
        if (!exam) { this._toast('Data tidak ditemukan', 'error'); return; }

        const ujian  = this._meta(exam);
        const access = exam.access_control || {};
        const soal   = exam.PQ             || {};
        const status = exam._status        || 'NOT_STARTED';
        const sched  = access.scheduled    || {};

        const STATUS_LABEL = {
            NOT_STARTED: 'Belum Mulai',
            RUNNING:     'Sedang Berjalan',
            PAUSED:      'Ditunda',
            FINISHED:    'Selesai',
        };

        // _countQuestions sums questions across all pages sections — same fix as _buildCard
        const jumlahSoal   = this._countQuestions(soal);
        const kelasDisplay = (ujian.kelas || []).map(k => `Kelas ${k}`).join(', ') || '-';
        const modeDisplay  = access.mode === 'manual' ? 'Manual' : 'Otomatis';
        const schedDisplay = sched.active
            ? `${this._fmtDate(sched.start)} — ${this._fmtDate(sched.end)}`
            : 'Tidak dijadwalkan';

        // Flatten all questions from all pages sections for preview
        // PQ structure: { pages1: {identitas}, pages2: {type_question, questions:[...]}, ... }
        const allQuestions = this._flattenQuestions(soal);
        const previewSlice = allQuestions.slice(0, 5);
        const soalPreview = jumlahSoal === 0
            ? `<p style="font-size:12px;color:var(--gray-400);margin:0">Tidak ada soal</p>`
            : previewSlice.map((q, i) => {
                const teks = (q.pertanyaan || q.soal || `Soal ${i+1}`).slice(0, 70);
                const full = (q.pertanyaan || q.soal || '');
                return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--gray-100)">
                    <span style="font-size:11px;font-weight:700;color:var(--primary);min-width:18px">${i+1}.</span>
                    <span style="font-size:11px;color:var(--gray-600);line-height:1.5">${this._esc(teks)}${full.length > 70 ? '…' : ''}</span>
                </div>`;
              }).join('')
              + (jumlahSoal > 5 ? `<p style="font-size:11px;color:var(--gray-400);margin:6px 0 0">+${jumlahSoal-5} soal lainnya</p>` : '');

        const html = `
            <div class="modal-header">
                <h3><i class="material-symbols-outlined">menu_book</i> Detail Ujian</h3>
                <button class="modal-close" aria-label="Tutup">&times;</button>
            </div>
            <div class="modal-body">
                <p class="detail-section-title">Informasi Dasar</p>
                <div class="detail-row">
                    <span class="detail-label">ID Ujian</span>
                    <span class="detail-value">
                        <code style="background:var(--primary-glass);padding:2px 7px;border-radius:5px;font-size:11px;font-family:monospace">${this._esc(examId)}</code>
                    </span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Judul</span>
                    <span class="detail-value">${this._esc(ujian.judul || '-')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Mata Pelajaran</span>
                    <span class="detail-value">${this._esc(ujian.mata_pelajaran || '-')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Kelas</span>
                    <span class="detail-value">${this._esc(kelasDisplay)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Tipe Ujian</span>
                    <span class="detail-value">${this._esc(ujian.tipe || '-')}</span>
                </div>
                ${ujian.tingkat ? `
                <div class="detail-row">
                    <span class="detail-label">Tingkat</span>
                    <span class="detail-value">${this._esc(ujian.tingkat)}</span>
                </div>` : ''}
                <p class="detail-section-title">Pengaturan</p>
                <div class="detail-row">
                    <span class="detail-label">Durasi</span>
                    <span class="detail-value"><i style="color:var(--primary)" class="material-symbols-outlined">schedule</i>&nbsp;${this._esc(String(ujian.time || '-'))}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Total Poin</span>
                    <span class="detail-value"><i style="color:var(--warning)" class="material-symbols-outlined">star</i>&nbsp;${ujian.global_skor ?? '-'} poin</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Mode Akses</span>
                    <span class="detail-value">
                        <span class="exam-mode ${access.mode === 'manual' ? 'manual' : 'auto'}">
                            <i class="material-symbols-outlined">${access.mode === 'manual' ? 'person_edit' : 'smart_toy'}</i> ${modeDisplay}
                        </span>
                    </span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Jadwal</span>
                    <span class="detail-value" style="font-size:11px">${schedDisplay}</span>
                </div>
                <p class="detail-section-title">Status</p>
                <div class="detail-row">
                    <span class="detail-label">Status Saat Ini</span>
                    <span class="detail-value">
                        <span class="exam-status">
                            <span class="status-dot ${status === 'RUNNING' ? 'active' : status === 'PAUSED' ? 'paused' : status === 'FINISHED' ? 'finished' : 'inactive'}"></span>
                            ${STATUS_LABEL[status] || status}
                        </span>
                    </span>
                </div>
                ${access.end ? `
                <div class="detail-row">
                    <span class="detail-label">Berakhir</span>
                    <span class="detail-value" style="font-size:11px">${this._fmtDate(access.end)}</span>
                </div>` : ''}
                ${access.remaining_time != null ? `
                <div class="detail-row">
                    <span class="detail-label">Sisa Waktu Tersimpan</span>
                    <span class="detail-value">${Math.ceil(access.remaining_time / 60)} menit</span>
                </div>` : ''}
                <p class="detail-section-title">Soal (${jumlahSoal} soal)</p>
                <div style="background:var(--gray-50);border-radius:var(--radius-md);padding:10px 13px;border:1px solid var(--gray-200)">
                    ${soalPreview}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn-modal btn-modal-secondary" data-action="close">Tutup</button>
                ${status !== 'FINISHED' ? `
                <button class="btn-modal btn-modal-primary" data-action="monitor" data-exam-id="${this._esc(examId)}">
                    <i class="material-symbols-outlined">settings_input_antenna</i> Pantau Ujian
                </button>` : ''}
            </div>`;

        this._showModal(html);
    }

    // =========================================================
    //  NOTIFICATION SECTIONS
    // =========================================================

    _renderCompletedUsers(exams) {
        const list    = document.getElementById('completed-users-list');
        const empty   = document.getElementById('no-completed-users');
        const counter = document.getElementById('completed-count');
        if (!list) return;

        const users = [];
        exams.forEach(exam => {
            const results = exam.hasil_peserta || exam.user_results || {};
            if (typeof results !== 'object') return;
            Object.entries(results).forEach(([name, data]) => {
                if (!data || typeof data !== 'object') return;
                users.push({
                    name,
                    examTitle: this._meta(exam).judul || exam.id,
                    skor:  data.skor      ?? data.score    ?? '-',
                    waktu: data.selesai_at || data.submitted_at || null,
                });
            });
        });

        if (counter) counter.textContent = users.length;
        list.innerHTML = '';

        if (users.length === 0) {
            empty?.classList.add('show');
            return;
        }
        empty?.classList.remove('show');

        const frag = document.createDocumentFragment();
        users.forEach(({ name, examTitle, skor, waktu }) => {
            const item = document.createElement('div');
            item.className = 'notification-item';
            item.setAttribute('role', 'listitem');
            item.innerHTML = `
                <div class="notification-icon success" aria-hidden="true"><i class="material-symbols-outlined">check</i></div>
                <div class="notification-content">
                    <h4>${this._esc(name)}</h4>
                    <p>${this._esc(examTitle)}</p>
                    <div class="notification-meta">
                        <span><i aria-hidden="true" class="material-symbols-outlined">star</i> ${this._esc(String(skor))} poin</span>
                        ${waktu ? `<span><i aria-hidden="true" class="material-symbols-outlined">schedule</i> ${this._timeAgo(waktu)}</span>` : ''}
                    </div>
                </div>
                <div class="notification-actions">
                    <button class="btn-action" data-action="view-detail" data-user="${this._esc(name)}"
                            title="Lihat detail" aria-label="Lihat detail ${this._esc(name)}">
                        <i aria-hidden="true" class="material-symbols-outlined">visibility</i>
                    </button>
                </div>`;
            frag.appendChild(item);
        });
        list.appendChild(frag);
    }

    _renderCheatingUsers(exams) {
        const list    = document.getElementById('cheating-users-list');
        const empty   = document.getElementById('no-cheating-users');
        const counter = document.getElementById('cheating-count');
        if (!list) return;

        const cheaters = [];
        exams.forEach(exam => {
            const viol = exam.violations || exam.kecurangan || {};
            if (typeof viol !== 'object') return;
            Object.entries(viol).forEach(([name, data]) => {
                if (!data || typeof data !== 'object') return;
                cheaters.push({
                    name,
                    examId:    exam.id,
                    examTitle: this._meta(exam).judul || exam.id,
                    level:     data.severity || data.level  || 'medium',
                    count:     data.count    || data.jumlah || 1,
                    isBlocked: !!data.blocked,
                    blockedBy: data.blockedBy || null,
                });
            });
        });

        if (counter) counter.textContent = cheaters.length;
        list.innerHTML = '';

        if (cheaters.length === 0) {
            empty?.classList.add('show');
            return;
        }
        empty?.classList.remove('show');

        const frag = document.createDocumentFragment();
        cheaters.forEach(({ name, examId, examTitle, level, count, isBlocked, blockedBy }) => {
            const isHigh   = level === 'high';
            const levLabel = isHigh ? 'Risiko Tinggi' : 'Risiko Sedang';
            const levClass = isHigh ? 'high' : 'medium';

            const blockBtnHTML = isBlocked
                ? `<button class="btn-action danger blocked" data-action="block"
                           data-user="${this._esc(name)}" data-exam-id="${this._esc(examId)}"
                           disabled title="Sudah diblokir${blockedBy ? ' oleh ' + this._esc(blockedBy) : ''}"
                           aria-label="Sudah diblokir — ${this._esc(name)}" aria-disabled="true">
                       <i aria-hidden="true" class="material-symbols-outlined">lock</i>
                   </button>`
                : `<button class="btn-action danger" data-action="block"
                           data-user="${this._esc(name)}" data-exam-id="${this._esc(examId)}"
                           title="Blokir ${this._esc(name)}" aria-label="Blokir akses ujian untuk ${this._esc(name)}">
                       <i aria-hidden="true" class="material-symbols-outlined">block</i>
                   </button>`;

            const item = document.createElement('div');
            item.className = 'notification-item warning';
            item.setAttribute('role', 'listitem');
            item.innerHTML = `
                <div class="notification-icon warning" aria-hidden="true">
                    <i class="material-symbols-outlined">warning</i>
                </div>
                <div class="notification-content">
                    <h4>${this._esc(name)}${isBlocked ? ' <span class="blocked-badge">Diblokir</span>' : ''}</h4>
                    <p>${this._esc(examTitle)}</p>
                    <div class="notification-meta">
                        <span class="severity ${levClass}">
                            <i aria-hidden="true" class="material-symbols-outlined">flag</i> ${levLabel}
                        </span>
                        <span><i aria-hidden="true" class="material-symbols-outlined">refresh</i> ${count}× pelanggaran</span>
                    </div>
                </div>
                <div class="notification-actions">
                    <button class="btn-action" data-action="review" data-user="${this._esc(name)}"
                            title="Tinjau kasus" aria-label="Tinjau kecurangan ${this._esc(name)}">
                        <i aria-hidden="true" class="material-symbols-outlined">search</i>
                    </button>
                    ${blockBtnHTML}
                </div>`;
            frag.appendChild(item);
        });
        list.appendChild(frag);
    }

    // =========================================================
    //  NOTIFICATION QUICK ACTIONS
    // =========================================================

    _viewUser(name) {
        this._toast(`Membuka detail: ${name}`, 'info');
    }

    _reviewCheating(name) {
        this._toast(`Meninjau kasus: ${name}`, 'warning');
    }

    // Block a user via Firestore dot-notation update.
    // WHY dot-notation: update({ 'violations.Ali.blocked': true }) touches only that
    // sub-field. A plain object update would wipe all other users' violation data.
    async _blockUser(name, examId) {
        if (!examId) {
            this._toast('Data ujian tidak ditemukan — coba refresh halaman.', 'error');
            return;
        }

        const confirmed = await this._confirm({
            title:   'Blokir Akses Ujian',
            message: `<strong>${this._esc(name)}</strong> tidak akan bisa masuk atau melanjutkan ujian ini.`,
            icon:    'block',
        });
        if (!confirmed) return;

        // Grab button ref before the first await — onSnapshot might replace the DOM element
        const triggerBtn = document.querySelector(
            `[data-action="block"][data-exam-id="${CSS.escape(examId)}"][data-user="${CSS.escape(name)}"]`
        );

        if (triggerBtn) {
            triggerBtn.disabled  = true;
            triggerBtn.innerHTML = '<i aria-hidden="true" class="material-symbols-outlined ms-spin">progress_activity</i>';
            triggerBtn.setAttribute('aria-label', 'Memproses...');
        }

        const BLOCK_TIMEOUT_MS = 10_000;

        const writeToFirestore = () => {
            const db = window.firebaseDb;
            if (!db) return Promise.reject(new Error('Firestore tidak tersedia'));
            return db.collection('ujian').doc(examId).update({
                [`violations.${name}.blocked`]:   true,
                [`violations.${name}.blockedAt`]: new Date().toISOString(),
                [`violations.${name}.blockedBy`]: window.Auth?.currentUser?.email || 'admin',
            });
        };

        try {
            await Promise.race([
                writeToFirestore(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), BLOCK_TIMEOUT_MS)
                ),
            ]);
            this._toast(`${name} berhasil diblokir`, 'success');
        } catch (err) {
            this._toast(
                err.message === 'timeout'
                    ? 'Koneksi lambat — coba lagi dalam beberapa saat.'
                    : 'Gagal memblokir. Periksa koneksi dan coba lagi.',
                'error'
            );

            const retryBtn = triggerBtn?.isConnected
                ? triggerBtn
                : document.querySelector(
                    `[data-action="block"][data-exam-id="${CSS.escape(examId)}"][data-user="${CSS.escape(name)}"]`
                  );

            if (retryBtn) {
                retryBtn.disabled  = false;
                retryBtn.innerHTML = '<i aria-hidden="true" class="material-symbols-outlined">block</i>';
                retryBtn.setAttribute('aria-label', `Blokir akses ujian untuk ${name}`);
            }
        }
    }

    // =========================================================
    //  MODAL
    // =========================================================

    _showModal(html) {
        document.querySelector('.custom-modal')?.remove();

        const modal = document.createElement('div');
        modal.className = 'custom-modal';
        modal.innerHTML = `<div class="modal-overlay" aria-hidden="true"></div>
                           <div class="modal-dialog" role="dialog" aria-modal="true">${html}</div>`;
        document.body.appendChild(modal);

        const escFn = e => {
            if (e.key === 'Escape') { this._closeModal(modal); document.removeEventListener('keydown', escFn); }
        };
        document.addEventListener('keydown', escFn);

        requestAnimationFrame(() => {
            modal.classList.add('show');
            modal.querySelector('.modal-close')?.focus();

            // F4+F5: Render math expressions and apply RTL/Arab classes in modal content.
            // Must run AFTER content is in DOM (inside rAF).
            const dialog = modal.querySelector('.modal-dialog');
            if (typeof window.renderMathIn  === 'function') window.renderMathIn(dialog);
            if (typeof window.applyLangClass === 'function') window.applyLangClass(dialog);

            // F6: Attach smart paste to any editable fields inside modal (edit modal).
            if (typeof window.MathPasteConverter !== 'undefined') {
                window.MathPasteConverter.attachToAll('textarea', dialog);
                window.MathPasteConverter.attachToAll('input[type="text"]', dialog);
            }
        });

        return modal;
    }

    _closeModal(modal) {
        if (!modal) return;
        modal.classList.remove('show');
        setTimeout(() => { if (modal.isConnected) modal.remove(); }, MODAL_REMOVE_MS);
    }

    // =========================================================
    //  CONFIRM HELPERS
    // =========================================================

    _confirm(opts) {
        return new Promise(resolve =>
            window.notify.confirm({
                ...opts,
                onYes:   () => resolve(true),
                onNo:    () => resolve(false),
                onClose: () => resolve(false),
            })
        );
    }

    _holdConfirm(opts) {
        return new Promise((resolve, reject) =>
            window.notify.holdConfirmAsync({
                ...opts,
                onAsyncConfirm: async () => { try { resolve(true); } catch(e) { reject(e); } },
                onCancel: () => resolve(false),
            })
        );
    }

    // =========================================================
    //  TOAST — best-effort, never throws
    // =========================================================

    _toast(msg, type = 'info') {
        try {
            const qn = window.QNotify || window.notify;
            if (qn?.notify?.[type])       qn.notify[type]('', msg, 3800);
            else if (window.notify?.[type]) window.notify[type]('', msg, 3800);
        } catch (_) { /* QNotify not ready — fail silently */ }
    }

    // =========================================================
    //  ERROR STATE
    // =========================================================

    _showInitError(msg) {
        const grid = document.getElementById('exams-grid');
        if (!grid) return;
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:50px 20px">
                <div style="width:72px;height:72px;background:var(--danger-glass);border-radius:50%;
                            display:flex;align-items:center;justify-content:center;margin:0 auto 18px">
                    <i style="font-size:28px;color:var(--danger)" class="material-symbols-outlined">warning</i>
                </div>
                <h3 style="color:var(--blue-dark);font-size:20px;margin-bottom:8px">Gagal Memuat</h3>
                <p style="color:var(--gray-500);font-size:13px;margin-bottom:20px;max-width:320px;
                           margin-inline:auto;line-height:1.6">${this._esc(msg)}</p>
                <button onclick="location.reload()"
                        style="padding:9px 22px;background:linear-gradient(135deg,var(--primary),var(--primary-light));
                               color:white;border:none;border-radius:var(--radius-md);cursor:pointer;
                               font-size:13px;font-weight:600;font-family:'Poppins',sans-serif;
                               box-shadow:var(--shadow-blue)">
                    <i class="material-symbols-outlined">refresh</i> Muat Ulang
                </button>
            </div>`;
    }

    // =========================================================
    //  UTILITIES
    // =========================================================

    _setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    _meta(exam) {
        return window.ExamRecordCompat?.getMeta(exam) || exam?.ujian || {};
    }

    // =========================================================
    //  PQ QUESTION HELPERS
    //  WHY these exist: exam.PQ is NOT a flat list of questions.
    //  It's a map of page-slots: pages1 = identity, pages2+ = question sections.
    //  Each section has a `questions` array inside it.
    //  Object.keys(PQ).length counts PAGES (e.g. 2), not QUESTIONS (e.g. 3).
    //  These helpers traverse the real structure to get accurate counts.
    // =========================================================

    // Returns the total number of questions across all section pages.
    _countQuestions(PQ) {
        if (!PQ || typeof PQ !== 'object') return 0;
        let total = 0;
        Object.values(PQ).forEach(page => {
            // Only pages with a questions array are actual question sections
            if (page && Array.isArray(page.questions)) {
                total += page.questions.length;
            }
        });
        return total;
    }

    // Returns a flat array of all question objects across all sections.
    // Used for soal preview in the detail modal.
    _flattenQuestions(PQ) {
        if (!PQ || typeof PQ !== 'object') return [];
        const all = [];
        // Sort by key so pages2 comes before pages3, etc.
        const sortedKeys = Object.keys(PQ).sort();
        sortedKeys.forEach(key => {
            const page = PQ[key];
            if (page && Array.isArray(page.questions)) {
                page.questions.forEach(q => all.push(q));
            }
        });
        return all;
    }

    _esc(str) {
        return String(str ?? '')
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;')
            .replace(/'/g,'&#39;');
    }

    _fmtDate(iso) {
        if (!iso) return '-';
        try {
            return new Date(iso).toLocaleString('id-ID', {
                day:'2-digit', month:'short', year:'numeric',
                hour:'2-digit', minute:'2-digit',
            });
        } catch(_) { return String(iso); }
    }

    _timeAgo(iso) {
        if (!iso) return '';
        try {
            const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
            if (m < 1)  return 'baru saja';
            if (m < 60) return `${m} mnt lalu`;
            const h = Math.floor(m / 60);
            if (h < 24) return `${h} jam lalu`;
            return `${Math.floor(h / 24)} hari lalu`;
        } catch(_) { return ''; }
    }

    // =========================================================
    //  CLEANUP
    // =========================================================

    destroy() {
        this.controller.destroy();
        clearTimeout(this.searchDebounce);
        this.isInitialized = false;
    }

    debugStatus() {
        return {
            initialized:  this.isInitialized,
            // v2.0.0: currentClass removed (class filter dihapus)
            total:        this._allExams.length,
            filtered:     this._forClass(this._allExams).length,
            supabaseReady: window.__firebaseReady ?? false,
            stats: {
                running:  this._allExams.filter(e => e._status === 'RUNNING').length,
                paused:   this._allExams.filter(e => e._status === 'PAUSED').length,
                finished: this._allExams.filter(e => e._status === 'FINISHED').length,
            },
        };
    }
}

// =============================================================
//  Bootstrap
// =============================================================
document.addEventListener('DOMContentLoaded', () => {
    window.ujianPesertaManager = new UjianPesertaManager();
    window.addEventListener('beforeunload', () => window.ujianPesertaManager?.destroy());
});

window.debugUjianPeserta = () => window.ujianPesertaManager?.debugStatus();