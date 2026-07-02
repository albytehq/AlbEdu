/**
 * WizardDOM — AlbEdu v0.4.1
 *
 * Handles all DOM manipulation: progress bar, step rendering,
 * navigation, event delegation, section/question rendering.
 *
 * Key changes in v0.4.1:
 *   - Advanced reactive progress bar with COMPLETE / WARNING / INCOMPLETE / EMPTY states
 *   - Background validation drives progress without opening steps
 *   - Step 4 renamed "Publish" with rich reviewer panel (no raw JSON)
 *   - Token display instead of JSON preview
 *   - Navigation buttons: "Publish" + "Kembali Edit" on step 4
 *   - Smooth step transitions
 */
const WizardDOM = (() => {
    let elements = {};
    let dropdownInstances = new Map();
    let eventListeners    = {};

    /**
     * resolveImageUrl — compatibility normalizer for gambar entries.
     * Handles both OLD string format and NEW { url, hash } object format.
     * @param  {string|{url:string,hash?:string}|null|undefined} img
     * @returns {string}
     */
    function resolveImageUrl(img) {
        if (!img) return '';
        if (typeof img === 'string') return img;
        if (typeof img === 'object') return img.url || '';
        return '';
    }

    // Debounced background validation timer
    let _bgValidTimer = null;
    const BG_VALID_DEBOUNCE = 400; // ms — lightweight enough to feel realtime

    const SELECTORS = {
        wizardModal:        '#wizardModal',
        createExamBtn:      '#btn-create-new-exam',
        closeWizard:        '#closeWizard',
        wizardProgress:     '#wizardProgress',
        wizardSteps:        '.wizard-step',
        prevBtn:            '#prevBtn',
        nextBtn:            '#nextBtn',
        catatanContainer:   '#catatanContainer',
        sectionsTabs:       '#sectionsTabs',
        sectionsContainer:  '#sectionsContainer',
        noSectionsState:    '#noSectionsState',
        generatedCode:      '#generatedCode',
        publishReviewer:    '#publishReviewer',
        successMessage:     '#successMessage',
        catatanToggle:      '#catatanToggle',
        scheduledContainer: '#scheduledContainer',
        saveDraftIndicator: '#saveDraftIndicator'
    };

    const initializeElements = () => {
        elements = {};
        Object.entries(SELECTORS).forEach(([key, sel]) => {
            const el = document.querySelector(sel);
            if (el) elements[key] = el;
        });
        elements.wizardSteps = document.querySelectorAll(SELECTORS.wizardSteps);
        return elements;
    };

    // ── Dropdown Manager ──────────────────────────────────────────────────────
    // W2 fix: replaced per-instance document.addEventListener('click', ...) leak
    // with a single delegated listener on document. The old code added a new
    // document click listener per DropdownManager instance (one per dropdown ×
    // every section rebuild) and never removed it — causing ~550 leaked
    // listeners after 50 question edits. The new pattern uses one global
    // delegated listener that walks the dropdownInstances Map.
    let _dropdownDocListenerInstalled = false;
    const _ensureDropdownDocListener = () => {
        if (_dropdownDocListenerInstalled) return;
        _dropdownDocListenerInstalled = true;
        document.addEventListener('click', (e) => {
            // If click is inside any dropdown, that dropdown's own toggle handles it.
            // Otherwise, close ALL open dropdowns.
            if (e.target.closest('.custom-dropdown')) return;
            dropdownInstances.forEach(inst => { if (inst.isOpen) inst.close(); });
        });
    };

    class DropdownManager {
        constructor(dropdown) {
            this.dropdown = dropdown;
            this.selected = dropdown.querySelector('.dropdown-selected');
            this.options  = dropdown.querySelector('.dropdown-options');
            this.isOpen   = false;
            this.boundToggle = this.toggle.bind(this);
            this.boundSelect = this.selectOption.bind(this);
            this.init();
        }
        init() {
            _ensureDropdownDocListener(); // installs once per page lifetime
            this.selected.addEventListener('click', this.boundToggle);
            this.options.querySelectorAll('.dropdown-option').forEach(opt =>
                opt.addEventListener('click', this.boundSelect));
            // W2 fix: NO more document.addEventListener('click', ...) per instance.
        }
        destroy() {
            this.selected.removeEventListener('click', this.boundToggle);
            this.options.querySelectorAll('.dropdown-option').forEach(opt =>
                opt.removeEventListener('click', this.boundSelect));
            this.dropdown.dropdownInstance = null;
            // W2 fix: nothing to remove from document — using global delegation.
        }
        toggle(e) { e.stopPropagation(); this.isOpen ? this.close() : this.open(); }
        open() {
            dropdownInstances.forEach(inst => { if (inst !== this) inst.close(); });
            this.options.classList.add('active');
            this.selected.classList.add('active');
            this.isOpen = true;
        }
        close() {
            this.options.classList.remove('active');
            this.selected.classList.remove('active');
            this.isOpen = false;
        }
        selectOption(e) {
            e.stopPropagation();
            const opt   = e.currentTarget;
            const value = opt.dataset.value;
            const text  = opt.textContent;
            this.selected.innerHTML = `<span>${text}</span><i class="material-symbols-outlined">expand_more</i>`;
            this.selected.dataset.value = value;
            this.options.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            this.close();
            this.dropdown.dispatchEvent(new CustomEvent('dropdown-change', {
                detail: { value, dropdown: this.dropdown.dataset.dropdown,
                          index: this.dropdown.dataset.index,
                          sectionIndex: this.dropdown.dataset.sectionIndex,
                          questionIndex: this.dropdown.dataset.questionIndex },
                bubbles: true
            }));
        }
        getValue() { return this.selected.dataset.value || ''; }
        setValue(value, text) {
            const opt = this.options.querySelector(`[data-value="${value}"]`);
            if (opt) {
                this.selected.innerHTML = `<span>${text || opt.textContent}</span><i class="material-symbols-outlined">expand_more</i>`;
                this.selected.dataset.value = value;
                this.options.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            } else if (text) {
                this.selected.innerHTML = `<span>${text}</span><i class="material-symbols-outlined">expand_more</i>`;
                this.selected.dataset.value = value;
            }
        }
        reset() {
            const label = this.dropdown.id.includes('kelas')     ? 'Pilih Kelas'    :
                          this.dropdown.id.includes('mode')      ? 'Pilih Mode'     :
                          this.dropdown.id.includes('section')   ? 'Pilih Tipe Soal' :
                          this.dropdown.id.includes('jawaban')   ? 'Pilih jawaban'  : 'Pilih Opsi';
            this.selected.innerHTML = `<span>${label}</span><i class="material-symbols-outlined">expand_more</i>`;
            this.selected.dataset.value = '';
            this.options.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('selected'));
            this.close();
        }
    }

    const initializeDropdowns = () => {
        dropdownInstances.forEach(inst => inst.destroy());
        dropdownInstances.clear();
        document.querySelectorAll('.wizard-wrapper .custom-dropdown').forEach((dd, idx) => {
            const inst = new DropdownManager(dd);
            dropdownInstances.set(dd.id || `dd-${idx}`, inst);
            dd.dropdownInstance = inst;
        });
    };

    const resetAllDropdowns = () => dropdownInstances.forEach(inst => inst.reset());

    // ── Advanced Progress Bar ─────────────────────────────────────────────────
    /**
     * Renders the progress bar with rich status per step.
     * Status comes from WizardValidation.validateAllBackground() — no step needs
     * to be opened first; we scan state directly.
     *
     * Status icons:
     *   complete    → ✓ (green)
     *   warning     → ⚠ (amber)
     *   incomplete  → ✕ (red)
     *   empty       → number (neutral)
     *   active      → number with pulse ring
     */
    const updateProgressBar = (currentStep, totalSteps, _completedSteps) => {
        if (!elements.wizardProgress) return;

        const stepNames     = WizardState.getStepNames();
        const bgResults     = WizardValidation.validateAllBackground();
        let html = '';

        for (let i = 1; i <= totalSteps; i++) {
            const result  = bgResults[i] || {};
            const status  = result.status || 'empty';
            const active  = i === currentStep;

            // Icon based on status
            let iconHtml = '';
            let stepClass = 'progress-step';

            if (active) {
                stepClass += ' active';
                iconHtml = `<span class="step-num">${i}</span>`;
            } else {
                stepClass += ` status-${status}`;
                if (status === 'complete') {
                    iconHtml = `<i class="material-symbols-outlined">check</i>`;
                } else if (status === 'warning') {
                    iconHtml = `<i class="material-symbols-outlined">priority_high</i>`;
                } else if (status === 'incomplete') {
                    iconHtml = `<i class="material-symbols-outlined">close</i>`;
                } else {
                    iconHtml = `<span class="step-num">${i}</span>`;
                }
            }

            // Count badge for errors/warnings (only on non-active steps)
            let countBadge = '';
            if (!active && status === 'incomplete' && result.errorCount > 0) {
                countBadge = `<span class="step-err-badge">${result.errorCount}</span>`;
            }
            if (!active && status === 'warning' && result.warningCount > 0) {
                countBadge = `<span class="step-warn-badge">${result.warningCount}</span>`;
            }

            html += `
                <div class="${stepClass}" data-step="${i}" data-status="${status}" title="${stepNames[i]}">
                    <div class="step-circle">
                        ${iconHtml}
                        ${countBadge}
                    </div>
                    <div class="step-name">${stepNames[i]}</div>
                </div>`;

            // Connector line between steps
            if (i < totalSteps) {
                const connClass = status === 'complete' ? 'connector-done' : '';
                html += `<div class="step-connector ${connClass}"></div>`;
            }
        }

        elements.wizardProgress.innerHTML = html;
    };

    /**
     * Trigger a debounced background validation + progress bar refresh.
     * Called after every state mutation — lightweight because validateAllBackground
     * reads from state (no DOM touching) and only updates the small progress HTML.
     */
    const scheduleProgressRefresh = (currentStep, totalSteps, completedSteps) => {
        if (_bgValidTimer) clearTimeout(_bgValidTimer);
        _bgValidTimer = setTimeout(() => {
            updateProgressBar(currentStep, totalSteps, completedSteps);
        }, BG_VALID_DEBOUNCE);
    };

    // ── Step display with smooth transition ───────────────────────────────────
    // Track active step to avoid re-triggering animation on refreshUI()
    // calls that happen within the same step (toggle video, upload, dll)
    let _lastShownStep = null;

    const showStep = (step) => {
        // Same step — just make sure it's visible, no animation re-trigger
        if (_lastShownStep === step) {
            const stepEl = document.getElementById(`step${step}`);
            if (stepEl && !stepEl.classList.contains('active')) {
                stepEl.classList.add('active');
            }
            return;
        }

        _lastShownStep = step;

        elements.wizardSteps.forEach(s => {
            s.classList.remove('active', 'step-entering');
        });
        const stepEl = document.getElementById(`step${step}`);
        if (stepEl) {
            // Add active first (display:block), then step-entering on next frame
            // so the browser sees the element before animating it — no reflow hack needed
            stepEl.classList.add('active');
            requestAnimationFrame(() => {
                stepEl.classList.add('step-entering');
                setTimeout(() => stepEl.classList.remove('step-entering'), 350);
            });
        }
    };

    // ── Navigation buttons ────────────────────────────────────────────────────
    /**
     * On step 4 (Publish):
     *   nextBtn → "Publish" with lock icon if not ready
     *   prevBtn → "Kembali Edit"
     */
    const updateNavigationButtons = (currentStep, totalSteps, publishReady) => {
        if (!elements.prevBtn || !elements.nextBtn) return;

        elements.prevBtn.disabled = currentStep === 1;

        if (currentStep === totalSteps) {
            // Kembali → "Kembali Edit"
            elements.prevBtn.innerHTML = '<i class="material-symbols-outlined">arrow_back</i> Kembali Edit';
            elements.prevBtn.disabled  = false;

            // Publish button with lock state
            if (publishReady === false) {
                elements.nextBtn.innerHTML  = '<i class="material-symbols-outlined">lock</i> Tidak Bisa Publish';
                elements.nextBtn.disabled   = true;
                elements.nextBtn.classList.add('publish-locked');
                elements.nextBtn.classList.remove('publish-ready');
            } else {
                elements.nextBtn.innerHTML  = 'Publish <i class="material-symbols-outlined">send</i>';
                elements.nextBtn.disabled   = false;
                elements.nextBtn.classList.add('publish-ready');
                elements.nextBtn.classList.remove('publish-locked');
            }
        } else {
            elements.prevBtn.innerHTML = '<i class="material-symbols-outlined">arrow_back</i> Sebelumnya';
            elements.nextBtn.innerHTML = 'Selanjutnya <i class="material-symbols-outlined">arrow_forward</i>';
            elements.nextBtn.disabled  = false;
            elements.nextBtn.classList.remove('publish-locked', 'publish-ready');
        }
    };

    // ── Publish Reviewer Panel ────────────────────────────────────────────────
    /**
     * Replaces the old JSON preview with a structured reviewer.
     * Shows: token, ready/cannot status, per-step issues, summary.
     */
    const updatePublishReviewer = (examData) => {
        const container = document.getElementById('publishReviewer');
        if (!container) return;

        const bgResults   = WizardValidation.validateAllBackground();
        const token       = examData?.ujian?.kode_id || '—';
        const stepNames   = WizardState.getStepNames();

        // Determine overall readiness (steps 1-3 must be complete or warning-only)
        const canPublish  = [1, 2, 3].every(s => {
            const st = bgResults[s]?.status;
            return st === 'complete' || st === 'warning' || st === 'empty';
        }) && [1, 3].every(s => {
            // Step 1 and 3 must be actually complete (not empty)
            const st = bgResults[s]?.status;
            return st === 'complete' || st === 'warning';
        });

        // Header HTML
        const headerHtml = canPublish
            ? `<div class="publish-status-header ready">
                    <i class="material-symbols-outlined">check_circle</i>
                    <div>
                        <strong>Siap untuk Dipublish</strong>
                        <span>Semua data wajib sudah terisi</span>
                    </div>
               </div>`
            : `<div class="publish-status-header not-ready">
                    <i class="material-symbols-outlined">lock</i>
                    <div>
                        <strong>Tidak Bisa Dipublish</strong>
                        <span>Ada data wajib yang belum lengkap</span>
                    </div>
               </div>`;

        // Token display
        const tokenHtml = `
            <div class="publish-token-card">
                <div class="publish-token-label">
                    <i class="material-symbols-outlined">key</i> Token Ujian
                </div>
                <div class="publish-token-value" id="generatedCode">${_esc(token)}</div>
                <div class="publish-token-actions">
                    <button class="btn-publish-action" data-action="copyCode">
                        <i class="material-symbols-outlined">content_copy</i> Salin Token
                    </button>
                    <button class="btn-publish-action btn-secondary-action" data-action="regenerateCode">
                        <i class="material-symbols-outlined">refresh</i> Generate Ulang
                    </button>
                </div>
                <p class="publish-token-hint">
                    <i class="material-symbols-outlined">info</i>
                    Token ini yang digunakan peserta untuk masuk ke ujian
                </p>
            </div>`;

        // Exam summary card
        const ujian = examData?.ujian || {};
        const sections = WizardState.getSections();
        const totalQ = sections.reduce((s, sec) => s + sec.questions.length, 0);
        const summaryHtml = `
            <div class="publish-summary-card">
                <div class="publish-summary-title"><i class="material-symbols-outlined">description</i> Ringkasan Ujian</div>
                <div class="publish-summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Judul</span>
                        <span class="summary-val">${_esc(ujian.judul || '—')}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Mata Pelajaran</span>
                        <span class="summary-val">${_esc(ujian.mata_pelajaran || '—')}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Kelas</span>
                        <span class="summary-val">${ujian.kelas?.[0] ? `Kelas ${ujian.kelas[0]}` : '—'}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Durasi</span>
                        <span class="summary-val">${ujian.time || '—'}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Mode Pembuka</span>
                        <span class="summary-val">${_esc(ujian.mode_pembuka || '—')}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total Soal</span>
                        <span class="summary-val">${totalQ} soal (${sections.length} bagian)</span>
                    </div>
                </div>
            </div>`;

        // Per-step reviewer rows
        let reviewerRows = '';
        for (let s = 1; s <= 3; s++) {
            const res      = bgResults[s] || {};
            const status   = res.status || 'empty';
            const errors   = Object.values(res.errors || {});
            const warnings = Object.values(res.warnings || {});

            const statusIcon = status === 'complete'   ? '<i class="material-symbols-outlined rc-complete">check_circle</i>'
                             : status === 'warning'    ? '<i class="material-symbols-outlined rc-warning">warning</i>'
                             : status === 'incomplete' ? '<i class="material-symbols-outlined rc-error">cancel</i>'
                             :                           '<i class="material-symbols-outlined rc-empty">circle</i>';

            const statusLabel = status === 'complete'   ? 'Lengkap'
                              : status === 'warning'    ? 'Ada Peringatan'
                              : status === 'incomplete' ? 'Tidak Lengkap'
                              :                          'Belum Diisi';

            let issuesList = '';
            if (errors.length > 0) {
                issuesList += errors.map(e => `<li class="ri-error"><i class="material-symbols-outlined">cancel</i> ${_esc(e)}</li>`).join('');
            }
            if (warnings.length > 0) {
                issuesList += warnings.map(w => `<li class="ri-warning"><i class="material-symbols-outlined">warning</i> ${_esc(w)}</li>`).join('');
            }

            reviewerRows += `
                <div class="reviewer-row status-row-${status}">
                    <div class="reviewer-row-header">
                        ${statusIcon}
                        <span class="reviewer-step-name">Step ${s}: ${stepNames[s]}</span>
                        <span class="reviewer-status-badge badge-${status}">${statusLabel}</span>
                    </div>
                    ${issuesList ? `<ul class="reviewer-issues">${issuesList}</ul>` : ''}
                </div>`;
        }

        const reviewerHtml = `
            <div class="publish-reviewer-section">
                <div class="publish-reviewer-title"><i class="material-symbols-outlined">assignment_turned_in</i> Review Akhir</div>
                ${reviewerRows}
            </div>`;

        container.innerHTML = headerHtml + tokenHtml + summaryHtml + reviewerHtml;

        // Update nav buttons to reflect publish readiness
        const state = WizardState.getState();
        updateNavigationButtons(state.currentStep, state.totalSteps, canPublish);

        return canPublish;
    };

    // ── Save indicator ────────────────────────────────────────────────────────
    const showSaveDraftIndicator = (savedAt) => {
        const el = document.getElementById('saveDraftIndicator');
        if (!el) return;
        const time = savedAt ? new Date(savedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
        const label = time ? `Draft tersimpan ${time}` : 'Draft tersimpan';
        // Update span inside indicator (icon + text structure)
        const span = el.querySelector('span');
        if (span) span.textContent = label;
        else el.childNodes[el.childNodes.length - 1].textContent = ' ' + label;
        el.classList.add('visible');
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => el.classList.remove('visible'), 3000);
    };

    // ── Containers ────────────────────────────────────────────────────────────
    const toggleCatatanContainer   = (show) => {
        if (elements.catatanContainer) elements.catatanContainer.style.display = show ? 'block' : 'none';
    };
    const toggleScheduledContainer = (show) => {
        if (elements.scheduledContainer) elements.scheduledContainer.style.display = show ? 'block' : 'none';
    };

    // ── Media HTML generator ──────────────────────────────────────────────────
    // NOTE: Media validation behavior unchanged per spec
    const generateMediaHTML = (media, sectionIdx, questionIdx) => {
        if (!media) return '';
        const videoEnabled = media.video?.enabled || false;
        const videoSrc     = media.video?.src || '';
        const gambarList   = media.gambar || [];

        let gambarPreviews = '';
        if (gambarList.length > 0) {
            gambarPreviews = '<div class="gambar-previews">';
            gambarList.forEach((gbr, idx) => {
                // Compat normalizer: resolves both old string URLs and new { url, hash } objects
                const imgUrl      = resolveImageUrl(gbr);
                const isNewCdn    = typeof gbr === 'object' && gbr !== null && gbr.hash;
                const isLegacyCdn = typeof gbr === 'string' && gbr.startsWith('https://');
                const isBase64    = typeof gbr === 'string' && gbr.startsWith('data:image/');
                const labelTxt = isNewCdn
                    ? `<span class="gambar-cdn-badge"><i class="material-symbols-outlined">cloud</i> CDN</span>`
                    : isLegacyCdn
                        ? `<span class="gambar-cdn-badge gambar-legacy-badge"><i class="material-symbols-outlined">history</i> CDN (lama)</span>`
                        : `<span class="gambar-cdn-badge gambar-legacy-badge"><i class="material-symbols-outlined">warning</i> Base64</span>`;
                gambarPreviews += `
                    <div class="gambar-preview-item"
                        data-image-index="${idx}"
                        data-section-index="${sectionIdx}"
                        data-question-index="${questionIdx}">
                        <img src="${imgUrl}" alt="Preview ${idx + 1}">
                        ${labelTxt}
                        <button class="btn-remove-image" data-action="removeImage"
                            data-section-index="${sectionIdx}" data-question-index="${questionIdx}" data-image-index="${idx}"
                            title="Hapus gambar">
                            <i class="material-symbols-outlined">close</i>
                        </button>
                    </div>`;
            });
            gambarPreviews += '</div>';
        }

        return `
            <div class="media-container">
                <div class="media-checkbox">
                    <label>
                        <input type="checkbox" class="media-video-toggle" data-action="toggleVideo"
                            data-section-index="${sectionIdx}" data-question-index="${questionIdx}" ${videoEnabled ? 'checked' : ''}>
                        <i class="material-symbols-outlined">videocam</i> Tambahkan Video
                    </label>
                </div>
                <div class="media-input-group" style="display: ${videoEnabled ? 'block' : 'none'}">
                    <input type="text" class="form-control youtube-url-input"
                        placeholder="Tempel URL YouTube (contoh: https://youtu.be/abc123)"
                        data-action="setYouTubeUrl"
                        data-section-index="${sectionIdx}" data-question-index="${questionIdx}"
                        value="${videoSrc || ''}">
                    <span class="youtube-url-feedback"
                        data-section-index="${sectionIdx}" data-question-index="${questionIdx}"></span>
                    <div class="youtube-preview" data-section-index="${sectionIdx}" data-question-index="${questionIdx}"
                        style="display:none;margin-top:8px;"></div>
                    <small class="text-muted">Mendukung youtube.com/watch?v=, youtu.be/, shorts/, embed/</small>
                </div>
                <div class="gambar-upload">
                    <label><i class="material-symbols-outlined">photo_library</i> Gambar (maks 4)</label>
                    <input type="file" accept="image/*" multiple class="form-control" data-action="uploadImage"
                        data-section-index="${sectionIdx}" data-question-index="${questionIdx}">
                    <small class="text-muted"><i class="material-symbols-outlined">auto_fix_high</i> Semua format diterima — otomatis dikompresi ke JPEG ≤500KB</small>
                    ${gambarPreviews}
                </div>
                <div class="validation-error" data-error="video-src-${sectionIdx}-${questionIdx}">
                    <i class="material-symbols-outlined">error</i> <span class="error-text">Video aktif tapi sumber kosong</span>
                </div>
                <div class="validation-error" data-error="gambar-count-${sectionIdx}-${questionIdx}">
                    <i class="material-symbols-outlined">error</i> <span class="error-text">Maksimal 4 gambar</span>
                </div>
                <div class="validation-error" data-error="gambar-size-${sectionIdx}-${questionIdx}">
                    <i class="material-symbols-outlined">error</i> <span class="error-text">Ukuran gambar terlalu besar</span>
                </div>
                <div class="validation-error" data-error="gambar-format-${sectionIdx}-${questionIdx}">
                    <i class="material-symbols-outlined">error</i> <span class="error-text">Format gambar tidak valid</span>
                </div>
            </div>`;
    };

    // ── Section HTML generator ────────────────────────────────────────────────
    const generateSectionHTML = (section, sectionIdx) => {
        const type     = section.type_question || '';
        const typeText = type === 'PG' ? 'Pilihan Ganda' : type === 'ESSAY' ? 'Essay' : 'Pilih Tipe Soal';

        const questionsHtml = section.questions.map((q, qIdx) => {
            if (type === 'PG') {
                return `
                    <div class="question-item-simple" data-section-index="${sectionIdx}" data-question-index="${qIdx}">
                        <div class="question-header-simple">
                            <span class="question-number-badge">Soal ${qIdx + 1} <span class="q-score-badge">+${q.skor || 0}</span></span>
                            <div class="question-actions-simple">
                                <button class="btn-move" data-action="moveQuestionUp" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">arrow_upward</i></button>
                                <button class="btn-move" data-action="moveQuestionDown" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">arrow_downward</i></button>
                                <button class="btn-delete" data-action="deleteQuestion" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">delete</i></button>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Pertanyaan *</label>
                            <textarea class="form-control" data-field="pertanyaan" data-section-index="${sectionIdx}" data-question-index="${qIdx}" rows="2">${q.pertanyaan || ''}</textarea>
                            <div class="validation-error" data-error="pertanyaan-${sectionIdx}-${qIdx}">
                                <i class="material-symbols-outlined">error</i> <span class="error-text"></span>
                            </div>
                        </div>
                        ${generateMediaHTML(q.media, sectionIdx, qIdx)}
                        <div class="options-container-simple">
                            ${['A','B','C','D'].map(letter => `
                                <div class="option-row">
                                    <span class="option-label-simple">${letter}.</span>
                                    <input type="text" class="form-control option-input-simple"
                                        data-field="pilihan-${letter}" data-section-index="${sectionIdx}" data-question-index="${qIdx}"
                                        value="${_esc(q.pilihan?.[letter] || '')}" placeholder="Opsi ${letter}">
                                    <div class="validation-error" data-error="pilihan-${letter}-${sectionIdx}-${qIdx}" style="margin-left:30px;">
                                        <i class="material-symbols-outlined">error</i> <span class="error-text"></span>
                                    </div>
                                </div>`).join('')}
                        </div>
                        <div class="validation-error" data-error="pilihan-duplicate-${sectionIdx}-${qIdx}">
                            <i class="material-symbols-outlined">error</i> <span class="error-text"></span>
                        </div>
                        <div class="answer-section">
                            <div class="form-row-simple">
                                <div class="form-group">
                                    <label>Jawaban Benar *</label>
                                    <div class="custom-dropdown" id="jawabanDropdown-${sectionIdx}-${qIdx}"
                                        data-dropdown="jawabanBenar" data-section-index="${sectionIdx}" data-question-index="${qIdx}">
                                        <div class="dropdown-selected">
                                            <span>${q.jawaban_benar ? 'Pilihan ' + q.jawaban_benar : 'Pilih jawaban'}</span>
                                            <i class="material-symbols-outlined">expand_more</i>
                                        </div>
                                        <div class="dropdown-options">
                                            <div class="dropdown-option" data-value="A">A</div>
                                            <div class="dropdown-option" data-value="B">B</div>
                                            <div class="dropdown-option" data-value="C">C</div>
                                            <div class="dropdown-option" data-value="D">D</div>
                                        </div>
                                    </div>
                                    <div class="validation-error" data-error="jawabanBenar-${sectionIdx}-${qIdx}">
                                        <i class="material-symbols-outlined">error</i> <span class="error-text"></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
            } else {
                return `
                    <div class="question-item-simple" data-section-index="${sectionIdx}" data-question-index="${qIdx}">
                        <div class="question-header-simple">
                            <span class="question-number-badge">Soal ${qIdx + 1} Essay <span class="q-score-badge">+${q.skor || 0}</span></span>
                            <div class="question-actions-simple">
                                <button class="btn-move" data-action="moveQuestionUp" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">arrow_upward</i></button>
                                <button class="btn-move" data-action="moveQuestionDown" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">arrow_downward</i></button>
                                <button class="btn-delete" data-action="deleteQuestion" data-index="${qIdx}" data-section-index="${sectionIdx}"><i class="material-symbols-outlined">delete</i></button>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Pertanyaan *</label>
                            <textarea class="form-control" data-field="pertanyaan" data-section-index="${sectionIdx}" data-question-index="${qIdx}" rows="3">${q.pertanyaan || ''}</textarea>
                            <div class="validation-error" data-error="pertanyaan-${sectionIdx}-${qIdx}">
                                <i class="material-symbols-outlined">error</i> <span class="error-text"></span>
                            </div>
                        </div>
                        ${generateMediaHTML(q.media, sectionIdx, qIdx)}
                    </div>`;
            }
        }).join('');

        return `
            <div class="section-content-header">
                <h4>${section.name}</h4>
                <span class="badge">${section.questions.length} Soal</span>
            </div>
            <div class="form-group">
                <label>Tipe Soal *</label>
                <div class="custom-dropdown" id="sectionTypeDropdown-${sectionIdx}" data-dropdown="sectionType" data-index="${sectionIdx}">
                    <div class="dropdown-selected">
                        <span>${typeText}</span>
                        <i class="material-symbols-outlined">expand_more</i>
                    </div>
                    <div class="dropdown-options">
                        <div class="dropdown-option" data-value="PG">Pilihan Ganda</div>
                        <div class="dropdown-option" data-value="ESSAY">Essay</div>
                    </div>
                </div>
                <div class="validation-error" data-error="sectionType-error-${sectionIdx}">
                    <i class="material-symbols-outlined">error</i> <span class="error-text">Tipe soal harus dipilih</span>
                </div>
            </div>
            <div class="questions-container" id="questions-${sectionIdx}">
                ${questionsHtml}
            </div>
            <div class="text-center" style="margin:20px 0;">
                <button class="btn-success" data-action="addQuestion" data-index="${sectionIdx}">
                    <i class="material-symbols-outlined">add_circle</i> Tambah Soal
                </button>
            </div>
            <div class="empty-state" id="noQuestions-${sectionIdx}" style="display:${section.questions.length === 0 ? 'flex' : 'none'}">
                <i class="material-symbols-outlined">help</i>
                <p>Belum ada soal. Klik "Tambah Soal" untuk memulai.</p>
            </div>`;
    };

    // ── Section tabs renderer ─────────────────────────────────────────────────
    const renderTabs = (sections, currentIndex) => {
        if (!elements.sectionsTabs) return;
        elements.sectionsTabs.innerHTML = sections.map((s, idx) => `
            <button class="section-tab ${idx === currentIndex ? 'active' : ''}" data-index="${idx}" data-action="switchSection">
                <i class="material-symbols-outlined">description</i> ${s.name}
                ${sections.length > 1 ? `<i data-index="${idx}" class="material-symbols-outlined remove-tab">close</i>` : ''}
            </button>`).join('');
    };

    // W1 fix: memoization cache for renderSectionContent. Old code did full
    // innerHTML rebuild on every Add/Delete/Move/section-switch — destroying
    // focus, cursor, KaTeX-rendered math, andDropdownManager instances.
    // Now we cache the signature (question count + idqs + types + skor) and
    // skip the rebuild if structure is unchanged. Typing path was already
    // non-rebuilding (debounced state update only); this extends that to
    // structural operations that don't actually change structure (e.g. tab
    // switch back to a previously-rendered section).
    const _sectionRenderCache = new Map(); // sectionIdx -> signature string

    const _computeSectionSignature = (section, sectionIdx) => {
        if (!section || !section.questions) return `empty-${sectionIdx}`;
        // Phase 8 critique fix: removed pertanyaan.length from signature.
        // Reason: typing path changes pertanyaan.length, which would invalidate
        // the cache and trigger a full rebuild on next refreshUI — defeating
        // the W1 optimization. Signature now only tracks STRUCTURAL identity
        // (question count + idqs + type + skor). Typing path doesn't call
        // refreshUI anyway (debounced state update only), but this protects
        // against future regressions.
        const qSig = section.questions.map(q =>
            `${q.idq}:${q.skor || 0}`
        ).join('|');
        return `s${sectionIdx}-t${section.type_question || ''}-n${section.questions.length}-[${qSig}]`;
    };

    const renderSectionContent = (section, sectionIdx, opts = {}) => {
        let contentEl = document.getElementById(`section-content-${sectionIdx}`);
        if (!contentEl) {
            contentEl = document.createElement('div');
            contentEl.className = 'section-content';
            contentEl.id        = `section-content-${sectionIdx}`;
            elements.sectionsContainer.appendChild(contentEl);
        }

        // W1: skip rebuild if signature unchanged (and not forced)
        const signature = _computeSectionSignature(section, sectionIdx);
        if (!opts.force && _sectionRenderCache.get(sectionIdx) === signature) {
            // Just toggle active class — content is already correct
            document.querySelectorAll('.wizard-wrapper .section-content').forEach(el => el.classList.remove('active'));
            contentEl.classList.add('active');
            return;
        }
        _sectionRenderCache.set(sectionIdx, signature);

        // Destroy existing DropdownManagers in this section before rebuild
        // (W2 fix: destroys instance-level listeners, document listener stays delegated)
        contentEl.querySelectorAll('.custom-dropdown').forEach(dd => {
            if (dd.dropdownInstance) {
                dd.dropdownInstance.destroy();
                dropdownInstances.delete(dd.id);
            }
        });

        contentEl.innerHTML = generateSectionHTML(section, sectionIdx);
        document.querySelectorAll('.wizard-wrapper .section-content').forEach(el => el.classList.remove('active'));
        contentEl.classList.add('active');

        // Init new dropdowns inside this section
        contentEl.querySelectorAll('.custom-dropdown').forEach(dd => {
            if (!dd.dropdownInstance) {
                const inst = new DropdownManager(dd);
                dropdownInstances.set(dd.id || `dd-${Date.now()}-${Math.random()}`, inst);
                dd.dropdownInstance = inst;
            }
        });

        // F4+F5: Math + RTL — only on actual rebuild (skipped when cached)
        if (typeof window.renderMathIn   === 'function') window.renderMathIn(contentEl);
        if (typeof window.applyLangClass === 'function') window.applyLangClass(contentEl);
        if (typeof window.MathPasteConverter !== 'undefined') {
            window.MathPasteConverter.attachToAll('textarea[data-field]', contentEl);
            window.MathPasteConverter.attachToAll('input[type="text"][data-field]', contentEl);
        }
    };

    // W1: invalidate cache when section changes (called by controller after mutations)
    const invalidateSectionCache = (sectionIdx) => {
        if (sectionIdx === undefined || sectionIdx === null) {
            _sectionRenderCache.clear();
        } else {
            _sectionRenderCache.delete(sectionIdx);
        }
    };

    const updateSectionsUI = (sections, currentIndex) => {
        if (!elements.sectionsTabs || !elements.sectionsContainer) return;
        renderTabs(sections, currentIndex);

        // Sync DOM containers to section count
        const existingIds = Array.from(elements.sectionsContainer.children).map(el => el.id);
        sections.forEach((_, idx) => {
            const id = `section-content-${idx}`;
            if (!existingIds.includes(id)) {
                const div = document.createElement('div');
                div.id        = id;
                div.className = 'section-content';
                elements.sectionsContainer.appendChild(div);
            }
        });
        Array.from(elements.sectionsContainer.children).forEach(el => {
            const idx = parseInt(el.id.replace('section-content-', ''));
            if (isNaN(idx) || idx >= sections.length) el.remove();
        });

        if (sections.length > 0) renderSectionContent(sections[currentIndex], currentIndex);
        if (elements.noSectionsState)
            elements.noSectionsState.style.display = sections.length === 0 ? 'flex' : 'none';
    };

    // ── Validation display ────────────────────────────────────────────────────
    const showValidationError = (field, message) => {
        const errorEl = document.querySelector(`.wizard-wrapper [data-error="${field}"]`);
        if (errorEl) {
            errorEl.style.display = 'flex';
            const span = errorEl.querySelector('.error-text');
            if (span) span.textContent = message;
            const input = document.querySelector(`.wizard-wrapper [data-field="${field}"]`) ||
                          document.querySelector(`.wizard-wrapper [data-dropdown="${field}"]`);
            if (input) input.classList.add('has-error');
        }
    };

    const hideValidationError = (field) => {
        const errorEl = document.querySelector(`.wizard-wrapper [data-error="${field}"]`);
        if (errorEl) {
            errorEl.style.display = 'none';
            const input = document.querySelector(`.wizard-wrapper [data-field="${field}"]`) ||
                          document.querySelector(`.wizard-wrapper [data-dropdown="${field}"]`);
            if (input) input.classList.remove('has-error');
        }
    };

    const hideAllValidationErrors = () => {
        document.querySelectorAll('.wizard-wrapper .validation-error').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.wizard-wrapper .has-error').forEach(el => el.classList.remove('has-error'));
    };

    // ── Modal ────────────────────────────────────────────────────────────────
    const showModal = () => {
        if (elements.wizardModal) {
            elements.wizardModal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    };
    const hideModal = () => {
        if (elements.wizardModal) {
            elements.wizardModal.classList.remove('active');
            document.body.style.overflow = '';
        }
    };

    // ── Event delegation ──────────────────────────────────────────────────────
    const setupEventDelegation = (handlers) => {
        if (eventListeners.click)    document.removeEventListener('click', eventListeners.click);
        if (eventListeners.input)    document.removeEventListener('input', eventListeners.input);
        if (eventListeners.change)   document.removeEventListener('change', eventListeners.change);
        if (eventListeners.dropdown) document.removeEventListener('dropdown-change', eventListeners.dropdown);

        eventListeners.click = (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (actionEl) {
                const action        = actionEl.dataset.action;
                const index         = actionEl.dataset.index;
                const sectionIndex  = actionEl.dataset.sectionIndex;
                const questionIndex = actionEl.dataset.questionIndex;
                const imageIndex    = actionEl.dataset.imageIndex;

                if (handlers[action]) {
                    if (action === 'removeImage') {
                        handlers[action](parseInt(sectionIndex), parseInt(questionIndex), parseInt(imageIndex));
                    } else if (action === 'toggleVideo') {
                        handlers[action](sectionIndex, questionIndex, actionEl.checked);
                    } else {
                        handlers[action](index, actionEl);
                    }
                }
                e.stopPropagation();
            }

            if (e.target.closest('.remove-tab')) {
                const idx = e.target.closest('.remove-tab').dataset.index;
                if (handlers.removeSection) handlers.removeSection(parseInt(idx));
                e.stopPropagation();
            } else if (e.target.closest('.section-tab') && !e.target.closest('.remove-tab')) {
                const idx = e.target.closest('.section-tab').dataset.index;
                if (handlers.switchSection) handlers.switchSection(parseInt(idx));
                e.stopPropagation();
            }
        };

        eventListeners.input = (e) => {
            const { action, field, sectionIndex, questionIndex } = e.target.dataset;
            if ((action === 'setYouTubeUrl' || action === 'updateVideoUrl') && handlers.setYouTubeUrl)
                handlers.setYouTubeUrl(e.target.value, parseInt(sectionIndex), parseInt(questionIndex));
            else if (field && handlers.inputChange)
                handlers.inputChange(field, e.target.value, sectionIndex, questionIndex);
        };

        eventListeners.change = (e) => {
            const { action, sectionIndex, questionIndex, field } = e.target.dataset;
            if (action === 'uploadImage' && e.target.files.length > 0 && handlers.uploadImage) {
                handlers.uploadImage(Array.from(e.target.files), parseInt(sectionIndex), parseInt(questionIndex));
                e.target.value = '';
            } else if (field && handlers.inputChange) {
                handlers.inputChange(field, e.target.value, sectionIndex, questionIndex);
            }
        };

        eventListeners.dropdown = (e) => {
            const { value, dropdown, index, sectionIndex, questionIndex } = e.detail;
            if (handlers.dropdownChange)
                handlers.dropdownChange(dropdown, value, index, sectionIndex, questionIndex);
        };

        document.addEventListener('click',           eventListeners.click);
        document.addEventListener('input',           eventListeners.input);
        document.addEventListener('change',          eventListeners.change);
        document.addEventListener('dropdown-change', eventListeners.dropdown);
    };

    // ── Utility ───────────────────────────────────────────────────────────────
    const _esc = (str) =>
        String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        initializeElements,
        initializeDropdowns,
        resetAllDropdowns,
        updateProgressBar,
        scheduleProgressRefresh,
        showStep,
        updateNavigationButtons,
        updatePublishReviewer,
        showSaveDraftIndicator,
        toggleCatatanContainer,
        toggleScheduledContainer,
        updateSectionsUI,
        invalidateSectionCache,  // W1: expose for controller to call after mutations
        showValidationError,
        hideValidationError,
        hideAllValidationErrors,
        showModal,
        hideModal,
        setupEventDelegation
    };
})();