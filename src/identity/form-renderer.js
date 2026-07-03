// =============================================================================
// IdentityFormRenderer.js — AlbEdu Identity Form Renderer v1.0.0
// =============================================================================
//
// Peserta-side form renderer untuk mode "Manual" identity.
// Render form dynamic berdasarkan fieldsConfig yang dibuat admin via IdentityFormBuilder.
//
// Supported field types: text, number, select, textarea, email
//
// Public API:
//   - mount(container, fieldsConfig)  → render form ke container
//   - validate()                       → return array of error strings
//   - getValues()                      → return {field_id: value, ...} + _meta
//   - getDisplayName()                 → return string (ambil dari field label "nama")
//   - reset()                          → clear all values
//   - destroy()                        → cleanup
// =============================================================================

window.IdentityFormRenderer = (() => {
  let _container = null;
  let _fields    = [];
  let _values    = {}; // field_id → value

  // ── Helpers ───────────────────────────────────────────────────────────

  function _findNamaField() {
    return _fields.find(f =>
      (f.label || '').toLowerCase().includes('nama')
    ) || _fields[0] || null;
  }

  function _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _isRequired(f) {
    return !!f.required;
  }

  function _getMaxlength(f) {
    if (['text', 'textarea'].includes(f.type) && f.max_length) {
      return parseInt(f.max_length, 10);
    }
    return null;
  }

  // ── Validation ────────────────────────────────────────────────────────

  function validate() {
    const errors = [];

    if (!Array.isArray(_fields) || _fields.length === 0) {
      errors.push('Konfigurasi form kosong.');
      return errors;
    }

    _fields.forEach(f => {
      const v   = _values[f.id] != null ? String(_values[f.id]).trim() : '';
      const lbl = f.label || f.id;

      // Required check
      if (_isRequired(f) && !v) {
        errors.push(`Field "${lbl}" wajib diisi.`);
        return;
      }

      if (!v) return; // optional & empty → skip further checks

      // Type-specific
      switch (f.type) {
        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
            errors.push(`Field "${lbl}": format email tidak valid.`);
          }
          break;
        case 'number':
          if (!/^-?\d+(\.\d+)?$/.test(v)) {
            errors.push(`Field "${lbl}": harus berupa angka.`);
          }
          break;
        case 'select':
          if (!Array.isArray(f.options) || !f.options.includes(v)) {
            errors.push(`Field "${lbl}": nilai tidak ada di opsi.`);
          }
          break;
      }

      // max_length
      const ml = _getMaxlength(f);
      if (ml && v.length > ml) {
        errors.push(`Field "${lbl}": melebihi ${ml} karakter.`);
      }
    });

    return errors;
  }

  // ── Get values ────────────────────────────────────────────────────────

  function getValues() {
    const result = {};
    _fields.forEach(f => {
      const v = _values[f.id];
      result[f.id] = v != null ? v : '';
    });
    return result;
  }

  function getDisplayName() {
    const namaField = _findNamaField();
    if (!namaField) return '';
    const v = _values[namaField.id];
    return v != null ? String(v).trim() : '';
  }

  function getIdentityObject() {
    return {
      _mode: 'manual',
      _display_name: getDisplayName(),
      ...getValues(),
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  function _render() {
    if (!_container) return;
    _container.innerHTML = '';

    const form = document.createElement('form');
    form.className = 'ifr-form';
    form.autocomplete = 'off';
    form.novalidate = true;
    form.onsubmit = e => e.preventDefault(); // prevent default, caller handle via button

    _fields.forEach(f => {
      form.appendChild(_renderField(f));
    });

    _container.appendChild(form);
  }

  function _renderField(f) {
    const wrap = document.createElement('div');
    wrap.className = 'ifr-field';
    wrap.dataset.fieldId = f.id;
    wrap.dataset.fieldType = f.type;

    // Label
    const lbl = document.createElement('label');
    lbl.className = 'ifr-field__label';
    lbl.htmlFor = `ifr_${f.id}`;
    lbl.innerHTML = _escapeHtml(f.label || f.id) +
      (_isRequired(f) ? ' <span class="ifr-required">*</span>' : '');
    wrap.appendChild(lbl);

    // Input by type
    let input;
    if (f.type === 'select') {
      // v2.0.0: Custom dropdown (replaces native <select>)
      const dd = _createCustomDropdown({
        placeholder: '-- Pilih --',
        options: (f.options || []).map(opt => ({ value: opt, label: opt })),
        onChange: (value) => {
          _values[f.id] = value;
          _clearFieldError(f.id);
        },
      });
      // Pre-fill if value exists
      if (_values[f.id]) {
        dd.setValue(_values[f.id]);
      }
      input = dd.element;
      input.id = `ifr_${f.id}`;
      input.classList.add('ifr-field__input');
      // Store reference for validation
      input._customDropdown = dd;
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.id = `ifr_${f.id}`;
      input.className = 'ifr-field__input';
      input.name = f.id;
      input.value = _values[f.id] != null ? _values[f.id] : '';
      if (f.placeholder) input.placeholder = f.placeholder;
      const ml = _getMaxlength(f);
      if (ml) input.maxlength = ml;
      if (_isRequired(f)) input.required = true;
      input.oninput = e => {
        _values[f.id] = e.target.value;
        _clearFieldError(f.id);
      };
    } else {
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : (f.type === 'email' ? 'email' : 'text');
      input.id = `ifr_${f.id}`;
      input.className = 'ifr-field__input';
      input.name = f.id;
      input.value = _values[f.id] != null ? _values[f.id] : '';
      if (f.placeholder) input.placeholder = f.placeholder;
      const ml = _getMaxlength(f);
      if (ml) input.maxlength = ml;
      if (_isRequired(f)) input.required = true;
      input.oninput = e => {
        _values[f.id] = e.target.value;
        _clearFieldError(f.id);
      };
    }

    wrap.appendChild(input);

    // Error container
    const errBox = document.createElement('div');
    errBox.className = 'ifr-field__error';
    errBox.id = `ifr_err_${f.id}`;
    wrap.appendChild(errBox);

    return wrap;
  }

  function _clearFieldError(fieldId) {
    const errBox = document.getElementById(`ifr_err_${fieldId}`);
    if (errBox) errBox.textContent = '';
    const wrap = _container?.querySelector(`.ifr-field[data-field-id="${fieldId}"]`);
    wrap?.classList.remove('ifr-field--error');
  }

  function _showFieldError(fieldId, msg) {
    const errBox = document.getElementById(`ifr_err_${fieldId}`);
    if (errBox) errBox.textContent = msg;
    const wrap = _container?.querySelector(`.ifr-field[data-field-id="${fieldId}"]`);
    wrap?.classList.add('ifr-field--error');
  }

  /**
   * v2.0.0 — Custom dropdown component (replaces native <select>).
   * Returns: { element, setOptions, setValue, clear }
   */
  function _createCustomDropdown({ placeholder = '-- Pilih --', options = [], onChange = () => {} } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'ifr-dropdown';
    wrap.tabIndex = 0;

    const selected = document.createElement('div');
    selected.className = 'ifr-dropdown__selected';
    selected.innerHTML = `
      <span class="ifr-dropdown__label">${_escapeHtml(placeholder)}</span>
      <span class="ifr-dropdown__arrow" data-albedu-icon="expand_more"></span>
    `;
    wrap.appendChild(selected);

    const optionsEl = document.createElement('div');
    optionsEl.className = 'ifr-dropdown__options';
    wrap.appendChild(optionsEl);

    let currentValue = '';

    function _renderOptions() {
      optionsEl.innerHTML = '';
      if (options.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ifr-dropdown__option ifr-dropdown__option--empty';
        empty.textContent = '(Kosong)';
        optionsEl.appendChild(empty);
        return;
      }
      options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'ifr-dropdown__option';
        item.dataset.value = opt.value;
        item.textContent = opt.label;
        if (opt.value === currentValue) {
          item.classList.add('ifr-dropdown__option--selected');
        }
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          _select(opt.value, opt.label);
          _close();
        });
        optionsEl.appendChild(item);
      });
    }

    function _select(value, label) {
      currentValue = value;
      const labelEl = selected.querySelector('.ifr-dropdown__label');
      if (labelEl) labelEl.textContent = label || placeholder;
      selected.classList.toggle('ifr-dropdown__selected--filled', !!value);
      onChange(value);
    }

    function _open() {
      document.querySelectorAll('.ifr-dropdown.is-open').forEach(d => {
        if (d !== wrap) d.classList.remove('is-open');
      });
      wrap.classList.add('is-open');
    }

    function _close() { wrap.classList.remove('is-open'); }

    function _toggle() {
      if (wrap.classList.contains('is-open')) _close();
      else _open();
    }

    selected.addEventListener('click', (e) => {
      e.stopPropagation();
      _toggle();
    });

    document.addEventListener('click', () => _close());

    _renderOptions();

    return {
      element: wrap,
      setOptions: (newOptions) => {
        options = newOptions;
        currentValue = '';
        const labelEl = selected.querySelector('.ifr-dropdown__label');
        if (labelEl) labelEl.textContent = placeholder;
        selected.classList.remove('ifr-dropdown__selected--filled');
        _renderOptions();
      },
      setValue: (value) => {
        const opt = options.find(o => o.value === value);
        if (opt) _select(opt.value, opt.label);
      },
      clear: () => {
        currentValue = '';
        const labelEl = selected.querySelector('.ifr-dropdown__label');
        if (labelEl) labelEl.textContent = placeholder;
        selected.classList.remove('ifr-dropdown__selected--filled');
      },
    };
  }

  function showErrors(errors) {
    // Clear all first
    _fields.forEach(f => _clearFieldError(f.id));

    // Map errors to fields
    errors.forEach(err => {
      // err format: Field "label": message  OR  Field "label" wajib diisi.
      const m = err.match(/^Field "([^"]+)":?\s*(.*)$/);
      if (m) {
        const lbl = m[1];
        const msg = m[2] || err;
        const field = _fields.find(f => (f.label || f.id) === lbl);
        if (field) {
          _showFieldError(field.id, msg);
        }
      }
    });

    // Show summary (optional)
    if (_container) {
      let summary = _container.querySelector('.ifr-error-summary');
      if (errors.length > 0) {
        if (!summary) {
          summary = document.createElement('div');
          summary.className = 'ifr-error-summary';
          _container.insertBefore(summary, _container.firstChild);
        }
        summary.innerHTML = `<strong>Perbaiki ${errors.length} error:</strong><ul>${errors.map(e => `<li>${_escapeHtml(e)}</li>`).join('')}</ul>`;
      } else if (summary) {
        summary.remove();
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  function mount(container, fieldsConfig) {
    if (!container) throw new Error('Container required');
    _container = container;
    _fields = Array.isArray(fieldsConfig) ? fieldsConfig : [];
    _values = {};
    _render();
  }

  function reset() {
    _values = {};
    if (_container) {
      _container.querySelectorAll('input, textarea').forEach(el => {
        el.value = '';
      });
      // v2.0.0: reset custom dropdowns
      _container.querySelectorAll('.ifr-dropdown').forEach(dd => {
        const labelEl = dd.querySelector('.ifr-dropdown__label');
        const selected = dd.querySelector('.ifr-dropdown__selected');
        if (labelEl) labelEl.textContent = '-- Pilih --';
        selected?.classList.remove('ifr-dropdown__selected--filled');
        dd.querySelectorAll('.ifr-dropdown__option--selected').forEach(o =>
          o.classList.remove('ifr-dropdown__option--selected')
        );
      });
      _container.querySelectorAll('.ifr-field--error').forEach(el => {
        el.classList.remove('ifr-field--error');
      });
      _container.querySelectorAll('.ifr-field__error').forEach(el => {
        el.textContent = '';
      });
      const summary = _container.querySelector('.ifr-error-summary');
      if (summary) summary.remove();
    }
  }

  function destroy() {
    _container = null;
    _fields = [];
    _values = {};
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    mount, destroy, reset,
    validate, getValues, getDisplayName, getIdentityObject,
    showErrors,
  };
})();
