// =============================================================================
// buat-ujian.js — Page controller + central state for Buat Ujian (v0.2.0)
// =============================================================================
// Central state mirrors the REAL AlbEdu exam document structure (verified
// from src/wizard/state.js v2.0.0 — table `ujian`, PK `kode_id` 5-digit string,
// sections[].questions[] with pilihan {A,B,C,D} object, jawaban_benar letter,
// identity_mode + identity_config replacing the dropped `kelas` field).
//
// v0.2.0 changes (per owner Albi Fahriza):
//   - Step-based wizard (3 steps), not 4 stacked cards
//   - localStorage draft system REMOVED — publish is the only save action
//   - Pengaturan Lanjutan card REMOVED (max_halaman hardcoded to 3)
//   - Theme is custom color pickers (CU/HJ/TW) in Step 1, not a dropdown
//   - Standard .header (consistent with other admin pages)
//   - List view default, button to open wizard
//
// Publish writes to Supabase via runTransaction (INSERT-only, no update).
//
// Loaded as classic <script defer>. Exposes window.BuatUjian.
// =============================================================================

(function () {
  'use strict';

  const SCHEMA_VERSION = '0.2.0';
  const GLOBAL_SKOR = 100;
  const MAX_SECTIONS = 2;
  const MAX_QUESTIONS_PER_SECTION = 50;
  const MAX_TOTAL_QUESTIONS = 100;

  // ── Default identity fields (matches existing DEFAULT_IDENTITY_FIELDS) ──
  // Two fields by default: "Nama" (required text) + "Kelas" (required select).
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

  // ── Central exam state (mirrors real examData structure) ──
  const _state = {
    examData: {
      ujian: {
        kode_id: null,
        judul: '',
        mata_pelajaran: '',
        identity_mode: 'manual',
        identity_config: { fields: defaultIdentityFields() },
        mode_pembuka: 'Manual',
        time: '60',
        catatan: 'Off',
        is_catatan: null,
        max_halaman: 3,
        global_skor: GLOBAL_SKOR,
        theme: { tema: 'default', CU: null, HJ: null, TW: null },
      },
      access_control: {
        mode: 'manual',
        manual_status: 'closed',
        override: false,
        scheduled: { start: null, end: null, active: false },
      },
      PQ: { pages1: { identitas: { mode: 'manual', fields: defaultIdentityFields() } } },
    },
    sections: [],
    generatedCodes: [],
  };

  const _listeners = new Set();
  let _lastTotalQ = 0, _lastBase = 0, _lastRem = 0;

  // ── Score recalculation (verified from state.js recalculateScores) ──
  // global_skor=100 auto-distributed: each q gets floor(100/N), first (100%N)
  // questions get +1 to distribute the remainder. Re-runs on every add/remove.
  function recalculateScores(state) {
    const totalQ = state.sections.reduce((sum, sec) => sum + sec.questions.length, 0);
    if (totalQ === 0) return state;

    const base = Math.floor(GLOBAL_SKOR / totalQ);
    const rem = GLOBAL_SKOR % totalQ;

    // Skip mutation if the distribution hasn't changed (perf optimization)
    if (totalQ === _lastTotalQ && base === _lastBase && rem === _lastRem) {
      let c = 0;
      for (const sec of state.sections) {
        for (const q of sec.questions) {
          const newSkor = base + (c++ < rem ? 1 : 0);
          if (q.skor !== newSkor) q.skor = newSkor;
        }
      }
      return state;
    }

    _lastTotalQ = totalQ;
    _lastBase = base;
    _lastRem = rem;

    let c = 0;
    state.sections = state.sections.map((sec) => ({
      ...sec,
      questions: sec.questions.map((q) => ({ ...q, skor: base + (c++ < rem ? 1 : 0) })),
    }));
    return state;
  }

  // ── generateCode (verified from state.js) ──
  // 5-digit string token, unique within current session (generatedCodes).
  // Collisions with already-published exams are caught by the transaction
  // guard in PublishCard._saveToSupabase (doc.exists → throw).
  function generateCode() {
    let code;
    do {
      code = Math.floor(10000 + Math.random() * 90000).toString();
    } while (_state.generatedCodes.includes(code));
    _state.examData.ujian.kode_id = code;
    _state.generatedCodes.push(code);
    return code;
  }

  const BuatUjian = {
    SCHEMA_VERSION,
    GLOBAL_SKOR,
    MAX_SECTIONS,
    MAX_QUESTIONS_PER_SECTION,
    MAX_TOTAL_QUESTIONS,

    getState() {
      // Deep clone so callers can't mutate internal state directly
      return JSON.parse(JSON.stringify(_state));
    },

    setState(patch) {
      if (patch && typeof patch === 'object') {
        Object.assign(_state, patch);
      }
      recalculateScores(_state);

      // Sync PQ mirror — exam-taker reads from PQ.pages1.identitas + PQ.pages2/3
      _state.examData.PQ.pages1.identitas = {
        mode: _state.examData.ujian.identity_mode,
        fields: _state.examData.ujian.identity_config.fields || [],
        // For 'daftar' mode, also mirror daftar_id (if set)
        ...(_state.examData.ujian.identity_mode === 'daftar' && _state.examData.ujian.identity_config?.daftar_id
          ? { daftar_id: _state.examData.ujian.identity_config.daftar_id }
          : {}),
      };

      // Mirror sections into PQ.pages2, pages3 (max 2 sections)
      // Clear any stale pages beyond current section count
      Object.keys(_state.examData.PQ).forEach((key) => {
        if (key.startsWith('pages') && key !== 'pages1') {
          const idx = parseInt(key.replace('pages', ''), 10);
          if (isNaN(idx) || idx - 2 >= _state.sections.length) {
            delete _state.examData.PQ[key];
          }
        }
      });
      _state.sections.forEach((sec, idx) => {
        _state.examData.PQ[`pages${idx + 2}`] = {
          type_question: sec.type_question,
          questions: sec.questions,
        };
      });

      _listeners.forEach((fn) => {
        try { fn(_state); } catch (e) { console.error('[BuatUjian] listener threw:', e); }
      });
    },

    subscribe(fn) {
      _listeners.add(fn);
      return () => _listeners.delete(fn);
    },

    // ── Section operations ──
    addSection() {
      if (_state.sections.length >= MAX_SECTIONS) return null;
      const id = _state.sections.length + 1;
      const section = { id, name: `Bagian ${id}`, type_question: '', questions: [] };
      _state.sections.push(section);
      this.setState({});
      return section;
    },

    removeSection(index) {
      if (index < 0 || index >= _state.sections.length) return;
      _state.sections.splice(index, 1);
      // Re-index remaining sections so ids stay 1, 2, ...
      _state.sections.forEach((s, i) => {
        s.id = i + 1;
        s.name = `Bagian ${i + 1}`;
      });
      this.setState({});
    },

    updateSection(index, updates) {
      const sec = _state.sections[index];
      if (!sec) return;
      // Changing type_question CLEARS all questions (schema rule)
      if (updates.type_question && updates.type_question !== sec.type_question) {
        sec.questions = [];
      }
      Object.assign(sec, updates);
      this.setState({});
    },

    // ── Question operations ──
    addQuestion(sectionIndex, type) {
      const sec = _state.sections[sectionIndex];
      if (!sec) return null;
      if (sec.questions.length >= MAX_QUESTIONS_PER_SECTION) return null;
      const totalQ = _state.sections.reduce((s, x) => s + x.questions.length, 0);
      if (totalQ >= MAX_TOTAL_QUESTIONS) return null;
      if (!sec.type_question) return null;
      // Reject type mismatch (defensive — UI shouldn't allow it)
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
      const sec = _state.sections[sectionIndex];
      if (!sec) return;
      const q = sec.questions[questionIndex];
      if (!q) return;
      Object.assign(q, updates);
      this.setState({});
    },

    removeQuestion(sectionIndex, questionIndex) {
      const sec = _state.sections[sectionIndex];
      if (!sec) return;
      sec.questions.splice(questionIndex, 1);
      // Re-index idq so it stays 1, 2, ...
      sec.questions.forEach((q, i) => { q.idq = i + 1; });
      this.setState({});
    },

    // ── Token ──
    generateToken() { return generateCode(); },
    getToken() { return _state.examData.ujian.kode_id; },

    // ── Export for Supabase (verified from state.js exportExamData) ──
    // Returns a plain object ready for transaction.set(docRef, ...).
    // Strips `kelas` (dropped in v2.0.0), computes scheduled.end from start+time.
    exportExamData() {
      const data = JSON.parse(JSON.stringify(_state.examData));
      data.sections = JSON.parse(JSON.stringify(_state.sections));

      // Denormalized top-level fields (for fast Supabase queries)
      data.judul = data.ujian?.judul ?? null;
      data.mata_pelajaran = data.ujian?.mata_pelajaran ?? null;
      data.identity_mode = data.ujian?.identity_mode ?? 'manual';
      data.identity_config = data.ujian?.identity_config ?? {};

      // Ensure PQ mirror is up-to-date
      data.PQ.pages1.identitas = {
        mode: data.ujian.identity_mode,
        fields: data.ujian.identity_config.fields || [],
        ...(data.ujian.identity_mode === 'daftar' && data.ujian.identity_config?.daftar_id
          ? { daftar_id: data.ujian.identity_config.daftar_id }
          : {}),
      };
      data.sections.forEach((sec, idx) => {
        data.PQ[`pages${idx + 2}`] = {
          type_question: sec.type_question,
          questions: sec.questions,
        };
      });

      // kelas field DROPPED in v2.0.0 — never include it
      delete data.kelas;
      delete data.ujian?.kelas;

      // Compute scheduled.end from start + duration
      if (data.access_control.mode === 'scheduled') {
        if (data.access_control.scheduled?.start) {
          const start = new Date(data.access_control.scheduled.start);
          if (!isNaN(start.getTime())) {
            const mins = parseInt(data.ujian.time, 10) || 0;
            const end = new Date(start.getTime() + mins * 60000);
            data.access_control.scheduled.end = end.toISOString();
            data.access_control.scheduled.active = true;
          }
        }
      } else {
        // Manual mode — clear scheduled fields
        data.access_control.scheduled = { start: null, end: null, active: false };
        data.access_control.end = null;
        data.access_control.remaining_time = null;
        if (!data.access_control.manual_status) {
          data.access_control.manual_status = 'closed';
        }
      }

      return data;
    },

    // ── Validate (verified from validation.js) ──
    // Returns { valid: boolean, errors: [{field, message}] }.
    // Step 1 — Identitas: judul, mata_pelajaran, identity_mode, mode_pembuka,
    //          time, catatan, scheduled.start (if Otomatis)
    // Step 3 — Soal: min 1 section, min 3 q per section, each q pertanyaan
    //          min 3 chars, PG requires all 4 pilihan + jawaban_benar letter
    validate() {
      const errors = [];
      const u = _state.examData.ujian;
      const ac = _state.examData.access_control;

      // ── Step 1: Identitas ──
      if (!u.judul) {
        errors.push({ field: 'judul', message: 'Judul ujian harus diisi' });
      } else if (u.judul.trim().length < 5) {
        errors.push({ field: 'judul', message: 'Judul min. 5 karakter' });
      }

      if (!u.mata_pelajaran) {
        errors.push({ field: 'mapel', message: 'Mata pelajaran harus diisi' });
      }

      const mode = u.identity_mode;
      if (!mode || (mode !== 'manual' && mode !== 'daftar')) {
        errors.push({ field: 'identity_mode', message: 'Mode identitas harus dipilih' });
      } else if (mode === 'manual') {
        const fields = u.identity_config?.fields || [];
        if (!fields.length) {
          errors.push({ field: 'identity_fields', message: 'Manual: minimal 1 field' });
        } else if (!fields.some((f) => (f.label || '').toLowerCase().includes('nama'))) {
          errors.push({ field: 'identity_fields', message: 'Minimal 1 field dengan label "nama"' });
        }
      } else if (mode === 'daftar') {
        if (!u.identity_config?.daftar_id) {
          errors.push({ field: 'identity_daftar', message: 'Pilih daftar nama' });
        }
      }

      if (!u.mode_pembuka) {
        errors.push({ field: 'mode_pembuka', message: 'Mode pembuka harus dipilih' });
      }

      const waktu = parseInt(u.time, 10);
      if (isNaN(waktu) || waktu < 1 || waktu > 120) {
        errors.push({ field: 'time', message: 'Waktu 1-120 menit' });
      }

      if (u.catatan === 'On' && (!u.is_catatan || !u.is_catatan.trim())) {
        errors.push({ field: 'is_catatan', message: 'Isi catatan jika catatan aktif' });
      }

      if (u.mode_pembuka === 'Otomatis' && !ac.scheduled?.start) {
        errors.push({ field: 'scheduled_start', message: 'Waktu mulai harus diisi' });
      }

      // ── Step 3: Soal ──
      if (_state.sections.length === 0) {
        errors.push({ field: 'sections', message: 'Minimal 1 bagian soal' });
      } else {
        _state.sections.forEach((sec, idx) => {
          if (!sec.type_question) {
            errors.push({ field: `section[${idx}].type`, message: `Bagian ${idx + 1}: pilih tipe soal` });
            return; // skip question validation if type isn't set
          }
          if (sec.questions.length < 3) {
            errors.push({ field: `section[${idx}].questions`, message: `Bagian ${idx + 1}: minimal 3 soal (saat ini ${sec.questions.length})` });
          }
          sec.questions.forEach((q, qIdx) => {
            const cleanQ = (q.pertanyaan || '').replace(/<[^>]*>/g, '').trim();
            if (!cleanQ) {
              errors.push({ field: `q[${idx}][${qIdx}]`, message: `Bagian ${idx + 1} Soal ${qIdx + 1}: pertanyaan harus diisi` });
            } else if (cleanQ.length < 3) {
              errors.push({ field: `q[${idx}][${qIdx}]`, message: `Bagian ${idx + 1} Soal ${qIdx + 1}: pertanyaan terlalu pendek` });
            }
            if (sec.type_question === 'PG') {
              if (!q.jawaban_benar) {
                errors.push({ field: `q[${idx}][${qIdx}]`, message: `Bagian ${idx + 1} Soal ${qIdx + 1}: pilih jawaban benar` });
              }
              ['A', 'B', 'C', 'D'].forEach((k) => {
                if (!q.pilihan?.[k]?.trim()) {
                  errors.push({ field: `q[${idx}][${qIdx}]`, message: `Bagian ${idx + 1} Soal ${qIdx + 1}: opsi ${k} harus diisi` });
                }
              });
            }
          });
        });
      }

      return { valid: errors.length === 0, errors };
    },
  };

  window.BuatUjian = BuatUjian;

  // ── Bootstrap on DOM ready ──
  // Each module auto-inits its own DOM listeners; we just kick them off
  // in dependency order. BuatUjian itself is already attached to window above.
  document.addEventListener('DOMContentLoaded', () => {
    // List view loads first (default view)
    if (window.ListView) window.ListView.init();
    // Wizard + step controllers
    if (window.WizardController) window.WizardController.init();
    // Step 1 modules
    if (window.MetadataCard) window.MetadataCard.init();
    // Step 2 modules
    if (window.SoalCard) window.SoalCard.init();
    if (window.SoalEditorModal) window.SoalEditorModal.init();
    if (window.TemplatePicker) window.TemplatePicker.init();
    // Step 3 modules
    if (window.PublishCard) window.PublishCard.init();
    // Global
    if (window.KeyboardShortcuts) window.KeyboardShortcuts.init();
    console.info('[BuatUjian] v0.2.0 initialized — schema', SCHEMA_VERSION);
  });
})();
