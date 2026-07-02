/**
 * WizardState — AlbEdu v0.4.1
 * Immutable state core + production-grade draft system.
 */
const WizardState = (() => {
    const SCHEMA_VERSION      = '2.0.0'; // v2.0.0: identity_mode + identity_config (hapus kelas/metode_nama)
    const DRAFT_KEY           = 'albedu_wizard_draft';
    const DRAFT_HISTORY_KEY   = 'albedu_wizard_draft_history';
    const MAX_DRAFT_HISTORY   = 3;
    const SAVE_DEBOUNCE_MS    = 500;
    const STEP_NAMES          = { 1: 'Identitas', 2: 'Tema', 3: 'Soal', 4: 'Publish' };
    const MAX_SECTIONS        = 2;
    const MAX_QUESTIONS_PER_SECTION = 50;
    const MAX_TOTAL_QUESTIONS = 100;
    const GLOBAL_SKOR         = 100;

    const DEFAULT_IDENTITY_FIELDS = () => [
        {
            id:          'field_nama_' + Math.random().toString(36).slice(2, 8),
            type:        'text',
            label:       'Nama',
            placeholder: 'Masukkan nama lengkap',
            required:    true,
            max_length:  50,
        },
        {
            id:          'field_kelas_' + Math.random().toString(36).slice(2, 8),
            type:        'select',
            label:       'Kelas',
            required:    true,
            options:     ['7A', '7B', '7C', '7D'],
        },
    ];

    const buildInitialState = () => ({
        currentStep: 1,
        totalSteps:  4,
        isModalOpen: false,
        examData: {
            ujian: {
                kode_id:        null,
                judul:          '',
                mata_pelajaran: '',
                // v2.0.0 — identity system (replaces kelas + metode_nama + daftar_id/tipe/label)
                identity_mode:  'manual',  // 'manual' | 'daftar'
                identity_config: {
                    fields: DEFAULT_IDENTITY_FIELDS(),  // populated for manual mode
                    // For 'daftar' mode: { daftar_id, daftar_tipe, daftar_label, tabs:[] }
                },
                mode_pembuka:   '',
                time:           '',
                catatan:        'Off',
                is_catatan:     null,
                max_halaman:    3,
                global_skor:    GLOBAL_SKOR,
                theme: { tema: 'default', CU: null, HJ: null, TW: null },
            },
            access_control: {
                mode:          'manual',
                manual_status: 'closed',  // WHY 'closed': exam baru tidak boleh langsung terbuka sebelum admin start
                override:      false,
                scheduled:     { start: null, end: null, active: false }
            },
            // v2.0.0 — PQ.pages1.identitas sekarang mirror dari ujian.identity_mode + identity_config.
            // Disimpan untuk backward compat dengan exam-taker yang baca dari PQ path.
            PQ: { pages1: { identitas: { mode: 'manual', fields: DEFAULT_IDENTITY_FIELDS() } } }
        },
        sections:            [],
        currentSectionIndex: 0,
        generatedCodes:      [],
        validationErrors:    {},
        stepCompleted:       { 1: false, 2: false, 3: false, 4: false }
    });

    let state        = buildInitialState();
    let _isDirty     = false;
    let _saveTimer   = null;
    let _lastSavedHash = '';

    const deepClone = obj => JSON.parse(JSON.stringify(obj));

    // W9 fix: memoized quickHash — caches hash by JSON string. Avoids 2× JSON.stringify
    // per save (was called in scheduleSave + flushSave). Each call for a 100-question
    // state was ~50KB stringify + 100K char iterations. Now computed once per state change.
    let _hashCache = new WeakMap();
    const quickHash = obj => {
        if (obj === null || typeof obj !== 'object') return '0';
        // WeakMap requires object key; state is always an object
        if (_hashCache.has(obj)) return _hashCache.get(obj);
        const str = JSON.stringify(obj);
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        const result = h.toString(36);
        _hashCache.set(obj, result);
        return result;
    };

    // W5 fix: skip full rebuild when total question count unchanged. Old code rebuilt
    // every section + every question object per mutation (O(n) allocations). Now we
    // mutate the skor field in-place when count is stable — same visual result, no GC pressure.
    let _lastTotalQ = -1;
    let _lastBase   = -1;
    let _lastRem    = -1;
    const recalculateScores = (s) => {
        const totalQ = s.sections.reduce((sum, sec) => sum + sec.questions.length, 0);
        if (totalQ === 0) return s;
        const base = Math.floor(GLOBAL_SKOR / totalQ);
        const rem  = GLOBAL_SKOR % totalQ;

        // W5: if count + distribution unchanged, only patch skor in-place (no array realloc)
        if (totalQ === _lastTotalQ && base === _lastBase && rem === _lastRem) {
            let c = 0;
            for (const sec of s.sections) {
                for (const q of sec.questions) {
                    const newSkor = base + (c++ < rem ? 1 : 0);
                    if (q.skor !== newSkor) q.skor = newSkor;
                }
            }
            return s;
        }

        // Count changed — full rebuild (rare path: add/remove question)
        _lastTotalQ = totalQ; _lastBase = base; _lastRem = rem;
        let c = 0;
        const newSections = s.sections.map(sec => ({
            ...sec,
            questions: sec.questions.map(q => ({ ...q, skor: base + (c++ < rem ? 1 : 0) }))
        }));
        return { ...s, sections: newSections };
    };

    const buildSaveEnvelope = () => ({
        schemaVersion: SCHEMA_VERSION,
        savedAt:       new Date().toISOString(),
        state:         deepClone(state)
    });

    const rotateDraftHistory = (envelope) => {
        try {
            const raw     = localStorage.getItem(DRAFT_HISTORY_KEY);
            const history = raw ? JSON.parse(raw) : [];
            history.unshift(envelope);
            localStorage.setItem(DRAFT_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_DRAFT_HISTORY)));
        } catch (_) {}
    };

    const flushSave = () => {
        try {
            const envelope = buildSaveEnvelope();
            localStorage.setItem(DRAFT_KEY, JSON.stringify(envelope));
            rotateDraftHistory(envelope);
            _lastSavedHash = quickHash(state);
            _isDirty       = false;
            window.dispatchEvent(new CustomEvent('wizard:draft-saved', { detail: { savedAt: envelope.savedAt } }));
            return true;
        } catch (err) {
            console.warn('[WizardState] Save failed:', err);
            return false;
        }
    };

    const scheduleSave = () => {
        _isDirty = true;
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            if (quickHash(state) !== _lastSavedHash) flushSave();
            _saveTimer = null;
        }, SAVE_DEBOUNCE_MS);
    };

    const validateAndMigrate = (raw) => {
        const initial  = buildInitialState();
        const restored = { ...initial, ...raw };
        restored.examData = { ...initial.examData, ...(raw.examData || {}) };
        restored.examData.ujian = { ...initial.examData.ujian, ...(raw.examData?.ujian || {}) };

        // v2.0.0 migration: metode_nama → identity_mode, daftar_id/tipe/label → identity_config
        const ujian = restored.examData.ujian;
        if (ujian.metode_nama && !ujian.identity_mode) {
            // Legacy draft — migrate
            ujian.identity_mode = ujian.metode_nama;  // 'manual' or 'daftar'
        }
        if (!ujian.identity_mode) ujian.identity_mode = 'manual';

        if (!ujian.identity_config || typeof ujian.identity_config !== 'object') {
            ujian.identity_config = {};
        }

        // If daftar legacy fields present, migrate into identity_config
        if (ujian.daftar_id && ujian.identity_mode === 'daftar') {
            ujian.identity_config.daftar_id    = ujian.identity_config.daftar_id    || ujian.daftar_id;
            ujian.identity_config.daftar_tipe  = ujian.identity_config.daftar_tipe  || ujian.daftar_tipe;
            ujian.identity_config.daftar_label = ujian.identity_config.daftar_label || ujian.daftar_label;
            // Also copy tabs from old PQ path if available
            const legacyKelas = raw.examData?.PQ?.pages1?.identitas?.kelas;
            if (Array.isArray(legacyKelas) && !ujian.identity_config.tabs) {
                ujian.identity_config.tabs = legacyKelas;
            }
        }

        // If manual mode and no fields, init default
        if (ujian.identity_mode === 'manual' &&
            (!Array.isArray(ujian.identity_config.fields) || ujian.identity_config.fields.length === 0)) {
            // Try to migrate from legacy kelas array → build Nama + Kelas select
            const legacyKelas = raw.examData?.ujian?.kelas || raw.examData?.PQ?.pages1?.identitas?.kelas;
            if (Array.isArray(legacyKelas) && legacyKelas.length > 0) {
                ujian.identity_config.fields = [
                    {
                        id:          'field_nama_legacy',
                        type:        'text',
                        label:       'Nama',
                        placeholder: 'Masukkan nama lengkap',
                        required:    true,
                        max_length:  50,
                    },
                    {
                        id:          'field_kelas_legacy',
                        type:        'select',
                        label:       'Kelas',
                        required:    true,
                        options:     [...legacyKelas],
                    },
                ];
            } else {
                ujian.identity_config.fields = DEFAULT_IDENTITY_FIELDS();
            }
        }

        // Cleanup legacy fields (keep them in object for safety, but they're unused)
        // DO NOT delete — let exportExamData handle them

        restored.examData.access_control = {
            ...initial.examData.access_control,
            ...(raw.examData?.access_control || {}),
            scheduled: {
                ...initial.examData.access_control.scheduled,
                ...(raw.examData?.access_control?.scheduled || {})
            }
        };
        restored.examData.PQ = { ...initial.examData.PQ, ...(raw.examData?.PQ || {}) };
        // Sync PQ.pages1.identitas with ujian.identity_mode + identity_config
        restored.examData.PQ.pages1 = restored.examData.PQ.pages1 || {};
        restored.examData.PQ.pages1.identitas = {
            mode:   ujian.identity_mode,
            fields: ujian.identity_config.fields || [],
            ...(ujian.identity_mode === 'daftar' ? {
                daftar_id:    ujian.identity_config.daftar_id,
                daftar_tipe:  ujian.identity_config.daftar_tipe,
                daftar_label: ujian.identity_config.daftar_label,
                tabs:         ujian.identity_config.tabs || [],
            } : {}),
        };

        if (!Array.isArray(restored.sections))       restored.sections = [];
        if (!Array.isArray(restored.generatedCodes)) restored.generatedCodes = [];
        if (typeof restored.currentSectionIndex !== 'number' ||
            restored.currentSectionIndex < 0 ||
            restored.currentSectionIndex >= restored.sections.length) {
            restored.currentSectionIndex = 0;
        }
        if (!restored.stepCompleted || typeof restored.stepCompleted !== 'object')
            restored.stepCompleted = { 1: false, 2: false, 3: false, 4: false };
        return restored;
    };

    return {
        getState:              () => deepClone(state),
        // W4 fix: read-only state reference for INTERNAL callers (validation, progress bar).
        // Old code called deepClone on every read (4× per Add Question = 4× 50KB JSON
        // parse/stringify). Callers using getStateRef() must NOT mutate the returned object.
        // For safety, Object.freeze is shallow — top-level keys are protected; nested
        // objects (sections, examData) are still mutable but trusted-internal-only.
        getStateRef:           () => Object.freeze({ ...state, sections: state.sections, examData: state.examData }),
        getCurrentStep:        () => state.currentStep,
        getExamData:           () => deepClone(state.examData),
        getSections:           () => deepClone(state.sections),
        getCurrentSection:     () => deepClone(state.sections[state.currentSectionIndex] || {}),
        getStepNames:          () => STEP_NAMES,
        getMaxSections:        () => MAX_SECTIONS,
        getMaxQuestionsPerSection: () => MAX_QUESTIONS_PER_SECTION,
        getMaxTotalQuestions:  () => MAX_TOTAL_QUESTIONS,
        getGlobalSkor:         () => GLOBAL_SKOR,
        isStepCompleted:       (step) => !!state.stepCompleted[step],
        isDirty:               () => _isDirty,

        setCurrentStep: (step) => {
            if (step >= 1 && step <= state.totalSteps) { state = { ...state, currentStep: step }; return true; }
            return false;
        },
        setStepCompleted: (step, completed) => {
            if (step >= 1 && step <= state.totalSteps)
                state = { ...state, stepCompleted: { ...state.stepCompleted, [step]: completed } };
        },
        setModalOpen: (isOpen) => { state = { ...state, isModalOpen: isOpen }; },

        resetState: () => {
            state = buildInitialState(); _isDirty = false; _lastSavedHash = ''; _lastTotalQ = -1; _lastBase = -1; _lastRem = -1;
            return deepClone(state);
        },

        // ── Draft API ──────────────────────────────────────────────────────────
        saveNow:        () => flushSave(),
        triggerAutoSave: scheduleSave,
        hasDraft: () => { try { return !!localStorage.getItem(DRAFT_KEY); } catch (_) { return false; } },
        loadDraft: () => {
            try {
                const raw = localStorage.getItem(DRAFT_KEY);
                if (!raw) return null;
                const env = JSON.parse(raw);
                return (env && env.state) ? env : null;
            } catch (_) { return null; }
        },
        applyDraft: (envelope) => {
            const validated    = validateAndMigrate(deepClone(envelope.state));
            state              = recalculateScores(validated);
            _isDirty           = false;
            _lastSavedHash     = quickHash(state);
        },

        /** BUG FIX: "No" on restore — fully clears draft AND resets internal state */
        discardDraft: () => {
            try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
            state          = buildInitialState();
            _isDirty       = false;
            _lastSavedHash = '';
            window.dispatchEvent(new CustomEvent('wizard:draft-discarded'));
        },

        /** BUG FIX: setState now guarantees validation cache refresh after restore */
        setState: (newState) => {
            const validated = validateAndMigrate(deepClone(newState));
            state = recalculateScores(validated);
            scheduleSave();
            // Signal that state was externally set — controllers must re-validate
            window.dispatchEvent(new CustomEvent('wizard:state-restored'));
        },

        updateExamData: (updates) => {
            const newExamData = deepClone(state.examData);
            if (updates.ujian)          Object.assign(newExamData.ujian, updates.ujian);
            if (updates.theme)          Object.assign(newExamData.ujian.theme, updates.theme);
            if (updates.PQ)             Object.assign(newExamData.PQ, updates.PQ);
            if (updates.access_control) {
                newExamData.access_control = {
                    ...newExamData.access_control,
                    ...updates.access_control,
                    scheduled: {
                        ...newExamData.access_control.scheduled,
                        ...(updates.access_control.scheduled || {})
                    }
                };
            }
            state = { ...state, examData: newExamData };
            scheduleSave();
        },

        /** v2.0.0 — Update identity config (mode + config object) */
    updateIdentityConfig: (updates) => {
        const newExamData = deepClone(state.examData);
        if (updates.identity_mode !== undefined) {
            newExamData.ujian.identity_mode = updates.identity_mode;
        }
        if (updates.identity_config !== undefined) {
            newExamData.ujian.identity_config = {
                ...newExamData.ujian.identity_config,
                ...updates.identity_config,
            };
        }
        // Sync PQ.pages1.identitas
        const ujian = newExamData.ujian;
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            mode:   ujian.identity_mode,
            fields: ujian.identity_config.fields || [],
            ...(ujian.identity_mode === 'daftar' ? {
                daftar_id:    ujian.identity_config.daftar_id,
                daftar_tipe:  ujian.identity_config.daftar_tipe,
                daftar_label: ujian.identity_config.daftar_label,
                tabs:         ujian.identity_config.tabs || [],
            } : {}),
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    /** v2.0.0 — Helper: set identity fields (manual mode) */
    setIdentityFields: (fields) => {
        const newExamData = deepClone(state.examData);
        newExamData.ujian.identity_config = newExamData.ujian.identity_config || {};
        newExamData.ujian.identity_config.fields = Array.isArray(fields) ? fields : [];
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            ...newExamData.PQ.pages1.identitas,
            mode: 'manual',
            fields: newExamData.ujian.identity_config.fields,
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    /** v2.0.0 — Helper: set daftar selection (daftar mode) */
    setIdentityDaftar: (daftar) => {
        const newExamData = deepClone(state.examData);
        newExamData.ujian.identity_mode = 'daftar';
        newExamData.ujian.identity_config = {
            daftar_id:    daftar.id,
            daftar_tipe:  daftar.tipe_daftar,
            daftar_label: daftar.label,
            tabs:         daftar.tabs || (daftar.daftar?.tabs || []),
        };
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            mode:         'daftar',
            daftar_id:    newExamData.ujian.identity_config.daftar_id,
            daftar_tipe:  newExamData.ujian.identity_config.daftar_tipe,
            daftar_label: newExamData.ujian.identity_config.daftar_label,
            tabs:         newExamData.ujian.identity_config.tabs,
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    /** v2.0.0 — Update identity config (mode + config object) */
    updateIdentityConfig: (updates) => {
        const newExamData = deepClone(state.examData);
        if (updates.identity_mode !== undefined) {
            newExamData.ujian.identity_mode = updates.identity_mode;
        }
        if (updates.identity_config !== undefined) {
            newExamData.ujian.identity_config = {
                ...newExamData.ujian.identity_config,
                ...updates.identity_config,
            };
        }
        // Sync PQ.pages1.identitas
        const ujian = newExamData.ujian;
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            mode:   ujian.identity_mode,
            fields: ujian.identity_config.fields || [],
            ...(ujian.identity_mode === 'daftar' ? {
                daftar_id:    ujian.identity_config.daftar_id,
                daftar_tipe:  ujian.identity_config.daftar_tipe,
                daftar_label: ujian.identity_config.daftar_label,
                tabs:         ujian.identity_config.tabs || [],
            } : {}),
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    /** v2.0.0 — Helper: set identity fields (manual mode) */
    setIdentityFields: (fields) => {
        const newExamData = deepClone(state.examData);
        newExamData.ujian.identity_mode = 'manual';
        newExamData.ujian.identity_config = newExamData.ujian.identity_config || {};
        newExamData.ujian.identity_config.fields = Array.isArray(fields) ? fields : [];
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            ...newExamData.PQ.pages1.identitas,
            mode: 'manual',
            fields: newExamData.ujian.identity_config.fields,
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    /** v2.0.0 — Helper: set daftar selection (daftar mode) */
    setIdentityDaftar: (daftar) => {
        const newExamData = deepClone(state.examData);
        newExamData.ujian.identity_mode = 'daftar';
        newExamData.ujian.identity_config = {
            daftar_id:    daftar.id,
            daftar_tipe:  daftar.tipe_daftar,
            daftar_label: daftar.label,
            tabs:         daftar.tabs || [],
        };
        newExamData.PQ.pages1 = newExamData.PQ.pages1 || {};
        newExamData.PQ.pages1.identitas = {
            mode:         'daftar',
            daftar_id:    newExamData.ujian.identity_config.daftar_id,
            daftar_tipe:  newExamData.ujian.identity_config.daftar_tipe,
            daftar_label: newExamData.ujian.identity_config.daftar_label,
            tabs:         newExamData.ujian.identity_config.tabs,
        };
        state = { ...state, examData: newExamData };
        scheduleSave();
    },

    addSection: () => {
            if (state.sections.length >= MAX_SECTIONS) return null;
            const id      = state.sections.length + 1;
            const section = { id, name: `Bagian ${id}`, type_question: '', questions: [] };
            const secs    = [...state.sections, section];
            state = recalculateScores({ ...state, sections: secs, currentSectionIndex: secs.length - 1 });
            scheduleSave();
            return deepClone(section);
        },

        removeSection: (index) => {
            if (index < 0 || index >= state.sections.length) return false;
            const secs   = state.sections.filter((_, i) => i !== index);
            const curIdx = Math.min(state.currentSectionIndex, Math.max(0, secs.length - 1));
            state = recalculateScores({ ...state, sections: secs, currentSectionIndex: curIdx });
            scheduleSave();
            return true;
        },

        setCurrentSectionIndex: (index) => {
            if (index >= 0 && index < state.sections.length) { state = { ...state, currentSectionIndex: index }; return true; }
            return false;
        },

        updateSection: (index, updates) => {
            if (index < 0 || index >= state.sections.length) return false;
            const secs    = [...state.sections];
            secs[index]   = { ...secs[index], ...updates };
            if (updates.type_question && updates.type_question !== state.sections[index].type_question)
                secs[index].questions = [];
            state = recalculateScores({ ...state, sections: secs });
            scheduleSave();
            return true;
        },

        addQuestionToSection: (sectionIndex, type) => {
            const sec = state.sections[sectionIndex];
            if (!sec) return null;
            if (sec.questions.length >= MAX_QUESTIONS_PER_SECTION) return null;
            const totalQ = state.sections.reduce((s, x) => s + x.questions.length, 0);
            if (totalQ >= MAX_TOTAL_QUESTIONS) return null;

            const id   = sec.questions.length + 1;
            const media = { video: { enabled: false, src: null }, gambar: [] };
            const q    = type === 'PG'
                ? { idq: id, pertanyaan: '', pilihan: { A: '', B: '', C: '', D: '' }, jawaban_benar: '', media: deepClone(media) }
                : { idq: id, pertanyaan: '', media: deepClone(media) };

            const secs  = [...state.sections];
            secs[sectionIndex] = { ...sec, questions: [...sec.questions, q] };
            state = recalculateScores({ ...state, sections: secs });
            scheduleSave();
            return deepClone(q);
        },

        removeQuestionFromSection: (sectionIndex, questionIndex) => {
            const sec = state.sections[sectionIndex];
            if (!sec || questionIndex < 0 || questionIndex >= sec.questions.length) return false;
            const qs = sec.questions.filter((_, i) => i !== questionIndex);
            qs.forEach((q, i) => { q.idq = i + 1; });
            const secs = [...state.sections];
            secs[sectionIndex] = { ...sec, questions: qs };
            state = recalculateScores({ ...state, sections: secs });
            scheduleSave();
            return true;
        },

        updateQuestionInSection: (sectionIndex, questionIndex, updates) => {
            const sec = state.sections[sectionIndex];
            if (!sec || questionIndex < 0 || questionIndex >= sec.questions.length) return false;
            const qs = [...sec.questions];
            qs[questionIndex] = { ...qs[questionIndex], ...updates };
            const secs = [...state.sections];
            secs[sectionIndex] = { ...sec, questions: qs };
            state = { ...state, sections: secs };
            scheduleSave();
            return true;
        },

        generateCode: () => {
            let code;
            do { code = Math.floor(10000 + Math.random() * 90000).toString(); }
            while (state.generatedCodes.includes(code));
            const newExamData = deepClone(state.examData);
            newExamData.ujian.kode_id = code;
            state = { ...state, generatedCodes: [...state.generatedCodes, code], examData: newExamData };
            scheduleSave();
            return code;
        },

        getTotalQuestions: () => state.sections.reduce((sum, s) => sum + s.questions.length, 0),

        exportExamData: () => {
            const data = deepClone(state.examData);
            state.sections.forEach((sec, idx) => {
                data.PQ[`pages${idx + 2}`] = { type_question: sec.type_question, questions: sec.questions };
            });
            // Inject top-level sections from the real source of truth (state.sections).
            // exportExamData() only ever copied sections into data.PQ.pages2/pages3/…,
            // leaving data.sections undefined — which caused null to land in Supabase.
            // The PQ nested structure is left completely untouched.
            data.sections = deepClone(state.sections);

            // v2.0.0 — expose identity_mode + identity_config at top level (untuk Supabase)
            // These replace the old `kelas` top-level column.
            data.identity_mode   = data.ujian?.identity_mode   ?? 'manual';
            data.identity_config = data.ujian?.identity_config ?? {};
            // Cleanup: hapus field legacy dari top-level data (kolom kelas udah di-drop di DB)
            delete data.kelas;
            // NOTE: metode_nama + daftar_id/tipe/label tidak dihapus dari data.ujian
            // untuk backward-compat dengan code yang mungkin masih baca dari sana.
            // Mereka tidak dikirim sebagai top-level column ke Supabase lagi.

            if (data.access_control.mode === 'scheduled') {
                if (data.access_control.scheduled.start) {
                    const start = new Date(data.access_control.scheduled.start);
                    if (!isNaN(start)) {
                        const mins = parseInt(data.ujian.time) || 0;
                        const end  = new Date(start.getTime() + mins * 60_000);
                        data.access_control.scheduled.end    = end.toISOString();
                        data.access_control.scheduled.active = true;
                    }
                }
            } else {
                // BUG FIX: clear ALL time-related fields for manual mode
                // exam-admin-controller reads access_control.end (top-level) for RUNNING check
                // if this is leftover from a previous session it causes instant FINISHED status
                data.access_control.scheduled    = { start: null, end: null, active: false };
                data.access_control.end          = null;
                data.access_control.remaining_time = null;
                // Ensure manual_status is explicitly set for calculateExamStatus()
                if (!data.access_control.manual_status) {
                    data.access_control.manual_status = 'closed';
                }
            }
            return data;
        }
    };
})();