// =============================================================================
// metadata-card.js — Card 1: assessment metadata + identity system + catatan
// =============================================================================
// Wires all inputs in Card 1 of create-assessment.html to
// window.CreateAssessment state (v1.0.0 flat schema).
// Identity system supports 'manual' (custom fields builder) and 'daftar'
// (pick from daftar_nama table).
// Theme editor (Google Form-like) is owned by create-assessment.js
// initThemeEditor() — NOT wired here anymore.
// Loaded as classic <script defer>. Exposes window.MetadataCard.
// =============================================================================

(function () {
  'use strict';

  // v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
  const t = (key, vars, fallback) => {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key, vars);
      return v !== undefined ? v : fallback;
    }
    return fallback;
  };

  const MetadataCard = {
    init() {
      this._judul = document.getElementById('assessment-title');
      this._mapel = document.getElementById('assessment-subject');
      this._time = document.getElementById('assessment-duration');
      this._modePembuka = document.getElementById('assessment-access-mode');
      this._scheduledField = document.getElementById('scheduled-field');
      this._scheduledStart = document.getElementById('assessment-scheduled-start');
      this._judulHint = document.getElementById('title-hint');

      // Identity
      this._identityManual = document.getElementById('identity-manual');
      this._identityDaftar = document.getElementById('identity-daftar');
      this._identityFields = document.getElementById('identity-fields');
      this._btnAddField = document.getElementById('btn-add-field');
      this._daftarSelect = document.getElementById('daftar-select');

      // Catatan
      this._catatan = document.getElementById('note-toggle');
      this._catatanTextField = document.getElementById('note-text-field');
      this._isCatatan = document.getElementById('note-text');

      // Allow retake (NEW v1.0.0)
      this._allowRetake = document.getElementById('allow-retake');

      if (!this._judul) {
        console.warn('[MetadataCard] required elements missing — not on create-assessment page');
        return;
      }

      this._wireEvents();
      this._renderIdentityFields();
      this._loadDaftarOptions();

      window.CreateAssessment.subscribe((state) => this._sync(state));
    },

    _wireEvents() {
      // Judul
      this._judul.addEventListener('input', (e) => {
        const state = window.CreateAssessment.getState();
        state.examData.title = e.target.value;
        window.CreateAssessment.setState({ examData: state.examData });
        this._validateJudul();
      });

      // Mata pelajaran
      this._mapel.addEventListener('input', (e) => {
        const state = window.CreateAssessment.getState();
        state.examData.subject = e.target.value;
        window.CreateAssessment.setState({ examData: state.examData });
      });

      // Durasi (NEW: stored as number `duration_minutes`, not string `time`)
      this._time.addEventListener('input', (e) => {
        const state = window.CreateAssessment.getState();
        const num = parseInt(e.target.value, 10);
        state.examData.duration_minutes = isNaN(num) ? 0 : num;
        window.CreateAssessment.setState({ examData: state.examData });
      });

      // Access mode (NEW: values 'manual'/'scheduled', was 'Manual'/'Otomatis')
      this._modePembuka.addEventListener('change', (e) => {
        const state = window.CreateAssessment.getState();
        state.examData.access_mode = e.target.value;
        window.CreateAssessment.setState({ examData: state.examData });
        this._scheduledField.hidden = e.target.value !== 'scheduled';
      });

      // Scheduled start (NEW: top-level state.scheduled_start, was nested access_control.scheduled.start)
      this._scheduledStart.addEventListener('change', (e) => {
        const value = e.target.value || null;
        window.CreateAssessment.setState({ scheduled_start: value });
      });

      // Identity mode toggle
      document.querySelectorAll('input[name="identity_mode"]').forEach((radio) => {
        radio.addEventListener('change', (e) => {
          const state = window.CreateAssessment.getState();
          state.examData.identity_mode = e.target.value;
          this._identityManual.hidden = e.target.value !== 'manual';
          this._identityDaftar.hidden = e.target.value !== 'daftar';
          window.CreateAssessment.setState({ examData: state.examData });
        });
      });

      // Add identity field
      this._btnAddField.addEventListener('click', () => this._addField());

      // Catatan (NEW: state.note_enabled boolean + state.note_text; UI still Off/On select)
      this._catatan.addEventListener('change', (e) => {
        const state = window.CreateAssessment.getState();
        const enabled = e.target.value === 'On';
        state.examData.note_enabled = enabled;
        if (!enabled) state.examData.note_text = null;
        this._catatanTextField.hidden = !enabled;
        window.CreateAssessment.setState({ examData: state.examData });
      });

      this._isCatatan.addEventListener('input', (e) => {
        const state = window.CreateAssessment.getState();
        state.examData.note_text = e.target.value;
        window.CreateAssessment.setState({ examData: state.examData });
      });

      // Allow retake (NEW v1.0.0)
      if (this._allowRetake) {
        this._allowRetake.addEventListener('change', (e) => {
          const state = window.CreateAssessment.getState();
          state.examData.allow_retake = e.target.checked;
          window.CreateAssessment.setState({ examData: state.examData });
        });
      }
    },

    _renderIdentityFields() {
      const state = window.CreateAssessment.getState();
      const fields = state.examData.identity_config?.fields || [];

      this._identityFields.innerHTML = fields.map((f, i) => `
        <div class="albedu-identity-field" data-index="${i}">
          <input type="text" class="albedu-field-input" data-field="label" value="${this._esc(f.label)}" placeholder="Label (e.g. Nama)">
          <select class="albedu-field-input" data-field="type">
            <option value="text" ${f.type === 'text' ? 'selected' : ''}>Text</option>
            <option value="select" ${f.type === 'select' ? 'selected' : ''}>Select</option>
          </select>
          <input type="text" class="albedu-field-input" data-field="options"
                 value="${this._esc((f.options || []).join(', '))}"
                 placeholder="Opsi (pisah koma)" ${f.type !== 'select' ? 'hidden' : ''}>
          <button class="albedu-btn albedu-btn-ghost albedu-btn-sm albedu-field-delete" data-index="${i}" type="button" aria-label="Hapus field">
            <i class="material-symbols-outlined">delete</i>
          </button>
        </div>
      `).join('');

      // Wire inputs
      this._identityFields.querySelectorAll('.albedu-field-input').forEach((input) => {
        input.addEventListener('input', (e) => {
          const idx = parseInt(e.target.closest('.albedu-identity-field').dataset.index, 10);
          const field = e.target.dataset.field;
          const state = window.CreateAssessment.getState();
          const f = state.examData.identity_config.fields[idx];
          if (!f) return;
          if (field === 'options') {
            f.options = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
          } else {
            f[field] = e.target.value;
          }
          window.CreateAssessment.setState({ examData: state.examData });
        });
        // For select (type) — re-render to show/hide options input
        if (input.dataset.field === 'type') {
          input.addEventListener('change', () => this._renderIdentityFields());
        }
      });

      // Wire delete buttons
      this._identityFields.querySelectorAll('.albedu-field-delete').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index, 10);
          const state = window.CreateAssessment.getState();
          state.examData.identity_config.fields.splice(idx, 1);
          window.CreateAssessment.setState({ examData: state.examData });
          this._renderIdentityFields();
        });
      });
    },

    _addField() {
      const state = window.CreateAssessment.getState();
      state.examData.identity_config.fields.push({
        id: 'field_' + Math.random().toString(36).slice(2, 8),
        type: 'text',
        label: '',
        placeholder: '',
        required: false,
      });
      window.CreateAssessment.setState({ examData: state.examData });
      this._renderIdentityFields();
    },

    async _loadDaftarOptions() {
      if (!this._daftarSelect) return;

      // Wire change listener once
      this._daftarSelect.addEventListener('change', (e) => {
        const state = window.CreateAssessment.getState();
        const id = e.target.value || null;
        state.examData.identity_config = state.examData.identity_config || {};
        state.examData.identity_config.daftar_id = id;
        // daftar_tipe / daftar_label / tabs akan diisi nanti oleh exam-taker
        // dari lookup table `daftar_nama`. Untuk wizard, cukup simpan id-nya.
        window.CreateAssessment.setState({ examData: state.examData });
      });

      try {
        const db = window.firebaseDb;
        if (!db) {
          // No DB available — leave placeholder
          return;
        }
        const snap = await db.collection('daftar_nama').get();
        const daftarList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._daftarSelect.innerHTML = '<option value="">— Pilih daftar —</option>' +
          daftarList.map((d) => `<option value="${this._esc(d.id)}">${this._esc(d.nama_daftar || d.id)}</option>`).join('');
      } catch (err) {
        console.warn('[MetadataCard] failed to load daftar:', err);
      }
    },

    _validateJudul() {
      const val = this._judul.value.trim();
      if (val.length === 0) {
        this._judulHint.textContent = '';
        this._judulHint.classList.remove('albedu-hint-error');
        this._judul.classList.remove('albedu-field-error');
      } else if (val.length < 5) {
        this._judulHint.textContent = t('create.judul_hint', { count: val.length }, `Min. 5 karakter (saat ini ${val.length})`);
        this._judulHint.classList.add('albedu-hint-error');
        this._judul.classList.add('albedu-field-error');
      } else {
        this._judulHint.textContent = '';
        this._judulHint.classList.remove('albedu-hint-error');
        this._judul.classList.remove('albedu-field-error');
      }
    },

    _sync(state) {
      const u = state.examData;
      if (this._judul.value !== (u.title || '')) this._judul.value = u.title || '';
      if (this._mapel.value !== (u.subject || '')) this._mapel.value = u.subject || '';
      const durasiStr = String(u.duration_minutes ?? '');
      if (this._time.value !== durasiStr) this._time.value = durasiStr;
      if (this._modePembuka.value !== (u.access_mode || 'manual')) {
        this._modePembuka.value = u.access_mode || 'manual';
      }
      this._scheduledField.hidden = u.access_mode !== 'scheduled';

      // Sync scheduled start (top-level state field)
      const schedVal = state.scheduled_start || '';
      if (this._scheduledStart.value !== schedVal) this._scheduledStart.value = schedVal;

      // Catatan: UI shows 'On'/'Off', state stores boolean note_enabled
      const catatanVal = u.note_enabled ? 'On' : 'Off';
      if (this._catatan.value !== catatanVal) this._catatan.value = catatanVal;
      this._catatanTextField.hidden = !u.note_enabled;
      if (this._isCatatan.value !== (u.note_text || '')) {
        this._isCatatan.value = u.note_text || '';
      }

      // Allow retake
      if (this._allowRetake) this._allowRetake.checked = !!u.allow_retake;

      // Sync identity mode radio
      document.querySelectorAll('input[name="identity_mode"]').forEach((radio) => {
        radio.checked = radio.value === u.identity_mode;
      });
      this._identityManual.hidden = u.identity_mode !== 'manual';
      this._identityDaftar.hidden = u.identity_mode !== 'daftar';
    },

    _esc(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };

  window.MetadataCard = MetadataCard;
})();
