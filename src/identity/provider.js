// IdentityProvider.js — unified facade that renders the identity form on
// the exam-taker (peserta) side. Switches between "manual" mode
// (IdentityFormRenderer) and "daftar" mode (dropdown).
//
// Public API:
//   - getIdentityConfig(examData)              → return { mode, fields|daftar, ... }
//   - render(mount, examData, onSubmit, onCancel) → render UI sesuai mode
//   - validate(examData)                        → return array of errors
//   - getDisplayName(identityObj)               → return string
//
// Identity object shape (returned by onSubmit callback):
//   Manual mode: { _mode:'manual', _display_name:'...', field_id:value, ... }
//   Daftar mode: { _mode:'daftar', _display_name:'...', nama:'...', tab_id:'...',
//                  tab_nama:'...', daftar_id:'...' }

window.IdentityProvider = (() => {

  const t = (key, vars, fallback) => fallback;

  // Helpers

  function _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Extract identity config from examData. Supports two shapes:
  //   - current: examData.identity_mode + examData.identity_config
  //   - legacy fallback: examData.PQ.pages1.identitas (manual/daftar)
  function getIdentityConfig(examData) {
    if (!examData) return { mode: 'manual', fields: _defaultFields() };

    // Current shape (post-migration)
    if (examData.identity_mode) {
      const cfg = examData.identity_config || {};
      if (examData.identity_mode === 'manual') {
        return {
          mode: 'manual',
          fields: Array.isArray(cfg.fields) && cfg.fields.length > 0
            ? cfg.fields
            : _defaultFields(),
        };
      }
      if (examData.identity_mode === 'daftar') {
        return {
          mode: 'daftar',
          daftar_id:    cfg.daftar_id    || null,
          daftar_tipe:  cfg.daftar_tipe  || null,
          daftar_label: cfg.daftar_label || null,
          tabs:         Array.isArray(cfg.tabs) ? cfg.tabs : [],
        };
      }
    }

    // Legacy shape (pre-migration, defensive)
    const identitas = examData?.PQ?.pages1?.identitas || examData?.p_q?.pages1?.identitas;
    if (identitas) {
      if (identitas.daftar_id) {
        return {
          mode: 'daftar',
          daftar_id:    identitas.daftar_id,
          daftar_tipe:  identitas.daftar_tipe,
          daftar_label: identitas.daftar_label,
          tabs:         Array.isArray(identitas.kelas) ? identitas.kelas : [],
        };
      }
      if (Array.isArray(identitas.fields) && identitas.fields.length > 0) {
        return { mode: 'manual', fields: identitas.fields };
      }
      // Fallback: kalau ada kelas array, auto-build Nama + Kelas select
      if (Array.isArray(identitas.kelas) && identitas.kelas.length > 0) {
        return {
          mode: 'manual',
          fields: [
            { id: 'field_nama', type: 'text', label: t('identity.field_name', null, 'Nama'), required: true, max_length: 50 },
            { id: 'field_kelas', type: 'select', label: t('identity.field_class', null, 'Kelas'), required: true, options: identitas.kelas },
          ],
        };
      }
    }

    // Last resort: default Nama only
    return { mode: 'manual', fields: _defaultFields() };
  }

  function _defaultFields() {
    return [
      { id: 'field_nama', type: 'text', label: t('identity.field_name', null, 'Nama'), placeholder: t('identity.field_name_placeholder', null, 'Masukkan nama lengkap'), required: true, max_length: 50 },
    ];
  }

  // Validation

  function validate(identityConfig, identityObj) {
    const errors = [];

    if (!identityObj || typeof identityObj !== 'object') {
      errors.push(t('identity.invalid', null, 'Identitas peserta tidak valid.'));
      return errors;
    }

    if (identityObj._mode === 'manual') {
      // M2 fix: Actually validate the PASSED identityObj against identityConfig.fields.
      // Previously this delegated to IdentityFormRenderer.validate() (singleton form
      // state), which ignored the identityObj argument — making the API misleading
      // and impossible to use for server-side / pre-fill / retry validation.
      //
      // Now we validate identityObj directly. If the caller also wants to validate
      // the live form (e.g. before _onIdentitySubmit), they should call
      // IdentityFormRenderer.validate() explicitly.
      const fields = (identityConfig && Array.isArray(identityConfig.fields))
        ? identityConfig.fields
        : [];

      if (fields.length === 0) {
        // No config — accept any manual identity as long as it has a display name.
        if (!identityObj._display_name && !identityObj.nama) {
          errors.push(t('identity.field_required', { field: 'Nama' }, 'Field "Nama" wajib diisi.'));
        }
        return errors;
      }

      fields.forEach(f => {
        const v = identityObj[f.id] != null ? String(identityObj[f.id]).trim() : '';
        const lbl = f.label || f.id;

        // Required check
        if (f.required && !v) {
          errors.push(t('identity.field_required', { field: lbl }, `Field "${lbl}" wajib diisi.`));
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
        const ml = (f.type === 'text' || f.type === 'textarea') && f.max_length
          ? parseInt(f.max_length, 10)
          : null;
        if (ml && v.length > ml) {
          errors.push(`Field "${lbl}": melebihi ${ml} karakter.`);
        }
      });
      return errors;
    }

    if (identityObj._mode === 'daftar') {
      if (!identityObj.nama) errors.push(t('identity.nama_required', null, 'Nama peserta wajib dipilih.'));
      if (!identityObj.tab_id) errors.push(t('identity.tab_required', null, 'Tab/Kelas wajib dipilih.'));
      return errors;
    }

    errors.push(t('identity.unknown_mode', null, 'Mode identitas tidak dikenal.'));
    return errors;
  }

  function getDisplayName(identityObj) {
    if (!identityObj) return '';
    return identityObj._display_name || identityObj.nama || '';
  }

  // Render (manual mode)

  function _renderManual(mount, fields, onSubmit, onCancel) {
    if (!window.IdentityFormRenderer) {
      mount.innerHTML = '<div class="ip-error">IdentityFormRenderer module tidak tersedia.</div>';
      return;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'ip-header';
    header.innerHTML = `
      <span class="ip-header__icon" data-albedu-icon="person"></span>
      <div class="ip-header__text">
        <div class="ip-header__title">Isi Identitas Peserta</div>
        <div class="ip-header__sub">Lengkapi data berikut sebelum memulai asesmen</div>
      </div>
    `;
    mount.appendChild(header);

    // Form container
    const formContainer = document.createElement('div');
    formContainer.className = 'ip-form-container';
    mount.appendChild(formContainer);

    window.IdentityFormRenderer.mount(formContainer, fields);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'ip-actions';

    if (onCancel) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ip-btn ip-btn--secondary';
      cancelBtn.textContent = 'Batal';
      cancelBtn.onclick = () => onCancel();
      actions.appendChild(cancelBtn);
    }

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'ip-btn ip-btn--primary ip-submit-btn';
    submitBtn.textContent = 'Mulai Asesmen';
    // M4 fix: loading state guard — prevent double-click during the async
    // identity submit. The caller's onSubmit() returns a Promise (or void);
    // we set `data-state="submitting"` + disable the button until it resolves.
    let isSubmitting = false;
    const originalLabel = submitBtn.textContent;
    submitBtn.onclick = async () => {
      if (isSubmitting) return;
      const errors = window.IdentityFormRenderer.validate();
      if (errors.length > 0) {
        window.IdentityFormRenderer.showErrors(errors);
        return;
      }
      const identity = window.IdentityFormRenderer.getIdentityObject();
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.setAttribute('data-state', 'submitting');
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.innerHTML = `<span class="ip-submit-btn__spinner" aria-hidden="true"></span><span>Memulai...</span>`;
      try {
        const result = onSubmit(identity);
        if (result && typeof result.then === 'function') await result;
      } finally {
        // Reset only if the page hasn't transitioned (e.g. on error)
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.removeAttribute('data-state');
        submitBtn.removeAttribute('aria-busy');
        submitBtn.textContent = originalLabel;
      }
    };
    actions.appendChild(submitBtn);

    mount.appendChild(actions);
  }

  // Render (daftar mode)

  async function _renderDaftar(mount, config, onSubmit, onCancel) {
    // Header
    const header = document.createElement('div');
    header.className = 'ip-header';
    header.innerHTML = `
      <span class="ip-header__icon" data-albedu-icon="format_list_bulleted"></span>
      <div class="ip-header__text">
        <div class="ip-header__title">Pilih Identitas Peserta</div>
        <div class="ip-header__sub">Daftar: ${_escapeHtml(config.daftar_label || 'Tanpa nama')}</div>
      </div>
    `;
    mount.appendChild(header);

    // Form
    const form = document.createElement('div');
    form.className = 'ip-daftar-form';

    // Normalize tabs structure.
    // - Embedded: [{nama_tab, anggota:[string]}] (no DB query needed)
    // - Legacy: ['7A', '7B', ...] (array of strings — needs DB fetch)
    const tabsNormalized = (config.tabs || []).map(t => {
      if (typeof t === 'string') {
        return { nama_tab: t, anggota: null }; // anggota null → perlu fetch
      }
      return {
        nama_tab: t.nama_tab || '',
        anggota:  Array.isArray(t.anggota) ? t.anggota : null,
      };
    });

    const hasEmbeddedAnggota = tabsNormalized.length > 0 && tabsNormalized[0].anggota !== null;

    // M4-minor fix: empty/misconfigured state for daftar (tabs=[])
    if (tabsNormalized.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'ip-empty-state';
      emptyState.setAttribute('role', 'alert');
      emptyState.innerHTML = `
        <div class="ip-empty-state__icon" data-albedu-icon="error_outline"></div>
        <div class="ip-empty-state__title">Asesmen Belum Dikonfigurasi</div>
        <div class="ip-empty-state__msg">Daftar tab/kelas kosong. Hubungi admin untuk mengonfigurasi asesmen ini.</div>
        <button class="ip-btn ip-btn--secondary" type="button" onclick="window.location.reload()">Muat Ulang</button>
      `;
      mount.appendChild(emptyState);
      return;
    }

    // Daftar info
    const info = document.createElement('div');
    info.className = 'ip-daftar-info';
    info.innerHTML = `
      <div><strong>Tipe:</strong> ${_escapeHtml(config.daftar_tipe || '-')}</div>
      <div><strong>Jumlah Tab:</strong> ${tabsNormalized.length}</div>
    `;
    form.appendChild(info);

    // State
    const state = { tab_nama: '', nama: '', daftar_id: config.daftar_id };

    // Tab selector (custom dropdown)
    const tabWrap = document.createElement('div');
    tabWrap.className = 'ip-field';

    const tabLabel = document.createElement('label');
    tabLabel.className = 'ip-field__label';
    tabLabel.innerHTML = `Pilih Tab <span class="ip-required">*</span>`;
    tabWrap.appendChild(tabLabel);

    const tabDropdown = _createCustomDropdown({
      placeholder: '-- Pilih Tab --',
      options: tabsNormalized.map(t => ({ value: t.nama_tab, label: t.nama_tab })),
      onChange: async (tabName) => {
        state.tab_nama = tabName;
        state.nama = '';
        errBox.textContent = '';
        manualCb.checked = false;
        manualInput.style.display = 'none';
        manualInput.value = '';

        if (!tabName) {
          namaWrap.classList.add('ip-field--hidden');
          return;
        }

        // Cari tab di tabsNormalized
        const tab = tabsNormalized.find(t => t.nama_tab === tabName);

        // If anggota is embedded, use it directly (no DB query)
        if (tab && Array.isArray(tab.anggota)) {
          _populateNamaDropdown(tab.anggota);
        } else {
          // Legacy fallback: fetch from DB (for exams whose tabs were just
          // an array of strings)
          try {
            const list = await _fetchPesertaDariDaftar(config.daftar_id, tabName);
            _populateNamaDropdown(list);
          } catch (err) {
            errBox.textContent = `Gagal memuat daftar nama: ${err.message}`;
            namaWrap.classList.add('ip-field--hidden');
          }
        }
      },
    });
    tabWrap.appendChild(tabDropdown.element);
    form.appendChild(tabWrap);

    // Nama selector (custom dropdown)
    const namaWrap = document.createElement('div');
    namaWrap.className = 'ip-field ip-field--hidden';

    const namaLabel = document.createElement('label');
    namaLabel.className = 'ip-field__label';
    namaLabel.innerHTML = `Pilih Nama <span class="ip-required">*</span>`;
    namaWrap.appendChild(namaLabel);

    // M12 fix: search input for long nama lists (>8 entries).
    // Shown above the dropdown, filters options by case-insensitive substring.
    // Hidden by default; revealed when list > 8 in _populateNamaDropdown.
    const searchWrap = document.createElement('div');
    searchWrap.className = 'ip-daftar-search';
    searchWrap.style.display = 'none';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ip-field__input ip-daftar-search__input';
    searchInput.placeholder = 'Cari nama...';
    searchInput.setAttribute('aria-label', 'Cari nama peserta');
    searchWrap.appendChild(searchInput);
    namaWrap.appendChild(searchWrap);

    const namaDropdown = _createCustomDropdown({
      placeholder: '-- Pilih Nama --',
      options: [],
      onChange: (nama) => {
        state.nama = nama;
        errBox.textContent = '';
      },
    });
    namaWrap.appendChild(namaDropdown.element);

    // M12: store full list so we can re-filter on search input
    let _fullNamaList = [];
    function _populateNamaDropdown(list) {
      _fullNamaList = Array.isArray(list) ? list : [];
      if (_fullNamaList.length === 0) {
        namaDropdown.setOptions([]);
        namaDropdown.setPlaceholder('(Tab kosong)');
        errBox.textContent = 'Tab ini kosong. Hubungi admin atau isi manual di bawah.';
        searchWrap.style.display = 'none';
      } else {
        _renderFilteredNama('');
        namaDropdown.setPlaceholder('-- Pilih Nama --');
        // M12: show search input if list is long
        searchWrap.style.display = _fullNamaList.length > 8 ? '' : 'none';
      }
      namaWrap.classList.remove('ip-field--hidden');
    }
    function _renderFilteredNama(query) {
      const q = (query || '').trim().toLowerCase();
      const filtered = q
        ? _fullNamaList.filter(n => String(n).toLowerCase().includes(q))
        : _fullNamaList;
      namaDropdown.setOptions(filtered.map(n => ({ value: n, label: n })));
    }
    // M12: wire search input
    searchInput.addEventListener('input', (e) => {
      _renderFilteredNama(e.target.value);
    });

    // Manual name fallback
    const manualWrap = document.createElement('div');
    manualWrap.className = 'ip-manual-toggle';
    // M3 fix: use a unique id per provider instance (counter) to avoid
    // duplicate IDs when the daftar form is re-rendered.
    const manualToggleId = `ip_manual_toggle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const manualCb = document.createElement('input');
    manualCb.type = 'checkbox';
    manualCb.id = manualToggleId;
    const manualLbl = document.createElement('label');
    manualLbl.htmlFor = manualToggleId;
    manualLbl.textContent = t('identity.manual_toggle_label', null, 'Nama saya tidak ada di daftar (isi manual)');
    manualWrap.appendChild(manualCb);
    manualWrap.appendChild(manualLbl);
    namaWrap.appendChild(manualWrap);

    const manualInput = document.createElement('input');
    manualInput.type = 'text';
    manualInput.className = 'ip-field__input ip-manual-input';
    manualInput.placeholder = t('identity.field_name_placeholder', null, 'Masukkan nama lengkap Anda');
    manualInput.style.display = 'none';
    namaWrap.appendChild(manualInput);

    form.appendChild(namaWrap);

    // Error display
    const errBox = document.createElement('div');
    errBox.className = 'ip-error-box';
    form.appendChild(errBox);

    mount.appendChild(form);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'ip-actions';

    if (onCancel) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ip-btn ip-btn--secondary';
      cancelBtn.textContent = 'Batal';
      cancelBtn.onclick = () => onCancel();
      actions.appendChild(cancelBtn);
    }

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'ip-btn ip-btn--primary ip-submit-btn';
    const daftarSubmitHTML = '<span style="font-size:16px;margin-right:4px;" data-albedu-icon="play_arrow"></span> Mulai Asesmen';
    submitBtn.innerHTML = daftarSubmitHTML;
    // M4 fix: loading state guard for daftar mode (mirror of manual mode)
    let daftarIsSubmitting = false;
    submitBtn.onclick = async () => {
      if (daftarIsSubmitting) return;
      errBox.textContent = '';

      if (!state.tab_nama) {
        errBox.textContent = 'Silakan pilih tab terlebih dahulu.';
        return;
      }
      if (!state.nama || !state.nama.trim()) {
        errBox.textContent = 'Silakan pilih atau masukkan nama.';
        return;
      }

      const identity = {
        _mode: 'daftar',
        _display_name: state.nama.trim(),
        nama: state.nama.trim(),
        tab_id: state.tab_nama,
        tab_nama: state.tab_nama,
        daftar_id: state.daftar_id,
        isManualName: manualCb.checked,
      };

      daftarIsSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.setAttribute('data-state', 'submitting');
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.innerHTML = `<span class="ip-submit-btn__spinner" aria-hidden="true"></span><span>Memulai...</span>`;
      try {
        const result = onSubmit(identity);
        if (result && typeof result.then === 'function') await result;
      } finally {
        daftarIsSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.removeAttribute('data-state');
        submitBtn.removeAttribute('aria-busy');
        submitBtn.innerHTML = daftarSubmitHTML;
      }
    };
    actions.appendChild(submitBtn);

    mount.appendChild(actions);

    // Event handlers

    manualCb.onchange = e => {
      if (e.target.checked) {
        namaDropdown.hide();
        namaDropdown.clear();
        state.nama = '';
        manualInput.style.display = '';
        manualInput.focus();
      } else {
        manualInput.style.display = 'none';
        manualInput.value = '';
        namaDropdown.show();
      }
    };

    manualInput.oninput = e => {
      state.nama = e.target.value;
      errBox.textContent = '';
    };
  }

  // Custom dropdown component (replaces native <select>).
  // Returns: { element, setOptions, setPlaceholder, clear, show, hide }
  function _createCustomDropdown({ placeholder = '-- Pilih --', options = [], onChange = () => {} } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'ip-dropdown';
    wrap.tabIndex = 0;

    const selected = document.createElement('div');
    selected.className = 'ip-dropdown__selected';
    selected.innerHTML = `
      <span class="ip-dropdown__label">${_escapeHtml(placeholder)}</span>
      <span class="ip-dropdown__arrow" data-albedu-icon="expand_more"></span>
    `;
    wrap.appendChild(selected);

    const optionsEl = document.createElement('div');
    optionsEl.className = 'ip-dropdown__options';
    wrap.appendChild(optionsEl);

    let currentValue = '';
    let isDisabled = false;

    function _renderOptions() {
      optionsEl.innerHTML = '';
      if (options.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ip-dropdown__option ip-dropdown__option--empty';
        empty.textContent = '(Kosong)';
        optionsEl.appendChild(empty);
        return;
      }
      options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'ip-dropdown__option';
        item.dataset.value = opt.value;
        item.textContent = opt.label;
        if (opt.value === currentValue) {
          item.classList.add('ip-dropdown__option--selected');
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
      const labelEl = selected.querySelector('.ip-dropdown__label');
      if (labelEl) labelEl.textContent = label || placeholder;
      selected.classList.toggle('ip-dropdown__selected--filled', !!value);
      onChange(value);
    }

    function _open() {
      if (isDisabled) return;
      // Close all other dropdowns
      document.querySelectorAll('.ip-dropdown.is-open').forEach(d => {
        if (d !== wrap) d.classList.remove('is-open');
      });
      wrap.classList.add('is-open');
    }

    function _close() {
      wrap.classList.remove('is-open');
    }

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
        const labelEl = selected.querySelector('.ip-dropdown__label');
        if (labelEl) labelEl.textContent = placeholder;
        selected.classList.remove('ip-dropdown__selected--filled');
        _renderOptions();
      },
      setPlaceholder: (text) => {
        placeholder = text;
        const labelEl = selected.querySelector('.ip-dropdown__label');
        if (labelEl && !currentValue) labelEl.textContent = placeholder;
      },
      clear: () => {
        currentValue = '';
        const labelEl = selected.querySelector('.ip-dropdown__label');
        if (labelEl) labelEl.textContent = placeholder;
        selected.classList.remove('ip-dropdown__selected--filled');
      },
      show: () => { wrap.style.display = ''; isDisabled = false; },
      hide: () => { wrap.style.display = 'none'; isDisabled = true; _close(); },
    };
  }

  // Fetch peserta from daftar_nama by daftarId + tabName.
  // Uses DaftarNama module (getAnggota method).
  async function _fetchPesertaDariDaftar(daftarId, tabName) {
    if (window.DaftarNama?.getAnggota) {
      try {
        return await window.DaftarNama.getAnggota(daftarId, tabName);
      } catch (err) {
        console.warn('[IdentityProvider] DaftarNama.getAnggota failed:', err);
        // fall through to ExamData
      }
    }
    if (window.ExamData?.getPesertaDariDaftar) {
      return await window.ExamData.getPesertaDariDaftar(daftarId, tabName);
    }
    return [];
  }

  // Main render entry

  async function render(mount, examData, onSubmit, onCancel) {
    if (!mount) throw new Error('Mount container required');
    mount.innerHTML = '';

    const config = getIdentityConfig(examData);

    if (config.mode === 'manual') {
      _renderManual(mount, config.fields, onSubmit, onCancel);
    } else if (config.mode === 'daftar') {
      await _renderDaftar(mount, config, onSubmit, onCancel);
    } else {
      mount.innerHTML = '<div class="ip-error">Mode identitas tidak dikenal.</div>';
    }
  }

  // Public API

  return {
    getIdentityConfig,
    render,
    validate,
    getDisplayName,
  };
})();
