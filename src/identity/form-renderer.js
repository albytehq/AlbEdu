// IdentityFormRenderer.js — peserta-side form renderer for "Manual" identity
// mode. Renders the form dynamically based on fieldsConfig produced by
// IdentityFormBuilder.
//
// Supported field types: text, number, select, textarea, email.
//
// Public API:
//   - mount(container, fieldsConfig)  → render form ke container
//   - validate()                       → return array of error strings
//   - getValues()                      → return {field_id: value, ...} + _meta
//   - getDisplayName()                 → return string (ambil dari field label "nama")
//   - reset()                          → clear all values
//   - destroy()                        → cleanup

window.IdentityFormRenderer = (() => {
  let _container = null;
  let _fields    = [];
  let _values    = {}; // field_id → value
  // M3 fix: instance ID counter — every mount() gets a unique suffix so
  // re-rendering the form (e.g. on retry) doesn't produce duplicate element
  // IDs in the DOM. Previously hard-coded IDs like `ifr_field_nama` collided
  // when mount() was called twice, causing querySelector('#id') to return
  // unreliable results.
  let _instanceId = 0;

  function _nextInstanceId() {
    _instanceId += 1;
    return _instanceId;
  }

  function _id(base) {
    return `${base}__i${_instanceId}`;
  }

  // Helpers

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

  // Validation

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

  // Get values

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

  // Rendering

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
    lbl.htmlFor = _id(`ifr_${f.id}`);
    lbl.innerHTML = _escapeHtml(f.label || f.id) +
      (_isRequired(f) ? ' <span class="ifr-required">*</span>' : '');
    wrap.appendChild(lbl);

    // Input by type
    let input;
    if (f.type === 'select') {
      // Build a hidden <select> first, then upgrade it to AlbEduDropdown.
      // This keeps the form input-shaped (so .ifr-field__input selectors
      // still apply) and lets the dropdown component own the visual layer.
      const hiddenSelect = document.createElement('select');
      hiddenSelect.className = 'ifr-field__input albedu-dropdown';
      hiddenSelect.id = _id(`ifr_${f.id}`);
      hiddenSelect.name = f.id;
      hiddenSelect.dataset.placeholder = '-- Pilih --';
      hiddenSelect.style.display = 'none';
      (f.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        hiddenSelect.appendChild(o);
      });

      // Build the AlbEduDropdown instance
      const AlbEduDropdown = window.AlbEduDropdown;
      let dd;
      if (AlbEduDropdown) {
        dd = new AlbEduDropdown(hiddenSelect, {
          placeholder: '-- Pilih --',
          options: (f.options || []).map(opt => ({ value: opt, label: opt })),
          searchable: 'auto',
          onChange: (value) => {
            _values[f.id] = value;
            _clearFieldError(f.id);
          },
        });
        input = dd.getElement();
        input.id = _id(`ifr_${f.id}`);
        input.classList.add('ifr-field__input');
        // Stash instance on the wrap element so reset() can call .clear()
        input._albeduDropdownInstance = dd;
        // Pre-fill if value exists
        if (_values[f.id]) dd.setValue(_values[f.id]);
      } else {
        // Fallback: native <select> (if AlbEduDropdown failed to load)
        console.warn('[IdentityFormRenderer] AlbEduDropdown not loaded — using native <select>');
        hiddenSelect.style.display = '';
        hiddenSelect.onchange = (e) => {
          _values[f.id] = e.target.value;
          _clearFieldError(f.id);
        };
        if (_values[f.id]) hiddenSelect.value = _values[f.id];
        input = hiddenSelect;
      }
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.id = _id(`ifr_${f.id}`);
      input.className = 'ifr-field__input';
      input.name = f.id;
      input.value = _values[f.id] != null ? _values[f.id] : '';
      if (f.placeholder) input.placeholder = f.placeholder;
      const ml = _getMaxlength(f);
      if (ml) input.maxLength = ml;
      if (_isRequired(f)) input.required = true;
      input.oninput = e => {
        _values[f.id] = e.target.value;
        _clearFieldError(f.id);
      };
    } else {
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : (f.type === 'email' ? 'email' : 'text');
      input.id = _id(`ifr_${f.id}`);
      input.className = 'ifr-field__input';
      input.name = f.id;
      input.value = _values[f.id] != null ? _values[f.id] : '';
      if (f.placeholder) input.placeholder = f.placeholder;
      const ml = _getMaxlength(f);
      if (ml) input.maxLength = ml;
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
    errBox.id = _id(`ifr_err_${f.id}`);
    wrap.appendChild(errBox);

    return wrap;
  }

  function _clearFieldError(fieldId) {
    // M3: use scoped query (within _container) instead of getElementById so
    // we don't depend on the global document having a unique id (which was
    // broken when form was re-rendered).
    const wrap = _container?.querySelector(`.ifr-field[data-field-id="${fieldId}"]`);
    const errBox = wrap?.querySelector('.ifr-field__error');
    if (errBox) errBox.textContent = '';
    wrap?.classList.remove('ifr-field--error');
  }

  function _showFieldError(fieldId, msg) {
    // M3: scoped query — see _clearFieldError.
    const wrap = _container?.querySelector(`.ifr-field[data-field-id="${fieldId}"]`);
    const errBox = wrap?.querySelector('.ifr-field__error');
    if (errBox) errBox.textContent = msg;
    wrap?.classList.add('ifr-field--error');
  }

  // NOTE: The legacy _createCustomDropdown() implementation has been removed.
  // Select-type fields now use AlbEduDropdown (src/shared/dropdown.js) which
  // is portal-based (escapes any overflow:hidden parent — fixes the
  // "dropdown kepotong card" bug on take.html's .id-card) and has smart
  // height adaptation + auto-flip-up + search for long lists.

  function showErrors(errors) {
    // Clear all first
    _fields.forEach(f => _clearFieldError(f.id));

    // Map errors to fields
    let firstErrorFieldId = null;
    errors.forEach(err => {
      // err format: Field "label": message  OR  Field "label" wajib diisi.
      const m = err.match(/^Field "([^"]+)":?\s*(.*)$/);
      if (m) {
        const lbl = m[1];
        const msg = m[2] || err;
        const field = _fields.find(f => (f.label || f.id) === lbl);
        if (field) {
          _showFieldError(field.id, msg);
          if (!firstErrorFieldId) firstErrorFieldId = field.id;
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
          summary.setAttribute('role', 'alert');
          summary.setAttribute('aria-live', 'assertive');
          _container.insertBefore(summary, _container.firstChild);
        }
        summary.innerHTML = `<strong>Perbaiki ${errors.length} error:</strong><ul>${errors.map(e => `<li>${_escapeHtml(e)}</li>`).join('')}</ul>`;
      } else if (summary) {
        summary.remove();
      }
    }

    // M11 fix: scroll the first error field into view (smooth) so mobile users
    // see something changed after a failed submit. Also focus it for keyboard
    // users. Safe in non-browser envs (jsdom) — wrapped in try/catch.
    if (firstErrorFieldId && _container) {
      try {
        const errWrap = _container.querySelector(
          `.ifr-field[data-field-id="${firstErrorFieldId}"]`
        );
        if (errWrap) {
          errWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const input = errWrap.querySelector('input, textarea, .albedu-dropdown, .ifr-dropdown');
          if (input && typeof input.focus === 'function') {
            // Defer focus to let scroll happen first
            setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (_) {} }, 100);
          }
        }
      } catch (_) { /* jsdom or no scroll support — ignore */ }
    }
  }

  // Lifecycle

  function mount(container, fieldsConfig) {
    if (!container) throw new Error('Container required');
    // M3 fix: bump instance ID on every mount so re-renders produce unique
    // element IDs. Also clear container so any stale DOM from a previous
    // mount is removed before we re-render.
    _nextInstanceId();
    _container = container;
    _container.innerHTML = '';
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
      // Reset AlbEduDropdown instances (new path) — use their public API
      _container.querySelectorAll('.albedu-dropdown').forEach(ddWrap => {
        // Walk up to find the .ifr-field wrapper, then look for the trigger
        const instance = ddWrap._albeduDropdownInstance;
        if (instance && typeof instance.clear === 'function') {
          instance.clear();
          return;
        }
        // Legacy fallback: manually reset label
        const labelEl = ddWrap.querySelector('.albedu-dropdown__label');
        const trigger = ddWrap.querySelector('.albedu-dropdown__trigger');
        const placeholder = (ddWrap.dataset && ddWrap.dataset.placeholder) || '-- Pilih --';
        if (labelEl) labelEl.textContent = placeholder;
        if (trigger) trigger.classList.remove('is-filled');
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
    // m2 fix: clear the rendered DOM before nulling refs so we don't leave
    // stale form HTML + event listeners in the page. Previously destroy()
    // only nulled _container/_fields/_values but left the rendered form
    // intact, causing visual residue + potential stale-handler bugs.
    if (_container) {
      try { _container.innerHTML = ''; } catch (_) {}
    }
    _container = null;
    _fields = [];
    _values = {};
  }

  // Public API

  return {
    mount, destroy, reset,
    validate, getValues, getDisplayName, getIdentityObject,
    showErrors,
  };
})();
