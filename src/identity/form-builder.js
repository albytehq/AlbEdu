// =============================================================================
// IdentityFormBuilder.js — AlbEdu Identity Form Builder v1.0.0
// =============================================================================
//
// Admin-side form builder untuk mode "Manual" identity.
// Menghasilkan konfigurasi fields[] yang akan disimpan di ujian.identity_config.
//
// Field types yang didukung:
//   - text      → textbox biasa (Nama, NISN, dll)
//   - number    → input numerik (No Absen, NISN numeric)
//   - select    → dropdown dengan options (Kelas, Jenjang, dll)
//   - textarea  → input multi-line (Alamat, Catatan)
//   - email     → input email dengan validasi format
//
// Aturan validasi:
//   - Minimal 1 field harus ada
//   - Minimal 1 field harus punya label yang mengandung "nama" (case-insensitive)
//     → ini jadi _display_name key untuk peserta
//   - Maksimal 10 fields per ujian
//   - Label maksimal 30 karakter
//   - Placeholder maksimal 80 karakter
//   - max_length maksimal 200 (untuk text/textarea)
//   - Select wajib punya minimal 1 option, maksimal 20 options
//   - Option value maksimal 50 karakter
//
// Public API:
//   - mount(container)           → render builder ke container
//   - getFieldConfig()           → return array of field configs
//   - loadConfig(fieldsConfig)   → load existing config ke builder
//   - validate()                 → return array of error strings (kosong = valid)
//   - destroy()                  → cleanup
//
// Events (dispatched ke document):
//   - identity-fields-change     → detail: { fields: [...] }
// =============================================================================

window.IdentityFormBuilder = (() => {
  // v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
  const t = (key, vars, fallback) => {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key, vars);
      return v !== undefined ? v : fallback;
    }
    return fallback;
  };
  const MAX_FIELDS        = 10;
  const MIN_FIELDS        = 1;
  const MAX_LABEL_LEN     = 30;
  const MAX_PLACEHOLDER   = 80;
  const MAX_MAX_LENGTH    = 200;
  const MAX_OPTIONS       = 20;
  const MIN_OPTIONS       = 1;
  const MAX_OPTION_LEN    = 50;

  const FIELD_TYPES = [
    { value: 'text',     label: t('identity.type_text', null, 'Teks Pendek'),  icon: 'Aa',  desc: t('identity.type_text_desc', null, 'Nama, NISN, dll') },
    { value: 'number',   label: t('identity.type_number', null, 'Angka'),        icon: '123', desc: t('identity.type_number_desc', null, 'Nomor absen, NISN numerik') },
    { value: 'select',   label: t('identity.type_select', null, 'Dropdown'),     icon: '▾',   desc: t('identity.type_select_desc', null, 'Pilihan ganda (Kelas, Jenjang)') },
    { value: 'textarea', label: t('identity.type_textarea', null, 'Teks Panjang'), icon: '¶',   desc: t('identity.type_textarea_desc', null, 'Alamat, catatan') },
    { value: 'email',    label: t('identity.type_email', null, 'Email'),        icon: '@',   desc: t('identity.type_email_desc', null, 'Input email dengan validasi') },
  ];

  // ── State ────────────────────────────────────────────────────────────────
  let _container = null;
  let _fields    = [];
  let _onChangeCb = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _genFieldId() {
    return 'field_' + Math.random().toString(36).slice(2, 10);
  }

  function _defaultNamaField() {
    return {
      id:          _genFieldId(),
      type:        'text',
      label:       'Nama',
      placeholder: 'Masukkan nama lengkap',
      required:    true,
      max_length:  50,
    };
  }

  function _defaultKelasField(options = ['7A', '7B', '7C', '7D']) {
    return {
      id:       _genFieldId(),
      type:     'select',
      label:    'Kelas',
      required: true,
      options:  [...options],
    };
  }

  function _defaultTemplate() {
    return [_defaultNamaField(), _defaultKelasField()];
  }

  function _cloneFields() {
    return _fields.map(f => ({
      ...f,
      options: Array.isArray(f.options) ? [...f.options] : undefined,
    }));
  }

  function _emitChange() {
    if (_onChangeCb) _onChangeCb(_cloneFields());
    document.dispatchEvent(new CustomEvent('identity-fields-change', {
      detail: { fields: _cloneFields() },
    }));
    _render(); // re-render setelah state berubah
  }

  // ── Validation ───────────────────────────────────────────────────────────

  function validate() {
    const errors = [];

    if (!Array.isArray(_fields) || _fields.length < MIN_FIELDS) {
      errors.push(`Minimal ${MIN_FIELDS} field harus ada.`);
      return errors;
    }
    if (_fields.length > MAX_FIELDS) {
      errors.push(`Maksimal ${MAX_FIELDS} field.`);
      return errors;
    }

    // Cek label "nama" — minimal 1 field
    const hasNamaField = _fields.some(f =>
      (f.label || '').toLowerCase().includes('nama')
    );
    if (!hasNamaField) {
      errors.push('Minimal 1 field harus punya label yang mengandung kata "nama".');
    }

    // Validate per field
    const seenIds = new Set();
    const seenLabels = new Set();
    _fields.forEach((f, idx) => {
      const prefix = `Field #${idx + 1}`;

      // ID
      if (!f.id) {
        errors.push(`${prefix}: ID kosong.`);
      } else if (seenIds.has(f.id)) {
        errors.push(`${prefix}: ID duplikat.`);
      } else {
        seenIds.add(f.id);
      }

      // Type
      if (!FIELD_TYPES.some(t => t.value === f.type)) {
        errors.push(`${prefix}: Tipe tidak valid ("${f.type}").`);
      }

      // Label
      const label = (f.label || '').trim();
      if (!label) {
        errors.push(`${prefix}: Label wajib diisi.`);
      } else if (label.length > MAX_LABEL_LEN) {
        errors.push(`${prefix}: Label melebihi ${MAX_LABEL_LEN} karakter.`);
      } else if (seenLabels.has(label.toLowerCase())) {
        errors.push(`${prefix}: Label "${label}" duplikat.`);
      } else {
        seenLabels.add(label.toLowerCase());
      }

      // Placeholder
      if (f.placeholder && f.placeholder.length > MAX_PLACEHOLDER) {
        errors.push(`${prefix}: Placeholder melebihi ${MAX_PLACEHOLDER} karakter.`);
      }

      // max_length
      if (['text', 'textarea'].includes(f.type)) {
        if (f.max_length != null) {
          if (!Number.isInteger(f.max_length) || f.max_length < 1) {
            errors.push(`${prefix}: max_length harus integer positif.`);
          } else if (f.max_length > MAX_MAX_LENGTH) {
            errors.push(`${prefix}: max_length maksimal ${MAX_MAX_LENGTH}.`);
          }
        }
      }

      // Select: options
      if (f.type === 'select') {
        if (!Array.isArray(f.options) || f.options.length < MIN_OPTIONS) {
          errors.push(`${prefix}: Tipe select wajib punya minimal ${MIN_OPTIONS} option.`);
        } else if (f.options.length > MAX_OPTIONS) {
          errors.push(`${prefix}: Tipe select maksimal ${MAX_OPTIONS} options.`);
        } else {
          const seenOpts = new Set();
          f.options.forEach((opt, i) => {
            const v = (opt || '').trim();
            if (!v) {
              errors.push(`${prefix}: Option #${i + 1} kosong.`);
            } else if (v.length > MAX_OPTION_LEN) {
              errors.push(`${prefix}: Option "${v}" melebihi ${MAX_OPTION_LEN} karakter.`);
            } else if (seenOpts.has(v.toLowerCase())) {
              errors.push(`${prefix}: Option "${v}" duplikat.`);
            } else {
              seenOpts.add(v.toLowerCase());
            }
          });
        }
      }
    });

    return errors;
  }

  // ── Public: getState & setState ──────────────────────────────────────────

  function getFieldConfig() {
    return _cloneFields();
  }

  function loadConfig(fieldsConfig) {
    if (!Array.isArray(fieldsConfig)) {
      _fields = _defaultTemplate();
    } else if (fieldsConfig.length === 0) {
      _fields = _defaultTemplate();
    } else {
      _fields = fieldsConfig.map(f => ({
        id:          f.id || _genFieldId(),
        type:        f.type || 'text',
        label:       f.label || '',
        placeholder: f.placeholder || '',
        required:    !!f.required,
        max_length:  f.max_length,
        options:     Array.isArray(f.options) ? [...f.options] : undefined,
      }));
    }
    _render();
  }

  function setOnChange(cb) {
    _onChangeCb = cb;
  }

  // ── Field operations ─────────────────────────────────────────────────────

  function addField(type = 'text') {
    if (_fields.length >= MAX_FIELDS) return;
    const newField = {
      id:          _genFieldId(),
      type:        type,
      label:       '',
      placeholder: '',
      required:    false,
      max_length:  type === 'textarea' ? 200 : 50,
      options:     type === 'select' ? [''] : undefined,
    };
    _fields.push(newField);
    _emitChange();
  }

  function removeField(fieldId) {
    if (_fields.length <= MIN_FIELDS) return;
    _fields = _fields.filter(f => f.id !== fieldId);
    _emitChange();
  }

  function updateField(fieldId, props) {
    _fields = _fields.map(f => f.id === fieldId ? { ...f, ...props } : f);
    _emitChange();
  }

  function reorderFields(fromIdx, toIdx) {
    if (fromIdx < 0 || fromIdx >= _fields.length) return;
    if (toIdx < 0 || toIdx >= _fields.length) return;
    if (fromIdx === toIdx) return;
    const item = _fields.splice(fromIdx, 1)[0];
    _fields.splice(toIdx, 0, item);
    _emitChange();
  }

  function moveFieldUp(idx) {
    if (idx <= 0) return;
    reorderFields(idx, idx - 1);
  }

  function moveFieldDown(idx) {
    if (idx >= _fields.length - 1) return;
    reorderFields(idx, idx + 1);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function _render() {
    if (!_container) return;
    _container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'ifb-header';
    header.innerHTML = `
      <div class="ifb-header__title">
        <i class="material-symbols-outlined ifb-header__icon">edit_note</i>
        <span>Form Builder Identitas Peserta</span>
      </div>
      <div class="ifb-header__count">${_fields.length} / ${MAX_FIELDS} field</div>
    `;
    _container.appendChild(header);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'ifb-hint';
    hint.innerHTML = `
      <strong>Aturan:</strong>
      Minimal 1 field harus punya label mengandung kata <em>"nama"</em>
      (digunakan sebagai display name peserta di hasil ujian).
    `;
    _container.appendChild(hint);

    // Field list
    const list = document.createElement('div');
    list.className = 'ifb-list';

    if (_fields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ifb-empty';
      empty.textContent = 'Belum ada field. Klik "Tambah Field" di bawah.';
      list.appendChild(empty);
    } else {
      _fields.forEach((field, idx) => {
        list.appendChild(_renderFieldCard(field, idx));
      });
    }
    _container.appendChild(list);

    // Add field buttons
    if (_fields.length < MAX_FIELDS) {
      const addSection = document.createElement('div');
      addSection.className = 'ifb-add-section';

      const addLabel = document.createElement('div');
      addLabel.className = 'ifb-add-label';
      addLabel.textContent = t('identity.add_field_label', null, 'Tambah field:');
      addSection.appendChild(addLabel);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'ifb-btn-group';
      FIELD_TYPES.forEach(t => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ifb-add-btn';
        btn.innerHTML = `
          <span class="ifb-add-btn__icon">${t.icon}</span>
          <span class="ifb-add-btn__label">${t.label}</span>
          <span class="ifb-add-btn__desc">${t.desc}</span>
        `;
        btn.onclick = () => addField(t.value);
        btnGroup.appendChild(btn);
      });
      addSection.appendChild(btnGroup);
      _container.appendChild(addSection);
    }
  }

  function _renderFieldCard(field, idx) {
    const card = document.createElement('div');
    card.className = 'ifb-card';
    card.dataset.fieldId = field.id;
    card.dataset.index = idx;

    // Card header
    const head = document.createElement('div');
    head.className = 'ifb-card__head';
    const typeMeta = FIELD_TYPES.find(t => t.value === field.type) || FIELD_TYPES[0];
    head.innerHTML = `
      <span class="ifb-card__icon">${typeMeta.icon}</span>
      <span class="ifb-card__type">${typeMeta.label}</span>
      <span class="ifb-card__index">#${idx + 1}</span>
      <div class="ifb-card__actions"></div>
    `;

    // Move up/down buttons
    const actions = head.querySelector('.ifb-card__actions');

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'ifb-icon-btn';
    upBtn.innerHTML = '<i class="material-symbols-outlined" style="font-size:14px;">arrow_upward</i>';
    upBtn.title = 'Pindah ke atas';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => moveFieldUp(idx);
    actions.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'ifb-icon-btn';
    downBtn.innerHTML = '<i class="material-symbols-outlined" style="font-size:14px;">arrow_downward</i>';
    downBtn.title = 'Pindah ke bawah';
    downBtn.disabled = idx === _fields.length - 1;
    downBtn.onclick = () => moveFieldDown(idx);
    actions.appendChild(downBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ifb-icon-btn ifb-icon-btn--danger';
    delBtn.innerHTML = '<i class="material-symbols-outlined" style="font-size:14px;">close</i>';
    delBtn.title = 'Hapus field';
    delBtn.disabled = _fields.length <= MIN_FIELDS;
    delBtn.onclick = () => {
      if (confirm(`Hapus field "${field.label || 'tanpa label'}"?`)) {
        removeField(field.id);
      }
    };
    actions.appendChild(delBtn);

    card.appendChild(head);

    // Card body — inputs
    const body = document.createElement('div');
    body.className = 'ifb-card__body';

    // Label
    body.appendChild(_renderInput({
      label: 'Label',
      value: field.label,
      placeholder: 'cth: Nama, NISN, Kelas',
      maxlength: MAX_LABEL_LEN,
      required: true,
      onChange: v => updateField(field.id, { label: v }),
    }));

    // Placeholder (skip untuk select)
    if (field.type !== 'select') {
      body.appendChild(_renderInput({
        label: 'Placeholder',
        value: field.placeholder || '',
        placeholder: 'cth: Masukkan nama lengkap',
        maxlength: MAX_PLACEHOLDER,
        onChange: v => updateField(field.id, { placeholder: v }),
      }));
    }

    // max_length (hanya text & textarea)
    if (['text', 'textarea'].includes(field.type)) {
      body.appendChild(_renderInput({
        label: 'Panjang maksimum',
        type: 'number',
        value: field.max_length != null ? String(field.max_length) : '',
        placeholder: '50',
        min: 1,
        max: MAX_MAX_LENGTH,
        onChange: v => {
          const n = parseInt(v, 10);
          updateField(field.id, { max_length: isNaN(n) ? null : n });
        },
      }));
    }

    // Options (hanya select)
    if (field.type === 'select') {
      body.appendChild(_renderOptionsEditor(field));
    }

    // Required toggle
    body.appendChild(_renderToggle({
      label: 'Wajib diisi (required)',
      checked: field.required,
      onChange: v => updateField(field.id, { required: v }),
    }));

    card.appendChild(body);
    return card;
  }

  function _renderInput({ label, value, placeholder, type = 'text', required, maxlength, min, max, onChange }) {
    const wrap = document.createElement('div');
    wrap.className = 'ifb-input';

    const lbl = document.createElement('label');
    lbl.className = 'ifb-input__label';
    lbl.innerHTML = required ? `${label} <span class="ifb-required">*</span>` : label;
    wrap.appendChild(lbl);

    const inp = document.createElement('input');
    inp.className = 'ifb-input__field';
    inp.type = type;
    inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    if (maxlength) inp.maxlength = maxlength;
    if (min != null) inp.min = min;
    if (max != null) inp.max = max;
    inp.oninput = e => onChange(e.target.value);
    wrap.appendChild(inp);

    return wrap;
  }

  function _renderToggle({ label, checked, onChange }) {
    const wrap = document.createElement('label');
    wrap.className = 'ifb-toggle';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ifb-toggle__checkbox';
    cb.checked = !!checked;
    cb.onchange = e => onChange(e.target.checked);
    wrap.appendChild(cb);

    const txt = document.createElement('span');
    txt.className = 'ifb-toggle__label';
    txt.textContent = label;
    wrap.appendChild(txt);

    return wrap;
  }

  function _renderOptionsEditor(field) {
    const wrap = document.createElement('div');
    wrap.className = 'ifb-options';

    const lbl = document.createElement('label');
    lbl.className = 'ifb-input__label';
    lbl.innerHTML = `Options <span class="ifb-required">*</span> (min ${MIN_OPTIONS}, max ${MAX_OPTIONS})`;
    wrap.appendChild(lbl);

    const list = document.createElement('div');
    list.className = 'ifb-options__list';

    const options = Array.isArray(field.options) ? field.options : [];
    options.forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'ifb-options__row';

      const inp = document.createElement('input');
      inp.className = 'ifb-input__field ifb-options__input';
      inp.type = 'text';
      inp.value = opt || '';
      inp.placeholder = `Option #${i + 1}`;
      inp.maxlength = MAX_OPTION_LEN;
      inp.oninput = e => {
        const newOpts = [...options];
        newOpts[i] = e.target.value;
        updateField(field.id, { options: newOpts });
      };
      row.appendChild(inp);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ifb-icon-btn ifb-icon-btn--danger';
      delBtn.innerHTML = '<i class="material-symbols-outlined" style="font-size:14px;">close</i>';
      delBtn.disabled = options.length <= MIN_OPTIONS;
      delBtn.onclick = () => {
        const newOpts = options.filter((_, j) => j !== i);
        updateField(field.id, { options: newOpts });
      };
      row.appendChild(delBtn);

      list.appendChild(row);
    });
    wrap.appendChild(list);

    if (options.length < MAX_OPTIONS) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ifb-btn ifb-btn--secondary ifb-btn--sm';
      addBtn.textContent = '+ Tambah option';
      addBtn.onclick = () => {
        updateField(field.id, { options: [...options, ''] });
      };
      wrap.appendChild(addBtn);
    }

    return wrap;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function mount(container, initialConfig = null) {
    if (!container) throw new Error('Container required');
    _container = container;
    if (Array.isArray(initialConfig) && initialConfig.length > 0) {
      _fields = initialConfig.map(f => ({
        id:          f.id || _genFieldId(),
        type:        f.type || 'text',
        label:       f.label || '',
        placeholder: f.placeholder || '',
        required:    !!f.required,
        max_length:  f.max_length,
        options:     Array.isArray(f.options) ? [...f.options] : undefined,
      }));
    } else {
      _fields = _defaultTemplate();
    }
    _render();
  }

  function destroy() {
    _container = null;
    _fields = [];
    _onChangeCb = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    // Constants
    MAX_FIELDS, MIN_FIELDS, MAX_LABEL_LEN, MAX_PLACEHOLDER, MAX_MAX_LENGTH,
    MAX_OPTIONS, MIN_OPTIONS, MAX_OPTION_LEN, FIELD_TYPES,

    // Lifecycle
    mount, destroy, setOnChange,

    // State
    getFieldConfig, loadConfig,

    // Validation
    validate,

    // Field ops
    addField, removeField, updateField, reorderFields, moveFieldUp, moveFieldDown,
  };
})();
