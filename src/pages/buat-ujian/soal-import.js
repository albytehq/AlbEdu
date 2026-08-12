// soal-import.js — Production-grade Import Bagian + Soal from DOCX/XLSX/CSV
//
// Replaces the old TemplatePicker with a file-based import that creates
// sections + questions in bulk.
//
// SUPPORTED FORMATS:
//
// 1. Excel (.xlsx/.xls):
//    Each sheet = 1 section (sheet name = section type: "PG" or "Esai").
//    Columns:
//      A = Pertanyaan
//      B = Opsi A
//      C = Opsi B
//      D = Opsi C
//      E = Opsi D
//      F = Jawaban Benar (A/B/C/D) — for PG sections
//    Row 1 = header (auto-detected)
//
// 2. Word (.docx):
//    Heading 1 = Section type marker: "PG" or "Esai"
//    Heading 2 = Question text
//    Bullet list under Heading 2 = Options (for PG)
//    Bold bullet = correct answer (for PG)
//
// 3. CSV (.csv):
//    [Section:PG] or [Section:Esai] marker = new section
//    Q: pertanyaan text = question
//    A: opsi text = option A
//    B: opsi text = option B
//    C: opsi text = option C
//    D: opsi text = option D
//    *A or ANS:A = correct answer
//
// EDGE CASES HANDLED:
//   • Section type detection (PG vs Esai)
//   • Max 2 sections (error if > 2)
//   • Max questions per section (no hard limit, but warned)
//   • Duplicate questions within section (warn)
//   • Duplicate options within question (warn)
//   • No correct answer for PG (warn + mark)
//   • Empty rows/lines (skip)
//   • Malformed rows (skip with warning)
//   • File > 5MB (error)
//   • Invalid format (error)

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const MAX_SECTIONS = 2;
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const MAX_QUESTIONS_PER_SECTION = 50;

  const SoalImport = {
    open: _openImportModal,
  };

  window.SoalImport = SoalImport;

  // ═══════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════
  let _parsedSections = null;
  let _parseWarnings = [];
  let _parseErrors = [];
  let _selectedFile = null;

  // ═══════════════════════════════════════════════════════════════════
  // Modal
  // ═══════════════════════════════════════════════════════════════════
  function _openImportModal() {
    if (!window.CreateAssessment) {
      window.notify?.error('Error', 'Modul asesmen belum siap.');
      return;
    }

    _resetState();
    _renderModal();
  }

  function _resetState() {
    _parsedSections = null;
    _parseWarnings = [];
    _parseErrors = [];
    _selectedFile = null;
  }

  function _closeModal() {
    const overlay = document.getElementById('soalImportOverlay');
    if (overlay) overlay.remove();
    _resetState();
  }

  function _renderModal() {
    document.getElementById('soalImportOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'soalImportOverlay';
    overlay.className = 'dn-import-overlay'; // reuse daftar-nama import CSS
    overlay.innerHTML = `
      <div class="dn-import-modal" role="dialog" aria-modal="true" aria-labelledby="soalImportTitle">
        <div class="dn-import-header">
          <div class="dn-import-title">
            <span data-albedu-icon="file_upload"></span>
            <h3 id="soalImportTitle">Import Bagian & Soal</h3>
          </div>
          <button class="dn-import-close" id="soalImportClose" type="button" aria-label="Tutup">
            <span data-albedu-icon="close"></span>
          </button>
        </div>
        <div class="dn-import-body" id="soalImportBody">
          ${_renderFormStep()}
        </div>
        <div class="dn-import-footer" id="soalImportFooter">
          <button class="dn-btn ghost" id="soalImportCancel" type="button">Batal</button>
          <button class="dn-btn primary" id="soalImportConfirm" type="button" disabled>
            <span data-albedu-icon="check"></span>
            <span>Import</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    window.AlbEdu?.bindIcons?.(overlay);

    overlay.querySelector('#soalImportClose').addEventListener('click', _closeModal);
    overlay.querySelector('#soalImportCancel').addEventListener('click', _closeModal);
    overlay.querySelector('#soalImportConfirm').addEventListener('click', _handleImport);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) _closeModal();
    });

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
  // Form
  // ═══════════════════════════════════════════════════════════════════
  function _renderFormStep() {
    return `
      <div class="dn-import-form">
        <div class="dn-import-field">
          <label>File <span class="dn-import-required">*</span></label>
          <div class="dn-import-dropzone" id="soalImportDropzone">
            <span data-albedu-icon="cloud_upload"></span>
            <p>Pilih file atau drag ke sini</p>
            <small>Format: .xlsx, .docx, .csv (maks 5MB)</small>
            <input type="file" id="soalImportFile" accept=".xlsx,.xls,.docx,.csv" hidden>
          </div>
          <div class="dn-import-file-info" id="soalImportFileInfo" hidden></div>
        </div>

        <details class="dn-import-guide">
          <summary>📋 Panduan Format</summary>
          <div class="dn-import-guide-body">
            <div class="dn-import-format">
              <h4>Excel (.xlsx)</h4>
              <ul>
                <li>Setiap sheet = 1 bagian (nama sheet = "PG" atau "Esai")</li>
                <li>Kolom A = Pertanyaan, B-E = Opsi A-D, F = Jawaban Benar (A/B/C/D)</li>
                <li>Baris 1 = header (opsional)</li>
              </ul>
              <pre>Sheet "PG":
| Pertanyaan    | A    | B    | C    | D    | Jawaban |
| 1+1=...?      | 1    | 2    | 3    | 4    | B       |
| Ibu kota RI?  | Jakarta | Bandung | Surabaya | Medan | A       |</pre>
            </div>
            <div class="dn-import-format">
              <h4>Word (.docx)</h4>
              <ul>
                <li>Heading 1 = tipe bagian: "PG" atau "Esai"</li>
                <li>Heading 2 = pertanyaan</li>
                <li>Bullet list = opsi jawaban (untuk PG)</li>
                <li><strong>Bold</strong> bullet = jawaban benar</li>
              </ul>
              <pre>PG (Heading 1)
1+1=...? (Heading 2)
• 1
• 2 (bold)
• 3
• 4

Esai (Heading 1)
Jelaskan... (Heading 2)</pre>
            </div>
            <div class="dn-import-format">
              <h4>CSV (.csv)</h4>
              <ul>
                <li><code>[Section:PG]</code> atau <code>[Section:Esai]</code> = bagian baru</li>
                <li><code>Q: pertanyaan</code> = soal</li>
                <li><code>A: opsi</code>, <code>B: opsi</code>, dll = opsi</li>
                <li><code>ANS: A</code> = jawaban benar</li>
              </ul>
              <pre>[Section:PG]
Q: 1+1=...?
A: 1
B: 2
C: 3
D: 4
ANS: B
Q: Ibu kota RI?
A: Jakarta
B: Bandung
ANS: A</pre>
            </div>
          </div>
        </details>

        <div class="dn-import-preview" id="soalImportPreview" hidden></div>
      </div>
    `;
  }

  function _wireFormStep() {
    const body = document.getElementById('soalImportBody');
    const fileInput = body.querySelector('#soalImportFile');
    const dropzone = body.querySelector('#soalImportDropzone');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) _handleFile(e.target.files[0]);
    });

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
  }

  // ═══════════════════════════════════════════════════════════════════
  // File handling
  // ═══════════════════════════════════════════════════════════════════
  async function _handleFile(file) {
    _selectedFile = file;
    _parsedSections = null;
    _parseWarnings = [];
    _parseErrors = [];

    const fileInfo = document.getElementById('soalImportFileInfo');
    const dropzone = document.getElementById('soalImportDropzone');

    if (file.size > MAX_FILE_SIZE) {
      _parseErrors.push(`Ukuran file ${_formatSize(file.size)} melebihi batas 5MB.`);
      _renderPreview();
      _updateConfirmButton();
      return;
    }

    fileInfo.hidden = false;
    fileInfo.innerHTML = `
      <span data-albedu-icon="description"></span>
      <span class="dn-import-file-name">${_esc(file.name)}</span>
      <span class="dn-import-file-size">${_formatSize(file.size)}</span>
      <button class="dn-import-file-remove" id="soalImportFileRemove" type="button" aria-label="Hapus file">
        <span data-albedu-icon="close"></span>
      </button>
    `;
    window.AlbEdu?.bindIcons?.(fileInfo);
    fileInfo.querySelector('#soalImportFileRemove').addEventListener('click', () => {
      _selectedFile = null;
      _parsedSections = null;
      fileInfo.hidden = true;
      document.getElementById('soalImportFile').value = '';
      _renderPreview();
      _updateConfirmButton();
    });

    dropzone.classList.add('has-file');

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
      console.error('[SoalImport] Parse failed:', err);
      _parseErrors.push(`Gagal membaca file: ${err.message}`);
    }

    _postParse();
    _renderPreview();
    _updateConfirmButton();
  }

  // ═══════════════════════════════════════════════════════════════════
  // XLSX parser
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

    const sections = [];
    for (const sheetName of workbook.SheetNames) {
      // Detect section type from sheet name
      const typeMatch = sheetName.match(/^(PG|Esai|Essay)$/i);
      const sectionType = typeMatch ? (typeMatch[1].toLowerCase() === 'esai' || typeMatch[1].toLowerCase() === 'essay' ? 'esai' : 'PG') : 'PG';

      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (rows.length === 0) {
        _parseWarnings.push(`Sheet "${sheetName}" kosong — dilewati.`);
        continue;
      }

      // Detect header row (skip if first row contains "Pertanyaan"/"Soal"/"Question")
      const firstRow = rows[0];
      const hasHeader = firstRow.some(cell => /^(pertanyaan|soal|question|jawaban|answer)$/i.test(String(cell).trim()));
      const dataRows = hasHeader ? rows.slice(1) : rows;

      const questions = [];
      for (const row of dataRows) {
        const pertanyaan = String(row[0] || '').trim();
        if (!pertanyaan) continue; // skip empty rows

        if (sectionType === 'PG') {
          const pilihan = {
            A: String(row[1] || '').trim(),
            B: String(row[2] || '').trim(),
            C: String(row[3] || '').trim(),
            D: String(row[4] || '').trim(),
          };
          let jawaban = String(row[5] || '').trim().toUpperCase();
          // Normalize: accept "A", "a", "1" (→A), "2" (→B), etc.
          if (/^[1-4]$/.test(jawaban)) {
            jawaban = ['A', 'B', 'C', 'D'][parseInt(jawaban) - 1];
          }
          if (!['A', 'B', 'C', 'D'].includes(jawaban)) jawaban = '';

          // Skip if no options at all
          if (!pilihan.A && !pilihan.B && !pilihan.C && !pilihan.D) {
            _parseWarnings.push(`Baris "${pertanyaan.slice(0, 30)}..." tidak punya opsi — dilewati.`);
            continue;
          }

          questions.push({
            idq: 0,
            pertanyaan,
            pilihan,
            jawaban_benar: jawaban,
            media: { video: { enabled: false, src: null }, gambar: [] },
          });
        } else {
          // Esai
          questions.push({
            idq: 0,
            pertanyaan,
            media: { video: { enabled: false, src: null }, gambar: [] },
          });
        }
      }

      if (questions.length > 0) {
        sections.push({ type_question: sectionType, questions });
      } else {
        _parseWarnings.push(`Sheet "${sheetName}" tidak memiliki soal valid — dilewati.`);
      }
    }

    _parsedSections = sections;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DOCX parser
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

    const sections = [];
    let currentSection = null;
    let currentQuestion = null;
    let currentOptions = {};
    let optionLetters = ['A', 'B', 'C', 'D'];
    let optionIdx = 0;

    function _pushQuestion() {
      if (!currentQuestion) return;
      if (currentSection.type_question === 'PG') {
        currentQuestion.pilihan = { ...currentOptions };
        // Auto-detect correct answer: check for <strong> in any option
        // (mammoth converts bold to <strong>)
        if (!currentQuestion.jawaban_benar) {
          // Will be set by option processing
        }
        // Fill missing options with empty string
        ['A', 'B', 'C', 'D'].forEach(k => {
          if (!currentQuestion.pilihan[k]) currentQuestion.pilihan[k] = '';
        });
        currentOptions = {};
        optionIdx = 0;
      }
      currentSection.questions.push(currentQuestion);
      currentQuestion = null;
    }

    function _pushSection() {
      if (currentSection) {
        _pushQuestion();
        if (currentSection.questions.length > 0) {
          sections.push(currentSection);
        }
      }
      currentSection = null;
    }

    for (const element of doc.body.children) {
      const tag = element.tagName;
      const text = element.textContent.trim();

      if (tag === 'H1') {
        _pushSection();
        // Detect section type
        const typeMatch = text.match(/^(PG|Esai|Essay)$/i);
        const type = typeMatch ? (typeMatch[1].toLowerCase() === 'esai' || typeMatch[1].toLowerCase() === 'essay' ? 'esai' : 'PG') : 'PG';
        currentSection = { type_question: type, questions: [] };
      } else if (tag === 'H2' || tag === 'H3') {
        _pushQuestion();
        if (!currentSection) {
          currentSection = { type_question: 'PG', questions: [] };
        }
        currentQuestion = {
          idq: 0,
          pertanyaan: text,
          media: { video: { enabled: false, src: null }, gambar: [] },
        };
        if (currentSection.type_question === 'PG') {
          currentQuestion.jawaban_benar = '';
        }
      } else if ((tag === 'UL' || tag === 'OL') && currentQuestion && currentSection?.type_question === 'PG') {
        // Options for PG question
        const items = element.querySelectorAll('li');
        items.forEach((li, i) => {
          if (i >= 4) return; // max 4 options
          const letter = optionLetters[i];
          const isBold = li.querySelector('strong') !== null;
          currentOptions[letter] = li.textContent.trim();
          if (isBold && !currentQuestion.jawaban_benar) {
            currentQuestion.jawaban_benar = letter;
          }
        });
      } else if (tag === 'P' && text && currentQuestion) {
        // Additional paragraph — append to question text
        currentQuestion.pertanyaan += '\n' + text;
      }
    }
    _pushSection();

    if (sections.length === 0) {
      _parseErrors.push('Tidak ada bagian/soal ditemukan di file DOCX. Pastikan ada Heading 1 (PG/Esai) + Heading 2 (pertanyaan).');
      return;
    }

    _parsedSections = sections;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CSV parser
  // ═══════════════════════════════════════════════════════════════════
  async function _parseCsv(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);

    const sections = [];
    let currentSection = null;
    let currentQuestion = null;

    function _pushQuestion() {
      if (!currentQuestion) return;
      if (currentSection.type_question === 'PG') {
        // Fill missing options
        if (!currentQuestion.pilihan) currentQuestion.pilihan = { A: '', B: '', C: '', D: '' };
        ['A', 'B', 'C', 'D'].forEach(k => {
          if (!currentQuestion.pilihan[k]) currentQuestion.pilihan[k] = '';
        });
      }
      currentSection.questions.push(currentQuestion);
      currentQuestion = null;
    }

    function _pushSection() {
      if (currentSection) {
        _pushQuestion();
        if (currentSection.questions.length > 0) sections.push(currentSection);
      }
      currentSection = null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Section marker: [Section:PG] or [Section:Esai]
      const sectionMatch = trimmed.match(/^\[Section:\s*(PG|Esai|Essay)\s*\]$/i);
      if (sectionMatch) {
        _pushSection();
        const type = sectionMatch[1].toLowerCase() === 'esai' || sectionMatch[1].toLowerCase() === 'essay' ? 'esai' : 'PG';
        currentSection = { type_question: type, questions: [] };
        continue;
      }

      // Question: Q: pertanyaan
      if (/^Q:\s*/i.test(trimmed)) {
        _pushQuestion();
        if (!currentSection) {
          currentSection = { type_question: 'PG', questions: [] };
        }
        const pertanyaan = trimmed.replace(/^Q:\s*/i, '').trim();
        currentQuestion = {
          idq: 0,
          pertanyaan,
          media: { video: { enabled: false, src: null }, gambar: [] },
        };
        if (currentSection.type_question === 'PG') {
          currentQuestion.pilihan = { A: '', B: '', C: '', D: '' };
          currentQuestion.jawaban_benar = '';
        }
        continue;
      }

      // Answer: ANS: A or *A
      const ansMatch = trimmed.match(/^(?:ANS:\s*|\.)([A-D])$/i);
      if (ansMatch && currentQuestion && currentSection?.type_question === 'PG') {
        currentQuestion.jawaban_benar = ansMatch[1].toUpperCase();
        continue;
      }

      // Option: A: text, B: text, etc.
      const optMatch = trimmed.match(/^([A-D]):\s*(.+)$/i);
      if (optMatch && currentQuestion && currentSection?.type_question === 'PG') {
        const letter = optMatch[1].toUpperCase();
        const text = optMatch[2].trim();
        // Check if marked as correct (*A: text or A: *text)
        if (text.startsWith('*')) {
          currentQuestion.jawaban_benar = letter;
          currentQuestion.pilihan[letter] = text.slice(1).trim();
        } else {
          currentQuestion.pilihan[letter] = text;
        }
        continue;
      }
    }
    _pushSection();

    if (sections.length === 0) {
      _parseErrors.push('File CSV kosong atau tidak ada soal ditemukan. Pastikan format: [Section:PG], Q: pertanyaan, A: opsi, ANS: A.');
      return;
    }

    _parsedSections = sections;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Post-parse validation
  // ═══════════════════════════════════════════════════════════════════
  function _postParse() {
    if (!_parsedSections || _parsedSections.length === 0) {
      if (_parseErrors.length === 0) {
        _parseErrors.push('Tidak ada bagian/soal valid ditemukan di file.');
      }
      return;
    }

    // Check max sections
    if (_parsedSections.length > MAX_SECTIONS) {
      _parseErrors.push(`Terlalu banyak bagian: ${_parsedSections.length} (maksimal ${MAX_SECTIONS}). Hapus bagian yang tidak perlu dari file.`);
      return;
    }

    // Validate each section
    _parsedSections.forEach((sec, sIdx) => {
      if (sec.questions.length > MAX_QUESTIONS_PER_SECTION) {
        _parseWarnings.push(`Bagian ${sIdx + 1} memiliki ${sec.questions.length} soal (rekomendasi maksimal ${MAX_QUESTIONS_PER_SECTION}).`);
      }

      // Check for duplicate questions within section
      const seenQs = new Map();
      sec.questions.forEach((q, qIdx) => {
        const cleanQ = (q.pertanyaan || '').replace(/<[^>]*>/g, '').trim().toLowerCase();
        if (cleanQ && seenQs.has(cleanQ)) {
          _parseWarnings.push(`Bagian ${sIdx + 1}: Soal #${qIdx + 1} duplikat dengan soal #${seenQs.get(cleanQ) + 1}.`);
        } else if (cleanQ) {
          seenQs.set(cleanQ, qIdx);
        }

        // PG-specific validation
        if (sec.type_question === 'PG') {
          if (!q.jawaban_benar) {
            _parseWarnings.push(`Bagian ${sIdx + 1}, Soal #${qIdx + 1}: Tidak ada jawaban benar. Akan ditandai untuk diedit manual.`);
          }

          // Check duplicate options
          if (q.pilihan) {
            const vals = ['A', 'B', 'C', 'D'].map(k => (q.pilihan[k] || '').trim().toLowerCase()).filter(v => v);
            const dups = vals.filter((v, i) => vals.indexOf(v) !== i);
            if (dups.length > 0) {
              _parseWarnings.push(`Bagian ${sIdx + 1}, Soal #${qIdx + 1}: Opsi jawaban duplikat terdeteksi.`);
            }

            // Check empty options
            const missing = ['A', 'B', 'C', 'D'].find(k => !(q.pilihan[k] || '').trim());
            if (missing) {
              _parseWarnings.push(`Bagian ${sIdx + 1}, Soal #${qIdx + 1}: Opsi ${missing} kosong.`);
            }
          }
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Preview
  // ═══════════════════════════════════════════════════════════════════
  function _renderPreview() {
    const preview = document.getElementById('soalImportPreview');
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

    if (!_parsedSections || _parsedSections.length === 0) {
      preview.innerHTML = `
        <div class="dn-import-result dn-import-result-loading">
          <span class="dn-import-spinner"></span>
          <span>Memproses file...</span>
        </div>
      `;
      return;
    }

    const totalQuestions = _parsedSections.reduce((s, sec) => s + sec.questions.length, 0);

    preview.innerHTML = `
      <div class="dn-import-result dn-import-result-success">
        <div class="dn-import-result-summary">
          <div class="dn-import-stat">
            <span class="dn-import-stat-value">${_parsedSections.length}</span>
            <span class="dn-import-stat-label">Bagian</span>
          </div>
          <div class="dn-import-stat">
            <span class="dn-import-stat-value">${totalQuestions}</span>
            <span class="dn-import-stat-label">Soal</span>
          </div>
        </div>
        ${_parseWarnings.length > 0 ? `
          <div class="dn-import-warnings">
            <div class="dn-import-warnings-head"><span data-albedu-icon="warning"></span> ${_parseWarnings.length} peringatan:</div>
            <ul class="dn-import-issues">
              ${_parseWarnings.slice(0, 8).map(w => `<li>${_esc(w)}</li>`).join('')}
              ${_parseWarnings.length > 8 ? `<li>... dan ${_parseWarnings.length - 8} lainnya</li>` : ''}
            </ul>
          </div>
        ` : ''}
        <div class="dn-import-tabs-preview">
          ${_parsedSections.map((sec, sIdx) => `
            <div class="dn-import-tab-preview">
              <div class="dn-import-tab-head">
                <span class="dn-import-tab-name">Bagian ${sIdx + 1} — ${sec.type_question === 'PG' ? 'Pilihan Ganda' : 'Esai'}</span>
                <span class="dn-import-tab-count">${sec.questions.length} soal</span>
              </div>
              <div class="dn-import-tab-names">
                ${sec.questions.slice(0, 4).map((q, qIdx) => {
                  const text = (q.pertanyaan || '').replace(/<[^>]*>/g, '').slice(0, 40);
                  const hasAns = sec.type_question !== 'PG' || q.jawaban_benar;
                  return `<span class="dn-import-name-chip${!hasAns ? ' dn-import-name-chip-warn' : ''}" title="${_esc(q.pertanyaan || '')}">#${qIdx + 1}: ${_esc(text)}${!hasAns ? ' ⚠' : ''}</span>`;
                }).join('')}
                ${sec.questions.length > 4 ? `<span class="dn-import-name-more">+${sec.questions.length - 4} soal lainnya</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    window.AlbEdu?.bindIcons?.(preview);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Confirm button
  // ═══════════════════════════════════════════════════════════════════
  function _updateConfirmButton() {
    const btn = document.getElementById('soalImportConfirm');
    if (!btn) return;
    const hasFile = _selectedFile && _parsedSections && _parsedSections.length > 0;
    const hasErrors = _parseErrors.length > 0;
    btn.disabled = !(hasFile && !hasErrors);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Import execution
  // ═══════════════════════════════════════════════════════════════════
  async function _handleImport() {
    const btn = document.getElementById('soalImportConfirm');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="dn-import-spinner"></span> <span>Mengimport...</span>';
    }

    try {
      const state = window.CreateAssessment.getState();
      const existingSections = state.examData.sections.length;

      // Check if we have room for new sections
      if (existingSections + _parsedSections.length > MAX_SECTIONS) {
        throw new Error(`Tidak cukup slot bagian. Ada ${existingSections} bagian existing, file menambah ${_parsedSections.length}. Maksimal ${MAX_SECTIONS} bagian total.`);
      }

      // Add each section + its questions
      let totalAdded = 0;
      for (const secData of _parsedSections) {
        // Add new section
        const newSec = window.CreateAssessment.addSection();
        if (!newSec) {
          _parseWarnings.push('Gagal menambah bagian baru (limit tercapai).');
          break;
        }

        // Set section type
        const secIdx = window.CreateAssessment.getState().examData.sections.length - 1;
        window.CreateAssessment.updateSection(secIdx, { type_question: secData.type_question });

        // Add questions
        for (const qData of secData.questions) {
          const added = window.CreateAssessment.addQuestion(secIdx, secData.type_question);
          if (!added) {
            _parseWarnings.push(`Gagal menambah soal di Bagian ${secIdx + 1} (limit tercapai?).`);
            break;
          }
          const qIdx = window.CreateAssessment.getState().examData.sections[secIdx].questions.length - 1;
          // Update with parsed data (preserve idq)
          const updateData = { ...qData, idq: added.idq };
          window.CreateAssessment.updateQuestion(secIdx, qIdx, updateData);
          totalAdded++;
        }
      }

      _closeModal();

      window.notify?.success(
        'Import Berhasil',
        `${_parsedSections.length} bagian dengan ${totalAdded} soal berhasil diimport.${_parseWarnings.length > 0 ? ' Periksa peringatan di daftar soal.' : ''}`,
        5000
      );

      // Switch to step 2 (Soal) if not already there
      if (window.WizardController?.goToStep) {
        window.WizardController.goToStep(2);
      }
    } catch (err) {
      console.error('[SoalImport] Import failed:', err);
      window.notify?.error('Gagal Import', err.message);

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
