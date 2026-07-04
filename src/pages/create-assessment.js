// =============================================================================
// create-assessment.js — v1.0.0 Page Controller
// =============================================================================
// Full rewrite with:
//   - Google Form-like theme editor (1 color → auto-derive)
//   - New schema (assessments table, 6-digit access_code, allow_retake)
//   - Server-side publish via direct Supabase insert (assessments table)
//   - Live WCAG AA validation
//   - List view + 3-step wizard
// =============================================================================

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  // ─── Constants ──────────────────────────────────────────────────────────
  const SCHEMA_VERSION = '1.0.0';
  const GLOBAL_SKOR = 100;
  const MAX_SECTIONS = 2;
  const MAX_QUESTIONS_PER_SECTION = 50;
  const MAX_TOTAL_QUESTIONS = 100;
  const ACCESS_CODE_LENGTH = 6;

  // ─── Default identity fields ────────────────────────────────────────────
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

  // ─── State ──────────────────────────────────────────────────────────────
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

  // ─── Score recalculation ────────────────────────────────────────────────
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

  // ─── Generate 6-digit access code ───────────────────────────────────────
  function generateAccessCode() {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (_state.generatedCodes.includes(code));
    _state.examData.access_code = code;
    _state.generatedCodes.push(code);
    return code;
  }

  // ─── Public API ─────────────────────────────────────────────────────────
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

    // ── Section operations ──
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

    // ── Question operations ──
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

    // ── Access code ──
    generateToken() { return generateAccessCode(); },
    getToken() { return _state.examData.access_code; },

    // ── Export for Supabase ──
    exportAssessmentData() {
      const data = JSON.parse(JSON.stringify(_state.examData));
      // Compute scheduled end from start + duration
      if (data.access_mode === 'scheduled' && _state.scheduled_start) {
        const start = new Date(_state.scheduled_start);
        if (!isNaN(start.getTime())) {
          data._scheduled_end = new Date(start.getTime() + data.duration_minutes * 60000).toISOString();
        }
      }
      return data;
    },

    // ── Validate ──
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

    // ── Publish to Supabase (assessments table) ──
    async publishToSupabase() {
      const { valid, errors } = this.validate();
      if (!valid) {
        throw new Error(errors[0]?.message || 'Validasi gagal');
      }

      // Ensure access code exists
      if (!this.getToken()) {
        this.generateToken();
      }

      const repo = window.AlbEdu?.repository;
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      if (!user) throw new Error('User tidak terautentikasi');
      if (!repo) throw new Error('Platform layer belum siap');

      const data = this.exportAssessmentData();
      const now = new Date().toISOString();

      // Insert into assessments table (native repository — addDoc returns the
      // inserted row with its generated UUID PK).
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

      // Audit log via native RPC service (non-blocking, auth token auto-attached)
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
  window.BuatUjian = CreateAssessment; // backward compat with v0.2.0 modules

  // ─── Bootstrap ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Init theme system with default
    if (window.ThemeSystem) {
      window.ThemeSystem.apply(_state.examData.theme_config);
    }

    // Init theme editor
    initThemeEditor();

    // Init v0.2.0 modules (still working — backward compat)
    if (window.MetadataCard) window.MetadataCard.init();
    if (window.SoalCard) window.SoalCard.init();
    if (window.PublishCard) window.PublishCard.init();
    if (window.SoalEditorModal) window.SoalEditorModal.init();
    if (window.TemplatePicker) window.TemplatePicker.init();
    if (window.WizardController) window.WizardController.init();
    if (window.ListView) window.ListView.init();
    if (window.KeyboardShortcuts) window.KeyboardShortcuts.init();

    console.info('[CreateAssessment] v1.0.0 initialized');
  });

  // ─── Language Switcher ──────────────────────────────────────────────────
  
  // ─── Theme Editor (Google Form-like) ────────────────────────────────────
  function initThemeEditor() {
    const presetChips = document.querySelectorAll('.albedu-preset-chip');
    const colorPicker = document.getElementById('color-picker');
    const colorHex = document.getElementById('color-hex');
    const colorReset = document.getElementById('color-reset');
    const colorQuickpicks = document.getElementById('color-quickpicks');
    const fontSelect = document.getElementById('theme-font');
    const modeSelect = document.getElementById('theme-mode');
    const resetAllBtn = document.getElementById('theme-reset-all');
    const wcagStatus = document.getElementById('wcag-status');

    if (!colorPicker || !window.ThemeSystem) {
      console.warn('[theme] ThemeSystem not loaded or color picker missing');
      return;
    }

    // Render quick-pick colors
    const quickColors = window.ThemeSystem.getQuickColors();
    colorQuickpicks.innerHTML = quickColors.map((c) =>
      `<button class="albedu-color-swatch-btn" data-color="${c.hex}" style="background: ${c.hex};" title="${c.name}" type="button"></button>`
    ).join('');

    // Mark active color
    function updateActiveColor(hex) {
      colorQuickpicks.querySelectorAll('.albedu-color-swatch-btn').forEach((btn) => {
        btn.classList.toggle('albedu-active', btn.dataset.color.toLowerCase() === hex.toLowerCase());
      });
    }

    // Apply theme + update state + validate WCAG
    function applyThemeChange(primary, font, mode, preset) {
      const theme = {
        version: '1.0',
        preset: preset || _state.examData.theme_config.preset,
        primary: primary || _state.examData.theme_config.primary,
        font: font || _state.examData.theme_config.font,
        mode: mode || _state.examData.theme_config.mode,
      };
      window.ThemeSystem.apply(theme);

      // Update state
      _state.examData.theme_config = theme;

      // Update UI
      colorPicker.value = theme.primary;
      colorHex.textContent = theme.primary;
      updateActiveColor(theme.primary);

      // WCAG validation
      const validation = window.ThemeSystem.validate(theme.primary);
      if (validation.allPass) {
        wcagStatus.className = 'albedu-wcag-status albedu-wcag-pass';
        wcagStatus.innerHTML = '<span style="font-size: 14px;" data-albedu-icon="check_circle"></span><span>' + t('create.wcag_pass', null, 'Contrast OK (Pass)') + '</span>';
      } else {
        wcagStatus.className = 'albedu-wcag-status albedu-wcag-fail';
        wcagStatus.innerHTML = '<span style="font-size: 14px;" data-albedu-icon="warning"></span><span>' + t('create.wcag_fail', null, 'Warna ini mungkin sulit dibaca. Coba warna lebih gelap.') + '</span>';
      }
    }

    // Preset chips
    presetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        presetChips.forEach((c) => c.classList.remove('albedu-active'));
        chip.classList.add('albedu-active');
        const preset = window.ThemeSystem.getPreset(chip.dataset.preset);
        applyThemeChange(preset.primary, preset.font, preset.mode, preset.id);
      });
    });

    // Quick-pick colors
    colorQuickpicks.addEventListener('click', (e) => {
      const btn = e.target.closest('.albedu-color-swatch-btn');
      if (!btn) return;
      applyThemeChange(btn.dataset.color, null, null, 'custom');
    });

    // Custom color picker
    colorPicker.addEventListener('input', (e) => {
      applyThemeChange(e.target.value, null, null, 'custom');
    });

    // Reset color to default
    colorReset.addEventListener('click', () => {
      applyThemeChange('#2563eb', 'Plus Jakarta Sans', 'auto', 'default');
      presetChips.forEach((c) => c.classList.toggle('albedu-active', c.dataset.preset === 'default'));
    });

    // Font select
    fontSelect.addEventListener('change', (e) => {
      applyThemeChange(null, e.target.value, null, _state.examData.theme_config.preset);
    });

    // Mode select
    modeSelect.addEventListener('change', (e) => {
      applyThemeChange(null, null, e.target.value, _state.examData.theme_config.preset);
    });

    // Reset all
    resetAllBtn.addEventListener('click', () => {
      applyThemeChange('#2563eb', 'Plus Jakarta Sans', 'auto', 'default');
      fontSelect.value = 'Plus Jakarta Sans';
      modeSelect.value = 'auto';
      presetChips.forEach((c) => c.classList.toggle('albedu-active', c.dataset.preset === 'default'));
    });

    // Initial apply
    applyThemeChange(
      _state.examData.theme_config.primary,
      _state.examData.theme_config.font,
      _state.examData.theme_config.mode,
      _state.examData.theme_config.preset
    );
  }
})();
