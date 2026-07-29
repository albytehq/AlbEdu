// create-assessment.js — page controller for the "Buat Asesmen" wizard.
// Owns the wizard state (examData), score recalculation, access-code
// generation, validation, and publish to the `assessments` table.

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const SCHEMA_VERSION = '1.0.0';
  const GLOBAL_SKOR = 100;
  const MAX_SECTIONS = 2;
  const MAX_QUESTIONS_PER_SECTION = 50;
  const MAX_TOTAL_QUESTIONS = 100;
  const ACCESS_CODE_LENGTH = 6;

  function defaultIdentityFields() {
    return [
      {
        id: 'field_nama_' + Math.random().toString(36).slice(2, 8),
        type: 'text',
        label: 'Nama',
        placeholder: 'Masukkan nama lengkap',
        required: true,
        max_length: 50,
      },
      {
        id: 'field_kelas_' + Math.random().toString(36).slice(2, 8),
        type: 'select',
        label: 'Kelas',
        required: true,
        options: ['7A', '7B', '7C', '7D'],
      },
    ];
  }

  const _state = {
    examData: {
      access_code: null,
      title: '',
      subject: '',
      identity_mode: 'manual',
      identity_config: { fields: defaultIdentityFields() },
      access_mode: 'manual',
      duration_minutes: 60,
      note_enabled: false,
      note_text: null,
      max_pages_per_section: 3,
      total_score: GLOBAL_SKOR,
      theme_config: {
        version: '1.0',
        preset: 'default',
        primary: '#2563eb',
        font: 'Plus Jakarta Sans',
        mode: 'auto',
      },
      allow_retake: false,
      sections: [],
    },
    scheduled_start: null,
    ac_manual_status: 'closed',
    ac_override: false,
    ac_end: null,
    ac_remaining_time: null,
    generatedCodes: [],
  };

  const _listeners = new Set();
  let _lastTotalQ = 0, _lastBase = 0, _lastRem = 0;

  // Score recalculation. Memoizes by (totalQ, base, rem) so a no-op setState
  // (for example typing in a non-score field) doesn't churn the questions array.
  function recalculateScores(state) {
    const totalQ = state.examData.sections.reduce((sum, sec) => sum + sec.questions.length, 0);
    if (totalQ === 0) return state;
    const base = Math.floor(GLOBAL_SKOR / totalQ);
    const rem = GLOBAL_SKOR % totalQ;

    if (totalQ === _lastTotalQ && base === _lastBase && rem === _lastRem) {
      let c = 0;
      for (const sec of state.examData.sections) {
        for (const q of sec.questions) {
          const newSkor = base + (c++ < rem ? 1 : 0);
          if (q.skor !== newSkor) q.skor = newSkor;
        }
      }
      return state;
    }
    _lastTotalQ = totalQ; _lastBase = base; _lastRem = rem;
    let c = 0;
    state.examData.sections = state.examData.sections.map((sec) => ({
      ...sec,
      questions: sec.questions.map((q) => ({ ...q, skor: base + (c++ < rem ? 1 : 0) })),
    }));
    return state;
  }

  // 6-digit access code; ensure it's unique within this session's seen set.
  function generateAccessCode() {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (_state.generatedCodes.includes(code));
    _state.examData.access_code = code;
    _state.generatedCodes.push(code);
    return code;
  }

  const CreateAssessment = {
    SCHEMA_VERSION,
    GLOBAL_SKOR,
    MAX_SECTIONS,
    MAX_QUESTIONS_PER_SECTION,
    MAX_TOTAL_QUESTIONS,

    getState() {
      return JSON.parse(JSON.stringify(_state));
    },

    setState(patch) {
      if (patch && typeof patch === 'object') {
        Object.assign(_state, patch);
      }
      recalculateScores(_state);
      _listeners.forEach((fn) => {
        try { fn(_state); } catch (e) { console.error('[CreateAssessment] listener threw:', e); }
      });
    },

    subscribe(fn) {
      _listeners.add(fn);
      return () => _listeners.delete(fn);
    },

    // Section operations
    addSection() {
      if (_state.examData.sections.length >= MAX_SECTIONS) return null;
      const id = _state.examData.sections.length + 1;
      const section = { id, name: `Bagian ${id}`, type_question: '', questions: [] };
      _state.examData.sections.push(section);
      this.setState({});
      return section;
    },

    removeSection(index) {
      _state.examData.sections.splice(index, 1);
      _state.examData.sections.forEach((s, i) => {
        s.id = i + 1;
        s.name = `Bagian ${i + 1}`;
      });
      this.setState({});
    },

    updateSection(index, updates) {
      const sec = _state.examData.sections[index];
      if (!sec) return;
      if (updates.type_question && updates.type_question !== sec.type_question) {
        sec.questions = [];
      }
      Object.assign(sec, updates);
      this.setState({});
    },

    // Question operations
    addQuestion(sectionIndex, type) {
      const sec = _state.examData.sections[sectionIndex];
      if (!sec) return null;
      if (sec.questions.length >= MAX_QUESTIONS_PER_SECTION) return null;
      const totalQ = _state.examData.sections.reduce((s, x) => s + x.questions.length, 0);
      if (totalQ >= MAX_TOTAL_QUESTIONS) return null;
      if (!sec.type_question) return null;
      if (type && type !== sec.type_question) return null;

      const idq = sec.questions.length + 1;
      const media = { video: { enabled: false, src: null }, gambar: [] };
      const q = type === 'PG'
        ? { idq, pertanyaan: '', pilihan: { A: '', B: '', C: '', D: '' }, jawaban_benar: '', media: JSON.parse(JSON.stringify(media)) }
        : { idq, pertanyaan: '', media: JSON.parse(JSON.stringify(media)) };
      sec.questions.push(q);
      this.setState({});
      return q;
    },

    updateQuestion(sectionIndex, questionIndex, updates) {
      const sec = _state.examData.sections[sectionIndex];
      if (!sec) return;
      const q = sec.questions[questionIndex];
      if (!q) return;
      Object.assign(q, updates);
      this.setState({});
    },

    removeQuestion(sectionIndex, questionIndex) {
      const sec = _state.examData.sections[sectionIndex];
      if (!sec) return;
      sec.questions.splice(questionIndex, 1);
      sec.questions.forEach((q, i) => { q.idq = i + 1; });
      this.setState({});
    },

    // Access code
    generateToken() {
      const code = generateAccessCode();
      this.setState({});
      return code;
    },
    getToken() { return _state.examData.access_code; },

    // Export for Supabase
    exportAssessmentData() {
      const data = JSON.parse(JSON.stringify(_state.examData));
      // Scheduled end = scheduled start + duration (minutes).
      if (data.access_mode === 'scheduled' && _state.scheduled_start) {
        const start = new Date(_state.scheduled_start);
        if (!isNaN(start.getTime())) {
          data._scheduled_end = new Date(start.getTime() + data.duration_minutes * 60000).toISOString();
        }
      }
      return data;
    },

    // Validate
    validate() {
      const errors = [];
      const u = _state.examData;

      if (!u.title) {
        errors.push({ field: 'title', message: t('create.err_title_required', null, 'Judul asesmen harus diisi') });
      } else if (u.title.trim().length < 5) {
        errors.push({ field: 'title', message: t('create.err_title_min', null, 'Judul min. 5 karakter') });
      }

      if (!u.subject) {
        errors.push({ field: 'subject', message: t('create.err_subject_required', null, 'Mata pelajaran harus diisi') });
      }

      const mode = u.identity_mode;
      if (!mode || (mode !== 'manual' && mode !== 'daftar')) {
        errors.push({ field: 'identity_mode', message: t('create.err_identity_mode_required', null, 'Mode identitas harus dipilih') });
      } else if (mode === 'manual') {
        const fields = u.identity_config?.fields || [];
        if (!fields.length) {
          errors.push({ field: 'identity_fields', message: t('create.err_manual_min_field', null, 'Manual: minimal 1 field') });
        } else if (!fields.some((f) => (f.label || '').toLowerCase().includes('nama'))) {
          errors.push({ field: 'identity_fields', message: t('create.err_manual_name_field', null, 'Minimal 1 field dengan label "nama"') });
        }
      } else if (mode === 'daftar') {
        if (!u.identity_config?.daftar_id) {
          errors.push({ field: 'identity_daftar', message: t('create.err_daftar_required', null, 'Pilih daftar nama') });
        }
      }

      const durasi = parseInt(u.duration_minutes, 10);
      if (isNaN(durasi) || durasi < 1 || durasi > 120) {
        errors.push({ field: 'duration_minutes', message: t('create.err_duration_range', null, 'Durasi 1-120 menit') });
      }

      if (u.note_enabled && (!u.note_text || !u.note_text.trim())) {
        errors.push({ field: 'note_text', message: t('create.err_note_required', null, 'Isi catatan jika catatan aktif') });
      }

      if (u.access_mode === 'scheduled' && !_state.scheduled_start) {
        errors.push({ field: 'scheduled_start', message: t('create.err_scheduled_start_required', null, 'Waktu mulai harus diisi') });
      }

      if (_state.examData.sections.length === 0) {
        errors.push({ field: 'sections', message: t('create.err_min_sections', null, 'Minimal 1 bagian soal') });
      } else {
        _state.examData.sections.forEach((sec, idx) => {
          if (!sec.type_question) {
            errors.push({ field: `section[${idx}].type`, message: t('create.err_section_type', { n: idx + 1 }, `Bagian ${idx + 1}: pilih tipe soal`) });
            return;
          }
          if (sec.questions.length < 3) {
            errors.push({ field: `section[${idx}].questions`, message: t('create.err_section_min_questions', { n: idx + 1, count: sec.questions.length }, `Bagian ${idx + 1}: minimal 3 soal (saat ini ${sec.questions.length})`) });
          }
          sec.questions.forEach((q, qIdx) => {
            const cleanQ = (q.pertanyaan || '').replace(/<[^>]*>/g, '').trim();
            if (!cleanQ) {
              errors.push({ field: `q[${idx}][${qIdx}]`, message: t('create.err_question_required', { sec: idx + 1, q: qIdx + 1 }, `Bagian ${idx + 1} Soal ${qIdx + 1}: pertanyaan harus diisi`) });
            } else if (cleanQ.length < 3) {
              errors.push({ field: `q[${idx}][${qIdx}]`, message: t('create.err_question_too_short', { sec: idx + 1, q: qIdx + 1 }, `Bagian ${idx + 1} Soal ${qIdx + 1}: pertanyaan terlalu pendek`) });
            }
            if (sec.type_question === 'PG') {
              if (!q.jawaban_benar) {
                errors.push({ field: `q[${idx}][${qIdx}]`, message: t('create.err_correct_answer', { sec: idx + 1, q: qIdx + 1 }, `Bagian ${idx + 1} Soal ${qIdx + 1}: pilih jawaban benar`) });
              }
              ['A', 'B', 'C', 'D'].forEach((k) => {
                if (!q.pilihan?.[k]?.trim()) {
                  errors.push({ field: `q[${idx}][${qIdx}]`, message: t('create.err_option_required', { sec: idx + 1, q: qIdx + 1, k }, `Bagian ${idx + 1} Soal ${qIdx + 1}: opsi ${k} harus diisi`) });
                }
              });
            }
          });
        });
      }

      return { valid: errors.length === 0, errors };
    },

    // Publish to Supabase (assessments table)
    async publishToSupabase() {
      const { valid, errors } = this.validate();
      if (!valid) {
        throw new Error(errors[0]?.message || 'Validasi gagal');
      }

      if (!this.getToken()) {
        this.generateToken();
      }

      const repo = window.AlbEdu?.repository;
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      if (!user) throw new Error('User tidak terautentikasi');
      if (!repo) throw new Error('Platform layer belum siap');

      const data = this.exportAssessmentData();
      const now = new Date().toISOString();

      // addDoc returns the inserted row with its generated UUID PK.
      const payload = {
        access_code: data.access_code,
        organization_id: null, // single-tenant mode
        created_by: user.id,
        created_by_email: user.email || null,
        published_at: now,
        title: data.title,
        subject: data.subject,
        duration_minutes: data.duration_minutes,
        access_mode: data.access_mode,
        note_enabled: data.note_enabled,
        note_text: data.note_text,
        max_pages_per_section: data.max_pages_per_section,
        total_score: data.total_score,
        theme_config: data.theme_config,
        identity_mode: data.identity_mode,
        identity_config: data.identity_config,
        sections: data.sections,
        allow_retake: data.allow_retake,
        status: 'active',
        ac_manual_status: 'closed',
        ac_override: false,
        ac_end: null,
        ac_remaining_time: null,
        ac_scheduled_start: data.access_mode === 'scheduled' ? _state.scheduled_start : null,
        ac_scheduled_end: data._scheduled_end || null,
        created_at: now,
        updated_at: now,
      };

      const docRef = await repo.addDoc('assessments', payload);

      // Audit log via the native RPC service (non-blocking; auth token is
      // auto-attached by the platform layer).
      try {
        await window.AlbEdu?.supabase?.rpc?.invoke('assessment-lifecycle', {
          assessment_id: docRef.id,
          action: 'publish',
        });
      } catch (err) {
        console.warn('[publish] audit log failed (non-blocking):', err);
      }

      return { id: docRef.id, access_code: data.access_code };
    },
  };

  window.CreateAssessment = CreateAssessment;
  window.BuatUjian = CreateAssessment; // back-compat alias

  // Bootstrap
  document.addEventListener('DOMContentLoaded', () => {
    if (window.ThemeSystem) {
      window.ThemeSystem.apply(_state.examData.theme_config);
    }

    initThemeEditor();

    // Wizard modules auto-init if loaded.
    if (window.MetadataCard) window.MetadataCard.init();
    if (window.SoalCard) window.SoalCard.init();
    if (window.PublishCard) window.PublishCard.init();
    if (window.SoalEditorModal) window.SoalEditorModal.init();
    if (window.TemplatePicker) window.TemplatePicker.init();
    if (window.WizardController) window.WizardController.init();
    if (window.ListView) window.ListView.init();
    if (window.KeyboardShortcuts) window.KeyboardShortcuts.init();

    console.info('[CreateAssessment] initialized');
  });

  // Theme Editor (production-grade with Default/Custom toggle + scoped overlay)
  function initThemeEditor() {
    // ── Toggle refs (Default / Custom) ──
    const toggleInputs = document.querySelectorAll('input[name="theme_mode_toggle"]');
    const customActions = document.getElementById('theme-custom-actions');
    const btnOpenOverlay = document.getElementById('btn-open-theme-overlay');

    // ── Current theme info refs (shown when Custom selected) ──
    const currentSwatch = document.getElementById('theme-current-swatch');
    const currentName = document.getElementById('theme-current-name');
    const currentDetail = document.getElementById('theme-current-detail');

    // ── Overlay refs ──
    const overlay = document.getElementById('theme-overlay');
    const overlayShell = overlay?.querySelector('.albedu-theme-overlay-shell');
    const presetChips = overlay?.querySelectorAll('#overlay-preset-chips .albedu-preset-chip');
    const colorPicker = document.getElementById('overlay-color-picker');
    const colorHex = document.getElementById('overlay-color-hex');
    const colorReset = document.getElementById('overlay-color-reset');
    const colorQuickpicks = document.getElementById('overlay-color-quickpicks');
    const fontSelect = document.getElementById('overlay-theme-font');
    const modeSelect = document.getElementById('overlay-theme-mode');
    const resetBtn = document.getElementById('theme-overlay-reset');
    const cancelBtn = document.getElementById('theme-overlay-cancel');
    const saveBtn = document.getElementById('theme-overlay-save');
    const wcagStatus = document.getElementById('overlay-wcag-status');
    const previewRoot = document.getElementById('overlay-preview-root');
    const previewMeta = document.getElementById('overlay-preview-meta');

    if (!toggleInputs.length || !overlay || !window.ThemeSystem) {
      console.warn('[theme] ThemeSystem not loaded or theme elements missing');
      return;
    }

    // ── Draft theme (working copy inside overlay; committed to _state on Save) ──
    let draftTheme = { ..._state.examData.theme_config };
    let savedThemeSnapshot = null; // captured on overlay open, restored on Cancel

    // Build quick-pick color buttons
    const quickColors = window.ThemeSystem.getQuickColors();
    colorQuickpicks.innerHTML = quickColors.map((c) =>
      `<button class="albedu-color-swatch-btn" data-color="${c.hex}" style="background: ${c.hex};" title="${c.name}" type="button"></button>`
    ).join('');

    function updateActiveColor(hex) {
      colorQuickpicks.querySelectorAll('.albedu-color-swatch-btn').forEach((btn) => {
        btn.classList.toggle('albedu-active', btn.dataset.color.toLowerCase() === hex.toLowerCase());
      });
    }

    // ── SCOPED theme injector ──
    // Injects CSS variables ONLY into the overlay preview root element.
    // Never touches documentElement — the wizard form stays unaffected.
    // Variable names match take-assessment.css so the preview resolves
    // identically to the actual peserta experience.
    function injectScopedTheme(theme) {
      if (!previewRoot) return;
      const derived = window.ThemeSystem.derive(theme.primary || '#2563eb');
      previewRoot.style.setProperty('--albedu-primary', derived.primary);
      previewRoot.style.setProperty('--albedu-primary-hover', derived.primary_hover);
      previewRoot.style.setProperty('--albedu-primary-muted', derived.primary_muted);
      previewRoot.style.setProperty('--albedu-primary-ring', derived.primary_ring);
      previewRoot.style.setProperty('--albedu-heading', derived.heading);
      previewRoot.style.setProperty('--albedu-body', derived.body);
      previewRoot.style.setProperty('--albedu-surface', derived.surface);
      previewRoot.style.setProperty('--albedu-surface-alt', derived.surface_alt);
      previewRoot.style.setProperty('--albedu-border', derived.border);
      previewRoot.style.setProperty('--albedu-font', `'${theme.font || 'Plus Jakarta Sans'}', system-ui, sans-serif`);
      previewRoot.style.setProperty('--albedu-radius-lg', '8px');

      // Dark mode (scoped to preview root only)
      const mode = theme.mode || 'auto';
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (mode === 'dark' || (mode === 'auto' && prefersDark)) {
        previewRoot.setAttribute('data-mode', 'dark');
        previewRoot.style.setProperty('--albedu-surface', '#1e293b');
        previewRoot.style.setProperty('--albedu-surface-alt', '#0f172a');
        previewRoot.style.setProperty('--albedu-heading', '#f1f5f9');
        previewRoot.style.setProperty('--albedu-body', '#cbd5e1');
        previewRoot.style.setProperty('--albedu-border', '#334155');
        previewRoot.style.setProperty('--albedu-primary-muted', 'rgba(59, 130, 246, 0.18)');
      } else {
        previewRoot.setAttribute('data-mode', 'light');
      }
    }

    // Update overlay control values + preview to reflect draftTheme
    function syncOverlayFromDraft() {
      // Preset chips
      presetChips?.forEach((chip) => {
        chip.classList.toggle('albedu-active', chip.dataset.preset === draftTheme.preset);
      });

      // Color picker + hex
      if (colorPicker) colorPicker.value = draftTheme.primary;
      if (colorHex) colorHex.textContent = draftTheme.primary;
      updateActiveColor(draftTheme.primary);

      // Font + mode selects
      if (fontSelect) fontSelect.value = draftTheme.font;
      if (modeSelect) modeSelect.value = draftTheme.mode;

      // WCAG validation
      if (wcagStatus) {
        const validation = window.ThemeSystem.validate(draftTheme.primary);
        if (validation.allPass) {
          wcagStatus.className = 'albedu-wcag-status albedu-wcag-pass';
          wcagStatus.innerHTML = '<span style="font-size: 14px;" data-albedu-icon="check_circle"></span><span>Contrast OK (Pass)</span>';
        } else {
          wcagStatus.className = 'albedu-wcag-status albedu-wcag-fail';
          wcagStatus.innerHTML = '<span style="font-size: 14px;" data-albedu-icon="warning"></span><span>Warna ini mungkin sulit dibaca. Coba warna lebih gelap.</span>';
        }
      }

      // Preview meta (top-right small label)
      if (previewMeta) {
        const modeLabel = { auto: 'Otomatis', light: 'Terang', dark: 'Gelap' }[draftTheme.mode] || 'Otomatis';
        previewMeta.textContent = `${draftTheme.font} · ${modeLabel}`;
      }

      // Inject scoped theme into preview root
      injectScopedTheme(draftTheme);
    }

    // Update the small theme info card shown in the wizard form (Custom mode)
    function syncWizardThemeInfo() {
      if (currentSwatch) currentSwatch.style.background = _state.examData.theme_config.primary;
      if (currentName) {
        currentName.textContent = _state.examData.theme_config.preset === 'default'
          ? 'Default'
          : (_state.examData.theme_config.preset === 'custom' ? 'Custom' : _state.examData.theme_config.preset);
      }
      if (currentDetail) {
        const modeLabel = { auto: 'Otomatis', light: 'Terang', dark: 'Gelap' }[_state.examData.theme_config.mode] || 'Otomatis';
        currentDetail.textContent = `${_state.examData.theme_config.font} · ${modeLabel} · ${_state.examData.theme_config.primary}`;
      }
    }

    // ── Toggle: Default / Custom ──
    toggleInputs.forEach((input) => {
      input.addEventListener('change', (e) => {
        const isCustom = e.target.value === 'custom';
        if (customActions) customActions.hidden = !isCustom;

        if (isCustom) {
          // User switching to Custom — keep current theme_config as draft
          draftTheme = { ..._state.examData.theme_config };
          syncWizardThemeInfo();
        } else {
          // User switching to Default — reset theme_config to defaults
          _state.examData.theme_config = {
            version: '1.0',
            preset: 'default',
            primary: '#2563eb',
            font: 'Plus Jakarta Sans',
            mode: 'auto',
          };
          window.CreateAssessment.setState({ examData: _state.examData });
        }
      });
    });

    // Initialize toggle state from saved theme_config
    const initialIsCustom = _state.examData.theme_config.preset !== 'default';
    if (initialIsCustom) {
      toggleInputs.forEach((input) => {
        input.checked = input.value === 'custom';
      });
      if (customActions) customActions.hidden = false;
      syncWizardThemeInfo();
    }

    // ── Open overlay ──
    btnOpenOverlay?.addEventListener('click', () => {
      // Snapshot current theme_config so Cancel can restore
      savedThemeSnapshot = { ..._state.examData.theme_config };
      draftTheme = { ..._state.examData.theme_config };

      // Show overlay with animation
      overlay.hidden = false;
      overlay.setAttribute('aria-hidden', 'false');
      // Trigger animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => overlay.classList.add('is-visible'));
      });
      document.body.style.overflow = 'hidden'; // lock scroll

      syncOverlayFromDraft();
      _startPreviewInteractions();
    });

    // ── Close overlay (with animation) ──
    function closeOverlay() {
      overlay.classList.remove('is-visible');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      _stopPreviewInteractions();
      // Wait for transition before hiding
      setTimeout(() => {
        overlay.hidden = true;
      }, 220);
    }

    // ── Preview interactions (clickable options/tabs/nav — NO live timer) ──
    // The preview is decorative (for theme visualization), but making it
    // interactive sells the "this is what your students will see" feeling.
    // All interactions are scoped to the preview root — never affect wizard form.
    //
    // NOTE: Timer stays STATIC at "60:00" — countdown disabled per user
    // request. The timer pill still shows the duration but doesn't tick.
    // Warning/critical states can still be triggered via _updateTimerDisplay
    // if a developer later wants to test them.
    let previewTimerId = null;            // kept for back-compat — always null now
    let previewSecondsRemaining = 60 * 60; // 60 minutes (static, never decremented)
    let previewActiveIdx = 0;
    const PREVIEW_TOTAL_QUESTIONS = 20;

    function _formatTimer(seconds) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function _updateProgressFill() {
      const fill = previewRoot?.querySelector('.exam-progress-fill');
      if (!fill) return;
      // 3 questions answered out of 20 = 15% (matches initial static state)
      const answeredCount = previewRoot?.querySelectorAll('.option-item.selected').length || 0;
      const pct = (answeredCount / PREVIEW_TOTAL_QUESTIONS) * 100;
      fill.style.width = pct + '%';
    }

    function _updateNavProgress() {
      const progress = previewRoot?.querySelector('.exam-nav__progress');
      if (progress) {
        const answeredCount = previewRoot?.querySelectorAll('.option-item.selected').length || 0;
        progress.textContent = `${answeredCount}/${PREVIEW_TOTAL_QUESTIONS}`;
      }
    }

    function _updateTimerDisplay() {
      // Display the static value (60:00). Warning/critical classes
      // never toggle here since the timer doesn't decrement.
      const timerText = previewRoot?.querySelector('.exam-timer span:last-child');
      if (timerText) timerText.textContent = _formatTimer(previewSecondsRemaining);
    }

    function _startPreviewInteractions() {
      _stopPreviewInteractions(); // idempotent — kill any prior timer

      // Reset state on each open
      previewSecondsRemaining = 60 * 60;
      previewActiveIdx = 0;
      _updateTimerDisplay();
      _updateProgressFill();
      _updateNavProgress();

      // NO live timer countdown — timer stays static at "60:00".
      // User-identified: timer shouldn't tick in this preview.

      // ── Wire option selection (click option → toggle selected) ──
      previewRoot?.querySelectorAll('.option-item').forEach((opt) => {
        opt.addEventListener('click', () => {
          const list = opt.closest('.option-list');
          if (!list) return;
          // Single-select within a question: clear siblings, then toggle self
          const wasSelected = opt.classList.contains('selected');
          list.querySelectorAll('.option-item').forEach((o) => {
            o.classList.remove('selected');
            o.setAttribute('aria-checked', 'false');
          });
          if (!wasSelected) {
            opt.classList.add('selected');
            opt.setAttribute('aria-checked', 'true');
          }
          // Update parent question card .answered state
          const card = opt.closest('.exam-question-card');
          if (card) {
            const hasSelected = !!list.querySelector('.option-item.selected');
            card.classList.toggle('answered', hasSelected);
          }
          _updateProgressFill();
          _updateNavProgress();
        });
      });

      // ── Wire page tabs (Identitas / Bagian 1 / Bagian 2 click → switch section) ──
      // Three tabs represent the full peserta journey:
      //   1. Identitas — fill identity form (Phase 2 in take.html)
      //   2. Bagian 1 — question section 1 (Phase 3, section 1)
      //   3. Bagian 2 — question section 2 (Phase 3, section 2)
      // Each tab shows/hides its corresponding <section data-section="...">
      const TAB_ORDER = ['identitas', 'bagian-1', 'bagian-2'];

      function _activateTab(tabName) {
        if (!TAB_ORDER.includes(tabName)) return;
        // Update tab buttons
        previewRoot?.querySelectorAll('.page-tab').forEach((t) => {
          const isActive = t.dataset.tab === tabName;
          t.classList.toggle('active', isActive);
          t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        // Show/hide section panels
        previewRoot?.querySelectorAll('[data-section]').forEach((sec) => {
          sec.hidden = sec.dataset.section !== tabName;
        });
        // Update progress based on which tab
        const fill = previewRoot?.querySelector('.exam-progress-fill');
        if (fill) {
          if (tabName === 'identitas') {
            fill.style.width = '0%'; // not started yet
          } else {
            // Bagian 1 = ~50%, Bagian 2 = ~100% (mock progress)
            fill.style.width = tabName === 'bagian-1' ? '50%' : '100%';
          }
        }
        // Update nav progress text
        const progress = previewRoot?.querySelector('.exam-nav__progress');
        if (progress) {
          if (tabName === 'identitas') {
            progress.textContent = 'Identitas';
          } else {
            // Count selected answers in the visible section
            const visibleSection = previewRoot?.querySelector(`[data-section="${tabName}"]`);
            const answeredInSec = visibleSection?.querySelectorAll('.option-item.selected').length || 0;
            const totalInSec = tabName === 'bagian-1' ? 10 : 5;
            progress.textContent = `${answeredInSec}/${totalInSec}`;
          }
        }
      }

      previewRoot?.querySelectorAll('.page-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          _activateTab(tab.dataset.tab);
        });
      });

      // ── Wire Prev/Next buttons ──
      // Prev/Next cycle through the 3 tabs in order: Identitas ↔ Bagian 1 ↔ Bagian 2.
      // When on Identitas, Next → Bagian 1 (simulates "Mulai Asesmen").
      // When on Bagian 2, Next disabled (at end).
      const navBtns = previewRoot?.querySelectorAll('.nav-btn');
      const prevBtn = navBtns?.[0]; // first nav-btn = Sebelumnya
      const nextBtn = navBtns?.[1]; // second = Selanjutnya

      function _currentTabIdx() {
        const activeTab = previewRoot?.querySelector('.page-tab.active');
        if (!activeTab) return 0;
        return TAB_ORDER.indexOf(activeTab.dataset.tab);
      }

      prevBtn?.addEventListener('click', () => {
        const idx = _currentTabIdx();
        if (idx > 0) _activateTab(TAB_ORDER[idx - 1]);
      });
      nextBtn?.addEventListener('click', () => {
        const idx = _currentTabIdx();
        if (idx < TAB_ORDER.length - 1) _activateTab(TAB_ORDER[idx + 1]);
      });

      // ── Wire "Mulai Asesmen" button in identity form ──
      // Clicking it advances to Bagian 1 (same as Next).
      previewRoot?.querySelector('.preview-identity-submit')?.addEventListener('click', () => {
        _activateTab('bagian-1');
      });

      // Initialize: Identitas tab active by default (matches HTML default state)
      _activateTab('identitas');
    }

    function _stopPreviewInteractions() {
      if (previewTimerId) {
        clearInterval(previewTimerId);
        previewTimerId = null;
      }
      // Note: option/tab/nav click listeners stay attached but are inert
      // when overlay is hidden — no need to remove them (preview root is
      // always in DOM, just hidden). They'll work again when overlay reopens.
    }

    cancelBtn?.addEventListener('click', () => {
      // Discard draft, restore snapshot
      if (savedThemeSnapshot) {
        _state.examData.theme_config = savedThemeSnapshot;
        window.CreateAssessment.setState({ examData: _state.examData });
        syncWizardThemeInfo();
      }
      closeOverlay();
    });

    saveBtn?.addEventListener('click', () => {
      // Commit draft to state
      _state.examData.theme_config = { ...draftTheme };
      window.CreateAssessment.setState({ examData: _state.examData });
      syncWizardThemeInfo();
      window.notify?.success?.(
        'Tema Disimpan',
        'Tema visual berhasil diterapkan ke asesmen.',
        2000
      );
      closeOverlay();
    });

    resetBtn?.addEventListener('click', () => {
      // Reset draft to defaults (does NOT save — user still needs to click Terapkan)
      draftTheme = {
        version: '1.0',
        preset: 'default',
        primary: '#2563eb',
        font: 'Plus Jakarta Sans',
        mode: 'auto',
      };
      syncOverlayFromDraft();
    });

    // ── Preset chips ──
    presetChips?.forEach((chip) => {
      chip.addEventListener('click', () => {
        const preset = window.ThemeSystem.getPreset(chip.dataset.preset);
        draftTheme = {
          ...draftTheme,
          preset: preset.id,
          primary: preset.primary,
          font: preset.font,
          mode: preset.mode,
        };
        syncOverlayFromDraft();
      });
    });

    // ── Color quickpicks ──
    colorQuickpicks?.addEventListener('click', (e) => {
      const btn = e.target.closest('.albedu-color-swatch-btn');
      if (!btn) return;
      draftTheme = { ...draftTheme, preset: 'custom', primary: btn.dataset.color };
      syncOverlayFromDraft();
    });

    // ── Color picker ──
    colorPicker?.addEventListener('input', (e) => {
      draftTheme = { ...draftTheme, preset: 'custom', primary: e.target.value };
      syncOverlayFromDraft();
    });

    // ── Color reset ──
    colorReset?.addEventListener('click', () => {
      draftTheme = {
        ...draftTheme,
        preset: 'default',
        primary: '#2563eb',
        font: 'Plus Jakarta Sans',
        mode: 'auto',
      };
      syncOverlayFromDraft();
    });

    // ── Font select ──
    fontSelect?.addEventListener('change', (e) => {
      draftTheme = { ...draftTheme, font: e.target.value };
      syncOverlayFromDraft();
    });

    // ── Mode select ──
    modeSelect?.addEventListener('change', (e) => {
      draftTheme = { ...draftTheme, mode: e.target.value };
      syncOverlayFromDraft();
    });

    // ── Close on Escape ──
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden && overlay.classList.contains('is-visible')) {
        cancelBtn?.click();
      }
    });

    // Initial sync of wizard theme info
    syncWizardThemeInfo();
  }
})();
