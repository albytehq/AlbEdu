/**
 * ExamIdentitySeparator.js -- v2
 * Form identitas peserta dengan custom dropdown.
 * Support mode: 'edit' (awal) dan 'readonly' (setelah submit, bisa diklik balik).
 */

const ExamIdentitySeparator = (() => {
  let _container    = null;
  let _kelasList    = [];
  let _namaList     = [];
  let _selectedKelas = '';
  let _selectedNama  = '';
  let _mode          = 'edit'; // 'edit' | 'readonly'
  let _onSubmitCb    = null;
  let _onKelasChangeCb = null;

  // --- Public: render ------------------------------------------------------
  //
  // identitasReadonly  — jika truthy DAN prefillOnly = false → mode readonly (form terkunci).
  //                      Jika prefillOnly = true → data dipakai sebagai pre-fill saja,
  //                      form tetap editable + tombol "Selanjutnya" tampil.
  //
  // prefillOnly        — true saat re-entry dengan draft: kita ingin pre-isi kelas & nama
  //                      tapi peserta tetap harus klik "Selanjutnya" untuk konfirmasi.
  //                      Ini mencegah jebakan "readonly tanpa tombol lanjut".
  function render(container, kelasList, identitasReadonly, prefillOnly) {
    // S1 fix: call destroy() first to remove previous document click listener.
    // Old code accumulated _handleOutsideClick listeners on document every time
    // render() was called (every identity phase entry, including after violation
    // resets) — causing N outside-click handlers to fire simultaneously, making
    // dropdowns close instantly when opened. Now destroy() runs first, ensuring
    // only ONE listener exists at any time.
    destroy();

    _container  = container;
    _kelasList  = kelasList || [];

    // WHY: identitasReadonly dipakai ganda — sebagai data prefill DAN toggle readonly.
    // Kalau prefillOnly = true kita tetap di mode edit supaya tombol Selanjutnya muncul.
    _mode          = (identitasReadonly && !prefillOnly) ? 'readonly' : 'edit';
    _selectedKelas = identitasReadonly?.kelas || '';
    _selectedNama  = identitasReadonly?.nama  || '';
    _namaList      = [];

    _container.innerHTML = _buildHTML();
    _populateKelas();
    _bindEvents();

    // Set tampilan awal kelas & nama (readonly maupun prefill)
    if (_selectedKelas) {
      _setKelasDisplay(_selectedKelas);
      _setNamaDisplay(_selectedNama || 'Pilih Nama Peserta');
    }
  }

  // --- Build HTML ----------------------------------------------------------
  function _buildHTML() {
    const isReadonly = _mode === 'readonly';
    return `
      <div class="identity-form-wrap${isReadonly ? ' is-readonly' : ''}">
        ${isReadonly ? `
          <div class="readonly-banner">
            <i class="material-symbols-outlined">lock</i>
            <span>Identitas sudah dikunci -- tidak dapat diubah</span>
          </div>
        ` : ''}

        <div class="field-group">
          <label class="field-label">
            <i class="material-symbols-outlined">school</i> Kelas
          </label>
          <div class="custom-dropdown${isReadonly ? ' dd-locked' : ''}" id="ddKelas">
            <div class="dd-trigger" id="ddKelasTrigger" tabindex="${isReadonly ? -1 : 0}">
              <span class="dd-display" id="ddKelasDisplay">
                ${_selectedKelas || 'Pilih Kelas'}
              </span>
              <i id="ddKelasArrow" class="material-symbols-outlined dd-arrow">expand_more</i>
            </div>
            <div class="dd-panel" id="ddKelasPanel">
              <ul class="dd-list" id="ddKelasList"></ul>
            </div>
          </div>
          <span class="field-error hidden" id="errKelas">Kelas harus dipilih.</span>
        </div>

        <div class="field-group">
          <label class="field-label">
            <i class="material-symbols-outlined">person</i> Nama Peserta
          </label>
          <div class="custom-dropdown${isReadonly ? ' dd-locked' : ''}" id="ddNama">
            <div class="dd-trigger${(!_selectedKelas && !isReadonly) ? ' dd-disabled' : ''}" id="ddNamaTrigger" tabindex="${isReadonly ? -1 : 0}">
              <span class="dd-display" id="ddNamaDisplay">
                ${_selectedNama || 'Pilih Nama Peserta'}
              </span>
              <i id="ddNamaArrow" class="material-symbols-outlined dd-arrow">expand_more</i>
            </div>
            <div class="dd-panel" id="ddNamaPanel">
              <div class="dd-search-wrap">
                <i class="material-symbols-outlined dd-search-icon">search</i>
                <input type="text" class="dd-search" id="ddNamaSearch"
                  placeholder="Cari nama peserta..." autocomplete="off" />
              </div>
              <ul class="dd-list" id="ddNamaList">
                <li class="dd-empty">Pilih kelas terlebih dahulu</li>
              </ul>
            </div>
          </div>
          <span class="field-error hidden" id="errNama">Nama peserta harus dipilih.</span>
        </div>

        ${!isReadonly ? `
          <button class="btn-mulai" id="btnMulai">
            <span>Selanjutnya</span>
            <i class="material-symbols-outlined">arrow_forward</i>
          </button>
        ` : ''}
      </div>
    `;
  }

  // --- Isi list kelas ------------------------------------------------------
  function _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function _populateKelas() {
    const list = document.getElementById('ddKelasList');
    if (!list) return;
    list.innerHTML = _kelasList
      .map(k => `<li class="dd-item" data-value="${_escapeHTML(k)}">${_escapeHTML(k)}</li>`)
      .join('');
  }

  // --- Update nama list (dipanggil controller setelah fetch) ---------------
  function updateNamaList(namaList) {
    _namaList = namaList || [];
    _renderNamaList(_namaList);
    const trigger = document.getElementById('ddNamaTrigger');
    const display = document.getElementById('ddNamaDisplay');
    if (trigger) trigger.classList.remove('dd-disabled');
    if (display && !_selectedNama) display.textContent = 'Pilih Nama Peserta';

    // Setiap kali list nama di-update, tampilkan tombol fallback manual.
    // Ini solusi untuk peserta yang namanya belum terdaftar karena admin belum update.
    _renderManualFallback();
  }

  // Tombol "Nama saya tidak ada di daftar" muncul di bawah dropdown nama.
  // Jika diklik, dropdown diganti dengan text input manual + badge peringatan.
  // Nama manual dikirim ke controller dengan flag _isManualNama = true.
  let _isManualNama = false;

  function _renderManualFallback() {
    // Jangan render ulang kalau sudah mode manual
    if (_isManualNama) return;
    const existing = document.getElementById('manualNamaFallback');
    if (existing) return; // sudah ada

    const fieldGroup = document.getElementById('ddNama')?.closest('.field-group');
    if (!fieldGroup) return;

    const fallbackEl = document.createElement('div');
    fallbackEl.id = 'manualNamaFallback';
    fallbackEl.style.cssText = 'margin-top:6px;';
    fallbackEl.innerHTML = `
      <button type="button" id="btnNamaTidakAda" style="
        background:none; border:none; padding:0; cursor:pointer;
        font-size:11px; color:var(--gray-400); text-decoration:underline;
        text-underline-offset:2px; font-family:var(--font);
        transition:color 0.15s;
      ">
        <i style="margin-right:3px;" class="material-symbols-outlined">help</i>
        Nama saya tidak ada di daftar
      </button>
    `;
    fieldGroup.appendChild(fallbackEl);

    document.getElementById('btnNamaTidakAda')?.addEventListener('click', _activateManualNama);
  }

  function _activateManualNama() {
    _isManualNama = true;
    _selectedNama = '';

    // Ganti dropdown dengan input manual
    const ddNama = document.getElementById('ddNama');
    if (ddNama) {
      ddNama.style.display = 'none';
    }

    // Hapus tombol fallback — sudah dipakai
    document.getElementById('manualNamaFallback')?.remove();

    // Inject input manual setelah dropdown
    const fieldGroup = ddNama?.closest('.field-group');
    if (!fieldGroup) return;

    const manualWrap = document.createElement('div');
    manualWrap.id = 'manualNamaWrap';
    manualWrap.innerHTML = `
      <div style="
        background:var(--amber-100);border:1.5px solid rgba(245,158,11,0.35);
        border-radius:var(--radius-sm);padding:8px 11px;
        display:flex;align-items:center;gap:7px;margin-bottom:8px;
        font-size:11px;color:#92400e;font-weight:600;
      ">
        <i style="color:var(--amber-500);" class="material-symbols-outlined">warning</i>
        Nama manual — hubungi guru untuk verifikasi data
      </div>
      <input
        id="inputNamaManual"
        type="text"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="Ketik nama lengkap kamu..."
        style="
          width:100%;padding:10px 13px;
          border:1.5px solid var(--gray-200);border-radius:var(--radius-sm);
          font-size:13px;font-weight:500;color:var(--gray-800);
          background:var(--gray-50);font-family:var(--font);
          transition:border-color 0.2s;
          box-sizing:border-box;
        "
      />
      <button type="button" id="btnBatalManual" style="
        margin-top:5px;background:none;border:none;padding:0;cursor:pointer;
        font-size:11px;color:var(--gray-400);text-decoration:underline;
        font-family:var(--font);
      ">Batalkan, pilih dari daftar</button>
    `;
    fieldGroup.appendChild(manualWrap);

    const inp = document.getElementById('inputNamaManual');
    inp?.focus();
    // FIX: Sanitize manual name input untuk mencegah XSS.
    // Nama manual dari text input bisa mengandung tag HTML — strip semua
    // tag dan batasi panjang sebelum disimpan ke state.
    inp?.addEventListener('input', e => {
      const raw = e.target.value.trim();
      // Strip semua tag HTML, hanya ambil text content
      const sanitized = raw.replace(/<[^>]*>/g, '').slice(0, 80);
      _selectedNama = sanitized;
      // Update input value agar user melihat hasil sanitasi
      if (e.target.value.trim() !== sanitized) {
        e.target.value = sanitized;
      }
    });
    inp?.addEventListener('focus', e => {
      e.target.style.borderColor = 'var(--color-primary)';
      e.target.style.background  = 'white';
    });
    inp?.addEventListener('blur', e => {
      e.target.style.borderColor = 'var(--gray-200)';
      e.target.style.background  = 'var(--gray-50)';
    });

    // Tombol batal — kembali ke mode dropdown
    document.getElementById('btnBatalManual')?.addEventListener('click', () => {
      _isManualNama  = false;
      _selectedNama  = '';
      manualWrap.remove();
      if (ddNama) ddNama.style.display = '';
      _renderManualFallback();
    });
  }

  function _renderNamaList(list) {
    const ul = document.getElementById('ddNamaList');
    if (!ul) return;
    if (!list.length) {
      ul.innerHTML = '<li class="dd-empty">Tidak ada peserta ditemukan</li>';
      return;
    }
    ul.innerHTML = list
      .map(nama => {
        // WHY: highlight nama yang sudah dipilih (dari prefill atau sebelumnya).
        // Tanpa ini, peserta membuka dropdown setelah prefill dan tidak tahu nama mana
        // yang sudah terisi — berisiko salah klik nama lain.
        // FIX: Escape nama untuk mencegah XSS — nama peserta bisa mengandung
        // karakter khusus yang bisa dieksploitasi jika langsung di-insert ke innerHTML.
        const isActive = nama === _selectedNama;
        const safe = _escapeHTML(nama);
        return `<li class="dd-item${isActive ? ' dd-item--active' : ''}" data-value="${safe}">${safe}</li>`;
      })
      .join('');
    // Bind click
    ul.querySelectorAll('.dd-item').forEach(item => {
      item.addEventListener('click', () => {
        _selectedNama = item.dataset.value;
        _setNamaDisplay(_selectedNama);
        // Update highlight: hapus semua lalu tandai yang baru dipilih
        ul.querySelectorAll('.dd-item').forEach(el => el.classList.remove('dd-item--active'));
        item.classList.add('dd-item--active');
        _hideError('errNama');
        _closeAll();
      });
    });
    // Scroll ke item yang aktif agar langsung kelihatan
    const activeItem = ul.querySelector('.dd-item--active');
    if (activeItem) {
      setTimeout(() => activeItem.scrollIntoView({ block: 'nearest' }), 50);
    }
  }

  // --- Bind events ---------------------------------------------------------
  function _bindEvents() {
    if (_mode === 'readonly') return; // Tidak ada interaksi saat readonly

    _bindToggle('ddKelasTrigger', 'ddKelasPanel', 'ddKelasArrow');
    _bindToggle('ddNamaTrigger',  'ddNamaPanel',  'ddNamaArrow');

    // Pilih kelas
    const kelasList = document.getElementById('ddKelasList');
    if (kelasList) {
      kelasList.addEventListener('click', e => {
        const item = e.target.closest('.dd-item');
        if (!item) return;
        _selectKelas(item.dataset.value);
      });
    }

    // Search nama
    const searchInput = document.getElementById('ddNamaSearch');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = q ? _namaList.filter(n => n.toLowerCase().includes(q)) : _namaList;
        _renderNamaList(filtered);
      });
    }

    // Tombol mulai
    document.getElementById('btnMulai')?.addEventListener('click', _handleSubmit);

    // Klik luar
    document.addEventListener('click', _handleOutsideClick);
  }

  function _bindToggle(triggerId, panelId, arrowId) {
    const trigger = document.getElementById(triggerId);
    const panel   = document.getElementById(panelId);
    const arrow   = document.getElementById(arrowId);
    if (!trigger || !panel) return;

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      if (trigger.classList.contains('dd-disabled')) return;
      const isOpen = panel.classList.contains('open');
      _closeAll();
      if (!isOpen) {
        panel.classList.add('open');
        arrow?.classList.add('rotated');
        trigger.classList.add('active');
        const search = panel.querySelector('.dd-search');
        if (search) setTimeout(() => search.focus(), 50);
      }
    });

    trigger.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger.click(); }
    });
  }

  function _closeAll() {
    document.querySelectorAll('.dd-panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.dd-arrow.rotated').forEach(a => a.classList.remove('rotated'));
    document.querySelectorAll('.dd-trigger.active').forEach(t => t.classList.remove('active'));
  }

  function _handleOutsideClick(e) {
    if (!e.target.closest('.custom-dropdown')) _closeAll();
  }

  function _selectKelas(kelas) {
    _selectedKelas = kelas;
    _selectedNama  = '';
    _setKelasDisplay(kelas);
    _setNamaDisplay('Pilih Nama Peserta');
    const search = document.getElementById('ddNamaSearch');
    if (search) search.value = '';
    _hideError('errKelas');
    _closeAll();

    const ul = document.getElementById('ddNamaList');
    if (ul) ul.innerHTML = '<li class="dd-empty"><i class="material-symbols-outlined ms-spin">progress_activity</i> Memuat...</li>';
    const trigger = document.getElementById('ddNamaTrigger');
    if (trigger) trigger.classList.remove('dd-disabled');

    if (_onKelasChangeCb) _onKelasChangeCb(kelas);
  }

  function _setKelasDisplay(val) {
    const el = document.getElementById('ddKelasDisplay');
    if (el) el.textContent = val;
  }

  function _setNamaDisplay(val) {
    const el = document.getElementById('ddNamaDisplay');
    if (el) el.textContent = val;
  }

  function _handleSubmit() {
    let valid = true;
    if (!_selectedKelas) { _showError('errKelas'); valid = false; }

    // Mode manual: validasi dari input text, bukan dropdown
    if (_isManualNama) {
      const inp = document.getElementById('inputNamaManual');
      const val = inp?.value.trim() || '';
      if (!val) {
        // Beri visual feedback pada input manual
        if (inp) {
          inp.style.borderColor = 'var(--red-500)';
          inp.placeholder = 'Nama tidak boleh kosong!';
          inp.focus();
        }
        valid = false;
      } else {
        _selectedNama = val;
      }
    } else {
      if (!_selectedNama) { _showError('errNama'); valid = false; }
    }

    if (!valid) return;

    // Kirim ke controller — flag isManual memungkinkan admin tahu ini entry manual
    if (_onSubmitCb) _onSubmitCb({
      nama: _selectedNama,
      kelas: _selectedKelas,
      isManual: _isManualNama,
    });
  }

  function _showError(id) {
    document.getElementById(id)?.classList.remove('hidden');
  }
  function _hideError(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  // --- Public: cleanup -----------------------------------------------------
  function destroy() {
    document.removeEventListener('click', _handleOutsideClick);
    // Reset manual state agar re-render bersih
    _isManualNama = false;
  }

  // --- Public API ----------------------------------------------------------
  return {
    render,
    updateNamaList,
    destroy,
    onSubmit(cb)      { _onSubmitCb = cb; },
    onKelasChange(cb) { _onKelasChangeCb = cb; },
  };
})();
