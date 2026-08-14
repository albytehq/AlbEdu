// daftar-nama-import.js — Production-grade Import Nama from DOCX/XLSX/CSV
//
// FEATURES:
//   • Parse XLSX (multi-sheet → multi-tab), DOCX (headings → tabs), CSV (markers → tabs)
//   • Smart tab detection: sheet names / headings / markers / default
//   • Validation: MAX_TABS=10, MAX_NAMA_LEN=50, MAX_TOTAL_NAMA=150, etc.
//   • Auto-fix: duplicate tab names → rename "Tab (2)", truncate long names
//   • Warnings: duplicate names within tab, empty tabs, header row detection
//   • Preview UI with tab breakdown + issue list
//   • Import as new daftar via DaftarNama.create()
//
// FORMAT GUIDE:
//   XLSX: Each sheet = 1 tab. Sheet name = tab name. Column A = names.
//         Row 1 = header (auto-detected if "Nama"/"Name").
//   DOCX: Heading 1/2/3 = tab names. Bullet lists or paragraphs = names.
//   CSV:  [Tab: Name] or --- Name --- markers for tabs. Each line = 1 name.
//         No markers → all names go into "Tab 1".
//
// EDGE CASES HANDLED:
//   • No tab name → default "Tab N"
//   • Tab name > 15 chars → truncate
//   • Duplicate tab names → auto-rename "Tab (2)"
//   • Empty tab → removed
//   • Name > 50 chars → truncate + warn
//   • Duplicate names within tab → warn (allow)
//   • > 10 tabs → error (block import)
//   • > 150 total names → error (block import)
//   • Empty file → error
//   • Invalid format → error

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // Constants (mirror DaftarNama.js)
  // ═══════════════════════════════════════════════════════════════════
  const MAX_TABS       = 10;
  const MIN_TABS       = 1;
  const MAX_TAB_NAME   = 15;
  const MIN_NAMA_DAFTAR = 5;
  const MAX_NAMA_DAFTAR = 30;
  const MAX_NAMA_LEN   = 50;
  const MAX_TOTAL_NAMA = 150;
  const MAX_FILE_SIZE  = 5 * 1024 * 1024; // 5MB

  const TIPE_OPTIONS = ['Kelas', 'Sekolah', 'Negara', 'Custom'];

  // ═══════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════
  let _parsedTabs = null;
  let _parseWarnings = [];
  let _parseErrors = [];
  let _selectedFile = null;
  let _createTipe = null;
  let _createTipeCustom = '';

  // ═══════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════
  window.DaftarNamaImport = {
    open: _openImportModal,
  };

  // ═══════════════════════════════════════════════════════════════════
  // Modal open/close
  // ═══════════════════════════════════════════════════════════════════
  function _openImportModal() {
    // Check if DaftarNama exists
    if (!window.DaftarNama) {
      window.notify?.error('Error', 'Modul daftar nama belum siap. Muat ulang halaman.');
      return;
    }

    // Check MAX_DAFTAR
    const MAX_DAFTAR = window.DaftarNama.MAX_DAFTAR || 3;
    // We can't easily check current count here, but the caller should guard.
    // The create() will fail if max reached.

    _resetState();
    _renderModal();
  }

  function _resetState() {
    _parsedTabs = null;
    _parseWarnings = [];
    _parseErrors = [];
    _selectedFile = null;
    _createTipe = null;
    _createTipeCustom = '';
  }

  function _closeModal() {
    const overlay = document.getElementById('dnImportOverlay');
    if (overlay) overlay.remove();
    _resetState();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Modal rendering
  // ═══════════════════════════════════════════════════════════════════
  function _renderModal() {
    // Remove existing modal if any
    document.getElementById('dnImportOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dnImportOverlay';
    overlay.className = 'dn-import-overlay';
    overlay.innerHTML = `
      <div class="dn-import-modal" role="dialog" aria-modal="true" aria-labelledby="dnImportTitle">
        <div class="dn-import-header">
          <div class="dn-import-title">
            <span data-albedu-icon="file_upload"></span>
            <h3 id="dnImportTitle">Import Daftar Nama</h3>
          </div>
          <button class="dn-import-close" id="dnImportClose" type="button" aria-label="Tutup">
            <span data-albedu-icon="close"></span>
          </button>
        </div>
        <div class="dn-import-body" id="dnImportBody">
          ${_renderFormStep()}
        </div>
        <div class="dn-import-footer" id="dnImportFooter">
          <button class="dn-btn ghost" id="dnImportCancel" type="button">Batal</button>
          <button class="dn-btn primary" id="dnImportConfirm" type="button" disabled>
            <span data-albedu-icon="check"></span>
            <span>Import</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    window.AlbEdu?.bindIcons?.(overlay);

    // Wire events
    overlay.querySelector('#dnImportClose').addEventListener('click', _closeModal);
    overlay.querySelector('#dnImportCancel').addEventListener('click', _closeModal);
    overlay.querySelector('#dnImportConfirm').addEventListener('click', _handleImport);

    // Click outside to close
    overlay.addEventListener('click', e => {
      if (e.target === overlay) _closeModal();
    });

    // Escape to close
    document.addEventListener('keydown', _escHandler);

    _wireFormStep();
  }

  function _escHandler(e) {
    if (e.key === 'Escape') {
      _closeModal();
      document.removeEventListener('keydown', _escHandler);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Form step (file picker + daftar name + tipe)
  // ═══════════════════════════════════════════════════════════════════
  function _renderFormStep() {
    return `
      <div class="dn-import-form">
        <!-- File picker -->
        <div class="dn-import-field">
          <label>File <span class="dn-import-required">*</span></label>
          <div class="dn-import-dropzone" id="dnImportDropzone">
            <span data-albedu-icon="cloud_upload"></span>
            <p>Pilih file atau drag ke sini</p>
            <small>Format: .xlsx, .docx, .csv (maks 5MB)</small>
            <input type="file" id="dnImportFile" accept=".xlsx,.xls,.docx,.csv" hidden>
          </div>
          <div class="dn-import-file-info" id="dnImportFileInfo" hidden></div>
        </div>

        <!-- Format guide (collapsible) -->
        <details class="dn-import-guide">
          <summary>📋 Panduan Format</summary>
          <div class="dn-import-guide-body">
            <div class="dn-import-format">
              <h4>Excel (.xlsx)</h4>
              <ul>
                <li>Setiap sheet = 1 tab</li>
                <li>Nama sheet = nama tab</li>
                <li>Kolom A = nama peserta (1 nama per baris)</li>
                <li>Baris 1 = header (opsional, auto-deteksi "Nama"/"Name")</li>
              </ul>
              <pre>Sheet "Kelas 7A":
  | Nama    |
  | Ahmad   |
  | Budi    |

Sheet "Kelas 7B":
  | Nama    |
  | Citra   |</pre>
            </div>
            <div class="dn-import-format">
              <h4>Word (.docx)</h4>
              <ul>
                <li>Heading 1/2/3 = nama tab</li>
                <li>Daftar bullet/paragraf di bawah heading = nama</li>
              </ul>
              <pre>Kelas 7A (Heading 1)
• Ahmad
• Budi

Kelas 7B (Heading 1)
• Citra</pre>
            </div>
            <div class="dn-import-format">
              <h4>CSV (.csv)</h4>
              <ul>
                <li>Marker <code>[Nama Tab]</code> atau <code>--- Nama Tab ---</code> = tab baru</li>
                <li>Setiap baris = 1 nama</li>
                <li>Tanpa marker → semua nama masuk "Tab 1"</li>
              </ul>
              <pre>[Kelas 7A]
Ahmad
Budi

[Kelas 7B]
Citra</pre>
            </div>
          </div>
        </details>

        <!-- Daftar name -->
        <div class="dn-import-field">
          <label for="dnImportNama">Nama Daftar <span class="dn-import-required">*</span></label>
          <input type="text" id="dnImportNama" class="albedu-input" placeholder="Contoh: Daftar Kelas 7A 2026" maxlength="30" minlength="5">
          <div class="dn-import-hint"><span id="dnImportNamaCount">0</span>/30 — minimal 5 karakter</div>
        </div>

        <!-- Tipe picker -->
        <div class="dn-import-field">
          <label>Tipe Daftar <span class="dn-import-required">*</span></label>
          <div class="dn-import-tipe-picker" id="dnImportTipePicker">
            ${TIPE_OPTIONS.map(t => `
              <button class="dn-import-tipe-btn" data-tipe="${t}" type="button">
                <span data-albedu-icon="${t === 'Kelas' ? 'groups' : t === 'Sekolah' ? 'school' : t === 'Negara' ? 'public' : 'label'}"></span>
                ${t}
              </button>
            `).join('')}
          </div>
          <div class="dn-import-custom-wrap" id="dnImportCustomWrap" style="display:none;">
            <label for="dnImportTipeCustom">Nama Tipe Custom <span class="dn-import-required">*</span></label>
            <input type="text" id="dnImportTipeCustom" class="albedu-input" placeholder="Contoh: Ekskul, Tim Futsal" maxlength="20">
            <div class="dn-import-hint">minimal 2 karakter</div>
          </div>
        </div>

        <!-- Preview area (filled after file parse) -->
        <div class="dn-import-preview" id="dnImportPreview" hidden></div>
      </div>
    `;
  }

  function _wireFormStep() {
    const body = document.getElementById('dnImportBody');

    // File input
    const fileInput = body.querySelector('#dnImportFile');
    const dropzone = body.querySelector('#dnImportDropzone');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) _handleFile(e.target.files[0]);
    });

    // Drag & drop
    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) _handleFile(e.dataTransfer.files[0]);
    });

    // Daftar name char counter
    const namaInput = body.querySelector('#dnImportNama');
    const namaCount = body.querySelector('#dnImportNamaCount');
    namaInput.addEventListener('input', e => {
      namaCount.textContent = e.target.value.length;
      _updateConfirmButton();
    });

    // Tipe picker
    body.querySelectorAll('.dn-import-tipe-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _createTipe = btn.dataset.tipe;
        body.querySelectorAll('.dn-import-tipe-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const customWrap = body.querySelector('#dnImportCustomWrap');
        // FIX: use style.display instead of hidden attribute (more reliable)
        if (_createTipe === 'Custom') {
          customWrap.style.display = 'flex';
          // Focus the custom input for better UX
          setTimeout(() => body.querySelector('#dnImportTipeCustom')?.focus(), 50);
        } else {
          customWrap.style.display = 'none';
        }
        _updateConfirmButton();
      });
    });

    // Custom tipe input
    const tipeCustomInput = body.querySelector('#dnImportTipeCustom');
    tipeCustomInput.addEventListener('input', e => {
      _createTipeCustom = e.target.value;
      _updateConfirmButton();
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // File handling + parsing
  // ═══════════════════════════════════════════════════════════════════
  async function _handleFile(file) {
    _selectedFile = file;
    _parsedTabs = null;
    _parseWarnings = [];
    _parseErrors = [];

    const fileInfo = document.getElementById('dnImportFileInfo');
    const dropzone = document.getElementById('dnImportDropzone');

    // File size check
    if (file.size > MAX_FILE_SIZE) {
      _parseErrors.push(`Ukuran file ${_formatSize(file.size)} melebihi batas 5MB.`);
      _renderPreview();
      return;
    }

    // FIX: Auto-fill nama daftar from filename if field is empty
    // Strip extension + common suffixes, title-case the result
    const namaInput = document.getElementById('dnImportNama');
    if (namaInput && !namaInput.value.trim()) {
      const baseName = file.name.replace(/\.(xlsx|xls|docx|csv)$/i, '');
      // Clean up: replace underscores/dashes with spaces, title-case
      const cleaned = baseName
        .replace(/[_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
      // Only fill if it meets min length (5 chars)
      if (cleaned.length >= MIN_NAMA_DAFTAR) {
        namaInput.value = cleaned.slice(0, MAX_NAMA_DAFTAR);
        const namaCount = document.getElementById('dnImportNamaCount');
        if (namaCount) namaCount.textContent = namaInput.value.length;
      }
    }

    // FIX: Smart-guess tipe from filename if no tipe selected yet
    if (!_createTipe) {
      const lowerName = file.name.toLowerCase();
      let guessedTipe = null;
      if (/kelas|class/i.test(lowerName)) {
        guessedTipe = 'Kelas';
      } else if (/sekolah|school/i.test(lowerName)) {
        guessedTipe = 'Sekolah';
      } else if (/negara|country|nation/i.test(lowerName)) {
        guessedTipe = 'Negara';
      }
      if (guessedTipe) {
        const tipeBtn = document.querySelector(`.dn-import-tipe-btn[data-tipe="${guessedTipe}"]`);
        if (tipeBtn) tipeBtn.click(); // triggers the click handler → sets _createTipe + .selected
      }
    }

    // Show file info
    fileInfo.hidden = false;
    fileInfo.innerHTML = `
      <span data-albedu-icon="description"></span>
      <span class="dn-import-file-name">${_esc(file.name)}</span>
      <span class="dn-import-file-size">${_formatSize(file.size)}</span>
      <button class="dn-import-file-remove" id="dnImportFileRemove" type="button" aria-label="Hapus file">
        <span data-albedu-icon="close"></span>
      </button>
    `;
    window.AlbEdu?.bindIcons?.(fileInfo);
    fileInfo.querySelector('#dnImportFileRemove').addEventListener('click', () => {
      _selectedFile = null;
      _parsedTabs = null;
      fileInfo.hidden = true;
      document.getElementById('dnImportFile').value = '';
      _renderPreview();
      _updateConfirmButton();
    });

    dropzone.classList.add('has-file');

    // Parse by extension
    const ext = file.name.split('.').pop().toLowerCase();
    try {
      if (ext === 'xlsx' || ext === 'xls') {
        await _parseXlsx(file);
      } else if (ext === 'docx') {
        await _parseDocx(file);
      } else if (ext === 'csv') {
        await _parseCsv(file);
      } else {
        _parseErrors.push(`Format .${ext} tidak didukung. Gunakan .xlsx, .docx, atau .csv.`);
      }
    } catch (err) {
      console.error('[DaftarNamaImport] Parse failed:', err);
      _parseErrors.push(`Gagal membaca file: ${err.message}`);
    }

    _renderPreview();
    _updateConfirmButton();
  }

  // ═══════════════════════════════════════════════════════════════════
  // XLSX parser (SheetJS)
  // ═══════════════════════════════════════════════════════════════════
  async function _parseXlsx(file) {
    if (!window.XLSX) {
      _parseErrors.push('Library SheetJS belum siap. Muat ulang halaman.');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      _parseErrors.push('File Excel tidak memiliki sheet.');
      return;
    }

    const tabs = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      const names = [];
      for (let i = 0; i < rows.length; i++) {
        const cellValue = rows[i]?.[0];
        if (!cellValue && cellValue !== 0) continue;
        const name = String(cellValue).trim();
        if (!name) continue;
        // Skip header row (first row, if it says "Nama"/"Name"/"No")
        if (i === 0 && /^(nama|name|names|nama\s+peserta|no\.?|nomor)$/i.test(name)) {
          continue;
        }
        names.push(name);
      }

      if (names.length > 0) {
        const tabName = sheetName.trim() || `Tab ${tabs.length + 1}`;
        tabs.push({ nama_tab: tabName, anggota: names });
      } else if (sheetName.trim()) {
        _parseWarnings.push(`Sheet "${sheetName}" kosong — dilewati.`);
      }
    }

    _parsedTabs = tabs;
    _postParse();
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOCX parser (mammoth)
  // ═══════════════════════════════════════════════════════════════════
  async function _parseDocx(file) {
    if (!window.mammoth) {
      _parseErrors.push('Library mammoth belum siap. Muat ulang halaman.');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const html = result.value;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const tabs = [];
    let currentTab = null;
    let currentNames = [];

    function _pushCurrentTab() {
      if (currentTab && currentNames.length > 0) {
        tabs.push({ nama_tab: currentTab, anggota: [...currentNames] });
      } else if (currentTab && currentNames.length === 0) {
        _parseWarnings.push(`Tab "${currentTab}" kosong — dilewati.`);
      }
      currentTab = null;
      currentNames = [];
    }

    for (const element of doc.body.children) {
      const tag = element.tagName;
      const text = element.textContent.trim();

      if (/^H[1-6]$/.test(tag)) {
        // Heading → new tab
        _pushCurrentTab();
        currentTab = text || `Tab ${tabs.length + 1}`;
      } else if (tag === 'UL' || tag === 'OL') {
        // List → names
        const items = element.querySelectorAll('li');
        items.forEach(li => {
          const name = li.textContent.trim();
          if (name) {
            if (!currentTab) currentTab = `Tab ${tabs.length + 1}`;
            currentNames.push(name);
          }
        });
      } else if (tag === 'P' && text) {
        // Paragraph → could be a name or a tab marker like "--- Tab ---"
        const markerMatch = text.match(/^---\s*(.+?)\s*---$/) || text.match(/^\[(.+)\]$/);
        if (markerMatch) {
          _pushCurrentTab();
          currentTab = markerMatch[1].trim();
        } else {
          if (!currentTab) currentTab = `Tab ${tabs.length + 1}`;
          // Could be multiple names separated by comma or newline
          const parts = text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
          parts.forEach(p => {
            if (p.length <= MAX_NAMA_LEN) currentNames.push(p);
          });
        }
      } else if (tag === 'TABLE') {
        // Table → extract first column as names
        const rows = element.querySelectorAll('tr');
        rows.forEach((row, i) => {
          const cell = row.querySelector('td, th');
          if (!cell) return;
          const name = cell.textContent.trim();
          if (!name) return;
          if (i === 0 && /^(nama|name|no\.?|nomor)$/i.test(name)) return; // header
          if (!currentTab) currentTab = `Tab ${tabs.length + 1}`;
          currentNames.push(name);
        });
      }
    }
    _pushCurrentTab();

    if (tabs.length === 0) {
      _parseErrors.push('Tidak ada nama ditemukan di file DOCX. Pastikan ada heading + daftar nama.');
      return;
    }

    _parsedTabs = tabs;
    _postParse();
  }

  // ═══════════════════════════════════════════════════════════════════
  // CSV parser
  // ═══════════════════════════════════════════════════════════════════
  async function _parseCsv(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);

    const tabs = [];
    let currentTab = null;
    let currentNames = [];

    function _pushCurrentTab() {
      if (currentTab && currentNames.length > 0) {
        tabs.push({ nama_tab: currentTab, anggota: [...currentNames] });
      }
      currentTab = null;
      currentNames = [];
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect tab marker: [Tab: Name] or [Name] or --- Name ---
      const markerMatch = trimmed.match(/^\[(.+)\]$/) || trimmed.match(/^---\s*(.+?)\s*---$/);
      if (markerMatch) {
        _pushCurrentTab();
        currentTab = markerMatch[1].trim();
      } else {
        if (!currentTab) currentTab = `Tab ${tabs.length + 1}`;
        // Strip CSV quoting
        const name = trimmed.replace(/^["']|["']$/g, '').trim();
        if (name) currentNames.push(name);
      }
    }
    _pushCurrentTab();

    if (tabs.length === 0) {
      _parseErrors.push('File CSV kosong atau tidak ada nama ditemukan.');
      return;
    }

    _parsedTabs = tabs;
    _postParse();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Post-parse validation + auto-fix
  // ═══════════════════════════════════════════════════════════════════
  function _postParse() {
    if (!_parsedTabs || _parsedTabs.length === 0) {
      _parseErrors.push('Tidak ada tab/nama valid ditemukan di file.');
      return;
    }

    // Check MAX_TABS
    if (_parsedTabs.length > MAX_TABS) {
      _parseErrors.push(`Terlalu banyak tab: ${_parsedTabs.length} (maksimal ${MAX_TABS}). Hapus tab yang tidak perlu dari file.`);
      return;
    }

    // Check MIN_TABS
    if (_parsedTabs.length < MIN_TABS) {
      _parseErrors.push(`Minimal ${MIN_TABS} tab harus ada.`);
      return;
    }

    // Auto-fix: tab name too long → truncate
    _parsedTabs.forEach(tab => {
      if (tab.nama_tab.length > MAX_TAB_NAME) {
        _parseWarnings.push(`Nama tab "${tab.nama_tab}" melebihi ${MAX_TAB_NAME} karakter — dipotong menjadi "${tab.nama_tab.slice(0, MAX_TAB_NAME)}".`);
        tab.nama_tab = tab.nama_tab.slice(0, MAX_TAB_NAME);
      }
    });

    // Auto-fix: duplicate tab names → rename
    // SMART DETECTION: Catches Excel's auto-rename pattern.
    // When Excel saves a duplicate sheet name, it appends a number:
    // "Kelas" + "Kelas" → "Kelas" + "Kelas1"
    // We normalize by stripping trailing digits to detect the original.
    // Examples that match as duplicate:
    //   "Kelas" + "Kelas1" → both normalize to "kelas"
    //   "Tab A" + "Tab A1" → both normalize to "tab a"
    //   "Sheet" + "Sheet2" + "Sheet3" → all normalize to "sheet"
    const seenTabNames = new Map(); // normalized name → count
    const originalNames = new Map(); // normalized name → first original name
    _parsedTabs.forEach(tab => {
      // Normalize: lowercase + strip trailing digits (Excel auto-rename pattern)
      const normalized = tab.nama_tab.toLowerCase().replace(/\d+$/, '').trim();
      if (seenTabNames.has(normalized)) {
        const count = seenTabNames.get(normalized) + 1;
        seenTabNames.set(normalized, count);
        const baseName = originalNames.get(normalized);
        const newName = `${baseName} (${count})`.slice(0, MAX_TAB_NAME);
        _parseWarnings.push(`Nama tab duplikat "${tab.nama_tab}" → diubah menjadi "${newName}".`);
        tab.nama_tab = newName;
      } else {
        seenTabNames.set(normalized, 1);
        originalNames.set(normalized, tab.nama_tab);
      }
    });

    // Auto-fix: name too long → truncate
    _parsedTabs.forEach(tab => {
      tab.anggota = tab.anggota.map(name => {
        if (name.length > MAX_NAMA_LEN) {
          const truncated = name.slice(0, MAX_NAMA_LEN);
          _parseWarnings.push(`Nama "${name}" di tab "${tab.nama_tab}" melebihi ${MAX_NAMA_LEN} karakter — dipotong.`);
          return truncated;
        }
        return name;
      });
    });

    // Check total names
    const totalNama = _parsedTabs.reduce((s, t) => s + t.anggota.length, 0);
    if (totalNama > MAX_TOTAL_NAMA) {
      _parseErrors.push(`Total nama ${totalNama} melebihi batas ${MAX_TOTAL_NAMA}. Kurangi nama di file.`);
      return;
    }

    // Check for duplicate names within each tab (warning, not error)
    _parsedTabs.forEach(tab => {
      const seen = new Map();
      const dups = [];
      tab.anggota.forEach(name => {
        const lower = name.toLowerCase();
        seen.set(lower, (seen.get(lower) || 0) + 1);
      });
      seen.forEach((count, name) => {
        if (count > 1) dups.push(`${name} (${count}x)`);
      });
      if (dups.length > 0) {
        _parseWarnings.push(`Tab "${tab.nama_tab}" memiliki nama duplikat: ${dups.join(', ')}. Duplikat akan tetap diimport.`);
      }
    });

    // Check for empty tabs (shouldn't happen after parse, but just in case)
    const emptyTabs = _parsedTabs.filter(t => t.anggota.length === 0);
    if (emptyTabs.length > 0) {
      _parseWarnings.push(`${emptyTabs.length} tab kosong ditemukan — akan dilewati.`);
      _parsedTabs = _parsedTabs.filter(t => t.anggota.length > 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Preview rendering
  // ═══════════════════════════════════════════════════════════════════
  function _renderPreview() {
    const preview = document.getElementById('dnImportPreview');
    if (!preview) return;

    if (!_selectedFile) {
      preview.hidden = true;
      preview.innerHTML = '';
      return;
    }

    preview.hidden = false;

    if (_parseErrors.length > 0) {
      preview.innerHTML = `
        <div class="dn-import-result dn-import-result-error">
          <div class="dn-import-result-icon"><span data-albedu-icon="error"></span></div>
          <div class="dn-import-result-body">
            <h4>Gagal Import</h4>
            <ul class="dn-import-issues">
              ${_parseErrors.map(e => `<li>${_esc(e)}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
      window.AlbEdu?.bindIcons?.(preview);
      return;
    }

    if (!_parsedTabs || _parsedTabs.length === 0) {
      preview.innerHTML = `
        <div class="dn-import-result dn-import-result-loading">
          <span class="dn-import-spinner"></span>
          <span>Memproses file...</span>
        </div>
      `;
      return;
    }

    const totalNama = _parsedTabs.reduce((s, t) => s + t.anggota.length, 0);

    preview.innerHTML = `
      <div class="dn-import-result dn-import-result-success">
        <div class="dn-import-result-summary">
          <div class="dn-import-stat">
            <span class="dn-import-stat-value">${_parsedTabs.length}</span>
            <span class="dn-import-stat-label">Tab</span>
          </div>
          <div class="dn-import-stat">
            <span class="dn-import-stat-value">${totalNama}</span>
            <span class="dn-import-stat-label">Nama</span>
          </div>
        </div>
        ${_parseWarnings.length > 0 ? `
          <div class="dn-import-warnings">
            <div class="dn-import-warnings-head"><span data-albedu-icon="warning"></span> ${_parseWarnings.length} peringatan:</div>
            <ul class="dn-import-issues">
              ${_parseWarnings.slice(0, 5).map(w => `<li>${_esc(w)}</li>`).join('')}
              ${_parseWarnings.length > 5 ? `<li>... dan ${_parseWarnings.length - 5} lainnya</li>` : ''}
            </ul>
          </div>
        ` : ''}
        <div class="dn-import-tabs-preview">
          ${_parsedTabs.map(tab => `
            <div class="dn-import-tab-preview">
              <div class="dn-import-tab-head">
                <span class="dn-import-tab-name">${_esc(tab.nama_tab)}</span>
                <span class="dn-import-tab-count">${tab.anggota.length} nama</span>
              </div>
              <div class="dn-import-tab-names">
                ${tab.anggota.slice(0, 5).map(n => `<span class="dn-import-name-chip">${_esc(n)}</span>`).join('')}
                ${tab.anggota.length > 5 ? `<span class="dn-import-name-more">+${tab.anggota.length - 5} lainnya</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    window.AlbEdu?.bindIcons?.(preview);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Confirm button state
  // ═══════════════════════════════════════════════════════════════════
  function _updateConfirmButton() {
    const btn = document.getElementById('dnImportConfirm');
    if (!btn) return;

    const nama = document.getElementById('dnImportNama')?.value.trim() || '';
    const hasFile = _selectedFile && _parsedTabs && _parsedTabs.length > 0;
    const hasErrors = _parseErrors.length > 0;
    const hasNama = nama.length >= MIN_NAMA_DAFTAR && nama.length <= MAX_NAMA_DAFTAR;
    const hasTipe = !!_createTipe;
    const hasCustomTipe = _createTipe !== 'Custom' || (_createTipeCustom && _createTipeCustom.trim().length >= 2);

    btn.disabled = !(hasFile && !hasErrors && hasNama && hasTipe && hasCustomTipe);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Import execution
  // ═══════════════════════════════════════════════════════════════════
  async function _handleImport() {
    const nama = document.getElementById('dnImportNama').value.trim();
    const btn = document.getElementById('dnImportConfirm');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="dn-import-spinner"></span> <span>Mengimport...</span>';
    }

    try {
      // Generate tab IDs for the parsed tabs
      const tabsWithIds = _parsedTabs.map(tab => ({
        id: 'tab_' + Math.random().toString(36).slice(2, 9),
        nama_tab: tab.nama_tab,
        anggota: tab.anggota,
      }));

      const created = await window.DaftarNama.create(
        nama,
        _createTipe,
        _createTipeCustom.trim(),
        tabsWithIds,  // initialTabs with IDs
        false         // forceSaveWithDup
      );

      // Success — close modal + refresh list
      _closeModal();

      // Reload the daftar list
      if (typeof _load === 'function') {
        await _load();
      }

      // Select the newly created daftar
      if (typeof _selectDaftar === 'function' && typeof _daftarList !== 'undefined') {
        const newDaftar = _daftarList.find(d => d.id === created.id);
        if (newDaftar) _selectDaftar(newDaftar);
      }

      window.notify?.success(
        'Import Berhasil',
        `${tabsWithIds.length} tab dengan ${tabsWithIds.reduce((s, t) => s + t.anggota.length, 0)} nama berhasil diimport.`,
        4000
      );
    } catch (err) {
      console.error('[DaftarNamaImport] Import failed:', err);

      if (err.isDuplicateWarning) {
        // Duplicate names — ask to force import
        const ok = await window.UI?.confirm({
          title: 'Nama Duplikat Ditemukan',
          message: 'Ada nama yang sama dalam satu tab. Tetap import?',
          confirmText: 'Import',
          cancelText: 'Batal',
        });
        if (ok) {
          try {
            const tabsWithIds = _parsedTabs.map(tab => ({
              id: 'tab_' + Math.random().toString(36).slice(2, 9),
              nama_tab: tab.nama_tab,
              anggota: tab.anggota,
            }));
            const created = await window.DaftarNama.create(
              nama, _createTipe, _createTipeCustom.trim(), tabsWithIds, true
            );
            _closeModal();
            if (typeof _load === 'function') await _load();
            if (typeof _selectDaftar === 'function' && typeof _daftarList !== 'undefined') {
              const newDaftar = _daftarList.find(d => d.id === created.id);
              if (newDaftar) _selectDaftar(newDaftar);
            }
            window.notify?.success('Import Berhasil', 'Daftar berhasil diimport dengan nama duplikat.', 3000);
          } catch (err2) {
            window.notify?.error('Gagal Import', err2.message);
          }
        }
      } else {
        window.notify?.error('Gagal Import', err.message);
      }

      // Reset button
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span data-albedu-icon="check"></span> <span>Import</span>';
        window.AlbEdu?.bindIcons?.(btn);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════
  function _esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
})();
