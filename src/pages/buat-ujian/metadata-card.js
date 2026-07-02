// =============================================================================
// metadata-card.js — Card 1: ujian metadata + identity system + catatan
// =============================================================================
// Wires all inputs in Card 1 of buat-ujian.html to window.BuatUjian state.
// Identity system supports 'manual' (custom fields builder) and 'daftar'
// (pick from daftar_nama table) — replaces the dropped `kelas` field.
// Loaded as classic <script defer>. Exposes window.MetadataCard.
// =============================================================================

(function () {
  'use strict';

  const MetadataCard = {
    init() {
      this._judul = document.getElementById('bu-judul');
      this._mapel = document.getElementById('bu-mapel');
      this._time = document.getElementById('bu-time');
      this._modePembuka = document.getElementById('bu-mode-pembuka');
      this._scheduledField = document.getElementById('bu-scheduled-field');
      this._scheduledStart = document.getElementById('bu-scheduled-start');
      this._judulHint = document.getElementById('bu-judul-hint');

      // Identity
      this._identityManual = document.getElementById('bu-identity-manual');
      this._identityDaftar = document.getElementById('bu-identity-daftar');
      this._identityFields = document.getElementById('bu-identity-fields');
      this._btnAddField = document.getElementById('bu-btn-add-field');
      this._daftarSelect = document.getElementById('bu-daftar-select');

      // Catatan
      this._catatan = document.getElementById('bu-catatan');
      this._catatanTextField = document.getElementById('bu-catatan-text-field');
      this._isCatatan = document.getElementById('bu-is-catatan');

      // Theme color pickers (CU, HJ, TW) — v0.2.0
      this._colorCU = document.getElementById('bu-color-cu');
      this._colorHJ = document.getElementById('bu-color-hj');
      this._colorTW = document.getElementById('bu-color-tw');
      this._colorControls = document.querySelectorAll('.bu-color-control');
      this._colorResets = document.querySelectorAll('.bu-color-reset');

      if (!this._judul) {
        console.warn('[MetadataCard] required elements missing — not on buat-ujian page');
        return;
      }

      this._wireEvents();
      this._renderIdentityFields();
      this._loadDaftarOptions();
      this._wireThemePickers();
      this._syncThemePickers();

      window.BuatUjian.subscribe((state) => this._sync(state));
    },

    _wireEvents() {
      // Judul
      this._judul.addEventListener('input', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.judul = e.target.value;
        window.BuatUjian.setState(state);
        this._validateJudul();
      });

      // Mata pelajaran
      this._mapel.addEventListener('input', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.mata_pelajaran = e.target.value;
        window.BuatUjian.setState(state);
      });

      // Durasi
      this._time.addEventListener('input', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.time = e.target.value;
        window.BuatUjian.setState(state);
      });

      // Mode pembuka
      this._modePembuka.addEventListener('change', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.mode_pembuka = e.target.value;
        state.examData.access_control.mode = e.target.value === 'Otomatis' ? 'scheduled' : 'manual';
        window.BuatUjian.setState(state);
        this._scheduledField.hidden = e.target.value !== 'Otomatis';
      });

      // Scheduled start
      this._scheduledStart.addEventListener('change', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.access_control.scheduled.start = e.target.value
          ? new Date(e.target.value).toISOString()
          : null;
        window.BuatUjian.setState(state);
      });

      // Identity mode toggle
      document.querySelectorAll('input[name="identity_mode"]').forEach((radio) => {
        radio.addEventListener('change', (e) => {
          const state = window.BuatUjian.getState();
          state.examData.ujian.identity_mode = e.target.value;
          this._identityManual.hidden = e.target.value !== 'manual';
          this._identityDaftar.hidden = e.target.value !== 'daftar';
          window.BuatUjian.setState(state);
        });
      });

      // Add identity field
      this._btnAddField.addEventListener('click', () => this._addField());

      // Catatan
      this._catatan.addEventListener('change', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.catatan = e.target.value;
        this._catatanTextField.hidden = e.target.value !== 'On';
        window.BuatUjian.setState(state);
      });

      this._isCatatan.addEventListener('input', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.is_catatan = e.target.value;
        window.BuatUjian.setState(state);
      });
    },

    // ── Theme color pickers (CU / HJ / TW) — v0.2.0 ──
    // Native <input type="color"> is visually hidden; the .bu-color-control
    // wrapper shows a custom swatch + hex code. Click on the wrapper opens
    // the native color picker. Reset button clears the value (sets to null).
    _wireThemePickers() {
      // Click on the wrapper → triggers the hidden native color input
      this._colorControls.forEach((ctrl) => {
        const input = ctrl.querySelector('.bu-color-input');
        if (!input) return;
        ctrl.addEventListener('click', (e) => {
          // Don't trigger if user clicked the reset button
          if (e.target.closest('.bu-color-reset')) return;
          input.click();
        });
      });

      // Color input change → update state + UI
      const handleColorChange = (e) => {
        const which = e.target.id.replace('bu-color-', '').toUpperCase(); // CU/HJ/TW
        const hex = e.target.value;
        const state = window.BuatUjian.getState();
        state.examData.ujian.theme[which] = hex;
        // Mark tema as 'custom' if any color differs from default
        state.examData.ujian.theme.tema = this._hasCustomColors(state) ? 'custom' : 'default';
        window.BuatUjian.setState(state);
        this._updateColorUI(which, hex);
      };
      this._colorCU?.addEventListener('input', handleColorChange);
      this._colorHJ?.addEventListener('input', handleColorChange);
      this._colorTW?.addEventListener('input', handleColorChange);

      // Reset buttons → clear that color
      this._colorResets.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const which = btn.dataset.color;
          const state = window.BuatUjian.getState();
          state.examData.ujian.theme[which] = null;
          state.examData.ujian.theme.tema = this._hasCustomColors(state) ? 'custom' : 'default';
          window.BuatUjian.setState(state);
          this._updateColorUI(which, null);
        });
      });
    },

    _hasCustomColors(state) {
      const t = state.examData.ujian.theme;
      return !!(t.CU || t.HJ || t.TW);
    },

    _updateColorUI(which, hex) {
      const ctrl = document.querySelector(`.bu-color-control[data-color="${which}"]`);
      if (!ctrl) return;
      const swatch = ctrl.querySelector('.bu-color-swatch');
      const hexLabel = ctrl.querySelector('.bu-color-hex');
      if (hex) {
        swatch.style.setProperty('--swatch-color', hex);
        swatch.classList.remove('bu-color-swatch-empty');
        hexLabel.textContent = hex;
        ctrl.classList.remove('bu-color-empty');
      } else {
        swatch.classList.add('bu-color-swatch-empty');
        swatch.style.removeProperty('--swatch-color');
        hexLabel.textContent = 'Default';
        ctrl.classList.add('bu-color-empty');
      }
    },

    _syncThemePickers() {
      // Initialize UI from state on first load
      const state = window.BuatUjian.getState();
      const t = state.examData.ujian.theme;
      ['CU', 'HJ', 'TW'].forEach((which) => {
        this._updateColorUI(which, t[which]);
        // Set hidden input value (so native picker knows the current color)
        const input = document.getElementById(`bu-color-${which.toLowerCase()}`);
        if (input) input.value = t[which] || '#0f172a';
      });
    },

    _renderIdentityFields() {
      const state = window.BuatUjian.getState();
      const fields = state.examData.ujian.identity_config?.fields || [];

      this._identityFields.innerHTML = fields.map((f, i) => `
        <div class="bu-identity-field" data-index="${i}">
          <input type="text" class="bu-field-input" data-field="label" value="${this._esc(f.label)}" placeholder="Label (e.g. Nama)">
          <select class="bu-field-input" data-field="type">
            <option value="text" ${f.type === 'text' ? 'selected' : ''}>Text</option>
            <option value="select" ${f.type === 'select' ? 'selected' : ''}>Select</option>
          </select>
          <input type="text" class="bu-field-input" data-field="options"
                 value="${this._esc((f.options || []).join(', '))}"
                 placeholder="Opsi (pisah koma)" ${f.type !== 'select' ? 'hidden' : ''}>
          <button class="bu-btn bu-btn-ghost bu-btn-sm bu-field-delete" data-index="${i}" type="button" aria-label="Hapus field">
            <i class="material-symbols-outlined">delete</i>
          </button>
        </div>
      `).join('');

      // Wire inputs
      this._identityFields.querySelectorAll('.bu-field-input').forEach((input) => {
        input.addEventListener('input', (e) => {
          const idx = parseInt(e.target.closest('.bu-identity-field').dataset.index, 10);
          const field = e.target.dataset.field;
          const state = window.BuatUjian.getState();
          const f = state.examData.ujian.identity_config.fields[idx];
          if (!f) return;
          if (field === 'options') {
            f.options = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
          } else {
            f[field] = e.target.value;
          }
          window.BuatUjian.setState(state);
        });
        // For select (type) — re-render to show/hide options input
        if (input.dataset.field === 'type') {
          input.addEventListener('change', () => this._renderIdentityFields());
        }
      });

      // Wire delete buttons
      this._identityFields.querySelectorAll('.bu-field-delete').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index, 10);
          const state = window.BuatUjian.getState();
          state.examData.ujian.identity_config.fields.splice(idx, 1);
          window.BuatUjian.setState(state);
          this._renderIdentityFields();
        });
      });
    },

    _addField() {
      const state = window.BuatUjian.getState();
      state.examData.ujian.identity_config.fields.push({
        id: 'field_' + Math.random().toString(36).slice(2, 8),
        type: 'text',
        label: '',
        placeholder: '',
        required: false,
      });
      window.BuatUjian.setState(state);
      this._renderIdentityFields();
    },

    async _loadDaftarOptions() {
      if (!this._daftarSelect) return;

      // Wire change listener once
      this._daftarSelect.addEventListener('change', (e) => {
        const state = window.BuatUjian.getState();
        const id = e.target.value || null;
        state.examData.ujian.identity_config = state.examData.ujian.identity_config || {};
        state.examData.ujian.identity_config.daftar_id = id;
        // daftar_tipe / daftar_label / tabs akan diisi nanti oleh exam-taker
        // dari lookup table `daftar_nama`. Untuk wizard, cukup simpan id-nya.
        window.BuatUjian.setState(state);
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
        this._judulHint.classList.remove('bu-hint-error');
        this._judul.classList.remove('bu-field-error');
      } else if (val.length < 5) {
        this._judulHint.textContent = `Min. 5 karakter (saat ini ${val.length})`;
        this._judulHint.classList.add('bu-hint-error');
        this._judul.classList.add('bu-field-error');
      } else {
        this._judulHint.textContent = '';
        this._judulHint.classList.remove('bu-hint-error');
        this._judul.classList.remove('bu-field-error');
      }
    },

    _sync(state) {
      const u = state.examData.ujian;
      if (this._judul.value !== u.judul) this._judul.value = u.judul;
      if (this._mapel.value !== u.mata_pelajaran) this._mapel.value = u.mata_pelajaran;
      if (this._time.value !== u.time) this._time.value = u.time;
      if (this._modePembuka.value !== u.mode_pembuka) this._modePembuka.value = u.mode_pembuka;
      this._scheduledField.hidden = u.mode_pembuka !== 'Otomatis';
      this._catatanTextField.hidden = u.catatan !== 'On';
      if (this._isCatatan.value !== (u.is_catatan || '')) this._isCatatan.value = u.is_catatan || '';
      if (this._catatan.value !== u.catatan) this._catatan.value = u.catatan;

      // Sync identity mode radio
      document.querySelectorAll('input[name="identity_mode"]').forEach((radio) => {
        radio.checked = radio.value === u.identity_mode;
      });
      this._identityManual.hidden = u.identity_mode !== 'manual';
      this._identityDaftar.hidden = u.identity_mode !== 'daftar';

      // Sync theme color pickers (in case state was changed elsewhere)
      ['CU', 'HJ', 'TW'].forEach((which) => {
        this._updateColorUI(which, u.theme?.[which] || null);
      });
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
