/**
 * WizardController — AlbEdu v0.4.1
 *
 * Orchestrates state, DOM, validation, save system, DOCX import.
 *
 * Changes v0.4.1:
 *   - BUG FIX: "No" on restore dialog now truly discards (uses state.discardDraft)
 *   - BUG FIX: Restore now fires re-validation so progress bar is never stale
 *   - BUG FIX: Validation state syncs with form state via wizard:state-restored event
 *   - Soft validation: user can freely navigate between steps
 *   - Background progress bar refresh after every mutation
 *   - Step 4 is now "Publish" with reviewer panel + lock system
 *   - DOCX import: parses AlbEdu standard template format
 *   - Save system now uses WizardState draft API (no manual localStorage calls)
 */
const WizardController = (() => {
    let instance    = null;
    let initialized = false;

    class WizardController {
        constructor() {
            if (instance) return instance;
            instance = this;
            this.state      = WizardState;
            this.dom        = WizardDOM;
            this.validation = WizardValidation;

            // F5 fix: wire ErrorManager (was previously undefined → applyErrors silently no-op'd via ?.)
            // ErrorManager is a top-level const in error-manager.js (classic script, shares lexical scope)
            // Guard with typeof check for safety in case error-manager.js fails to load
            this.errorManager = (typeof ErrorManager !== 'undefined') ? ErrorManager : null;

            this.history      = [];
            this.historyIndex = -1;
            this.maxHistory   = 50;

            this.debounceTimers    = {};
            this.isConfirming      = false;
        }

        static getInstance() {
            if (!instance) instance = new WizardController();
            return instance;
        }

        init() {
            if (initialized) return;
            this.dom.initializeElements();
            this.dom.initializeDropdowns();
            this.setupEvents();
            this.setupDraftListeners();
            initialized = true;
        }

        // ── Save draft event listeners ───────────────────────────────────────
        setupDraftListeners() {
            window.addEventListener('wizard:draft-saved', (e) => {
                this.dom.showSaveDraftIndicator(e.detail?.savedAt);
            });

            // BUG FIX: When state is restored, trigger a full UI + validation refresh
            window.addEventListener('wizard:state-restored', () => {
                this.refreshUI();
                this.populateStep1FromState();
            });
        }

        // ── History ──────────────────────────────────────────────────────────
        // W8 fix: skip pushing identical snapshots. Old code called getState()
        // (deepClone) + pushed unconditionally on every debounced keystroke (300ms).
        // For 100-question state, this was ~50KB JSON parse/stringify per snapshot,
        // plus memory bloat from 50 redundant identical entries. Now we use
        // getStateRef() (no clone) for the dedupe check, and only deepClone when
        // the snapshot is actually different.
        pushHistory() {
            const currRef = this.state.getStateRef?.() ?? this.state.getState();
            // Dedupe: if last snapshot equals current state, skip
            const lastSnapshot = this.history[this.historyIndex];
            if (lastSnapshot && this._snapshotEquals(lastSnapshot, currRef)) return;
            // Only deepClone when actually pushing (state has genuinely changed)
            const curr = this.state.getState();
            if (this.historyIndex < this.history.length - 1)
                this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(curr);
            if (this.history.length > this.maxHistory) this.history.shift();
            this.historyIndex = this.history.length - 1;
        }
        // W8 helper: lightweight snapshot equality check.
        // Uses quickHash on both — O(n) each, but avoids deepClone when equal.
        _snapshotEquals(a, b) {
            try {
                return JSON.stringify(a) === JSON.stringify(b);
            } catch (_) { return false; }
        }

        undo() {
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.state.setState(this.history[this.historyIndex]);
                this.refreshUI();
                if (window.notify) window.notify.info('Undo', 'Kembali ke keadaan sebelumnya', 1500);
            }
        }

        redo() {
            if (this.historyIndex < this.history.length - 1) {
                this.historyIndex++;
                this.state.setState(this.history[this.historyIndex]);
                this.refreshUI();
                if (window.notify) window.notify.info('Redo', 'Maju ke keadaan berikutnya', 1500);
            }
        }

        // NOTE: autoSave() is now gone — WizardState handles all saves internally
        // via scheduleSave() / triggerAutoSave(). Controllers call state mutators
        // directly; saves happen automatically after every mutation.

        // ── Open / Close wizard ──────────────────────────────────────────────
        openWizard() {
            if (this.isConfirming) return;

            const envelope = this.state.loadDraft();
            if (!envelope) {
                this.resetAndOpenWizard();
                return;
            }

            this.isConfirming = true;

            let lastSavedInfo = '';
            try {
                if (envelope.savedAt) {
                    const d = new Date(envelope.savedAt);
                    lastSavedInfo = ` (terakhir: ${d.toLocaleDateString()} ${d.toLocaleTimeString()})`;
                }
            } catch (_) {}

            const confirmRestore = () => {
                this.isConfirming = false;
                try {
                    // applyDraft validates + migrates before applying
                    this.state.applyDraft(envelope);

                    this.pushHistory();
                    document.body.style.overflow = 'hidden';
                    this.dom.showModal();

                    // Refresh UI THEN populate form — order matters
                    this.refreshUI();
                    this.populateStep1FromState();

                    if (window.notify)
                        window.notify.success('Dipulihkan', `Draft ujian dipulihkan${lastSavedInfo}`, 3000);
                } catch (e) {
                    console.error('[WizardController] Restore failed:', e);
                    // Quarantine the corrupt draft and start fresh
                    this.state.discardDraft();
                    this.resetAndOpenWizard();
                    if (window.notify)
                        window.notify.error('Gagal', 'Draft rusak, memulai baru', 3000);
                }
            };

            /**
             * BUG FIX: "No" now calls discardDraft() which:
             *   1. Removes from localStorage
             *   2. Resets internal state to initial
             *   3. Clears dirty flags
             * Old code only did (1), leaving stale state in memory.
             */
            const rejectRestore = () => {
                this.isConfirming = false;
                this.state.discardDraft();   // full clear — no stale state
                this.resetAndOpenWizard();
                if (window.notify)
                    window.notify.info('Dihapus', 'Memulai ujian baru', 2000);
            };

            if (window.notify?.confirm) {
                window.notify.confirm({
                    message: `Data ujian sebelumnya ditemukan${lastSavedInfo}. Lanjutkan?`,
                    icon:    'help',
                    onYes:   confirmRestore,
                    onNo:    rejectRestore
                });
            } else {
                // QNotify not ready yet — retry once it is
                const retry = () => {
                    if (window.notify?.confirm) {
                        window.notify.confirm({
                            message: `Data ujian sebelumnya ditemukan${lastSavedInfo}. Lanjutkan?`,
                            icon:    'help',
                            onYes:   confirmRestore,
                            onNo:    rejectRestore
                        });
                    } else {
                        confirmRestore(); // absolute last resort
                    }
                };
                window.addEventListener('qnotify-ready', retry, { once: true });
            }
        }

        resetAndOpenWizard() {
            this.isConfirming = false;
            this.state.resetState();
            this.history      = [];
            this.historyIndex = -1;
            this._fullDOMClean();
            this.pushHistory();
            document.body.style.overflow = 'hidden';
            this.dom.showModal();
            this.state.setCurrentStep(1);
            this.refreshUI();
            // v0.5.0: pre-load daftar options in background for Metode Nama dropdown
            this._loadDaftarOptions();

            // v2.0.0 — default identity_mode='manual' → auto-mount IdentityFormBuilder
            // WHY: tanpa ini, peserta harus klik tab "Manual" dulu baru form builder muncul.
            // Default state sudah manual, jadi langsung mount di sini.
            // Use setTimeout to ensure DOM is ready (modal animation in progress).
            setTimeout(() => {
                try {
                    const mode = this.state.getExamData().ujian.identity_mode || 'manual';
                    this._applyMetodeTabUI(mode);
                    if (mode === 'manual') {
                        this._mountFormBuilder();
                    }
                } catch (err) {
                    console.warn('[wizard] auto-mount form builder failed:', err);
                }
            }, 100);
        }

        closeWizard() {
            document.body.style.overflow = '';
            this.dom.hideModal();
            this._fullDOMClean();
        }

        // ── Full DOM clean ───────────────────────────────────────────────────
        /**
         * Hard-resets every piece of wizard DOM back to blank state.
         * Called on closeWizard() AND resetAndOpenWizard() so there is
         * never any ghost data from a previous session visible in the UI.
         */
        _fullDOMClean() {
            // 1. All text inputs + textareas
            document.querySelectorAll('.wizard-wrapper input[type="text"], .wizard-wrapper input[type="number"], .wizard-wrapper textarea')
                .forEach(el => { el.value = ''; el.classList.remove('has-error', 'disabled-field'); });

            // 2. All checkboxes (catatan toggle etc)
            document.querySelectorAll('.wizard-wrapper input[type="checkbox"]')
                .forEach(el => { el.checked = false; });

            // 3. Dropdowns — reset via instance API (restores placeholder text)
            this.dom.resetAllDropdowns();

            // 4. Validation errors
            this.dom.hideAllValidationErrors();

            // 5. Catatan + Scheduled containers — hide
            this.dom.toggleCatatanContainer(false);
            this.dom.toggleScheduledContainer(false);

            // 6. Sections container — wipe rendered section tabs + content
            const sectionsContainer = document.getElementById('sectionsContainer');
            if (sectionsContainer) sectionsContainer.innerHTML = '';
            const sectionsTabs = document.getElementById('sectionsTabs');
            if (sectionsTabs) sectionsTabs.innerHTML = '';
            const noSections = document.getElementById('noSectionsState');
            if (noSections) noSections.style.display = '';

            // 7. Publish reviewer panel
            const reviewer = document.getElementById('publishReviewer');
            if (reviewer) reviewer.innerHTML = '';

            // 8. Save draft indicator — hide
            const indicator = document.getElementById('saveDraftIndicator');
            if (indicator) { indicator.classList.remove('visible'); }

            // 9. Nav buttons — restore to default state
            const nextBtn = document.querySelector('#nextBtn');
            const prevBtn = document.querySelector('#prevBtn');
            if (nextBtn) {
                nextBtn.innerHTML = 'Selanjutnya <i class="material-symbols-outlined">arrow_forward</i>';
                nextBtn.disabled  = false;
                nextBtn.classList.remove('publish-ready', 'publish-locked');
            }
            if (prevBtn) {
                prevBtn.innerHTML = '<i class="material-symbols-outlined">arrow_back</i> Sebelumnya';
                prevBtn.disabled  = true;
            }

            // 10. Progress bar — reset to blank (no statuses from previous run)
            const progressEl = document.getElementById('wizardProgress');
            if (progressEl) progressEl.innerHTML = '';

            // 11. Debounce timers — cancel any pending saves/validations
            Object.keys(this.debounceTimers).forEach(k => {
                clearTimeout(this.debounceTimers[k]);
                delete this.debounceTimers[k];
            });

            // 12. Re-init dropdowns so new session gets fresh instances
            this.dom.initializeDropdowns();
        }

        // ── Refresh UI ───────────────────────────────────────────────────────
        refreshUI() {
            const state       = this.state.getState();
            const currentStep = state.currentStep;

            this.dom.updateProgressBar(currentStep, 4, state.stepCompleted);
            this.dom.showStep(currentStep);

            // Step 4 = Publish — navigation buttons depend on reviewr result
            if (currentStep === 4) {
                const examData   = this.state.getExamData();
                let code         = examData.ujian.kode_id;
                if (!code) code  = this.state.generateCode();
                const canPublish = this.dom.updatePublishReviewer(this.state.exportExamData());
                this.dom.updateNavigationButtons(currentStep, 4, canPublish);
            } else {
                this.dom.updateNavigationButtons(currentStep, 4);
            }

            this.dom.hideAllValidationErrors();

            if (currentStep === 3) {
                this.dom.updateSectionsUI(state.sections, state.currentSectionIndex);
            }

            // Scheduled inputs visibility
            const mode = state.examData.ujian.mode_pembuka;
            this.dom.toggleScheduledContainer(mode === 'Otomatis');

            if (currentStep === 1) {
                const waktuInput = document.querySelector('[data-field="waktuUjian"]');
                if (waktuInput) {
                    waktuInput.disabled = (mode === 'Otomatis');
                    waktuInput.classList.toggle('disabled-field', mode === 'Otomatis');
                }
            }
        }

        // ── Navigation ───────────────────────────────────────────────────────
        /**
         * Soft navigation: user can move anywhere freely.
         * No hard-blocking on next — validation lives in step 4 reviewer.
         * Exception: on forward navigation, we just allow it. Period.
         */
        navigateToStep(step) {
            if (step < 1 || step > 4) return;
            this.pushHistory();
            this.state.setCurrentStep(step);
            this.refreshUI();
            // Trigger background progress refresh after settling
            this.dom.scheduleProgressRefresh(step, 4, this.state.getState().stepCompleted);
        }

        handleNext() {
            const current = this.state.getCurrentStep();
            if (current === 4) {
                this.publishExam();
            } else {
                this.navigateToStep(current + 1);
            }
        }

        // ── Setup events ─────────────────────────────────────────────────────
        setupEvents() {
            this.dom.setupEventDelegation({
                prevStep:         () => this.navigateToStep(this.state.getCurrentStep() - 1),
                nextStep:         () => this.handleNext(),
                switchSection:    (idx) => this.switchSection(parseInt(idx)),
                addSection:       () => this.addSection(),
                removeSection:    (idx) => this.removeSection(parseInt(idx)),
                addQuestion:      (sIdx) => this.addQuestion(parseInt(sIdx)),
                deleteQuestion:   (qIdx, el) => this.deleteQuestion(parseInt(qIdx), el),
                moveQuestionUp:   (qIdx, el) => this.moveQuestion(parseInt(qIdx), 'up', el),
                moveQuestionDown: (qIdx, el) => this.moveQuestion(parseInt(qIdx), 'down', el),
                regenerateCode:   () => this.regenerateCode(),
                copyCode:         () => this.copyCode(),
                inputChange:      (field, value, sIdx, qIdx) => this.handleInput(field, value, sIdx, qIdx),
                dropdownChange:   (type, value, index, sIdx, qIdx) => this.handleDropdown(type, value, index, sIdx, qIdx),
                toggleVideo:      (sIdx, qIdx, checked) => this.toggleVideo(parseInt(sIdx), parseInt(qIdx), checked),
                updateVideoUrl:   (url, sIdx, qIdx) => this.updateVideoUrl(url, sIdx, qIdx),
                setYouTubeUrl:    (url, sIdx, qIdx) => this.setYouTubeUrl(url, sIdx, qIdx),
                uploadImage:      (files, sIdx, qIdx) => this.uploadImage(files, sIdx, qIdx),
                removeImage:      (sIdx, qIdx, imgIdx) => this.removeImage(sIdx, qIdx, imgIdx)
            });

            const closeBtn   = document.querySelector('#closeWizard');
            const modal      = document.querySelector('#wizardModal');
            const catatanTgl = document.querySelector('#catatanToggle');

            closeBtn?.addEventListener('click', () => this.closeWizard());
            modal?.addEventListener('click', (e) => { if (e.target === modal) this.closeWizard(); });
            catatanTgl?.addEventListener('change', (e) => {
                const checked = e.target.checked;
                this.dom.toggleCatatanContainer(checked);
                this.pushHistory();
                this.state.updateExamData({
                    ujian: {
                        catatan:    checked ? 'On' : 'Off',
                        is_catatan: checked ? this.state.getExamData().ujian.is_catatan : null
                    }
                });
                this.triggerProgressRefresh();
            });

            // v0.5.0 — Metode Nama tab switcher
            const metodeTabs = document.querySelector('#metodeTabs');
            if (metodeTabs) {
                metodeTabs.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-metode]');
                    if (!btn) return;
                    this._handleMetodeChange(btn.dataset.metode);
                });
            }

            document.addEventListener('keydown', (e) => {
                if (!document.querySelector('#wizardModal.active')) return;
                if (e.ctrlKey && e.key === 'z') { e.preventDefault(); this.undo(); }
                if (e.ctrlKey && e.key === 'y') { e.preventDefault(); this.redo(); }
            });
        }

        triggerProgressRefresh() {
            const state = this.state.getState();
            this.dom.scheduleProgressRefresh(state.currentStep, 4, state.stepCompleted);
        }

        // ── Form population from state (BUG FIX: called after restore) ───────
        populateStep1FromState() {
            const state = this.state.getState();
            const ujian = state.examData.ujian;

            const set = (sel, val) => { const el = document.querySelector(sel); if (el) el.value = val || ''; };

            set('[data-field="judul"]',          ujian.judul);
            set('[data-field="mataPelajaran"]',   ujian.mata_pelajaran);

            if (ujian.time) set('[data-field="waktuUjian"]', parseInt(ujian.time) || '');

            // v2.0.0 — Hapus restore dropdown kelasUtama (sistem kelas lama dihapus)
            // Dropdown kelas 7/8/9 dihapus dari wizard HTML, diganti dengan IdentityFormBuilder

            if (ujian.mode_pembuka) {
                const dd = document.querySelector('[data-dropdown="modePembuka"]');
                dd?.dropdownInstance?.setValue(ujian.mode_pembuka, ujian.mode_pembuka);
            }

            // Catatan toggle
            if (ujian.catatan === 'On') {
                const tog = document.querySelector('#catatanToggle');
                if (tog) { tog.checked = true; this.dom.toggleCatatanContainer(true); }
                set('[data-field="catatan"]', ujian.is_catatan);
            }

            // Scheduled fields
            const scheduled = state.examData.access_control?.scheduled;
            if (ujian.mode_pembuka === 'Otomatis' && scheduled) {
                this.dom.toggleScheduledContainer(true);
                if (scheduled.start) {
                    set('[data-field="tanggalMulai"]', scheduled.start.split('T')[0]);
                    set('[data-field="jamMulai"]',     (scheduled.start.split('T')[1] || '').substring(0, 5));
                }
                if (scheduled.end) {
                    set('[data-field="tanggalSelesai"]', scheduled.end.split('T')[0]);
                    set('[data-field="jamSelesai"]',     (scheduled.end.split('T')[1] || '').substring(0, 5));
                }
            }

            // v2.0.0 — restore identity_mode state (replaces metode_nama)
            const mode = ujian.identity_mode || 'manual';
            this._applyMetodeTabUI(mode);
            if (mode === 'daftar') {
                const cfg = ujian.identity_config || {};
                if (cfg.daftar_id) {
                    this._restoreDaftarDropdown(cfg.daftar_id, cfg.daftar_tipe, cfg.daftar_label);
                }
            } else if (mode === 'manual') {
                // Mount IdentityFormBuilder with existing fields
                this._mountFormBuilder();
            }

            // BUG FIX: After populating, signal a full validation re-run
            // so progress bar reflects the restored data immediately
            this.triggerProgressRefresh();
        }

        // ── Duration helper ──────────────────────────────────────────────────
        calculateDurationFromISO(startISO, endISO) {
            if (!startISO || !endISO) return null;
            const diff = new Date(endISO) - new Date(startISO);
            const mins = Math.floor(diff / 60000);
            return mins >= 0 ? mins : null;
        }

        updateDurationFromSchedule() {
            const { scheduled } = this.state.getExamData().access_control;
            if (!scheduled) return;
            const duration = this.calculateDurationFromISO(scheduled.start, scheduled.end);
            if (duration !== null) {
                this.state.updateExamData({ ujian: { time: `${duration} menit` } });
                const el = document.querySelector('[data-field="waktuUjian"]');
                if (el) el.value = duration;
            }
        }

        toggleScheduledInputs(show) { this.dom.toggleScheduledContainer(show); }

        // ── v0.5.0 Metode Nama helpers ────────────────────────────────────────

        /** Called once on wizard open — loads daftar options from Supabase */
        async _loadDaftarOptions() {
            if (!window.DaftarNama) return;
            try {
                const list = await window.DaftarNama.getAll();
                this._cachedDaftarList = list;
                this._populateDaftarDropdown(list);
            } catch (err) {
                console.warn('[Wizard] _loadDaftarOptions:', err?.message);
            }
        }

        _populateDaftarDropdown(list) {
            const optionsEl = document.querySelector('#daftarNamaOptions');
            const labelEl   = document.querySelector('#daftarNamaLabel');
            if (!optionsEl) return;

            if (!list || list.length === 0) {
                optionsEl.innerHTML = '<div class="dropdown-option" style="color:#94a3b8;pointer-events:none;font-size:12px;padding:10px 14px;">Belum ada data daftar. Buat di menu Daftar Nama.</div>';
                if (labelEl) labelEl.textContent = 'Belum ada data daftar';
                return;
            }

            optionsEl.innerHTML = list.map(d =>
                // BUGFIX: escape ALL user-controlled values (id, tipe_daftar,
                // nama_daftar) - they all flow into HTML attributes / text and
                // could contain characters that break out of the attribute context
                // (e.g. a nama_daftar containing `\" onmouseover=\"alert(1)`).
                `<div class="dropdown-option" data-value="${this._escHtml(d.id)}" data-tipe="${this._escHtml(d.tipe_daftar)}" data-nama="${this._escHtml(d.nama_daftar)}">
                    <i style="color:#2563eb;margin-right:6px" class="material-symbols-outlined">format_list_bulleted</i>
                    ${this._escHtml(d.nama_daftar)}
                    <span style="font-size:11px;color:#94a3b8;margin-left:6px">${this._escHtml(d.tipe_daftar)}</span>
                </div>`
            ).join('');

            if (labelEl) labelEl.textContent = 'Pilih data daftar...';

            // Bind click events on options
            optionsEl.querySelectorAll('.dropdown-option[data-value]').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Close dropdown
                    optionsEl.classList.remove('active');
                    const selected = document.querySelector('#daftarNamaSelected');
                    if (selected) selected.classList.remove('active');
                    this._handleDaftarNamaSelected(opt.dataset.value);
                });
            });

            // Custom dropdown toggle for daftar
            const selected = document.querySelector('#daftarNamaSelected');
            if (selected && !selected._daftarBound) {
                selected._daftarBound = true;
                selected.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isOpen = optionsEl.classList.contains('active');
                    // Close all other dropdowns
                    document.querySelectorAll('.wizard-wrapper .dropdown-options.active').forEach(o => o.classList.remove('active'));
                    document.querySelectorAll('.wizard-wrapper .dropdown-selected.active').forEach(s => s.classList.remove('active'));
                    if (!isOpen) {
                        optionsEl.classList.add('active');
                        selected.classList.add('active');
                    }
                });
                document.addEventListener('click', () => {
                    optionsEl.classList.remove('active');
                    selected.classList.remove('active');
                });
            }
        }

        _handleDaftarNamaSelected(daftarId) {
            const list  = this._cachedDaftarList || [];
            const d     = list.find(x => x.id === daftarId);
            if (!d) return;

            const label = `Pilih ${d.tipe_daftar}`;
            // v2.0.0: embed FULL tabs structure (with anggota) ke identity_config.
            // WHY: peserta tidak bisa query daftar_nama table (RLS block — cuma admin yang bisa SELECT).
            // Jadi kita embed anggota ke examData.identity_config.tabs saat admin save exam.
            // Peserta langsung baca dari examData (yang sudah di-fetch via view ujian_peserta).
            const tabsFull = (d.tabs || []).map(t => ({
                nama_tab: t.nama_tab || '',
                anggota:  Array.isArray(t.anggota) ? [...t.anggota] : [],
            }));

            // v2.0.0 — Update state via setIdentityDaftar helper
            this.pushHistory();
            this.state.setIdentityDaftar({
                id:           d.id,
                tipe_daftar:  d.tipe_daftar,
                label:        label,
                tabs:         tabsFull,
            });

            // Update UI
            const labelEl    = document.querySelector('#daftarNamaLabel');
            const tipeInfo   = document.querySelector('#daftarTipeInfo');
            const tipeText   = document.querySelector('#daftarTipeText');
            const pilihLabel = document.querySelector('#daftarPilihLabel');

            if (labelEl) labelEl.textContent = d.nama_daftar;
            if (tipeInfo) tipeInfo.style.display = '';
            if (tipeText) tipeText.textContent = d.tipe_daftar;
            if (pilihLabel) pilihLabel.textContent = label;

            this.triggerProgressRefresh();
        }

        _restoreDaftarDropdown(daftarId, tipe, label) {
            const labelEl    = document.querySelector('#daftarNamaLabel');
            const tipeInfo   = document.querySelector('#daftarTipeInfo');
            const tipeText   = document.querySelector('#daftarTipeText');
            const pilihLabel = document.querySelector('#daftarPilihLabel');

            // Wait for DaftarNama to load options, then restore
            const tryRestore = () => {
                const list = this._cachedDaftarList;
                if (!list) { setTimeout(tryRestore, 300); return; }
                const d = list.find(x => x.id === daftarId);
                if (labelEl) labelEl.textContent = d?.nama_daftar || 'Daftar dipilih';
                if (tipeInfo) tipeInfo.style.display = '';
                if (tipeText) tipeText.textContent = tipe || '';
                if (pilihLabel) pilihLabel.textContent = label || '';
            };
            setTimeout(tryRestore, 200);
        }

        _handleMetodeChange(metode) {
            this.pushHistory();
            // v2.0.0 — gunakan updateIdentityConfig
            this.state.updateIdentityConfig({ identity_mode: metode });
            this._applyMetodeTabUI(metode);
            if (metode === 'daftar') {
                this._loadDaftarOptions();
                this._unmountFormBuilder();
            } else if (metode === 'manual') {
                this._mountFormBuilder();
            }
            this.triggerProgressRefresh();
        }

        /** v2.0.0 — Mount IdentityFormBuilder ke container #identityFormBuilder */
        _mountFormBuilder() {
            if (!window.IdentityFormBuilder) {
                console.warn('[wizard] IdentityFormBuilder module not available');
                return;
            }
            const container = document.querySelector('#identityFormBuilder');
            if (!container) {
                console.warn('[wizard] #identityFormBuilder container not found');
                return;
            }
            const ujian = this.state.getExamData().ujian;
            const existingFields = ujian.identity_config?.fields || null;

            // Avoid double-mount
            if (this._formBuilderMounted) {
                // Re-load config if changed
                window.IdentityFormBuilder.loadConfig(existingFields);
                return;
            }

            window.IdentityFormBuilder.mount(container, existingFields);
            window.IdentityFormBuilder.setOnChange(fields => {
                this.pushHistory();
                this.state.setIdentityFields(fields);
                this.triggerProgressRefresh();
            });
            this._formBuilderMounted = true;
        }

        /** v2.0.0 — Unmount IdentityFormBuilder */
        _unmountFormBuilder() {
            if (!this._formBuilderMounted) return;
            if (window.IdentityFormBuilder) {
                window.IdentityFormBuilder.destroy();
            }
            const container = document.querySelector('#identityFormBuilder');
            if (container) container.innerHTML = '';
            this._formBuilderMounted = false;
        }

        _applyMetodeTabUI(metode) {
            const tabs = document.querySelectorAll('#metodeTabs [data-metode]');
            tabs.forEach(btn => {
                const isActive = btn.dataset.metode === metode;
                btn.style.background = isActive ? '#eff6ff' : '#f8fafc';
                btn.style.color      = isActive ? '#2563eb' : '#64748b';
                btn.style.borderColor= isActive ? '#2563eb' : '#e2e8f0';
                btn.classList.toggle('active', isActive);
            });
            const picker = document.querySelector('#daftarPickerGroup');
            if (picker) picker.style.display = metode === 'daftar' ? '' : 'none';
        }

        _escHtml(s) {
            return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // ── End v0.5.0 helpers ────────────────────────────────────────────────

        // ── Input handlers ───────────────────────────────────────────────────
        handleInput(field, value, sectionIdx, questionIdx) {
            // Question-level fields
            if (sectionIdx !== undefined && questionIdx !== undefined) {
                const key = `${field}-${sectionIdx}-${questionIdx}`;
                this.debounce(key, () => {
                    this.pushHistory();
                    if (field.startsWith('pilihan-')) {
                        const letter    = field.split('-')[1];
                        const sections  = this.state.getSections();
                        const question  = sections[sectionIdx]?.questions[questionIdx];
                        if (question) {
                            this.state.updateQuestionInSection(parseInt(sectionIdx), parseInt(questionIdx),
                                { pilihan: { ...question.pilihan, [letter]: value } });
                        }
                    } else if (field === 'pertanyaan') {
                        this.state.updateQuestionInSection(parseInt(sectionIdx), parseInt(questionIdx), { pertanyaan: value });
                    }
                    this.triggerProgressRefresh();
                    this.updateValidationErrors();
                }, 300);
                return;
            }

            // Step 1 fields
            const fieldMap = {
                judul:          () => this.state.updateExamData({ ujian: { judul: value } }),
                mataPelajaran:  () => this.state.updateExamData({ ujian: { mata_pelajaran: value } }),
                waktuUjian:     () => this.state.updateExamData({ ujian: { time: value + ' menit' } }),
                catatan:        () => this.state.updateExamData({ ujian: { is_catatan: value } })
            };

            if (fieldMap[field]) {
                this.debounce(field, () => {
                    this.pushHistory();
                    fieldMap[field]();
                    this.triggerProgressRefresh();
                    this.updateValidationErrors();
                }, 300);
                return;
            }

            if (field.startsWith('color')) {
                this.debounce(field, () => {
                    this.pushHistory();
                    this.state.updateExamData({ theme: { [field.replace('color', '')]: value } });
                }, 300);
                return;
            }

            // Scheduled datetime fields
            if (['tanggalMulai', 'jamMulai', 'tanggalSelesai', 'jamSelesai'].includes(field)) {
                this.debounce(field, () => {
                    this.pushHistory();
                    const tanggalMulai = document.querySelector('[data-field="tanggalMulai"]')?.value || '';
                    const jamMulai     = document.querySelector('[data-field="jamMulai"]')?.value || '';
                    const tanggalSel   = document.querySelector('[data-field="tanggalSelesai"]')?.value || '';
                    const jamSel       = document.querySelector('[data-field="jamSelesai"]')?.value || '';

                    const start = tanggalMulai ? `${tanggalMulai}T${jamMulai || '00:00'}:00` : null;
                    const end   = tanggalSel   ? `${tanggalSel}T${jamSel   || '00:00'}:00` : null;

                    this.state.updateExamData({ access_control: { scheduled: { start, end } } });

                    const mode = this.state.getExamData().ujian.mode_pembuka;
                    if (mode === 'Otomatis') this.updateDurationFromSchedule();
                    this.triggerProgressRefresh();
                }, 300);
            }
        }

        handleDropdown(type, value, index, sectionIndex, questionIndex) {
            this.pushHistory();

            // v2.0.0 — kelasUtama dropdown removed (sistem kelas lama dihapus)
            // Kalau ada panggilan lama, abaikan
            if (type === 'kelasUtama') {
                console.warn('[wizard] kelasUtama dropdown is deprecated (v2.0.0)');
                return;
            }

            else if (type === 'modePembuka') {
                this.state.updateExamData({ ujian: { mode_pembuka: value } });

                if (value === 'Manual') {
                    this.state.updateExamData({
                        access_control: {
                            mode: 'manual', manual_status: 'closed', override: false,
                            scheduled: { active: false, start: null, end: null }
                        }
                    });
                    this.dom.toggleScheduledContainer(false);
                    const waktu = document.querySelector('[data-field="waktuUjian"]');
                    if (waktu) { waktu.disabled = false; waktu.classList.remove('disabled-field'); }
                }
                else if (value === 'Otomatis') {
                    this.state.updateExamData({ access_control: { mode: 'scheduled', scheduled: { active: true } } });
                    this.dom.toggleScheduledContainer(true);
                    const waktu = document.querySelector('[data-field="waktuUjian"]');
                    if (waktu) { waktu.disabled = true; waktu.classList.add('disabled-field'); }
                    this.updateDurationFromSchedule();
                }
                this.triggerProgressRefresh();
            }

            // v0.5.0 — Daftar Nama dropdown selection
            else if (type === 'daftarNama') {
                this._handleDaftarNamaSelected(value);
            }

            else if (type === 'sectionType' && index !== undefined) {
                const sIdx    = parseInt(index);
                const section = this.state.getSections()[sIdx];
                const doChange = () => {
                    this.state.updateSection(sIdx, { type_question: value });
                    this.refreshUI();
                    this.triggerProgressRefresh();
                    this.updateValidationErrors();
                };
                const revert = () => {
                    const dd = document.querySelector(`#sectionTypeDropdown-${sIdx}`);
                    dd?.dropdownInstance?.setValue(
                        section.type_question || '',
                        section.type_question === 'PG' ? 'Pilihan Ganda' :
                        section.type_question === 'ESSAY' ? 'Essay' : 'Pilih Tipe Soal'
                    );
                };

                if (section && section.questions.length > 0) {
                    if (window.notify?.confirm) {
                        window.notify.confirm({
                            message: 'Mengubah tipe soal akan menghapus semua soal di bagian ini. Lanjutkan?',
                            icon: 'warning', onYes: doChange, onNo: revert
                        });
                    } else {
                        doChange();
                    }
                } else {
                    this.state.updateSection(sIdx, { type_question: value });
                    this.refreshUI();
                    this.triggerProgressRefresh();
                    this.updateValidationErrors();
                }
            }

            else if (type === 'jawabanBenar') {
                if (sectionIndex !== undefined && questionIndex !== undefined) {
                    this.state.updateQuestionInSection(parseInt(sectionIndex), parseInt(questionIndex),
                        { jawaban_benar: value });
                    this.triggerProgressRefresh();
                    this.updateValidationErrors();
                }
            }
        }

        debounce(key, fn, delay) {
            if (this.debounceTimers[key]) clearTimeout(this.debounceTimers[key]);
            this.debounceTimers[key] = setTimeout(() => { fn(); delete this.debounceTimers[key]; }, delay);
        }

        // ── Validation helpers ───────────────────────────────────────────────
        /**
         * BUG FIX: updateValidationErrors now reads directly from WizardValidation
         * (which reads from WizardState) — never from stale DOM state.
         */
        updateValidationErrors() {
            const step = this.state.getCurrentStep();
            if (step !== 3) return;
            const { errors } = this.validation.validateStep(3);
            this.errorManager?.applyErrors(errors);
        }

        // ── Section / question actions ────────────────────────────────────────
        addSection() {
            if (this.state.getSections().length >= this.state.getMaxSections()) {
                if (window.notify) window.notify.error('Gagal', `Maksimal ${this.state.getMaxSections()} bagian`, 3000);
                return;
            }
            this.pushHistory();
            this.state.addSection();
            this.dom.invalidateSectionCache?.(); // W1: force rebuild for new section
            this.refreshUI();
            this.triggerProgressRefresh();
        }

        removeSection(index) {
            const doRemove = () => {
                this.pushHistory();
                this.state.removeSection(index);
                this.dom.invalidateSectionCache?.(); // W1: force rebuild after removal
                this.refreshUI();
                this.triggerProgressRefresh();
            };
            if (window.notify?.confirm) {
                window.notify.confirm({ message: 'Hapus bagian ini?', icon: 'warning', onYes: doRemove });
            } else {
                doRemove();
            }
        }

        switchSection(index) {
            this.state.setCurrentSectionIndex(index);
            this.refreshUI();
        }

        addQuestion(sectionIdx) {
            const sections = this.state.getSections();
            const section  = sections[sectionIdx];
            if (!section?.type_question) {
                if (window.notify) window.notify.warning('Peringatan', 'Pilih tipe soal terlebih dahulu', 3000);
                return;
            }
            if (section.questions.length >= this.state.getMaxQuestionsPerSection()) {
                if (window.notify) window.notify.error('Gagal', `Maksimal ${this.state.getMaxQuestionsPerSection()} soal per bagian`, 3000);
                return;
            }
            if (this.state.getTotalQuestions() >= this.state.getMaxTotalQuestions()) {
                if (window.notify) window.notify.error('Gagal', `Maksimal ${this.state.getMaxTotalQuestions()} soal total`, 3000);
                return;
            }
            this.pushHistory();
            this.state.addQuestionToSection(sectionIdx, section.type_question);
            this.dom.invalidateSectionCache?.(sectionIdx); // W1: rebuild only this section
            this.refreshUI();
            this.triggerProgressRefresh();
        }

        deleteQuestion(qIdx, el) {
            const sectionIdx = el?.dataset?.sectionIndex;
            if (sectionIdx === undefined) return;
            const doDelete = () => {
                this.pushHistory();
                this.state.removeQuestionFromSection(parseInt(sectionIdx), parseInt(qIdx));
                this.dom.invalidateSectionCache?.(parseInt(sectionIdx)); // W1: rebuild this section
                this.refreshUI();
                this.triggerProgressRefresh();
            };
            if (window.notify?.confirm) {
                window.notify.confirm({ message: 'Hapus soal ini?', icon: 'warning', onYes: doDelete });
            } else {
                doDelete();
            }
        }

        moveQuestion(qIdx, direction, el) {
            const sectionIdx = el?.dataset?.sectionIndex;
            if (sectionIdx === undefined) return;
            const section   = this.state.getSections()[parseInt(sectionIdx)];
            const questions = [...section.questions];

            if (direction === 'up' && qIdx > 0)
                [questions[qIdx - 1], questions[qIdx]] = [questions[qIdx], questions[qIdx - 1]];
            else if (direction === 'down' && qIdx < questions.length - 1)
                [questions[qIdx], questions[qIdx + 1]] = [questions[qIdx + 1], questions[qIdx]];
            else return;

            questions.forEach((q, i) => { q.idq = i + 1; });
            this.pushHistory();
            this.state.updateSection(parseInt(sectionIdx), { questions });
            this.dom.invalidateSectionCache?.(parseInt(sectionIdx)); // W1: rebuild this section
            this.refreshUI();
        }

        regenerateCode() {
            const code = this.state.generateCode();
            // If on step 4, refresh the reviewer (which shows the new token)
            if (this.state.getCurrentStep() === 4) {
                this.dom.updatePublishReviewer(this.state.exportExamData());
            }
            if (window.notify) window.notify.success('Token Baru', `Token ${code} telah digenerate`, 2000);
        }

        copyCode() {
            const code = this.state.getExamData().ujian.kode_id;
            if (!code) return;
            navigator.clipboard.writeText(code).then(() => {
                if (window.notify) window.notify.success('Tersalin', `Token ${code} berhasil disalin`, 1500);
            });
        }

        // ── Publish ──────────────────────────────────────────────────────────
        async publishExam() {
            const bgResults   = this.validation.validateAllBackground();
            const canPublish  = [1, 3].every(s => {
                const st = bgResults[s]?.status;
                return st === 'complete' || st === 'warning';
            });

            if (!canPublish) {
                if (window.notify)
                    window.notify.error('Tidak Bisa Publish', 'Perbaiki semua error terlebih dahulu', 4000);
                return;
            }

            const examData = this.state.exportExamData();
            const kodeId   = examData.ujian?.kode_id;

            if (!kodeId) {
                if (window.notify) window.notify.error('Gagal', 'Token tidak ditemukan', 3000);
                return;
            }

            try {
                if (window.notify) window.notify.info('Mempublish ujian...', '', 2000);
                await this.saveExamToSupabase(examData);
                this.state.discardDraft();  // Clean up — exam is now in Firestore
                this.history      = [];
                this.historyIndex = -1;
                if (window.notify) window.notify.success('Berhasil!', `Ujian dipublish dengan token ${kodeId}`, 3000);
                setTimeout(() => this.closeWizard(), 2000);
            } catch (error) {
                console.error('[WizardController] Publish error:', error);
                if (window.notify)
                    window.notify.error('Gagal Publish', error.message, 5000);
            }
        }

        // ── DB save ───────────────────────────────────────────────────────────
        async saveExamToSupabase(examData) {
            const kodeId = examData.ujian?.kode_id;
            if (!kodeId) throw new Error('Token tidak ditemukan');

            const db   = window.firebaseDb;
            const user = window.firebaseAuth?.currentUser;
            if (!user)   throw new Error('User tidak terautentikasi');

            const docRef = db.collection('ujian').doc(kodeId);

            await db.runTransaction(async (transaction) => {
                const doc = await transaction.get(docRef);
                if (doc.exists) throw new Error('Token ujian sudah digunakan, generate ulang token');

                // Normalize access_control before write — prevents stale
                // top-level `end` / undefined `manual_status` causing FINISHED on load
                const acMode = examData.access_control?.mode || 'manual';
                const normalizedAC = {
                    ...examData.access_control,
                    ...(acMode === 'manual' ? {
                        manual_status:  'closed',
                        end:            null,
                        remaining_time: null,
                        override:       false
                    } : {})
                };

                transaction.set(docRef, {
                    ...examData,
                    access_control: normalizedAC,
                    // ── Denormalized summary fields ───────────────────────────
                    // WHY: examData.ujian berisi judul/mata_pelajaran/kelas/sections
                    // sebagai nested JSON. Supabase butuh kolom top-level ini untuk
                    // fast query, listing, dan filtering tanpa harus parse JSON blob.
                    // v2.0.0: `kelas` diganti dengan `identity_mode` + `identity_config`.
                    judul:           examData.ujian?.judul          ?? null,
                    mata_pelajaran:  examData.ujian?.mata_pelajaran ?? null,
                    identity_mode:   examData.identity_mode   ?? examData.ujian?.identity_mode   ?? 'manual',
                    identity_config: examData.identity_config ?? examData.ujian?.identity_config ?? {},
                    // examData.sections is now always set by exportExamData() from state.sections.
                    // getSections() is a belt-and-suspenders fallback — should never be needed.
                    sections:        (() => {
                                        const s = examData.sections ?? this.state.getSections();
                                        if (!s || !s.length)
                                            console.warn('[saveExamToSupabase] sections is empty — verify exportExamData() was called');
                                        return s ?? null;
                                    })(),
                    // ─────────────────────────────────────────────────────────
                    createdBy:      user.uid,
                    createdByEmail: user.email || null,
                    createdAt:      db.FieldValue.serverTimestamp(),
                    updatedAt:      db.FieldValue.serverTimestamp(),
                    status:         'active'
                });
            });
        }

        // ── Media handlers ─────────────────────────────────────────────────────
        // YouTube URL helper — supports watch?v=, youtu.be/, shorts/, embed/
        _extractYouTubeId(url) {
            if (!url) return null;
            const patterns = [
                /[?&]v=([a-zA-Z0-9_-]{11})/,          // youtube.com/watch?v=
                /youtu\.be\/([a-zA-Z0-9_-]{11})/,      // youtu.be/
                /\/shorts\/([a-zA-Z0-9_-]{11})/,       // youtube.com/shorts/
                /\/embed\/([a-zA-Z0-9_-]{11})/,        // youtube.com/embed/
            ];
            for (const re of patterns) {
                const m = url.match(re);
                if (m) return m[1];
            }
            return null;
        }

        // Save a validated YouTube URL into state; called on every input event
        setYouTubeUrl(url, sectionIdx, questionIdx) {
            this.pushHistory();
            const sections = this.state.getSections();
            const q        = sections[sectionIdx]?.questions[questionIdx];
            if (!q) return;

            const media   = q.media || { video: { enabled: false, src: null }, gambar: [] };
            const videoId = this._extractYouTubeId(url);

            if (url && !videoId) {
                // Invalid URL — store raw string so the UI can show feedback,
                // but do not surface a notify toast on every keystroke.
                media.video.src     = url;
                media.video.videoId = null;
            } else {
                media.video.src     = url || null;
                media.video.videoId = videoId || null;
            }

            this.state.updateQuestionInSection(sectionIdx, questionIdx, { media });
            // Refresh only the preview thumbnail — no full UI rebuild needed
            this._refreshVideoPreview(sectionIdx, questionIdx, videoId, url);
            this.updateValidationErrors();
        }

        async uploadImage(files, sectionIdx, questionIdx) {
            const sections = this.state.getSections();
            const q        = sections[sectionIdx]?.questions[questionIdx];
            if (!q) return;

            // Accept any image format — compression converts everything to JPEG
            const validFiles = files.filter(f => f.type.startsWith('image/'));
            if (!validFiles.length) {
                if (window.notify) window.notify.warning('Peringatan', 'File harus berupa gambar', 2000);
                return;
            }

            // Hard ceiling before compression — 50 MB; genuinely pathological files
            const MAX_RAW = 50 * 1024 * 1024;
            const oversized = validFiles.filter(f => f.size > MAX_RAW);
            if (oversized.length) {
                if (window.notify)
                    window.notify.error('Gagal', `Gambar terlalu besar (maks 50MB sebelum kompresi): ${oversized.map(f => f.name).join(', ')}`, 4000);
                return;
            }

            const currentImages = q.media?.gambar || [];
            if (currentImages.length + validFiles.length > 4) {
                if (window.notify) window.notify.error('Gagal', 'Maksimal 4 gambar per soal', 3000);
                return;
            }

            const fileInput = document.querySelector(
                `input[data-action="uploadImage"][data-section-index="${sectionIdx}"][data-question-index="${questionIdx}"]`);
            if (fileInput) fileInput.disabled = true;
            if (window.notify) window.notify.info('Memproses gambar...', `Mengkompresi ${validFiles.length} file ke JPEG ≤500KB`, 2500);

            // ── Step 1: Compress all files client-side → JPEG ≤ 500 KB ──────────
            let compressedFiles;
            try {
                if (typeof ImageCompress === 'undefined') throw new Error('ImageCompress tidak tersedia');
                compressedFiles = await ImageCompress.compressAll(validFiles);
            } catch (err) {
                console.error('[uploadImage] Compression failed:', err);
                if (window.notify) window.notify.error('Gagal', `Kompresi gambar gagal: ${err.message}`, 4000);
                if (fileInput) fileInput.disabled = false;
                return;
            }

            if (window.notify) window.notify.info('Mengupload gambar...', `${compressedFiles.length} file ke CDN`, 2000);

            // ── Step 2: Upload compressed JPEGs to Cloudflare Worker ─────────────
            const WORKER_URL = window.ALBYTE_WORKER_URL || 'https://albedu.examjuniorhighschool.workers.dev/upload';
            const uploaded = [];
            const failed   = [];

            await Promise.all(compressedFiles.map(async (file) => {
                try {
                    const formData = new FormData();
                    formData.append('file', file, file.name);
                    console.debug('[uploadImage] POSTing to:', WORKER_URL, '| file:', file.name, file.type, file.size);
                    const res = await fetch(WORKER_URL, { method: 'POST', body: formData });
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '(could not read body)');
                        console.error('[uploadImage] Worker raw error:', res.status, errText);
                        throw new Error(`Worker error (${res.status}): ${errText}`);
                    }
                    const data = await res.json();
                    console.debug('[uploadImage] Worker response:', data);
                    if (!data.cdn_url) throw new Error('Worker response missing cdn_url');
                    uploaded.push({ url: data.cdn_url, hash: data.hash });
                } catch (err) {
                    console.error('[uploadImage] file failed:', file.name, err.message);
                    failed.push(file.name);
                }
            }));

            try {
                if (!uploaded.length) throw new Error('Tidak ada gambar berhasil diupload');

                this.pushHistory();
                const media = { ...(q.media || { video: { enabled: false, src: null }, gambar: [] }) };
                media.gambar = [...currentImages, ...uploaded];
                this.state.updateQuestionInSection(sectionIdx, questionIdx, { media });
                this.refreshUI();
                if (window.notify) {
                    failed.length
                        ? window.notify.warning('Upload Sebagian', `${uploaded.length} berhasil, ${failed.length} gagal`, 3000)
                        : window.notify.success('Berhasil', `${uploaded.length} gambar diupload ke CDN`, 2500);
                }
            } catch (err) {
                console.error('[uploadImage]', err);
                if (window.notify) window.notify.error('Gagal', `Upload gambar: ${err.message}`, 4000);
            } finally {
                if (fileInput) fileInput.disabled = false;
            }
        }

        // Update only the preview area — avoids full UI rebuild on every keystroke
        _refreshVideoPreview(sectionIdx, questionIdx, videoId, rawUrl) {
            const previewEl = document.querySelector(
                `.youtube-preview[data-section-index="${sectionIdx}"][data-question-index="${questionIdx}"]`);
            const feedbackEl = document.querySelector(
                `.youtube-url-feedback[data-section-index="${sectionIdx}"][data-question-index="${questionIdx}"]`);
            if (!previewEl) return;

            if (!rawUrl) {
                previewEl.style.display  = 'none';
                previewEl.innerHTML      = '';
                if (feedbackEl) { feedbackEl.textContent = ''; feedbackEl.className = 'youtube-url-feedback'; }
                return;
            }

            if (videoId) {
                previewEl.style.display = 'block';
                previewEl.innerHTML = `<img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg"
                    alt="YouTube preview" style="width:100%;border-radius:6px;display:block;">`;
                if (feedbackEl) {
                    feedbackEl.textContent = '✓ YouTube URL valid';
                    feedbackEl.className   = 'youtube-url-feedback valid';
                }
            } else {
                previewEl.style.display  = 'none';
                previewEl.innerHTML      = '';
                if (feedbackEl) {
                    feedbackEl.textContent = '⚠ URL YouTube tidak valid';
                    feedbackEl.className   = 'youtube-url-feedback invalid';
                }
            }
        }

        toggleVideo(sectionIdx, questionIdx, enabled) {
            this.pushHistory();
            const sections = this.state.getSections();
            const q        = sections[sectionIdx]?.questions[questionIdx];
            if (q) {
                const media = q.media || { video: { enabled: false, src: null }, gambar: [] };
                media.video.enabled = enabled;
                if (!enabled) { media.video.src = null; media.video.videoId = null; }
                this.state.updateQuestionInSection(sectionIdx, questionIdx, { media });
                this.refreshUI();
                this.updateValidationErrors();
            }
        }

        // Kept for backward compat with any callers that still use updateVideoUrl
        updateVideoUrl(url, sectionIdx, questionIdx) {
            this.setYouTubeUrl(url, sectionIdx, questionIdx);
        }

        async removeImage(sectionIdx, questionIdx, imageIdx) {
            const sections = this.state.getSections();
            const q        = sections[sectionIdx]?.questions[questionIdx];
            if (!q?.media?.gambar) return;

            const imgEntry = q.media.gambar[imageIdx];
            const imgUrl   = typeof imgEntry === 'object' ? (imgEntry?.url || '') : (imgEntry || '');

            // ── Confirm dialog (use QNotify when available, fallback to native) ─
            const proceed = () => {
                // ── Visual feedback: dim the thumbnail immediately ──────────
                const previewEl = document.querySelector(
                    `.gambar-preview-item[data-image-index="${imageIdx}"][data-section-index="${sectionIdx}"][data-question-index="${questionIdx}"]`
                );
                if (previewEl) {
                    previewEl.style.opacity   = '0.4';
                    previewEl.style.pointerEvents = 'none';
                }

                this.pushHistory();

                // ── CDN release ────────────────────────────────────────────
                const hash = imgEntry?.hash;
                if (hash) {
                    const releaseUrl = (window.ALBYTE_WORKER_URL || 'https://albedu.examjuniorhighschool.workers.dev/upload')
                        .replace(/\/upload$/, '/release');
                    fetch(releaseUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hash }),
                    })
                    .then(r => { if (!r.ok) return r.text().then(t => { throw new Error(t); }); })
                    .then(() => console.debug('[removeImage] /release OK for hash:', hash))
                    .catch(e => console.warn('[removeImage] /release failed:', e));
                } else if (typeof imgEntry === 'string'
                        && imgEntry.startsWith('https://raw.githubusercontent.com/')
                        && typeof ImageCleanup !== 'undefined') {
                    ImageCleanup.deleteImage(imgEntry).catch(e => console.warn('[removeImage] legacy CDN delete failed:', e));
                }

                // ── Local state update ─────────────────────────────────────
                const media    = { ...q.media };
                media.gambar   = media.gambar.filter((_, i) => i !== imageIdx);
                this.state.updateQuestionInSection(sectionIdx, questionIdx, { media });
                this.refreshUI();
                this.updateValidationErrors();

                if (window.notify) window.notify.success('Dihapus', 'Gambar berhasil dihapus', 2000);
            };

            const confirmed = await window.UI.confirm({ message: 'Hapus gambar ini?\nGambar akan dihapus dari CDN dan tidak bisa dikembalikan.', icon: 'warning' });
            if (!confirmed) return;
            proceed();
        }

        // ── DOCX Import — "Import Soal dari DOCX" ───────────────────────────
        /**
         * AlbEdu DOCX Simple Format Parser — v0.5.0
         *
         * This feature imports QUESTIONS ONLY from a .docx file.
         * The exam metadata (judul, mapel, kelas, etc.) still needs to be
         * filled manually in the wizard.
         *
         * Supported format (Pilihan Ganda):
         *   1. pertanyaan
         *   A.opsi  B.opsi  C.opsi  D.opsi
         *   (jawaban)
         *
         * Supported format (Essay):
         *   1. pertanyaan
         *
         * Lines starting with "BAGIAN" or "- BAGIAN" create new sections.
         * Lines "Pilihan Ganda" / "Essay" set section type.
         * Lines "(A)", "(B)", "(C)", "(D)" set answer key for PG questions.
         *
         * Header fields (Judul:, Mapel:, etc.) are optional and parsed
         * if present, but NOT required. The focus is importing soal only.
         */
        openDocxImport() {
            let inp = document.getElementById('_docx-import-input');
            if (!inp) {
                inp = document.createElement('input');
                inp.type    = 'file';
                inp.accept  = '.docx';
                inp.id      = '_docx-import-input';
                inp.style.display = 'none';
                document.body.appendChild(inp);
            }
            inp.value = '';
            inp.onchange = (e) => {
                const file = e.target.files[0];
                if (file) this.importDocx(file);
            };
            inp.click();
        }

        async importDocx(file) {
            if (!file.name.toLowerCase().endsWith('.docx')) {
                if (window.notify) window.notify.error('Format Salah', 'File harus berformat .docx', 3000);
                return;
            }

            if (window.notify) window.notify.info('Membaca file...', 'Import Soal DOCX', 2000);

            try {
                const text = await this._extractDocxText(file);
                const result = this._parseDocxSimple(text);

                if (result.warnings.length > 0) {
                    const warnMsg = result.warnings.slice(0, 3).join('\n')
                        + (result.warnings.length > 3 ? `\n...dan ${result.warnings.length - 3} lainnya` : '');
                    if (window.notify)
                        window.notify.warning(`Import: ${result.warnings.length} peringatan`, warnMsg, 6000);
                }

                if (result.errors.length > 0) {
                    const errMsg = result.errors.slice(0, 3).join('\n')
                        + (result.errors.length > 3 ? `\n...dan ${result.errors.length - 3} lainnya` : '');
                    if (window.notify)
                        window.notify.error(`Import Gagal: ${result.errors.length} error`, errMsg, 8000);
                    return;
                }

                // Apply imported questions to state (soal only, wizard stays open)
                const applyResult = this._applyImportedSoal(result.data);

                // Kasih tau user kalo ada bagian yang di-skip (MAX_SECTIONS = 2)
                if (applyResult.skippedSections > 0) {
                    if (window.notify)
                        window.notify.warning('Bagian dilewati',
                            `${applyResult.skippedSections} bagian tidak diimport karena melebihi batas maksimal (2 bagian).`, 6000);
                }

                if (window.notify)
                    window.notify.success('Import Berhasil',
                        `${result.data.totalQuestions} soal dari ${applyResult.appliedSections} bagian berhasil diimport`, 3000);

            } catch (err) {
                console.error('[DocxImport]', err);
                if (window.notify)
                    window.notify.error('Import Gagal', err.message || 'Gagal membaca file DOCX', 5000);
            }
        }

        /** Extract plain text from .docx using mammoth.js */
        async _extractDocxText(file) {
            if (typeof mammoth === 'undefined') {
                await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
            }
            const arrayBuffer = await file.arrayBuffer();
            const result      = await mammoth.extractRawText({ arrayBuffer });
            return result.value || '';
        }

        _loadScript(src) {
            return new Promise((resolve, reject) => {
                const s  = document.createElement('script');
                s.src    = src;
                s.onload = resolve;
                s.onerror = () => reject(new Error(`Gagal memuat library: ${src}`));
                document.head.appendChild(s);
            });
        }

        /**
         * Simple DOCX parser — strict soal-only import.
         * Format baru:
         *   bagian (1)
         *   (Pilihan Ganda)
         *
         *   1.pertanyaan soal
         *   a.opsi jawaban a
         *   b.opsi jawaban b
         *   c.opsi jawaban c
         *   d.opsi jawaban d
         *   jawaban: a
         *
         * Aturan:
         *   - "bagian (N)" bisa ditulis: bagian 1 / bagian(1) / BAGIAN (1)
         *   - Type soal: "Pilihan Ganda" | "PG" | "Essay" | "Esai" | "Uraian"
         *   - Nomor soal wajib urut 1,2,3,...
         *   - Opsi bisa inline ("a.x b.x c.x d.x") atau per-baris
         *   - "jawaban: a" — huruf opsi, optional kurung: "jawaban: (a)"
         *   - Tanpa marker bagian → otomatis 1 bagian type PG
         *   - Header (judul/mapel/kelas/durasi/mode) DIABAIKAN — diisi manual di Step 1
         */
        _parseDocxSimple(text) {
            const lines    = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const errors   = [];
            const warnings = [];

            // Strict soal-only import. No header (judul/mapel/kelas/durasi/mode)
            // is parsed — that lives in Step 1 of the wizard.
            const data = {
                sections:       [],
                totalQuestions: 0
            };

            // ── Patterns (format baru) ────────────────────────────────────
            // Section:  "bagian (1)" | "bagian 1" | "BAGIAN(1)"  (case-insensitive)
            const SECTION_PAT     = /^bagian\s*\(?\s*(\d+)\s*\)?$/i;
            // Question: "1.pertanyaan" | "1) pertanyaan"  (nomor wajib urut 1,2,3,...)
            const Q_PAT            = /^(\d+)[.)]\s*(.+)$/;
            // Opsi per-line: "a.opsi" | "b. opsi" (lowercase a-d, case-insensitive)
            const OPT_PER_LINE_PAT = /^([a-d])[.)]\s*(.+)$/i;
            // Answer key: "jawaban: a" | "jawaban: (A)" | "Jawaban : b"
            const ANSWER_PAT       = /^jawaban\s*:\s*\(?\s*([a-d])\s*\)?$/i;

            // Strip outer parens + whitespace for type matching
            const stripParens = (s) => s.replace(/^[()\s]+|[()\s]+$/g, '').trim();
            const TYPE_PG_PAT    = /^(pilihan\s*ganda|pg)$/i;
            const TYPE_ESSAY_PAT = /^(essay|esai|uraian)$/i;

            let currentSection = null;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // ── Section delimiter: "bagian (1)" ──────────────────────
                const secMatch = line.match(SECTION_PAT);
                if (secMatch) {
                    const secId = parseInt(secMatch[1]);
                    currentSection = {
                        id:            secId,
                        name:          `Bagian ${secId}`,
                        type_question: '',
                        questions:     []
                    };
                    data.sections.push(currentSection);
                    continue;
                }

                // ── Type marker — only when current section awaits type ──
                // Accept "(Pilihan Ganda)", "Pilihan Ganda", "PG", etc.
                if (currentSection && !currentSection.type_question) {
                    const stripped = stripParens(line);
                    if (TYPE_PG_PAT.test(stripped)) {
                        currentSection.type_question = 'PG';
                        continue;
                    }
                    if (TYPE_ESSAY_PAT.test(stripped)) {
                        currentSection.type_question = 'ESSAY';
                        continue;
                    }
                    // Parens-wrapped short line that isn't a known type → error
                    if (/^\(.+\)$/.test(line) && stripped.length <= 30) {
                        errors.push(`Bagian ${currentSection.id}: Type soal tidak dikenal "${stripped}". Gunakan: Pilihan Ganda atau Essay.`);
                        currentSection.type_question = 'PG'; // fallback agar parsing lanjut
                        continue;
                    }
                    // Otherwise: not a type marker, fall through
                }

                // ── Question line: "1.pertanyaan" ────────────────────────
                const qMatch = line.match(Q_PAT);
                if (qMatch) {
                    const qNum  = parseInt(qMatch[1]);
                    const qText = qMatch[2].trim();

                    // Auto-create default section (1 bagian, PG) kalo tanpa marker
                    if (!currentSection) {
                        currentSection = {
                            id:            1,
                            name:          'Bagian 1',
                            type_question: 'PG',
                            questions:     []
                        };
                        data.sections.push(currentSection);
                    }

                    const type  = currentSection.type_question || 'PG';
                    const media = { video: { enabled: false, src: null }, gambar: [] };

                    if (type === 'PG') {
                        const q = {
                            idq:           currentSection.questions.length + 1,
                            pertanyaan:    qText,
                            pilihan:       { A: '', B: '', C: '', D: '' },
                            jawaban_benar: '',
                            media,
                            skor:          0
                        };
                        currentSection.questions.push(q);

                        // Validasi nomor urut (wajib 1,2,3,...)
                        if (qNum !== q.idq) {
                            warnings.push(`Bagian ${currentSection.id}: Nomor soal melompat (diharapkan ${q.idq}, ditemukan ${qNum}).`);
                        }

                        // ── Opsi: coba inline dulu, lalu per-line ──────────
                        const nextLine = lines[i + 1] || '';
                        const isOptionStart = (l) => OPT_PER_LINE_PAT.test(l) && !Q_PAT.test(l);

                        if (isOptionStart(nextLine)) {
                            // Hitung berapa token opsi di baris itu (inline check)
                            const tokenCount = (nextLine.match(/[a-d][.)]/gi) || []).length;
                            if (tokenCount >= 2) {
                                // Inline: "a.x b.x c.x d.x" dalam satu baris.
                                // Pakai .*? (bukan [^a-d]*?) supaya teks opsi boleh
                                // mengandung huruf A-D — andalkan lookahead buat berhenti
                                // di marker opsi berikutnya ("  b." dsb).
                                i++;
                                const inlinePat = /([a-d])[.)]\s*(.*?)(?=\s+[a-d][.)]|$)/gi;
                                let im;
                                while ((im = inlinePat.exec(nextLine)) !== null) {
                                    q.pilihan[im[1].toUpperCase()] = im[2].trim();
                                }
                            } else {
                                // Per-line: tiap opsi di baris sendiri
                                while (i + 1 < lines.length && isOptionStart(lines[i + 1])) {
                                    i++;
                                    const optMatch = lines[i].match(OPT_PER_LINE_PAT);
                                    if (optMatch) q.pilihan[optMatch[1].toUpperCase()] = optMatch[2].trim();
                                }
                            }
                        }

                        // ── Kunci jawaban: "jawaban: a" ────────────────────
                        const ansLine = lines[i + 1] || '';
                        const ansMatch = ansLine.match(ANSWER_PAT);
                        if (ansMatch) {
                            q.jawaban_benar = ansMatch[1].toUpperCase();
                            i++; // consume answer line
                        } else if (!q.jawaban_benar) {
                            warnings.push(`Soal ${qNum}: Jawaban tidak ditemukan.`);
                        }

                        // Validasi kelengkapan opsi
                        const missingOpts = ['A','B','C','D'].filter(l => !q.pilihan[l]);
                        if (missingOpts.length) {
                            warnings.push(`Soal ${qNum}: Opsi ${missingOpts.join(', ')} tidak ditemukan.`);
                        }

                    } else if (type === 'ESSAY') {
                        currentSection.questions.push({
                            idq:        currentSection.questions.length + 1,
                            pertanyaan: qText,
                            media,
                            skor:       0
                        });
                        if (qNum !== currentSection.questions[currentSection.questions.length - 1].idq) {
                            warnings.push(`Bagian ${currentSection.id}: Nomor soal melompat (ditemukan ${qNum}).`);
                        }
                    }
                    continue;
                }
                // Baris lain (termasuk header lama kayak "Judul:", "Mapel:") → diabaikan
            }

            // ── Validasi akhir ─────────────────────────────────────────────
            data.sections.forEach((sec, idx) => {
                // Default type kalo kosong (kasus auto-section tanpa marker type)
                if (!sec.type_question) sec.type_question = 'PG';
                if (sec.questions.length === 0) {
                    warnings.push(`Bagian ${idx + 1}: Tidak ada soal ditemukan.`);
                }
            });

            const totalQ = data.sections.reduce((s, sec) => s + sec.questions.length, 0);
            data.totalQuestions = totalQ;

            if (data.sections.length === 0 || totalQ === 0) {
                errors.push('Tidak ada soal yang ditemukan. Pastikan format: bagian (1) / (Pilihan Ganda) / 1.pertanyaan / a.opsi / jawaban: a');
            }

            return { data, errors, warnings };
        }

        /** Apply imported soal data to WizardState — soal-only, OVERWRITE existing.
         *  Returns { appliedSections, skippedSections } supaya caller bisa kasih
         *  notif akurat saat sebagian bagian di-skip karena MAX_SECTIONS. */
        _applyImportedSoal(importData) {
            // Open wizard if not already open
            const modal = document.querySelector('#wizardModal');
            if (!modal || !modal.classList.contains('active')) {
                this.resetAndOpenWizard();
            }

            // OVERWRITE: clear existing sections dulu (removeSection mutate array → loop dari belakang)
            let safety = 20;
            while (this.state.getSections().length > 0 && safety-- > 0) {
                this.state.removeSection(this.state.getSections().length - 1);
            }

            // Apply sections + questions (soal only — TANPA header metadata)
            let appliedSections = 0;
            importData.sections.forEach((secData) => {
                const section = this.state.addSection();
                if (!section) return;   // guard MAX_SECTIONS — bagian ini di-skip
                appliedSections++;
                const sIdx = this.state.getSections().length - 1;
                this.state.updateSection(sIdx, { type_question: secData.type_question });

                secData.questions.forEach((qData) => {
                    this.state.addQuestionToSection(sIdx, secData.type_question);
                    const secs  = this.state.getSections();
                    const qIdx  = secs[sIdx].questions.length - 1;
                    const updates = { pertanyaan: qData.pertanyaan };
                    if (secData.type_question === 'PG') {
                        updates.pilihan      = qData.pilihan;
                        updates.jawaban_benar = qData.jawaban_benar;
                    }
                    this.state.updateQuestionInSection(sIdx, qIdx, updates);
                });
            });

            this.pushHistory();

            // Tetap di step 3 (Bagian Soal) biar user lihat hasil import
            this.state.setCurrentStep(3);

            // W7 fix: refreshUI() + populateStep1FromState() were unreachable
            // because the return statement was placed BEFORE them. Moved return
            // to end of function so the UI actually refreshes after DOCX import.
            this.refreshUI();
            this.populateStep1FromState();

            return {
                appliedSections,
                skippedSections: importData.sections.length - appliedSections
            };
        }
    }

    return WizardController;
})();